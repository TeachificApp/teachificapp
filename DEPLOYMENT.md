# Teachific™ — Railway Deployment Guide

This guide walks you through deploying Teachific™ to [Railway](https://railway.app) as a self-hosted alternative to the Manus platform. The app runs as a single Node.js process (Express + Vite SSR) backed by a MySQL database and S3-compatible file storage.

---

## Overview

| Component | Manus (current) | Railway (self-hosted) |
|---|---|---|
| Hosting | Manus platform | Railway (Node.js service) |
| Database | Manus MySQL | Railway MySQL plugin |
| File storage | Manus built-in S3 | S3-compatible bucket (AWS S3 or Cloudflare R2) |
| AI / LLM | Manus built-in (Gemini) | OpenAI API |
| Auth | Manus OAuth | Email/password (built-in) |
| Payments | Stripe (same) | Stripe (same) |
| Email | SendGrid (same) | SendGrid (same) |

---

## Step 1 — Create a Railway Project

1. Go to [railway.app](https://railway.app) and sign in with GitHub.
2. Click **New Project** → **Deploy from GitHub repo** → select your `scorm-host` repository.
3. Railway will detect the `railway.toml` and begin building automatically.

---

## Step 2 — Add a MySQL Database

1. In your Railway project, click **+ New** → **Database** → **MySQL**.
2. Railway will provision a MySQL instance and automatically inject `DATABASE_URL` into your service's environment.
3. No further configuration is needed for the database connection.

---

## Step 3 — Create an AWS S3 Bucket

File uploads (SCORM packages, videos, images, digital downloads) require an S3 bucket.

1. Log in to [AWS Console](https://console.aws.amazon.com) → S3 → **Create bucket**.
2. Choose a region (e.g., `us-east-1`) and a unique bucket name (e.g., `teachific-files`).
3. Under **Block Public Access**, **uncheck** "Block all public access" so uploaded files are publicly readable.
4. Under **Bucket Policy**, add this policy (replace `YOUR-BUCKET-NAME`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::YOUR-BUCKET-NAME/*"
    }
  ]
}
```

5. Create an **IAM user** with `AmazonS3FullAccess` and generate an **Access Key ID** and **Secret Access Key**.

---

## Step 4 — Set Environment Variables in Railway

In your Railway service, go to **Variables** and add the following:

### Required — Database
| Variable | Value |
|---|---|
| `DATABASE_URL` | Auto-injected by Railway MySQL plugin |

### Required — App Security
| Variable | Value |
|---|---|
| `JWT_SECRET` | A long random string (e.g., `openssl rand -hex 64`) |
| `NODE_ENV` | `production` |

### Required — AWS S3 / S3-compatible Storage
| Variable | Value |
|---|---|
| `AWS_ACCESS_KEY_ID` | Your IAM user access key |
| `AWS_SECRET_ACCESS_KEY` | Your IAM user secret key |
| `AWS_REGION` | Your bucket region (e.g., `us-east-1`), or `auto` for Cloudflare R2 |
| `AWS_S3_BUCKET` | Your bucket name (e.g., `teachific-files`) |
| `AWS_S3_ENDPOINT` | Optional: S3-compatible API endpoint, such as Cloudflare R2 |
| `AWS_S3_PUBLIC_URL` | Optional: CloudFront/CDN/public bucket URL if you set one up |

For Cloudflare R2, split the bucket URL into endpoint and bucket name. For example,
`https://926e046281eccc776864fd105e322ac8.r2.cloudflarestorage.com/teachific`
should be configured as:

| Variable | Value |
|---|---|
| `AWS_S3_ENDPOINT` | `https://926e046281eccc776864fd105e322ac8.r2.cloudflarestorage.com` |
| `AWS_S3_BUCKET` | `teachific` |
| `AWS_REGION` | `auto` |

Set `AWS_S3_PUBLIC_URL` to an R2 public development URL or custom domain when files
need to be loaded directly by browsers.

### Required — AI Features (Course Generator, Transcription, etc.)
| Variable | Value |
|---|---|
| `OPENAI_API_KEY` | Your OpenAI API key from [platform.openai.com](https://platform.openai.com) |
| `OPENAI_MODEL` | Optional: model to use (default: `gpt-4o-mini`) |

### Required — Stripe Payments
| Variable | Value |
|---|---|
| `STRIPE_SECRET_KEY` | Your Stripe secret key (`sk_live_...`) |
| `VITE_STRIPE_PUBLISHABLE_KEY` | Your Stripe publishable key (`pk_live_...`) |
| `STRIPE_WEBHOOK_SECRET` | From Stripe Dashboard → Webhooks |

### Required — Email (SendGrid)
| Variable | Value |
|---|---|
| `SENDGRID_API_KEY` | Your SendGrid API key |
| `SENDGRID_FROM_EMAIL` | Verified SendGrid sender email (e.g., `hello@teachific.app`) |
| `SENDGRID_FROM_NAME` | Sender name (e.g., `Teachific`) |

After adding Railway variables, you can validate the service configuration from a
Railway shell:

```bash
pnpm check:railway-env
```

This checks that the required database, storage, SendGrid, and Stripe variables
are present without printing any secret values.

### Optional — Manus OAuth (if keeping Manus login)
Railway does not require Manus OAuth. The primary Railway login path is the
Teachific email/password auth flow, which uses the same signed `app_session_id`
cookie as the legacy OAuth flow.

If you want to keep Manus OAuth working alongside email/password, configure all
of these variables:
| Variable | Value |
|---|---|
| `VITE_APP_ID` | Your Manus app ID |
| `OAUTH_SERVER_URL` | `https://api.manus.im` |
| `VITE_OAUTH_PORTAL_URL` | `https://manus.im` |

Also update the Manus OAuth app settings so the allowed callback/redirect URL
matches your Railway domain:

```text
https://YOUR-RAILWAY-DOMAIN.up.railway.app/api/oauth/callback
```

or your production custom domain:

```text
https://teachific.app/api/oauth/callback
```

If these variables are omitted, Manus OAuth is disabled and email/password auth
continues to work.

### Optional — Cloudflare (if using Cloudflare for DNS/CDN)
| Variable | Value |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |
| `CLOUDFLARE_API_TOKEN` | Your Cloudflare API token |

---

## Step 5 — Run Database Migrations

After the first successful deployment, you need to apply all 68 database migrations in order.

1. In Railway, open your service → **Connect** → copy the MySQL connection string.
2. Connect using a MySQL client (TablePlus, DBeaver, or the `mysql` CLI):

```bash
mysql -h HOST -P PORT -u USER -p DATABASE_NAME
```

3. Run each migration file in order from `drizzle/0000_*.sql` through `drizzle/0067_*.sql`:

```bash
# From your local project directory:
for f in drizzle/*.sql; do
  echo "Running $f..."
  mysql -h HOST -P PORT -u USER -p DATABASE_NAME < "$f"
done
```

Or connect to Railway's MySQL and paste the contents of each file in sequence.

> **Important:** Run migrations in numerical order (0000 → 0067). Skipping or running out of order will cause foreign key errors.

---

## Step 6 — Configure Stripe Webhooks

1. Go to [Stripe Dashboard](https://dashboard.stripe.com) → **Developers** → **Webhooks**.
2. Click **Add endpoint**.
3. Set the URL to: `https://YOUR-RAILWAY-DOMAIN.up.railway.app/api/stripe/webhook`
4. Select these events:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.paid`
   - `invoice.payment_failed`
5. Copy the **Signing secret** and set it as `STRIPE_WEBHOOK_SECRET` in Railway.

---

## Step 7 — Point Your Domain to Railway

Once you've tested on the Railway-generated URL (e.g., `teachific-production.up.railway.app`):

1. In Railway, go to your service → **Settings** → **Networking** → **Custom Domain**.
2. Add `teachific.app` and `www.teachific.app`.
3. Railway will show you the DNS records to add.
4. In your domain registrar (GoDaddy), update the DNS:
   - Add a `CNAME` record: `www` → `teachific-production.up.railway.app`
   - Add an `ALIAS` or `A` record for the root domain as instructed by Railway.
5. SSL is provisioned automatically by Railway (Let's Encrypt).

---

## Step 8 — Set Up Org Subdomains (Optional)

Teachific supports org subdomains (e.g., `myschool.teachific.app`). To enable this on Railway:

1. Add a **wildcard DNS record**: `*.teachific.app` → `teachific-production.up.railway.app`
2. In Railway, add `*.teachific.app` as a custom domain.
3. Railway will provision a wildcard SSL certificate automatically.

---

## Testing Checklist

Before going live, verify these flows on your Railway staging URL:

- [ ] Homepage loads correctly
- [ ] Sign up with email/password works
- [ ] Login and logout work
- [ ] File upload (SCORM ZIP) completes and content plays
- [ ] Video upload works
- [ ] Course creation and publishing works
- [ ] Student enrollment and course access works
- [ ] Stripe checkout completes (use test card `4242 4242 4242 4242`)
- [ ] Email sending works (password reset, enrollment confirmation)
- [ ] AI course generator works (requires OpenAI key)
- [ ] Admin panel loads and shows correct data

---

## Cost Estimate (Monthly)

| Service | Free Tier | Paid |
|---|---|---|
| Railway (Hobby) | $5/month flat | Includes 8GB RAM, 100GB bandwidth |
| AWS S3 | 5GB free | ~$0.023/GB after that |
| OpenAI | Pay per use | ~$0.15/1M tokens (gpt-4o-mini) |
| SendGrid | 100 emails/day free | $19.95/month for 50k emails |
| Stripe | No monthly fee | 2.9% + $0.30 per transaction |

**Estimated total for a small school: ~$10–20/month**

---

## Troubleshooting

**Build fails on Railway:**
- Check that `pnpm-lock.yaml` is committed to git
- Ensure `NODE_ENV=production` is set

**Database connection errors:**
- Verify `DATABASE_URL` is injected by the Railway MySQL plugin
- Check that migrations ran successfully in order

**File uploads fail:**
- Verify all four `AWS_*` variables are set correctly
- Check that the S3 bucket policy allows public reads
- Confirm the IAM user has `AmazonS3FullAccess`

**Stripe webhooks not working:**
- Verify the webhook URL matches your Railway domain exactly
- Confirm `STRIPE_WEBHOOK_SECRET` matches the signing secret in Stripe Dashboard

**AI features not working:**
- Verify `OPENAI_API_KEY` is set and has credits
- Check Railway logs for LLM error messages

---

## Getting Help

- Railway docs: [docs.railway.app](https://docs.railway.app)
- AWS S3 docs: [docs.aws.amazon.com/s3](https://docs.aws.amazon.com/s3)
- OpenAI docs: [platform.openai.com/docs](https://platform.openai.com/docs)
- Teachific support: support@teachific.net
