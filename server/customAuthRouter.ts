/**
 * Custom Teachific Authentication Router
 * Handles email/password registration, login, logout, email verification,
 * and password reset — completely independent of Manus OAuth.
 */
import { z } from "zod";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { router, publicProcedure, protectedProcedure } from "./_core/trpc";
import { TRPCError } from "@trpc/server";
import { getDb } from "./db";
import { users, orgMembers, organizations } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { generateUniqueOrgSlug } from "../shared/slugUtils";
import { sendEmail } from "./sendgrid";
import * as dbHelpers from "./db";
import { verifyEmailHtml, resetPasswordHtml } from "./emailTemplates";
import { signSessionToken } from "./_core/context";

const COOKIE_NAME = "teachific_session";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const BCRYPT_ROUNDS = 12;
const SITE_URL = process.env.VITE_SITE_URL || "https://teachific.app";

function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

function generateOpenId(): string {
  return `local_${crypto.randomUUID().replace(/-/g, "")}`;
}

function serializeCookie(name: string, value: string, maxAge: number): string {
  const isProduction = process.env.NODE_ENV === "production";
  // Use SameSite=None + Secure in production so the cookie is sent cross-subdomain
  // (e.g. from teachific.app to allaboutultrasound.teachific.app).
  // Domain=.teachific.app ensures all subdomains share the same session.
  let str = `${name}=${encodeURIComponent(value)}; HttpOnly; Path=/; Max-Age=${maxAge}`;
  if (isProduction) {
    str += "; Secure; SameSite=None; Domain=.teachific.app";
  } else {
    str += "; SameSite=Lax";
  }
  return str;
}

