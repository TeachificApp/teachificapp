/**
 * Teachific Platform Subscription Plans
 * Defines plan limits and manages Stripe products/prices.
 */
import Stripe from "stripe";
import { ENV } from "./_core/env";

export const STRIPE_API_VERSION = "2025-03-31.basil" as const;

// ─── Plan Limits ─────────────────────────────────────────────────────────────
export type PlanTier = "free" | "starter" | "builder" | "pro" | "enterprise";
// App access tiers: none = no access, web = web app only, desktop = desktop app only, bundle = web + desktop
export type AppAccessTier = "none" | "web" | "desktop" | "bundle";

export interface PlanLimits {
  name: string;
  tier: PlanTier;
  // Pricing (USD cents)
  monthlyPrice: number | null; // null = contact sales
  annualPrice: number | null;
  // Limits (-1 = unlimited, 0 = not available)
  maxAdmins: number;
  maxMembers: number;
  maxCourses: number;
  maxCommunities: number;
  maxInstructors: number;
  maxStorageBytes: number; // -1 = unlimited
  maxMembershipTiers: number;
  // Features (boolean)
  whiteLabel: boolean;
  emailMarketing: boolean;
  transactionFeePercent: number; // legacy — kept for reference
  teachificPayFeePercent: number; // platform fee on TeachificPay transactions
  customGateway: boolean; // can use own Stripe/payment gateway
  groupRegistrations: boolean;
  deepAnalytics: boolean;
  affiliatePlatform: boolean;
  sso: boolean;
  customCss: boolean;
  customDomain: boolean;
  communityAccess: boolean;
  revenueShare: boolean;
  onboardingTeam: boolean;
}

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free: {
    name: "Free",
    tier: "free",
    monthlyPrice: 0,
    annualPrice: 0,
    maxAdmins: 1,
    maxMembers: 10,
    maxCourses: 1,
    maxCommunities: 0,
    maxInstructors: 0, // admin is only instructor
    maxStorageBytes: 100 * 1024 * 1024 * 1024, // 100 GB
    maxMembershipTiers: 0,
    whiteLabel: false,
    emailMarketing: false,
    transactionFeePercent: 0,
    teachificPayFeePercent: 2, // 2% TeachificPay fee
    customGateway: false, // must use TeachificPay
    groupRegistrations: false,
    deepAnalytics: false,
    affiliatePlatform: false,
    sso: false,
    customCss: false,
    customDomain: false,
    communityAccess: false,
    revenueShare: false,
    onboardingTeam: false,
  },
  starter: {
    name: "Starter",
    tier: "starter",
    monthlyPrice: 3900, // $39
    annualPrice: 39900, // $399
    maxAdmins: 1,
    maxMembers: 1000,
    maxCourses: 5,
    maxCommunities: 0,
    maxInstructors: 1,
    maxStorageBytes: 1024 * 1024 * 1024 * 1024, // 1 TB
    maxMembershipTiers: 1,
    whiteLabel: false,
    emailMarketing: false,
    transactionFeePercent: 3,
    teachificPayFeePercent: 1, // 1% TeachificPay fee
    customGateway: false, // must use TeachificPay
    groupRegistrations: false,
    deepAnalytics: false,
    affiliatePlatform: false,
    sso: false,
    customCss: false,
    customDomain: false,
    communityAccess: false,
    revenueShare: false,
    onboardingTeam: false,
  },
  builder: {
    name: "Builder",
    tier: "builder",
    monthlyPrice: 9900, // $99
    annualPrice: 99900, // $999
    maxAdmins: 1,
    maxMembers: 5000,
    maxCourses: 20,
    maxCommunities: 1,
    maxInstructors: 3,
    maxStorageBytes: 2 * 1024 * 1024 * 1024 * 1024, // 2 TB
    maxMembershipTiers: 3,
    whiteLabel: true,
    emailMarketing: false,
    transactionFeePercent: 1,
    teachificPayFeePercent: 0.5, // 0.5% TeachificPay fee (required — no own gateway on Builder)
    customGateway: false, // Builder must use TeachificPay
    groupRegistrations: false,
    deepAnalytics: false, // basic analytics only
    affiliatePlatform: false,
    sso: false,
    customCss: false,
    customDomain: true,
    communityAccess: true,
    revenueShare: false,
    onboardingTeam: false,
  },
  pro: {
    name: "Pro",
    tier: "pro",
    monthlyPrice: 19900, // $199
    annualPrice: 199900, // $1999
    maxAdmins: 3,
    maxMembers: 15000,
    maxCourses: 50,
    maxCommunities: 3,
    maxInstructors: 10,
    maxStorageBytes: 5 * 1024 * 1024 * 1024 * 1024, // 5 TB
    maxMembershipTiers: 10,
    whiteLabel: true,
    emailMarketing: true,
    transactionFeePercent: 0,
    teachificPayFeePercent: 0, // 0% fee on Pro — revenue from subscription
    customGateway: true, // Pro can use own gateway or TeachificPay
    groupRegistrations: true,
    deepAnalytics: true,
    affiliatePlatform: true,
    sso: true,
    customCss: true,
    customDomain: true,
    communityAccess: true,
    revenueShare: true,
    onboardingTeam: false,
  },
  enterprise: {
    name: "Enterprise",
    tier: "enterprise",
    monthlyPrice: null, // contact sales
    annualPrice: null,
    maxAdmins: -1,
    maxMembers: -1,
    maxCourses: -1,
    maxCommunities: -1,
    maxInstructors: -1,
    maxStorageBytes: -1, // Unlimited
    maxMembershipTiers: -1,
    whiteLabel: true,
    emailMarketing: true,
    transactionFeePercent: 0,
    teachificPayFeePercent: 0, // 0% fee on Enterprise — revenue from subscription
    customGateway: true, // Enterprise can use own gateway or TeachificPay
    groupRegistrations: true,
    deepAnalytics: true,
    affiliatePlatform: true,
    sso: true,
    customCss: true,
    customDomain: true,
    communityAccess: true,
    revenueShare: true,
    onboardingTeam: true,
  },
};

