import type { User } from "../../drizzle/schema";
import { getUserById } from "../db";

export const TEACHIFIC_SESSION_COOKIE = "teachific_session";

type TeachificSessionPayload = {
  userId: number;
  ts?: number;
};

export function encodeTeachificSession(userId: number): string {
  return Buffer.from(JSON.stringify({ userId, ts: Date.now() })).toString("base64url");
}

function parseCookieValues(cookieHeader: string | undefined, name: string): string[] {
  if (!cookieHeader) return [];
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => decodeURIComponent(part.slice(name.length + 1)))
    .filter(Boolean);
}

export function parseTeachificSessionPayloads(cookieHeader: string | undefined): TeachificSessionPayload[] {
  const payloads: TeachificSessionPayload[] = [];
  parseCookieValues(cookieHeader, TEACHIFIC_SESSION_COOKIE).forEach((raw, index) => {
    try {
      const payload = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
      if (!payload?.userId || typeof payload.userId !== "number") return;
      payloads.push({
        userId: payload.userId,
        ts: typeof payload.ts === "number" ? payload.ts : index,
      });
    } catch {
      // Ignore malformed stale cookies and try any other duplicate values.
    }
  });
  return payloads.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
}

export async function resolveTeachificSessionUser(cookieHeader: string | undefined): Promise<User | null> {
  const payloads = parseTeachificSessionPayloads(cookieHeader);
  for (const payload of payloads) {
    const user = await getUserById(payload.userId);
    if (user) return user;
  }
  return null;
}
