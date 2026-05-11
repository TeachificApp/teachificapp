import { describe, expect, it } from "vitest";
import {
  TEACHIFIC_SESSION_COOKIE,
  encodeTeachificSession,
  parseTeachificSessionPayloads,
} from "./teachificSession";

function cookie(value: string) {
  return `${TEACHIFIC_SESSION_COOKIE}=${encodeURIComponent(value)}`;
}

describe("Teachific session cookies", () => {
  it("prefers the newest duplicate session cookie payload", () => {
    const older = Buffer.from(JSON.stringify({ userId: 1, ts: 100 })).toString("base64url");
    const newer = Buffer.from(JSON.stringify({ userId: 2, ts: 200 })).toString("base64url");

    const payloads = parseTeachificSessionPayloads(`${cookie(older)}; ${cookie(newer)}`);

    expect(payloads.map((payload) => payload.userId)).toEqual([2, 1]);
  });

  it("ignores malformed duplicate session cookies", () => {
    const valid = encodeTeachificSession(3);

    const payloads = parseTeachificSessionPayloads(`${cookie("not-json")}; ${cookie(valid)}`);

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.userId).toBe(3);
  });
});
