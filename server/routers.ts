import { COOKIE_NAME, IMPERSONATION_ORIGINAL_COOKIE } from "@shared/const";
import dns from "node:dns";
import { sendEmail } from "./sendgrid";
import https from "node:https";
import { TRPCError } from "@trpc/server";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  addOrgMember,
  createOrg,
  createPackage,
  createPermissions,
  createPlaySession,
  createVersion,
  deletePackage,
  getAllOrgs,
  getAllPackages,
  getAllUsers,
  getAnalyticsByOrg,
  getAnalyticsByPackage,
  getAnalyticsSummary,
  getEntryPointAsset,
  getFileAssetsByVersion,
  getOrgById,
  getOrgBySlug,
  getOrgMember,
  getOrgMembers,
  getOrgsByUserId,
  getPackageById,
  getPackagesByOrg,
  getPermissions,
  getPlaySession,
  getPlaySessionsByPackage,
  getUserByEmail,
  getUserById,
  getUserPlayCount,
  getVersionById,
  getVersionsByPackage,
  incrementDownloadCount,
  incrementPlayCount,
  logAnalyticsEvent,
  removeOrgMember,
  updateOrgMemberRole,
  updatePackage,
  updatePermissions,
  updatePlaySession,
  updateUserRole,
  upsertScormData,
  getScormData,
  getLatestVersionNumber,
  getFoldersByOrg,
  getFolderById,
  createFolder,
  updateFolder,
  deleteFolder,
  movePackageToFolder,
  setVersionReplacedAt,
  deleteVersionAssets,
  getOrgIdForUser,
  getPlatformSettings,
  updatePlatformSettings,
  updateUser,
  deleteUser,
  updateOrg,
  deleteOrg,
  upsertUser,
  createManualUser,
  getDb,
  getPlanLimits,
  upsertPlanLimit,
  getOrgLimitOverrides,
  upsertOrgLimitOverride,
  deleteOrgLimitOverride,
  deleteOrgCascade,
  getOrgLimitsEnriched,
  getOrgStorageUsage,
  createSupportTicket,
  getSupportTickets,
  updateSupportTicketStatus,
} from "./db";
import { courseEnrollments, organizations, orgMembers, orgLandingPages, users } from "../drizzle/schema";
import { eq, sql } from "drizzle-orm";
import {
  getOrgSubscription,
  upsertOrgSubscription,
  getEnrollmentsByUser,
  createEnrollment,
  getCoursesByOrg,
} from "./lmsDb";
import {
  getQuizById,
  getQuizzesByOrg,
  createQuiz,
  updateQuiz,
  deleteQuiz,
  getQuestionsByQuiz,
  createQuestion,
  updateQuestion,
  deleteQuestion,
  getChoicesByQuestion,
  upsertChoices,
  createAttempt,
  getAttemptById,
  submitAttempt,
  getAttemptsByQuiz,
  saveResponse,
  getResponsesByAttempt,
  getQuizAnalytics,
} from "./quizDb";
import { invokeLLM } from "./_core/llm";
import { storagePut } from "./storage";
import { getSessionCookieOptions } from "./_core/cookies";
import { TEACHIFIC_SESSION_COOKIE } from "./_core/teachificSession";
import { sdk } from "./_core/sdk";
import { systemRouter } from "./_core/systemRouter";
import { lmsRouter } from "./lmsRouter";
import { formsRouter } from "./formsRouter";
import { customAuthRouter } from "./customAuthRouter";
import { communityRouter } from "./communityRouter";
import { stripeRouter } from "./stripeRouter";
import { authoringRouter } from "./authoringRouter";
import { quizMakerRouter } from "./quizMakerRouter";
import { questionBankRouter } from "./questionBankRouter";
import { teachificPayRouter } from "./teachificPayRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { ENV } from "./_core/env";
import { issueEmbedToken, verifyEmbedToken } from "./embedToken";

// ─── SSL check helper ────────────────────────────────────────────────────────
// Attempts an HTTPS HEAD request to the custom domain and returns 'active' if
// the TLS handshake succeeds, 'error' on cert/connection failure, or 'pending'
// if the domain is not yet reachable.
function checkSsl(domain: string): Promise<"active" | "pending" | "error"> {
  return new Promise((resolve) => {
    const req = https.request(
      { hostname: domain, port: 443, method: "HEAD", path: "/", timeout: 8000 },
      () => { req.destroy(); resolve("active"); }
    );
    req.on("error", (err: any) => {
      // ECONNREFUSED / ENOTFOUND = domain not pointing here yet
      if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND" || err.code === "ETIMEDOUT") {
        resolve("pending");
      } else {
        // cert errors (DEPTH_ZERO_SELF_SIGNED_CERT, CERT_HAS_EXPIRED, etc.) = reachable but SSL issue
        resolve("error");
      }
    });
    req.on("timeout", () => { req.destroy(); resolve("pending"); });
    req.end();
  });
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────
// site_owner + site_admin have site-wide access
const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "site_admin" && ctx.user.role !== "site_owner") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
  }
  return next({ ctx });
});

// org_admin / org_super_admin can manage their own org; site_admin + site_owner can manage any org
const orgAdminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (!(["site_owner", "site_admin", "org_super_admin", "org_admin"] as string[]).includes(ctx.user.role)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Organization admin access required" });
  }
  return next({ ctx });
});

const ownerProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "site_owner") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Site owner access required" });
  }
  return next({ ctx });
});

