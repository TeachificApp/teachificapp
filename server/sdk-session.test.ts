import { describe, expect, it } from "vitest";
import { ENV } from "./_core/env";
import { sdk } from "./_core/sdk";

describe("SDK session tokens", () => {
  it("creates verifiable sessions without Manus OAuth app configuration", async () => {
    ENV.appId = "";
    ENV.cookieSecret = "test-session-secret";

    const token = await sdk.createSessionToken("local_test_user", {
      name: "Local Test User",
      expiresInMs: 60_000,
    });

    const session = await sdk.verifySession(token);

    expect(session).toMatchObject({
      openId: "local_test_user",
      appId: "teachific",
      name: "Local Test User",
    });
  });
});