// ─── Stripe Client ────────────────────────────────────────────────────────────
let stripeClient: Stripe | null = null;
export function getStripe(): Stripe {
  if (!stripeClient) {
    if (!ENV.stripeSecretKey) throw new Error("STRIPE_SECRET_KEY not configured");
    stripeClient = new Stripe(ENV.stripeSecretKey, { apiVersion: STRIPE_API_VERSION });
  }
  return stripeClient;
}

// ─── Stripe Price IDs ─────────────────────────────────────────────────────────
// These are populated at server startup via ensureStripePlans()
export const STRIPE_PRICE_IDS: Record<string, string> = {};

/**
 * Idempotently create Stripe products and prices for all paid plans.
 * Stores price IDs in STRIPE_PRICE_IDS for use in checkout sessions.
 */
export async function ensureStripePlans(): Promise<void> {
  if (!ENV.stripeSecretKey) {
    console.log("[Stripe] No secret key configured, skipping plan setup");
    return;
  }
  const stripe = getStripe();
  const paidPlans: PlanTier[] = ["starter", "builder", "pro"];

  for (const tier of paidPlans) {
    const plan = PLAN_LIMITS[tier];
    if (!plan.monthlyPrice || !plan.annualPrice) continue;

    // Find or create product
    const products = await stripe.products.list({ limit: 100 });
    let product = products.data.find((p) => p.metadata?.teachific_tier === tier);
    if (!product) {
      product = await stripe.products.create({
        name: `Teachific ${plan.name}`,
        description: `Teachific ${plan.name} plan`,
        metadata: { teachific_tier: tier },
      });
    }

    // Monthly price
    const monthlyKey = `${tier}_monthly`;
    const existingPrices = await stripe.prices.list({ product: product.id, limit: 100 });
    let monthlyPrice = existingPrices.data.find(
      (p) => p.recurring?.interval === "month" && p.metadata?.teachific_tier === tier && p.active
    );
    if (!monthlyPrice) {
      monthlyPrice = await stripe.prices.create({
        product: product.id,
        unit_amount: plan.monthlyPrice,
        currency: "usd",
        recurring: { interval: "month" },
        metadata: { teachific_tier: tier, interval: "monthly" },
      });
    }
    STRIPE_PRICE_IDS[monthlyKey] = monthlyPrice.id;

    // Annual price
    const annualKey = `${tier}_annual`;
    let annualPrice = existingPrices.data.find(
      (p) => p.recurring?.interval === "year" && p.metadata?.teachific_tier === tier && p.active
    );
    if (!annualPrice) {
      annualPrice = await stripe.prices.create({
        product: product.id,
        unit_amount: plan.annualPrice,
        currency: "usd",
        recurring: { interval: "year" },
        metadata: { teachific_tier: tier, interval: "annual" },
      });
    }
    STRIPE_PRICE_IDS[annualKey] = annualPrice.id;
  }

  // ── Teachific Studio™ — Web + Desktop plans ────────────────────────────────────
  const studioAppPlans: Record<"web" | "desktop" | "bundle", { name: string; monthlyPrice: number; annualPrice: number; description: string }> = {
    web:     { name: "Teachific Studio™ Web",    monthlyPrice: 3700, annualPrice: 29900, description: "Teachific Studio™ Web — browser-based editing, CC styling, transcript editing" },
    desktop: { name: "Teachific Studio™ Desktop", monthlyPrice: 4700, annualPrice: 39900, description: "Teachific Studio™ Desktop — full desktop app, HD MP4 export, multi-track editing" },
    bundle:  { name: "Teachific Studio™ Bundle",  monthlyPrice: 6700, annualPrice: 54900, description: "Teachific Studio™ Bundle — Web + Desktop apps" },
  };
  for (const [tier, plan] of Object.entries(studioAppPlans) as ["web"|"desktop"|"bundle", typeof studioAppPlans["web"]][]) {
    const productKey = `studio_${tier}`;
    const products = await stripe.products.list({ limit: 100 });
    let product = products.data.find((p) => p.metadata?.product_key === productKey);
    if (!product) {
      product = await stripe.products.create({
        name: plan.name, description: plan.description,
        metadata: { product_key: productKey, product_type: "studio", access_tier: tier },
      });
    }
    const existingPrices = await stripe.prices.list({ product: product.id, limit: 100 });
    let monthlyPrice = existingPrices.data.find(
      (p) => p.recurring?.interval === "month" && p.metadata?.product_key === productKey && p.active
    );
    if (!monthlyPrice) {
      monthlyPrice = await stripe.prices.create({
        product: product.id, unit_amount: plan.monthlyPrice, currency: "usd",
        recurring: { interval: "month" },
        metadata: { product_key: productKey, interval: "monthly", product_type: "studio", access_tier: tier },
      });
    }
    STRIPE_PRICE_IDS[`studio_${tier}_monthly`] = monthlyPrice.id;
    let annualPrice = existingPrices.data.find(
      (p) => p.recurring?.interval === "year" && p.metadata?.product_key === productKey && p.active
    );
    if (!annualPrice) {
      annualPrice = await stripe.prices.create({
        product: product.id, unit_amount: plan.annualPrice, currency: "usd",
        recurring: { interval: "year" },
        metadata: { product_key: productKey, interval: "annual", product_type: "studio", access_tier: tier },
      });
    }
    STRIPE_PRICE_IDS[`studio_${tier}_annual`] = annualPrice.id;
  }

  // ── TeachificCreator™ — Web + Desktop plans ──────────────────────────────────────
  const creatorAppPlans: Record<"web" | "desktop" | "bundle", { name: string; monthlyPrice: number; annualPrice: number; description: string }> = {
    web:     { name: "TeachificCreator™ Web",    monthlyPrice: 9900,  annualPrice: 89900,  description: "TeachificCreator™ Web — browser-based SCORM authoring, branching scenarios, AI content generation" },
    desktop: { name: "TeachificCreator™ Desktop", monthlyPrice: 11700, annualPrice: 99900,  description: "TeachificCreator™ Desktop — full desktop authoring suite" },
    bundle:  { name: "TeachificCreator™ Bundle",  monthlyPrice: 14900, annualPrice: 129900, description: "TeachificCreator™ Bundle — Web + Desktop apps" },
  };
  for (const [tier, plan] of Object.entries(creatorAppPlans) as ["web"|"desktop"|"bundle", typeof creatorAppPlans["web"]][]) {
    const productKey = `creator_${tier}`;
    const products = await stripe.products.list({ limit: 100 });
    let product = products.data.find((p) => p.metadata?.product_key === productKey);
    if (!product) {
      product = await stripe.products.create({
        name: plan.name, description: plan.description,
        metadata: { product_key: productKey, product_type: "creator", access_tier: tier },
      });
    }
    const existingPrices = await stripe.prices.list({ product: product.id, limit: 100 });
    let monthlyPrice = existingPrices.data.find(
      (p) => p.recurring?.interval === "month" && p.metadata?.product_key === productKey && p.active
    );
    if (!monthlyPrice) {
      monthlyPrice = await stripe.prices.create({
        product: product.id, unit_amount: plan.monthlyPrice, currency: "usd",
        recurring: { interval: "month" },
        metadata: { product_key: productKey, interval: "monthly", product_type: "creator", access_tier: tier },
      });
    }
    STRIPE_PRICE_IDS[`creator_${tier}_monthly`] = monthlyPrice.id;
    let annualPrice = existingPrices.data.find(
      (p) => p.recurring?.interval === "year" && p.metadata?.product_key === productKey && p.active
    );
    if (!annualPrice) {
      annualPrice = await stripe.prices.create({
        product: product.id, unit_amount: plan.annualPrice, currency: "usd",
        recurring: { interval: "year" },
        metadata: { product_key: productKey, interval: "annual", product_type: "creator", access_tier: tier },
      });
    }
    STRIPE_PRICE_IDS[`creator_${tier}_annual`] = annualPrice.id;
  }

  // ── Teachific QuizMaker™ — Web + Desktop plans ─────────────────────────────────
  const quizCreatorAppPlans: Record<"web" | "desktop" | "bundle", { name: string; monthlyPrice: number; annualPrice: number; description: string }> = {
    web:     { name: "Teachific QuizMaker™ Web",    monthlyPrice: 3700, annualPrice: 29900, description: "Teachific QuizMaker™ Web — browser-based quiz creation, 7 question types, LMS integration" },
    desktop: { name: "Teachific QuizMaker™ Desktop", monthlyPrice: 4800, annualPrice: 39900, description: "Teachific QuizMaker™ Desktop — full desktop quiz authoring, AES-256 encrypted .quiz files" },
    bundle:  { name: "Teachific QuizMaker™ Bundle",  monthlyPrice: 6500, annualPrice: 54900, description: "Teachific QuizMaker™ Bundle — Web + Desktop apps" },
  };
  for (const [tier, plan] of Object.entries(quizCreatorAppPlans) as ["web"|"desktop"|"bundle", typeof quizCreatorAppPlans["web"]][]) {
    const productKey = `quiz_creator_${tier}`;
    const products = await stripe.products.list({ limit: 100 });
    let product = products.data.find((p) => p.metadata?.product_key === productKey);
    if (!product) {
      product = await stripe.products.create({
        name: plan.name, description: plan.description,
        metadata: { product_key: productKey, product_type: "quiz_creator", access_tier: tier },
      });
    }
    const existingPrices = await stripe.prices.list({ product: product.id, limit: 100 });
    let monthlyPrice = existingPrices.data.find(
      (p) => p.recurring?.interval === "month" && p.metadata?.product_key === productKey && p.active
    );
    if (!monthlyPrice) {
      monthlyPrice = await stripe.prices.create({
        product: product.id, unit_amount: plan.monthlyPrice, currency: "usd",
        recurring: { interval: "month" },
        metadata: { product_key: productKey, interval: "monthly", product_type: "quiz_creator", access_tier: tier },
      });
    }
    STRIPE_PRICE_IDS[`quiz_creator_${tier}_monthly`] = monthlyPrice.id;
    let annualPrice = existingPrices.data.find(
      (p) => p.recurring?.interval === "year" && p.metadata?.product_key === productKey && p.active
    );
    if (!annualPrice) {
      annualPrice = await stripe.prices.create({
        product: product.id, unit_amount: plan.annualPrice, currency: "usd",
        recurring: { interval: "year" },
        metadata: { product_key: productKey, interval: "annual", product_type: "quiz_creator", access_tier: tier },
      });
    }
    STRIPE_PRICE_IDS[`quiz_creator_${tier}_annual`] = annualPrice.id;
  }

    console.log("[Stripe] Plans initialized:", Object.keys(STRIPE_PRICE_IDS));
}