// ─── App Router ───────────────────────────────────────────────────────────────
export const appRouter = router({
  system: systemRouter,
  lms: lmsRouter,
  customAuth: customAuthRouter,
  forms: formsRouter,
  community: communityRouter,
  billing: stripeRouter,
  authoring: authoringRouter,
  quizMaker: quizMakerRouter,
  questionBank: questionBankRouter,
  teachificPay: teachificPayRouter,

  // ── Embed Token (cookie-free iframe auth) ─────────────────────────────────
  embed: router({
    /**
     * Issue a short-lived embed token for a package.
     * Called from the parent page (where the session cookie IS available),
     * then passed as ?t=<token> into the iframe src so the iframe can make
     * tRPC calls without needing a session cookie.
     */
    getToken: publicProcedure
      .input(z.object({
        packageId: z.number(),
        orgId: z.number().optional(),
        learnerName: z.string().max(255).optional(),
        learnerEmail: z.string().max(320).optional(),
        learnerId: z.string().max(128).optional(),
        learnerGroup: z.string().max(128).optional(),
        customData: z.string().optional(),
        utmSource: z.string().max(128).optional(),
        utmMedium: z.string().max(128).optional(),
        utmCampaign: z.string().max(128).optional(),
        referrer: z.string().max(512).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const token = await issueEmbedToken({
          packageId: input.packageId,
          userId: ctx.user?.id,
          orgId: input.orgId,
          learnerName: input.learnerName,
          learnerEmail: input.learnerEmail,
          learnerId: input.learnerId,
          learnerGroup: input.learnerGroup,
          customData: input.customData,
          utmSource: input.utmSource,
          utmMedium: input.utmMedium,
          utmCampaign: input.utmCampaign,
          referrer: input.referrer,
        });
        return { token };
      }),

    /**
     * Start a play session using an embed token instead of a session cookie.
     * Used by EmbedPage/PlayerPage when running inside an iframe.
     */
    startSession: publicProcedure
      .input(z.object({ embedToken: z.string() }))
      .mutation(async ({ input, ctx }) => {
        const payload = await verifyEmbedToken(input.embedToken);
        if (!payload) throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid or expired embed token" });
        const pkg = await getPackageById(payload.packageId);
        if (!pkg) throw new TRPCError({ code: "NOT_FOUND" });
        if (!pkg.isPublic && !payload.userId) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "This content is private." });
        }
        const perms = await getPermissions(payload.packageId);
        if (perms?.maxTotalPlays && pkg.totalPlayCount >= perms.maxTotalPlays) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Maximum total plays reached" });
        }
        if (perms?.playExpiresAt && new Date() > perms.playExpiresAt) {
          throw new TRPCError({ code: "FORBIDDEN", message: "This content has expired" });
        }
        const token = nanoid(32);
        await createPlaySession({
          packageId: payload.packageId,
          userId: payload.userId,
          orgId: payload.orgId,
          sessionToken: token,
          ipAddress: ctx.req.headers["x-forwarded-for"] as string ?? ctx.req.socket?.remoteAddress,
          userAgent: ctx.req.headers["user-agent"],
          referrer: payload.referrer,
          learnerName: payload.learnerName,
          learnerEmail: payload.learnerEmail,
          learnerId: payload.learnerId,
          learnerGroup: payload.learnerGroup,
          customData: payload.customData,
          utmSource: payload.utmSource,
          utmMedium: payload.utmMedium,
          utmCampaign: payload.utmCampaign,
        });
        await incrementPlayCount(payload.packageId);
        await logAnalyticsEvent({
          packageId: payload.packageId,
          userId: payload.userId,
          orgId: payload.orgId,
          eventType: "play_start",
          eventData: JSON.stringify({}),
        });
        return { sessionToken: token };
      }),

    /**
     * End a play session (token-based, no cookie required).
     */
    endSession: publicProcedure
      .input(z.object({
        sessionToken: z.string(),
        completionStatus: z.enum(["not_attempted", "incomplete", "completed", "passed", "failed", "unknown"]).optional(),
        scoreRaw: z.number().optional(),
        scoreMax: z.number().optional(),
        scoreMin: z.number().optional(),
        scoreScaled: z.number().optional(),
      }))
      .mutation(async ({ input }) => {
        const session = await getPlaySession(input.sessionToken);
        if (!session) throw new TRPCError({ code: "NOT_FOUND" });
        const isCompleted = input.completionStatus === "completed" || input.completionStatus === "passed";
        await updatePlaySession(input.sessionToken, {
          endedAt: new Date(),
          completionStatus: input.completionStatus,
          scoreRaw: input.scoreRaw,
          scoreMax: input.scoreMax,
          scoreMin: input.scoreMin,
          scoreScaled: input.scoreScaled,
          isCompleted,
        });
        if (isCompleted) {
          await logAnalyticsEvent({
            packageId: session.packageId,
            sessionId: session.id,
            userId: session.userId ?? undefined,
            orgId: session.orgId ?? undefined,
            eventType: "scorm_complete",
            eventData: JSON.stringify({ score: input.scoreRaw }),
          });
        }
        return { success: true };
      }),
  }),

  // ── Auth ──────────────────────────────────────────────────────────────────
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      ctx.res.clearCookie(TEACHIFIC_SESSION_COOKIE, { ...cookieOptions, maxAge: -1 });
      if (cookieOptions.domain) {
        const { domain: _domain, ...hostOnlyCookieOptions } = cookieOptions;
        ctx.res.clearCookie(TEACHIFIC_SESSION_COOKIE, { ...hostOnlyCookieOptions, maxAge: -1 });
      }
      return { success: true } as const;
    }),
  }),

  // ── Resolved Branding (public) ─────────────────────────────────────────────
  // Returns platform branding for site admins/owners, or org branding for org members
  resolvedBranding: publicProcedure.query(async ({ ctx }) => {
    const db2 = await getDb();
    if (!db2) return null;
    const { platformSettings: psTable, orgThemes, orgMembers: omTable, organizations } = await import("../drizzle/schema");
    // If user is logged in and belongs to an org, return org branding
    if (ctx.user) {
      const membership = await db2
        .select({ orgId: omTable.orgId })
        .from(omTable)
        .where(eq(omTable.userId, ctx.user.id))
        .limit(1);
      if (membership.length) {
        const orgId = membership[0].orgId;
        const orgTheme = await db2.select().from(orgThemes).where(eq(orgThemes.orgId, orgId)).limit(1);
        if (orgTheme.length) {
          const t = orgTheme[0];
          return {
            source: "org" as const,
            primaryColor: t.primaryColor,
            accentColor: t.accentColor,
            buttonColor: t.buttonColor,
            buttonTextColor: t.buttonTextColor,
            sidebarBgColor: t.sidebarBgColor,
            sidebarTextColor: t.sidebarTextColor,
            sidebarActiveColor: t.sidebarActiveColor,
            pageBgColor: t.pageBgColor,
            logoUrl: t.adminLogoUrl,
            faviconUrl: t.faviconUrl,
            platformName: null,
            headingFont: t.fontFamily,
            bodyFont: t.fontFamily,
          };
        }
      }
    }
    // Fall back to platform branding
    const rows = await db2.select().from(psTable).limit(1);
    if (!rows.length) return null;
    const p = rows[0];
    return {
      source: "platform" as const,
      primaryColor: p.primaryColor,
      accentColor: p.accentColor,
      buttonColor: p.buttonColor,
      buttonTextColor: p.buttonTextColor,
      sidebarBgColor: p.sidebarBgColor,
      sidebarTextColor: p.sidebarTextColor,
      sidebarActiveColor: p.sidebarActiveColor,
      pageBgColor: p.pageBgColor,
      logoUrl: p.logoUrl,
      faviconUrl: p.faviconUrl,
      platformName: p.platformName,
      headingFont: p.headingFont,
      bodyFont: p.bodyFont,
    };
  }),

  // ── Subdomain Resolution (public) ──────────────────────────────────────────
  // Resolves org info from a subdomain slug (e.g. "myorg" from myorg.teachific.app)
  resolveBySubdomain: publicProcedure
    .input(z.object({ subdomain: z.string().min(1) }))
    .query(async ({ input }) => {
      const db2 = await getDb();
      if (!db2) return null;
      const { organizations: orgsTable, orgThemes } = await import("../drizzle/schema");
      // Match by customSubdomain first, then by slug
      const orgs = await db2
        .select()
        .from(orgsTable)
        .where(eq(orgsTable.isActive, true))
        .limit(100);
      const org = orgs.find(o =>
        (o.customSubdomain && o.customSubdomain.toLowerCase() === input.subdomain.toLowerCase()) ||
        o.slug.toLowerCase() === input.subdomain.toLowerCase()
      );
      if (!org) return null;
      // Get org theme
      const theme = await db2.select().from(orgThemes).where(eq(orgThemes.orgId, org.id)).limit(1);
      const t = theme[0];
      return {
        orgId: org.id,
        orgName: org.name,
        orgSlug: org.slug,
        logoUrl: t?.adminLogoUrl ?? org.logoUrl,
        primaryColor: t?.primaryColor,
        accentColor: t?.accentColor,
        buttonColor: t?.buttonColor,
        buttonTextColor: t?.buttonTextColor,
        sidebarBgColor: t?.sidebarBgColor,
        sidebarTextColor: t?.sidebarTextColor,
        sidebarActiveColor: t?.sidebarActiveColor,
        pageBgColor: t?.pageBgColor,
        headingFont: t?.fontFamily,
        bodyFont: t?.fontFamily,
      };
    }),

  // ── Users (admin) ─────────────────────────────────────────────────────────
  users: router({
    list: adminProcedure.query(() => getAllUsers()),
    // Returns users with their primary org name — for platform admin search/filter
    listWithOrg: adminProcedure.query(async () => {
      const db = await getDb();
      if (!db) return [];
      const allUsers = await getAllUsers();
      const memberships = await db
        .select({ userId: orgMembers.userId, orgName: organizations.name, orgId: organizations.id })
        .from(orgMembers)
        .innerJoin(organizations, eq(orgMembers.orgId, organizations.id));
      const orgByUser = new Map<number, { orgName: string; orgId: number }>();
      for (const m of memberships) {
        if (!orgByUser.has(m.userId)) orgByUser.set(m.userId, { orgName: m.orgName, orgId: m.orgId });
      }
      return allUsers.map((u) => ({
        ...u,
        orgName: orgByUser.get(u.id)?.orgName ?? null,
        orgId: orgByUser.get(u.id)?.orgId ?? null,
      }));
    }),
    get: adminProcedure.input(z.object({ id: z.number() })).query(({ input }) => getUserById(input.id)),
    // Create a new user manually (platform admin)
    create: adminProcedure
      .input(z.object({
        name: z.string().min(1),
        email: z.string().email(),
        password: z.string().min(6),
        role: z.enum(["site_admin", "org_super_admin", "org_admin", "member"]).default("member"),
        orgId: z.number().optional(),
        memberSubRole: z.enum(["basic_member", "instructor", "group_manager", "group_member"]).optional(),
        groupId: z.number().optional(),
      }))
      .mutation(async ({ input }) => {
        const existing = await getUserByEmail(input.email);
        if (existing) throw new TRPCError({ code: "CONFLICT", message: "A user with that email already exists" });
        const bcrypt = await import("bcryptjs");
        const passwordHash = await bcrypt.default.hash(input.password, 10);
        const openId = `manual_${nanoid(20)}`;
        await createManualUser({ openId, name: input.name, email: input.email, loginMethod: "email", role: input.role, passwordHash });
        const newUser = await getUserByEmail(input.email);
        if (!newUser) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create user" });
        if (input.orgId) {
          const orgRole = (input.role === "org_admin" || input.role === "org_super_admin") ? input.role : "member";
          await addOrgMember(input.orgId, newUser.id, orgRole, undefined, input.memberSubRole);
          // If group assignment requested, add to group_members
          if (input.groupId) {
            const db2 = await getDb();
            if (db2) {
              const { groupMembers: gmTable } = await import("../drizzle/schema");
              await db2.insert(gmTable).values({ groupId: input.groupId, userId: newUser.id, email: input.email, name: input.name, status: "active" }).onDuplicateKeyUpdate({ set: { status: "active" } });
            }
          }
        }
        return newUser;
      }),
    // Assign a user to an org (platform admin only)
    assignToOrg: adminProcedure
      .input(z.object({
        userId: z.number(),
        orgId: z.number(),
        orgRole: z.enum(["org_super_admin", "org_admin", "member"]).default("member"),
        memberSubRole: z.enum(["basic_member", "instructor", "group_manager", "group_member"]).optional(),
        groupId: z.number().optional(),
      }))
      .mutation(async ({ input }) => {
        const existing = await getOrgMember(input.orgId, input.userId);
        if (existing) {
          await updateOrgMemberRole(input.orgId, input.userId, input.orgRole, input.memberSubRole);
        } else {
          await addOrgMember(input.orgId, input.userId, input.orgRole, undefined, input.memberSubRole);
        }
        if (input.groupId) {
          const db2 = await getDb();
          if (db2) {
            const user = await getUserById(input.userId);
            const { groupMembers: gmTable } = await import("../drizzle/schema");
            await db2.insert(gmTable).values({ groupId: input.groupId, userId: input.userId, email: user?.email ?? "", name: user?.name ?? "", status: "active" }).onDuplicateKeyUpdate({ set: { status: "active" } });
          }
        }
        return { success: true };
      }),
    updateRole: ownerProcedure
      .input(z.object({ userId: z.number(), role: z.enum(["site_owner", "site_admin", "org_super_admin", "org_admin", "member"]) }))
      .mutation(({ input }) => updateUserRole(input.userId, input.role)),
    update: adminProcedure
      .input(z.object({
        userId: z.number(),
        name: z.string().min(1).optional(),
        email: z.string().email().optional(),
        role: z.enum(["site_owner", "site_admin", "org_super_admin", "org_admin", "member"]).optional(),
      }))
      .mutation(({ input }) => { const { userId, ...data } = input; return updateUser(userId, data); }),
    delete: ownerProcedure
      .input(z.object({ userId: z.number() }))
      .mutation(({ input }) => deleteUser(input.userId)),
    getEnrollments: adminProcedure
      .input(z.object({ userId: z.number() }))
      .query(({ input }) => getEnrollmentsByUser(input.userId)),
    enrollInCourse: adminProcedure
      .input(z.object({ userId: z.number(), courseId: z.number(), orgId: z.number() }))
      .mutation(({ input }) => createEnrollment({ userId: input.userId, courseId: input.courseId, orgId: input.orgId, isActive: true, progressPct: 0, certificateIssued: false })),
    revokeEnrollment: adminProcedure
      .input(z.object({ enrollmentId: z.number() }))
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        await db.update(courseEnrollments).set({ isActive: false }).where(eq(courseEnrollments.id, input.enrollmentId));
        return { success: true };
      }),
    // Reset a user's password (admin sets a new password on their behalf)
    resetPassword: adminProcedure
      .input(z.object({
        userId: z.number(),
        newPassword: z.string().min(6, "Password must be at least 6 characters"),
      }))
      .mutation(async ({ input }) => {
        const bcrypt = await import("bcryptjs");
        const passwordHash = await bcrypt.default.hash(input.newPassword, 10);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        const { users: usersTable } = await import("../drizzle/schema");
        await db.update(usersTable).set({ passwordHash }).where(eq(usersTable.id, input.userId));
        return { success: true };
      }),
    // Get the org subscription for a specific user (via their org membership)
    getUserOrgSubscription: adminProcedure
      .input(z.object({ userId: z.number() }))
      .query(async ({ input }) => {
        const db = await getDb();
        if (!db) return null;
        const { orgMembers: orgMembersTable, orgSubscriptions: orgSubTable } = await import("../drizzle/schema");
        const row = await db
          .select({
            orgId: orgMembersTable.orgId,
            plan: orgSubTable.plan,
            status: orgSubTable.status,
            customPriceUsd: orgSubTable.customPriceUsd,
            customPriceLabel: orgSubTable.customPriceLabel,
            adminNotes: orgSubTable.adminNotes,
            currentPeriodEnd: orgSubTable.currentPeriodEnd,
            cancelAtPeriodEnd: orgSubTable.cancelAtPeriodEnd,
          })
          .from(orgMembersTable)
          .leftJoin(orgSubTable, eq(orgSubTable.orgId, orgMembersTable.orgId))
          .where(eq(orgMembersTable.userId, input.userId))
          .limit(1)
          .then((r) => r[0] ?? null);
        return row;
      }),
    // Update the org subscription for the org a user belongs to
    updateUserOrgSubscription: adminProcedure
      .input(z.object({
        userId: z.number(),
        plan: z.enum(["free", "starter", "builder", "pro", "enterprise"]),
        status: z.enum(["active", "trialing", "past_due", "cancelled", "unpaid"]).optional(),
        customPriceUsd: z.number().optional(),
        customPriceLabel: z.string().optional(),
        adminNotes: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        const { orgMembers: orgMembersTable } = await import("../drizzle/schema");
        const membership = await db.select({ orgId: orgMembersTable.orgId }).from(orgMembersTable).where(eq(orgMembersTable.userId, input.userId)).limit(1).then((r) => r[0] ?? null);
        if (!membership) throw new TRPCError({ code: "NOT_FOUND", message: "User is not a member of any organization" });
        const { plan, status, customPriceUsd, customPriceLabel, adminNotes } = input;
        await upsertOrgSubscription(membership.orgId, { plan, status: status ?? "active", customPriceUsd, customPriceLabel, adminNotes, assignedByUserId: ctx.user.id });
        return { success: true };
      }),
    // Bulk update role and/or org assignment for multiple users
    bulkUpdate: adminProcedure
      .input(z.object({
        userIds: z.array(z.number()).min(1).max(200),
        role: z.enum(["site_admin", "org_super_admin", "org_admin", "member", "user"]).optional(),
        orgId: z.number().optional(),
        orgRole: z.enum(["org_super_admin", "org_admin", "member"]).optional(),
      }))
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        const { users: usersTable } = await import("../drizzle/schema");
        let updated = 0;
        for (const userId of input.userIds) {
          if (input.role) {
            await db.update(usersTable).set({ role: input.role }).where(eq(usersTable.id, userId));
          }
          if (input.orgId) {
            const orgRole = input.orgRole ?? "member";
            const existing = await getOrgMember(input.orgId, userId);
            if (existing) {
              await updateOrgMemberRole(input.orgId, userId, orgRole);
            } else {
              await addOrgMember(input.orgId, userId, orgRole);
            }
          }
          updated++;
        }
        return { updated };
      }),
    // Bulk enroll multiple users in a course
    bulkEnroll: adminProcedure
      .input(z.object({
        userIds: z.array(z.number()).min(1).max(200),
        courseId: z.number(),
        orgId: z.number(),
      }))
      .mutation(async ({ input }) => {
        let enrolled = 0;
        for (const userId of input.userIds) {
          try {
            await createEnrollment({ userId, courseId: input.courseId, orgId: input.orgId, isActive: true, progressPct: 0, certificateIssued: false });
            enrolled++;
          } catch { /* skip already enrolled */ }
        }
        return { enrolled };
      }),
  }),
  // ── Organizationss ─────────────────────────────────────────────────────────
  orgs: router({
    list: adminProcedure.query(() => getAllOrgs()),
    myOrgs: protectedProcedure.query(({ ctx }) => getOrgsByUserId(ctx.user.id)),
    // Returns the user's primary org + their role in it (auto-detected, no manual selection needed)
    // Priority: highest role first (org_super_admin > org_admin > member), then isPrimary as tiebreaker
    myContext: protectedProcedure
      .input(z.object({ subdomain: z.string().optional() }).optional())
      .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return null;
      const rows = await db
        .select({ org: organizations, role: orgMembers.role })
        .from(orgMembers)
        .innerJoin(organizations, eq(orgMembers.orgId, organizations.id))
        .where(eq(orgMembers.userId, ctx.user.id));
      if (rows.length === 0) return null;
      // If a subdomain is provided (user is on an org subdomain), scope to that org
      const subdomain = input?.subdomain;
      if (subdomain) {
        const match = rows.find(r => r.org.slug?.toLowerCase() === subdomain.toLowerCase());
        if (match) {
          const subscription = await getOrgSubscription(match.org.id);
          return {
            org: match.org,
            role: match.role as "org_super_admin" | "org_admin" | "site_owner" | "site_admin" | "sub_admin" | "instructor" | "member" | "user",
            subscription: subscription ?? null,
          };
        }
      }
      // Role priority: org_super_admin > org_admin > sub_admin > instructor > member/user
      const ROLE_PRIORITY: Record<string, number> = {
        org_super_admin: 100, org_admin: 90, sub_admin: 70,
        instructor: 60, group_manager: 50, group_member: 40, member: 20, user: 10,
      };
      const sorted = [...rows].sort((a, b) => {
        const pa = ROLE_PRIORITY[a.role] ?? 0;
        const pb = ROLE_PRIORITY[b.role] ?? 0;
        if (pb !== pa) return pb - pa;
        // Tiebreak: non-primary org first (personal workspaces rank lower)
        const aIsPrimary = a.org.isPrimary ? 1 : 0;
        const bIsPrimary = b.org.isPrimary ? 1 : 0;
        return aIsPrimary - bIsPrimary;
      });
      const best = sorted[0];
      const subscription = await getOrgSubscription(best.org.id);
      return {
        org: best.org,
        role: best.role as "org_super_admin" | "org_admin" | "site_owner" | "site_admin" | "sub_admin" | "instructor" | "member" | "user",
        subscription: subscription ?? null,
      };
    }),
    // Org admin can update their own org settings
    updateSettings: protectedProcedure
      .input(z.object({
        name: z.string().min(1).optional(),
        slug: z.string().min(1).optional(),
        logoUrl: z.string().optional().nullable(),
        customDomain: z.string().optional().nullable(),
        customSenderEmail: z.string().email().optional().nullable(),
        customSenderName: z.string().optional().nullable(),
      }))
      .mutation(async ({ input, ctx }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const rows = await db
          .select({ org: organizations, role: orgMembers.role })
          .from(orgMembers)
          .innerJoin(organizations, eq(orgMembers.orgId, organizations.id))
          .where(eq(orgMembers.userId, ctx.user.id))
          .limit(1);
        if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "No organization found" });
        if (rows[0].role !== "org_admin" && rows[0].role !== "org_super_admin" && ctx.user.role !== "site_owner" && ctx.user.role !== "site_admin" && ctx.user.role !== "org_super_admin") {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
        // Validate slug uniqueness if changing it
        if (input.slug && input.slug !== rows[0].org.slug) {
          const slugTaken = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, input.slug)).limit(1);
          if (slugTaken.length) throw new TRPCError({ code: "CONFLICT", message: "This subdomain is already taken. Please choose another." });
        }
        const prevDomain = rows[0].org.customDomain;
        const newDomain = input.customDomain;
        // Reset verification status when domain changes or is removed
        const domainChanged = newDomain !== undefined && newDomain !== prevDomain;
        if (domainChanged) {
          await updateOrg(rows[0].org.id, {
            ...input,
            domainVerificationStatus: newDomain ? "pending" : "unverified",
            domainVerifiedAt: null,
            domainVerificationError: null,
          });
          // Fire-and-forget background DNS check when a new domain is saved
          if (newDomain) {
            const orgId = rows[0].org.id;
            const slug = rows[0].org.slug;
            const expectedTarget = `${slug}.teachific.app`;
            setImmediate(async () => {
              try {
                const db2 = await getDb();
                if (!db2) return;
                const cnames = await dns.promises.resolveCname(newDomain);
                const matched = cnames.some((c) =>
                  c.toLowerCase().replace(/\.$/, "") === expectedTarget.toLowerCase()
                );
                if (matched) {
                  await db2.update(organizations).set({
                    domainVerificationStatus: "verified",
                    domainVerifiedAt: new Date(),
                    domainVerificationError: null,
                  }).where(eq(organizations.id, orgId));
                } else {
                  await db2.update(organizations).set({
                    domainVerificationStatus: "failed",
                    domainVerificationError: `CNAME resolves to [${cnames.join(", ")}] but expected ${expectedTarget}`,
                  }).where(eq(organizations.id, orgId));
                }
              } catch (err: any) {
                const db2 = await getDb();
                if (!db2) return;
                const errorMsg = err.code === "ENOTFOUND" || err.code === "ENODATA"
                  ? `No CNAME record found for ${newDomain}. Make sure you've added the CNAME record and DNS has propagated.`
                  : `DNS lookup failed: ${err.message}`;
                await db2.update(organizations).set({
                  domainVerificationStatus: "failed",
                  domainVerificationError: errorMsg,
                }).where(eq(organizations.id, orgId));
              }
            });
          }
        } else {
          await updateOrg(rows[0].org.id, input);
        }
        return { success: true };
      }),
    // Auto-provision a default org for users who have none (e.g. existing users pre-dating auto-creation)
    ensureDefault: protectedProcedure.mutation(async ({ ctx }) => {
      const existing = await getOrgsByUserId(ctx.user.id);
      if (existing.length > 0) return existing[0];
      const base = (ctx.user.name || ctx.user.email || "personal")
        .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
      const slug = `${base}-workspace`;
      const taken = await getOrgBySlug(slug);
      const finalSlug = taken ? `${slug}-${ctx.user.id}` : slug;
      const orgName = ctx.user.name ? `${ctx.user.name}'s Workspace` : "My Workspace";
      await createOrg({ name: orgName, slug: finalSlug, description: "Default personal workspace", ownerId: ctx.user.id });
      const newOrg = await getOrgBySlug(finalSlug);
      if (newOrg) await addOrgMember(newOrg.id, ctx.user.id, "org_admin");
      return newOrg;
    }),
    // Upload org logo to S3 and save URL
    uploadLogo: protectedProcedure
      .input(z.object({ fileName: z.string(), contentType: z.string(), fileUrl: z.string().optional() }))
      .mutation(async ({ input, ctx }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const rows = await db
          .select({ org: organizations, role: orgMembers.role })
          .from(orgMembers)
          .innerJoin(organizations, eq(orgMembers.orgId, organizations.id))
          .where(eq(orgMembers.userId, ctx.user.id))
          .limit(1);
        if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "No organization found" });
        if (rows[0].role !== "org_admin" && rows[0].role !== "org_super_admin" && ctx.user.role !== "site_owner" && ctx.user.role !== "site_admin" && ctx.user.role !== "org_super_admin") {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
        // If fileUrl is provided (uploaded via /api/media-upload), just save it
        const fileUrl = input.fileUrl ?? (() => { throw new TRPCError({ code: "BAD_REQUEST", message: "fileUrl is required" }); })();
        // Save the logo URL to the org
        await updateOrg(rows[0].org.id, { logoUrl: fileUrl });
        return { fileUrl };
      }),
     // Upload org favicon to S3 and save URL in orgThemes
    uploadFavicon: orgAdminProcedure
      .input(z.object({ fileName: z.string(), contentType: z.string(), fileUrl: z.string() }))
      .mutation(async ({ input, ctx }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const rows = await db
          .select({ org: organizations, role: orgMembers.role })
          .from(orgMembers)
          .innerJoin(organizations, eq(orgMembers.orgId, organizations.id))
          .where(eq(orgMembers.userId, ctx.user.id))
          .limit(1);
        if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND" });
        const fileUrl = input.fileUrl;
        // Upsert orgTheme with faviconUrl
        const { orgThemes } = await import("../drizzle/schema");
        const existing = await db.select({ id: orgThemes.id }).from(orgThemes).where(eq(orgThemes.orgId, rows[0].org.id)).limit(1);
        if (existing.length) {
          await db.update(orgThemes).set({ faviconUrl: fileUrl }).where(eq(orgThemes.orgId, rows[0].org.id));
        } else {
          await db.insert(orgThemes).values({ orgId: rows[0].org.id, faviconUrl: fileUrl });
        }
        return { fileUrl };
      }),
    // Upload site logo (student-facing) to S3 and save URL in orgThemes
    uploadSiteLogo: orgAdminProcedure
      .input(z.object({ fileName: z.string(), contentType: z.string(), fileUrl: z.string() }))
      .mutation(async ({ input, ctx }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const rows = await db
          .select({ org: organizations, role: orgMembers.role })
          .from(orgMembers)
          .innerJoin(organizations, eq(orgMembers.orgId, organizations.id))
          .where(eq(orgMembers.userId, ctx.user.id))
          .limit(1);
        if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND" });
        const fileUrl = input.fileUrl;
        // Upsert orgTheme with adminLogoUrl (student-facing logo)
        const { orgThemes } = await import("../drizzle/schema");
        const existing = await db.select({ id: orgThemes.id }).from(orgThemes).where(eq(orgThemes.orgId, rows[0].org.id)).limit(1);
        if (existing.length) {
          await db.update(orgThemes).set({ adminLogoUrl: fileUrl }).where(eq(orgThemes.orgId, rows[0].org.id));
        } else {
          await db.insert(orgThemes).values({ orgId: rows[0].org.id, adminLogoUrl: fileUrl });
        }
        return { fileUrl };
      }),
    get: protectedProcedure.input(z.object({ id: z.number() })).query(({ input }) => getOrgById(input.id)),
    getBySlug: protectedProcedure.input(z.object({ slug: z.string() })).query(({ input }) => getOrgBySlug(input.slug)),
    // Real-time subdomain availability check (public so it works on registration too)
    checkSubdomain: publicProcedure
      .input(z.object({ subdomain: z.string().min(1), currentOrgId: z.number().optional() }))
      .query(async ({ input }) => {
        const db = await getDb();
        if (!db) return { available: false };
        const existing = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.slug, input.subdomain.toLowerCase()))
          .limit(1);
        if (!existing.length) return { available: true };
        // If the match is the current org itself, it's still "available" (no change)
        if (input.currentOrgId && existing[0].id === input.currentOrgId) return { available: true };
        return { available: false };
      }),

    // ── Domain Verification ────────────────────────────────────────────────────
    // Get the current domain verification status for the user's org
    getDomainStatus: orgAdminProcedure.query(async ({ ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const rows = await db
        .select({
          org: organizations,
          role: orgMembers.role,
        })
        .from(orgMembers)
        .innerJoin(organizations, eq(orgMembers.orgId, organizations.id))
        .where(eq(orgMembers.userId, ctx.user.id))
        .limit(1);
      if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND" });
      const org = rows[0].org;
       // Check SSL only if domain is verified
      let sslStatus: "active" | "pending" | "error" = "pending";
      if (org.customDomain && org.domainVerificationStatus === "verified") {
        sslStatus = await checkSsl(org.customDomain);
      } else if (!org.customDomain || org.domainVerificationStatus === "unverified") {
        sslStatus = "pending";
      }
      return {
        customDomain: org.customDomain ?? null,
        domainVerificationStatus: org.domainVerificationStatus,
        domainVerifiedAt: org.domainVerifiedAt ?? null,
        domainVerificationError: org.domainVerificationError ?? null,
        expectedCname: `${org.slug}.teachific.app`,
        sslStatus,
      };
    }),
    // Perform a live DNS CNAME lookup and update verification status
    verifyDomain: orgAdminProcedure.mutation(async ({ ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const rows = await db
        .select({ org: organizations, role: orgMembers.role })
        .from(orgMembers)
        .innerJoin(organizations, eq(orgMembers.orgId, organizations.id))
        .where(eq(orgMembers.userId, ctx.user.id))
        .limit(1);
      if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND" });
      const org = rows[0].org;
      if (!org.customDomain) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "No custom domain configured. Please save a custom domain first." });
      }
      const expectedTarget = `${org.slug}.teachific.app`;
      // Set status to pending while we check
      await db.update(organizations)
        .set({ domainVerificationStatus: "pending", domainVerificationError: null })
        .where(eq(organizations.id, org.id));
      try {
        const cnames = await dns.promises.resolveCname(org.customDomain);
        // Check if any resolved CNAME points to the expected target
        const matched = cnames.some((c) =>
          c.toLowerCase().replace(/\.$/, "") === expectedTarget.toLowerCase()
        );
        if (matched) {
          await db.update(organizations)
            .set({
              domainVerificationStatus: "verified",
              domainVerifiedAt: new Date(),
              domainVerificationError: null,
            })
            .where(eq(organizations.id, org.id));
          const sslStatus = await checkSsl(org.customDomain);
          return { status: "verified" as const, cnames, sslStatus };
        } else {
          const errorMsg = `CNAME resolves to [${cnames.join(", ")}] but expected ${expectedTarget}`;
          await db.update(organizations)
            .set({ domainVerificationStatus: "failed", domainVerificationError: errorMsg })
            .where(eq(organizations.id, org.id));
          return { status: "failed" as const, cnames, expected: expectedTarget, error: errorMsg, sslStatus: "pending" as const };
        }
      } catch (err: any) {
        const errorMsg = err.code === "ENOTFOUND" || err.code === "ENODATA"
          ? `No CNAME record found for ${org.customDomain}. Make sure you've added the CNAME record and DNS has propagated.`
          : `DNS lookup failed: ${err.message}`;
        await db.update(organizations)
          .set({ domainVerificationStatus: "failed", domainVerificationError: errorMsg })
          .where(eq(organizations.id, org.id));
        return { status: "failed" as const, cnames: [], expected: expectedTarget, error: errorMsg, sslStatus: "pending" as const };
      }
    }),

    // ── SEO & Custom CSS procedures ────────────────────────────────────────────
    updateSeo: orgAdminProcedure
      .input(z.object({
        orgId: z.number(),
        seoTitle: z.string().max(60).optional().nullable(),
        seoDescription: z.string().max(160).optional().nullable(),
        seoKeywords: z.string().max(500).optional().nullable(),
        seoOgImageUrl: z.string().url().optional().nullable(),
        seoRobotsIndex: z.boolean().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        // Verify the user has access to this org
        const member = await db.select().from(orgMembers)
          .where(eq(orgMembers.orgId, input.orgId))
          .limit(1);
        const isSiteAdmin = ctx.user.role === "site_owner" || ctx.user.role === "site_admin";
        if (!isSiteAdmin && !member.find((m) => m.userId === ctx.user.id)) {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
        await db.update(organizations)
          .set({
            ...(input.seoTitle !== undefined && { seoTitle: input.seoTitle }),
            ...(input.seoDescription !== undefined && { seoDescription: input.seoDescription }),
            ...(input.seoKeywords !== undefined && { seoKeywords: input.seoKeywords }),
            ...(input.seoOgImageUrl !== undefined && { seoOgImageUrl: input.seoOgImageUrl }),
            ...(input.seoRobotsIndex !== undefined && { seoRobotsIndex: input.seoRobotsIndex }),
          })
          .where(eq(organizations.id, input.orgId));
        return { success: true };
      }),

    uploadSeoOgImage: orgAdminProcedure
      .input(z.object({ orgId: z.number(), base64: z.string(), mimeType: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const isSiteAdmin = ctx.user.role === "site_owner" || ctx.user.role === "site_admin";
        if (!isSiteAdmin) {
          const member = await db.select().from(orgMembers)
            .where(eq(orgMembers.orgId, input.orgId)).limit(1);
          if (!member.find((m) => m.userId === ctx.user.id)) throw new TRPCError({ code: "FORBIDDEN" });
        }
        const buffer = Buffer.from(input.base64, "base64");
        const ext = input.mimeType === "image/png" ? "png" : input.mimeType === "image/webp" ? "webp" : "jpg";
        const key = `org-${input.orgId}/seo-og-${Date.now()}.${ext}`;
        const { url } = await storagePut(key, buffer, input.mimeType);
        await db.update(organizations).set({ seoOgImageUrl: url }).where(eq(organizations.id, input.orgId));
        return { url };
      }),

    updateCustomCss: orgAdminProcedure
      .input(z.object({ orgId: z.number(), customCss: z.string().max(50000) }))
      .mutation(async ({ ctx, input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const isSiteAdmin = ctx.user.role === "site_owner" || ctx.user.role === "site_admin";
        if (!isSiteAdmin) {
          const member = await db.select().from(orgMembers)
            .where(eq(orgMembers.orgId, input.orgId)).limit(1);
          if (!member.find((m) => m.userId === ctx.user.id)) throw new TRPCError({ code: "FORBIDDEN" });
        }
        await db.update(organizations)
          .set({ customCss: input.customCss || null })
          .where(eq(organizations.id, input.orgId));
        return { success: true };
      }),

    // ── Landing Page procedures ────────────────────────────────────────────
    // Get landing page for an org by slug (public)
    getLandingPage: publicProcedure
      .input(z.object({ slug: z.string() }))
      .query(async ({ input }) => {
        const db = await getDb();
        if (!db) return null;
        const org = await getOrgBySlug(input.slug);
        if (!org) return null;
        const rows = await db
          .select()
          .from(orgLandingPages)
          .where(eq(orgLandingPages.orgId, org.id))
          .limit(1);
        return rows[0] ? { ...rows[0], org } : null;
      }),

    // Save / update landing page (org admin only)
    saveLandingPage: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        heroHeadline: z.string().max(255).optional(),
        heroSubheadline: z.string().optional(),
        heroCtaText: z.string().max(100).optional(),
        heroCtaUrl: z.string().max(512).optional(),
        heroBgColor: z.string().max(32).optional(),
        heroTextColor: z.string().max(32).optional(),
        aboutTitle: z.string().max(255).optional(),
        aboutBody: z.string().optional(),
        features: z.string().optional(), // JSON
        accentColor: z.string().max(32).optional(),
        showCourses: z.boolean().optional(),
        isPublished: z.boolean().optional(),
        footerText: z.string().optional(),
        blocksJson: z.string().optional(), // WYSIWYG canvas blocks JSON
      }))
      .mutation(async ({ input, ctx }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        // Verify user is admin of this org
        const member = await getOrgMember(input.orgId, ctx.user.id);
        const isOrgAdmin = member && (member.role === "org_admin" || member.role === "org_super_admin");
        const isSiteAdmin = ctx.user.role === "site_owner" || ctx.user.role === "site_admin";
        if (!isOrgAdmin && !isSiteAdmin) throw new TRPCError({ code: "FORBIDDEN" });
        const { orgId, ...fields } = input;
        // Upsert: insert if not exists, update if exists
        const existing = await db.select({ id: orgLandingPages.id }).from(orgLandingPages).where(eq(orgLandingPages.orgId, orgId)).limit(1);
        if (existing.length) {
          await db.update(orgLandingPages).set({ ...fields, updatedAt: new Date() }).where(eq(orgLandingPages.orgId, orgId));
        } else {
          await db.insert(orgLandingPages).values({ orgId, ...fields });
        }
        return { success: true };
      }),

    create: adminProcedure
      .input(z.object({ name: z.string().min(1), slug: z.string().min(1), description: z.string().optional() }))
      .mutation(async ({ input, ctx }) => {
        const existing = await getOrgBySlug(input.slug);
        if (existing) throw new TRPCError({ code: "CONFLICT", message: "Slug already in use" });
        await createOrg({ ...input, ownerId: ctx.user.id });
        const org = await getOrgBySlug(input.slug);
        if (org) {
          await addOrgMember(org.id, ctx.user.id, "org_admin");
          // Auto-enroll the org admin in the Teachific school (slug='teach')
          try {
            const teachOrg = await getOrgBySlug("teach");
            if (teachOrg && teachOrg.id !== org.id) {
              await addOrgMember(teachOrg.id, ctx.user.id, "member");
            }
          } catch (_e) { /* non-fatal */ }
          // Auto-seed landing page on org creation with Teachific teal branding
          const db = await getDb();
          if (db) {
            const defaultBlocks = JSON.stringify([
              {
                id: "banner-1",
                type: "banner",
                visible: true,
                data: {
                  headline: `Welcome to ${org.name}`,
                  subheadline: org.description || "Explore our courses and start learning today.",
                  ctaText: "Browse Courses",
                  ctaUrl: "#courses",
                  ctaSecondaryText: "",
                  ctaSecondaryUrl: "",
                  backgroundColor: "#0f2942",
                  textColor: "#ffffff",
                  ctaBgColor: "#0ea5e9",
                  ctaTextColor: "#ffffff",
                  alignment: "center",
                  backgroundType: "color",
                  backgroundImageUrl: "",
                  overlay: false,
                  overlayOpacity: 0.5,
                  minHeight: 500,
                },
              },
              {
                id: "feature-1",
                type: "feature_grid",
                visible: true,
                data: {
                  headline: `Why Choose ${org.name}`,
                  subheadline: "Everything you need to learn and grow.",
                  columns: 3,
                  features: [
                    { id: "f1", icon: "BookOpen", title: "Expert Content", description: "Courses created by industry professionals." },
                    { id: "f2", icon: "Award", title: "Earn Certificates", description: "Get recognized for your achievements." },
                    { id: "f3", icon: "Users", title: "Community", description: "Learn alongside a supportive community." },
                  ],
                  backgroundColor: "#ffffff",
                  textColor: "#1e293b",
                  accentColor: "#0ea5e9",
                },
              },
              {
                id: "courses-1",
                type: "course_outline",
                visible: true,
                data: {
                  headline: "Our Courses",
                  subheadline: "Start your learning journey today.",
                  backgroundColor: "#f8fafc",
                  textColor: "#1e293b",
                  accentColor: "#0ea5e9",
                },
              },
              {
                id: "cta-1",
                type: "cta",
                visible: true,
                data: {
                  headline: "Ready to get started?",
                  subtext: "Join thousands of learners already on the platform.",
                  ctaText: "Enroll Now",
                  ctaUrl: "#courses",
                  backgroundType: "color",
                  backgroundColor: "#0ea5e9",
                  textColor: "#ffffff",
                  alignment: "center",
                  overlay: false,
                  overlayOpacity: 0.5,
                },
              },
            ]);
            await db.insert(orgLandingPages).values({
              orgId: org.id,
              heroHeadline: `Welcome to ${org.name}`,
              heroSubheadline: org.description || `Explore our courses and start learning today.`,
              heroCtaText: "Browse Courses",
              heroBgColor: "#0f2942",
              heroTextColor: "#ffffff",
              accentColor: "#0ea5e9",
              showCourses: true,
              isPublished: true,
              aboutTitle: `About ${org.name}`,
              aboutBody: org.description || `We offer high-quality online courses designed to help you grow.`,
              footerText: `© ${new Date().getFullYear()} ${org.name}. All rights reserved.`,
              blocksJson: defaultBlocks,
            }).onDuplicateKeyUpdate({ set: { updatedAt: new Date() } });
          }
        }
        return org;
      }),

    update: adminProcedure
      .input(z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        slug: z.string().min(1).optional(),
        description: z.string().optional(),
        adminNotes: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        await updateOrg(id, data);
        return { success: true };
      }),

    delete: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await deleteOrg(input.id);
        return { success: true };
      }),

    // Get and update legal documents (Terms of Service, Privacy Policy)
    getLegalDocs: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
        const rows = await db.select({ org: organizations, role: orgMembers.role })
          .from(orgMembers).innerJoin(organizations, eq(orgMembers.orgId, organizations.id))
          .where(eq(orgMembers.userId, ctx.user.id)).limit(1);
        const org = rows.find(r => r.org.id === input.orgId)?.org;
        if (!org && ctx.user.role !== 'site_owner' && ctx.user.role !== 'site_admin') {
          throw new TRPCError({ code: 'FORBIDDEN' });
        }
        const target = org ?? await getOrgById(input.orgId);
        return { termsOfService: target?.termsOfService ?? '', privacyPolicy: target?.privacyPolicy ?? '', requireTermsAgreement: target?.requireTermsAgreement ?? false, footerLinks: target?.footerLinks ?? '' };
      }),
    updateLegalDocs: protectedProcedure
      .input(z.object({ orgId: z.number(), termsOfService: z.string().optional(), privacyPolicy: z.string().optional(), requireTermsAgreement: z.boolean().optional(), footerLinks: z.string().optional() }))
      .mutation(async ({ input, ctx }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
        const rows = await db.select({ org: organizations, role: orgMembers.role })
          .from(orgMembers).innerJoin(organizations, eq(orgMembers.orgId, organizations.id))
          .where(eq(orgMembers.userId, ctx.user.id)).limit(1);
        const row = rows.find(r => r.org.id === input.orgId);
        if (!row && ctx.user.role !== 'site_owner' && ctx.user.role !== 'site_admin') {
          throw new TRPCError({ code: 'FORBIDDEN' });
        }
        if (row && row.role !== 'org_admin' && row.role !== 'org_super_admin' && ctx.user.role !== 'site_owner' && ctx.user.role !== 'site_admin' && ctx.user.role !== 'org_super_admin') {
          throw new TRPCError({ code: 'FORBIDDEN' });
        }
        const { orgId, ...data } = input;
        await updateOrg(orgId, data);
        return { success: true };
      }),
    // Public endpoint: fetch legal docs for checkout display (no auth required)
    publicLegalDocs: publicProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input }) => {
        const org = await getOrgById(input.orgId);
        if (!org) return { termsOfService: '', privacyPolicy: '', requireTermsAgreement: false };
        return { termsOfService: org.termsOfService ?? '', privacyPolicy: org.privacyPolicy ?? '', requireTermsAgreement: org.requireTermsAgreement ?? false, footerLinks: org.footerLinks ?? '' };
      }),
    // Public endpoint: fetch legal docs by org slug (for school storefront footer, no auth required)
    publicLegalDocsBySlug: publicProcedure
      .input(z.object({ slug: z.string() }))
      .query(async ({ input }) => {
        const org = await getOrgBySlug(input.slug);
        if (!org) return { termsOfService: '', privacyPolicy: '', requireTermsAgreement: false, orgId: null as number | null, orgName: '' };
        return { termsOfService: org.termsOfService ?? '', privacyPolicy: org.privacyPolicy ?? '', requireTermsAgreement: org.requireTermsAgreement ?? false, orgId: org.id, orgName: org.name, footerLinks: org.footerLinks ?? '' };
      }),
    // Public endpoint: fetch school/org info by slug (for storefront, no auth required)
    publicSchoolBySlug: publicProcedure
      .input(z.object({ slug: z.string() }))
      .query(async ({ input }) => {
        const org = await getOrgBySlug(input.slug);
        if (!org) return null;
        return { id: org.id, name: org.name, slug: org.slug, description: (org as any).description ?? '' };
      }),
    // Storage usage for the user's primary org
    storageUsage: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        // Allow org members, org admins, and site admins
        const member = await getOrgMember(input.orgId, ctx.user.id);
        if (!member && ctx.user.role !== 'site_owner' && ctx.user.role !== 'site_admin') {
          throw new TRPCError({ code: 'FORBIDDEN' });
        }
        return getOrgStorageUsage(input.orgId);
      }),
    members: router({
      list: protectedProcedure.input(z.object({ orgId: z.number() })).query(async ({ input, ctx }) => {
        const members = await getOrgMembers(input.orgId);
        const users = await Promise.all(members.map((m) => getUserById(m.userId)));
        return members.map((m, i) => ({ ...m, user: users[i] }));
      }),
      add: adminProcedure
        .input(z.object({ orgId: z.number(), userId: z.number(), role: z.enum(["org_admin", "user"]) }))
        .mutation(({ input, ctx }) => addOrgMember(input.orgId, input.userId, input.role, ctx.user.id)),
      remove: adminProcedure
        .input(z.object({ orgId: z.number(), userId: z.number() }))
        .mutation(({ input }) => removeOrgMember(input.orgId, input.userId)),
      updateRole: adminProcedure
        .input(z.object({ orgId: z.number(), userId: z.number(), role: z.enum(["org_admin", "user"]) }))
        .mutation(({ input }) => updateOrgMemberRole(input.orgId, input.userId, input.role)),
      // Org-admin accessible updateRole — org admins can change member roles within their org
      updateMemberRole: orgAdminProcedure
        .input(z.object({
          orgId: z.number(),
          userId: z.number(),
          role: z.enum(["org_super_admin", "org_admin", "member", "user"]),
        }))
        .mutation(async ({ input, ctx }) => {
          if (ctx.user.role !== "site_owner" && ctx.user.role !== "site_admin") {
            const membership = await getOrgMember(input.orgId, ctx.user.id);
            if (!membership || (membership.role !== "org_admin" && membership.role !== "org_super_admin")) {
              throw new TRPCError({ code: "FORBIDDEN" });
            }
            if (input.role === "org_super_admin" && membership.role !== "org_super_admin") {
              throw new TRPCError({ code: "FORBIDDEN", message: "Only org super admins can assign the org_super_admin role" });
            }
          }
          const db2 = await getDb();
          if (!db2) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
          const { and: andOp } = await import("drizzle-orm");
          await db2.update(orgMembers).set({ role: input.role }).where(
            andOp(eq(orgMembers.orgId, input.orgId), eq(orgMembers.userId, input.userId))
          );
          return { success: true };
        }),
      // Org-admin accessible remove member
      removeMember: orgAdminProcedure
        .input(z.object({ orgId: z.number(), userId: z.number() }))
        .mutation(async ({ input, ctx }) => {
          if (ctx.user.role !== "site_owner" && ctx.user.role !== "site_admin") {
            const membership = await getOrgMember(input.orgId, ctx.user.id);
            if (!membership || (membership.role !== "org_admin" && membership.role !== "org_super_admin")) {
              throw new TRPCError({ code: "FORBIDDEN" });
            }
          }
          await removeOrgMember(input.orgId, input.userId);
          return { success: true };
        }),

      // Returns org members enriched with user data and course enrollments
      listWithEnrollments: orgAdminProcedure
        .input(z.object({ orgId: z.number() }))
        .query(async ({ input, ctx }) => {
          if (ctx.user.role !== "site_owner" && ctx.user.role !== "site_admin") {
            const membership = await getOrgMember(input.orgId, ctx.user.id);
            if (!membership) throw new TRPCError({ code: "FORBIDDEN" });
          }
          const db2 = await getDb();
          if (!db2) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
          const { inArray, and: andOp, desc: descOp } = await import("drizzle-orm");
          const { courses: coursesTable } = await import("../drizzle/schema");

          const members = await db2
            .select({ member: orgMembers, user: users })
            .from(orgMembers)
            .innerJoin(users, eq(orgMembers.userId, users.id))
            .where(eq(orgMembers.orgId, input.orgId));

          if (!members.length) return [];
          const userIds = members.map(m => m.user.id);

          const enrollments = await db2
            .select({ enrollment: courseEnrollments, course: coursesTable })
            .from(courseEnrollments)
            .innerJoin(coursesTable, eq(courseEnrollments.courseId, coursesTable.id))
            .where(andOp(inArray(courseEnrollments.userId, userIds), eq(courseEnrollments.orgId, input.orgId)))
            .orderBy(descOp(courseEnrollments.enrolledAt));

          return members.map(({ member, user }) => ({
            id: member.id,
            userId: user.id,
            orgId: input.orgId,
            role: member.role,
            joinedAt: member.joinedAt,
            user: {
              id: user.id,
              name: user.name,
              email: user.email,
              loginMethod: user.loginMethod,
              createdAt: user.createdAt,
            },
            enrollments: enrollments
              .filter(e => e.enrollment.userId === user.id)
              .map(e => ({
                id: e.enrollment.id,
                courseId: e.enrollment.courseId,
                courseName: e.course.title,
                progressPct: e.enrollment.progressPct ?? 0,
                isActive: e.enrollment.isActive,
                enrolledAt: e.enrollment.enrolledAt,
                completedAt: e.enrollment.completedAt,
              })),
          }));
        }),

      // Create a new email/password user and add them to the org
      createAndAdd: orgAdminProcedure
        .input(z.object({
          orgId: z.number(),
          name: z.string().min(1),
          email: z.string().email(),
          password: z.string().min(6),
          role: z.enum(["org_admin", "user"]).default("user"),
          courseIds: z.array(z.number()).optional(),
        }))
        .mutation(async ({ input, ctx }) => {
          if (ctx.user.role !== "site_owner" && ctx.user.role !== "site_admin") {
            const membership = await getOrgMember(input.orgId, ctx.user.id);
            if (!membership) throw new TRPCError({ code: "FORBIDDEN" });
          }
          const existing = await getUserByEmail(input.email);
          let userId: number;
          if (existing) {
            userId = existing.id;
            const existingMember = await getOrgMember(input.orgId, existing.id);
            if (!existingMember) {
              await addOrgMember(input.orgId, existing.id, input.role === "org_admin" ? "org_admin" : "member", ctx.user.id);
            }
          } else {
            const bcrypt = await import("bcryptjs");
            const passwordHash = await bcrypt.default.hash(input.password, 10);
            const openId = `manual_${nanoid(20)}`;
            await createManualUser({ openId, name: input.name, email: input.email, loginMethod: "email", role: "user", passwordHash });
            const newUser = await getUserByEmail(input.email);
            if (!newUser) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
            userId = newUser.id;
            await addOrgMember(input.orgId, userId, input.role === "org_admin" ? "org_admin" : "member", ctx.user.id);
          }
          if (input.courseIds?.length) {
            const { getEnrollment: getEnr } = await import("./lmsDb");
            for (const courseId of input.courseIds) {
              const enr = await getEnr(courseId, userId);
              if (!enr) await createEnrollment({ userId, courseId, orgId: input.orgId, isActive: true, progressPct: 0, certificateIssued: false });
            }
          }
          return { success: true, userId };
        }),

      // Manually enroll an existing org member in a course
      manualEnroll: orgAdminProcedure
        .input(z.object({
          orgId: z.number(),
          userId: z.number(),
          courseId: z.number(),
        }))
        .mutation(async ({ input, ctx }) => {
          if (ctx.user.role !== "site_owner" && ctx.user.role !== "site_admin") {
            const membership = await getOrgMember(input.orgId, ctx.user.id);
            if (!membership) throw new TRPCError({ code: "FORBIDDEN" });
          }
          const { getEnrollment: getEnr } = await import("./lmsDb");
          const existing = await getEnr(input.courseId, input.userId);
          if (existing) {
            const db2 = await getDb();
            if (db2 && !existing.isActive) {
              await db2.update(courseEnrollments).set({ isActive: true }).where(eq(courseEnrollments.id, existing.id));
            }
            return { success: true, enrollmentId: existing.id };
          }
          const enrollment = await createEnrollment({ userId: input.userId, courseId: input.courseId, orgId: input.orgId, isActive: true, progressPct: 0, certificateIssued: false });
          return { success: true, enrollmentId: enrollment?.id };
        }),

      // Bulk import members from CSV data
      bulkImport: orgAdminProcedure
        .input(z.object({
          orgId: z.number(),
          users: z.array(z.object({
            name: z.string(),
            email: z.string().email(),
            password: z.string().optional(),
            role: z.enum(["org_admin", "user"]).default("user"),
          })),
        }))
        .mutation(async ({ input, ctx }) => {
          if (ctx.user.role !== "site_owner" && ctx.user.role !== "site_admin") {
            const membership = await getOrgMember(input.orgId, ctx.user.id);
            if (!membership) throw new TRPCError({ code: "FORBIDDEN" });
          }
          let created = 0, updated = 0, failed = 0;
          const errors: string[] = [];
          const bcrypt = await import("bcryptjs");
          for (const u of input.users) {
            try {
              const existing = await getUserByEmail(u.email);
              if (existing) {
                const existingMember = await getOrgMember(input.orgId, existing.id);
                if (!existingMember) await addOrgMember(input.orgId, existing.id, u.role === "org_admin" ? "org_admin" : "member", ctx.user.id);
                updated++;
              } else {
                const password = u.password || nanoid(12);
                const passwordHash = await bcrypt.default.hash(password, 10);
                const openId = `manual_${nanoid(20)}`;
                await createManualUser({ openId, name: u.name, email: u.email, loginMethod: "email", role: "user", passwordHash });
                const newUser = await getUserByEmail(u.email);
                if (!newUser) throw new Error("Failed to create user");
                await addOrgMember(input.orgId, newUser.id, u.role === "org_admin" ? "org_admin" : "member", ctx.user.id);
                created++;
              }
            } catch (e: any) { failed++; errors.push(`${u.email}: ${e.message}`); }
          }
          return { total: input.users.length, created, updated, failed, errors };
        }),
    }),
  }),

  // ── Content Packages ──────────────────────────────────────────────────────
  packages: router({
    list: protectedProcedure
      .input(z.object({ orgId: z.number().optional() }).optional())
      .query(async ({ input, ctx }) => {
        // Site-wide roles: see everything (or filter by explicit orgId)
        if (ctx.user.role === "site_owner" || ctx.user.role === "site_admin") {
          return input?.orgId ? getPackagesByOrg(input.orgId) : getAllPackages();
        }
        // org_admin / org_super_admin: always scoped to their assigned org only
        if (ctx.user.role === "org_admin" || ctx.user.role === "org_super_admin") {
          const orgId = await getOrgIdForUser(ctx.user.id);
          if (!orgId) return [];
          return getPackagesByOrg(orgId);
        }
        // Regular users: see packages from their orgs
        const orgs = await getOrgsByUserId(ctx.user.id);
        const orgIds = orgs.map((o) => o.id);
        if (input?.orgId && orgIds.includes(input.orgId)) return getPackagesByOrg(input.orgId);
        const allPkgs = await Promise.all(orgIds.map((id) => getPackagesByOrg(id)));
        return allPkgs.flat();
      }),

    get: publicProcedure.input(z.object({ id: z.number() })).query(async ({ input, ctx }) => {
      const pkg = await getPackageById(input.id);
      if (!pkg) throw new TRPCError({ code: "NOT_FOUND" });
      // Private packages require authentication
      if (!pkg.isPublic && !ctx.user) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "This content is private. Please sign in to access it." });
      }
      return pkg;
    }),

    create: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        title: z.string().min(1),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        originalZipKey: z.string(),
        originalZipUrl: z.string(),
        originalZipSize: z.number().optional(),
        contentType: z.enum(["scorm", "html", "articulate", "ispring", "unknown"]).optional(),
        scormVersion: z.enum(["1.2", "2004", "none"]).optional(),
        scormEntryPoint: z.string().optional(),
        displayMode: z.enum(["native", "lms_shell", "quiz"]).default("native"),
        lmsShellConfig: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        await createPackage({
          orgId: input.orgId,
          uploadedBy: ctx.user.id,
          title: input.title,
          description: input.description,
          tags: JSON.stringify(input.tags ?? []),
          originalZipKey: input.originalZipKey,
          originalZipUrl: input.originalZipUrl,
          originalZipSize: input.originalZipSize ?? 0,
          contentType: input.contentType ?? "unknown",
          scormVersion: input.scormVersion ?? "none",
          scormEntryPoint: input.scormEntryPoint,
          displayMode: input.displayMode,
          lmsShellConfig: input.lmsShellConfig,
          status: "uploading",
        });
        const pkgs = await getPackagesByOrg(input.orgId);
        return pkgs[0];
      }),

    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        title: z.string().optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        displayMode: z.enum(["native", "lms_shell", "quiz"]).optional(),
        lmsShellConfig: z.string().optional(),
        isPublic: z.boolean().optional(),
        autoFullscreenMobile: z.boolean().optional(),
        status: z.enum(["uploading", "processing", "ready", "error"]).optional(),
        scormVersion: z.enum(["1.2", "2004", "none"]).optional(),
        scormEntryPoint: z.string().optional(),
        scormManifest: z.string().optional(),
        contentType: z.enum(["scorm", "html", "articulate", "ispring", "unknown"]).optional(),
        llmSummary: z.string().optional(),
        llmTags: z.string().optional(),
        llmValidationNotes: z.string().optional(),
        extractedFolderKey: z.string().optional(),
        currentVersionId: z.number().optional(),
        processingError: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const { id, tags, ...rest } = input;
        await updatePackage(id, {
          ...rest,
          ...(tags !== undefined ? { tags: JSON.stringify(tags) } : {}),
        });
        return getPackageById(id);
      }),

    delete: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(({ input }) => deletePackage(input.id)),

    // LLM analysis of an uploaded package
    analyze: protectedProcedure
      .input(z.object({
        packageId: z.number(),
        fileList: z.array(z.string()),
        manifestXml: z.string().optional(),
        sampleHtml: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const prompt = `You are an expert eLearning content analyst. Analyze the following SCORM/HTML content package and provide:
1. A concise description (2-3 sentences) of what this course covers
2. 5-8 relevant tags (single words or short phrases)
3. SCORM compliance validation notes
4. Detected content structure (number of modules, quiz presence, etc.)

File list (first 30): ${input.fileList.slice(0, 30).join(", ")}
${input.manifestXml ? `\nSCORM Manifest (excerpt):\n${input.manifestXml.slice(0, 2000)}` : ""}
${input.sampleHtml ? `\nSample HTML content:\n${input.sampleHtml.slice(0, 1000)}` : ""}

Respond in JSON format: { "description": "...", "tags": [...], "validationNotes": "...", "structure": "..." }`;

        try {
          const response = await invokeLLM({
            messages: [
              { role: "system", content: "You are an eLearning content analyst. Always respond with valid JSON." },
              { role: "user", content: prompt },
            ],
            response_format: { type: "json_object" } as Parameters<typeof invokeLLM>[0]["response_format"],
          });
          const content = response?.choices?.[0]?.message?.content ?? "{}";
          const parsed = JSON.parse(typeof content === "string" ? content : JSON.stringify(content));
          await updatePackage(input.packageId, {
            llmSummary: parsed.description ?? "",
            llmTags: JSON.stringify(parsed.tags ?? []),
            llmValidationNotes: `${parsed.validationNotes ?? ""}\n\nStructure: ${parsed.structure ?? ""}`.trim(),
          });
          return parsed;
        } catch (err) {
          console.error("[LLM Analysis] Failed:", err);
          return { description: "", tags: [], validationNotes: "Analysis unavailable", structure: "" };
        }
      }),

    // Extract questions from SCORM/HTML using LLM
    extractQuestions: protectedProcedure
      .input(z.object({
        packageId: z.number(),
        htmlContent: z.string(),
        orgId: z.number(),
      }))
      .mutation(async ({ input, ctx }) => {
        const prompt = `Extract all quiz questions from the following HTML content. For each question identify:
- The question text
- Question type (multiple_choice, true_false, short_answer, matching, multiple_select)
- All answer choices
- Which answer(s) are correct
- Any explanation/rationale provided

HTML Content:
${input.htmlContent.slice(0, 6000)}

Respond in JSON: { "questions": [{ "questionText": "...", "questionType": "multiple_choice", "choices": [{ "text": "...", "isCorrect": true/false }], "explanation": "..." }] }`;

        try {
          const response = await invokeLLM({
            messages: [
              { role: "system", content: "You are an expert at extracting quiz questions from educational HTML content. Always respond with valid JSON." },
              { role: "user", content: prompt },
            ],
            response_format: { type: "json_object" } as Parameters<typeof invokeLLM>[0]["response_format"],
          });
          const content = response?.choices?.[0]?.message?.content ?? "{}";
          const parsed = JSON.parse(typeof content === "string" ? content : JSON.stringify(content));
          return { questions: parsed.questions ?? [] };
        } catch (err) {
          console.error("[Question Extraction] Failed:", err);
          return { questions: [] };
        }
      }),
  }),

  // ── Versions ──────────────────────────────────────────────────────────────
  versions: router({
    list: protectedProcedure
      .input(z.object({ packageId: z.number() }))
      .query(({ input }) => getVersionsByPackage(input.packageId)),

    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(({ input }) => getVersionById(input.id)),

    create: protectedProcedure
      .input(z.object({
        packageId: z.number(),
        versionLabel: z.string().optional(),
        changelog: z.string().optional(),
        zipKey: z.string(),
        zipUrl: z.string(),
        zipSize: z.number().optional(),
        extractedFolderKey: z.string().optional(),
        entryPoint: z.string().optional(),
        fileCount: z.number().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        // Mark the currently active version as replaced
        const pkg = await getPackageById(input.packageId);
        if (pkg?.currentVersionId) {
          await setVersionReplacedAt(pkg.currentVersionId, new Date());
        }
        const latestNum = await getLatestVersionNumber(input.packageId);
        await createVersion({
          ...input,
          versionNumber: latestNum + 1,
          uploadedBy: ctx.user.id,
          zipSize: input.zipSize ?? 0,
          fileCount: input.fileCount ?? 0,
        });
        const versions = await getVersionsByPackage(input.packageId);
        const newVersion = versions[0];
        if (newVersion) {
          await updatePackage(input.packageId, { currentVersionId: newVersion.id });
        }
        return newVersion;
      }),

    restore: protectedProcedure
      .input(z.object({ packageId: z.number(), versionId: z.number() }))
      .mutation(async ({ input }) => {
        const pkg = await getPackageById(input.packageId);
        // Mark the currently active version as replaced (now)
        if (pkg?.currentVersionId && pkg.currentVersionId !== input.versionId) {
          await setVersionReplacedAt(pkg.currentVersionId, new Date());
        }
        // Restore the target version: clear its replacedAt and set as current
        await setVersionReplacedAt(input.versionId, null);
        await updatePackage(input.packageId, { currentVersionId: input.versionId });
        return { success: true };
      }),

    purgeExpired: protectedProcedure
      .input(z.object({ packageId: z.number() }))
      .mutation(async ({ input }) => {
        const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
        const cutoff = new Date(Date.now() - THIRTY_DAYS_MS);
        const versions = await getVersionsByPackage(input.packageId);
        const expired = versions.filter(
          (v) => v.replacedAt !== null && v.replacedAt !== undefined && new Date(v.replacedAt) < cutoff
        );
        for (const v of expired) {
          await deleteVersionAssets(v.id);
        }
        return { deleted: expired.length };
      }),

    assets: protectedProcedure
      .input(z.object({ versionId: z.number() }))
      .query(({ input }) => getFileAssetsByVersion(input.versionId)),

    entryPoint: protectedProcedure
      .input(z.object({ versionId: z.number() }))
      .query(({ input }) => getEntryPointAsset(input.versionId)),
  }),

  // ── Permissions ───────────────────────────────────────────────────────────
  permissions: router({
    get: publicProcedure
      .input(z.object({ packageId: z.number() }))
      .query(({ input }) => getPermissions(input.packageId)),

    update: adminProcedure
      .input(z.object({
        packageId: z.number(),
        allowDownload: z.boolean().optional(),
        downloadRequiresAuth: z.boolean().optional(),
        maxPlaysPerUser: z.number().nullable().optional(),
        maxTotalPlays: z.number().nullable().optional(),
        playExpiresAt: z.date().nullable().optional(),
        allowEmbed: z.boolean().optional(),
        allowedEmbedDomains: z.array(z.string()).optional(),
        allowExternalLinks: z.boolean().optional(),
        requiresAuth: z.boolean().optional(),
        allowedOrgIds: z.array(z.number()).optional(),
        allowedUserIds: z.array(z.number()).optional(),
      }))
      .mutation(async ({ input }) => {
        const { packageId, allowedEmbedDomains, allowedOrgIds, allowedUserIds, ...rest } = input;
        const existing = await getPermissions(packageId);
        if (!existing) await createPermissions(packageId);
        await updatePermissions(packageId, {
          ...rest,
          ...(allowedEmbedDomains !== undefined ? { allowedEmbedDomains: JSON.stringify(allowedEmbedDomains) } : {}),
          ...(allowedOrgIds !== undefined ? { allowedOrgIds: JSON.stringify(allowedOrgIds) } : {}),
          ...(allowedUserIds !== undefined ? { allowedUserIds: JSON.stringify(allowedUserIds) } : {}),
        });
        return getPermissions(packageId);
      }),

    generateShareToken: adminProcedure
      .input(z.object({ packageId: z.number(), expiresInDays: z.number().optional() }))
      .mutation(async ({ input }) => {
        const token = nanoid(32);
        const expiresAt = input.expiresInDays
          ? new Date(Date.now() + input.expiresInDays * 86400000)
          : null;
        await updatePermissions(input.packageId, {
          shareToken: token,
          shareTokenExpiresAt: expiresAt ?? undefined,
        });
        return { token };
      }),
  }),

  // ── Play Sessions ─────────────────────────────────────────────────────────
  sessions: router({
    start: publicProcedure
      .input(z.object({
        packageId: z.number(),
        versionId: z.number().optional(),
        orgId: z.number().optional(),
        // Dynamic URL learner identity params
        learnerName:  z.string().max(255).optional(),
        learnerEmail: z.string().max(320).optional(),
        learnerId:    z.string().max(128).optional(),
        learnerGroup: z.string().max(128).optional(),
        customData:   z.string().optional(),
        utmSource:    z.string().max(128).optional(),
        utmMedium:    z.string().max(128).optional(),
        utmCampaign:  z.string().max(128).optional(),
        referrer:     z.string().max(512).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const pkg = await getPackageById(input.packageId);
        if (!pkg) throw new TRPCError({ code: "NOT_FOUND" });

        // Private packages require authentication to start a session
        if (!pkg.isPublic && !ctx.user) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "This content is private. Please sign in to access it." });
        }

        const perms = await getPermissions(input.packageId);

        // Check play limits
        if (perms?.maxTotalPlays && pkg.totalPlayCount >= perms.maxTotalPlays) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Maximum total plays reached" });
        }
        if (perms?.maxPlaysPerUser && ctx.user) {
          const userCount = await getUserPlayCount(input.packageId, ctx.user.id);
          if (userCount >= perms.maxPlaysPerUser) {
            throw new TRPCError({ code: "FORBIDDEN", message: "You have reached the maximum number of plays" });
          }
        }
        if (perms?.playExpiresAt && new Date() > perms.playExpiresAt) {
          throw new TRPCError({ code: "FORBIDDEN", message: "This content has expired" });
        }

        const token = nanoid(32);
        await createPlaySession({
          packageId: input.packageId,
          versionId: input.versionId,
          userId: ctx.user?.id,
          orgId: input.orgId,
          sessionToken: token,
          ipAddress: ctx.req.headers["x-forwarded-for"] as string ?? ctx.req.socket?.remoteAddress,
          userAgent: ctx.req.headers["user-agent"],
          referrer: input.referrer,
          // Dynamic learner identity from URL params
          learnerName:  input.learnerName,
          learnerEmail: input.learnerEmail,
          learnerId:    input.learnerId,
          learnerGroup: input.learnerGroup,
          customData:   input.customData,
          utmSource:    input.utmSource,
          utmMedium:    input.utmMedium,
          utmCampaign:  input.utmCampaign,
        });

        await incrementPlayCount(input.packageId);
        await logAnalyticsEvent({
          packageId: input.packageId,
          userId: ctx.user?.id,
          orgId: input.orgId,
          eventType: "play_start",
          eventData: JSON.stringify({ versionId: input.versionId }),
        });

        return { sessionToken: token };
      }),

    end: publicProcedure
      .input(z.object({
        sessionToken: z.string(),
        durationSeconds: z.number().optional(),
        completionStatus: z.enum(["not_attempted", "incomplete", "completed", "passed", "failed", "unknown"]).optional(),
        scoreRaw: z.number().optional(),
        scoreMax: z.number().optional(),
        scoreMin: z.number().optional(),
        scoreScaled: z.number().optional(),
      }))
      .mutation(async ({ input }) => {
        const session = await getPlaySession(input.sessionToken);
        if (!session) throw new TRPCError({ code: "NOT_FOUND" });

        const isCompleted = input.completionStatus === "completed" || input.completionStatus === "passed";
        await updatePlaySession(input.sessionToken, {
          endedAt: new Date(),
          durationSeconds: input.durationSeconds,
          completionStatus: input.completionStatus,
          scoreRaw: input.scoreRaw,
          scoreMax: input.scoreMax,
          scoreMin: input.scoreMin,
          scoreScaled: input.scoreScaled,
          isCompleted,
        });

        if (isCompleted) {
          await logAnalyticsEvent({
            packageId: session.packageId,
            sessionId: session.id,
            userId: session.userId ?? undefined,
            orgId: session.orgId ?? undefined,
            eventType: "scorm_complete",
            eventData: JSON.stringify({ score: input.scoreRaw }),
          });
        }
        return { success: true };
      }),

    get: publicProcedure
      .input(z.object({ sessionToken: z.string() }))
      .query(({ input }) => getPlaySession(input.sessionToken)),

    listByPackage: protectedProcedure
      .input(z.object({ packageId: z.number(), limit: z.number().optional() }))
      .query(async ({ input, ctx }) => {
        // org_admin / org_super_admin: verify the package belongs to their org
        if (ctx.user.role === "org_admin" || ctx.user.role === "org_super_admin") {
          const orgId = await getOrgIdForUser(ctx.user.id);
          const pkg = await getPackageById(input.packageId);
          if (!pkg || pkg.orgId !== orgId) throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
        }
        return getPlaySessionsByPackage(input.packageId, input.limit ?? 200);
      }),
  }),

  // ── SCORM LMS API ─────────────────────────────────────────────────────────
  scorm: router({
    getData: publicProcedure
      .input(z.object({ sessionToken: z.string() }))
      .query(async ({ input }) => {
        const session = await getPlaySession(input.sessionToken);
        if (!session) throw new TRPCError({ code: "NOT_FOUND" });
        const data = await getScormData(session.id);
        return data ?? { cmiData: "{}", suspendData: "", lessonStatus: "not attempted", lessonLocation: "", score: null, totalTime: "" };
      }),

    setData: publicProcedure
      .input(z.object({
        sessionToken: z.string(),
        cmiData: z.string().optional(),
        suspendData: z.string().optional(),
        lessonStatus: z.string().optional(),
        lessonLocation: z.string().optional(),
        score: z.number().optional(),
        totalTime: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const session = await getPlaySession(input.sessionToken);
        if (!session) throw new TRPCError({ code: "NOT_FOUND" });
        const { sessionToken, ...data } = input;
        await upsertScormData(session.id, session.packageId, session.userId ?? undefined, data);
        await updatePlaySession(sessionToken, { lastActiveAt: new Date() });
        return { success: true };
      }),
  }),

  // ── Analytics ─────────────────────────────────────────────────────────────
  analytics: router({
    summary: protectedProcedure
      .input(z.object({ orgId: z.number().optional() }))
      .query(async ({ input, ctx }) => {
        // org_admin / org_super_admin: always scope to their assigned org
        if (ctx.user.role === "org_admin" || ctx.user.role === "org_super_admin") {
          const orgId = await getOrgIdForUser(ctx.user.id);
          return getAnalyticsSummary(orgId ?? undefined);
        }
        return getAnalyticsSummary(input.orgId);
      }),

    byPackage: protectedProcedure
      .input(z.object({ packageId: z.number() }))
      .query(async ({ input, ctx }) => {
        // org_admin / org_super_admin: verify the package belongs to their org before returning data
        if (ctx.user.role === "org_admin" || ctx.user.role === "org_super_admin") {
          const orgId = await getOrgIdForUser(ctx.user.id);
          const pkg = await getPackageById(input.packageId);
          if (!pkg || pkg.orgId !== orgId) throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
        }
        return getAnalyticsByPackage(input.packageId);
      }),

    byOrg: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(({ input }) => getAnalyticsByOrg(input.orgId)),

    logEvent: publicProcedure
      .input(z.object({
        packageId: z.number(),
        sessionId: z.number().optional(),
        orgId: z.number().optional(),
        eventType: z.enum(["play_start", "play_end", "play_pause", "play_resume", "download", "scorm_complete", "scorm_pass", "scorm_fail", "page_view", "link_click", "error"]),
        eventData: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        await logAnalyticsEvent({
          ...input,
          userId: ctx.user?.id,
          eventData: input.eventData,
        });
        return { success: true };
      }),

    trackDownload: protectedProcedure
      .input(z.object({ packageId: z.number(), orgId: z.number().optional() }))
      .mutation(async ({ input, ctx }) => {
        await incrementDownloadCount(input.packageId);
        await logAnalyticsEvent({
          packageId: input.packageId,
          userId: ctx.user.id,
          orgId: input.orgId,
          eventType: "download",
          eventData: JSON.stringify({}),
        });
        return { success: true };
      }),
  }),

  // ── Quizzes ───────────────────────────────────────────────────────────────
  quizzes: router({
    list: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(({ input }) => getQuizzesByOrg(input.orgId)),

    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        const quiz = await getQuizById(input.id);
        if (!quiz) throw new TRPCError({ code: "NOT_FOUND" });
        const questions = await getQuestionsByQuiz(input.id);
        const questionsWithChoices = await Promise.all(
          questions.map(async (q) => ({ ...q, choices: await getChoicesByQuestion(q.id) }))
        );
        return { ...quiz, questions: questionsWithChoices };
      }),

    create: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        packageId: z.number().optional(),
        title: z.string().min(1),
        description: z.string().optional(),
        instructions: z.string().optional(),
        passingScore: z.number().optional(),
        timeLimit: z.number().optional(),
        maxAttempts: z.number().optional(),
        shuffleQuestions: z.boolean().optional(),
        shuffleAnswers: z.boolean().optional(),
        showFeedbackImmediately: z.boolean().optional(),
        showCorrectAnswers: z.boolean().optional(),
      }))
      .mutation(({ input, ctx }) => createQuiz({ ...input, createdBy: ctx.user.id })),

    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        title: z.string().optional(),
        description: z.string().optional(),
        instructions: z.string().optional(),
        passingScore: z.number().optional(),
        timeLimit: z.number().nullable().optional(),
        maxAttempts: z.number().nullable().optional(),
        shuffleQuestions: z.boolean().optional(),
        shuffleAnswers: z.boolean().optional(),
        showFeedbackImmediately: z.boolean().optional(),
        showCorrectAnswers: z.boolean().optional(),
        isPublished: z.boolean().optional(),
      }))
      .mutation(({ input }) => {
        const { id, ...data } = input;
        return updateQuiz(id, data);
      }),

    delete: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(({ input }) => deleteQuiz(input.id)),

    questions: router({
      list: protectedProcedure
        .input(z.object({ quizId: z.number() }))
        .query(async ({ input }) => {
          const questions = await getQuestionsByQuiz(input.quizId);
          return Promise.all(questions.map(async (q) => ({ ...q, choices: await getChoicesByQuestion(q.id) })));
        }),

      upsert: protectedProcedure
        .input(z.object({
          quizId: z.number(),
          questions: z.array(z.object({
            id: z.number().optional(),
            sortOrder: z.number(),
            questionType: z.enum(["multiple_choice", "true_false", "short_answer", "matching", "multiple_select"]),
            questionText: z.string(),
            questionHtml: z.string().optional(),
            imageUrl: z.string().optional(),
            explanation: z.string().optional(),
            points: z.number().optional(),
            choices: z.array(z.object({
              id: z.number().optional(),
              sortOrder: z.number(),
              choiceText: z.string(),
              choiceHtml: z.string().optional(),
              isCorrect: z.boolean(),
              matchTarget: z.string().optional(),
            })).optional(),
          })),
        }))
        .mutation(async ({ input }) => {
          for (const q of input.questions) {
            let questionId = q.id;
            if (!questionId) {
              const newQ = await createQuestion({
                quizId: input.quizId,
                sortOrder: q.sortOrder,
                questionType: q.questionType,
                questionText: q.questionText,
                questionHtml: q.questionHtml,
                imageUrl: q.imageUrl,
                explanation: q.explanation,
                points: q.points ?? 1,
              });
              questionId = newQ.insertId;
            } else {
              await updateQuestion(questionId, {
                sortOrder: q.sortOrder,
                questionType: q.questionType,
                questionText: q.questionText,
                questionHtml: q.questionHtml,
                imageUrl: q.imageUrl,
                explanation: q.explanation,
                points: q.points ?? 1,
              });
            }
            if (q.choices && questionId) {
              await upsertChoices(questionId, q.choices);
            }
          }
          return getQuestionsByQuiz(input.quizId);
        }),

      delete: protectedProcedure
        .input(z.object({ id: z.number() }))
        .mutation(({ input }) => deleteQuestion(input.id)),
    }),

    attempts: router({
      start: protectedProcedure
        .input(z.object({ quizId: z.number(), packageId: z.number().optional(), orgId: z.number().optional() }))
        .mutation(async ({ input, ctx }) => {
          const existing = await getAttemptsByQuiz(input.quizId, ctx.user.id);
          const attemptNumber = existing.length + 1;
          return createAttempt({
            quizId: input.quizId,
            packageId: input.packageId,
            userId: ctx.user.id,
            orgId: input.orgId,
            attemptNumber,
          });
        }),

      saveResponse: protectedProcedure
        .input(z.object({
          attemptId: z.number(),
          questionId: z.number(),
          responseText: z.string().optional(),
          selectedChoiceIds: z.array(z.number()).optional(),
          timeTakenSeconds: z.number().optional(),
        }))
        .mutation(({ input }) => saveResponse({
          ...input,
          selectedChoiceIds: input.selectedChoiceIds ? JSON.stringify(input.selectedChoiceIds) : undefined,
        })),

      submit: protectedProcedure
        .input(z.object({ attemptId: z.number() }))
        .mutation(({ input }) => submitAttempt(input.attemptId)),

      get: protectedProcedure
        .input(z.object({ id: z.number() }))
        .query(async ({ input }) => {
          const attempt = await getAttemptById(input.id);
          if (!attempt) throw new TRPCError({ code: "NOT_FOUND" });
          const responses = await getResponsesByAttempt(input.id);
          return { ...attempt, responses };
        }),

      list: protectedProcedure
        .input(z.object({ quizId: z.number() }))
        .query(({ input, ctx }) => getAttemptsByQuiz(input.quizId, ctx.user.id)),
    }),

    analytics: protectedProcedure
      .input(z.object({ quizId: z.number() }))
      .query(({ input }) => getQuizAnalytics(input.quizId)),

    // XLS Export — returns base64-encoded XLSX buffer
    exportXls: protectedProcedure
      .input(z.object({ quizId: z.number() }))
      .query(async ({ ctx, input }) => {
        const XLSX = await import("xlsx");
        const quiz = await getQuizById(input.quizId);
        if (!quiz) throw new TRPCError({ code: "NOT_FOUND" });
        const questions = await getQuestionsByQuiz(input.quizId);
        const questionsWithChoices = await Promise.all(
          questions.map(async (q) => ({ ...q, choices: await getChoicesByQuestion(q.id) }))
        );
        const typeMap: Record<string, string> = {
          multiple_choice: "MC", multiple_select: "MR", true_false: "TF",
          short_answer: "TI", matching: "MG", sequence: "SEQ",
          numeric: "NUMG", essay: "ESS", info_slide: "IS",
          ordering: "SEQ", drag_words: "TI", dropdown: "MC",
          likert: "SA", drag_drop: "MG", fill_blank: "TI",
          hotspot: "MC", image_choice: "MC",
        };
        const rows = questionsWithChoices.map((q) => {
          const row: Record<string, string | number> = {
            "Question Type": typeMap[q.questionType] ?? "MC",
            "Question Text": q.questionText,
            Image: "", Video: "", Audio: "",
            "Correct Feedback": q.explanation ?? "",
            "Incorrect Feedback": "",
            Points: q.points ?? 1,
          };
          (q.choices as { choiceText: string; isCorrect: boolean }[]).forEach((c, i) => {
            row[`Answer ${i + 1}`] = c.isCorrect ? `*${c.choiceText}` : c.choiceText;
          });
          return row;
        });
        const ws = XLSX.utils.json_to_sheet(rows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Questions");
        const templateRows = [{
          "Question Type": "MC|MR|TF|TI|MG",
          "Question Text": "Question text here",
          Image: "", Video: "", Audio: "",
          "Answer 1": "*Correct answer (prefix with *)",
          "Answer 2": "Wrong answer",
          "Correct Feedback": "Explanation",
          "Incorrect Feedback": "",
          Points: 1,
        }];
        const wsTemplate = XLSX.utils.json_to_sheet(templateRows);
        XLSX.utils.book_append_sheet(wb, wsTemplate, "Template");
        // Add watermark sheet for free/trial users
        const db = await getDb();
        if (db) {
          const [userRow] = await db.select({
            quizCreatorAccess: users.quizCreatorAccess,
            quizCreatorTrialEndsAt: users.quizCreatorTrialEndsAt,
          }).from(users).where(eq(users.id, ctx.user.id));
          const qRole = (userRow as any)?.quizCreatorAccess ?? "none";
          const qTrial = (userRow as any)?.quizCreatorTrialEndsAt ?? null;
          const isTrialing = qRole !== "none" && qTrial && new Date(qTrial) > new Date();
          const isPaid = qRole !== "none" && !isTrialing;
          if (!isPaid) {
            const wsWatermark = XLSX.utils.json_to_sheet([{
              "": "Created with Teachific\u2122 \u2014 This export was generated on the free/trial plan. Upgrade at teachific.com to remove this notice.",
            }]);
            XLSX.utils.book_append_sheet(wb, wsWatermark, "Teachific\u2122");
          }
        }
        const buf = XLSX.write(wb, { type: "base64", bookType: "xlsx" }) as string;
        return { base64: buf, filename: `${quiz.title ?? "quiz"}.xlsx` };
      }),

    // XLS Import — accepts base64-encoded XLSX, returns parsed questions for preview
    importXls: protectedProcedure
      .input(z.object({ base64: z.string() }))
      .mutation(async ({ input }) => {
        const XLSX = await import("xlsx");
        const buf = Buffer.from(input.base64, "base64");
        const wb = XLSX.read(buf, { type: "buffer" });
        const sheetName = wb.SheetNames.find((n) => n.toLowerCase() === "questions") ?? wb.SheetNames[0];
        const ws = wb.Sheets[sheetName];
        const rows: Record<string, string>[] = XLSX.utils.sheet_to_json(ws, { defval: "" });
        const typeMap: Record<string, string> = {
          MC: "multiple_choice", MR: "multiple_select", TF: "true_false",
          TI: "short_answer", MG: "matching", SEQ: "sequence",
          NUMG: "numeric", ESS: "essay", IS: "info_slide",
          RNK: "sequence", SA: "short_answer",
        };
        const questions = rows
          .filter((r) => r["Question Text"]?.trim())
          .map((r, i) => {
            const qType = typeMap[(r["Question Type"] ?? "").trim().toUpperCase()] ?? "multiple_choice";
            const choices: { text: string; isCorrect: boolean }[] = [];
            for (let j = 1; j <= 10; j++) {
              const raw = (r[`Answer ${j}`] ?? "").trim();
              if (!raw) continue;
              const isCorrect = raw.startsWith("*");
              choices.push({ text: isCorrect ? raw.slice(1).trim() : raw, isCorrect });
            }
            return {
              sortOrder: i,
              questionType: qType,
              questionText: r["Question Text"].trim(),
              explanation: (r["Correct Feedback"] ?? "").trim(),
              points: Number(r["Points"]) || 1,
              choices,
            };
          });
        const warnings: string[] = [];
        questions.forEach((q, i) => {
          if (!q.choices.some((c) => c.isCorrect)) warnings.push(`Row ${i + 1}: no correct answer marked (use * prefix)`);
        });
        return { questions, warnings };
      }),

    // ── Import from QuizMaker .quiz file ──────────────────────────────────────
    importFromQuizMaker: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        // The raw text content of the .quiz file (TEACHIFIC_QUIZ_V1 format)
        quizFileContent: z.string(),
        // Optional title override
        titleOverride: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        // Parse the .quiz file format: TEACHIFIC_QUIZ_V1\n<base64payload>
        const lines = input.quizFileContent.trim().split("\n");
        if (lines[0] !== "TEACHIFIC_QUIZ_V1") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid .quiz file: missing header" });
        }
        const payload = lines[1];
        if (!payload) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid .quiz file: empty payload" });

        // Decode base64 payload (free tier = plain JSON; encrypted files not supported server-side)
        let quizData: {
          meta: {
            title: string;
            description?: string;
            passingScore?: number;
            timeLimit?: number | null;
            shuffleQuestions?: boolean;
            shuffleAnswers?: boolean;
            showFeedback?: string;
            maxAttempts?: number;
          };
          questions: Array<{
            id: string;
            type: string;
            order: number;
            points?: number;
            stem: string;
            explanation?: string;
            data: Record<string, unknown>;
          }>;
        };
        try {
          const decoded = Buffer.from(payload, "base64").toString("utf-8");
          quizData = JSON.parse(decoded);
        } catch {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Could not parse .quiz file. Encrypted files are not supported for import — save without encryption first.",
          });
        }

        if (!quizData.meta || !Array.isArray(quizData.questions)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid .quiz file structure" });
        }

        // Create the quiz record
        const title = input.titleOverride || quizData.meta.title || "Imported Quiz";
        const newQuiz = await createQuiz({
          orgId: input.orgId,
          createdBy: ctx.user.id,
          title,
          description: quizData.meta.description || undefined,
          passingScore: quizData.meta.passingScore ?? 70,
          // timeLimit in .quiz is minutes; DB stores seconds
          timeLimit: quizData.meta.timeLimit ? quizData.meta.timeLimit * 60 : undefined,
          maxAttempts: quizData.meta.maxAttempts ?? undefined,
          shuffleQuestions: quizData.meta.shuffleQuestions ?? false,
          shuffleAnswers: quizData.meta.shuffleAnswers ?? false,
          showFeedbackImmediately: quizData.meta.showFeedback === "immediate",
          showCorrectAnswers: true,
          isPublished: true,
        });
        if (!newQuiz) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create quiz" });

        // Map QuizMaker question types → DB question types
        const typeMap: Record<string, string> = {
          mcq: "multiple_choice",
          tf: "true_false",
          short_answer: "short_answer",
          matching: "matching",
          fill_blank: "short_answer",
          image_choice: "multiple_choice",
          hotspot: "multiple_choice",
        };

        // Insert questions and choices
        for (const q of quizData.questions) {
          const dbType = (typeMap[q.type] || "multiple_choice") as any;
          const questionResult = await createQuestion({
            quizId: newQuiz.id,
            sortOrder: q.order,
            questionType: dbType,
            questionText: q.stem,
            explanation: q.explanation || undefined,
            points: q.points ?? 1,
          });
          const questionId = questionResult.insertId as number;

          // Build choices based on question type
          const choices: Array<{ sortOrder: number; choiceText: string; isCorrect: boolean; matchTarget?: string }> = [];

          if (q.type === "mcq" || q.type === "image_choice") {
            const data = q.data as { choices: Array<{ text?: string; label?: string; correct: boolean }> };
            (data.choices || []).forEach((c, i) => {
              choices.push({ sortOrder: i, choiceText: c.text || c.label || `Option ${i + 1}`, isCorrect: c.correct });
            });
          } else if (q.type === "tf") {
            const data = q.data as { correct: boolean };
            choices.push({ sortOrder: 0, choiceText: "True", isCorrect: data.correct === true });
            choices.push({ sortOrder: 1, choiceText: "False", isCorrect: data.correct === false });
          } else if (q.type === "matching") {
            const data = q.data as { pairs: Array<{ premise: string; response: string }> };
            (data.pairs || []).forEach((p, i) => {
              choices.push({ sortOrder: i, choiceText: p.premise, isCorrect: true, matchTarget: p.response });
            });
          } else if (q.type === "fill_blank") {
            const data = q.data as { blanks: Array<{ acceptedAnswers: string[] }> };
            const answers = (data.blanks || []).flatMap((b) => b.acceptedAnswers).slice(0, 1);
            if (answers.length > 0) choices.push({ sortOrder: 0, choiceText: answers[0], isCorrect: true });
          } else if (q.type === "short_answer") {
            const data = q.data as { sampleAnswer: string };
            if (data.sampleAnswer) choices.push({ sortOrder: 0, choiceText: data.sampleAnswer, isCorrect: true });
          } else if (q.type === "hotspot") {
            const data = q.data as { regions: Array<{ label: string; correct: boolean }> };
            (data.regions || []).forEach((r, i) => {
              choices.push({ sortOrder: i, choiceText: r.label, isCorrect: r.correct });
            });
          }

          if (choices.length > 0) await upsertChoices(questionId, choices);
        }

        return {
          quizId: newQuiz.id,
          title: newQuiz.title,
          questionCount: quizData.questions.length,
        };
      }),
  }),

  // ── Folders ────────────────────────────────────────────────────────────────────────────────────
  folders: router({
    // List all folders for the current user's org
    list: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        // org_admin / org_super_admin: always scope to their assigned org, ignore input.orgId
        if (ctx.user.role === "org_admin" || ctx.user.role === "org_super_admin") {
          const orgId = await getOrgIdForUser(ctx.user.id);
          if (!orgId) return [];
          return getFoldersByOrg(orgId);
        }
        return getFoldersByOrg(input.orgId);
      }),

    // Create a new folder
    create: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        name: z.string().min(1).max(255),
        parentId: z.number().nullable().optional(),
        color: z.string().max(32).optional(),
      }))
      .mutation(({ input, ctx }) =>
        createFolder({
          orgId: input.orgId,
          ownerId: ctx.user.id,
          name: input.name.trim(),
          parentId: input.parentId ?? null,
          color: input.color ?? null,
        })
      ),

    // Rename a folder
    rename: protectedProcedure
      .input(z.object({ id: z.number(), name: z.string().min(1).max(255) }))
      .mutation(async ({ input }) => {
        await updateFolder(input.id, { name: input.name.trim() });
        return getFolderById(input.id);
      }),

    // Move a folder to a different parent (or to root if parentId is null)
    move: protectedProcedure
      .input(z.object({ id: z.number(), parentId: z.number().nullable() }))
      .mutation(async ({ input }) => {
        // Prevent moving a folder into itself or its own descendant
        if (input.parentId === input.id)
          throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot move a folder into itself" });
        await updateFolder(input.id, { parentId: input.parentId ?? null });
        return getFolderById(input.id);
      }),

    // Delete a folder (children promoted to parent, packages moved to uncategorized)
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await deleteFolder(input.id);
        return { success: true };
      }),

    // Move a package into a folder (or to root if folderId is null)
    movePackage: protectedProcedure
      .input(z.object({ packageId: z.number(), folderId: z.number().nullable() }))
      .mutation(async ({ input }) => {
        await movePackageToFolder(input.packageId, input.folderId);
        return { success: true };
      }),

    // Reorder folders by updating sortOrder for a batch of IDs
    reorder: protectedProcedure
      .input(z.object({ orderedIds: z.array(z.number()) }))
      .mutation(async ({ input }) => {
        await Promise.all(
          input.orderedIds.map((id, index) => updateFolder(id, { sortOrder: index }))
        );
        return { success: true };
      }),
  }),
  // ── Platform Admin ───────────────────────────────────────────────────────
  platformAdmin: router({
    // Platform settings (registration toggle, maintenance mode, etc.)
    getSettings: ownerProcedure.query(() => getPlatformSettings()),
    updateSettings: ownerProcedure
      .input(z.object({
        allowPublicRegistration: z.boolean().optional(),
        maintenanceMode: z.boolean().optional(),
        platformName: z.string().min(1).max(255).optional(),
        supportEmail: z.string().email().optional().nullable(),
        maxUploadSizeMb: z.number().int().min(1).max(10000).optional(),
        enterpriseMaxUploadSizeMb: z.number().int().min(1).max(50000).optional(),
        // Branding
        logoUrl: z.string().url().optional().nullable(),
        faviconUrl: z.string().url().optional().nullable(),
        primaryColor: z.string().max(32).optional(),
        accentColor: z.string().max(32).optional(),
        // Watermark
        watermarkImageUrl: z.string().url().optional().nullable(),
        watermarkOpacity: z.number().int().min(0).max(100).optional(),
        watermarkPosition: z.string().max(32).optional(),
        watermarkSize: z.number().int().min(20).max(400).optional(),
      }))
      .mutation(({ input }) => updatePlatformSettings(input)),
    // Upload platform logo, favicon, or watermark
    uploadPlatformAsset: ownerProcedure
      .input(z.object({
        fileName: z.string(),
        contentType: z.string(),
        assetType: z.enum(["logo", "favicon", "watermark"]),
      }))
      .mutation(async ({ input }) => {
        const suffix = input.fileName.split(".").pop() || "png";
        const key = `platform/${input.assetType}-${Date.now()}.${suffix}`;
        const { url } = await storagePut(key, Buffer.alloc(0), input.contentType);
        const fileUrl = url.split("?")[0];
        return { uploadUrl: url, fileUrl, assetType: input.assetType };
      }),

    // All users across the platform
    listUsers: adminProcedure.query(() => getAllUsers()),
    updateUser: adminProcedure
      .input(z.object({
        userId: z.number(),
        name: z.string().min(1).optional(),
        email: z.string().email().optional(),
        role: z.enum(["site_owner", "site_admin", "org_super_admin", "org_admin", "member"]).optional(),
        orgId: z.number().optional(),
        orgRole: z.enum(["org_super_admin", "org_admin", "member"]).optional(),
        memberSubRole: z.enum(["basic_member", "instructor", "group_manager", "group_member"]).optional(),
        groupId: z.number().optional(),
      }))
      .mutation(async ({ input }) => {
        const { userId, orgId, orgRole, memberSubRole, groupId, ...data } = input;
        await updateUser(userId, data);
        if (orgId && orgRole) {
          const existing = await getOrgMember(orgId, userId);
          if (existing) {
            await updateOrgMemberRole(orgId, userId, orgRole, memberSubRole);
          } else {
            await addOrgMember(orgId, userId, orgRole, undefined, memberSubRole);
          }
          if (groupId) {
            const db2 = await getDb();
            if (db2) {
              const user = await getUserById(userId);
              const { groupMembers: gmTable } = await import("../drizzle/schema");
              await db2.insert(gmTable).values({ groupId, userId, email: user?.email ?? "", name: user?.name ?? "", status: "active" }).onDuplicateKeyUpdate({ set: { status: "active" } });
            }
          }
        }
        return { success: true };
      }),
    deleteUser: ownerProcedure
      .input(z.object({ userId: z.number() }))
      .mutation(({ input }) => deleteUser(input.userId)),
    bulkAddUsers: adminProcedure
      .input(z.object({
        orgId: z.number(),
        users: z.array(z.object({
          name: z.string().optional(),
          email: z.string().email(),
          role: z.enum(["org_super_admin", "org_admin", "member"]).default("member"),
          memberSubRole: z.enum(["basic_member", "instructor", "group_manager", "group_member"]).optional(),
        })),
      }))
      .mutation(async ({ input }) => {
        const results: { email: string; status: string; userId?: number }[] = [];
        for (const u of input.users) {
          try {
            const allUsers = await getAllUsers();
            const existing = allUsers.find((usr) => usr.email === u.email);
            if (existing) {
              await addOrgMember(input.orgId, existing.id, u.role, undefined, u.memberSubRole);
              results.push({ email: u.email, status: "added_existing", userId: existing.id });
            } else {
              const openId = `pending_${nanoid(16)}`;
              await upsertUser({ openId, name: u.name ?? null, email: u.email, role: "member" });
              const newUser = (await getAllUsers()).find((usr) => usr.email === u.email);
              if (newUser) {
                await addOrgMember(input.orgId, newUser.id, u.role, undefined, u.memberSubRole);
                results.push({ email: u.email, status: "created", userId: newUser.id });
              }
            }
          } catch (err) {
            results.push({ email: u.email, status: `error: ${(err as Error).message}` });
          }
        }
        return results;
      }),

    // All organizations
    listOrgs: adminProcedure.query(() => getAllOrgs()),
    updateOrg: adminProcedure
      .input(z.object({
        orgId: z.number(),
        name: z.string().min(1).optional(),
        slug: z.string().min(1).optional(),
        description: z.string().optional(),
        domain: z.string().optional().nullable(),
        logoUrl: z.string().optional().nullable(),
        adminNotes: z.string().optional().nullable(),
      }))
      .mutation(({ input }) => {
        const { orgId, ...data } = input;
        return updateOrg(orgId, data);
      }),

    // Subscription management (manual Enterprise assignment)
    getOrgSubscription: adminProcedure
      .input(z.object({ orgId: z.number() }))
      .query(({ input }) => getOrgSubscription(input.orgId)),
    setOrgPlan: adminProcedure
      .input(z.object({
        orgId: z.number(),
        plan: z.enum(["free", "starter", "builder", "pro", "enterprise"]),
        customPriceUsd: z.number().int().optional().nullable(), // in cents
        customPriceLabel: z.string().optional().nullable(),
        adminNotes: z.string().optional().nullable(),
        status: z.enum(["active", "trialing", "past_due", "cancelled", "unpaid"]).optional(),
      }))
      .mutation(({ input, ctx }) => {
        const { orgId, ...data } = input;
        return upsertOrgSubscription(orgId, { ...data, assignedByUserId: ctx.user.id });
      }),

    // Platform-wide analytics overview
    platformStats: adminProcedure.query(async () => {
      const empty = { totalUsers: 0, totalOrgs: 0, totalCourses: 0, totalEnrollments: 0, totalRevenue: 0, planBreakdown: {} as Record<string, number>, recentOrgs: [] as any[], recentUsers: [] as any[], analytics: { totalPlays: 0, totalDownloads: 0, totalCompletions: 0 } };
      try {
        const db = await getDb();
        if (!db) return empty;
        const { sql: sqlFn, count, desc } = await import("drizzle-orm");
        const { users, organizations: orgsTable, orgSubscriptions } = await import("../drizzle/schema");
        const { courses: lmsCourses, courseEnrollments: enrollTable, courseOrders } = await import("../drizzle/schema");

        const [userCount] = await db.select({ count: count() }).from(users);
        const [orgCount] = await db.select({ count: count() }).from(orgsTable);
        const [courseCount] = await db.select({ count: count() }).from(lmsCourses);
        const [enrollCount] = await db.select({ count: count() }).from(enrollTable);

        // Revenue from paid orders — amount is a float (USD), not cents
        const revenueRows = await db.select({ total: sqlFn<number>`COALESCE(SUM(amount), 0)` }).from(courseOrders).where(sqlFn`status = 'completed'`);
        const totalRevenue = revenueRows[0]?.total ?? 0;

        // Plan breakdown from org_subscriptions
        const planRows = await db.select({ plan: orgSubscriptions.plan, count: count() }).from(orgSubscriptions).groupBy(orgSubscriptions.plan);
        const planBreakdown = Object.fromEntries(planRows.map(r => [r.plan, r.count]));

        // Recent orgs
        const recentOrgs = await db.select({ id: orgsTable.id, name: orgsTable.name, slug: orgsTable.slug, createdAt: orgsTable.createdAt }).from(orgsTable).orderBy(desc(orgsTable.createdAt)).limit(5);

        // Recent users
        const recentUsers = await db.select({ id: users.id, name: users.name, email: users.email, role: users.role, createdAt: users.createdAt }).from(users).orderBy(desc(users.createdAt)).limit(5);

        const analytics = await getAnalyticsSummary();

        return {
          totalUsers: userCount.count,
          totalOrgs: orgCount.count,
          totalCourses: courseCount.count,
          totalEnrollments: enrollCount.count,
          totalRevenue,
          planBreakdown,
          recentOrgs,
          recentUsers,
          analytics,
        };
      } catch (err) {
        console.error("[platformStats] query error:", err);
        return empty;
      }
    }),

    // ── Impersonation ──────────────────────────────────────────────────────
    // Login as the primary org admin for a given org
    impersonateOrg: adminProcedure
      .input(z.object({ orgId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const db2 = await getDb();
        if (!db2) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
        const { orgMembers: orgMembersTable, users: usersTable } = await import("../drizzle/schema");
        const { eq: eqOp, inArray } = await import("drizzle-orm");
        const adminMembers = await db2
          .select({ userId: orgMembersTable.userId })
          .from(orgMembersTable)
          .where(eqOp(orgMembersTable.orgId, input.orgId))
          .limit(20);
        if (!adminMembers.length) throw new TRPCError({ code: "NOT_FOUND", message: "No members found in this organization" });
        const memberIds = adminMembers.map(m => m.userId);
        const members = await db2.select().from(usersTable).where(inArray(usersTable.id, memberIds));
        const orgAdmin = members.find(u => u.role === "org_admin") ?? members[0];
        if (!orgAdmin) throw new TRPCError({ code: "NOT_FOUND", message: "No user found for this organization" });
        // Store current admin session as the original session cookie
        const cookieHeader = ctx.req.headers.cookie ?? "";
        const currentSessionCookie = cookieHeader.split(";").find(c => c.trim().startsWith(COOKIE_NAME + "="))?.split("=").slice(1).join("=");
        const cookieOptions = getSessionCookieOptions(ctx.req);
        if (currentSessionCookie) {
          ctx.res.cookie(IMPERSONATION_ORIGINAL_COOKIE, currentSessionCookie, { ...cookieOptions, maxAge: 60 * 60 * 1000 });
        }
        const impersonationToken = await sdk.createImpersonationToken(
          orgAdmin.openId,
          orgAdmin.name ?? orgAdmin.email ?? "User",
          ctx.user.openId
        );
        ctx.res.cookie(COOKIE_NAME, impersonationToken, { ...cookieOptions, maxAge: 60 * 60 * 1000 });
        return { success: true, impersonatedUser: { id: orgAdmin.id, name: orgAdmin.name, email: orgAdmin.email } };
      }),

    // Login as a specific user by userId
    impersonateUser: adminProcedure
      .input(z.object({ userId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const targetUser = await getUserById(input.userId);
        if (!targetUser) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
        if ((targetUser.role === "site_owner" || targetUser.role === "site_admin") && ctx.user.role !== "site_owner") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Cannot impersonate another admin" });
        }
        const cookieHeader = ctx.req.headers.cookie ?? "";
        const currentSessionCookie = cookieHeader.split(";").find(c => c.trim().startsWith(COOKIE_NAME + "="))?.split("=").slice(1).join("=");
        const cookieOptions = getSessionCookieOptions(ctx.req);
        if (currentSessionCookie) {
          ctx.res.cookie(IMPERSONATION_ORIGINAL_COOKIE, currentSessionCookie, { ...cookieOptions, maxAge: 60 * 60 * 1000 });
        }
        const impersonationToken = await sdk.createImpersonationToken(
          targetUser.openId,
          targetUser.name ?? targetUser.email ?? "User",
          ctx.user.openId
        );
        ctx.res.cookie(COOKIE_NAME, impersonationToken, { ...cookieOptions, maxAge: 60 * 60 * 1000 });
        return { success: true, impersonatedUser: { id: targetUser.id, name: targetUser.name, email: targetUser.email } };
      }),

    // End impersonation — restore original admin session
    createOrgWithAdmin: adminProcedure
      .input(z.object({
        orgName: z.string().min(1),
        orgSlug: z.string().min(1).regex(/^[a-z0-9-]+$/, "Slug must be lowercase letters, numbers, and hyphens only").optional(),
        adminName: z.string().min(1),
        adminEmail: z.string().email(),
        plan: z.enum(["free", "starter", "builder", "pro", "enterprise"]).optional().default("free"),
      }))
      .mutation(async ({ input }) => {
        const db2 = await getDb();
        if (!db2) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const { users: usersTable, organizations: orgsTable, orgMembers: orgMembersTable, orgSubscriptions: orgSubTable } = await import("../drizzle/schema");
        const { eq: eqOp } = await import("drizzle-orm");
        // Auto-generate slug from org name if not provided
        const { generateUniqueOrgSlug } = await import("../shared/slugUtils");
        const finalSlug = input.orgSlug
          ? input.orgSlug
          : await generateUniqueOrgSlug(input.orgName, async (s) => {
              const rows = await db2.select({ id: orgsTable.id }).from(orgsTable).where(eqOp(orgsTable.slug, s)).limit(1);
              return rows.length > 0;
            });
        // Check slug uniqueness if manually provided
        if (input.orgSlug) {
          const existing = await db2.select({ id: orgsTable.id }).from(orgsTable).where(eqOp(orgsTable.slug, finalSlug)).limit(1);
          if (existing.length) throw new TRPCError({ code: "CONFLICT", message: "An organization with this slug already exists" });
        }
        // Check if user exists by email, create if not
        const existingUsers = await db2.select().from(usersTable).where(eqOp(usersTable.email, input.adminEmail)).limit(1);
        let adminUserId: number;
        if (existingUsers.length) {
          adminUserId = existingUsers[0].id;
          // Upgrade to org_admin if needed
          if (existingUsers[0].role === "user") {
            await db2.update(usersTable).set({ role: "org_admin", name: input.adminName }).where(eqOp(usersTable.id, adminUserId));
          }
        } else {
          const { nanoid } = await import("nanoid");
          const openId = `manual_${nanoid(16)}`;
          const [result] = await db2.insert(usersTable).values({
            openId,
            name: input.adminName,
            email: input.adminEmail,
            role: "org_admin",
          });
          adminUserId = (result as any).insertId;
        }
        // Create the org
        const [orgResult] = await db2.insert(orgsTable).values({
          name: input.orgName,
          slug: finalSlug,
          ownerId: adminUserId,
          isActive: true,
        });
        const orgId = (orgResult as any).insertId;
        // Add admin as org_admin member
        await db2.insert(orgMembersTable).values({ orgId, userId: adminUserId, role: "org_admin" }).onDuplicateKeyUpdate({ set: { role: "org_admin" } });
        // Set subscription plan
        await db2.insert(orgSubTable).values({ orgId, plan: input.plan, status: "active" }).onDuplicateKeyUpdate({ set: { plan: input.plan, status: "active" } });
        // Auto-enroll the new org admin in the Teachific school (slug='teach')
        try {
          const teachOrg = await getOrgBySlug("teach");
          if (teachOrg && teachOrg.id !== orgId) {
            await addOrgMember(teachOrg.id, adminUserId, "member");
          }
        } catch (_e) { /* non-fatal */ }
        return { orgId, adminUserId };
      }),
    uploadPlatformLogo: adminProcedure
      .input(z.object({ fileName: z.string(), contentType: z.string() }))
      .mutation(async ({ input }) => {
        const ext = input.fileName.split(".").pop() ?? "png";
        const key = `platform-branding/${Date.now()}-${nanoid(8)}.${ext}`;
        const { url } = await storagePut(key, Buffer.alloc(0), input.contentType);
        const fileUrl = url.split("?")[0];
        return { key, fileUrl, uploadUrl: url };
      }),
    getBranding: adminProcedure.query(async () => {
      const db2 = await getDb();
      if (!db2) return null;
      const { platformSettings: psTable } = await import("../drizzle/schema");
      const rows = await db2.select().from(psTable).limit(1);
      return rows[0] ?? null;
    }),
    updateBranding: adminProcedure
      .input(z.object({
        logoUrl: z.string().optional().nullable(),
        faviconUrl: z.string().optional().nullable(),
        primaryColor: z.string().optional(),
        accentColor: z.string().optional(),
        buttonColor: z.string().optional().nullable(),
        buttonTextColor: z.string().optional().nullable(),
        sidebarBgColor: z.string().optional().nullable(),
        sidebarTextColor: z.string().optional().nullable(),
        sidebarActiveColor: z.string().optional().nullable(),
        pageBgColor: z.string().optional().nullable(),
        platformName: z.string().optional(),
        tagline: z.string().optional().nullable(),
        headingFont: z.string().optional(),
        bodyFont: z.string().optional(),
        watermarkImageUrl: z.string().optional().nullable(),
        watermarkOpacity: z.number().int().min(0).max(100).optional(),
        watermarkPosition: z.string().optional(),
        watermarkSize: z.number().int().min(20).max(400).optional(),
      }))
      .mutation(async ({ input }) => {
        const db2 = await getDb();
        if (!db2) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const { platformSettings: psTable } = await import("../drizzle/schema");
        const existing = await db2.select({ id: psTable.id }).from(psTable).limit(1);
        if (existing.length) {
          await db2.update(psTable).set(input as any);
        } else {
          await db2.insert(psTable).values(input as any);
        }
        return { success: true };
      }),
    // ── Subscription Plan Limits ──────────────────────────────────────────────
    getPlanLimits: adminProcedure.query(() => getPlanLimits()),
    upsertPlanLimit: adminProcedure
      .input(z.object({
        plan: z.enum(["free", "starter", "builder", "pro", "enterprise"]),
        featureKey: z.string().min(1),
        featureLabel: z.string().min(1),
        limitValue: z.number().int().min(-1),
      }))
      .mutation(({ input }) => upsertPlanLimit(input)),

    // ── Org Limit Overrides ────────────────────────────────────────────────────
    getOrgLimits: adminProcedure
      .input(z.object({ orgId: z.number() }))
      .query(({ input }) => getOrgLimitOverrides(input.orgId)),
    getOrgLimitsEnriched: adminProcedure
      .input(z.object({ orgId: z.number() }))
      .query(({ input }) => getOrgLimitsEnriched(input.orgId)),
    upsertOrgLimitOverride: adminProcedure
      .input(z.object({
        orgId: z.number(),
        featureKey: z.string().min(1),
        limitValue: z.number().int().min(-1),
        note: z.string().optional(),
      }))
      .mutation(({ input, ctx }) => upsertOrgLimitOverride({ ...input, overriddenByUserId: ctx.user.id })),
    deleteOrgLimitOverride: adminProcedure
      .input(z.object({ orgId: z.number(), featureKey: z.string() }))
      .mutation(({ input }) => deleteOrgLimitOverride(input.orgId, input.featureKey)),

    // ── Delete Org ─────────────────────────────────────────────────────────────
    deleteOrg: adminProcedure
      .input(z.object({ orgId: z.number() }))
      .mutation(({ input }) => deleteOrgCascade(input.orgId)),

    endImpersonation: protectedProcedure
      .mutation(async ({ ctx }) => {
        const cookieHeader = ctx.req.headers.cookie ?? "";
        const originalSession = cookieHeader.split(";").find(c => c.trim().startsWith(IMPERSONATION_ORIGINAL_COOKIE + "="))?.split("=").slice(1).join("=");
        if (!originalSession) throw new TRPCError({ code: "BAD_REQUEST", message: "No active impersonation session" });
        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.cookie(COOKIE_NAME, originalSession, { ...cookieOptions, maxAge: 365 * 24 * 60 * 60 * 1000 });
        ctx.res.clearCookie(IMPERSONATION_ORIGINAL_COOKIE, { ...cookieOptions, maxAge: -1 });
        return { success: true };
      }),

    // ── Platform-level Legal Policies ────────────────────────────────────────
    // Public: anyone can read the platform policies (shown at /policies)
    getPolicies: publicProcedure.query(async () => {
      const settings = await getPlatformSettings();
      return {
        termsOfService: settings?.termsOfService ?? "",
        privacyPolicy: settings?.privacyPolicy ?? "",
      };
    }),
    // Admin-only: update platform policies
    updatePolicies: adminProcedure
      .input(z.object({
        termsOfService: z.string().optional(),
        privacyPolicy: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        await updatePlatformSettings(input);
        return { success: true };
      }),

    // ── Desktop App Version Management ──────────────────────────────────────
    // Public: get latest download URLs for a product
    getLatestAppVersion: publicProcedure
      .input(z.object({ product: z.enum(["creator", "studio", "quizcreator"]) }))
      .query(async ({ input }) => {
        const db2 = await getDb();
        if (!db2) return null;
        const { appVersions } = await import("../drizzle/schema");
        const { eq, and } = await import("drizzle-orm");
        const rows = await db2.select().from(appVersions)
          .where(and(eq(appVersions.product, input.product), eq(appVersions.isLatest, true)))
          .limit(1);
        return rows[0] ?? null;
      }),

    // Public: get all versions for all products
    getAllAppVersions: publicProcedure.query(async () => {
      const db2 = await getDb();
      if (!db2) return [];
      const { appVersions } = await import("../drizzle/schema");
      return db2.select().from(appVersions);
    }),

    // Admin: upsert an app version (create or update)
    upsertAppVersion: adminProcedure
      .input(z.object({
        id: z.number().optional(),
        product: z.enum(["creator", "studio", "quizcreator"]),
        version: z.string().min(1),
        releaseNotes: z.string().optional(),
        windowsUrl: z.string().optional(),
        macUrl: z.string().optional(),
        isLatest: z.boolean().default(false),
      }))
      .mutation(async ({ input }) => {
        const db2 = await getDb();
        if (!db2) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const { appVersions } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        if (input.isLatest) {
          await db2.update(appVersions).set({ isLatest: false }).where(eq(appVersions.product, input.product));
        }
        if (input.id) {
          await db2.update(appVersions).set({
            version: input.version,
            releaseNotes: input.releaseNotes ?? null,
            windowsUrl: input.windowsUrl || null,
            macUrl: input.macUrl || null,
            isLatest: input.isLatest,
          }).where(eq(appVersions.id, input.id));
        } else {
          await db2.insert(appVersions).values({
            product: input.product,
            version: input.version,
            releaseNotes: input.releaseNotes ?? null,
            windowsUrl: input.windowsUrl || null,
            macUrl: input.macUrl || null,
            isLatest: input.isLatest,
          });
        }
        return { success: true };
      }),

    // Admin: delete an app version
    deleteAppVersion: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const db2 = await getDb();
        if (!db2) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const { appVersions } = await import("../drizzle/schema");
        const { eq } = await import("drizzle-orm");
        await db2.delete(appVersions).where(eq(appVersions.id, input.id));
        return { success: true };
      }),

    // ── Org Member Management (Platform Admin) ──────────────────────────────
    getOrgMembers: adminProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input }) => {
        const members = await getOrgMembers(input.orgId);
        const userList = await Promise.all(members.map((m) => getUserById(m.userId)));
        return members.map((m, i) => ({
          ...m,
          user: userList[i] ?? null,
        }));
      }),

    removeOrgMember: adminProcedure
      .input(z.object({ orgId: z.number(), userId: z.number() }))
      .mutation(async ({ input }) => {
        await removeOrgMember(input.orgId, input.userId);
        return { success: true };
      }),

    updateOrgMemberRole: adminProcedure
      .input(z.object({
        orgId: z.number(),
        userId: z.number(),
        role: z.enum(["org_super_admin", "org_admin", "member", "user"]),
      }))
      .mutation(async ({ input }) => {
        await updateOrgMemberRole(input.orgId, input.userId, input.role as any);
        return { success: true };
      }),

    addUserToOrg: adminProcedure
      .input(z.object({
        orgId: z.number(),
        userId: z.number(),
        role: z.enum(["org_admin", "user"]).default("user"),
      }))
      .mutation(async ({ input }) => {
        const existing = await getOrgMember(input.orgId, input.userId);
        if (existing) throw new TRPCError({ code: "CONFLICT", message: "User is already a member of this org" });
        await addOrgMember(input.orgId, input.userId, input.role as any);
        return { success: true };
      }),
    addUserToOrgByEmail: adminProcedure
      .input(z.object({
        orgId: z.number(),
        email: z.string().email(),
        role: z.enum(["org_admin", "user"]).default("user"),
      }))
      .mutation(async ({ input }) => {
        const user = await getUserByEmail(input.email);
        if (!user) throw new TRPCError({ code: "NOT_FOUND", message: `No user found with email ${input.email}` });
        const existing = await getOrgMember(input.orgId, user.id);
        if (existing) throw new TRPCError({ code: "CONFLICT", message: "User is already a member of this org" });
        await addOrgMember(input.orgId, user.id, input.role as any);
        return { success: true, userId: user.id, name: user.name, email: user.email };
      }),
  }),

  // ─── QuizMaker Product ──────────────────────────────────────────────────────
  quizCreator: router({
    /** Get the current user's QuizMaker role */
    getMyRole: protectedProcedure.query(async ({ ctx }) => {
      const user = await getUserById(ctx.user.id);
      const role = (user?.quizCreatorAccess ?? "none") as "none" | "web" | "desktop" | "bundle";
      const trialEndsAt = (user as any)?.quizCreatorTrialEndsAt ?? null;
      const isInTrial = role !== "none" && trialEndsAt && new Date(trialEndsAt) > new Date();
      const isPaid = role !== "none" && !isInTrial;
      return { role, trialEndsAt, isInTrial, isPaid };
    }),

    /** Admin: set a user's QuizMaker role */
    setUserRole: adminProcedure
      .input(z.object({
        userId: z.number(),
        role: z.enum(["none", "web", "desktop", "bundle"]),
      }))
      .mutation(async ({ input }) => {
        await updateUser(input.userId, { quizCreatorAccess: input.role });
        return { success: true };
      }),

    /** Admin: list all users with their QuizMaker role */
    listUsersWithRole: adminProcedure.query(async () => {
      const allUsers = await getAllUsers();
      return allUsers.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        quizCreatorAccess: u.quizCreatorAccess ?? "none",
      }));
    }),
  }),

  // ── Support ───────────────────────────────────────────────────────────────
  support: router({
    /** Public: submit a support ticket — no auth required */
    submitTicket: publicProcedure
      .input(
        z.object({
          name: z.string().min(1).max(128),
          email: z.string().email().max(255),
          subject: z.string().min(1).max(255),
          category: z.enum(["general", "billing", "technical", "account", "other"]).default("general"),
          message: z.string().min(10).max(5000),
        })
      )
      .mutation(async ({ input, ctx }) => {
        await createSupportTicket({
          ...input,
          userId: ctx.user?.id,
        });
        const categoryLabels: Record<string, string> = {
          general: "General",
          billing: "Billing",
          technical: "Technical",
          account: "Account",
          other: "Other",
        };
        const safeMessage = input.message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const html = `
          <h2 style="color:#0f172a">New Support Ticket</h2>
          <table style="border-collapse:collapse;width:100%;max-width:600px;font-family:sans-serif">
            <tr><td style="padding:8px 12px;font-weight:bold;background:#f3f4f6;width:120px">From</td><td style="padding:8px 12px">${input.name} &lt;${input.email}&gt;</td></tr>
            <tr><td style="padding:8px 12px;font-weight:bold;background:#f3f4f6">Category</td><td style="padding:8px 12px">${categoryLabels[input.category] ?? input.category}</td></tr>
            <tr><td style="padding:8px 12px;font-weight:bold;background:#f3f4f6">Subject</td><td style="padding:8px 12px">${input.subject}</td></tr>
            <tr><td style="padding:8px 12px;font-weight:bold;background:#f3f4f6;vertical-align:top">Message</td><td style="padding:8px 12px;white-space:pre-wrap">${safeMessage}</td></tr>
            ${ctx.user ? `<tr><td style="padding:8px 12px;font-weight:bold;background:#f3f4f6">User ID</td><td style="padding:8px 12px">${ctx.user.id}</td></tr>` : ""}
          </table>
          <p style="color:#6b7280;font-size:12px;margin-top:16px">Submitted via the Teachific support form.</p>
        `;
        await sendEmail({
          to: "support@teachific.net",
          subject: `[Support] ${input.subject}`,
          html,
          replyTo: input.email,
        });
        return { success: true };
      }),

    /** Admin: list all tickets */
    listTickets: adminProcedure
      .input(
        z.object({
          status: z.enum(["open", "in_progress", "resolved", "closed"]).optional(),
          limit: z.number().int().min(1).max(200).default(50),
          offset: z.number().int().min(0).default(0),
        })
      )
      .query(async ({ input }) => {
        return getSupportTickets(input);
      }),

    /** Admin: update ticket status */
    updateTicketStatus: adminProcedure
      .input(
        z.object({
          id: z.number().int(),
          status: z.enum(["open", "in_progress", "resolved", "closed"]),
          staffNotes: z.string().max(2000).optional(),
        })
      )
      .mutation(async ({ input }) => {
        await updateSupportTicketStatus(input.id, input.status, input.staffNotes);
        return { success: true };
      }),
  }),
});
export type AppRouter = typeof appRouter;
