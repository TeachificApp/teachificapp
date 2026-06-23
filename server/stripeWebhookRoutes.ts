/**
 * Stripe Webhook Handler
 * Handles subscription lifecycle events from Stripe.
 * MUST be registered BEFORE express.json() middleware.
 */
import express from "express";
import type Stripe from "stripe";
import { ENV } from "./_core/env";
import { getStripe, PLAN_LIMITS, type PlanTier } from "./stripePlans";
import { upsertOrgSubscription, createEnrollment, getEnrollment } from "./lmsDb";
import { getUserByEmail, getDb } from "./db";
import { sendEmail } from "./sendgrid";
import { courseEnrollmentHtml } from "./emailTemplates";
import { getCourseById } from "./lmsDb";
import { teachificPayDisputes, teachificPayCharges, organizations, users } from "../drizzle/schema";
import { eq, and } from "drizzle-orm";
import { notifyOwner } from "./_core/notification";

const router = express.Router();

type DbSubStatus = "active" | "trialing" | "past_due" | "cancelled" | "unpaid";
function normalizeStripeStatus(stripeStatus: string): DbSubStatus {
  if (stripeStatus === "canceled") return "cancelled";
  const valid: DbSubStatus[] = ["active", "trialing", "past_due", "cancelled", "unpaid"];
  return valid.includes(stripeStatus as DbSubStatus) ? (stripeStatus as DbSubStatus) : "active";
}

