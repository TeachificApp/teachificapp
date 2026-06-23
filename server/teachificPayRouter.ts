/**
 * TeachificPay Router
 *
 * Handles Stripe Connect Express onboarding, platform-fee checkout,
 * gateway enforcement, and payout data for school owners/admins.
 *
 * Rules:
 *  - Free: MUST use TeachificPay (2% platform fee)
 *  - Starter: MUST use TeachificPay (1% platform fee)
 *  - Builder: MUST use TeachificPay (0.5% platform fee)
 *  - Pro / Enterprise: can choose TeachificPay (0% fee) or own gateway
 *  - Group registrations: follow the org's gateway setting
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq, desc, and, sql, or, like, gte, lte } from "drizzle-orm";
import { organizations, teachificPayDisputes, teachificPayCharges } from "../drizzle/schema";
import { protectedProcedure, router } from "./_core/trpc";
import { getStripe, PLAN_LIMITS, PlanTier } from "./stripePlans";
import { getOrgSubscription } from "./lmsDb";
import { getDb } from "./db";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getOrgWithPlan(orgId: number) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw new TRPCError({ code: "NOT_FOUND", message: "Organization not found" });

  const sub = await getOrgSubscription(orgId);
  const tier: PlanTier = (sub?.plan as PlanTier) ?? "free";
  const limits = PLAN_LIMITS[tier];
  return { org, tier, limits };
}

function requireOrgAccess(ctx: { user: { id: number; role: string } }, ownerId: number) {
  const isSiteAdmin = ctx.user.role === "site_owner" || ctx.user.role === "site_admin";
  const isOwner = ctx.user.id === ownerId;
  if (!isSiteAdmin && !isOwner) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const teachificPayRouter = router({
  /**
   * Get TeachificPay status for an org (gateway, connect status, fees).
   * Accessible by org owner, org admins, and site admins.
   */
  getStatus: protectedProcedure
    .input(z.object({ orgId: z.number() }))
    .query(async ({ ctx, input }) => {
      const { org, tier, limits } = await getOrgWithPlan(input.orgId);
      requireOrgAccess(ctx, org.ownerId);

      return {
        orgId: org.id,
        orgName: org.name,
        tier,
        paymentGateway: org.paymentGateway ?? "teachific_pay",
        stripeConnectStatus: org.stripeConnectStatus ?? "not_connected",
        stripeConnectAccountId: org.stripeConnectAccountId ?? null,
        canUseOwnGateway: limits.customGateway,
        teachificPayFeePercent: limits.teachificPayFeePercent,
        hasOwnGateway: !!org.ownStripePublishableKey,
      };
    }),

  /**
   * Start Stripe Connect Express onboarding for an org.
   * Returns the onboarding URL to redirect the user to.
   */
  startConnectOnboarding: protectedProcedure
    .input(
      z.object({
        orgId: z.number(),
        returnUrl: z.string().url(),
        refreshUrl: z.string().url(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { org, tier } = await getOrgWithPlan(input.orgId);
      requireOrgAccess(ctx, org.ownerId);

      const stripe = getStripe();

      // Create or reuse the Connect account
      let accountId = org.stripeConnectAccountId;
      if (!accountId) {
        const account = await stripe.accounts.create({
          type: "express",
          email: ctx.user.email ?? undefined,
          metadata: {
            orgId: String(input.orgId),
            orgName: org.name,
            tier,
          },
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
          },
        });
        accountId = account.id;

        const dbConn = await getDb();
        if (!dbConn) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        await dbConn
          .update(organizations)
          .set({
            stripeConnectAccountId: accountId,
            stripeConnectStatus: "pending",
          })
          .where(eq(organizations.id, input.orgId));
      }

      // Create an account link for onboarding
      const accountLink = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: input.refreshUrl,
        return_url: input.returnUrl,
        type: "account_onboarding",
      });

      return { url: accountLink.url, accountId };
    }),

  /**
   * Sync Connect account status from Stripe (call after onboarding return).
   */
  syncConnectStatus: protectedProcedure
    .input(z.object({ orgId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const { org } = await getOrgWithPlan(input.orgId);
      requireOrgAccess(ctx, org.ownerId);

      if (!org.stripeConnectAccountId) {
        return { status: "not_connected" as const };
      }

      const stripe = getStripe();
      const account = await stripe.accounts.retrieve(org.stripeConnectAccountId);

      let status: "not_connected" | "pending" | "active" | "restricted" | "suspended" = "pending";
      if (account.charges_enabled && account.payouts_enabled) {
        status = "active";
      } else if (account.requirements?.disabled_reason) {
        status = "restricted";
      }

      const dbSync = await getDb();
      if (!dbSync) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      await dbSync
        .update(organizations)
        .set({ stripeConnectStatus: status })
        .where(eq(organizations.id, input.orgId));

      return { status, chargesEnabled: account.charges_enabled, payoutsEnabled: account.payouts_enabled };
    }),

  /**
   * Update payment gateway preference for Builder+ orgs.
   * Free/Starter cannot change this — they are locked to teachific_pay.
   */
  setGateway: protectedProcedure
    .input(
      z.object({
        orgId: z.number(),
        gateway: z.enum(["teachific_pay", "own_gateway"]),
        ownStripePublishableKey: z.string().optional(),
        ownStripeSecretKey: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { org, limits } = await getOrgWithPlan(input.orgId);
      requireOrgAccess(ctx, org.ownerId);

      if (input.gateway === "own_gateway" && !limits.customGateway) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Your plan does not support custom payment gateways. Upgrade to Pro or higher.",
        });
      }

      const updates: Partial<typeof organizations.$inferInsert> = {
        paymentGateway: input.gateway,
      };

      if (input.gateway === "own_gateway") {
        if (input.ownStripePublishableKey) {
          updates.ownStripePublishableKey = input.ownStripePublishableKey;
        }
        // In production, encrypt the secret key before storing
        if (input.ownStripeSecretKey) {
          updates.ownStripeSecretKeyEncrypted = input.ownStripeSecretKey;
        }
      }

      const dbUpd = await getDb();
      if (!dbUpd) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      await dbUpd.update(organizations).set(updates).where(eq(organizations.id, input.orgId));

      return { success: true, gateway: input.gateway };
    }),

  /**
   * Create a TeachificPay checkout session for a course purchase.
   * Enforces gateway rules: Free/Starter/Builder must use TeachificPay.
   * Pro/Enterprise can use their own gateway or TeachificPay.
   */
  createCheckout: protectedProcedure
    .input(
      z.object({
        orgId: z.number(),
        courseId: z.number(),
        priceInCents: z.number().min(50),
        courseName: z.string(),
        isGroupRegistration: z.boolean().default(false),
        groupSize: z.number().min(1).default(1),
        successUrl: z.string().url(),
        cancelUrl: z.string().url(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { org, tier, limits } = await getOrgWithPlan(input.orgId);

      const stripe = getStripe();
      const useTeachificPay =
        !limits.customGateway || // Free/Starter/Builder must use TeachificPay
        org.paymentGateway === "teachific_pay"; // Pro/Enterprise opted into TeachificPay

      if (!useTeachificPay && !org.stripeConnectAccountId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Own gateway selected but Stripe Connect account not configured.",
        });
      }

      const feePercent = limits.teachificPayFeePercent;
      const platformFeeAmount = useTeachificPay
        ? Math.round(input.priceInCents * (feePercent / 100))
        : 0;

      const sessionParams: Parameters<typeof stripe.checkout.sessions.create>[0] = {
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: input.courseName,
                metadata: { orgId: String(input.orgId), courseId: String(input.courseId) },
              },
              unit_amount: input.priceInCents,
            },
            quantity: input.groupSize,
          },
        ],
        mode: "payment",
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        allow_promotion_codes: true,
        client_reference_id: String(ctx.user.id),
        customer_email: ctx.user.email ?? undefined,
        metadata: {
          user_id: String(ctx.user.id),
          org_id: String(input.orgId),
          course_id: String(input.courseId),
          is_group_registration: String(input.isGroupRegistration),
          group_size: String(input.groupSize),
          gateway: useTeachificPay ? "teachific_pay" : "own_gateway",
          platform_fee_percent: String(feePercent),
        },
      };

      // Add platform fee and transfer for TeachificPay
      if (useTeachificPay && org.stripeConnectAccountId) {
        sessionParams.payment_intent_data = {
          ...(platformFeeAmount > 0 ? { application_fee_amount: platformFeeAmount } : {}),
          transfer_data: {
            destination: org.stripeConnectAccountId,
          },
        };
      }

      const session = await stripe.checkout.sessions.create(sessionParams);
      return { checkoutUrl: session.url, sessionId: session.id, platformFeeAmount, useTeachificPay };
    }),

  /**
   * Get payout/earnings summary for an org (for school owner/admin dashboard).
   */
  getEarnings: protectedProcedure
    .input(z.object({ orgId: z.number() }))
    .query(async ({ ctx, input }) => {
      const { org } = await getOrgWithPlan(input.orgId);
      requireOrgAccess(ctx, org.ownerId);

      if (!org.stripeConnectAccountId) {
        return {
          connected: false,
          balance: null,
          payouts: [],
          recentCharges: [],
        };
      }
      const connectedAcct = org.stripeConnectAccountId!;
      const stripeClient = getStripe();
      const [balance, payouts, charges] = await Promise.all([
        stripeClient.balance.retrieve({ stripeAccount: connectedAcct } as any),
        stripeClient.payouts.list({ limit: 10 }, { stripeAccount: connectedAcct }),
        stripeClient.charges.list({ limit: 20 }, { stripeAccount: connectedAcct }),
      ]);

      return {
        connected: true,
        balance: {
          available: (balance as any).available.map((b: any) => ({ amount: b.amount, currency: b.currency })),
          pending: (balance as any).pending.map((b: any) => ({ amount: b.amount, currency: b.currency })),
        },
        payouts: payouts.data.map((p: any) => ({
          id: p.id,
          amount: p.amount,
          currency: p.currency,
          status: p.status,
          arrivalDate: p.arrival_date,
          createdAt: p.created,
        })),
        recentCharges: charges.data.map((c: any) => ({
          id: c.id,
          amount: c.amount,
          currency: c.currency,
          status: c.status,
          description: c.description,
          createdAt: c.created,
          refunded: c.refunded,
        })),
      };
    }),

  // ─── Platform Admin Procedures ─────────────────────────────────────────────

  /**
   * [Platform Admin] List all orgs with their TeachificPay status.
   */
  adminListAccounts: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role !== "site_owner" && ctx.user.role !== "site_admin") {
      throw new TRPCError({ code: "FORBIDDEN" });
    }

    const dbAdmin = await getDb();
    if (!dbAdmin) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
    const orgs = await dbAdmin
      .select({
        id: organizations.id,
        name: organizations.name,
        ownerId: organizations.ownerId,
        stripeConnectAccountId: organizations.stripeConnectAccountId,
        stripeConnectStatus: organizations.stripeConnectStatus,
        paymentGateway: organizations.paymentGateway,
        createdAt: organizations.createdAt,
      })
      .from(organizations)
      .orderBy(desc(organizations.createdAt));

    return orgs;
  }),

  /**
   * [Platform Admin] Get platform-wide fee revenue summary.
   */
  adminGetPlatformRevenue: protectedProcedure.query(async ({ ctx }) => {
    if (ctx.user.role !== "site_owner" && ctx.user.role !== "site_admin") {
      throw new TRPCError({ code: "FORBIDDEN" });
    }

    const stripe = getStripe();

    // Get application fee revenue (platform fees collected)
    const applicationFees = await stripe.applicationFees.list({ limit: 100 });

    const totalFeesCollected = applicationFees.data.reduce((sum, fee) => sum + fee.amount, 0);
    const totalFeesRefunded = applicationFees.data.reduce((sum, fee) => sum + fee.amount_refunded, 0);

    return {
      totalFeesCollected,
      totalFeesRefunded,
      netFees: totalFeesCollected - totalFeesRefunded,
      recentFees: applicationFees.data.slice(0, 20).map((fee) => ({
        id: fee.id,
        amount: fee.amount,
        amountRefunded: fee.amount_refunded,
        currency: fee.currency,
        createdAt: fee.created,
        originatingChargeId: fee.originating_transaction,
      })),
    };
  }),

  /**
   * [Platform Admin] Override gateway for an org (e.g., suspend processing).
   */
  adminSetOrgGateway: protectedProcedure
    .input(
      z.object({
        orgId: z.number(),
        gateway: z.enum(["teachific_pay", "own_gateway"]),
        connectStatus: z.enum(["not_connected", "pending", "active", "restricted", "suspended"]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "site_owner" && ctx.user.role !== "site_admin") {
        throw new TRPCError({ code: "FORBIDDEN" });
      }

      const updates: Partial<typeof organizations.$inferInsert> = {
        paymentGateway: input.gateway,
      };
      if (input.connectStatus) {
        updates.stripeConnectStatus = input.connectStatus;
      }

      const dbUpd2 = await getDb();
      if (!dbUpd2) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      await dbUpd2.update(organizations).set(updates).where(eq(organizations.id, input.orgId));

      return { success: true };
    }),

  // ─── Dispute Management (Org Owner) ─────────────────────────────────────────
  /**
   * List disputes for an org (school owner view).
   */
  listDisputes: protectedProcedure
    .input(z.object({ orgId: z.number() }))
    .query(async ({ ctx, input }) => {
      const { org } = await getOrgWithPlan(input.orgId);
      requireOrgAccess(ctx, org.ownerId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const rows = await db.select()
        .from(teachificPayDisputes)
        .where(eq(teachificPayDisputes.orgId, input.orgId))
        .orderBy(desc(teachificPayDisputes.createdAt))
        .limit(100);
      return rows;
    }),

  /**
   * Submit dispute evidence for a specific dispute.
   */
  submitDisputeEvidence: protectedProcedure
    .input(z.object({
      orgId: z.number(),
      disputeId: z.string(),
      productDescription: z.string().optional(),
      customerEmailAddress: z.string().optional(),
      serviceDate: z.string().optional(),
      uncategorizedText: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { org } = await getOrgWithPlan(input.orgId);
      requireOrgAccess(ctx, org.ownerId);
      const stripe = getStripe();
      const evidence: Record<string, string> = {};
      if (input.productDescription) evidence.product_description = input.productDescription;
      if (input.customerEmailAddress) evidence.customer_email_address = input.customerEmailAddress;
      if (input.serviceDate) evidence.service_date = input.serviceDate;
      if (input.uncategorizedText) evidence.uncategorized_text = input.uncategorizedText;
      await stripe.disputes.update(input.disputeId, { evidence: evidence as any, submit: true });
      const db = await getDb();
      if (db) {
        await db.update(teachificPayDisputes)
          .set({ evidenceSubmitted: true })
          .where(eq(teachificPayDisputes.stripeDisputeId, input.disputeId));
      }
      return { success: true };
    }),

  // ─── Charge History (Org Owner) ───────────────────────────────────────────
  /**
   * List charge history for an org.
   */
  listCharges: protectedProcedure
    .input(z.object({ orgId: z.number(), limit: z.number().min(1).max(200).default(50) }))
    .query(async ({ ctx, input }) => {
      const { org } = await getOrgWithPlan(input.orgId);
      requireOrgAccess(ctx, org.ownerId);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const rows = await db.select()
        .from(teachificPayCharges)
        .where(eq(teachificPayCharges.orgId, input.orgId))
        .orderBy(desc(teachificPayCharges.chargedAt))
        .limit(input.limit);
      return rows;
    }),

  /**
   * Issue a refund on a charge (org owner can refund their own charges).
   */
  refundCharge: protectedProcedure
    .input(z.object({
      orgId: z.number(),
      chargeId: z.string(),
      amountCents: z.number().optional(),
      reason: z.enum(["duplicate", "fraudulent", "requested_by_customer"]).default("requested_by_customer"),
    }))
    .mutation(async ({ ctx, input }) => {
      const { org } = await getOrgWithPlan(input.orgId);
      requireOrgAccess(ctx, org.ownerId);
      // Verify the charge belongs to this org
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [chargeRow] = await db.select()
        .from(teachificPayCharges)
        .where(and(eq(teachificPayCharges.orgId, input.orgId), eq(teachificPayCharges.stripeChargeId, input.chargeId)))
        .limit(1);
      if (!chargeRow) throw new TRPCError({ code: "NOT_FOUND", message: "Charge not found for this org" });
      const stripe = getStripe();
      const refund = await stripe.refunds.create({
        charge: input.chargeId,
        amount: input.amountCents,
        reason: input.reason,
      });
      return { refundId: refund.id, status: refund.status, amount: refund.amount, currency: refund.currency };
    }),

  // ─── Platform Admin: Disputes ─────────────────────────────────────────────
  /**
   * [Platform Admin] List all disputes across all orgs.
   */
  adminListDisputes: protectedProcedure
    .input(z.object({ limit: z.number().default(100) }))
    .query(async ({ ctx, input }) => {
      if (ctx.user.role !== "site_owner" && ctx.user.role !== "site_admin") {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const rows = await db.select()
        .from(teachificPayDisputes)
        .orderBy(desc(teachificPayDisputes.createdAt))
        .limit(input.limit);
      return rows;
    }),

  /**
   * [Platform Admin] List all charges across all orgs.
   */
  adminListCharges: protectedProcedure
    .input(z.object({ limit: z.number().default(100) }))
    .query(async ({ ctx, input }) => {
      if (ctx.user.role !== "site_owner" && ctx.user.role !== "site_admin") {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const rows = await db.select()
        .from(teachificPayCharges)
        .orderBy(desc(teachificPayCharges.chargedAt))
        .limit(input.limit);
      return rows;
    }),

  /**
   * [Platform Admin] Issue a refund on a charge via the platform account.
   */
  adminRefundCharge: protectedProcedure
    .input(
      z.object({
        chargeId: z.string(),
        amountCents: z.number().optional(),
        reason: z.enum(["duplicate", "fraudulent", "requested_by_customer"]).default("requested_by_customer"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "site_owner" && ctx.user.role !== "site_admin") {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      const stripe = getStripe();
      const refund = await stripe.refunds.create({
        charge: input.chargeId,
        amount: input.amountCents,
        reason: input.reason,
      });
      return { refundId: refund.id, status: refund.status, amount: refund.amount, currency: refund.currency };
    }),

  // ─── Platform Admin: Enhanced Dispute Management ──────────────────────────

  /**
   * [Platform Admin] Enhanced dispute list with org name, filters, and pagination.
   */
  adminListAllDisputes: protectedProcedure
    .input(z.object({
      limit: z.number().default(50),
      offset: z.number().default(0),
      status: z.string().optional(),
      orgId: z.number().optional(),
      search: z.string().optional(),
      dateFrom: z.number().optional(),
      dateTo: z.number().optional(),
    }))
    .query(async ({ ctx, input }) => {
      if (ctx.user.role !== "site_owner" && ctx.user.role !== "site_admin") {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const conditions: ReturnType<typeof eq>[] = [];
      if (input.status && input.status !== "all") {
        conditions.push(eq(teachificPayDisputes.status, input.status as any));
      }
      if (input.orgId) conditions.push(eq(teachificPayDisputes.orgId, input.orgId));
      if (input.search) {
        conditions.push(
          or(
            like(teachificPayDisputes.learnerEmail, `%${input.search}%`),
            like(teachificPayDisputes.stripeDisputeId, `%${input.search}%`),
            like(teachificPayDisputes.stripeChargeId, `%${input.search}%`),
          ) as any
        );
      }
      if (input.dateFrom) conditions.push(gte(teachificPayDisputes.createdAt, new Date(input.dateFrom)) as any);
      if (input.dateTo) conditions.push(lte(teachificPayDisputes.createdAt, new Date(input.dateTo)) as any);

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, countRows] = await Promise.all([
        db.select({
          id: teachificPayDisputes.id,
          orgId: teachificPayDisputes.orgId,
          stripeDisputeId: teachificPayDisputes.stripeDisputeId,
          stripeChargeId: teachificPayDisputes.stripeChargeId,
          amount: teachificPayDisputes.amount,
          currency: teachificPayDisputes.currency,
          status: teachificPayDisputes.status,
          reason: teachificPayDisputes.reason,
          evidenceDueBy: teachificPayDisputes.evidenceDueBy,
          evidenceSubmitted: teachificPayDisputes.evidenceSubmitted,
          learnerEmail: teachificPayDisputes.learnerEmail,
          accessRevoked: teachificPayDisputes.accessRevoked,
          adminNotes: teachificPayDisputes.adminNotes,
          escalated: teachificPayDisputes.escalated,
          createdAt: teachificPayDisputes.createdAt,
          updatedAt: teachificPayDisputes.updatedAt,
          orgName: organizations.name,
          orgSlug: organizations.slug,
        })
          .from(teachificPayDisputes)
          .leftJoin(organizations, eq(teachificPayDisputes.orgId, organizations.id))
          .where(whereClause)
          .orderBy(desc(teachificPayDisputes.createdAt))
          .limit(input.limit)
          .offset(input.offset),
        db.select({ total: sql<number>`count(*)` })
          .from(teachificPayDisputes)
          .where(whereClause),
      ]);

      return { disputes: rows, total: Number(countRows[0]?.total ?? 0) };
    }),

  /**
   * [Platform Admin] Dispute summary stats for the dashboard header.
   */
  adminDisputeStats: protectedProcedure
    .query(async ({ ctx }) => {
      if (ctx.user.role !== "site_owner" && ctx.user.role !== "site_admin") {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const rows = await db.select({
        status: teachificPayDisputes.status,
        count: sql<number>`count(*)`,
        totalAmount: sql<number>`sum(${teachificPayDisputes.amount})`,
      }).from(teachificPayDisputes).groupBy(teachificPayDisputes.status);

      const stats = { open: 0, openAmount: 0, won: 0, wonAmount: 0, lost: 0, lostAmount: 0, total: 0, totalAmount: 0 };
      const OPEN_STATUSES = ["needs_response", "warning_needs_response", "under_review", "warning_under_review"];
      for (const row of rows) {
        const count = Number(row.count);
        const amount = Number(row.totalAmount ?? 0);
        stats.total += count;
        stats.totalAmount += amount;
        if (OPEN_STATUSES.includes(row.status)) { stats.open += count; stats.openAmount += amount; }
        else if (row.status === "won") { stats.won += count; stats.wonAmount += amount; }
        else if (row.status === "lost") { stats.lost += count; stats.lostAmount += amount; }
      }
      return stats;
    }),

  /**
   * [Platform Admin] Add an internal admin note to a dispute.
   */
  adminAddDisputeNote: protectedProcedure
    .input(z.object({ disputeId: z.number(), note: z.string().min(1).max(2000) }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "site_owner" && ctx.user.role !== "site_admin") {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [existing] = await db.select({ adminNotes: teachificPayDisputes.adminNotes })
        .from(teachificPayDisputes).where(eq(teachificPayDisputes.id, input.disputeId));
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });
      const timestamp = new Date().toISOString();
      const newNote = `[${timestamp}] ${ctx.user.name ?? ctx.user.email ?? "Admin"}: ${input.note}`;
      const combined = existing.adminNotes ? `${existing.adminNotes}\n${newNote}` : newNote;
      await db.update(teachificPayDisputes).set({ adminNotes: combined }).where(eq(teachificPayDisputes.id, input.disputeId));
      return { success: true };
    }),

  /**
   * [Platform Admin] Escalate a dispute — flags it and appends an escalation note.
   */
  adminEscalateDispute: protectedProcedure
    .input(z.object({ disputeId: z.number(), message: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "site_owner" && ctx.user.role !== "site_admin") {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [dispute] = await db.select().from(teachificPayDisputes).where(eq(teachificPayDisputes.id, input.disputeId));
      if (!dispute) throw new TRPCError({ code: "NOT_FOUND" });
      const note = `[ESCALATED] ${new Date().toISOString()} — ${input.message ?? "Flagged for urgent attention by platform admin."}`;
      const combined = dispute.adminNotes ? `${dispute.adminNotes}\n${note}` : note;
      await db.update(teachificPayDisputes).set({ adminNotes: combined, escalated: true }).where(eq(teachificPayDisputes.id, input.disputeId));
      return { success: true };
    }),

  /**
   * [Platform Admin] Submit dispute evidence to Stripe on behalf of a school.
   */
  adminSubmitDisputeEvidence: protectedProcedure
    .input(z.object({
      disputeId: z.number(),
      stripeDisputeId: z.string(),
      customerEmailAddress: z.string().optional(),
      productDescription: z.string().optional(),
      uncategorizedText: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "site_owner" && ctx.user.role !== "site_admin") {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      const stripe = getStripe();
      await stripe.disputes.update(input.stripeDisputeId, {
        evidence: {
          customer_email_address: input.customerEmailAddress,
          product_description: input.productDescription,
          uncategorized_text: input.uncategorizedText,
        },
        submit: true,
      });
      const db = await getDb();
      if (db) await db.update(teachificPayDisputes).set({ evidenceSubmitted: true }).where(eq(teachificPayDisputes.id, input.disputeId));
      return { success: true };
    }),

  /**
   * [Platform Admin] Enhanced charge list with org name, filters, and pagination.
   */
  adminListAllCharges: protectedProcedure
    .input(z.object({
      limit: z.number().default(50),
      offset: z.number().default(0),
      orgId: z.number().optional(),
      status: z.string().optional(),
      search: z.string().optional(),
      dateFrom: z.number().optional(),
      dateTo: z.number().optional(),
    }))
    .query(async ({ ctx, input }) => {
      if (ctx.user.role !== "site_owner" && ctx.user.role !== "site_admin") {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const conditions: ReturnType<typeof eq>[] = [];
      if (input.orgId) conditions.push(eq(teachificPayCharges.orgId, input.orgId));
      if (input.status && input.status !== "all") conditions.push(eq(teachificPayCharges.status, input.status as any));
      if (input.search) {
        conditions.push(
          or(
            like(teachificPayCharges.learnerEmail, `%${input.search}%`),
            like(teachificPayCharges.stripeChargeId, `%${input.search}%`),
          ) as any
        );
      }
      if (input.dateFrom) conditions.push(gte(teachificPayCharges.chargedAt, new Date(input.dateFrom)) as any);
      if (input.dateTo) conditions.push(lte(teachificPayCharges.chargedAt, new Date(input.dateTo)) as any);

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, countRows] = await Promise.all([
        db.select({
          id: teachificPayCharges.id,
          orgId: teachificPayCharges.orgId,
          stripeChargeId: teachificPayCharges.stripeChargeId,
          amount: teachificPayCharges.amount,
          platformFee: teachificPayCharges.platformFee,
          netAmount: teachificPayCharges.netAmount,
          currency: teachificPayCharges.currency,
          status: teachificPayCharges.status,
          amountRefunded: teachificPayCharges.amountRefunded,
          learnerEmail: teachificPayCharges.learnerEmail,
          isGroupRegistration: teachificPayCharges.isGroupRegistration,
          groupSize: teachificPayCharges.groupSize,
          chargedAt: teachificPayCharges.chargedAt,
          orgName: organizations.name,
          orgSlug: organizations.slug,
        })
          .from(teachificPayCharges)
          .leftJoin(organizations, eq(teachificPayCharges.orgId, organizations.id))
          .where(whereClause)
          .orderBy(desc(teachificPayCharges.chargedAt))
          .limit(input.limit)
          .offset(input.offset),
        db.select({ total: sql<number>`count(*)` })
          .from(teachificPayCharges)
          .where(whereClause),
      ]);

      return { charges: rows, total: Number(countRows[0]?.total ?? 0) };
    }),
});
