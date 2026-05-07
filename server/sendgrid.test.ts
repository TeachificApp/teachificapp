import { describe, it, expect } from "vitest";
import { validateSendGridKey, buildUnsubscribeToken, parseUnsubscribeToken, resolveMergeTags } from "./sendgrid";

describe("SendGrid helpers", () => {
  it.skipIf(!process.env.SENDGRID_API_KEY)("validates the SendGrid API key against the live API", async () => {
    const valid = await validateSendGridKey();
    expect(valid).toBe(true);
  }, 15000);

  it("builds and parses unsubscribe tokens correctly", () => {
    const token = buildUnsubscribeToken(42, 7);
    const parsed = parseUnsubscribeToken(token);
    expect(parsed).not.toBeNull();
    expect(parsed?.orgId).toBe(42);
    expect(parsed?.userId).toBe(7);
  });

  it("returns null for invalid unsubscribe tokens", () => {
    expect(parseUnsubscribeToken("not-a-valid-token")).toBeNull();
  });

  it("resolves merge tags in template strings", () => {
    const result = resolveMergeTags(
      "Hello {{user_name}}, welcome to {{org_name}}!",
      { user_name: "Alice", org_name: "Acme Corp" }
    );
    expect(result).toBe("Hello Alice, welcome to Acme Corp!");
  });

  it("leaves unresolved merge tags intact", () => {
    const result = resolveMergeTags("Hello {{user_name}}!", {});
    expect(result).toBe("Hello {{user_name}}!");
  });
});
