import sgMail from "@sendgrid/mail";

export interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  fromName?: string;
  fromEmail?: string;
  replyTo?: string;
}

export function getSendGridConfig(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env.SENDGRID_API_KEY?.trim() ?? "";
  return {
    apiKey,
    fromEmail: env.SENDGRID_FROM_EMAIL?.trim() || "hello@teachific.app",
    fromName: env.SENDGRID_FROM_NAME?.trim() || "Teachific",
    configured: apiKey.length > 0,
  };
}

function normalizeRecipients(to: string | string[]): string[] {
  const recipients = Array.isArray(to) ? to : [to];
  return recipients.map((email) => email.trim()).filter(Boolean);
}

export async function sendEmail(opts: SendEmailOptions): Promise<boolean> {
  const config = getSendGridConfig();
  if (!config.configured) {
    console.warn("[SendGrid] No API key configured — email not sent:", opts.subject);
    return false;
  }
  const to = normalizeRecipients(opts.to);
  if (to.length === 0) {
    console.warn("[SendGrid] No recipients provided — email not sent:", opts.subject);
    return false;
  }
  try {
    sgMail.setApiKey(config.apiKey);
    await sgMail.send({
      to,
      from: {
        email: opts.fromEmail ?? config.fromEmail,
        name: opts.fromName ?? config.fromName,
      },
      subject: opts.subject,
      html: opts.html,
      text: opts.text ?? opts.html.replace(/<[^>]+>/g, ""),
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
    });
    return true;
  } catch (err: any) {
    console.error("[SendGrid] Send failed:", err?.response?.body ?? err);
    return false;
  }
}

/** Replace merge tags in a template string.
 *  Supported tags: {{user_name}}, {{org_name}}, {{course_title}},
 *  {{unsubscribe_url}}, {{site_url}}, {{year}}
 */
export function resolveMergeTags(
  template: string,
  vars: Record<string, string>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

/** Build an unsubscribe token: base64url(orgId:userId:timestamp) */
export function buildUnsubscribeToken(orgId: number, userId: number): string {
  const payload = `${orgId}:${userId}:${Date.now()}`;
  return Buffer.from(payload).toString("base64url");
}

/** Parse an unsubscribe token back to { orgId, userId } */
export function parseUnsubscribeToken(
  token: string
): { orgId: number; userId: number } | null {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const parts = decoded.split(":");
    if (parts.length < 2) return null;
    const orgId = parseInt(parts[0]);
    const userId = parseInt(parts[1]);
    if (isNaN(orgId) || isNaN(userId)) return null;
    return { orgId, userId };
  } catch {
    return null;
  }
}

/** Validate SendGrid API key by calling the API */
export async function validateSendGridKey(): Promise<boolean> {
  const { apiKey } = getSendGridConfig();
  if (!apiKey) return false;
  try {
    const res = await fetch("https://api.sendgrid.com/v3/user/profile", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return res.status === 200;
  } catch {
    return false;
  }
}