// Raw body parser for Stripe signature verification
router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    // Handle test events
    let event: Stripe.Event;
    try {
      if (ENV.isProduction) {
        if (!ENV.stripeWebhookSecret) {
          console.error("[Stripe Webhook] STRIPE_WEBHOOK_SECRET not set — rejecting event");
          return res.status(500).json({ error: "Webhook secret not configured" });
        }
        if (!sig) {
          return res.status(400).json({ error: "Missing stripe-signature header" });
        }
        const stripe = getStripe();
        event = stripe.webhooks.constructEvent(req.body, sig as string, ENV.stripeWebhookSecret);
      } else if (ENV.stripeWebhookSecret && sig) {
        const stripe = getStripe();
        event = stripe.webhooks.constructEvent(req.body, sig as string, ENV.stripeWebhookSecret);
      } else {
        event = JSON.parse(req.body.toString()) as Stripe.Event;
      }
    } catch (err: any) {
      console.error("[Stripe Webhook] Signature verification failed:", err.message);
      return res.status(400).json({ error: `Webhook Error: ${err.message}` });
    }

    // Test event detection
    if (event.id.startsWith("evt_test_")) {
      console.log("[Stripe Webhook] Test event detected, returning verification response");
      return res.json({ verified: true });
    }

    console.log(`[Stripe Webhook] Event: ${event.type} (${event.id})`);

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;

          // ── Course purchase (one-time payment) ──────────────────────────────
          if (session.mode === "payment" && session.metadata?.type === "course_purchase") {
            const courseId = parseInt(session.metadata?.course_id ?? "0");
            const orgId = parseInt(session.metadata?.org_id ?? "0");
            const buyerEmail = session.customer_details?.email ?? session.metadata?.customer_email ?? "";
            const amountPaid = session.amount_total ? session.amount_total / 100 : 0;
            if (courseId && orgId && buyerEmail) {
              try {
                const user = await getUserByEmail(buyerEmail);
                if (user) {
                  const existing = await getEnrollment(courseId, user.id);
                  if (!existing) {
                    await createEnrollment({ courseId, userId: user.id, orgId, amountPaid });
                    console.log(`[Stripe Webhook] User ${user.id} enrolled in course ${courseId}`);
                    const course = await getCourseById(courseId).catch(() => null);
                    await sendEmail({
                      to: user.email ?? "",
                      subject: `Your enrollment is confirmed!`,
                      html: courseEnrollmentHtml({
                        userName: user.name ?? "there",
                        courseTitles: course?.title ? [course.title] : ["your course"],
                        amountPaid,
                      }),
                    });
                  }
                } else {
                  console.warn(`[Stripe Webhook] No user for email ${buyerEmail} — enrollment deferred`);
                }
              } catch (enrollErr: any) {
                console.error("[Stripe Webhook] Course enrollment failed:", enrollErr.message);
              }
            }
            break;
          }

          // ── Studio / Creator / QuizMaker subscription checkout ──────────────────────
          const appProductType = session.metadata?.product_type;
          if (session.mode === "subscription" && (appProductType === "studio" || appProductType === "creator" || appProductType === "quiz_creator")) {
            const accessTier = session.metadata?.access_tier as string;
            const userId = parseInt(session.metadata?.user_id ?? "0");
            if (accessTier && userId) {
              try {
                const db = await getDb();
                if (db) {
                  const { users } = await import("../drizzle/schema");
                  const { eq } = await import("drizzle-orm");
                  // Fetch subscription to get trial end date
                  let trialEndsAt: Date | null = null;
                  if (session.subscription) {
                    const stripe = getStripe();
                    const sub = await stripe.subscriptions.retrieve(session.subscription as string);
                    if (sub.trial_end) trialEndsAt = new Date(sub.trial_end * 1000);
                  }
                  if (appProductType === "studio") {
                    await db.update(users)
                      .set({ studioAccess: accessTier as any, ...(trialEndsAt ? { studioTrialEndsAt: trialEndsAt } : {}) })
                      .where(eq(users.id, userId));
                  } else if (appProductType === "creator") {
                    await db.update(users)
                      .set({ creatorAccess: accessTier as any, ...(trialEndsAt ? { creatorTrialEndsAt: trialEndsAt } : {}) })
                      .where(eq(users.id, userId));
                  } else if (appProductType === "quiz_creator") {
                    await db.update(users)
                      .set({ quizCreatorAccess: accessTier as any, ...(trialEndsAt ? { quizCreatorTrialEndsAt: trialEndsAt } : {}) })
                      .where(eq(users.id, userId));
                  }
                  console.log(`[Stripe Webhook] User ${userId} ${appProductType} access updated to ${accessTier}${trialEndsAt ? ` (trial until ${trialEndsAt.toISOString()})` : ""}`);
                }
              } catch (err: any) {
                console.error(`[Stripe Webhook] ${appProductType} access update failed:`, err.message);
              }
            }
            break;
          }

          // ── Org subscription checkout ───────────────────────────────────────────────
          if (session.mode !== "subscription") break;

          const orgId = parseInt(session.metadata?.org_id ?? "0");
          const plan = (session.metadata?.plan ?? "starter") as PlanTier;
          const customerId = session.customer as string;
          const subscriptionId = session.subscription as string;

          if (!orgId) {
            console.error("[Stripe Webhook] Missing org_id in checkout session metadata");
            break;
          }

          // Fetch subscription details
          const stripe = getStripe();
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);

          const item = subscription.items.data[0];
          await upsertOrgSubscription(orgId, {
            plan,
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscriptionId,
            status: normalizeStripeStatus(subscription.status),
            currentPeriodStart: item ? new Date(item.current_period_start * 1000) : undefined,
            currentPeriodEnd: item ? new Date(item.current_period_end * 1000) : undefined,
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
          });

          console.log(`[Stripe Webhook] Org ${orgId} upgraded to ${plan}`);
          break;
        }

        case "customer.subscription.updated": {
          const subscription = event.data.object as Stripe.Subscription;
          const orgId = parseInt(subscription.metadata?.org_id ?? "0");
          if (!orgId) break;

          // Determine plan from price metadata
          const priceId = subscription.items.data[0]?.price?.id;
          let plan: PlanTier = "free";
          if (priceId) {
            const stripe = getStripe();
            const price = await stripe.prices.retrieve(priceId);
            plan = (price.metadata?.teachific_tier as PlanTier) ?? "free";
          }

          const item2 = subscription.items.data[0];
          await upsertOrgSubscription(orgId, {
            plan,
            status: normalizeStripeStatus(subscription.status),
            currentPeriodStart: item2 ? new Date(item2.current_period_start * 1000) : undefined,
            currentPeriodEnd: item2 ? new Date(item2.current_period_end * 1000) : undefined,
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
          });

          console.log(`[Stripe Webhook] Org ${orgId} subscription updated: ${subscription.status}`);
          break;
        }

        case "customer.subscription.deleted": {
          const subscription = event.data.object as Stripe.Subscription;
          const orgId = parseInt(subscription.metadata?.org_id ?? "0");
          if (!orgId) break;

          await upsertOrgSubscription(orgId, {
            plan: "free",
            status: "cancelled",
            cancelAtPeriodEnd: false,
          });

          console.log(`[Stripe Webhook] Org ${orgId} subscription cancelled, downgraded to free`);
          break;
        }

        case "invoice.payment_failed": {
          const invoice = event.data.object as Stripe.Invoice;
          const subscriptionId = (invoice as any).subscription as string;
          if (!subscriptionId) break;

          const stripe = getStripe();
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const orgId = parseInt(subscription.metadata?.org_id ?? "0");
          if (!orgId) break;

          await upsertOrgSubscription(orgId, { status: "past_due" });
          console.log(`[Stripe Webhook] Org ${orgId} payment failed, status: past_due`);
          break;
        }

        // ── TeachificPay: log completed charges ──────────────────────────────
        case "charge.succeeded": {
          const charge = event.data.object as Stripe.Charge;
          if (!charge.transfer_data?.destination) break; // Only log TeachificPay charges
          const db = await getDb();
          if (!db) break;
          // Find org by Connect account ID
          const [org] = await db.select({ id: organizations.id })
            .from(organizations)
            .where(eq(organizations.stripeConnectAccountId as any, charge.transfer_data.destination as string))
            .limit(1);
          if (!org) break;
          const netAmount = charge.amount - (charge.application_fee_amount ?? 0);
          await db.insert(teachificPayCharges).values({
            orgId: org.id,
            stripeChargeId: charge.id,
            stripePaymentIntentId: charge.payment_intent as string ?? null,
            amount: charge.amount,
            platformFee: charge.application_fee_amount ?? 0,
            netAmount,
            currency: charge.currency,
            status: "succeeded",
            amountRefunded: 0,
            learnerEmail: charge.billing_details?.email ?? null,
          }).onDuplicateKeyUpdate({ set: { status: "succeeded" } });
          console.log(`[Stripe Webhook] Charge ${charge.id} logged for org ${org.id}`);
          break;
        }

        // ── TeachificPay: dispute opened ──────────────────────────────────────
        case "charge.dispute.created": {
          const dispute = event.data.object as Stripe.Dispute;
          const db = await getDb();
          if (!db) break;
          // Find org by charge
          const [chargeRow] = await db.select()
            .from(teachificPayCharges)
            .where(eq(teachificPayCharges.stripeChargeId, dispute.charge as string))
            .limit(1);
          const orgId = chargeRow?.orgId ?? 0;
          if (!orgId) {
            console.warn(`[Stripe Webhook] Dispute ${dispute.id} — no matching charge row, skipping`);
            break;
          }
          await db.insert(teachificPayDisputes).values({
            orgId,
            stripeDisputeId: dispute.id,
            stripeChargeId: dispute.charge as string,
            stripePaymentIntentId: dispute.payment_intent as string ?? null,
            amount: dispute.amount,
            currency: dispute.currency,
            status: dispute.status as any,
            reason: dispute.reason,
            evidenceDueBy: dispute.evidence_details?.due_by ? dispute.evidence_details.due_by * 1000 : null,
            courseId: chargeRow?.courseId ?? null,
            learnerId: chargeRow?.learnerId ?? null,
            learnerEmail: chargeRow?.learnerEmail ?? null,
            accessRevoked: false,
          }).onDuplicateKeyUpdate({ set: { status: dispute.status as any } });
          // Update charge status
          await db.update(teachificPayCharges)
            .set({ status: "refunded" })
            .where(eq(teachificPayCharges.stripeChargeId, dispute.charge as string));
          console.log(`[Stripe Webhook] Dispute ${dispute.id} opened for org ${orgId}`);

          // ── Fetch school name and platform owner email for rich notification ──
          const [disputeOrg] = await db.select({ name: organizations.name })
            .from(organizations).where(eq(organizations.id, orgId)).limit(1);
          const schoolName = disputeOrg?.name ?? `Org #${orgId}`;
          const [ownerRow] = await db.select({ email: users.email, name: users.name })
            .from(users).where(eq(users.openId, ENV.ownerOpenId)).limit(1);
          const ownerEmail = ownerRow?.email ?? null;

          const amountStr = `$${(dispute.amount / 100).toFixed(2)} ${dispute.currency.toUpperCase()}`;
          const reasonLabel = (dispute.reason ?? "unknown").replace(/_/g, " ");
          const dueDateStr = dispute.evidence_details?.due_by
            ? new Date(dispute.evidence_details.due_by * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
            : "Unknown";
          const adminDisputeUrl = `https://teachific.app/admin?tab=teachificpay&subtab=disputes`;

          // In-app notification (always fires)
          await notifyOwner({
            title: "⚠️ New Chargeback Dispute",
            content: `${schoolName} has a new ${amountStr} dispute (${reasonLabel}). Evidence due: ${dueDateStr}. Review at ${adminDisputeUrl}`,
          }).catch(() => {});

          // Rich HTML email to platform owner
          if (ownerEmail) {
            const disputeEmailHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;margin:0;padding:0}
  .wrap{max-width:600px;margin:32px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)}
  .hdr{background:#dc2626;padding:24px 32px}.hdr h1{color:#fff;margin:0;font-size:20px;font-weight:700}
  .hdr p{color:#fecaca;margin:4px 0 0;font-size:14px}
  .body{padding:32px}
  .alert{background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:16px 20px;margin-bottom:24px}
  .alert .amt{font-size:28px;font-weight:700;color:#dc2626}
  .alert .rsn{font-size:14px;color:#7f1d1d;margin-top:4px;text-transform:capitalize}
  table.det{width:100%;border-collapse:collapse;margin-bottom:24px}
  table.det td{padding:10px 0;border-bottom:1px solid #f3f4f6;font-size:14px;color:#374151}
  table.det td:first-child{font-weight:600;color:#111827;width:40%}
  .dl{background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:14px 20px;margin-bottom:24px}
  .dl strong{color:#92400e}
  .cta{display:inline-block;background:#0d9488;color:#fff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;font-size:15px}
  .ftr{background:#f9fafb;padding:20px 32px;font-size:12px;color:#9ca3af;border-top:1px solid #e5e7eb}
</style></head>
<body><div class="wrap">
  <div class="hdr"><h1>⚠️ New Chargeback Dispute</h1><p>Action required — evidence submission deadline approaching</p></div>
  <div class="body">
    <div class="alert"><div class="amt">${amountStr}</div><div class="rsn">Reason: ${reasonLabel}</div></div>
    <table class="det">
      <tr><td>School</td><td>${schoolName}</td></tr>
      <tr><td>Learner</td><td>${chargeRow?.learnerEmail ?? "Unknown"}</td></tr>
      <tr><td>Dispute ID</td><td style="font-family:monospace;font-size:12px">${dispute.id}</td></tr>
      <tr><td>Charge ID</td><td style="font-family:monospace;font-size:12px">${dispute.charge as string}</td></tr>
      <tr><td>Status</td><td>${dispute.status}</td></tr>
    </table>
    <div class="dl"><strong>Evidence deadline: ${dueDateStr}</strong><br>
      <span style="font-size:13px;color:#78350f">Submit compelling evidence to Stripe before this date to contest the dispute.</span>
    </div>
    <a href="${adminDisputeUrl}" class="cta">Review Dispute in Admin Panel →</a>
  </div>
  <div class="ftr">Automated notification from Teachific™. You are receiving this as the platform owner.</div>
</div></body></html>`;
            await sendEmail({
              to: ownerEmail,
              subject: `⚠️ New Dispute: ${amountStr} from ${schoolName} — Evidence Due ${dueDateStr}`,
              html: disputeEmailHtml,
            }).catch((err) => console.error("[Dispute Email] Failed to send:", err));
          }
          break;
        }

        // ── TeachificPay: dispute updated ─────────────────────────────────────
        case "charge.dispute.updated": {
          const dispute = event.data.object as Stripe.Dispute;
          const db = await getDb();
          if (!db) break;
          await db.update(teachificPayDisputes)
            .set({
              status: dispute.status as any,
              evidenceDueBy: dispute.evidence_details?.due_by ? dispute.evidence_details.due_by * 1000 : null,
            })
            .where(eq(teachificPayDisputes.stripeDisputeId, dispute.id));
          console.log(`[Stripe Webhook] Dispute ${dispute.id} updated: ${dispute.status}`);
          break;
        }

        // ── TeachificPay: dispute closed (won or lost) ────────────────────────
        case "charge.dispute.closed": {
          const dispute = event.data.object as Stripe.Dispute;
          const db = await getDb();
          if (!db) break;
          await db.update(teachificPayDisputes)
            .set({ status: dispute.status as any })
            .where(eq(teachificPayDisputes.stripeDisputeId, dispute.id));
          console.log(`[Stripe Webhook] Dispute ${dispute.id} closed: ${dispute.status}`);
          // Fetch school name and owner email for outcome notification
          const [closedDisputeRow] = await db.select({ orgId: teachificPayDisputes.orgId, learnerEmail: teachificPayDisputes.learnerEmail })
            .from(teachificPayDisputes).where(eq(teachificPayDisputes.stripeDisputeId, dispute.id)).limit(1);
          const closedOrgId = closedDisputeRow?.orgId ?? 0;
          let closedSchoolName = `Org #${closedOrgId}`;
          if (closedOrgId) {
            const [cOrg] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, closedOrgId)).limit(1);
            closedSchoolName = cOrg?.name ?? closedSchoolName;
          }
          const [closedOwner] = await db.select({ email: users.email }).from(users).where(eq(users.openId, ENV.ownerOpenId)).limit(1);
          const closedOwnerEmail = closedOwner?.email ?? null;
          const closedAmountStr = `$${(dispute.amount / 100).toFixed(2)} ${dispute.currency.toUpperCase()}`;
          const adminUrl2 = `https://teachific.app/admin?tab=teachificpay&subtab=disputes`;

          if (dispute.status === "won") {
            await notifyOwner({
              title: "✅ Dispute Won",
              content: `The ${closedAmountStr} dispute from ${closedSchoolName} was resolved in your favor. Review at ${adminUrl2}`,
            }).catch(() => {});
            if (closedOwnerEmail) {
              await sendEmail({
                to: closedOwnerEmail,
                subject: `✅ Dispute Won: ${closedAmountStr} from ${closedSchoolName}`,
                html: `<div style="font-family:sans-serif;max-width:600px;margin:32px auto;padding:32px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px">
  <h2 style="color:#15803d;margin-top:0">✅ Dispute Resolved in Your Favor</h2>
  <p style="color:#166534">The <strong>${closedAmountStr}</strong> dispute from <strong>${closedSchoolName}</strong> has been <strong>won</strong>. The funds will remain in the connected account.</p>
  <p style="color:#166534">Learner: ${closedDisputeRow?.learnerEmail ?? "Unknown"}</p>
  <a href="${adminUrl2}" style="display:inline-block;background:#0d9488;color:#fff;text-decoration:none;padding:10px 24px;border-radius:6px;font-weight:600;margin-top:16px">View in Admin Panel →</a>
  <p style="font-size:12px;color:#6b7280;margin-top:24px">Teachific™ automated notification</p>
</div>`,
              }).catch(() => {});
            }
          } else if (dispute.status === "lost") {
            await notifyOwner({
              title: "❌ Dispute Lost",
              content: `The ${closedAmountStr} dispute from ${closedSchoolName} was resolved against you. Funds returned to cardholder. Review at ${adminUrl2}`,
            }).catch(() => {});
            if (closedOwnerEmail) {
              await sendEmail({
                to: closedOwnerEmail,
                subject: `❌ Dispute Lost: ${closedAmountStr} from ${closedSchoolName}`,
                html: `<div style="font-family:sans-serif;max-width:600px;margin:32px auto;padding:32px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px">
  <h2 style="color:#dc2626;margin-top:0">❌ Dispute Resolved Against You</h2>
  <p style="color:#7f1d1d">The <strong>${closedAmountStr}</strong> dispute from <strong>${closedSchoolName}</strong> has been <strong>lost</strong>. The funds have been returned to the cardholder and a $15 dispute fee has been charged by Stripe.</p>
  <p style="color:#7f1d1d">Learner: ${closedDisputeRow?.learnerEmail ?? "Unknown"}</p>
  <a href="${adminUrl2}" style="display:inline-block;background:#0d9488;color:#fff;text-decoration:none;padding:10px 24px;border-radius:6px;font-weight:600;margin-top:16px">View in Admin Panel →</a>
  <p style="font-size:12px;color:#6b7280;margin-top:24px">Teachific™ automated notification</p>
</div>`,
              }).catch(() => {});
            }
          }
          break;
        }

        // ── TeachificPay: charge refunded ─────────────────────────────────────
        case "charge.refunded": {
          const charge = event.data.object as Stripe.Charge;
          const db = await getDb();
          if (!db) break;
          const newStatus = charge.amount_refunded >= charge.amount ? "refunded" : "partially_refunded";
          await db.update(teachificPayCharges)
            .set({ status: newStatus, amountRefunded: charge.amount_refunded })
            .where(eq(teachificPayCharges.stripeChargeId, charge.id));
          console.log(`[Stripe Webhook] Charge ${charge.id} refunded: ${charge.amount_refunded} cents`);
          break;
        }

        case "account.updated": {
          // Stripe Connect: sync account status when onboarding completes or capabilities change
          const account = event.data.object as Stripe.Account;
          const accountId = account.id;
          if (!accountId) break;
          const db = await getDb();
          if (!db) break;
          const { organizations } = await import("../drizzle/schema");
          const { eq } = await import("drizzle-orm");
          // Determine new status
          const chargesEnabled = account.charges_enabled ?? false;
          const payoutsEnabled = account.payouts_enabled ?? false;
          const detailsSubmitted = account.details_submitted ?? false;
          let newStatus: string;
          if (chargesEnabled && payoutsEnabled) {
            newStatus = "active";
          } else if (detailsSubmitted) {
            newStatus = "pending";
          } else {
            newStatus = "incomplete";
          }
          // Update the org that has this Connect account
          await db
            .update(organizations)
            .set({ stripeConnectStatus: newStatus } as any)
            .where(eq((organizations as any).stripeConnectAccountId, accountId));
          console.log(`[Stripe Webhook] Connect account ${accountId} status updated to ${newStatus}`);
          break;
        }

        default:
          console.log(`[Stripe Webhook] Unhandled event type: ${event.type}`);
      }
    } catch (err: any) {
      console.error("[Stripe Webhook] Processing error:", err.message);
      return res.status(500).json({ error: "Webhook processing failed" });
    }

    res.json({ received: true });
  }
);

export default router;
