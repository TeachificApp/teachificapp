/**
 * Video scraper — extracts and downloads videos from arbitrary web page URLs.
 *
 * Strategy order:
 *   1. yt-dlp (subprocess) — handles Facebook, LinkedIn, Twitter/X, Instagram, YouTube,
 *      Vimeo, TikTok, and hundreds more sites with obfuscated/JS-rendered video.
 *   2. HTML meta-tag fallback — parses og:video, og:video:url, twitter:player:stream,
 *      and <video>/<source> tags for direct .mp4 links.
 *
 * The caller receives a local temp file path + metadata; it's responsible for uploading
 * to S3 and cleaning up the temp file.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";
import { nanoid } from "nanoid";

const execFileAsync = promisify(execFile);

export interface ScrapedVideo {
  filePath: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  durationSeconds: number | null;
  title: string;
  sourceUrl: string;
}

// ── yt-dlp strategy ──────────────────────────────────────────────────────────

async function ytdlpAvailable(): Promise<boolean> {
  try {
    await execFileAsync("yt-dlp", ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function scrapeWithYtdlp(url: string): Promise<ScrapedVideo> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "vid-import-"));
  const outTemplate = path.join(tmpDir, "%(title).80s.%(ext)s");

  try {
    // First get video info (title, duration, format) without downloading
    const { stdout: infoJson } = await execFileAsync(
      "yt-dlp",
      [
        "--dump-json",
        "--no-playlist",
        "--no-warnings",
        url,
      ],
      { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }
    );

    const info = JSON.parse(infoJson);
    const title: string = info.title || info.fulltitle || "Imported Video";
    const duration: number | null = info.duration ? Math.round(info.duration) : null;

    // Download best mp4 (video+audio merged), max 1080p to keep size reasonable
    await execFileAsync(
      "yt-dlp",
      [
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        "-f", "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]/best",
        "--merge-output-format", "mp4",
        "--output", outTemplate,
        url,
      ],
      { timeout: 10 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 }
    );

    // Find the downloaded file
    const files = await fs.promises.readdir(tmpDir);
    if (files.length === 0) throw new Error("yt-dlp produced no output file");
    const downloadedFile = files[0];
    const filePath = path.join(tmpDir, downloadedFile);
    const stat = await fs.promises.stat(filePath);

    const ext = path.extname(downloadedFile).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".mkv": "video/x-matroska",
      ".mov": "video/quicktime",
      ".avi": "video/x-msvideo",
      ".m4a": "audio/mp4",
      ".mp3": "audio/mpeg",
    };

    return {
      filePath,
      fileName: downloadedFile,
      mimeType: mimeMap[ext] || "video/mp4",
      fileSize: stat.size,
      durationSeconds: duration,
      title,
      sourceUrl: url,
    };
  } catch (err: any) {
    // Clean up tmpDir on failure
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// ── HTML meta-tag fallback ───────────────────────────────────────────────────

async function scrapeWithMetaTags(url: string): Promise<ScrapedVideo> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) throw new Error(`Failed to fetch page: ${res.status} ${res.statusText}`);
  const html = await res.text();

  // Extract video URLs from meta tags and video elements
  const videoUrls: string[] = [];

  // og:video, og:video:url, og:video:secure_url
  const ogVideoRe = /<meta\s+(?:property|name)=["']og:video(?::(?:secure_)?url)?["']\s+content=["']([^"']+)["']/gi;
  let match;
  while ((match = ogVideoRe.exec(html)) !== null) {
    if (match[1] && isVideoUrl(match[1])) videoUrls.push(match[1]);
  }

  // twitter:player:stream
  const twitterRe = /<meta\s+(?:property|name)=["']twitter:player:stream["']\s+content=["']([^"']+)["']/gi;
  while ((match = twitterRe.exec(html)) !== null) {
    if (match[1]) videoUrls.push(match[1]);
  }

  // <video src="..."> and <source src="...">
  const videoSrcRe = /<(?:video|source)\s[^>]*src=["']([^"']+)["']/gi;
  while ((match = videoSrcRe.exec(html)) !== null) {
    if (match[1] && isVideoUrl(match[1])) videoUrls.push(match[1]);
  }

  if (videoUrls.length === 0) {
    throw new Error(
      "No downloadable video found on this page. " +
      "This site may require authentication or use a format that isn't directly accessible. " +
      "Try a direct video URL instead."
    );
  }

  // Try downloading the first valid video URL
  const videoUrl = resolveUrl(videoUrls[0], url);
  return await downloadDirectVideo(videoUrl, url);
}

function isVideoUrl(url: string): boolean {
  const videoExtensions = /\.(mp4|webm|mov|avi|mkv|m4v|ogv|3gp)(\?|$)/i;
  const videoMimeHints = /video\//i;
  return videoExtensions.test(url) || videoMimeHints.test(url);
}

function resolveUrl(videoUrl: string, pageUrl: string): string {
  if (videoUrl.startsWith("http://") || videoUrl.startsWith("https://")) return videoUrl;
  if (videoUrl.startsWith("//")) return "https:" + videoUrl;
  try {
    return new URL(videoUrl, pageUrl).href;
  } catch {
    return videoUrl;
  }
}

async function downloadDirectVideo(videoUrl: string, sourceUrl: string): Promise<ScrapedVideo> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "vid-import-"));

  try {
    const res = await fetch(videoUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": sourceUrl,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });

    if (!res.ok) throw new Error(`Failed to download video: ${res.status}`);
    if (!res.body) throw new Error("No response body");

    const contentType = res.headers.get("content-type") || "video/mp4";
    const ext = contentType.includes("webm") ? ".webm" : contentType.includes("mov") ? ".mov" : ".mp4";
    const fileName = `imported-${nanoid(8)}${ext}`;
    const filePath = path.join(tmpDir, fileName);

    const buffer = Buffer.from(await res.arrayBuffer());
    await fs.promises.writeFile(filePath, buffer);

    // Try to get duration via ffprobe
    let duration: number | null = null;
    try {
      const { stdout } = await execFileAsync("ffprobe", [
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        filePath,
      ], { timeout: 10_000 });
      const probe = JSON.parse(stdout);
      if (probe.format?.duration) duration = Math.round(parseFloat(probe.format.duration));
    } catch { /* ffprobe not critical */ }

    const stat = await fs.promises.stat(filePath);

    // Extract a title from the page URL
    let title = "Imported Video";
    try {
      const parsed = new URL(sourceUrl);
      title = parsed.hostname.replace(/^www\./, "");
    } catch { /* keep default */ }

    return {
      filePath,
      fileName,
      mimeType: contentType.split(";")[0].trim(),
      fileSize: stat.size,
      durationSeconds: duration,
      title,
      sourceUrl,
    };
  } catch (err) {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function scrapeVideoFromUrl(url: string): Promise<ScrapedVideo> {
  // Validate URL
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("URL must use http or https");
    }
  } catch (err: any) {
    throw new Error(`Invalid URL: ${err.message}`);
  }

  // If the URL points directly to a video file, download it immediately
  if (isVideoUrl(url)) {
    console.log(`[videoScraper] Direct video URL detected, downloading: ${url}`);
    return await downloadDirectVideo(url, url);
  }

  // Try yt-dlp first (handles most sites including Facebook, LinkedIn, etc.)
  if (await ytdlpAvailable()) {
    try {
      console.log(`[videoScraper] Trying yt-dlp for: ${url}`);
      return await scrapeWithYtdlp(url);
    } catch (err: any) {
      console.warn(`[videoScraper] yt-dlp failed: ${err.message}`);
      // Fall through to meta-tag scraping
    }
  }

  // Fall back to HTML meta-tag scraping
  console.log(`[videoScraper] Trying HTML meta-tag scraping for: ${url}`);
  return await scrapeWithMetaTags(url);
}

/**
 * Clean up temp files after upload to S3 is complete.
 * The filePath's parent directory is the tmpDir created by mkdtemp.
 */
export async function cleanupScrapedVideo(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  if (dir.includes("vid-import-")) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
