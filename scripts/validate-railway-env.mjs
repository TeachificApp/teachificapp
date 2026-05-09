const requiredGroups = [
  {
    name: "Railway runtime",
    required: ["DATABASE_URL", "JWT_SECRET"],
  },
  {
    name: "S3-compatible storage",
    required: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "AWS_S3_BUCKET"],
    optional: ["AWS_S3_ENDPOINT", "AWS_S3_PUBLIC_URL"],
  },
  {
    name: "SendGrid email",
    required: ["SENDGRID_API_KEY", "SENDGRID_FROM_EMAIL", "SENDGRID_FROM_NAME"],
  },
  {
    name: "AI features",
    required: ["OPENAI_API_KEY"],
    optional: ["OPENAI_MODEL"],
  },
  {
    name: "Stripe payments",
    required: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "VITE_STRIPE_PUBLISHABLE_KEY"],
  },
];

const warnings = [];
const errors = [];
const oauthVars = ["VITE_APP_ID", "OAUTH_SERVER_URL", "VITE_OAUTH_PORTAL_URL"];

function hasValue(name) {
  return (process.env[name] ?? "").trim().length > 0;
}

for (const group of requiredGroups) {
  for (const name of group.required) {
    if (!hasValue(name)) errors.push(`${group.name}: missing ${name}`);
  }
}

if (hasValue("AWS_S3_ENDPOINT")) {
  try {
    const endpoint = new URL(process.env.AWS_S3_ENDPOINT);
    const bucket = process.env.AWS_S3_BUCKET;
    const path = endpoint.pathname.replace(/^\/+|\/+$/g, "");
    if (bucket && path === bucket) {
      warnings.push(
        "AWS_S3_ENDPOINT includes the bucket path. The app accepts this, but Railway should preferably store the account endpoint and AWS_S3_BUCKET separately."
      );
    }
  } catch {
    errors.push("S3-compatible storage: AWS_S3_ENDPOINT must be a valid URL when set");
  }
}

if (hasValue("SENDGRID_API_KEY") && !process.env.SENDGRID_API_KEY.trim().startsWith("SG.")) {
  warnings.push("SENDGRID_API_KEY does not start with SG.; confirm this is a SendGrid API key");
}

if (hasValue("SENDGRID_FROM_EMAIL") && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(process.env.SENDGRID_FROM_EMAIL.trim())) {
  errors.push("SendGrid email: SENDGRID_FROM_EMAIL must be an email address");
}

if (!hasValue("AWS_S3_PUBLIC_URL")) {
  warnings.push("AWS_S3_PUBLIC_URL is not set; browser-facing file URLs will use the bucket endpoint instead of a custom public domain/CDN");
}

if ((process.env.NODE_ENV ?? "") !== "production") {
  warnings.push("NODE_ENV is not production; Railway should set NODE_ENV=production");
}

const configuredOauthVars = oauthVars.filter(hasValue);
if (configuredOauthVars.length > 0 && configuredOauthVars.length < oauthVars.length) {
  errors.push(
    `Manus OAuth: configure all or none of ${oauthVars.join(", ")}. Missing ${oauthVars
      .filter((name) => !hasValue(name))
      .join(", ")}`
  );
}

if (configuredOauthVars.length === 0) {
  warnings.push("Manus OAuth variables are not set; Railway will use Teachific email/password auth only");
}

if (errors.length > 0) {
  console.error("Railway environment validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  if (warnings.length > 0) {
    console.warn("\nWarnings:");
    for (const warning of warnings) console.warn(`- ${warning}`);
  }
  process.exit(1);
}

console.log("Railway environment validation passed.");
if (warnings.length > 0) {
  console.warn("\nWarnings:");
  for (const warning of warnings) console.warn(`- ${warning}`);
}
