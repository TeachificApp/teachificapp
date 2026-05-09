import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq, desc, and, sql, gte, count } from "drizzle-orm";
import { nanoid } from "nanoid";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { sendEmail } from "./sendgrid";
import { storagePut } from "./storage";
import {
  forms, formFields, formBranchingRules, formSubmissions, orgSubscriptions,
  formSessions, formAnalyticsEvents, formIntegrations, orgThemes,
  orgMediaLibrary, formFilters, formViews, formLabels, formDocs, formScheduledExports,
  organizations,
} from "../drizzle/schema";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getFormById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(forms).where(eq(forms.id, id)).limit(1);
  return rows[0];
}

async function getFormBySlug(slug: string, orgSlug?: string) {
  const db = await getDb();
  if (!db) return undefined;
  if (orgSlug) {
    // Org-scoped lookup: join with organizations to verify org slug
    const rows = await db
      .select({ form: forms })
      .from(forms)
      .innerJoin(organizations, eq(forms.orgId, organizations.id))
      .where(and(eq(forms.slug, slug), eq(organizations.slug, orgSlug)))
      .limit(1);
    return rows[0]?.form;
  }
  const rows = await db.select().from(forms).where(eq(forms.slug, slug)).limit(1);
  return rows[0];
}

async function getFieldsByForm(formId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(formFields).where(eq(formFields.formId, formId)).orderBy(formFields.sortOrder);
}

