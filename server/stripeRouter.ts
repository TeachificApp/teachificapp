/**
 * Stripe Billing Router for Teachific
 * Handles org subscription checkout, customer portal, and payment settings.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { protectedProcedure, publicProcedure, adminProcedure, router } from "./_core/trpc";
import { getStripe, STRIPE_PRICE_IDS, PLAN_LIMITS, STRIPE_API_VERSION, type PlanTier } from "./stripePlans";
import { getOrgSubscription, upsertOrgSubscription } from "./lmsDb";
import { ENV } from "./_core/env";

async function getDb() {
  const { getDb: _getDb } = await import("./db");
  const db = await _getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
  return db;
}

// ─── Helper: get org context for the current user ─────────────────────────────
async function getOrgContext(userId: number) {
  const db = await getDb();
  const { orgMembers, organizations } = await import("../drizzle/schema");
  const rows = await db
    .select({
      orgId: orgMembers.orgId,
      role: orgMembers.role,
      orgName: organizations.name,
      orgSlug: organizations.slug,
    })
    .from(orgMembers)
    .innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
    .where(eq(orgMembers.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

// ─── Helper: ensure org payment settings row ──────────────────────────────────
async function getOrCreateOrgPaymentSettings(orgId: number) {
  const db = await getDb();
  const { orgPaymentSettings } = await import("../drizzle/schema");
  const rows = await db
    .select()
    .from(orgPaymentSettings)
    .where(eq(orgPaymentSettings.orgId, orgId))
    .limit(1);
  if (rows[0]) return rows[0];
  await db.insert(orgPaymentSettings).values({ orgId });
  const newRows = await db
    .select()
    .from(orgPaymentSettings)
    .where(eq(orgPaymentSettings.orgId, orgId))
    .limit(1);
  return newRows[0]!;
}

export const stripeRouter = router({
  // ── Get current subscription ───────────────────────────────────────────────
  getSubscription: protectedProcedure.query(async ({ ctx }) => {
    const orgCtx = await getOrgContext(ctx.user.id);
    if (!orgCtx) return null;
    const sub = await getOrgSubscription(orgCtx.orgId);
    const plan = sub?.plan ?? "free";
    const limits = PLAN_LIMITS[plan as PlanTier];
    return {
      orgId: orgCtx.orgId,
      orgName: orgCtx.orgName,
      plan: plan as PlanTier,
      limits,
      status: sub?.status ?? "active",
      stripeSubscriptionId: sub?.stripeSubscriptionId ?? null,
      stripeCustomerId: sub?.stripeCustomerId ?? null,
      currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
      customPriceLabel: sub?.customPriceLabel ?? null,
    };
  }),

  // ── Create checkout session ────────────────────────────────────────────────
  createCheckoutSession: protectedProcedure
    .input(
      z.object({
        plan: z.enum(["starter", "builder", "pro"]),
        interval: z.enum(["monthly", "annual"]),
        origin: z.string().url(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (!ENV.stripeSecretKey) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Stripe not configured" });
      }
      const orgCtx = await getOrgContext(ctx.user.id);
      if (!orgCtx) {
        throw new TRPCError({ code: "FORBIDDEN", message: "No organization found" });
      }
      if (!["org_super_admin", "org_admin"].includes(orgCtx.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only org admins can manage billing" });
      }

      const priceKey = `${input.plan}_${input.interval}`;
      const priceId = STRIPE_PRICE_IDS[priceKey];
      if (!priceId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Price not found for ${priceKey}. Stripe plans may not be initialized yet.`,
        });
      }

      const stripe = getStripe();
      const sub = await getOrgSubscription(orgCtx.orgId);

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        payment_method_types: ["card"],
        line_items: [{ price: priceId, quantity: 1 }],
        allow_promotion_codes: true,
        customer: sub?.stripeCustomerId ?? undefined,
        customer_email: sub?.stripeCustomerId ? undefined : ctx.user.email ?? undefined,
        client_reference_id: String(ctx.user.id),
        metadata: {
          user_id: String(ctx.user.id),
          org_id: String(orgCtx.orgId),
          plan: input.plan,
          interval: input.interval,
          customer_email: ctx.user.email ?? "",
          customer_name: ctx.user.name ?? "",
        },
        subscription_data: {
          // 14-day free trial — no charge until trial ends
          trial_period_days: 14,
          metadata: {
            org_id: String(orgCtx.orgId),
            plan: input.plan,
          },
        },
        success_url: `${input.origin}/lms/billing?success=1&plan=${input.plan}&trial=1`,
        cancel_url: `${input.origin}/lms/billing?cancelled=1`,
      });

      return { url: session.url };
    }),

  // ── Create customer portal session ────────────────────────────────────────
  createPortalSession: protectedProcedure
    .input(z.object({ origin: z.string().url() }))
    .mutation(async ({ ctx, input }) => {
      if (!ENV.stripeSecretKey) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Stripe not configured" });
      }
      const orgCtx = await getOrgContext(ctx.user.id);
      if (!orgCtx) {
        throw new TRPCError({ code: "FORBIDDEN", message: "No organization found" });
      }
      const sub = await getOrgSubscription(orgCtx.orgId);
      if (!sub?.stripeCustomerId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "No Stripe customer found. Please subscribe first." });
      }
      const stripe = getStripe();
      const session = await stripe.billingPortal.sessions.create({
        customer: sub.stripeCustomerId,
        return_url: `${input.origin}/lms/billing`,
      });
      return { url: session.url };
    }),

  // ── Get org payment settings ───────────────────────────────────────────────
  getPaymentSettings: protectedProcedure.query(async ({ ctx }) => {
    const orgCtx = await getOrgContext(ctx.user.id);
    if (!orgCtx) return null;
    if (!["org_super_admin", "org_admin"].includes(orgCtx.role)) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    const settings = await getOrCreateOrgPaymentSettings(orgCtx.orgId);
    // Never expose secrets to frontend
    return {
      ...settings,
      paypalClientSecret: settings.paypalClientSecret ? "••••••••" : null,
    };
  }),

  // ── Update org payment settings ───────────────────────────────────────────
  updatePaymentSettings: protectedProcedure
    .input(
      z.object({
        paypalEmail: z.string().email().optional().nullable(),
        paypalEnabled: z.boolean().optional(),
        paypalClientId: z.string().optional().nullable(),
        paypalClientSecret: z.string().optional().nullable(),
        currency: z.string().length(3).optional(),
        autoEnrollNewMembers: z.boolean().optional(),
        revenueShareJson: z.string().optional().nullable(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const orgCtx = await getOrgContext(ctx.user.id);
      if (!orgCtx) throw new TRPCError({ code: "FORBIDDEN" });
      if (!["org_super_admin", "org_admin"].includes(orgCtx.role)) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      const db = await getDb();
      const { orgPaymentSettings } = await import("../drizzle/schema");
      await getOrCreateOrgPaymentSettings(orgCtx.orgId);
      const updateData: Record<string, unknown> = {};
      if (input.paypalEmail !== undefined) updateData.paypalEmail = input.paypalEmail;
      if (input.paypalEnabled !== undefined) updateData.paypalEnabled = input.paypalEnabled;
      if (input.paypalClientId !== undefined) updateData.paypalClientId = input.paypalClientId;
      if (input.paypalClientSecret !== undefined && input.paypalClientSecret !== "••••••••") {
        updateData.paypalClientSecret = input.paypalClientSecret;
      }
      if (input.currency !== undefined) updateData.currency = input.currency;
      if (input.autoEnrollNewMembers !== undefined) updateData.autoEnrollNewMembers = input.autoEnrollNewMembers;
      if (input.revenueShareJson !== undefined) updateData.revenueShareJson = input.revenueShareJson;
      await db
        .update(orgPaymentSettings)
        .set(updateData as any)
        .where(eq(orgPaymentSettings.orgId, orgCtx.orgId));
      return { success: true };
    }),

  // ── Get org payment settings (by orgId, for org admin) ─────────────────────
  getOrgPaymentSettings: protectedProcedure
    .input(z.object({ orgId: z.number() }))
    .query(async ({ ctx, input }) => {
      const orgCtx = await getOrgContext(ctx.user.id);
      if (!orgCtx || orgCtx.orgId !== input.orgId) throw new TRPCError({ code: "FORBIDDEN" });
      if (!["org_super_admin", "org_admin"].includes(orgCtx.role)) throw new TRPCError({ code: "FORBIDDEN" });
      const settings = await getOrCreateOrgPaymentSettings(input.orgId);
      return {
        ...settings,
        stripeSecretKey: settings.stripeSecretKey ? "••••••••••••••••" : null,
        paypalClientSecret: settings.paypalClientSecret ? "••••••••" : null,
        autoEnrollment: settings.autoEnrollNewMembers,
      };
    }),

  // ── Update org payment settings (by orgId, for org admin) ────────────────────
  updateOrgPaymentSettings: protectedProcedure
    .input(
      z.object({
        orgId: z.number(),
        stripePublishableKey: z.string().optional().nullable(),
        stripeSecretKey: z.string().optional().nullable(),
        paypalClientId: z.string().optional().nullable(),
        paypalClientSecret: z.string().optional().nullable(),
        autoEnrollment: z.boolean().optional(),
        autoEnrollCourseIds: z.string().optional(), // JSON array of course IDs
      })
    )
    .mutation(async ({ ctx, input }) => {
      const orgCtx = await getOrgContext(ctx.user.id);
      if (!orgCtx || orgCtx.orgId !== input.orgId) throw new TRPCError({ code: "FORBIDDEN" });
      if (!["org_super_admin", "org_admin"].includes(orgCtx.role)) throw new TRPCError({ code: "FORBIDDEN" });
      const db = await getDb();
      const { orgPaymentSettings } = await import("../drizzle/schema");
      await getOrCreateOrgPaymentSettings(input.orgId);
      const updateData: Record<string, unknown> = {};
      if (input.stripePublishableKey !== undefined) updateData.stripePublishableKey = input.stripePublishableKey;
      if (input.stripeSecretKey !== undefined && !input.stripeSecretKey?.startsWith("•")) {
        updateData.stripeSecretKey = input.stripeSecretKey;
      }
      if (input.paypalClientId !== undefined) updateData.paypalClientId = input.paypalClientId;
      if (input.paypalClientSecret !== undefined && !input.paypalClientSecret?.startsWith("•")) {
        updateData.paypalClientSecret = input.paypalClientSecret;
      }
      if (input.autoEnrollment !== undefined) updateData.autoEnrollNewMembers = input.autoEnrollment;
      if (input.autoEnrollCourseIds !== undefined) updateData.autoEnrollCourseIds = input.autoEnrollCourseIds;
      if (Object.keys(updateData).length > 0) {
        await db
          .update(orgPaymentSettings)
          .set(updateData as any)
          .where(eq(orgPaymentSettings.orgId, input.orgId));
      }
      return { success: true };
    }),

  // ── Create course/product checkout session (with transaction fee) ──────────
  createCourseCheckout: publicProcedure
    .input(
      z.object({
        orgId: z.number(),
        productId: z.number(),
        priceId: z.number(),
        buyerEmail: z.string().email(),
        buyerName: z.string().optional(),
        origin: z.string().url(),
      })
    )
    .mutation(async ({ input }) => {
      // Get org payment settings (org's own Stripe key)
      const db = await getDb();
      const { orgPaymentSettings, orgSubscriptions } = await import("../drizzle/schema");
      const [paySettings] = await db
        .select()
        .from(orgPaymentSettings)
        .where(eq(orgPaymentSettings.orgId, input.orgId))
        .limit(1);

      if (!paySettings?.stripeSecretKey) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This organization has not configured Stripe payments.",
        });
      }

      // Get org's Teachific plan to determine transaction fee
      const [orgSub] = await db
        .select()
        .from(orgSubscriptions)
        .where(eq(orgSubscriptions.orgId, input.orgId))
        .limit(1);
      const planTier = (orgSub?.plan ?? "free") as PlanTier;
      const planLimits = PLAN_LIMITS[planTier];
      const feePercent = planLimits.transactionFeePercent; // 0, 1, or 3

      // Get product and price details
      const { getDigitalProduct, listProductPrices, createDigitalOrder } = await import("./lmsDb");
      const product = await getDigitalProduct(input.productId);
      if (!product || product.orgId !== input.orgId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Product not found" });
      }
      const prices = await listProductPrices(input.productId);
      const price = prices.find((p) => p.id === input.priceId);
      if (!price) throw new TRPCError({ code: "NOT_FOUND", message: "Price not found" });

      // Use the org's own Stripe secret key
      const orgStripe = new (await import("stripe")).default(paySettings.stripeSecretKey, {
        apiVersion: STRIPE_API_VERSION,
      });

      const amountCents = Math.round(Number(price.amount) * 100);
      const applicationFeeCents = feePercent > 0 ? Math.round(amountCents * feePercent / 100) : undefined;

      // Create a pre-order record so we can link back on webhook
      const order = await createDigitalOrder({
        productId: input.productId,
        priceId: input.priceId,
        orgId: input.orgId,
        buyerEmail: input.buyerEmail,
        buyerName: input.buyerName,
        amount: price.amount,
        currency: price.currency ?? "USD",
        paymentRef: undefined,
        accessExpiresAt: product.defaultAccessDays
          ? new Date(Date.now() + product.defaultAccessDays * 86400000)
          : null,
        maxDownloads: product.defaultMaxDownloads ?? null,
      });

      const session = await orgStripe.checkout.sessions.create({
        mode: "payment",
        customer_email: input.buyerEmail,
        line_items: [
          {
            price_data: {
              currency: (price.currency ?? "USD").toLowerCase(),
              unit_amount: amountCents,
              product_data: {
                name: product.title,
                description: product.description ?? undefined,
                images: product.thumbnailUrl ? [product.thumbnailUrl] : [],
              },
            },
            quantity: 1,
          },
        ],
        ...(applicationFeeCents ? { payment_intent_data: { application_fee_amount: applicationFeeCents } } : {}),
        metadata: {
          teachific_order_id: String(order.id),
          teachific_org_id: String(input.orgId),
          teachific_product_id: String(input.productId),
          teachific_fee_percent: String(feePercent),
          buyer_email: input.buyerEmail,
          buyer_name: input.buyerName ?? "",
        },
        success_url: `${input.origin}/school/${product.orgId}/thank-you?order_id=${order.id}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${input.origin}/school/${product.orgId}/courses/${input.productId}`,
        allow_promotion_codes: true,
      });

      return { checkoutUrl: session.url, orderId: order.id };
    }),

  // ── Get all plan limits (public) ──────────────────────────────────────────
  getPlanLimits: protectedProcedure.query(() => {
    return PLAN_LIMITS;
  }),

  // ── Studio subscription checkout ───────────────────────────────────────
  createStudioCheckout: protectedProcedure
    .input(z.object({
      tier: z.enum(["web", "desktop", "bundle"]),
      interval: z.enum(["monthly", "annual"]),
      origin: z.string().url(),
    }))
    .mutation(async ({ input, ctx }) => {
      const stripe = getStripe();
      const priceKey = `studio_${input.tier}_${input.interval}`;
      const priceId = STRIPE_PRICE_IDS[priceKey];
      if (!priceId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Studio price not found. Please try again shortly." });
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        payment_method_types: ["card"],
        line_items: [{ price: priceId, quantity: 1 }],
        customer_email: ctx.user.email ?? undefined,
        client_reference_id: String(ctx.user.id),
        metadata: {
          user_id: String(ctx.user.id),
          customer_email: ctx.user.email ?? "",
          customer_name: ctx.user.name ?? "",
          studio_tier: input.tier,
          product_type: "studio",
        },
        success_url: `${input.origin}/studio?upgraded=1`,
        cancel_url: `${input.origin}/studio-pro`,
        allow_promotion_codes: true,
      });
      return { checkoutUrl: session.url };
    }),

  // ── Studio subscription status ────────────────────────────────────────────
  getStudioSubscription: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    const { users } = await import("../drizzle/schema");
    const rows = await db.select({
      studioAccess: users.studioAccess,
      studioTrialEndsAt: users.studioTrialEndsAt,
    }).from(users).where(eq(users.id, ctx.user.id)).limit(1);
    const studioAccess = (rows[0]?.studioAccess ?? "none") as string;
    const trialEndsAt = rows[0]?.studioTrialEndsAt ?? null;
    const isInTrial = studioAccess !== "none" && trialEndsAt && new Date(trialEndsAt) > new Date();
    return {
      tier: studioAccess as "none" | "web" | "desktop" | "bundle",
      isActive: studioAccess !== "none",
      trialEndsAt,
      isInTrial: !!isInTrial,
      isPaid: studioAccess !== "none" && !isInTrial,
    };
  }),

  // ── Admin: list all Studio users ────────────────────────────────────────
  adminListStudioUsers: adminProcedure.query(async () => {
    const db = await getDb();
    const { users } = await import("../drizzle/schema");
    const allUsers = await db.select({
      id: users.id,
      name: users.name,
      email: users.email,
      studioAccess: users.studioAccess,
      studioTrialEndsAt: users.studioTrialEndsAt,
      createdAt: users.createdAt,
    }).from(users).orderBy(users.createdAt);
    return allUsers.map((u) => ({
      ...u,
      studioAccess: (u.studioAccess ?? "none") as "none" | "web" | "desktop" | "bundle",
    }));
  }),
  // ── Admin: set a user's Studio role ──────────────────────────────────────
  adminSetStudioRole: adminProcedure
    .input(z.object({
      userId: z.number(),
      role: z.enum(["none", "web", "desktop", "bundle"]),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      const { users } = await import("../drizzle/schema");
      await db.update(users).set({ studioAccess: input.role }).where(eq(users.id, input.userId));
      return { success: true };
    }),
  // ── Admin: list all Creator users ─────────────────────────────────────────
  adminListCreatorUsers: adminProcedure.query(async () => {
    const db = await getDb();
    const { users } = await import("../drizzle/schema");
    const allUsers = await db.select({
      id: users.id, name: users.name, email: users.email,
      creatorAccess: users.creatorAccess, creatorTrialEndsAt: users.creatorTrialEndsAt, createdAt: users.createdAt,
    }).from(users).orderBy(users.createdAt);
    return allUsers.map((u) => ({ ...u, creatorAccess: (u.creatorAccess ?? "none") as "none" | "web" | "desktop" | "bundle" }));
  }),
  // ── Admin: set a user's Creator role ─────────────────────────────────────
  adminSetCreatorRole: adminProcedure
    .input(z.object({
      userId: z.number(),
      role: z.enum(["none", "web", "desktop", "bundle"]),
      trialDays: z.number().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      const { users } = await import("../drizzle/schema");
      const trialEndsAt = input.trialDays ? new Date(Date.now() + input.trialDays * 86400000) : null;
      await db.update(users).set({ creatorAccess: input.role, creatorTrialEndsAt: trialEndsAt }).where(eq(users.id, input.userId));
      return { success: true };
    }),
  // ── Admin: list all QuizMaker users ────────────────────────────────────
  adminListQuizCreatorUsers: adminProcedure.query(async () => {
    const db = await getDb();
    const { users } = await import("../drizzle/schema");
    const allUsers = await db.select({
      id: users.id, name: users.name, email: users.email,
      quizCreatorAccess: users.quizCreatorAccess, quizCreatorTrialEndsAt: users.quizCreatorTrialEndsAt, createdAt: users.createdAt,
    }).from(users).orderBy(users.createdAt);
    return allUsers.map((u) => ({ ...u, quizCreatorAccess: (u.quizCreatorAccess ?? "none") as "none" | "web" | "desktop" | "bundle" }));
  }),
  // ── Admin: set a user's QuizMaker role ─────────────────────────────────
  adminSetQuizCreatorRole: adminProcedure
    .input(z.object({
      userId: z.number(),
      role: z.enum(["none", "web", "desktop", "bundle"]),
      trialDays: z.number().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      const { users } = await import("../drizzle/schema");
      const trialEndsAt = input.trialDays ? new Date(Date.now() + input.trialDays * 86400000) : null;
      await db.update(users).set({ quizCreatorAccess: input.role, quizCreatorTrialEndsAt: trialEndsAt }).where(eq(users.id, input.userId));
      return { success: true };
    }),
  // ── Admin: update Studio trial end date ──────────────────────────────────
  adminSetStudioTrial: adminProcedure
    .input(z.object({ userId: z.number(), trialDays: z.number().optional() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      const { users } = await import("../drizzle/schema");
      const trialEndsAt = input.trialDays ? new Date(Date.now() + input.trialDays * 86400000) : null;
      await db.update(users).set({ studioTrialEndsAt: trialEndsAt }).where(eq(users.id, input.userId));
      return { success: true };
    }),
  // ── TeachificCreator™ checkout (Web / Desktop / Bundle) ───────────────────────────
  createCreatorSingleCheckout: protectedProcedure
    .input(z.object({
      interval: z.enum(["monthly", "annual"]),
      accessTier: z.enum(["web", "desktop", "bundle"]).default("desktop"),
      origin: z.string().url(),
    }))
    .mutation(async ({ input, ctx }) => {
      const stripe = getStripe();
      const priceKey = `creator_${input.accessTier}_${input.interval}`;
      const priceId = STRIPE_PRICE_IDS[priceKey];
      if (!priceId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "TeachificCreator price not found. Please try again shortly." });
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        payment_method_types: ["card"],
        line_items: [{ price: priceId, quantity: 1 }],
        customer_email: ctx.user.email ?? undefined,
        client_reference_id: String(ctx.user.id),
        allow_promotion_codes: true,
        metadata: {
          user_id: String(ctx.user.id),
          customer_email: ctx.user.email ?? "",
          customer_name: ctx.user.name ?? "",
          product_type: "creator",
          access_tier: input.accessTier,
        },
        subscription_data: {
          trial_period_days: 14,
          metadata: { user_id: String(ctx.user.id), product_type: "creator", access_tier: input.accessTier },
        },
        success_url: `${input.origin}/creator?upgraded=1`,
        cancel_url: `${input.origin}/creator-pro`,
      });
      return { checkoutUrl: session.url };
    }),

  // ── Teachific Studio™ checkout (Web / Desktop / Bundle) ──────────────────────────────
  createStudioSingleCheckout: protectedProcedure
    .input(z.object({
      interval: z.enum(["monthly", "annual"]),
      accessTier: z.enum(["web", "desktop", "bundle"]).default("desktop"),
      origin: z.string().url(),
    }))
    .mutation(async ({ input, ctx }) => {
      const stripe = getStripe();
      const priceKey = `studio_${input.accessTier}_${input.interval}`;
      const priceId = STRIPE_PRICE_IDS[priceKey];
      if (!priceId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Teachific Studio price not found. Please try again shortly." });
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        payment_method_types: ["card"],
        line_items: [{ price: priceId, quantity: 1 }],
        customer_email: ctx.user.email ?? undefined,
        client_reference_id: String(ctx.user.id),
        allow_promotion_codes: true,
        metadata: {
          user_id: String(ctx.user.id),
          customer_email: ctx.user.email ?? "",
          customer_name: ctx.user.name ?? "",
          product_type: "studio",
          access_tier: input.accessTier,
        },
        subscription_data: {
          trial_period_days: 14,
          metadata: { user_id: String(ctx.user.id), product_type: "studio", access_tier: input.accessTier },
        },
        success_url: `${input.origin}/studio?upgraded=1`,
        cancel_url: `${input.origin}/studio-pro`,
      });
      return { checkoutUrl: session.url };
    }),

  // ── Teachific QuizMaker™ checkout (Web / Desktop / Bundle) ─────────────────────────
  createQuizCreatorCheckout: protectedProcedure
    .input(z.object({
      interval: z.enum(["monthly", "annual"]),
      accessTier: z.enum(["web", "desktop", "bundle"]).default("desktop"),
      origin: z.string().url(),
    }))
    .mutation(async ({ input, ctx }) => {
      const stripe = getStripe();
      const priceKey = `quiz_creator_${input.accessTier}_${input.interval}`;
      const priceId = STRIPE_PRICE_IDS[priceKey];
      if (!priceId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "QuizMaker price not found. Please try again shortly." });
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        payment_method_types: ["card"],
        line_items: [{ price: priceId, quantity: 1 }],
        customer_email: ctx.user.email ?? undefined,
        client_reference_id: String(ctx.user.id),
        allow_promotion_codes: true,
        metadata: {
          user_id: String(ctx.user.id),
          customer_email: ctx.user.email ?? "",
          customer_name: ctx.user.name ?? "",
          product_type: "quiz_creator",
          access_tier: input.accessTier,
        },
        subscription_data: {
          trial_period_days: 14,
          metadata: { user_id: String(ctx.user.id), product_type: "quiz_creator", access_tier: input.accessTier },
        },
        success_url: `${input.origin}/quiz-creator?upgraded=1`,
        cancel_url: `${input.origin}/quiz-creator-pro`,
      });
      return { checkoutUrl: session.url };
     }),

  // ── Enterprise contact-sales inquiry ─────────────────────────────────────────────
  contactEnterprise: protectedProcedure
    .input(z.object({
      orgId: z.number(),
      orgName: z.string(),
      contactName: z.string(),
      contactEmail: z.string().email(),
      teamSize: z.string().optional(),
      message: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { notifyOwner } = await import("./_core/notification");
      const content = [
        "**Enterprise Plan Inquiry**",
        "",
        `**Organization:** ${input.orgName} (ID: ${input.orgId})`,
        `**Contact:** ${input.contactName} <${input.contactEmail}>`,
        `**Team Size:** ${input.teamSize ?? "Not specified"}`,
        `**Message:** ${input.message ?? "No message provided"}`,
        "",
        `Submitted by user ID: ${ctx.user.id}`,
      ].join("\n");
      await notifyOwner({
        title: `Enterprise Inquiry: ${input.orgName}`,
        content,
      });
      return { success: true };
    }),

  // ── Get all product subscriptions for the current user (cross-product nav) ─────────
  getAllSubscriptions: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    const { users, orgMembers, orgSubscriptions } = await import("../drizzle/schema");

    // User-level roles (Studio, Creator, QuizMaker)
    const [userRow] = await db
      .select({
        studioAccess: users.studioAccess,
        studioTrialEndsAt: users.studioTrialEndsAt,
        creatorAccess: users.creatorAccess,
        creatorTrialEndsAt: users.creatorTrialEndsAt,
        quizCreatorAccess: users.quizCreatorAccess,
        quizCreatorTrialEndsAt: users.quizCreatorTrialEndsAt,
      })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .limit(1);

    // LMS org subscription
    const [orgRow] = await db
      .select({ orgId: orgMembers.orgId })
      .from(orgMembers)
      .where(eq(orgMembers.userId, ctx.user.id))
      .limit(1);

    let lmsPlan: string = "free";
    let lmsIsActive = false;
    if (orgRow) {
      const [orgSub] = await db
        .select({ plan: orgSubscriptions.plan, status: orgSubscriptions.status })
        .from(orgSubscriptions)
        .where(eq(orgSubscriptions.orgId, orgRow.orgId))
        .limit(1);
      lmsPlan = orgSub?.plan ?? "free";
      lmsIsActive = !!orgSub && orgSub.status !== "cancelled";
    }
    const hasLms = lmsIsActive || lmsPlan !== "free";

    // Studio
    const studioAccess = (userRow?.studioAccess ?? "none") as string;
    const studioTrialEndsAt = userRow?.studioTrialEndsAt ?? null;
    const studioInTrial = studioAccess !== "none" && studioTrialEndsAt && new Date(studioTrialEndsAt) > new Date();
    const hasStudio = studioAccess !== "none";

    // Creator
    const creatorAccess = (userRow?.creatorAccess ?? "none") as string;
    const creatorTrialEndsAt = userRow?.creatorTrialEndsAt ?? null;
    const creatorInTrial = creatorAccess !== "none" && creatorTrialEndsAt && new Date(creatorTrialEndsAt) > new Date();
    const hasCreator = creatorAccess !== "none";

    // QuizMaker
    const quizRole = (userRow?.quizCreatorAccess ?? "none") as string;
    const quizTrialEndsAt = userRow?.quizCreatorTrialEndsAt ?? null;
    const quizInTrial = quizRole !== "none" && quizTrialEndsAt && new Date(quizTrialEndsAt) > new Date();
    const hasQuizMaker = quizRole !== "none";

    return {
      lms: { plan: lmsPlan, isActive: hasLms },
      studio: { tier: studioAccess, isActive: hasStudio, isInTrial: !!studioInTrial },
      creator: { tier: creatorAccess, isActive: hasCreator, isInTrial: !!creatorInTrial },
      quizCreator: { tier: quizRole, isActive: hasQuizMaker, isInTrial: !!quizInTrial },
    };
  }),

  // ── Desktop app download URLs (subscription-gated) ─────────────────────────
  getDesktopDownloads: protectedProcedure
    .input(z.object({ app: z.enum(["creator", "studio", "quizCreator"]) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      const { users } = await import("../drizzle/schema");
      const [userRow] = await db
        .select({
          creatorAccess: users.creatorAccess,
          studioAccess: users.studioAccess,
          quizCreatorAccess: users.quizCreatorAccess,
        })
        .from(users)
        .where(eq(users.id, ctx.user.id))
        .limit(1);

      const roleMap: Record<string, string> = {
        creator: userRow?.creatorAccess ?? "none",
        studio: userRow?.studioAccess ?? "none",
        quizCreator: userRow?.quizCreatorAccess ?? "none",
      };
      const hasAccess = roleMap[input.app] !== "none";

      if (!hasAccess) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "An active subscription is required to download this app.",
        });
      }

      // Pull latest download URLs from app_versions DB table
      const dbProduct = input.app === "quizCreator" ? "quizcreator" : input.app;
      const { appVersions } = await import("../drizzle/schema");
      const { and: and2 } = await import("drizzle-orm");
      const [latestRow] = await db
        .select()
        .from(appVersions)
        .where(and2(eq(appVersions.product, dbProduct as "creator" | "studio" | "quizcreator"), eq(appVersions.isLatest, true)))
        .limit(1);
      return {
        hasAccess: true,
        app: input.app,
        version: latestRow?.version ?? "1.0.0",
        windows: latestRow?.windowsUrl ?? null,
        mac: latestRow?.macUrl ?? null,
        releasePage: null,
      };
    }),

  // ── Platform Admin: Stripe integration status ─────────────────
  getStripeStatus: adminProcedure.query(async () => {
    const isConfigured = !!ENV.stripeSecretKey;
    const hasWebhookSecret = !!ENV.stripeWebhookSecret;
    const publishableKeyPrefix = ENV.stripePublishableKey
      ? ENV.stripePublishableKey.slice(0, 14) + "..."
      : null;
    const isTestMode = ENV.stripeSecretKey?.startsWith("sk_test_") ?? false;
    const priceCount = Object.keys(STRIPE_PRICE_IDS).length;
    const priceIds = Object.entries(STRIPE_PRICE_IDS).map(([key, id]) => ({ key, id }));
    return {
      isConfigured,
      isTestMode,
      hasWebhookSecret,
      publishableKeyPrefix,
      priceCount,
      priceIds,
      claimUrl: isTestMode ? "https://dashboard.stripe.com/claim_sandbox/YWNjdF8xVElITmQ1NEtpeUUwbExZLDE3NzU5MjQwNTEv100hEZaCvIU" : null,
    };
  }),
});
