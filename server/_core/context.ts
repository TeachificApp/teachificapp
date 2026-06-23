import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { sdk } from "./sdk";
import { getUserById } from "../db";
import { createHmac, timingSafeEqual } from "crypto";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: (User & { impersonatedBy?: string }) | null;
};

/** Parse a single named cookie from the Cookie header */
function parseCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getSessionSecret(): string {
  return process.env.JWT_SECRET || "";
}

/** Sign a session payload and return the token (payload.signature) */
export function signSessionToken(payload: { userId: number; ts: number }): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", getSessionSecret()).update(data).digest("base64url");
  return `${data}.${sig}`;
}

/** Verify and parse a signed session token. Returns null if invalid/expired/tampered. */
function verifySessionToken(token: string): { userId: number; ts: number } | null {
  const secret = getSessionSecret();
  if (!secret) return null;
  const dotIdx = token.indexOf(".");
  if (dotIdx < 0) return null;
  const data = token.substring(0, dotIdx);
  const sig = token.substring(dotIdx + 1);
  const expected = createHmac("sha256", secret).update(data).digest("base64url");
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (!payload?.userId || typeof payload.userId !== "number") return null;
    if (typeof payload.ts === "number" && Date.now() - payload.ts > SESSION_MAX_AGE_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Resolve a user from the custom Teachific email/password session cookie */
async function resolveTeachificSession(cookieHeader: string | undefined): Promise<User | null> {
  try {
    const raw = parseCookie(cookieHeader, "teachific_session");
    if (!raw) return null;
    const payload = verifySessionToken(raw);
    if (!payload) return null;
    const user = await getUserById(payload.userId);
    return user ?? null;
  } catch {
    return null;
  }
}

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: (User & { impersonatedBy?: string }) | null = null;

  try {
    // Primary: Manus OAuth / app_session_id cookie
    user = await sdk.authenticateRequest(opts.req);
  } catch {
    // Fallback: custom Teachific email/password session cookie
    user = await resolveTeachificSession(opts.req.headers.cookie);
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
  };
}