// ─── Router ───────────────────────────────────────────────────────────────────
export const customAuthRouter = router({

  /** Register a new user with email + password */
  register: publicProcedure
    .input(z.object({
      name: z.string().min(1).max(100),
      email: z.string().email().max(320),
      password: z.string().min(8).max(128),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable." });

      const settings = await dbHelpers.getPlatformSettings();
      if (!settings?.allowPublicRegistration) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Public registration is currently closed." });
      }

      const existing = await db.select({ id: users.id }).from(users)
        .where(eq(users.email, input.email.toLowerCase()))
        .limit(1);
      if (existing.length > 0) {
        throw new TRPCError({ code: "CONFLICT", message: "An account with this email already exists." });
      }

      const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
      const verificationToken = generateToken();
      const verificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const openId = generateOpenId();

      await db.insert(users).values({
        openId,
        name: input.name,
        email: input.email.toLowerCase(),
        loginMethod: "email",
        role: "user",
        passwordHash,
        emailVerified: false,
        emailVerificationToken: verificationToken,
        emailVerificationExpiry: verificationExpiry,
        lastSignedIn: new Date(),
      });

      const [newUser] = await db.select().from(users)
        .where(eq(users.email, input.email.toLowerCase()))
        .limit(1);

      if (newUser) {
        try {
          const orgName = `${input.name}'s School`;
          const slug = await generateUniqueOrgSlug(orgName, async (s) => !!(await dbHelpers.getOrgBySlug(s)));
          await dbHelpers.createOrg({ name: orgName, slug, description: "Default workspace", ownerId: newUser.id });
          const org = await dbHelpers.getOrgBySlug(slug);
          if (org) await dbHelpers.addOrgMember(org.id, newUser.id, "org_admin");
        } catch {}

        const verifyUrl = `${SITE_URL}/verify-email?token=${verificationToken}`;
        await sendEmail({
          to: input.email,
          subject: "Verify your Teachific email address",
          html: verifyEmailHtml(input.name, verifyUrl),
        });
      }

      return { success: true, message: "Account created! Please check your email to verify your address." };
    }),

  /** Login with email + password */
  login: publicProcedure
    .input(z.object({
      email: z.string().email(),
      password: z.string().min(1),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [user] = await db.select().from(users)
        .where(eq(users.email, input.email.toLowerCase()))
        .limit(1);

      if (!user || !user.passwordHash) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid email or password." });
      }

      const valid = await bcrypt.compare(input.password, user.passwordHash);
      if (!valid) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid email or password." });
      }

      if (!user.emailVerified) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Please verify your email address before logging in. Check your inbox for the verification link." });
      }

      await db.update(users).set({ lastSignedIn: new Date() }).where(eq(users.id, user.id));

      const sessionToken = signSessionToken({ userId: user.id, ts: Date.now() });
      ctx.res.setHeader("Set-Cookie", serializeCookie(COOKIE_NAME, sessionToken, COOKIE_MAX_AGE));

      // Resolve the user's primary org slug for immediate subdomain redirect
      const ROLE_PRIORITY: Record<string, number> = {
        org_super_admin: 100, org_admin: 90, sub_admin: 70,
        instructor: 60, group_manager: 50, group_member: 40, member: 20, user: 10,
      };
      const memberships = await db
        .select({ role: orgMembers.role, slug: organizations.slug })
        .from(orgMembers)
        .innerJoin(organizations, eq(orgMembers.orgId, organizations.id))
        .where(eq(orgMembers.userId, user.id));
      const bestMembership = memberships.sort((a, b) =>
        (ROLE_PRIORITY[b.role] ?? 0) - (ROLE_PRIORITY[a.role] ?? 0)
      )[0];

      return {
        success: true,
        user: { id: user.id, name: user.name, email: user.email, role: user.role, emailVerified: user.emailVerified },
        orgSlug: bestMembership?.slug ?? null,
        orgRole: bestMembership?.role ?? null,
      };
    }),

  /** Logout */
  logout: publicProcedure.mutation(async ({ ctx }) => {
    ctx.res.setHeader("Set-Cookie", serializeCookie(COOKIE_NAME, "", 0));
    return { success: true };
  }),

  /** Get current user from custom session cookie */
  me: publicProcedure.query(async ({ ctx }) => {
    try {
      const cookieHeader = ctx.req.headers.cookie ?? "";
      const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
      if (!match) return null;

      const payload = JSON.parse(Buffer.from(decodeURIComponent(match[1]), "base64url").toString("utf8"));
      if (!payload?.userId) return null;

      const db = await getDb();
      if (!db) return null;

      const [user] = await db.select().from(users).where(eq(users.id, payload.userId)).limit(1);
      if (!user) return null;

      return { id: user.id, name: user.name, email: user.email, role: user.role, emailVerified: user.emailVerified, openId: user.openId };
    } catch {
      return null;
    }
  }),

  /** Verify email with token */
  verifyEmail: publicProcedure
    .input(z.object({ token: z.string() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [user] = await db.select().from(users)
        .where(eq(users.emailVerificationToken, input.token))
        .limit(1);

      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "Invalid or expired verification link." });
      if (user.emailVerificationExpiry && user.emailVerificationExpiry < new Date()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Verification link has expired. Please request a new one." });
      }

      await db.update(users).set({ emailVerified: true, emailVerificationToken: null, emailVerificationExpiry: null }).where(eq(users.id, user.id));
      return { success: true, message: "Email verified! You can now log in." };
    }),

  /** Resend verification email */
  resendVerification: publicProcedure
    .input(z.object({ email: z.string().email() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) return { success: true };

      const [user] = await db.select().from(users).where(eq(users.email, input.email.toLowerCase())).limit(1);
      if (!user || user.emailVerified) return { success: true };

      const verificationToken = generateToken();
      const verificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await db.update(users).set({ emailVerificationToken: verificationToken, emailVerificationExpiry: verificationExpiry }).where(eq(users.id, user.id));

      const verifyUrl = `${SITE_URL}/verify-email?token=${verificationToken}`;
      await sendEmail({ to: input.email, subject: "Verify your Teachific email address", html: verifyEmailHtml(user.name || "", verifyUrl) });
      return { success: true };
    }),

  /** Request password reset */
  forgotPassword: publicProcedure
    .input(z.object({ email: z.string().email() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) return { success: true };

      const [user] = await db.select().from(users).where(eq(users.email, input.email.toLowerCase())).limit(1);
      // Return success even if user not found (prevents email enumeration)
      if (!user) return { success: true };
      // Allow reset even for OAuth accounts (no passwordHash) so they can set a password

      const resetToken = generateToken();
      const resetExpiry = new Date(Date.now() + 60 * 60 * 1000);

      await db.update(users).set({ resetToken, resetTokenExpiry: resetExpiry }).where(eq(users.id, user.id));

      const resetUrl = `${SITE_URL}/reset-password?token=${resetToken}`;
      await sendEmail({ to: input.email, subject: "Reset your Teachific password", html: resetPasswordHtml(user.name || "", resetUrl) });
      return { success: true };
    }),

  /** Reset password with token */
  resetPassword: publicProcedure
    .input(z.object({ token: z.string(), newPassword: z.string().min(8).max(128) }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [user] = await db.select().from(users).where(eq(users.resetToken, input.token)).limit(1);
      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "Invalid or expired reset link." });
      if (user.resetTokenExpiry && user.resetTokenExpiry < new Date()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Reset link has expired. Please request a new one." });
      }

      const passwordHash = await bcrypt.hash(input.newPassword, BCRYPT_ROUNDS);
      await db.update(users).set({ passwordHash, resetToken: null, resetTokenExpiry: null, emailVerified: true }).where(eq(users.id, user.id));
      return { success: true, message: "Password updated! You can now log in." };
    }),

  /** Change password (authenticated) */
  changePassword: protectedProcedure
    .input(z.object({ currentPassword: z.string(), newPassword: z.string().min(8).max(128) }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [user] = await db.select().from(users).where(eq(users.id, ctx.user.id)).limit(1);
      if (!user?.passwordHash) throw new TRPCError({ code: "BAD_REQUEST", message: "No password set on this account." });

      const valid = await bcrypt.compare(input.currentPassword, user.passwordHash);
      if (!valid) throw new TRPCError({ code: "UNAUTHORIZED", message: "Current password is incorrect." });

      const passwordHash = await bcrypt.hash(input.newPassword, BCRYPT_ROUNDS);
      await db.update(users).set({ passwordHash }).where(eq(users.id, user.id));
      return { success: true };
    }),
});