async function getRulesByForm(formId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(formBranchingRules).where(eq(formBranchingRules.formId, formId)).orderBy(formBranchingRules.sortOrder);
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ── Subscription plan form limits ───────────────────────────────────────────
const FORM_LIMITS: Record<string, number> = {
  free: 0,
  starter: 3,
  builder: 10,
  pro: 50,
  enterprise: 200,
};

async function getOrgFormLimit(orgId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const rows = await db.select().from(orgSubscriptions).where(eq(orgSubscriptions.orgId, orgId)).limit(1);
  const plan = (rows[0]?.plan ?? "free").toLowerCase();
  return FORM_LIMITS[plan] ?? 0;
}

// ── Check if org has email workflow access (enterprise plan) ──────────────────
async function orgHasEmailAccess(orgId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const rows = await db.select().from(orgSubscriptions).where(eq(orgSubscriptions.orgId, orgId)).limit(1);
  const plan = rows[0]?.plan ?? "free";
  return ["pro", "enterprise"].includes(plan);
}

// ── Send notification email via SendGrid ──────────────────────────────────────
async function sendFormNotification(opts: {
  toEmails: string[];
  formTitle: string;
  answers: Record<string, string>;
  fields: Array<{ id: number; label: string }>;
  respondentEmail?: string;
}) {
  const rows = opts.fields
    .map((f) => `<tr><td style="padding:6px 12px;font-weight:600;color:#374151;border-bottom:1px solid #f3f4f6">${f.label}</td><td style="padding:6px 12px;color:#6b7280;border-bottom:1px solid #f3f4f6">${opts.answers[f.id] ?? "—"}</td></tr>`)
    .join("");

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#24abbc">New Form Submission</h2>
      <p style="color:#6b7280">A new response was submitted to <strong>${opts.formTitle}</strong>.</p>
      <table style="width:100%;border-collapse:collapse;margin-top:16px">${rows}</table>
      ${opts.respondentEmail ? `<p style="margin-top:16px;color:#6b7280;font-size:13px">Respondent email: ${opts.respondentEmail}</p>` : ""}
    </div>`;

  await sendEmail({
    to: opts.toEmails,
    subject: `New submission: ${opts.formTitle}`,
    html,
    replyTo: opts.respondentEmail,
  });
}

// ── Router ────────────────────────────────────────────────────────────────────

export const formsRouter = router({
  // ── List forms for an org ─────────────────────────────────────────────────
  list: protectedProcedure
    .input(z.object({ orgId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      return db.select().from(forms).where(eq(forms.orgId, input.orgId)).orderBy(desc(forms.createdAt));
    }),

  // ── Get a single form with fields and rules ───────────────────────────────
  get: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const form = await getFormById(input.id);
      if (!form) throw new TRPCError({ code: "NOT_FOUND" });
      const fields = await getFieldsByForm(form.id);
      const rules = await getRulesByForm(form.id);
      return { ...form, fields, rules };
    }),

  // ── Get form limit for org ───────────────────────────────────────────────
  getLimit: protectedProcedure
    .input(z.object({ orgId: z.number() }))
    .query(async ({ input }) => {
      const limit = await getOrgFormLimit(input.orgId);
      const db = await getDb();
      if (!db) return { limit, current: 0 };
      const rows = await db.select().from(forms).where(eq(forms.orgId, input.orgId));
      return { limit, current: rows.length };
    }),

  // ── Create a form ─────────────────────────────────────────────────────────
  create: protectedProcedure
    .input(z.object({
      orgId: z.number(),
      title: z.string().min(1),
      description: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Enforce subscription plan limit (bypassed for platform admins)
      const _isPlatformAdmin = ctx.user.role === "site_owner" || ctx.user.role === "site_admin";
      if (!_isPlatformAdmin) {
        const limit = await getOrgFormLimit(input.orgId);
        const existing = await db.select().from(forms).where(eq(forms.orgId, input.orgId));
        if (existing.length >= limit) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: `Your plan allows up to ${limit} form${limit === 1 ? "" : "s"}. Please upgrade to create more.`,
          });
        }
      }
      const baseSlug = slugify(input.title) || "form";
      const slug = `${baseSlug}-${nanoid(6)}`;
      await db.insert(forms).values({
        orgId: input.orgId,
        title: input.title,
        description: input.description ?? null,
        slug,
        status: "draft",
        submissionCount: 0,
      });
      const created = await getFormBySlug(slug);
      return created!;
    }),

  // ── Update form settings ──────────────────────────────────────────────────
  update: protectedProcedure
    .input(z.object({
      id: z.number(),
      title: z.string().min(1).optional(),
      description: z.string().optional().nullable(),
      status: z.enum(["draft", "published", "closed"]).optional(),
      notifyEmails: z.array(z.string().email()).optional(),
      notifyOrgAdmin: z.boolean().optional(),
      notifyRespondent: z.boolean().optional(),
      sendConfirmation: z.boolean().optional(),
      confirmationEmailField: z.string().optional().nullable(),
      confirmationSubject: z.string().optional().nullable(),
      confirmationBody: z.string().optional().nullable(),
      successMessage: z.string().optional().nullable(),
      redirectUrl: z.string().optional().nullable(),
      requireLogin: z.boolean().optional(),
      allowMultipleSubmissions: z.boolean().optional(),
      primaryColor: z.string().optional().nullable(),
      buttonColor: z.string().optional().nullable(),
      buttonTextColor: z.string().optional().nullable(),
      headerBgColor: z.string().optional().nullable(),
      headerTextColor: z.string().optional().nullable(),
      fontFamily: z.string().optional().nullable(),
      headerImageUrl: z.string().optional().nullable(),
      useOrgBranding: z.boolean().optional(),
      customCss: z.string().optional().nullable(),
      slug: z.string().min(1).max(200).regex(/^[a-z0-9-]+$/, "Slug may only contain lowercase letters, numbers, and hyphens").optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const { id, notifyEmails, slug, ...rest } = input;
      // Verify slug uniqueness if changing it
      if (slug) {
        const existing = await db.select({ id: forms.id }).from(forms).where(eq(forms.slug, slug)).limit(1);
        if (existing.length > 0 && existing[0].id !== id) {
          throw new TRPCError({ code: "CONFLICT", message: "This URL slug is already in use by another form." });
        }
      }
      await db.update(forms).set({
        ...rest,
        ...(slug ? { slug } : {}),
        notifyEmails: notifyEmails ? JSON.stringify(notifyEmails) : undefined,
        updatedAt: new Date(),
      }).where(eq(forms.id, id));
      return { success: true };
    }),

  // ── Delete a form ─────────────────────────────────────────────────────────
  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.delete(formBranchingRules).where(eq(formBranchingRules.formId, input.id));
      await db.delete(formSubmissions).where(eq(formSubmissions.formId, input.id));
      await db.delete(formFields).where(eq(formFields.formId, input.id));
      await db.delete(forms).where(eq(forms.id, input.id));
      return { success: true };
    }),

  // ── Duplicate a form ──────────────────────────────────────────────────────
  duplicate: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const original = await getFormById(input.id);
      if (!original) throw new TRPCError({ code: "NOT_FOUND" });
      const newSlug = `${slugify(original.title)}-copy-${nanoid(6)}`;
      await db.insert(forms).values({
        orgId: original.orgId,
        title: `${original.title} (Copy)`,
        description: original.description,
        slug: newSlug,
        status: "draft",
        notifyEmails: original.notifyEmails,
        sendConfirmation: original.sendConfirmation,
        confirmationEmailField: original.confirmationEmailField,
        confirmationSubject: original.confirmationSubject,
        confirmationBody: original.confirmationBody,
        successMessage: original.successMessage,
        redirectUrl: original.redirectUrl,
        requireLogin: original.requireLogin,
        allowMultipleSubmissions: original.allowMultipleSubmissions,
        primaryColor: original.primaryColor,
        submissionCount: 0,
      });
      const newForm = await getFormBySlug(newSlug);
      // Copy fields
      const fields = await getFieldsByForm(original.id);
      const fieldIdMap: Record<number, number> = {};
      for (const f of fields) {
        const { id, ...fData } = f;
        await db.insert(formFields).values({ ...fData, formId: newForm!.id });
        const inserted = await db.select().from(formFields)
          .where(and(eq(formFields.formId, newForm!.id), eq(formFields.sortOrder, fData.sortOrder)))
          .limit(1);
        if (inserted[0]) fieldIdMap[id] = inserted[0].id;
      }
      // Copy rules with remapped field IDs
      const rules = await getRulesByForm(original.id);
      for (const r of rules) {
        await db.insert(formBranchingRules).values({
          formId: newForm!.id,
          sourceFieldId: fieldIdMap[r.sourceFieldId] ?? r.sourceFieldId,
          operator: r.operator,
          value: r.value,
          action: r.action,
          targetFieldId: r.targetFieldId ? (fieldIdMap[r.targetFieldId] ?? r.targetFieldId) : null,
          sortOrder: r.sortOrder,
        });
      }
      return newForm!;
    }),

  // ── Fields CRUD ───────────────────────────────────────────────────────────
  fields: router({
    upsert: protectedProcedure
      .input(z.object({
        formId: z.number(),
        fields: z.array(z.object({
          id: z.number().optional(),
          type: z.string(),
          label: z.string(),
          placeholder: z.string().optional().nullable(),
          helpText: z.string().optional().nullable(),
          required: z.boolean().optional(),
          sortOrder: z.number(),
          options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
          minLength: z.number().optional().nullable(),
          maxLength: z.number().optional().nullable(),
          isBranchingSource: z.boolean().optional(),
        })),
      }))
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

        const incomingIds = input.fields.filter((f) => f.id).map((f) => f.id!);
        // Delete fields that were removed
        const existing = await getFieldsByForm(input.formId);
        for (const ef of existing) {
          if (!incomingIds.includes(ef.id)) {
            await db.delete(formBranchingRules).where(eq(formBranchingRules.sourceFieldId, ef.id));
            await db.delete(formFields).where(eq(formFields.id, ef.id));
          }
        }
        // Upsert each field
        const result: Array<{ tempId?: number; id: number }> = [];
        for (const f of input.fields) {
          const data = {
            formId: input.formId,
            type: f.type,
            label: f.label,
            placeholder: f.placeholder ?? null,
            helpText: f.helpText ?? null,
            required: f.required ?? false,
            sortOrder: f.sortOrder,
            options: f.options ? JSON.stringify(f.options) : null,
            minLength: f.minLength ?? null,
            maxLength: f.maxLength ?? null,
            isBranchingSource: f.isBranchingSource ?? false,
          };
          if (f.id) {
            await db.update(formFields).set(data).where(eq(formFields.id, f.id));
            result.push({ id: f.id });
          } else {
            await db.insert(formFields).values(data);
            const inserted = await db.select().from(formFields)
              .where(and(eq(formFields.formId, input.formId), eq(formFields.sortOrder, f.sortOrder)))
              .orderBy(desc(formFields.id))
              .limit(1);
            result.push({ id: inserted[0]?.id ?? 0 });
          }
        }
        return result;
      }),
  }),

  // ── Branching Rules CRUD ──────────────────────────────────────────────────
  rules: router({
    upsert: protectedProcedure
      .input(z.object({
        formId: z.number(),
        rules: z.array(z.object({
          id: z.number().optional(),
          sourceFieldId: z.number(),
          operator: z.enum(["equals", "not_equals", "contains", "not_contains", "is_empty", "is_not_empty"]),
          value: z.string().optional().nullable(),
          action: z.enum(["show_field", "hide_field", "jump_to_field", "submit_form"]),
          targetFieldId: z.number().optional().nullable(),
          sortOrder: z.number(),
        })),
      }))
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        // Replace all rules for this form
        await db.delete(formBranchingRules).where(eq(formBranchingRules.formId, input.formId));
        for (const r of input.rules) {
          await db.insert(formBranchingRules).values({
            formId: input.formId,
            sourceFieldId: r.sourceFieldId,
            operator: r.operator,
            value: r.value ?? null,
            action: r.action,
            targetFieldId: r.targetFieldId ?? null,
            sortOrder: r.sortOrder,
          });
        }
        return { success: true };
      }),
  }),

  // ── Submissions ───────────────────────────────────────────────────────────
  submissions: router({
    list: protectedProcedure
      .input(z.object({ formId: z.number() }))
      .query(async ({ input }) => {
        const db = await getDb();
        if (!db) return [];
        return db.select().from(formSubmissions)
          .where(eq(formSubmissions.formId, input.formId))
          .orderBy(desc(formSubmissions.submittedAt));
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        await db.delete(formSubmissions).where(eq(formSubmissions.id, input.id));
        return { success: true };
      }),
  }),

  // ── Public: get published form by slug (for the form player) ─────────────
  publicGet: publicProcedure
    .input(z.object({ slug: z.string(), orgSlug: z.string().optional() }))
    .query(async ({ input }) => {
      const form = await getFormBySlug(input.slug, input.orgSlug);
      if (!form || form.status !== "published") return null;
      const fields = await getFieldsByForm(form.id);
      const rules = await getRulesByForm(form.id);
      // Fetch org branding defaults from orgThemes
      let orgPrimaryColor: string | null = null;
      let orgFontFamily: string | null = null;
      if (form.orgId) {
        const db = await getDb();
        if (db) {
          const [themeRow] = await db.select().from(orgThemes).where(eq(orgThemes.orgId, form.orgId)).limit(1);
          orgPrimaryColor = themeRow?.primaryColor ?? null;
          orgFontFamily = themeRow?.fontFamily ?? null;
        }
      }
      // Don't expose internal email config to the public
      return {
        id: form.id,
        title: form.title,
        description: form.description,
        slug: form.slug,
        requireLogin: form.requireLogin,
        allowMultipleSubmissions: form.allowMultipleSubmissions,
        successMessage: form.successMessage,
        redirectUrl: form.redirectUrl,
        // branding
        primaryColor: form.primaryColor,
        buttonColor: form.buttonColor,
        buttonTextColor: form.buttonTextColor,
        headerBgColor: form.headerBgColor,
        headerTextColor: form.headerTextColor,
        fontFamily: form.fontFamily,
        headerImageUrl: form.headerImageUrl,
        useOrgBranding: form.useOrgBranding,
        customCss: form.customCss,
        orgPrimaryColor,
        orgFontFamily,
        fields: fields.map((f) => ({
          id: f.id,
          type: f.type,
          label: f.label,
          placeholder: f.placeholder,
          helpText: f.helpText,
          required: f.required,
          sortOrder: f.sortOrder,
          options: f.options ? JSON.parse(f.options) : [],
          isBranchingSource: f.isBranchingSource,
          isHidden: f.isHidden ?? false,
          memberVarName: f.memberVarName ?? null,
        })),
        rules: rules.map((r) => ({
          id: r.id,
          sourceFieldId: r.sourceFieldId,
          operator: r.operator,
          value: r.value,
          action: r.action,
          targetFieldId: r.targetFieldId,
        })),
      };
    }),

  // ── Public: submit a form response ───────────────────────────────────────
  publicSubmit: publicProcedure
    .input(z.object({
      formId: z.number(),
      answers: z.record(z.string(), z.any()),
      respondentEmail: z.string().email().optional(),
      respondentName: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const form = await getFormById(input.formId);
      if (!form || form.status !== "published") {
        throw new TRPCError({ code: "NOT_FOUND", message: "Form not found or not accepting submissions" });
      }

      // Store submission
      await db.insert(formSubmissions).values({
        formId: input.formId,
        userId: (ctx.user as any)?.id ?? null,
        respondentEmail: input.respondentEmail ?? null,
        respondentName: input.respondentName ?? null,
        answers: JSON.stringify(input.answers),
        ipAddress: ctx.req.ip ?? null,
        userAgent: ctx.req.headers["user-agent"] ?? null,
      });

      // Increment counter
      await db.update(forms)
        .set({ submissionCount: (form.submissionCount ?? 0) + 1, updatedAt: new Date() })
        .where(eq(forms.id, input.formId));

      // Email notifications (if configured)
      const notifyEmails: string[] = form.notifyEmails ? JSON.parse(form.notifyEmails) : [];
      if (notifyEmails.length > 0) {
        const fields = await getFieldsByForm(input.formId);
        const answersRecord: Record<string, string> = {};
        for (const [k, v] of Object.entries(input.answers)) {
          answersRecord[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
        }
        await sendFormNotification({
          toEmails: notifyEmails,
          formTitle: form.title,
          answers: answersRecord,
          fields: fields.map((f) => ({ id: f.id, label: f.label })),
          respondentEmail: input.respondentEmail,
        });
      }

      return { success: true, message: form.successMessage ?? "Thank you for your response!" };
    }),

  // ── Check if org has email routing access ────────────────────────────────
  emailAccessCheck: protectedProcedure
    .input(z.object({ orgId: z.number() }))
    .query(async ({ input }) => {
      const hasAccess = await orgHasEmailAccess(input.orgId);
      return { hasAccess };
    }),

  // ── Branding ──────────────────────────────────────────────────────────────
  branding: router({
    // Get org defaults for branding
    orgDefaults: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const rows = await db.select().from(orgThemes).where(eq(orgThemes.orgId, input.orgId)).limit(1);
        const theme = rows[0];
        return {
          primaryColor: theme?.primaryColor ?? "#24abbc",
          accentColor: theme?.accentColor ?? "#4ad9e0",
          fontFamily: theme?.fontFamily ?? "Inter",
          logoUrl: theme?.adminLogoUrl ?? null,
          schoolName: theme?.schoolName ?? null,
        };
      }),

    // Upload header image for a form
    uploadHeaderImage: protectedProcedure
      .input(z.object({
        formId: z.number(),
        base64: z.string(), // data:image/...;base64,...
        mimeType: z.string(),
        fileName: z.string(),
      }))
      .mutation(async ({ input, ctx }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        // Decode base64
        const base64Data = input.base64.replace(/^data:[^;]+;base64,/, "");
        const buffer = Buffer.from(base64Data, "base64");
        const key = `form-headers/${ctx.user.id}/${input.formId}-${Date.now()}-${input.fileName}`;
        const { url } = await storagePut(key, buffer, input.mimeType);
        // Save to form
        await db.update(forms).set({ headerImageUrl: url }).where(eq(forms.id, input.formId));
        return { url };
      }),
  }),

  // ── Sessions & Analytics tracking ─────────────────────────────────────────
  sessions: router({
    start: publicProcedure
      .input(z.object({
        formId: z.number(),
        sessionToken: z.string(),
        memberVars: z.record(z.string(), z.string()).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const db = await getDb();
        if (!db) return { sessionId: 0 };
        const [result] = await db.insert(formSessions).values({
          formId: input.formId,
          sessionToken: input.sessionToken,
          userId: ctx.user?.id ?? null,
          memberVars: input.memberVars ? JSON.stringify(input.memberVars) : null,
        });
        const sessionId = (result as any).insertId as number;
        // Log form_start event
        await db.insert(formAnalyticsEvents).values({
          formId: input.formId,
          sessionId,
          event: "form_start",
        });
        return { sessionId };
      }),

    fieldView: publicProcedure
      .input(z.object({
        formId: z.number(),
        sessionId: z.number(),
        fieldId: z.number(),
      }))
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) return;
        await db.insert(formAnalyticsEvents).values({
          formId: input.formId,
          sessionId: input.sessionId,
          fieldId: input.fieldId,
          event: "field_view",
        });
      }),

    complete: publicProcedure
      .input(z.object({
        formId: z.number(),
        sessionId: z.number(),
        durationSeconds: z.number().optional(),
      }))
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) return;
        await db.update(formSessions)
          .set({ completed: true, completedAt: new Date(), durationSeconds: input.durationSeconds ?? null })
          .where(eq(formSessions.id, input.sessionId));
        await db.insert(formAnalyticsEvents).values({
          formId: input.formId,
          sessionId: input.sessionId,
          event: "form_complete",
        });
      }),

    dropout: publicProcedure
      .input(z.object({
        formId: z.number(),
        sessionId: z.number(),
        fieldId: z.number().optional(),
        durationSeconds: z.number().optional(),
      }))
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) return;
        await db.update(formSessions)
          .set({ droppedAtFieldId: input.fieldId ?? null, durationSeconds: input.durationSeconds ?? null })
          .where(eq(formSessions.id, input.sessionId));
      }),
  }),

  // ── Analytics ─────────────────────────────────────────────────────────────
  analytics: router({
    summary: protectedProcedure
      .input(z.object({ formId: z.number() }))
      .query(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const sessions = await db.select().from(formSessions).where(eq(formSessions.formId, input.formId));
        const total = sessions.length;
        const completed = sessions.filter(s => s.completed).length;
        const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;
        const durations = sessions.filter(s => s.durationSeconds != null && s.completed).map(s => s.durationSeconds!);
        const avgDuration = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
        // Drop-off field
        const dropCounts: Record<number, number> = {};
        for (const s of sessions) {
          if (!s.completed && s.droppedAtFieldId) {
            dropCounts[s.droppedAtFieldId] = (dropCounts[s.droppedAtFieldId] ?? 0) + 1;
          }
        }
        const topDropFieldId = Object.entries(dropCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
        return { total, completed, completionRate, avgDuration, topDropFieldId: topDropFieldId ? parseInt(topDropFieldId) : null };
      }),

    fieldDropoff: protectedProcedure
      .input(z.object({ formId: z.number() }))
      .query(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        // Get all field_view events grouped by fieldId
        const events = await db.select().from(formAnalyticsEvents)
          .where(and(eq(formAnalyticsEvents.formId, input.formId), eq(formAnalyticsEvents.event, "field_view")));
        const viewCounts: Record<number, number> = {};
        for (const e of events) {
          if (e.fieldId) viewCounts[e.fieldId] = (viewCounts[e.fieldId] ?? 0) + 1;
        }
        // Get drop-off counts per field
        const sessions = await db.select().from(formSessions)
          .where(and(eq(formSessions.formId, input.formId)));
        const dropCounts: Record<number, number> = {};
        for (const s of sessions) {
          if (!s.completed && s.droppedAtFieldId) {
            dropCounts[s.droppedAtFieldId] = (dropCounts[s.droppedAtFieldId] ?? 0) + 1;
          }
        }
        return { viewCounts, dropCounts };
      }),

    timeSeries: protectedProcedure
      .input(z.object({ formId: z.number(), days: z.number().default(30) }))
      .query(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const since = new Date(Date.now() - input.days * 24 * 60 * 60 * 1000);
        const sessions = await db.select().from(formSessions)
          .where(and(eq(formSessions.formId, input.formId), gte(formSessions.startedAt, since)));
        // Group by date
        const starts: Record<string, number> = {};
        const completions: Record<string, number> = {};
        for (const s of sessions) {
          const d = s.startedAt.toISOString().slice(0, 10);
          starts[d] = (starts[d] ?? 0) + 1;
          if (s.completed) completions[d] = (completions[d] ?? 0) + 1;
        }
        // Build ordered array for last N days
        const result: Array<{ date: string; starts: number; completions: number }> = [];
        for (let i = input.days - 1; i >= 0; i--) {
          const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
          result.push({ date: d, starts: starts[d] ?? 0, completions: completions[d] ?? 0 });
        }
        return result;
      }),
  }),

  // ── Integrations ──────────────────────────────────────────────────────────
  integrations: router({
    list: protectedProcedure
      .input(z.object({ formId: z.number() }))
      .query(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        return db.select().from(formIntegrations).where(eq(formIntegrations.formId, input.formId));
      }),

    upsert: protectedProcedure
      .input(z.object({
        formId: z.number(),
        integrations: z.array(z.object({
          id: z.number().optional(),
          type: z.enum(["course", "custom_page", "landing_page"]),
          targetId: z.number().optional(),
          targetUrl: z.string().optional(),
          triggerOn: z.enum(["on_submit", "on_completion"]).default("on_submit"),
          action: z.enum(["enroll", "redirect", "tag", "embed"]),
          label: z.string().optional(),
          sortOrder: z.number().default(0),
        })),
      }))
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        // Delete existing and re-insert
        await db.delete(formIntegrations).where(eq(formIntegrations.formId, input.formId));
        if (input.integrations.length > 0) {
          await db.insert(formIntegrations).values(
            input.integrations.map((ig, i) => ({
              formId: input.formId,
              type: ig.type,
              targetId: ig.targetId ?? null,
              targetUrl: ig.targetUrl ?? null,
              triggerOn: ig.triggerOn,
              action: ig.action,
              label: ig.label ?? null,
              sortOrder: i,
            }))
          );
        }
        return { success: true };
      }),
  }),

  // ── Member variable resolution ────────────────────────────────────────────
  memberVars: router({
    resolve: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ ctx }) => {
        const user = ctx.user;
        return {
          name: user.name ?? "",
          email: user.email ?? "",
          userId: String(user.id),
        };
      }),
  }),

  // ── Media Library ─────────────────────────────────────────────────────────
  media: router({
    list: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        mimeType: z.string().optional(), // filter by mime prefix e.g. "image/"
        tag: z.string().optional(),
        page: z.number().default(1),
        pageSize: z.number().default(30),
      }))
      .query(async ({ input }) => {
        const db = await getDb();
        if (!db) return { items: [], total: 0 };
        let q = db.select().from(orgMediaLibrary).where(eq(orgMediaLibrary.orgId, input.orgId));
        const rows = await q.orderBy(desc(orgMediaLibrary.createdAt));
        let filtered = rows;
        if (input.mimeType) filtered = filtered.filter(r => r.mimeType.startsWith(input.mimeType!));
        if (input.tag) filtered = filtered.filter(r => {
          const tags: string[] = r.tags ? JSON.parse(r.tags) : [];
          return tags.includes(input.tag!);
        });
        const total = filtered.length;
        const start = (input.page - 1) * input.pageSize;
        return { items: filtered.slice(start, start + input.pageSize), total };
      }),

    upload: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        base64: z.string(),
        mimeType: z.string(),
        filename: z.string(),
        altText: z.string().optional(),
        tags: z.array(z.string()).optional(),
        source: z.enum(["form", "course", "direct", "other"]).default("direct"),
        sourceId: z.number().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const base64Data = input.base64.replace(/^data:[^;]+;base64,/, "");
        const buffer = Buffer.from(base64Data, "base64");
        const ext = input.filename.split(".").pop() ?? "bin";
        const key = `org-media/${input.orgId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        const { url } = await storagePut(key, buffer, input.mimeType);
        const [result] = await db.insert(orgMediaLibrary).values({
          orgId: input.orgId,
          uploadedBy: ctx.user.id,
          filename: input.filename,
          mimeType: input.mimeType,
          fileSize: buffer.length,
          fileKey: key,
          url,
          altText: input.altText ?? null,
          tags: input.tags ? JSON.stringify(input.tags) : null,
          source: input.source,
          sourceId: input.sourceId ?? null,
        });
        const id = (result as any).insertId as number;
        const rows = await db.select().from(orgMediaLibrary).where(eq(orgMediaLibrary.id, id)).limit(1);
        return rows[0];
      }),

    updateTags: protectedProcedure
      .input(z.object({ id: z.number(), tags: z.array(z.string()), altText: z.string().optional() }))
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        await db.update(orgMediaLibrary)
          .set({ tags: JSON.stringify(input.tags), altText: input.altText ?? null, updatedAt: new Date() })
          .where(eq(orgMediaLibrary.id, input.id));
        return { success: true };
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        await db.delete(orgMediaLibrary).where(eq(orgMediaLibrary.id, input.id));
        return { success: true };
      }),
  }),

  // ── Results Filters ───────────────────────────────────────────────────────
  filters: router({
    list: protectedProcedure
      .input(z.object({ formId: z.number() }))
      .query(async ({ input }) => {
        const db = await getDb();
        if (!db) return [];
        return db.select().from(formFilters).where(eq(formFilters.formId, input.formId)).orderBy(formFilters.name);
      }),

    save: protectedProcedure
      .input(z.object({
        id: z.number().optional(),
        formId: z.number(),
        name: z.string().min(1),
        conditions: z.array(z.object({
          fieldId: z.number(),
          operator: z.string(), // "equals"|"contains"|"not_equals"|"is_empty"|"is_not_empty"
          value: z.string().optional(),
        })),
      }))
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const conditionsJson = JSON.stringify(input.conditions);
        if (input.id) {
          await db.update(formFilters)
            .set({ name: input.name, conditions: conditionsJson, updatedAt: new Date() })
            .where(eq(formFilters.id, input.id));
          return { id: input.id };
        }
        const [r] = await db.insert(formFilters).values({
          formId: input.formId,
          name: input.name,
          conditions: conditionsJson,
        });
        return { id: (r as any).insertId as number };
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        await db.delete(formFilters).where(eq(formFilters.id, input.id));
        return { success: true };
      }),
  }),

  // ── Results Views ─────────────────────────────────────────────────────────
  views: router({
    list: protectedProcedure
      .input(z.object({ formId: z.number() }))
      .query(async ({ input }) => {
        const db = await getDb();
        if (!db) return [];
        return db.select().from(formViews).where(eq(formViews.formId, input.formId)).orderBy(formViews.name);
      }),

    save: protectedProcedure
      .input(z.object({
        id: z.number().optional(),
        formId: z.number(),
        name: z.string().min(1),
        visibleFieldIds: z.array(z.number()),
      }))
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const json = JSON.stringify(input.visibleFieldIds);
        if (input.id) {
          await db.update(formViews).set({ name: input.name, visibleFieldIds: json, updatedAt: new Date() }).where(eq(formViews.id, input.id));
          return { id: input.id };
        }
        const [r] = await db.insert(formViews).values({ formId: input.formId, name: input.name, visibleFieldIds: json });
        return { id: (r as any).insertId as number };
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        await db.delete(formViews).where(eq(formViews.id, input.id));
        return { success: true };
      }),
  }),

  // ── Results Labels ────────────────────────────────────────────────────────
  labels: router({
    list: protectedProcedure
      .input(z.object({ formId: z.number() }))
      .query(async ({ input }) => {
        const db = await getDb();
        if (!db) return [];
        return db.select().from(formLabels).where(eq(formLabels.formId, input.formId));
      }),

    save: protectedProcedure
      .input(z.object({
        formId: z.number(),
        fieldId: z.number(),
        customLabel: z.string(),
      }))
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        // Upsert
        const existing = await db.select().from(formLabels)
          .where(and(eq(formLabels.formId, input.formId), eq(formLabels.fieldId, input.fieldId)))
          .limit(1);
        if (existing[0]) {
          await db.update(formLabels).set({ customLabel: input.customLabel, updatedAt: new Date() }).where(eq(formLabels.id, existing[0].id));
        } else {
          await db.insert(formLabels).values({ formId: input.formId, fieldId: input.fieldId, customLabel: input.customLabel });
        }
        return { success: true };
      }),
  }),

  // ── Results Docs ──────────────────────────────────────────────────────────
  docs: router({
    list: protectedProcedure
      .input(z.object({ formId: z.number() }))
      .query(async ({ input }) => {
        const db = await getDb();
        if (!db) return [];
        return db.select().from(formDocs).where(eq(formDocs.formId, input.formId)).orderBy(formDocs.name);
      }),

    save: protectedProcedure
      .input(z.object({
        id: z.number().optional(),
        formId: z.number(),
        name: z.string().min(1),
        docType: z.string().default("merged_pdf"),
        template: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        if (input.id) {
          await db.update(formDocs).set({ name: input.name, docType: input.docType, template: input.template ?? null, updatedAt: new Date() }).where(eq(formDocs.id, input.id));
          return { id: input.id };
        }
        const [r] = await db.insert(formDocs).values({ formId: input.formId, name: input.name, docType: input.docType, template: input.template ?? null });
        return { id: (r as any).insertId as number };
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        await db.delete(formDocs).where(eq(formDocs.id, input.id));
        return { success: true };
      }),
  }),

  // ── Scheduled Exports ─────────────────────────────────────────────────────
  scheduledExports: router({
    list: protectedProcedure
      .input(z.object({ formId: z.number() }))
      .query(async ({ input }) => {
        const db = await getDb();
        if (!db) return [];
        return db.select().from(formScheduledExports).where(eq(formScheduledExports.formId, input.formId)).orderBy(formScheduledExports.name);
      }),

    save: protectedProcedure
      .input(z.object({
        id: z.number().optional(),
        formId: z.number(),
        name: z.string().min(1),
        frequency: z.enum(["daily", "weekly", "monthly"]).default("weekly"),
        dayValue: z.number().optional(),
        hourUtc: z.number().default(8),
        deliveryEmail: z.string().email(),
        format: z.enum(["csv", "xlsx"]).default("csv"),
        filterId: z.number().optional(),
        isActive: z.boolean().default(true),
      }))
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const vals = {
          formId: input.formId,
          name: input.name,
          frequency: input.frequency,
          dayValue: input.dayValue ?? null,
          hourUtc: input.hourUtc,
          deliveryEmail: input.deliveryEmail,
          format: input.format,
          filterId: input.filterId ?? null,
          isActive: input.isActive,
        };
        if (input.id) {
          await db.update(formScheduledExports).set({ ...vals, updatedAt: new Date() }).where(eq(formScheduledExports.id, input.id));
          return { id: input.id };
        }
        const [r] = await db.insert(formScheduledExports).values(vals);
        return { id: (r as any).insertId as number };
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        await db.delete(formScheduledExports).where(eq(formScheduledExports.id, input.id));
        return { success: true };
      }),
  }),

  // ── Export (immediate download) ───────────────────────────────────────────
  exportResults: protectedProcedure
    .input(z.object({
      formId: z.number(),
      format: z.enum(["csv", "xlsx"]).default("csv"),
      filterId: z.number().optional(),
      dateFrom: z.string().optional(), // ISO date string
      dateTo: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const form = await getFormById(input.formId);
      if (!form) throw new TRPCError({ code: "NOT_FOUND" });
      const fields = await getFieldsByForm(input.formId);

      let submissions = await db.select().from(formSubmissions)
        .where(eq(formSubmissions.formId, input.formId))
        .orderBy(desc(formSubmissions.submittedAt));

      // Date filter
      if (input.dateFrom) {
        const from = new Date(input.dateFrom);
        submissions = submissions.filter(s => s.submittedAt >= from);
      }
      if (input.dateTo) {
        const to = new Date(input.dateTo);
        to.setHours(23, 59, 59, 999);
        submissions = submissions.filter(s => s.submittedAt <= to);
      }

      // Field filter
      if (input.filterId) {
        const filterRows = await db.select().from(formFilters).where(eq(formFilters.id, input.filterId)).limit(1);
        if (filterRows[0]) {
          const conditions: Array<{ fieldId: number; operator: string; value?: string }> = JSON.parse(filterRows[0].conditions);
          submissions = submissions.filter(sub => {
            const answers: Record<string, string> = sub.answers ? JSON.parse(sub.answers) : {};
            return conditions.every(cond => {
              const val = answers[cond.fieldId] ?? "";
              switch (cond.operator) {
                case "equals": return val === (cond.value ?? "");
                case "not_equals": return val !== (cond.value ?? "");
                case "contains": return val.toLowerCase().includes((cond.value ?? "").toLowerCase());
                case "is_empty": return !val;
                case "is_not_empty": return !!val;
                default: return true;
              }
            });
          });
        }
      }

      // Build CSV
      const headers = ["Reference #", "Submitted At", "Respondent Email", "Respondent Name", ...fields.map(f => f.label)];
      const rows = submissions.map((sub, i) => {
        const answers: Record<string, string> = sub.answers ? JSON.parse(sub.answers) : {};
        return [
          String(10000000 + i + 1),
          sub.submittedAt.toISOString(),
          sub.respondentEmail ?? "",
          sub.respondentName ?? "",
          ...fields.map(f => answers[f.id] ?? ""),
        ];
      });

      const csvLines = [headers, ...rows].map(row =>
        row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(",")
      );
      const csv = csvLines.join("\n");

      return { csv, filename: `${form.title.replace(/[^a-z0-9]/gi, "_")}_results.csv`, count: submissions.length };
    }),

  // ── Import submissions from CSV ───────────────────────────────────────────
  importResults: protectedProcedure
    .input(z.object({
      formId: z.number(),
      // CSV content as string
      csv: z.string(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const lines = input.csv.split("\n").filter(Boolean);
      if (lines.length < 2) return { imported: 0 };
      const headers = lines[0].split(",").map(h => h.replace(/^"|"$/g, "").trim());
      let imported = 0;
      for (const line of lines.slice(1)) {
        const cells = line.split(",").map(c => c.replace(/^"|"$/g, "").trim());
        const answers: Record<string, string> = {};
        headers.forEach((h, i) => { answers[h] = cells[i] ?? ""; });
        await db.insert(formSubmissions).values({
          formId: input.formId,
          answers: JSON.stringify(answers),
          respondentEmail: answers["Respondent Email"] || null,
          respondentName: answers["Respondent Name"] || null,
        });
        imported++;
      }
      return { imported };
    }),

  // ── Delete all results ────────────────────────────────────────────────────
  deleteAllResults: protectedProcedure
    .input(z.object({ formId: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.delete(formSubmissions).where(eq(formSubmissions.formId, input.formId));
      await db.update(forms).set({ submissionCount: 0, updatedAt: new Date() }).where(eq(forms.id, input.formId));
      return { success: true };
    }),

  // ── Notification settings update ──────────────────────────────────────────
  updateNotifications: protectedProcedure
    .input(z.object({
      formId: z.number(),
      notifyOrgAdmin: z.boolean().optional(),
      notifyRespondent: z.boolean().optional(),
      notifyEmails: z.array(z.string().email()).optional(),
      confirmationSubject: z.string().optional(),
      confirmationBody: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const { formId, notifyEmails, ...rest } = input;
      await db.update(forms).set({
        ...rest,
        notifyEmails: notifyEmails !== undefined ? JSON.stringify(notifyEmails) : undefined,
        updatedAt: new Date(),
      }).where(eq(forms.id, formId));
      return { success: true };
    }),

  // ── Import form fields from a URL (LLM-powered scraper) ───────────────────
  importFromUrl: protectedProcedure
    .input(z.object({ url: z.string().url() }))
    .mutation(async ({ input }) => {
      // Fetch the page HTML
      let html = "";
      try {
        const res = await fetch(input.url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; TeachificBot/1.0)" },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        html = await res.text();
      } catch (e: any) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Could not fetch URL: ${e.message}` });
      }

      // Strip scripts/styles/tags and truncate to 40k chars for LLM
      const stripped = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40000);

      const { invokeLLM } = await import("./_core/llm");
      const result = await invokeLLM({
        messages: [
          {
            role: "system",
            content: "You are a form extraction assistant. Given the text content of a web page that contains a form, extract all form fields and return them as a JSON object. Only extract actual user-input fields (text, email, phone, number, textarea, select/dropdown, radio, checkbox, date, file, url, rating). Do NOT include submit buttons or hidden fields.",
          },
          {
            role: "user",
            content: `Extract all form fields from this page content:\n\n${stripped}`,
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "form_extraction",
            strict: true,
            schema: {
              type: "object",
              properties: {
                title: { type: "string", description: "The form title or page title" },
                description: { type: "string", description: "A brief description of the form's purpose" },
                fields: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      type: { type: "string", enum: ["text", "email", "phone", "number", "textarea", "select", "radio", "checkbox", "date", "file", "url", "rating", "section"] },
                      label: { type: "string" },
                      placeholder: { type: "string" },
                      required: { type: "boolean" },
                      options: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: { value: { type: "string" }, label: { type: "string" } },
                          required: ["value", "label"],
                          additionalProperties: false,
                        },
                      },
                    },
                    required: ["type", "label", "required", "options"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["title", "description", "fields"],
              additionalProperties: false,
            },
          },
        },
      });

      const content = result?.choices?.[0]?.message?.content;
      if (!content) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "LLM returned no content" });

      let parsed: any;
      try {
        parsed = typeof content === "string" ? JSON.parse(content) : content;
      } catch {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not parse LLM response" });
      }

      return {
        title: parsed.title ?? "",
        description: parsed.description ?? "",
        fields: (parsed.fields ?? []).map((f: any, i: number) => ({
          type: f.type ?? "text",
          label: f.label ?? `Field ${i + 1}`,
          placeholder: f.placeholder ?? "",
          required: f.required ?? false,
          options: (f.options ?? []).map((o: any) => ({ value: String(o.value), label: String(o.label) })),
          sortOrder: i,
        })),
      };
    }),
});
