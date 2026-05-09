import { afterEach, describe, it, expect, vi } from "vitest";

const sendGridMock = vi.hoisted(() => ({
  send: vi.fn(),
  setApiKey: vi.fn(),
}));

vi.mock("@sendgrid/mail", () => ({
  default: sendGridMock,
}));

import {
  validateSendGridKey,
  buildUnsubscribeToken,
  getSendGridConfig,
  parseUnsubscribeToken,
  resolveMergeTags,
  sendEmail,
} from "./sendgrid";

const originalSendGridEnv = {
  SENDGRID_API_KEY: process.env.SENDGRID_API_KEY,
  SENDGRID_FROM_EMAIL: process.env.SENDGRID_FROM_EMAIL,
  SENDGRID_FROM_NAME: process.env.SENDGRID_FROM_NAME,
};

afterEach(() => {
  sendGridMock.send.mockReset();
  sendGridMock.setApiKey.mockReset();
  for (const [key, value] of Object.entries(originalSendGridEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

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

  it("reads SendGrid config from the current environment", () => {
    process.env.SENDGRID_API_KEY = "SG.test-key";
    process.env.SENDGRID_FROM_EMAIL = "verified@example.com";
    process.env.SENDGRID_FROM_NAME = "Verified Sender";

    expect(getSendGridConfig()).toEqual({
      apiKey: "SG.test-key",
      fromEmail: "verified@example.com",
      fromName: "Verified Sender",
      configured: true,
    });
  });

  it("sends mail through SendGrid with normalized recipients and defaults", async () => {
    process.env.SENDGRID_API_KEY = "SG.test-key";
    delete process.env.SENDGRID_FROM_EMAIL;
    delete process.env.SENDGRID_FROM_NAME;
    sendGridMock.send.mockResolvedValueOnce([{}]);

    const sent = await sendEmail({
      to: [" learner@example.com ", ""],
      subject: "Welcome",
      html: "<p>Hello learner</p>",
    });

    expect(sent).toBe(true);
    expect(sendGridMock.setApiKey).toHaveBeenCalledWith("SG.test-key");
    expect(sendGridMock.send).toHaveBeenCalledWith({
      to: ["learner@example.com"],
      from: {
        email: "hello@teachific.app",
        name: "Teachific",
      },
      subject: "Welcome",
      html: "<p>Hello learner</p>",
      text: "Hello learner",
    });
  });

  it("does not call SendGrid without recipients", async () => {
    process.env.SENDGRID_API_KEY = "SG.test-key";

    const sent = await sendEmail({
      to: ["  "],
      subject: "No recipients",
      html: "<p>Hello</p>",
    });

    expect(sent).toBe(false);
    expect(sendGridMock.send).not.toHaveBeenCalled();
  });
});
