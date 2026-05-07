/**
 * Storage abstraction layer
 *
 * Supports two backends, selected automatically by environment variables:
 *
 * 1. AWS S3 or S3-compatible storage such as Cloudflare R2
 *    Required: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_S3_BUCKET
 *    Optional: AWS_S3_ENDPOINT    (S3-compatible API endpoint)
 *              AWS_S3_PUBLIC_URL  (CDN/public prefix, e.g. https://cdn.example.com)
 *
 * 2. Manus built-in storage (default when running on the Manus platform)
 *    Required: BUILT_IN_FORGE_API_URL, BUILT_IN_FORGE_API_KEY
 */

import { ENV } from './_core/env';

// ─── Backend detection ────────────────────────────────────────────────────────

function isAwsConfigured(): boolean {
  return !!(
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY &&
    process.env.AWS_REGION &&
    process.env.AWS_S3_BUCKET
  );
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

// ─── AWS S3 Backend ───────────────────────────────────────────────────────────

function buildS3PublicUrl(key: string): string {
  const bucket = process.env.AWS_S3_BUCKET!;
  const region = process.env.AWS_REGION!;
  const endpoint = getS3Endpoint();
  return process.env.AWS_S3_PUBLIC_URL
    ? `${process.env.AWS_S3_PUBLIC_URL.replace(/\/$/, "")}/${key}`
    : endpoint
      ? `${endpoint}/${bucket}/${key}`
    : `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}

function getS3Endpoint(): string | undefined {
  const rawEndpoint = process.env.AWS_S3_ENDPOINT?.trim();
  if (!rawEndpoint) return undefined;

  const bucket = process.env.AWS_S3_BUCKET;
  try {
    const url = new URL(rawEndpoint);
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    // Accept bucket URLs copied from R2, but configure the SDK with the account endpoint.
    if (bucket && path === bucket) url.pathname = "/";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return rawEndpoint.replace(/\/+$/, "");
  }
}

async function createS3Client(): Promise<import("@aws-sdk/client-s3").S3Client> {
  const { S3Client } = await import("@aws-sdk/client-s3");
  const endpoint = getS3Endpoint();
  return new S3Client({
    region: process.env.AWS_REGION!,
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
}

async function s3Put(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  const client = await createS3Client();
  const key = normalizeKey(relKey);
  await client.send(
    new PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET!,
      Key: key,
      Body: typeof data === "string" ? Buffer.from(data) : data,
      ContentType: contentType,
    })
  );
  return { key, url: buildS3PublicUrl(key) };
}

async function s3PutStream(
  relKey: string,
  filePath: string,
  contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  const { createReadStream, statSync } = await import("fs");
  const client = await createS3Client();
  const key = normalizeKey(relKey);
  const fileSize = statSync(filePath).size;
  await client.send(
    new PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET!,
      Key: key,
      Body: createReadStream(filePath),
      ContentType: contentType,
      ContentLength: fileSize,
    })
  );
  return { key, url: buildS3PublicUrl(key) };
}

async function s3Get(relKey: string): Promise<{ key: string; url: string }> {
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const client = await createS3Client();
  const key = normalizeKey(relKey);
  const url = await getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: process.env.AWS_S3_BUCKET!, Key: key }),
    { expiresIn: 3600 }
  );
  return { key, url };
}

// ─── Manus Built-in Storage Backend ──────────────────────────────────────────

function getManusStorageConfig() {
  const baseUrl = ENV.forgeApiUrl;
  const apiKey = ENV.forgeApiKey;
  if (!baseUrl || !apiKey) {
    throw new Error(
      "No storage backend configured. Set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_REGION/AWS_S3_BUCKET " +
      "for AWS S3, or BUILT_IN_FORGE_API_URL/BUILT_IN_FORGE_API_KEY for Manus storage."
    );
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}

function buildManusUploadUrl(baseUrl: string, relKey: string): URL {
  const url = new URL("v1/storage/upload", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  url.searchParams.set("path", normalizeKey(relKey));
  return url;
}

async function buildManusDownloadUrl(baseUrl: string, relKey: string, apiKey: string): Promise<string> {
  const url = new URL("v1/storage/downloadUrl", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  url.searchParams.set("path", normalizeKey(relKey));
  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return (await response.json()).url;
}

async function manusPut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  const { baseUrl, apiKey } = getManusStorageConfig();
  const key = normalizeKey(relKey);
  const uploadUrl = buildManusUploadUrl(baseUrl, key);
  const blob = typeof data === "string"
    ? new Blob([data], { type: contentType })
    : new Blob([data as any], { type: contentType });
  const form = new FormData();
  form.append("file", blob, key.split("/").pop() ?? key);
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new Error(`Storage upload failed (${response.status} ${response.statusText}): ${message}`);
  }
  const url = (await response.json()).url;
  return { key, url };
}

async function manusPutStream(
  relKey: string,
  filePath: string,
  contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  const { baseUrl, apiKey } = getManusStorageConfig();
  const key = normalizeKey(relKey);
  const uploadUrl = buildManusUploadUrl(baseUrl, key);
  const { createReadStream, statSync } = await import("fs");
  const FormDataNode = (await import("form-data")).default;
  const https = await import("https");
  const http = await import("http");
  const fileSize = statSync(filePath).size;
  const form = new FormDataNode();
  form.append("file", createReadStream(filePath), {
    filename: key.split("/").pop() ?? key,
    contentType,
    knownLength: fileSize,
  });
  const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
  return new Promise((resolve, reject) => {
    const isHttps = uploadUrl.protocol === "https:";
    const transport = isHttps ? https : http;
    const options = {
      method: "POST",
      hostname: uploadUrl.hostname,
      port: uploadUrl.port || (isHttps ? 443 : 80),
      path: uploadUrl.pathname + uploadUrl.search,
      headers: { ...form.getHeaders(), Authorization: `Bearer ${apiKey}` },
    };
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    const req = (transport as typeof https).request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if ((res.statusCode ?? 500) >= 400) {
          done(() => reject(new Error(`Storage stream upload failed (${res.statusCode}): ${body.slice(0, 300)}`)));
          return;
        }
        try {
          done(() => resolve({ key, url: JSON.parse(body).url }));
        } catch {
          done(() => reject(new Error(`Invalid JSON from storage: ${body.slice(0, 300)}`)));
        }
      });
      res.on("error", (err) => done(() => reject(err)));
    });
    const timer = setTimeout(() => {
      req.destroy(new Error(`Storage upload timed out after ${UPLOAD_TIMEOUT_MS / 60000} minutes`));
    }, UPLOAD_TIMEOUT_MS);
    req.on("error", (err) => { clearTimeout(timer); done(() => reject(err)); });
    req.on("close", () => clearTimeout(timer));
    form.pipe(req);
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  return isAwsConfigured()
    ? s3Put(relKey, data, contentType)
    : manusPut(relKey, data, contentType);
}

export async function storagePutStream(
  relKey: string,
  filePath: string,
  contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  return isAwsConfigured()
    ? s3PutStream(relKey, filePath, contentType)
    : manusPutStream(relKey, filePath, contentType);
}

export async function storageGet(
  relKey: string
): Promise<{ key: string; url: string }> {
  if (isAwsConfigured()) {
    return s3Get(relKey);
  }
  const { baseUrl, apiKey } = getManusStorageConfig();
  const key = normalizeKey(relKey);
  return { key, url: await buildManusDownloadUrl(baseUrl, key, apiKey) };
}
