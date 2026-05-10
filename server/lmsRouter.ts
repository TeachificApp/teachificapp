import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import {
  getCoursesByOrg,
  reorderCourses,
  getCourseById,
  getCourseWithInstructor,
  getCourseBySlug,
  createCourse,
  updateCourse,
  deleteCourse,
  getSectionsByCourse,
  createSection,
  updateSection,
  deleteSection,
  reorderSections,
  getLessonById,
  createLesson,
  updateLesson,
  deleteLesson,
  reorderLessons,
  getFullCurriculum,
  getPricingByCourse,
  createPricing,
  updatePricing,
  deletePricing,
  getEnrollmentsByUser,
  getEnrollmentsByCourse,
  getEnrollment,
  createEnrollment,
  updateEnrollmentProgress,
  getAllLessonProgress,
  upsertLessonProgress,
  getOrgTheme,
  upsertOrgTheme,
  getOrgSubscription,
  upsertOrgSubscription,
  getPagesByOrg,
  getPageById,
  getPageByCourse,
  getPublishedPageBySlug,
  createPage,
  updatePage,
  deletePage,
  duplicatePage,
  getInstructorsByOrg,
  upsertInstructor,
  updateInstructorById,
  deleteInstructorById,
  getCouponsByOrg,
  getCouponByCode,
  createCoupon,
  updateCoupon,
  getReviewsByCourse,
  createReview,
  getCertificatesByUser,
  getLmsAnalyticsByOrg,
  getDashboardMetrics,
  getRevenueChartData,
  getRecentActivity,
  getRecentlyEditedCourses,
  getEnrolledCoursesForUser,
  getCertificateByEnrollment,
  createCertificate,
  getFlashcardDecksByOrg,
  getFlashcardDeckById,
  createFlashcardDeck,
  updateFlashcardDeck,
  deleteFlashcardDeck,
  getCardsByDeck,
  bulkUpsertCards,
} from "./lmsDb";
import { getOrgById, getOrgMember, getDb, getOrgBySlug } from "./db";
import {
  listDigitalProducts,
  getDigitalProduct,
  getDigitalProductBySlug,
  createDigitalProduct,
  updateDigitalProduct,
  deleteDigitalProduct,
  listProductPrices,
  upsertProductPrice,
  deleteProductPrice,
  createDigitalOrder,
  markOrderPaid,
  getOrderByToken,
  getOrderById,
  listOrdersForProduct,
  listOrdersForOrg,
  incrementDownloadCount,
  logDownload,
  listDownloadLogs,
  listDownloadLogsForOrder,
  updateOrderStatus,
  getWebinarsByOrg,
  getWebinarById,
  getPublishedWebinarBySlug,
  createWebinar,
  updateWebinar,
  deleteWebinar,
  getWebinarRegistrations,
  getWebinarRegistrationByEmail,
  createWebinarRegistration,
  updateWebinarRegistration,
  createWebinarSession,
  getWebinarSessionByToken,
  updateWebinarSession,
  getWebinarFunnelSteps,
  upsertWebinarFunnelSteps,
  getWebinarStats,
  listEmailCampaigns,
  getEmailCampaignById,
  createEmailCampaign,
  updateEmailCampaign,
  deleteEmailCampaign,
  getEmailCampaignStats,
  getMembersWithEnrollments,
  getCategoriesByOrg,
  getCategoryById,
  createCategory,
  updateCategory,
  deleteCategory,
  getCourseCategories,
  setCourseCategories,
  getGroupsByOrg,
  getGroupById,
  createGroup,
  updateGroup,
  deleteGroup,
  getGroupMembers,
  addGroupMember,
  removeGroupMember,
  getGroupsByManager,
  getGroupMemberById,
  getDiscussionsByOrg,
  getDiscussionById,
  createDiscussion,
  updateDiscussion,
  deleteDiscussion,
  getRepliesByDiscussion,
  createDiscussionReply,
  deleteDiscussionReply,
  getAssignmentsByOrg,
  getAssignmentById,
  createAssignment,
  updateAssignment,
  deleteAssignment,
  getSubmissionsByAssignment,
  createSubmission,
  gradeSubmission,
  getCertificateTemplatesByOrg,
  getCertificateTemplateById,
  createCertificateTemplate,
  updateCertificateTemplate,
  deleteCertificateTemplate,
  getAffiliatesByOrg,
  getAffiliateById,
  createAffiliate,
  updateAffiliate,
  deleteAffiliate,
  getRevenuePartnersByOrg,
  getRevenuePartnerById,
  createRevenuePartner,
  updateRevenuePartner,
  deleteRevenuePartner,
  getCourseOrdersByOrg,
  getCourseOrderById,
  createCourseOrder,
  updateCourseOrder,
  getCourseOrderStats,
  getMembershipsByOrg,
  getMembershipById,
  createMembership,
  updateMembership,
  deleteMembership,
  getMembershipMembers,
  addMembershipMember,
  updateMembershipMember,
  removeMembershipMember,
  getMembershipContentItems,
  addMembershipContent,
  removeMembershipContent,
  getMembershipRules,
  addMembershipRule,
  updateMembershipRule,
  removeMembershipRule,
  getBundlesByOrg,
  getBundleById,
  createBundle,
  updateBundle,
  deleteBundle,
} from "./lmsDb";
import { copyCourse, copyLessonToSection, copySectionToCourse } from "./lmsDbCopy";
import { nanoid } from "nanoid";
import { invokeLLM } from "./_core/llm";
import { sanitizeAiCoursePayload } from "./aiCourseSanitizer";
import { storagePut } from "./storage";
import { transcribeAudio } from "./_core/voiceTranscription";
import { getLimits } from "../shared/tierLimits";
import { sendEmail, resolveMergeTags, buildUnsubscribeToken } from "./sendgrid";
import { courseEnrollmentHtml, groupManagerAssignmentHtml, certificateCompletionHtml, dripUnlockHtml } from "./emailTemplates";
import { getOrgMembers, getUserById } from "./db";
import { generateCertificatePdf, shouldShowTeachificBranding } from "./certificateGenerator";

// ─── Role helpers ────────────────────────────────────────────────────────────

async function requireOrgRole(
  userId: number,
  orgId: number,
  allowedRoles: string[] = ["org_super_admin", "org_admin", "sub_admin", "instructor"],
  userRole?: string
) {
  // Platform admins (site_owner, site_admin) can access any org without being a member
  if (userRole === "site_owner" || userRole === "site_admin") {
    // Return a synthetic member object so callers don't need to handle null
    return { userId, orgId, role: "org_admin" as const, createdAt: new Date() };
  }
  // org_super_admin has full access ONLY to their own org(s) — must verify membership
  const member = await getOrgMember(orgId, userId);
  if (userRole === "org_super_admin") {
    // Must be a member of this specific org
    if (!member) {
      throw new TRPCError({ code: "FORBIDDEN", message: "You do not have access to this organization" });
    }
    return { userId, orgId, role: "org_admin" as const, createdAt: new Date() };
  }
  // Also accept org_super_admin at the member level (belt-and-suspenders)
  if (!member || !(["org_super_admin", ...allowedRoles]).includes(member.role)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Insufficient permissions" });
  }
  return member;
}

async function requireOrgAdmin(userId: number, orgId: number, userRole?: string) {
  return requireOrgRole(userId, orgId, ["org_super_admin", "org_admin", "sub_admin"], userRole);
}

// ─── Router ──────────────────────────────────────────────────────────────────

// ── Auto-enrollment helper ──────────────────────────────────────────────────
async function autoEnrollMemberIfEnabled(orgId: number, userId: number): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    const { orgPaymentSettings, courses: coursesTable } = await import("../drizzle/schema");
    const { and, inArray } = await import("drizzle-orm");
    const [paySettings] = await db
      .select({ autoEnroll: orgPaymentSettings.autoEnrollNewMembers, courseIds: orgPaymentSettings.autoEnrollCourseIds })
      .from(orgPaymentSettings)
      .where(eq(orgPaymentSettings.orgId, orgId))
      .limit(1);
    if (!paySettings?.autoEnroll) return;
    let courseIds: number[] = [];
    if (paySettings.courseIds) {
      try { courseIds = JSON.parse(paySettings.courseIds as string); } catch { courseIds = []; }
    }
    // If specific course IDs are set, use them; otherwise enroll in all published courses
    let targetCourses: { id: number }[];
    if (courseIds.length > 0) {
      targetCourses = await db
        .select({ id: coursesTable.id })
        .from(coursesTable)
        .where(and(eq(coursesTable.orgId, orgId), inArray(coursesTable.id, courseIds)));
    } else {
      targetCourses = await db
        .select({ id: coursesTable.id })
        .from(coursesTable)
        .where(and(eq(coursesTable.orgId, orgId), inArray(coursesTable.status, ["published", "hidden"])));
    }
    const enrolledCourseTitles: string[] = [];
    for (const course of targetCourses) {
      const existing = await getEnrollment(course.id, userId);
      if (!existing) {
        await createEnrollment({ courseId: course.id, userId, orgId, amountPaid: 0 });
        const fullCourse = await getCourseById(course.id);
        if (fullCourse) enrolledCourseTitles.push(fullCourse.title);
      }
    }
    // Send enrollment confirmation email
    if (enrolledCourseTitles.length > 0) {
      try {
        const [user, org] = await Promise.all([getUserById(userId), getOrgById(orgId)]);
        if (user?.email && org) {
          const courseListHtml = enrolledCourseTitles
            .map((t) => `<li style="margin:4px 0">${t}</li>`)
            .join("");
          await sendEmail({
            to: user.email,
            subject: `You've been enrolled in ${enrolledCourseTitles.length === 1 ? enrolledCourseTitles[0] : `${enrolledCourseTitles.length} courses`} at ${org.name}`,
            html: courseEnrollmentHtml({
              userName: user.name ?? "there",
              orgName: org.name,
              courseTitles: enrolledCourseTitles,
            }),
          });
        }
      } catch (emailErr) {
        console.error("[autoEnroll] Email send failed:", emailErr);
      }
    }
  } catch (e) {
    // Non-fatal: log but don't block member creation
    console.error("[autoEnroll] Error:", e);
  }
}

export const lmsRouter = router({
  // ── Public School Endpoints (no auth required) ─────────────────────────

  publicSchool: router({
    coursesBySlug: publicProcedure
      .input(z.object({ slug: z.string() }))
      .query(async ({ input }) => {
        const org = await getOrgBySlug(input.slug);
        if (!org) return [];
        const courses = await getCoursesByOrg(org.id);
        // Only return published courses to the public directory
        // Hidden courses are accessible via direct URL but not listed here
        // Private courses require email invite, archived are completely hidden
        return courses.filter((c: any) => c.status === "published");
      }),
    themeBySlug: publicProcedure
      .input(z.object({ slug: z.string() }))
      .query(async ({ input }) => {
        const org = await getOrgBySlug(input.slug);
        if (!org) return null;
        const theme = await getOrgTheme(org.id);
        return {
          ...theme,
          // SEO fields from organizations table
          seoTitle: org.seoTitle ?? null,
          seoDescription: org.seoDescription ?? null,
          seoKeywords: org.seoKeywords ?? null,
          seoOgImageUrl: org.seoOgImageUrl ?? null,
          seoRobotsIndex: org.seoRobotsIndex ?? true,
          // Custom CSS
          customCss: org.customCss ?? null,
          // School name for title fallback
          orgName: org.name,
        };
      }),

    // Returns the published school_home page builder blocks for a school subdomain
    homePageBySlug: publicProcedure
      .input(z.object({ slug: z.string() }))
      .query(async ({ input }) => {
        const org = await getOrgBySlug(input.slug);
        if (!org) return null;
        const pages = await getPagesByOrg(org.id);
        const homePage = pages.find((p: any) => p.pageType === "school_home" && p.isPublished);
        if (!homePage) return null;
        let blocks: any[] = [];
        try {
          blocks = homePage.blocksJson ? JSON.parse(homePage.blocksJson) : [];
        } catch {
          blocks = [];
        }
        return { pageId: homePage.id, blocks };
      }),
  }),

  // ── Courses ──────────────────────────────────────────────────────────────

  courses: router({
    list: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        return getCoursesByOrg(input.orgId);
      }),

    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        const course = await getCourseWithInstructor(input.id);
        if (!course) throw new TRPCError({ code: "NOT_FOUND" });
        return course;
      }),

    create: protectedProcedure
      .input(
        z.object({
          orgId: z.number(),
          title: z.string().min(1),
          slug: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const slug =
          input.slug ??
          input.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") +
            "-" +
            nanoid(4);
        return createCourse({
          orgId: input.orgId,
          title: input.title,
          slug,
          instructorId: ctx.user.id,
        });
      }),

    update: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          title: z.string().optional(),
          slug: z.string().optional(),
          description: z.string().optional(),
          shortDescription: z.string().optional(),
          thumbnailUrl: z.string().optional(),
          promoVideoUrl: z.string().optional(),
          status: z.enum(["draft", "published", "hidden", "private", "archived"]).optional(),
          isPrivate: z.boolean().optional(),
          isHidden: z.boolean().optional(),
          disableTextCopy: z.boolean().optional(),
          seoTitle: z.string().optional(),
          seoDescription: z.string().optional(),
          enableChapterShare: z.boolean().optional(),
          enableCompletionShare: z.boolean().optional(),
          socialShareText: z.string().optional(),
          playerThemeColor: z.string().optional(),
          playerSidebarStyle: z.enum(["full", "minimal", "hidden"]).optional(),
          playerShowProgress: z.boolean().optional(),
          playerShowProgressPercent: z.boolean().optional(),
          playerAllowNotes: z.boolean().optional(),
          playerShowLessonIcons: z.boolean().optional(),
          completionType: z.enum(["all_lessons", "percentage", "quiz_pass"]).optional(),
          completionPercentage: z.number().optional(),
          welcomeEmailEnabled: z.boolean().optional(),
          welcomeEmailSubject: z.string().optional(),
          welcomeEmailBody: z.string().optional(),
          afterPurchaseRedirectUrl: z.string().optional(),
          thankYouPageEnabled: z.boolean().optional(),
          thankYouPageBlocks: z.string().optional(),
          headerCode: z.string().optional(),
          footerCode: z.string().optional(),
          designTemplate: z.string().optional(),
          showCompleteButton: z.boolean().optional(),
          enableCertificate: z.boolean().optional(),
          trackProgress: z.boolean().optional(),
          requireSequential: z.boolean().optional(),
          language: z.string().optional(),
          // Pre-start page fields
          whatYouLearn: z.string().optional(),
          requirements: z.string().optional(),
          targetAudience: z.string().optional(),
          instructorBio: z.string().optional(),
          preStartPageEnabled: z.boolean().optional(),
          instructorId: z.number().nullable().optional(),
          // Access duration
          accessDurationType: z.enum(["lifetime", "days", "date"]).optional(),
          accessDurationDays: z.number().nullable().optional(),
          accessExpiryDate: z.date().nullable().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const course = await getCourseById(input.id);
        if (!course) throw new TRPCError({ code: "NOT_FOUND" });
        const member = await requireOrgRole(ctx.user.id, course.orgId, undefined, ctx.user.role);
        // Gate hidden/private to Pro and Enterprise tiers (bypassed for platform admins and org super admins)
        if ((input.status === "hidden" || input.status === "private") &&
            ctx.user.role !== "site_owner" && ctx.user.role !== "site_admin" && ctx.user.role !== "org_super_admin") {
          const sub = await getOrgSubscription(course.orgId);
          const tier = sub?.plan || "free";
          if (!tier.includes("pro") && !tier.includes("enterprise")) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Hidden and Private courses require a Pro or Enterprise plan.",
            });
          }
        }
        const { id, ...data } = input;
        return updateCourse(id, data);
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const course = await getCourseById(input.id);
        if (!course) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, course.orgId, ctx.user.role);
        await deleteCourse(input.id);
        return { success: true };
      }),

    reorder: protectedProcedure
      .input(z.object({ orgId: z.number(), courseIds: z.array(z.number()) }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        await reorderCourses(input.courseIds);
        return { success: true };
      }),
    getThankYouPage: publicProcedure
      .input(z.object({ courseId: z.number() }))
      .query(async ({ input }) => {
        const course = await getCourseById(input.courseId);
        if (!course) throw new TRPCError({ code: "NOT_FOUND" });
        if (!course.thankYouPageEnabled || !course.thankYouPageBlocks) {
          return null;
        }
        return {
          courseId: course.id,
          courseTitle: course.title,
          blocks: course.thankYouPageBlocks,
        };
      }),
  }),

  // ── Curriculum ───────────────────────────────────────────────────────────

  curriculum: router({
    get: protectedProcedure
      .input(z.object({ courseId: z.number() }))
      .query(async ({ input, ctx }) => {
        const curriculum = await getFullCurriculum(input.courseId);
        // Compute drip lock status per lesson based on enrollment date
        const enrollment = await getEnrollment(input.courseId, ctx.user.id);
        const enrolledAt = enrollment?.enrolledAt ? new Date(enrollment.enrolledAt) : null;
        const now = new Date();
        return curriculum.map((section: any) => ({
          ...section,
          lessons: (section.lessons || []).map((lesson: any) => {
            let isDripLocked = false;
            let unlocksAt: Date | null = null;
            if (enrolledAt && lesson.dripType && lesson.dripType !== "immediate") {
              if (lesson.dripType === "days_after_enrollment" && lesson.dripDays != null) {
                const unlockDate = new Date(enrolledAt.getTime() + lesson.dripDays * 24 * 60 * 60 * 1000);
                if (unlockDate > now) {
                  isDripLocked = true;
                  unlocksAt = unlockDate;
                }
              } else if (lesson.dripType === "specific_date" && lesson.dripDate) {
                const unlockDate = new Date(lesson.dripDate);
                if (unlockDate > now) {
                  isDripLocked = true;
                  unlocksAt = unlockDate;
                }
              }
            }
            return { ...lesson, isDripLocked, unlocksAt };
          }),
        }));
      }),

    createSection: protectedProcedure
      .input(
        z.object({
          courseId: z.number(),
          title: z.string().min(1),
          sortOrder: z.number().default(0),
          isFreePreview: z.boolean().default(false),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const course = await getCourseById(input.courseId);
        if (!course) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgRole(ctx.user.id, course.orgId, undefined, ctx.user.role);
        return createSection(input);
      }),

    updateSection: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          courseId: z.number().optional(),
          title: z.string().optional(),
          sortOrder: z.number().optional(),
          isFreePreview: z.boolean().optional(),
          drip: z.string().optional(),
          dripDays: z.number().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        // Tier gate: drip scheduling requires Builder+ (bypassed for platform admins)
        const _isPlatformAdmin = ctx.user.role === "site_owner" || ctx.user.role === "site_admin" || ctx.user.role === "org_super_admin";
        if (!_isPlatformAdmin && (input.drip || input.dripDays) && input.courseId) {
          const course = await getCourseById(input.courseId);
          if (course) {
            const sub = await getOrgSubscription(course.orgId);
            if (!getLimits(sub?.plan).dripScheduling) {
              throw new TRPCError({ code: "FORBIDDEN", message: "Drip scheduling requires a Builder plan or higher." });
            }
          }
        }
        const { id, courseId: _cid, ...data } = input;
        return updateSection(id, data);
      }),

    deleteSection: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await deleteSection(input.id);
        return { success: true };
      }),

    reorderSections: protectedProcedure
      .input(z.object({ sectionIds: z.array(z.number()) }))
      .mutation(async ({ input }) => {
        await reorderSections(input.sectionIds);
        return { success: true };
      }),

    createLesson: protectedProcedure
      .input(
        z.object({
          courseId: z.number(),
          sectionId: z.number(),
          title: z.string().min(1),
          lessonType: z
            .enum([
              "video",
              "text",
              "scorm",
              "quiz",
              "flashcard",
              "exam",
              "pdf",
              "audio",
              "assignment",
              "live",
              "download",
              "weblink",
              "zoom",
            ])
            .default("text"),
          sortOrder: z.number().default(0),
          isFreePreview: z.boolean().default(false),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const course = await getCourseById(input.courseId);
        if (!course) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgRole(ctx.user.id, course.orgId, undefined, ctx.user.role);
        return createLesson(input);
      }),

    updateLesson: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          title: z.string().optional(),
          lessonType: z
            .enum([
              "video",
              "text",
              "scorm",
              "quiz",
              "flashcard",
              "exam",
              "pdf",
              "audio",
              "assignment",
              "live",
              "download",
              "weblink",
              "zoom",
            ])
            .optional(),
          contentJson: z.string().optional(),
          videoUrl: z.string().optional(),
          videoProvider: z.enum(["upload", "youtube", "vimeo", "wistia"]).optional(),
          packageId: z.number().nullish(),
          quizId: z.number().nullish(),
          isFreePreview: z.boolean().optional(),
          isPublished: z.boolean().optional(),
          durationSeconds: z.number().nullish(),
          sortOrder: z.number().optional(),
          downloadUrl: z.string().optional(),
          downloadFileName: z.string().optional(),
          pdfUrl: z.string().optional(),
          audioUrl: z.string().optional(),
          webLinkUrl: z.string().optional(),
          richTextAddOn: z.string().optional(),
          liveSessionJson: z.string().optional(),
          // Lesson banners
          startBannerEnabled: z.boolean().optional(),
          startBannerPosition: z.enum(["top", "bottom", "left"]).optional(),
          startBannerMessage: z.string().optional(),
          startBannerImageUrl: z.string().optional(),
          startBannerSound: z.string().optional(),
          startBannerCustomSoundUrl: z.string().nullish(),
          startBannerConfetti: z.boolean().optional(),
          startBannerConfettiStyle: z.enum(["burst", "cannon", "rain", "fireworks"]).optional(),
          startBannerDurationMs: z.number().optional(),
          completeBannerEnabled: z.boolean().optional(),
          completeBannerPosition: z.enum(["top", "bottom", "left"]).optional(),
          completeBannerMessage: z.string().optional(),
          completeBannerImageUrl: z.string().optional(),
          completeBannerSound: z.string().optional(),
          completeBannerCustomSoundUrl: z.string().nullish(),
          completeBannerConfetti: z.boolean().optional(),
          completeBannerConfettiStyle: z.enum(["burst", "cannon", "rain", "fireworks"]).optional(),
          completeBannerDurationMs: z.number().optional(),
          // Prerequisite / gating settings
          isPrerequisite: z.boolean().optional(),
          requiresCompletion: z.boolean().optional(),
          passingScore: z.number().nullish(),
          allowSkip: z.boolean().optional(),
          estimatedMinutes: z.number().nullish(),
          // Drip
          dripDays: z.number().nullish(),
          dripDate: z.string().nullish(),
          dripType: z.enum(["immediate", "days_after_enrollment", "specific_date"]).optional(),
        })
      )
      .mutation(async ({ input }) => {
        const { id, dripDate, ...rest } = input;
        const data = {
          ...rest,
          ...(dripDate !== undefined ? { dripDate: dripDate ? new Date(dripDate) : null } : {}),
        };
        return updateLesson(id, data);
      }),

    getLesson: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        const lesson = await getLessonById(input.id);
        if (!lesson) throw new TRPCError({ code: "NOT_FOUND" });
        return lesson;
      }),
    deleteLesson: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await deleteLesson(input.id);
        return { success: true };
      }),

    reorderLessons: protectedProcedure
      .input(z.object({ lessonIds: z.array(z.number()) }))
      .mutation(async ({ input }) => {
        await reorderLessons(input.lessonIds);
        return { success: true };
      }),
  }),

  // ── Pricing ──────────────────────────────────────────────────────────────

  pricing: router({
    list: protectedProcedure
      .input(z.object({ courseId: z.number() }))
      .query(async ({ input }) => getPricingByCourse(input.courseId)),

    create: protectedProcedure
      .input(
        z.object({
          courseId: z.number(),
          orgId: z.number(),
          name: z.string(),
          pricingType: z.enum(["free", "one_time", "subscription", "payment_plan"]),
          price: z.number().default(0),
          currency: z.string().default("USD"),
          billingInterval: z.enum(["month", "year"]).optional(),
          accessDays: z.number().optional(),
          isFeatured: z.boolean().default(false),
          sortOrder: z.number().default(0),
        })
      )
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        return createPricing(input);
      }),

    update: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          name: z.string().optional(),
          price: z.number().optional(),
          isFeatured: z.boolean().optional(),
          sortOrder: z.number().optional(),
          accessDays: z.number().optional(),
        })
      )
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        return updatePricing(id, data);
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await deletePricing(input.id);
        return { success: true };
      }),
  }),

  // ── Enrollments ──────────────────────────────────────────────────────────

  enrollments: router({
    myEnrollments: protectedProcedure.query(async ({ ctx }) => {
      return getEnrollmentsByUser(ctx.user.id);
    }),

    byCourse: protectedProcedure
      .input(z.object({ courseId: z.number() }))
      .query(async ({ input, ctx }) => {
        const course = await getCourseById(input.courseId);
        if (!course) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgRole(ctx.user.id, course.orgId, undefined, ctx.user.role);
        return getEnrollmentsByCourse(input.courseId);
      }),

    enroll: protectedProcedure
      .input(
        z.object({
          courseId: z.number(),
          orgId: z.number(),
          pricingId: z.number().optional(),
          amountPaid: z.number().default(0),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const existing = await getEnrollment(input.courseId, ctx.user.id);
        if (existing) return existing;
        return createEnrollment({
          courseId: input.courseId,
          userId: ctx.user.id,
          orgId: input.orgId,
          pricingId: input.pricingId,
          amountPaid: input.amountPaid,
        });
      }),

    progress: protectedProcedure
      .input(z.object({ courseId: z.number() }))
      .query(async ({ input, ctx }) => {
        const enrollment = await getEnrollment(input.courseId, ctx.user.id);
        if (!enrollment) {
          // Allow org admins/sub-admins/instructors to preview without enrollment
          const course = await getCourseById(input.courseId);
          if (course) {
            const member = await getOrgMember(course.orgId, ctx.user.id);
            if (member && ["org_super_admin", "org_admin", "sub_admin", "instructor"].includes(member.role)) {
              return { enrollment: null, lessonProgress: [], isPreview: true };
            }
          }
          return null;
        }
        const lessonProgressList = await getAllLessonProgress(enrollment.id);
        return { enrollment, lessonProgress: lessonProgressList, isPreview: false };
      }),

    updateLessonProgress: protectedProcedure
      .input(
        z.object({
          courseId: z.number(),
          lessonId: z.number(),
          status: z.enum(["not_started", "in_progress", "completed"]),
          timeSpentSeconds: z.number().optional(),
          scormData: z.string().optional(),
          quizScore: z.number().optional(),
          quizPassed: z.boolean().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const enrollment = await getEnrollment(input.courseId, ctx.user.id);
        if (!enrollment) throw new TRPCError({ code: "FORBIDDEN", message: "Not enrolled" });

        const progress = await upsertLessonProgress({
          enrollmentId: enrollment.id,
          lessonId: input.lessonId,
          userId: ctx.user.id,
          courseId: input.courseId,
          status: input.status,
          timeSpentSeconds: input.timeSpentSeconds,
          scormData: input.scormData,
          quizScore: input.quizScore,
          quizPassed: input.quizPassed,
          completedAt: input.status === "completed" ? new Date() : undefined,
        });

        // Recalculate overall progress
        const allLessons = await getAllLessonProgress(enrollment.id);
        const completed = allLessons.filter((l) => l.status === "completed").length;
        const total = allLessons.length;
        const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
        await updateEnrollmentProgress(enrollment.id, pct, input.lessonId);

        // Auto-issue certificate on 100% completion
        if (pct === 100) {
          const course = await getCourseById(input.courseId);
          if (course?.enableCertificate) {
            const existing = await getCertificateByEnrollment(enrollment.id);
            if (!existing) {
              const verificationCode = nanoid(16);
              await createCertificate({
                enrollmentId: enrollment.id,
                userId: ctx.user.id,
                courseId: input.courseId,
                orgId: course.orgId,
                verificationCode,
                certData: JSON.stringify({
                  studentName: ctx.user.name ?? ctx.user.email,
                  courseTitle: course.title,
                  issuedAt: new Date().toISOString(),
                }),
              });
              // Send certificate completion email
              try {
                const [org, user] = await Promise.all([
                  getOrgById(course.orgId),
                  getUserById(ctx.user.id),
                ]);
                if (user?.email) {
                  const SITE_URL = process.env.VITE_SITE_URL ?? "https://teachific.app";
                  const courseUrl = `${SITE_URL}/learn/${(course as any).slug ?? course.id}`;
                  await sendEmail({
                    to: user.email,
                    subject: `Certificate of Completion — ${course.title}`,
                    html: certificateCompletionHtml({
                      userName: user.name ?? user.email,
                      courseTitle: course.title,
                      orgName: org?.name,
                      issuedAt: new Date(),
                      verificationCode,
                      courseUrl,
                    }),
                  });
                }
              } catch (emailErr) {
                console.error("[Certificate] Failed to send completion email:", emailErr);
              }
            }
          }
        }

        return progress;
      }),
  }),

  // ── Themes ───────────────────────────────────────────────────────────────

  themes: router({
    get: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        return getOrgTheme(input.orgId);
      }),

    update: protectedProcedure
      .input(
        z.object({
          orgId: z.number(),
          bgMode: z.enum(["light", "dark"]).optional(),
          primaryColor: z.string().optional(),
          accentColor: z.string().optional(),
          fontFamily: z.string().optional(),
          schoolName: z.string().optional(),
          adminLogoUrl: z.string().optional(),
          faviconUrl: z.string().optional(),
          customCss: z.string().nullish().transform(v => v ?? undefined),
          studentPrimaryColor: z.string().optional(),
          studentAccentColor: z.string().optional(),
          studentTheme: z.enum(["light", "dark"]).optional(),
          watermarkImageUrl: z.string().nullable().optional(),
          watermarkOpacity: z.number().min(0).max(100).optional(),
          watermarkPosition: z.string().optional(),
          watermarkSize: z.number().min(20).max(400).optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const { orgId, ...data } = input;
        return upsertOrgTheme(orgId, data);
      }),
  }),

  // ── Page Builder ─────────────────────────────────────────────────────────

  pages: router({
    list: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        return getPagesByOrg(input.orgId);
      }),

    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        const page = await getPageById(input.id);
        if (!page) throw new TRPCError({ code: "NOT_FOUND" });
        return page;
      }),

    getByCourse: protectedProcedure
      .input(z.object({ courseId: z.number() }))
      .query(async ({ input }) => {
        return getPageByCourse(input.courseId);
      }),

    create: protectedProcedure
      .input(
        z.object({
          orgId: z.number(),
          courseId: z.number().optional(),
          pageType: z
            .enum(["course_sales", "school_home", "custom", "checkout", "thank_you"])
            .default("course_sales"),
          title: z.string().optional(),
          slug: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        return createPage({ ...input, blocksJson: "[]" });
      }),

    update: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          title: z.string().optional(),
          slug: z.string().optional(),
          blocksJson: z.string().optional(),
          isPublished: z.boolean().optional(),
          showHeader: z.boolean().optional(),
          showFooter: z.boolean().optional(),
          metaTitle: z.string().nullish().transform(v => v ?? undefined),
          metaDescription: z.string().nullish().transform(v => v ?? undefined),
          customCss: z.string().nullish().transform(v => v ?? undefined),
        })
      )
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        return updatePage(id, data);
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await deletePage(input.id);
        return { success: true };
      }),

    getBySlug: publicProcedure
      .input(z.object({ slug: z.string() }))
      .query(async ({ input }) => {
        const page = await getPublishedPageBySlug(input.slug);
        if (!page) throw new TRPCError({ code: "NOT_FOUND" });
        return page;
      }),

    duplicate: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const original = await getPageById(input.id);
        if (!original) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgRole(ctx.user.id, original.orgId, undefined, ctx.user.role);
        const copy = await duplicatePage(input.id);
        return copy;
      }),

    // AI-generate a school homepage from org details
    aiGenerate: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        orgName: z.string(),
        tagline: z.string().optional(),
        description: z.string().optional(),
        primaryColor: z.string().optional().default("#24abbc"),
        courseCount: z.number().optional().default(0),
      }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const prompt = `You are a web page designer. Generate a JSON array of page blocks for a school homepage for "${input.orgName}".
${input.tagline ? `Tagline: ${input.tagline}` : ""}
${input.description ? `Description: ${input.description}` : ""}
Primary color: ${input.primaryColor}

Return ONLY a valid JSON array of blocks. Each block has: { id: string, type: string, props: object }.
Available block types and their required props:
- "hero": { title, subtitle, ctaText, ctaUrl, backgroundImage?, backgroundColor }
- "features": { title, items: [{icon, title, description}] }
- "courses": { title, subtitle }
- "testimonials": { title, items: [{name, role, text, avatar?}] }
- "cta": { title, subtitle, buttonText, buttonUrl, backgroundColor }
- "text": { content (HTML string) }
- "stats": { items: [{value, label}] }

Generate 5-7 blocks that make a compelling school homepage. Use the org's colors and branding. Make it professional and engaging.`;
        const response = await invokeLLM({
          messages: [
            { role: "system", content: "You are a professional web designer. Return only valid JSON arrays, no markdown, no explanation." },
            { role: "user", content: prompt },
          ],
          response_format: { type: "json_object" } as any,
        });
        let blocksJson = "[]";
        try {
          const rawContent = response.choices?.[0]?.message?.content;
          const raw = typeof rawContent === "string" ? rawContent : Array.isArray(rawContent) ? (rawContent.find((c: any) => c.type === "text") as any)?.text ?? "[]" : "[]";
          // The LLM might return { blocks: [...] } or just [...]
          const parsed = JSON.parse(raw);
          const arr = Array.isArray(parsed) ? parsed : (parsed.blocks ?? []);
          // Ensure each block has a unique id
          const { nanoid: nid } = await import("nanoid");
          const blocks = arr.map((b: any) => ({ ...b, id: b.id || nid(8) }));
          blocksJson = JSON.stringify(blocks);
        } catch {
          blocksJson = "[]";
        }
        // Find or create the school_home page for this org
        const existingPages = await getPagesByOrg(input.orgId);
        const homePage = existingPages.find((p: any) => p.pageType === "school_home");
        if (homePage) {
          await updatePage(homePage.id, { blocksJson, title: `${input.orgName} Homepage`, isPublished: true });
          return { pageId: homePage.id, blocksJson };
        } else {
          const slug = input.orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-home";
          const newPage = await createPage({ orgId: input.orgId, pageType: "school_home", title: `${input.orgName} Homepage`, slug, blocksJson });
          await updatePage(newPage.id, { isPublished: true });
          return { pageId: newPage.id, blocksJson };
        }
      }),
  }),

  // ── Instructors ──────────────────────────────────────────────────────────

  instructors: router({
    list: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        return getInstructorsByOrg(input.orgId);
      }),

    upsert: protectedProcedure
      .input(
        z.object({
          orgId: z.number(),
          displayName: z.string().optional(),
          title: z.string().optional(),
          bio: z.string().optional(),
          avatarUrl: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        return upsertInstructor({ ...input, userId: ctx.user.id });
      }),
    create: protectedProcedure
      .input(
        z.object({
          orgId: z.number(),
          displayName: z.string().min(1),
          title: z.string().optional(),
          bio: z.string().optional(),
          avatarUrl: z.string().optional(),
          socialLinks: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        return upsertInstructor({ ...input, userId: ctx.user.id });
      }),
    update: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          orgId: z.number(),
          displayName: z.string().optional(),
          title: z.string().optional(),
          bio: z.string().optional(),
          avatarUrl: z.string().optional(),
          socialLinks: z.string().optional(),
          isActive: z.boolean().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        const { id, orgId, ...updates } = input;
        return updateInstructorById(id, updates);
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number(), orgId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        return deleteInstructorById(input.id);
      }),
  }),

  // ── Coupons ──────────────────────────────────────────────────────────────

  coupons: router({
    list: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        return getCouponsByOrg(input.orgId);
      }),

    validate: protectedProcedure
      .input(z.object({ orgId: z.number(), code: z.string() }))
      .query(async ({ input }) => {
        return getCouponByCode(input.orgId, input.code);
      }),

    create: protectedProcedure
      .input(
        z.object({
          orgId: z.number(),
          code: z.string().min(1),
          discountType: z.enum(["percentage", "fixed"]).default("percentage"),
          discountValue: z.number(),
          maxUses: z.number().optional(),
          expiresAt: z.date().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        return createCoupon(input);
      }),

    update: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          isActive: z.boolean().optional(),
          maxUses: z.number().optional(),
        })
      )
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        return updateCoupon(id, data);
      }),
  }),

  // ── Reviews ──────────────────────────────────────────────────────────────

  reviews: router({
    byCourse: publicProcedure
      .input(z.object({ courseId: z.number() }))
      .query(async ({ input }) => getReviewsByCourse(input.courseId)),

    create: protectedProcedure
      .input(
        z.object({
          courseId: z.number(),
          orgId: z.number(),
          rating: z.number().min(1).max(5),
          reviewText: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        return createReview({ ...input, userId: ctx.user.id });
      }),
  }),

  // ── Analytics ────────────────────────────────────────────────────────────

  analytics: router({
    summary: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        return getLmsAnalyticsByOrg(input.orgId);
      }),
    byGroup: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        groupId: z.number().optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
      }))
      .query(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const { getOrgAnalyticsByGroup } = await import("./lmsDb");
        return getOrgAnalyticsByGroup(input.orgId, {
          groupId: input.groupId,
          dateFrom: input.dateFrom ? new Date(input.dateFrom) : undefined,
          dateTo: input.dateTo ? new Date(input.dateTo) : undefined,
        });
      }),
    courseAnalytics: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
        groupBy: z.enum(["day", "week", "month"]).optional(),
      }))
      .query(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const { getOrgCourseAnalytics } = await import("./lmsDb");
        return getOrgCourseAnalytics(input.orgId, {
          dateFrom: input.dateFrom ? new Date(input.dateFrom) : undefined,
          dateTo: input.dateTo ? new Date(input.dateTo) : undefined,
          groupBy: input.groupBy,
        });
      }),
    quizAnalytics: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
        groupBy: z.enum(["day", "week", "month"]).optional(),
      }))
      .query(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const { getOrgQuizAnalytics } = await import("./lmsDb");
        return getOrgQuizAnalytics(input.orgId, {
          dateFrom: input.dateFrom ? new Date(input.dateFrom) : undefined,
          dateTo: input.dateTo ? new Date(input.dateTo) : undefined,
          groupBy: input.groupBy,
        });
      }),
  }),

  // ── Certificates ─────────────────────────────────────────────────────────

  certificates: router({
    mine: protectedProcedure.query(async ({ ctx }) => {
      return getCertificatesByUser(ctx.user.id);
    }),

    /** Generate + upload a branded PDF for a specific enrollment certificate */
    download: protectedProcedure
      .input(z.object({ enrollmentId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        // 1. Get the certificate record
        const cert = await getCertificateByEnrollment(input.enrollmentId);
        if (!cert) throw new TRPCError({ code: "NOT_FOUND", message: "Certificate not found" });
        if (cert.userId !== ctx.user.id) throw new TRPCError({ code: "FORBIDDEN" });

        // 2. Get course + org info
        const course = await getCourseById(cert.courseId);
        if (!course) throw new TRPCError({ code: "NOT_FOUND", message: "Course not found" });
        const org = await getOrgById(course.orgId);
        if (!org) throw new TRPCError({ code: "NOT_FOUND", message: "Org not found" });

        // 3. Get org theme for branding colors
        const theme = await getOrgTheme(course.orgId);
        const sub = await getOrgSubscription(course.orgId);
        const plan = sub?.plan ?? "free";

        // 4. Get default certificate template for the org (if any)
        const templates = await getCertificateTemplatesByOrg(course.orgId);
        const tpl = templates.find((t: any) => t.isDefault) ?? templates[0] ?? null;

        // 5. Determine branding
        const showTeachificBranding = tpl?.showTeachificBranding ?? shouldShowTeachificBranding(plan);
        const primaryColor = tpl?.primaryColor ?? theme?.primaryColor ?? "#0ea5e9";
        const accentColor = tpl?.accentColor ?? theme?.accentColor ?? "#0f2942";
        const logoUrl = tpl?.logoUrl ?? org.logoUrl ?? theme?.adminLogoUrl ?? null;

        // 6. Generate PDF
        const pdfBuffer = await generateCertificatePdf({
          studentName: ctx.user.name ?? "Student",
          courseName: course.title,
          issuedAt: cert.issuedAt ? new Date(cert.issuedAt) : new Date(),
          verificationCode: cert.verificationCode ?? cert.id.toString(),
          orgName: org.name,
          orgLogoUrl: logoUrl,
          primaryColor,
          accentColor,
          bgStyle: (tpl?.bgStyle as any) ?? "white",
          signatureName: tpl?.signatureName ?? null,
          signatureTitle: tpl?.signatureTitle ?? null,
          signatureImageUrl: tpl?.signatureImageUrl ?? null,
          footerText: tpl?.footerText ?? null,
          showTeachificBranding,
        });

        // 7. Upload to S3 and return URL
        const key = `certificates/${course.orgId}/${ctx.user.id}/cert-${cert.id}-${Date.now()}.pdf`;
        const { url } = await storagePut(key, pdfBuffer, "application/pdf");
        return { url, filename: `certificate-${course.title.replace(/[^a-z0-9]/gi, "-").toLowerCase()}.pdf` };
      }),

    // ── Certificate Templates ─────────────────────────────────────────────
    templates: router({
      list: protectedProcedure
        .input(z.object({ orgId: z.number() }))
        .query(async ({ input, ctx }) => {
          await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
          return getCertificateTemplatesByOrg(input.orgId);
        }),

      create: protectedProcedure
        .input(z.object({
          orgId: z.number(),
          name: z.string().min(1),
          isDefault: z.boolean().optional(),
          logoUrl: z.string().optional(),
          primaryColor: z.string().optional(),
          accentColor: z.string().optional(),
          bgStyle: z.enum(["white", "light", "gradient", "dark"]).optional(),
          signatureName: z.string().optional(),
          signatureTitle: z.string().optional(),
          signatureImageUrl: z.string().optional(),
          footerText: z.string().optional(),
          showTeachificBranding: z.boolean().optional(),
        }))
        .mutation(async ({ input, ctx }) => {
          await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
          const sub = await getOrgSubscription(input.orgId);
          const plan = sub?.plan ?? "free";
          // Force showTeachificBranding=true on free/starter/builder plans
          const showTeachificBranding = shouldShowTeachificBranding(plan)
            ? true
            : (input.showTeachificBranding ?? false);
          return createCertificateTemplate({
            orgId: input.orgId,
            name: input.name,
            isDefault: input.isDefault ?? false,
            logoUrl: input.logoUrl,
            primaryColor: input.primaryColor,
            accentColor: input.accentColor,
            bgStyle: input.bgStyle ?? "white",
            signatureName: input.signatureName,
            signatureTitle: input.signatureTitle,
            signatureImageUrl: input.signatureImageUrl,
            footerText: input.footerText,
            showTeachificBranding,
          });
        }),

      update: protectedProcedure
        .input(z.object({
          id: z.number(),
          name: z.string().min(1).optional(),
          isDefault: z.boolean().optional(),
          logoUrl: z.string().nullable().optional(),
          primaryColor: z.string().nullable().optional(),
          accentColor: z.string().nullable().optional(),
          bgStyle: z.enum(["white", "light", "gradient", "dark"]).optional(),
          signatureName: z.string().nullable().optional(),
          signatureTitle: z.string().nullable().optional(),
          signatureImageUrl: z.string().nullable().optional(),
          footerText: z.string().nullable().optional(),
          showTeachificBranding: z.boolean().optional(),
        }))
        .mutation(async ({ input, ctx }) => {
          const tpl = await getCertificateTemplateById(input.id);
          if (!tpl) throw new TRPCError({ code: "NOT_FOUND" });
          await requireOrgAdmin(ctx.user.id, tpl.orgId, ctx.user.role);
          // Re-enforce Teachific branding on non-white-label plans
          const sub = await getOrgSubscription(tpl.orgId);
          const plan = sub?.plan ?? "free";
          const { id, ...rest } = input;
          const data: any = { ...rest };
          if (shouldShowTeachificBranding(plan)) data.showTeachificBranding = true;
          return updateCertificateTemplate(input.id, data);
        }),

      delete: protectedProcedure
        .input(z.object({ id: z.number() }))
        .mutation(async ({ input, ctx }) => {
          const tpl = await getCertificateTemplateById(input.id);
          if (!tpl) throw new TRPCError({ code: "NOT_FOUND" });
          await requireOrgAdmin(ctx.user.id, tpl.orgId, ctx.user.role);
          await deleteCertificateTemplate(input.id);
          return { success: true };
        }),
    }),
  }),

  // ── Subscription ─────────────────────────────────────────────────────────

  subscription: router({
    get: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const sub = await getOrgSubscription(input.orgId);
        // Auto-provision enterprise for any org that has no subscription yet
        if (!sub) {
          return upsertOrgSubscription(input.orgId, { plan: 'enterprise', status: 'active' });
        }
        return sub;
      }),
    upsert: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        plan: z.enum(['free', 'starter', 'builder', 'pro', 'enterprise']),
        status: z.enum(['active', 'trialing', 'past_due', 'cancelled', 'unpaid']).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        return upsertOrgSubscription(input.orgId, { plan: input.plan, status: input.status ?? 'active' });
      }),
  }),

  // ── Copy / Duplicate ─────────────────────────────────────────────────────

  copy: router({
    course: protectedProcedure
      .input(z.object({ courseId: z.number(), newTitle: z.string().optional() }))
      .mutation(async ({ input, ctx }) => {
        const course = await getCourseById(input.courseId);
        if (!course) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgRole(ctx.user.id, course.orgId, undefined, ctx.user.role);
        const newTitle = input.newTitle ?? `Copy of ${course.title}`;
        const newSlug =
          newTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") +
          "-" +
          nanoid(4);
        return copyCourse(input.courseId, newTitle, newSlug);
      }),
    lesson: protectedProcedure
      .input(
        z.object({
          lessonId: z.number(),
          targetCourseId: z.number(),
          targetSectionId: z.number(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const course = await getCourseById(input.targetCourseId);
        if (!course) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgRole(ctx.user.id, course.orgId, undefined, ctx.user.role);
        return copyLessonToSection(
          input.lessonId,
          input.targetCourseId,
          input.targetSectionId
        );
      }),
    section: protectedProcedure
      .input(z.object({ sectionId: z.number(), targetCourseId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const course = await getCourseById(input.targetCourseId);
        if (!course) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgRole(ctx.user.id, course.orgId, undefined, ctx.user.role);
        return copySectionToCourse(input.sectionId, input.targetCourseId);
      }),
  }),

  // ── AI Generation ─────────────────────────────────────────────────────────

  ai: router({
    generateCourse: protectedProcedure
      .input(
        z.object({
          orgId: z.number(),
          topic: z.string().min(3),
          numModules: z.number().default(3),
          numLessonsPerModule: z.number().default(4),
        })
      )
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        // Tier gate: AI generation requires Starter+ (bypassed for platform admins and org super admins)
        if (ctx.user.role !== "site_owner" && ctx.user.role !== "site_admin" && ctx.user.role !== "org_super_admin") {
          const sub = await getOrgSubscription(input.orgId);
          if (!getLimits(sub?.plan).aiGeneration) {
            throw new TRPCError({ code: "FORBIDDEN", message: "AI course generation requires a Starter plan or higher. Please upgrade to use this feature." });
          }
        }
        const response = await invokeLLM({
          messages: [
            {
              role: "system",
              content:
                "You are an expert instructional designer. Return valid JSON only, no markdown.",
            },
            {
              role: "user",
              content: `Create a course outline for: "${input.topic}". Return JSON: { "title": string, "description": string, "modules": [{ "title": string, "lessons": [{ "title": string, "type": "text"|"video"|"quiz"|"assignment", "description": string }] }] }. Create ${input.numModules} modules with ${input.numLessonsPerModule} lessons each.`,
            },
          ],
        });
        const rawContent = response.choices?.[0]?.message?.content ?? "{}";
        const content = typeof rawContent === "string" ? rawContent : "{}";
        try {
          const cleaned = content.replace(/```json\n?|```\n?/g, "").trim();
          return JSON.parse(cleaned);
        } catch {
          return { title: input.topic, description: "", modules: [] };
        }
      }),

    generateQuiz: protectedProcedure
      .input(
        z.object({
          topic: z.string().min(3),
          numQuestions: z.number().default(10),
          difficulty: z.enum(["easy", "medium", "hard"]).default("medium"),
        })
      )
      .mutation(async ({ input }) => {
        const response = await invokeLLM({
          messages: [
            {
              role: "system",
              content: "You are an expert quiz creator. Return valid JSON only, no markdown.",
            },
            {
              role: "user",
              content: `Create ${input.numQuestions} ${input.difficulty} multiple-choice questions about: "${input.topic}". Return JSON: { "questions": [{ "text": string, "choices": [{ "text": string, "isCorrect": boolean }], "explanation": string }] }`,
            },
          ],
        });
        const rawContent = response.choices?.[0]?.message?.content ?? "{}";
        const content = typeof rawContent === "string" ? rawContent : "{}";
        try {
          const cleaned = content.replace(/```json\n?|```\n?/g, "").trim();
          return JSON.parse(cleaned);
        } catch {
          return { questions: [] };
        }
      }),

    generateFlashcards: protectedProcedure
      .input(
        z.object({
          topic: z.string().min(3),
          numCards: z.number().default(15),
        })
      )
      .mutation(async ({ input }) => {
        const response = await invokeLLM({
          messages: [
            {
              role: "system",
              content: "You are an expert educator. Return valid JSON only, no markdown.",
            },
            {
              role: "user",
              content: `Create ${input.numCards} flashcards about: "${input.topic}". Return JSON: { "cards": [{ "front": string, "back": string }] }`,
            },
          ],
        });
        const rawContent = response.choices?.[0]?.message?.content ?? "{}";
        const content = typeof rawContent === "string" ? rawContent : "{}";
        try {
          const cleaned = content.replace(/```json\n?|```\n?/g, "").trim();
          return JSON.parse(cleaned);
        } catch {
          return { cards: [] };
        }
      }),
    generateLandingPage: protectedProcedure
      .input(
        z.object({
          topic: z.string().min(3),
          title: z.string().min(1),
          description: z.string().optional(),
          targetAudience: z.string().optional(),
          difficulty: z.string().optional(),
        })
      )
      .mutation(async ({ input }) => {
        const response = await invokeLLM({
          messages: [
            { role: "system", content: "You are an expert course marketer. Return valid JSON only, no markdown." },
            { role: "user", content: `Generate landing page content for a course titled "${input.title}" about "${input.topic}"${input.targetAudience ? ` for ${input.targetAudience}` : ""}${input.difficulty ? ` at ${input.difficulty} level` : ""}. Return JSON: { "heroHeadline": string, "heroSubtitle": string, "shortDescription": string, "whatYouLearn": string[], "requirements": string[], "targetAudience": string, "suggestedPriceFree": boolean, "suggestedPrice": number }` },
          ],
        });
        const rawContent = response.choices?.[0]?.message?.content ?? "{}";
        const content = typeof rawContent === "string" ? rawContent : "{}";
        try {
          const cleaned = content.replace(/```json\n?|```\n?/g, "").trim();
          return JSON.parse(cleaned);
        } catch {
          return { heroHeadline: input.title, heroSubtitle: "", shortDescription: "", whatYouLearn: [], requirements: [], targetAudience: "", suggestedPriceFree: true, suggestedPrice: 0 };
        }
      }),
    generateContent: protectedProcedure
      .input(
        z.object({
          lessonTitle: z.string().min(1),
          courseTitle: z.string().optional(),
          prompt: z.string().optional(),
          contentType: z.enum(["text", "outline", "summary", "quiz_questions"]).default("text"),
        })
      )
      .mutation(async ({ input }) => {
        const typeInstructions: Record<string, string> = {
          text: "Generate rich lesson content in HTML format (use <h2>, <p>, <ul>, <strong> tags). Write 3-5 paragraphs with practical examples.",
          outline: "Generate a structured lesson outline as HTML with numbered sections and bullet points.",
          summary: "Generate a concise 2-3 paragraph summary of the lesson content in HTML.",
          quiz_questions: "Generate 5 multiple-choice quiz questions as a JSON array: [{\"question\": string, \"options\": string[], \"correct\": number, \"explanation\": string}]. Return only the JSON array.",
        };
        const response = await invokeLLM({
          messages: [
            { role: "system", content: `You are an expert course content writer. ${typeInstructions[input.contentType]}` },
            { role: "user", content: `Lesson: "${input.lessonTitle}"${input.courseTitle ? ` (Course: "${input.courseTitle}")` : ""}${input.prompt ? `\nAdditional context: ${input.prompt}` : ""}` },
          ],
        });
        const content = response.choices?.[0]?.message?.content ?? "";
        return { content: typeof content === "string" ? content : JSON.stringify(content) };
      }),
    createCourseFromOutline: protectedProcedure
      .input(
        z.object({
          orgId: z.number(),
          title: z.string().min(1),
          description: z.string().optional(),
          shortDescription: z.string().optional(),
          whatYouLearn: z.string().optional(),
          requirements: z.string().optional(),
          targetAudience: z.string().optional(),
          modules: z.array(z.object({
            title: z.string(),
            lessons: z.array(z.object({
              title: z.string(),
              type: z.string(),
              description: z.string().optional(),
            })),
          })),
        })
      )
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        if (ctx.user.role !== "site_owner" && ctx.user.role !== "site_admin" && ctx.user.role !== "org_super_admin") {
          const sub = await getOrgSubscription(input.orgId);
          if (!getLimits(sub?.plan).aiGeneration) {
            throw new TRPCError({ code: "FORBIDDEN", message: "AI course generation requires a Starter plan or higher." });
          }
        }
        const sanitized = sanitizeAiCoursePayload(input, nanoid(4));
        const course = await createCourse({
          orgId: input.orgId,
          title: sanitized.title,
          slug: sanitized.slug,
          description: sanitized.description,
          shortDescription: sanitized.shortDescription,
          whatYouLearn: sanitized.whatYouLearn,
          requirements: sanitized.requirements,
          targetAudience: sanitized.targetAudience,
          instructorId: ctx.user.id,
        });
        if (!course) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create course" });
        for (let mi = 0; mi < sanitized.modules.length; mi++) {
          const mod = sanitized.modules[mi];
          const section = await createSection({ courseId: course.id, title: mod.title, sortOrder: mi });
          if (!section) continue;
          for (let li = 0; li < mod.lessons.length; li++) {
            const les = mod.lessons[li];
            const lessonType = ["text", "video", "quiz", "assignment", "audio", "pdf"].includes(les.type) ? les.type : "text";
            await createLesson({
              courseId: course.id,
              sectionId: section.id,
              title: les.title,
              lessonType: lessonType as any,
              sortOrder: li,
              contentJson: les.description ? `<p>${les.description}</p>` : "",
            });
          }
        }
        return course;
      }),
  }),
  // ── Dashboard Analyticss ─────────────────────────────────────────────────

  dashboard: router({
    metrics: protectedProcedure
      .input(z.object({ orgId: z.number(), days: z.number().default(30) }))
      .query(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        return getDashboardMetrics(input.orgId, input.days);
      }),
    chartData: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        days: z.number().default(30),
        groupBy: z.enum(['day', 'week', 'month']).default('day'),
      }))
      .query(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        return getRevenueChartData(input.orgId, input.days, input.groupBy);
      }),
    recentActivity: protectedProcedure
      .input(z.object({ orgId: z.number(), limit: z.number().default(20) }))
      .query(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        return getRecentActivity(input.orgId, input.limit);
      }),
    recentCourses: protectedProcedure
      .input(z.object({ orgId: z.number(), limit: z.number().default(6) }))
      .query(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        return getRecentlyEditedCourses(input.orgId, input.limit);
      }),
    enrolledCourses: protectedProcedure
      .query(async ({ ctx }) => {
        return getEnrolledCoursesForUser(ctx.user.id);
      }),
  }),

  // ── Members ───────────────────────────────────────────────

  members: router({
    listWithEnrollments: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        const { getMembersWithEnrollments } = await import("./lmsDb");
        return getMembersWithEnrollments(input.orgId);
      }),
    // Org admin creates a new user and adds them to the org, optionally enrolling in courses
    createAndAdd: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        name: z.string().min(1),
        email: z.string().email(),
        password: z.string().min(6),
        role: z.enum(["org_admin", "user"]).default("user"),
        courseIds: z.array(z.number()).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        const { getUserByEmail, createManualUser, addOrgMember, getOrgMember: getOrgMemberDb, updateOrgMemberRole } = await import("./db");
        const existing = await getUserByEmail(input.email);
        let userId: number;
        if (existing) {
          userId = existing.id;
        } else {
          const bcrypt = await import("bcryptjs");
          const { nanoid: nid } = await import("nanoid");
          const passwordHash = await bcrypt.default.hash(input.password, 10);
          const openId = `manual_${nid(20)}`;
          await createManualUser({ openId, name: input.name, email: input.email, loginMethod: "email", role: input.role === "org_admin" ? "org_admin" : "user", passwordHash });
          const newUser = await getUserByEmail(input.email);
          if (!newUser) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to create user" });
          userId = newUser.id;
        }
        const existingMember = await getOrgMemberDb(input.orgId, userId);
        if (existingMember) {
          await updateOrgMemberRole(input.orgId, userId, input.role);
        } else {
          await addOrgMember(input.orgId, userId, input.role);
        }
        if (input.courseIds && input.courseIds.length > 0) {
          for (const courseId of input.courseIds) {
            const existingEnroll = await getEnrollment(courseId, userId);
            if (!existingEnroll) {
              await createEnrollment({ courseId, userId, orgId: input.orgId, amountPaid: 0 });
            }
          }
        } else {
          // Auto-enroll in org-configured courses if enabled
          await autoEnrollMemberIfEnabled(input.orgId, userId);
        }
        return { success: true, userId };
      }),
    manualEnroll: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        courseId: z.number(),
        email: z.string().email(),
      }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        const { getUserByEmail } = await import("./db");
        const user = await getUserByEmail(input.email);
        if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "No user found with that email address" });
        const existing = await getEnrollment(input.courseId, user.id);
        if (existing) return existing;
        return createEnrollment({
          courseId: input.courseId,
          userId: user.id,
          orgId: input.orgId,
          amountPaid: 0,
        });
      }),
    // Bulk import members from CSV/Excel
    bulkImport: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        members: z.array(z.object({
          name: z.string().min(1),
          email: z.string().email(),
          password: z.string().min(6).optional().default("Teachific@123"),
          role: z.enum(["org_admin", "user"]).optional().default("user"),
        })),
        courseIds: z.array(z.number()).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        const { getUserByEmail, createManualUser, addOrgMember, getOrgMember: getOrgMemberDb, updateOrgMemberRole } = await import("./db");
        const bcrypt = await import("bcryptjs");
        const { nanoid: nid } = await import("nanoid");
        let created = 0, updated = 0, failed = 0;
        const errors: string[] = [];
        for (const m of input.members) {
          try {
            const existing = await getUserByEmail(m.email);
            let userId: number;
            if (existing) {
              userId = existing.id;
              updated++;
            } else {
              const passwordHash = await bcrypt.default.hash(m.password!, 10);
              const openId = `manual_${nid(20)}`;
              await createManualUser({ openId, name: m.name, email: m.email, loginMethod: "email", role: m.role === "org_admin" ? "org_admin" : "user", passwordHash });
              const newUser = await getUserByEmail(m.email);
              if (!newUser) throw new Error("Failed to create user");
              userId = newUser.id;
              created++;
            }
            const existingMember = await getOrgMemberDb(input.orgId, userId);
            if (existingMember) {
              await updateOrgMemberRole(input.orgId, userId, m.role ?? "user");
            } else {
              await addOrgMember(input.orgId, userId, m.role ?? "user");
            }
            if (input.courseIds?.length) {
              for (const courseId of input.courseIds) {
                const existingEnroll = await getEnrollment(courseId, userId);
                if (!existingEnroll) {
                  await createEnrollment({ courseId, userId, orgId: input.orgId, amountPaid: 0 });
                }
              }
            } else {
              // Auto-enroll in org-configured courses if enabled
              await autoEnrollMemberIfEnabled(input.orgId, userId);
            }
          } catch (e: any) {
            failed++;
            errors.push(`${m.email}: ${e.message}`);
          }
        }
        return { created, updated, failed, errors, total: input.members.length };
      }),
  }),

  // ── Activity Tracking ───────────────────────────────────────────────

  activity: router({
    // Batch ingest events from the client tracker (protected — must be logged in)
    ingest: protectedProcedure
      .input(
        z.object({
          orgId: z.number(),
          events: z.array(
            z.object({
              sessionKey: z.string(),
              eventType: z.enum([
                "page_view", "page_exit", "session_start", "session_heartbeat", "session_end",
                "video_play", "video_pause", "video_seek", "video_complete", "video_progress",
                "lesson_start", "lesson_complete", "quiz_start", "quiz_submit",
                "download", "link_click", "button_click", "search", "enrollment", "course_complete",
              ]),
              pageUrl: z.string().optional(),
              pageTitle: z.string().optional(),
              courseId: z.number().nullish(),
              lessonId: z.number().nullish(),
              quizId: z.number().nullish(),
              durationMs: z.number().nullish(),
              videoPositionSec: z.number().nullish(),
              videoDurationSec: z.number().nullish(),
              metadata: z.string().nullish(),
              referrer: z.string().optional(),
            })
          ),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { insertActivityEvents } = await import("./lmsDb");
        await insertActivityEvents(
          input.events.map((e) => ({
            ...e,
            userId: ctx.user.id,
            orgId: input.orgId,
            userAgent: undefined,
          }))
        );
        return { ok: true };
      }),

    // Query events for a specific org (admin only)
    list: protectedProcedure
      .input(
        z.object({
          orgId: z.number(),
          userId: z.number().optional(),
          courseId: z.number().optional(),
          eventType: z.string().optional(),
          dateFrom: z.string().optional(),
          dateTo: z.string().optional(),
          limit: z.number().default(200),
          offset: z.number().default(0),
        })
      )
      .query(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        const { getActivityEventsByOrg } = await import("./lmsDb");
        return getActivityEventsByOrg(input.orgId, {
          userId: input.userId,
          courseId: input.courseId,
          eventType: input.eventType,
          dateFrom: input.dateFrom ? new Date(input.dateFrom) : undefined,
          dateTo: input.dateTo ? new Date(input.dateTo) : undefined,
          limit: input.limit,
          offset: input.offset,
        });
      }),

    // Summary stats for a specific user
    userSummary: protectedProcedure
      .input(z.object({ orgId: z.number(), userId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        const { getActivitySummaryByUser } = await import("./lmsDb");
        return getActivitySummaryByUser(input.orgId, input.userId);
      }),

    // List all members who have activity
    memberList: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        const { getActivityMemberList } = await import("./lmsDb");
        const userIds = await getActivityMemberList(input.orgId);
        // Fetch user details for each
        const { getUserById } = await import("./db");
        const members = await Promise.all(
          userIds.map(async (uid) => {
            const u = await getUserById(uid);
            return u ? { id: u.id, name: u.name, email: u.email } : null;
          })
        );
        return members.filter(Boolean);
      }),
  }),

  // ── Notification Settings ────────────────────────────────────────────────

  notifications: router({
    getOrgSettings: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        const { getOrgNotificationSettings } = await import("./lmsDb");
        return getOrgNotificationSettings(input.orgId);
      }),

    updateOrgSettings: protectedProcedure
      .input(
        z.object({
          orgId: z.number(),
          enrollment: z.boolean().optional(),
          completion: z.boolean().optional(),
          quizResult: z.boolean().optional(),
          reminder: z.boolean().optional(),
          announcement: z.boolean().optional(),
          weeklyDigest: z.boolean().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        const { updateOrgNotificationSettings } = await import("./lmsDb");
        const { orgId, ...settings } = input;
        return updateOrgNotificationSettings(orgId, settings);
      }),

    getCourseOverrides: protectedProcedure
      .input(z.object({ courseId: z.number() }))
      .query(async ({ input, ctx }) => {
        const course = await getCourseById(input.courseId);
        if (!course) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, course.orgId, ctx.user.role);
        const { getCourseNotificationOverrides } = await import("./lmsDb");
        return getCourseNotificationOverrides(input.courseId);
      }),

    updateCourseOverrides: protectedProcedure
      .input(
        z.object({
          courseId: z.number(),
          overrides: z.object({
            enrollment: z.boolean().optional(),
            completion: z.boolean().optional(),
            quizResult: z.boolean().optional(),
            reminder: z.boolean().optional(),
          }).nullable(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const course = await getCourseById(input.courseId);
        if (!course) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, course.orgId, ctx.user.role);
        const { updateCourseNotificationOverrides } = await import("./lmsDb");
        await updateCourseNotificationOverrides(input.courseId, input.overrides);
        return { ok: true };
      }),
  }),

  // ── Email Branding ───────────────────────────────────────────────────────

  emailBranding: router({
    get: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        const { getOrgEmailBranding } = await import("./lmsDb");
        return getOrgEmailBranding(input.orgId);
      }),

    update: protectedProcedure
      .input(
        z.object({
          orgId: z.number(),
          logoUrl: z.string().optional(),
          primaryColor: z.string().optional(),
          footerText: z.string().optional(),
          senderName: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        const { updateOrgEmailBranding } = await import("./lmsDb");
        const { orgId, ...branding } = input;
        return updateOrgEmailBranding(orgId, branding);
      }),
  }),

  // ── Digital Downloads ─────────────────────────────────────────────────
  downloads: router({
    // Product CRUD
    listProducts: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        return listDigitalProducts(input.orgId);
      }),

    getProduct: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const product = await getDigitalProduct(input.id);
        if (!product) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, product.orgId, ctx.user.role);
        return product;
      }),

    getProductBySlug: publicProcedure
      .input(z.object({ slug: z.string() }))
      .query(async ({ input }) => {
        const product = await getDigitalProductBySlug(input.slug);
        // Enforce visibility: only published and hidden products are accessible via URL
        // Draft, private (invite-only), and archived products are not accessible
        const visibility = (product as any)?.visibility ?? (product?.isPublished ? "published" : "draft");
        if (!product || (visibility !== "published" && visibility !== "hidden")) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }
        const prices = await listProductPrices(product.id);
        // Check if org has Stripe configured for checkout
        const db = await getDb();
        let hasStripe = false;
        if (db) {
          const { orgPaymentSettings } = await import("../drizzle/schema");
          const [paySettings] = await db
            .select({ hasStripe: orgPaymentSettings.stripeSecretKey })
            .from(orgPaymentSettings)
            .where(eq(orgPaymentSettings.orgId, product.orgId))
            .limit(1);
          hasStripe = !!(paySettings?.hasStripe);
        }
        return { ...product, prices: prices.filter((p) => p.isActive), hasStripe };
      }),

    createProduct: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        title: z.string(),
        slug: z.string(),
        description: z.string().optional(),
        fileUrl: z.string(),
        fileKey: z.string(),
        fileType: z.string().optional(),
        fileSize: z.number().optional(),
        thumbnailUrl: z.string().optional(),
        defaultAccessDays: z.number().nullable().optional(),
        defaultMaxDownloads: z.number().nullable().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        return createDigitalProduct(input as any);
      }),

    updateProduct: protectedProcedure
      .input(z.object({
        id: z.number(),
        title: z.string().optional(),
        slug: z.string().optional(),
        description: z.string().optional(),
        fileUrl: z.string().optional(),
        fileKey: z.string().optional(),
        fileType: z.string().optional(),
        fileSize: z.number().optional(),
        thumbnailUrl: z.string().optional(),
        salesPageBlocksJson: z.any().optional(),
        isPublished: z.boolean().optional(),
        defaultAccessDays: z.number().nullable().optional(),
        defaultMaxDownloads: z.number().nullable().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { id, ...data } = input;
        const product = await getDigitalProduct(id);
        if (!product) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, product.orgId, ctx.user.role);
        await updateDigitalProduct(id, data as any);
        return getDigitalProduct(id);
      }),

    deleteProduct: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const product = await getDigitalProduct(input.id);
        if (!product) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, product.orgId, ctx.user.role);
        await deleteDigitalProduct(input.id);
        return { ok: true };
      }),

    // Prices
    listPrices: protectedProcedure
      .input(z.object({ productId: z.number() }))
      .query(async ({ input, ctx }) => {
        const product = await getDigitalProduct(input.productId);
        if (!product) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, product.orgId, ctx.user.role);
        return listProductPrices(input.productId);
      }),

    upsertPrice: protectedProcedure
      .input(z.object({
        id: z.number().optional(),
        productId: z.number(),
        label: z.string(),
        type: z.enum(["one_time", "payment_plan"]),
        amount: z.string(),
        currency: z.string().optional(),
        installments: z.number().nullable().optional(),
        installmentAmount: z.string().nullable().optional(),
        intervalDays: z.number().nullable().optional(),
        isActive: z.boolean().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const product = await getDigitalProduct(input.productId);
        if (!product) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, product.orgId, ctx.user.role);
        return upsertProductPrice(input as any);
      }),

    deletePrice: protectedProcedure
      .input(z.object({ id: z.number(), productId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const product = await getDigitalProduct(input.productId);
        if (!product) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, product.orgId, ctx.user.role);
        await deleteProductPrice(input.id);
        return { ok: true };
      }),

    // Orders
    createOrder: publicProcedure
      .input(z.object({
        productId: z.number(),
        priceId: z.number(),
        buyerEmail: z.string().email(),
        buyerName: z.string().optional(),
        paymentRef: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const product = await getDigitalProduct(input.productId);
        if (!product) throw new TRPCError({ code: "NOT_FOUND" });
        const prices = await listProductPrices(input.productId);
        const price = prices.find((p) => p.id === input.priceId);
        if (!price) throw new TRPCError({ code: "NOT_FOUND", message: "Price not found" });
        // Calculate access expiry
        const accessExpiresAt = product.defaultAccessDays
          ? new Date(Date.now() + product.defaultAccessDays * 86400000)
          : null;
        const order = await createDigitalOrder({
          productId: input.productId,
          priceId: input.priceId,
          orgId: product.orgId,
          buyerEmail: input.buyerEmail,
          buyerName: input.buyerName,
          amount: price.amount,
          currency: price.currency ?? "USD",
          paymentRef: input.paymentRef,
          accessExpiresAt,
          maxDownloads: product.defaultMaxDownloads ?? null,
        });
        // Auto-mark as paid if no payment ref required (free or manual)
        if (input.paymentRef) {
          await markOrderPaid(order.id, input.paymentRef);
        }
        return order;
      }),

    confirmPayment: protectedProcedure
      .input(z.object({ orderId: z.number(), paymentRef: z.string().optional() }))
      .mutation(async ({ input, ctx }) => {
        const order = await getOrderById(input.orderId);
        if (!order) throw new TRPCError({ code: "NOT_FOUND" });
        const product = await getDigitalProduct(order.productId);
        if (!product) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, product.orgId, ctx.user.role);
        await markOrderPaid(input.orderId, input.paymentRef);
        return { ok: true };
      }),

    getOrderByToken: publicProcedure
      .input(z.object({ token: z.string() }))
      .query(async ({ input }) => {
        const order = await getOrderByToken(input.token);
        if (!order) throw new TRPCError({ code: "NOT_FOUND" });
        const product = await getDigitalProduct(order.productId);
        const now = new Date();
        const expired = order.accessExpiresAt ? order.accessExpiresAt < now : false;
        const limitReached = order.maxDownloads ? (order.downloadCount ?? 0) >= order.maxDownloads : false;
        return {
          ...order,
          product: product ? { title: product.title, thumbnailUrl: product.thumbnailUrl } : null,
          canDownload: order.status === "paid" && !expired && !limitReached,
          expired,
          limitReached,
        };
      }),

    listOrders: protectedProcedure
      .input(z.object({ orgId: z.number(), productId: z.number().optional() }))
      .query(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        if (input.productId) return listOrdersForProduct(input.productId);
        return listOrdersForOrg(input.orgId);
      }),

    updateOrderStatus: protectedProcedure
      .input(z.object({ id: z.number(), status: z.string(), notes: z.string().optional() }))
      .mutation(async ({ input, ctx }) => {
        const order = await getOrderById(input.id);
        if (!order) throw new TRPCError({ code: "NOT_FOUND" });
        const product = await getDigitalProduct(order.productId);
        if (!product) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, product.orgId, ctx.user.role);
        await updateOrderStatus(input.id, input.status, input.notes);
        return { ok: true };
      }),

    listDownloadLogs: protectedProcedure
      .input(z.object({ orgId: z.number(), productId: z.number().optional() }))
      .query(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        if (input.productId) return listDownloadLogs(input.productId);
        // Return logs for all products in this org
        const products = await listDigitalProducts(input.orgId);
        const allLogs = await Promise.all(products.map((p) => listDownloadLogs(p.id)));
        return allLogs.flat().sort((a, b) => new Date(b.downloadedAt!).getTime() - new Date(a.downloadedAt!).getTime());
      }),
  }),

  // ── Webinars ─────────────────────────────────────────────────────────────
  webinars: router({
    list: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        return getWebinarsByOrg(input.orgId);
      }),

    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const w = await getWebinarById(input.id);
        if (!w) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgRole(ctx.user.id, w.orgId, undefined, ctx.user.role);
        return w;
      }),

    getBySlug: publicProcedure
      .input(z.object({ slug: z.string() }))
      .query(async ({ input }) => {
        return getPublishedWebinarBySlug(input.slug);
      }),

    create: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        title: z.string(),
        slug: z.string(),
        type: z.enum(["live", "evergreen"]).default("evergreen"),
      }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        // Webinars require Builder plan or higher (bypassed for platform admins and org super admins)
        if (ctx.user.role !== "site_owner" && ctx.user.role !== "site_admin" && ctx.user.role !== "org_super_admin") {
          const sub = await getOrgSubscription(input.orgId);
          if (!getLimits(sub?.plan).upsellFunnels) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Webinars require a Builder plan or higher. Please upgrade your organization's plan to access this feature.",
            });
          }
        }
        return createWebinar(input as any);
      }),

    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        title: z.string().optional(),
        slug: z.string().optional(),
        description: z.string().nullish(),
        type: z.enum(["live", "evergreen"]).optional(),
        videoSource: z.enum(["upload", "youtube", "vimeo", "zoom", "teams", "embed"]).optional(),
        videoUrl: z.string().nullish(),
        videoFileUrl: z.string().nullish(),
        videoFileKey: z.string().nullish(),
        meetingUrl: z.string().nullish(),
        meetingId: z.string().nullish(),
        scheduledAt: z.string().nullish(),
        durationMinutes: z.number().nullish(),
        timezone: z.string().optional(),
        replayDelayMinutes: z.number().optional(),
        aiViewersEnabled: z.boolean().optional(),
        aiViewersMin: z.number().optional(),
        aiViewersMax: z.number().optional(),
        aiViewersPeakAt: z.number().optional(),
        salesPageBlocksJson: z.any().optional(),
        thumbnailUrl: z.string().nullish(),
        requireRegistration: z.boolean().optional(),
        registrationFormFields: z.any().optional(),
        postWebinarAction: z.enum(["product", "url", "thankyou", "none"]).optional(),
        postWebinarProductId: z.number().nullish(),
        postWebinarUrl: z.string().nullish(),
        postWebinarMessage: z.string().nullish(),
        postWebinarDelaySeconds: z.number().optional(),
        isPublished: z.boolean().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { id, ...data } = input;
        const w = await getWebinarById(id);
        if (!w) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, w.orgId, ctx.user.role);
        const updateData: any = { ...data };
        if (data.scheduledAt) updateData.scheduledAt = new Date(data.scheduledAt);
        return updateWebinar(id, updateData);
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const w = await getWebinarById(input.id);
        if (!w) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, w.orgId, ctx.user.role);
        await deleteWebinar(input.id);
        return { ok: true };
      }),

    // Funnel steps
    getFunnelSteps: protectedProcedure
      .input(z.object({ webinarId: z.number() }))
      .query(async ({ input, ctx }) => {
        const w = await getWebinarById(input.webinarId);
        if (!w) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgRole(ctx.user.id, w.orgId, undefined, ctx.user.role);
        return getWebinarFunnelSteps(input.webinarId);
      }),

    saveFunnelSteps: protectedProcedure
      .input(z.object({
        webinarId: z.number(),
        steps: z.array(z.object({
          stepType: z.enum(["registration", "confirmation", "reminder", "watch", "offer", "thankyou"]),
          title: z.string().optional(),
          pageBlocksJson: z.any().optional(),
          emailSubject: z.string().optional(),
          emailBody: z.string().optional(),
          triggerType: z.enum(["immediate", "delay", "scheduled"]).optional(),
          triggerDelayMinutes: z.number().optional(),
          isActive: z.boolean().optional(),
        })),
      }))
      .mutation(async ({ input, ctx }) => {
        const w = await getWebinarById(input.webinarId);
        if (!w) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, w.orgId, ctx.user.role);
        await upsertWebinarFunnelSteps(input.webinarId, input.steps as any);
        return { ok: true };
      }),

    // Registration (public)
    register: publicProcedure
      .input(z.object({
        webinarId: z.number(),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        email: z.string().email(),
        phone: z.string().optional(),
        customFields: z.any().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const w = await getWebinarById(input.webinarId);
        if (!w) throw new TRPCError({ code: "NOT_FOUND" });
        // Upsert registration
        const existing = await getWebinarRegistrationByEmail(input.webinarId, input.email);
        if (existing) return { registration: existing, alreadyRegistered: true };
        const reg = await createWebinarRegistration({
          webinarId: input.webinarId,
          orgId: w.orgId,
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          phone: input.phone,
          customFields: input.customFields,
          ipAddress: (ctx as any).req?.ip,
        });
        return { registration: reg, alreadyRegistered: false };
      }),

    // Start session (creates a session token for the watch page)
    startSession: publicProcedure
      .input(z.object({
        webinarId: z.number(),
        registrationId: z.number().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const token = nanoid(32);
        const session = await createWebinarSession({
          webinarId: input.webinarId,
          registrationId: input.registrationId,
          sessionToken: token,
          ipAddress: (ctx as any).req?.ip,
          userAgent: (ctx as any).req?.headers?.['user-agent'],
        });
        return { sessionToken: token, sessionId: session?.id };
      }),

    // Heartbeat (updates watch time)
    heartbeat: publicProcedure
      .input(z.object({
        sessionToken: z.string(),
        watchedSeconds: z.number(),
        currentViewerCount: z.number().optional(),
      }))
      .mutation(async ({ input }) => {
        const session = await getWebinarSessionByToken(input.sessionToken);
        if (!session) return { ok: false };
        await updateWebinarSession(session.id, {
          watchedSeconds: input.watchedSeconds,
          lastHeartbeatAt: new Date(),
          peakViewerCount: Math.max(session.peakViewerCount ?? 0, input.currentViewerCount ?? 0),
        });
        // Mark registration as attended if watched > 60s
        if (session.registrationId && input.watchedSeconds > 60) {
          await updateWebinarRegistration(session.registrationId, { attended: true, watchedSeconds: input.watchedSeconds });
        }
        return { ok: true };
      }),

    // Mark conversion (clicked post-webinar CTA)
    markConverted: publicProcedure
      .input(z.object({ registrationId: z.number() }))
      .mutation(async ({ input }) => {
        await updateWebinarRegistration(input.registrationId, { convertedAt: new Date() });
        return { ok: true };
      }),

    // AI viewer count generator
    getAiViewerCount: publicProcedure
      .input(z.object({
        webinarId: z.number(),
        elapsedMinutes: z.number(),
      }))
      .query(async ({ input }) => {
        const w = await getWebinarById(input.webinarId);
        if (!w || !w.aiViewersEnabled) return { count: 0 };
        const min = w.aiViewersMin ?? 50;
        const max = w.aiViewersMax ?? 300;
        const peak = w.aiViewersPeakAt ?? 30;
        const elapsed = input.elapsedMinutes;
        const duration = w.durationMinutes ?? 60;
        // Bell-curve style: ramp up to peak, then gradually decline
        let ratio: number;
        if (elapsed <= peak) {
          ratio = elapsed / peak;
        } else {
          ratio = 1 - ((elapsed - peak) / (duration - peak)) * 0.4;
        }
        ratio = Math.max(0.1, Math.min(1, ratio));
        const base = Math.round(min + (max - min) * ratio);
        // Add small random jitter ±5%
        const jitter = Math.round(base * 0.05 * (Math.random() * 2 - 1));
        return { count: Math.max(1, base + jitter) };
      }),

    // Reports
    getRegistrations: protectedProcedure
      .input(z.object({ webinarId: z.number() }))
      .query(async ({ input, ctx }) => {
        const w = await getWebinarById(input.webinarId);
        if (!w) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgRole(ctx.user.id, w.orgId, undefined, ctx.user.role);
        return getWebinarRegistrations(input.webinarId);
      }),

    getStats: protectedProcedure
      .input(z.object({ webinarId: z.number() }))
      .query(async ({ input, ctx }) => {
        const w = await getWebinarById(input.webinarId);
        if (!w) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgRole(ctx.user.id, w.orgId, undefined, ctx.user.role);
        return getWebinarStats(input.webinarId);
      }),
  }),

  // ── Email Marketing ─────────────────────────────────────────────────────
  emailMarketing: router({
    list: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        return listEmailCampaigns(input.orgId);
      }),
    stats: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        return getEmailCampaignStats(input.orgId);
      }),
    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const c = await getEmailCampaignById(input.id);
        if (!c) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, c.orgId!, ctx.user.role);
        return c;
      }),
    create: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        name: z.string().min(1),
        subject: z.string().min(1),
        htmlBody: z.string(),
        textBody: z.string().optional(),
        scheduledAt: z.date().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        return createEmailCampaign({ ...input, createdBy: ctx.user.id });
      }),
    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        name: z.string().optional(),
        subject: z.string().optional(),
        htmlBody: z.string().optional(),
        textBody: z.string().optional(),
        status: z.enum(["draft", "scheduled", "sending", "sent", "failed"]).optional(),
        scheduledAt: z.date().optional().nullable(),
      }))
      .mutation(async ({ input, ctx }) => {
        const c = await getEmailCampaignById(input.id);
        if (!c) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, c.orgId!, ctx.user.role);
        const { id, ...data } = input;
        return updateEmailCampaign(id, data);
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const c = await getEmailCampaignById(input.id);
        if (!c) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, c.orgId!, ctx.user.role);
        await deleteEmailCampaign(input.id);
        return { ok: true };
      }),
    send: protectedProcedure
      .input(z.object({
        id: z.number(),
        audience: z.enum(["all_members", "enrolled_students", "custom"]).default("all_members"),
        courseId: z.number().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const c = await getEmailCampaignById(input.id);
        if (!c) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, c.orgId!, ctx.user.role);
        if (c.status === "sent") throw new TRPCError({ code: "BAD_REQUEST", message: "Campaign already sent" });
        // Mark as sending
        await updateEmailCampaign(input.id, { status: "sending" });
        // Gather recipients
        const members = await getOrgMembers(c.orgId!);
        const recipientUserIds = members.map((m: any) => m.userId).filter(Boolean) as number[];
        let sentCount = 0;
        let failedCount = 0;
        for (const userId of recipientUserIds) {
          const user = await getUserById(userId);
          if (!user?.email) { failedCount++; continue; }
          const unsubToken = buildUnsubscribeToken(c.orgId!, userId);
          const html = resolveMergeTags(c.htmlBody, {
            user_name: user.name ?? user.email,
            org_name: String(c.orgId),
            course_title: "",
            unsubscribe_url: `${process.env.VITE_OAUTH_PORTAL_URL ?? ""}/unsubscribe?token=${unsubToken}`,
            site_url: process.env.VITE_OAUTH_PORTAL_URL ?? "",
            year: String(new Date().getFullYear()),
          });
          const ok = await sendEmail({ to: user.email, subject: c.subject, html });
          if (ok) sentCount++; else failedCount++;
        }
        await updateEmailCampaign(input.id, {
          status: "sent",
          sentAt: new Date(),
          sentCount,
          failedCount,
          recipientCount: recipientUserIds.length,
        });
        return { sentCount, failedCount, total: recipientUserIds.length };
      }),
  }),
  // ── Media Upload ────────────────────────────────────────────────────────
  media: router({
    // List all media items for an org (with optional type/search filter)
    listOrgMedia: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        typeFilter: z.enum(["all", "image", "video", "audio", "document", "archive"]).default("all"),
        search: z.string().optional(),
        page: z.number().default(1),
        pageSize: z.number().default(50),
        folderId: z.number().nullable().optional(), // null = root, undefined = all folders
      }))
      .query(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const db = await getDb();
        if (!db) return { items: [], total: 0 };
        const { orgMediaLibrary } = await import("../drizzle/schema");
        const rows = await db.select().from(orgMediaLibrary)
          .where(eq(orgMediaLibrary.orgId, input.orgId))
          .orderBy(desc(orgMediaLibrary.createdAt));
        let filtered = rows;
        // Folder filter: null = root (no folder), number = specific folder, undefined = all
        if (input.folderId !== undefined) {
          if (input.folderId === null) {
            filtered = filtered.filter(r => r.folderId === null);
          } else {
            filtered = filtered.filter(r => r.folderId === input.folderId);
          }
        }
        if (input.typeFilter !== "all") {
          filtered = filtered.filter(r => {
            const m = r.mimeType;
            if (input.typeFilter === "image") return m.startsWith("image/");
            if (input.typeFilter === "video") return m.startsWith("video/");
            if (input.typeFilter === "audio") return m.startsWith("audio/");
            if (input.typeFilter === "archive") return m === "application/zip" || m === "application/x-zip-compressed" || m.includes("zip");
            if (input.typeFilter === "document") return (
              m === "application/pdf" ||
              m === "application/msword" ||
              m.includes("wordprocessingml") ||
              m.includes("officedocument")
            );
            return true;
          });
        }
        if (input.search) {
          const q = input.search.toLowerCase();
          filtered = filtered.filter(r => r.filename.toLowerCase().includes(q));
        }
        const total = filtered.length;
        const start = (input.page - 1) * input.pageSize;
        return {
          items: filtered.slice(start, start + input.pageSize).map(r => ({
            ...r,
            tags: r.tags ? JSON.parse(r.tags) : [],
          })),
          total,
        };
      }),
    // Folder CRUD
    listFolders: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const db = await getDb();
        if (!db) return [];
        const { orgMediaFolders, orgMediaLibrary: oml } = await import("../drizzle/schema");
        const folders = await db.select().from(orgMediaFolders)
          .where(eq(orgMediaFolders.orgId, input.orgId))
          .orderBy(orgMediaFolders.name);
        // Count items per folder
        const allItems = await db.select({ id: oml.id, folderId: oml.folderId })
          .from(oml).where(eq(oml.orgId, input.orgId));
        const countMap: Record<number, number> = {};
        for (const item of allItems) {
          if (item.folderId != null) countMap[item.folderId] = (countMap[item.folderId] ?? 0) + 1;
        }
        const rootCount = allItems.filter(i => i.folderId === null).length;
        return { folders: folders.map(f => ({ ...f, count: countMap[f.id] ?? 0 })), rootCount };
      }),
    createFolder: protectedProcedure
      .input(z.object({ orgId: z.number(), name: z.string().min(1).max(255) }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const { orgMediaFolders } = await import("../drizzle/schema");
        const [result] = await db.insert(orgMediaFolders).values({ orgId: input.orgId, name: input.name });
        return { id: (result as any).insertId, name: input.name };
      }),
    renameFolder: protectedProcedure
      .input(z.object({ orgId: z.number(), id: z.number(), name: z.string().min(1).max(255) }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const { orgMediaFolders } = await import("../drizzle/schema");
        await db.update(orgMediaFolders).set({ name: input.name }).where(eq(orgMediaFolders.id, input.id));
        return { ok: true };
      }),
    deleteFolder: protectedProcedure
      .input(z.object({ orgId: z.number(), id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const { orgMediaFolders, orgMediaLibrary: oml } = await import("../drizzle/schema");
        // Move all items in this folder back to root
        await db.update(oml).set({ folderId: null }).where(eq(oml.folderId, input.id));
        await db.delete(orgMediaFolders).where(eq(orgMediaFolders.id, input.id));
        return { ok: true };
      }),
    // Bulk operations
    bulkDelete: protectedProcedure
      .input(z.object({ orgId: z.number(), ids: z.array(z.number()).min(1) }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const { orgMediaLibrary } = await import("../drizzle/schema");
        const { inArray } = await import("drizzle-orm");
        await db.delete(orgMediaLibrary).where(inArray(orgMediaLibrary.id, input.ids));
        return { deleted: input.ids.length };
      }),
    bulkMoveToFolder: protectedProcedure
      .input(z.object({ orgId: z.number(), ids: z.array(z.number()).min(1), folderId: z.number().nullable() }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const { orgMediaLibrary } = await import("../drizzle/schema");
        const { inArray } = await import("drizzle-orm");
        await db.update(orgMediaLibrary)
          .set({ folderId: input.folderId })
          .where(inArray(orgMediaLibrary.id, input.ids));
        return { moved: input.ids.length };
      }),
    // Delete a media item by ID
    deleteOrgMedia: protectedProcedure
      .input(z.object({ orgId: z.number(), id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const { orgMediaLibrary } = await import("../drizzle/schema");
        await db.delete(orgMediaLibrary).where(eq(orgMediaLibrary.id, input.id));
        return { ok: true };
      }),
    renameOrgMedia: protectedProcedure
      .input(z.object({ orgId: z.number(), id: z.number(), filename: z.string().min(1).max(255) }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const { orgMediaLibrary } = await import("../drizzle/schema");
        await db.update(orgMediaLibrary)
          .set({ filename: input.filename })
          .where(eq(orgMediaLibrary.id, input.id));
        return { ok: true };
      }),
    getUploadUrl: protectedProcedure
      .input(
        z.object({
          orgId: z.number(),
          fileName: z.string(),
          contentType: z.string(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const ext = input.fileName.split(".").pop() ?? "bin";
        const key = `lms-media/${input.orgId}/${Date.now()}-${nanoid(8)}.${ext}`;
        const { url } = await storagePut(key, Buffer.alloc(0), input.contentType);
        const fileUrl = url.split("?")[0];
        return { key, fileUrl, uploadUrl: url };
      }),
    saveRecording: protectedProcedure
      .input(
        z.object({
          orgId: z.number(),
          fileName: z.string(),
          contentType: z.string(),
          fileSize: z.number(),
          fileKey: z.string(),
          url: z.string(),
          duration: z.number().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const { orgMediaLibrary } = await import("../drizzle/schema");
        const [result] = await db.insert(orgMediaLibrary).values({
          orgId: input.orgId,
          uploadedBy: ctx.user.id,
          filename: input.fileName,
          mimeType: input.contentType,
          fileSize: input.fileSize,
          fileKey: input.fileKey,
          url: input.url,
          source: "direct",
          tags: JSON.stringify(["recording"]),
        });
        return { id: (result as any).insertId, url: input.url };
      }),
    transcribe: protectedProcedure
      .input(
        z.object({
          orgId: z.number(),
          fileUrl: z.string(),
          language: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        try {
          const result = await transcribeAudio({
            audioUrl: input.fileUrl,
            language: input.language,
            prompt: "Transcribe this screen recording audio",
          });
          if ("error" in result) {
            throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: (result as any).error ?? "Transcription failed" });
          }
          return { text: (result as any).text ?? "", segments: (result as any).segments ?? [] };
        } catch (err: any) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: err?.message ?? "Transcription failed" });
        }
      }),
    // Save an uploaded video/audio file to the org media library
    saveMediaItem: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        fileName: z.string(),
        mimeType: z.string(),
        fileSize: z.number(),
        fileKey: z.string(),
        url: z.string(),
        durationSeconds: z.number().optional(),
        tags: z.array(z.string()).optional(),
        source: z.enum(["form", "course", "direct", "other"]).default("direct"),
        sourceId: z.number().optional(),
        folderId: z.number().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const { orgMediaLibrary } = await import("../drizzle/schema");
        const [result] = await db.insert(orgMediaLibrary).values({
          orgId: input.orgId,
          uploadedBy: ctx.user.id,
          filename: input.fileName,
          mimeType: input.mimeType,
          fileSize: input.fileSize,
          fileKey: input.fileKey,
          url: input.url,
          durationSeconds: input.durationSeconds ?? null,
          source: input.source,
          sourceId: input.sourceId ?? null,
          tags: input.tags ? JSON.stringify(input.tags) : null,
          folderId: input.folderId ?? null,
        });
        const id = (result as any).insertId as number;
        const rows = await db.select().from(orgMediaLibrary).where(eq(orgMediaLibrary.id, id)).limit(1);
        return rows[0];
      }),
    // Get a single media item by ID
    getMediaItem: protectedProcedure
      .input(z.object({ orgId: z.number(), id: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const db = await getDb();
        if (!db) return null;
        const { orgMediaLibrary } = await import("../drizzle/schema");
        const rows = await db.select().from(orgMediaLibrary)
          .where(eq(orgMediaLibrary.id, input.id))
          .limit(1);
        return rows[0] ?? null;
      }),
    // Generate closed captions for a media item via Whisper, save VTT to S3, update DB
    generateCaptions: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        mediaItemId: z.number(),
        fileUrl: z.string(),
        language: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        console.log("[generateCaptions] Starting for mediaItemId:", input.mediaItemId, "url:", input.fileUrl?.substring(0, 80));
        const result = await transcribeAudio({
          audioUrl: input.fileUrl,
          language: input.language,
          prompt: "Transcribe this video or audio recording",
        });
        console.log("[generateCaptions] Result keys:", Object.keys(result), "error" in result ? `ERROR: ${(result as any).error} | ${(result as any).details}` : `OK segments=${(result as any).segments?.length}`);
        if ("error" in result) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `${(result as any).error}: ${(result as any).details ?? ""}` });
        }
        const segments = (result as any).segments ?? [];
        const fullText = (result as any).text ?? "";
        const toVttTime = (sec: number) => {
          const h = Math.floor(sec / 3600).toString().padStart(2, "0");
          const m = Math.floor((sec % 3600) / 60).toString().padStart(2, "0");
          const s = Math.floor(sec % 60).toString().padStart(2, "0");
          const ms = Math.round((sec % 1) * 1000).toString().padStart(3, "0");
          return `${h}:${m}:${s}.${ms}`;
        };
        let vtt = "WEBVTT\n\n";
        for (const seg of segments) {
          vtt += `${toVttTime(seg.start)} --> ${toVttTime(seg.end)}\n${seg.text.trim()}\n\n`;
        }
        const vttKey = `captions/${input.orgId}/${input.mediaItemId}-${Date.now()}.vtt`;
        const { url: captionsUrl } = await storagePut(vttKey, Buffer.from(vtt, "utf-8"), "text/vtt");
        const { orgMediaLibrary } = await import("../drizzle/schema");
        await db.update(orgMediaLibrary)
          .set({ captionsUrl, transcriptJson: JSON.stringify(segments), updatedAt: new Date() })
          .where(eq(orgMediaLibrary.id, input.mediaItemId));
        return { captionsUrl, vtt, segments, text: fullText };
      }),
    // Update captions/transcript on an existing media item (after user edits)
    updateCaptions: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        mediaItemId: z.number(),
        segments: z.array(z.object({
          id: z.number(),
          start: z.number(),
          end: z.number(),
          text: z.string(),
        })),
      }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const toVttTime = (sec: number) => {
          const h = Math.floor(sec / 3600).toString().padStart(2, "0");
          const m = Math.floor((sec % 3600) / 60).toString().padStart(2, "0");
          const s = Math.floor(sec % 60).toString().padStart(2, "0");
          const ms = Math.round((sec % 1) * 1000).toString().padStart(3, "0");
          return `${h}:${m}:${s}.${ms}`;
        };
        let vtt = "WEBVTT\n\n";
        for (const seg of input.segments) {
          vtt += `${toVttTime(seg.start)} --> ${toVttTime(seg.end)}\n${seg.text.trim()}\n\n`;
        }
        const vttKey = `captions/${input.orgId}/${input.mediaItemId}-${Date.now()}-edited.vtt`;
        const { url: captionsUrl } = await storagePut(vttKey, Buffer.from(vtt, "utf-8"), "text/vtt");
        const { orgMediaLibrary } = await import("../drizzle/schema");
        await db.update(orgMediaLibrary)
          .set({ captionsUrl, transcriptJson: JSON.stringify(input.segments), updatedAt: new Date() })
          .where(eq(orgMediaLibrary.id, input.mediaItemId));
        return { captionsUrl, vtt };
      }),
    // Save a highlight clip definition (start/end timestamps) for a media item
    saveClip: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        mediaItemId: z.number(),
        label: z.string().default("Clip"),
        startSec: z.number(),
        endSec: z.number(),
      }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const { videoClips } = await import("../drizzle/schema");
        const [result] = await db.insert(videoClips).values({
          orgId: input.orgId,
          mediaItemId: input.mediaItemId,
          label: input.label,
          startSec: input.startSec,
          endSec: input.endSec,
          createdBy: ctx.user.id,
        });
        const id = (result as any).insertId as number;
        const rows = await db.select().from(videoClips).where(eq(videoClips.id, id)).limit(1);
        return rows[0];
      }),
    // List clips for a media item
    listClips: protectedProcedure
      .input(z.object({ orgId: z.number(), mediaItemId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const db = await getDb();
        if (!db) return [];
        const { videoClips } = await import("../drizzle/schema");
        return db.select().from(videoClips)
          .where(eq(videoClips.mediaItemId, input.mediaItemId))
          .orderBy(videoClips.startSec);
      }),
    // Update a clip label/timestamps
    updateClip: protectedProcedure
      .input(z.object({ id: z.number(), orgId: z.number(), label: z.string().optional(), startSec: z.number().optional(), endSec: z.number().optional() }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const { videoClips } = await import("../drizzle/schema");
        const updates: Record<string, any> = { updatedAt: new Date() };
        if (input.label !== undefined) updates.label = input.label;
        if (input.startSec !== undefined) updates.startSec = input.startSec;
        if (input.endSec !== undefined) updates.endSec = input.endSec;
        await db.update(videoClips).set(updates).where(eq(videoClips.id, input.id));
        return { success: true };
      }),
    // Delete a clip
    deleteClip: protectedProcedure
      .input(z.object({ id: z.number(), orgId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const { videoClips } = await import("../drizzle/schema");
        await db.delete(videoClips).where(eq(videoClips.id, input.id));
        return { success: true };
      }),

    // Extract a clip from a media item using FFmpeg (trim to start/end), upload to S3
    extractClip: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        mediaItemId: z.number(),
        clipId: z.number().optional(),
        label: z.string().default("Clip"),
        startSec: z.number(),
        endSec: z.number(),
        sourceUrl: z.string(),
      }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const { execFile } = await import("child_process");
        const { promisify } = await import("util");
        const fs = await import("fs");
        const os = await import("os");
        const path = await import("path");
        const execFileAsync = promisify(execFile);
        const tmpDir = os.tmpdir();
        const suffix = Date.now();
        const tmpIn = path.join(tmpDir, `clip-in-${suffix}.mp4`);
        const tmpOut = path.join(tmpDir, `clip-out-${suffix}.mp4`);
        try {
          const res = await fetch(input.sourceUrl);
          if (!res.ok) throw new Error(`Failed to fetch source video: ${res.status}`);
          const arrayBuf = await res.arrayBuffer();
          await fs.promises.writeFile(tmpIn, Buffer.from(arrayBuf));
          const duration = input.endSec - input.startSec;
          await execFileAsync("ffmpeg", [
            "-y",
            "-ss", String(input.startSec),
            "-i", tmpIn,
            "-t", String(duration),
            "-c", "copy",
            tmpOut,
          ]);
          const clipBuffer = await fs.promises.readFile(tmpOut);
          const safeName = input.label.replace(/[^a-z0-9_-]/gi, "-").slice(0, 40);
          const clipKey = `lms-media/${input.orgId}/clips/${input.mediaItemId}-${safeName}-${suffix}.mp4`;
          const { url: clipUrl } = await storagePut(clipKey, clipBuffer, "video/mp4");
          if (input.clipId) {
            const { videoClips } = await import("../drizzle/schema");
            await db.update(videoClips)
              .set({ videoUrl: clipUrl, videoKey: clipKey, updatedAt: new Date() })
              .where(eq(videoClips.id, input.clipId));
          }
          return { url: clipUrl, key: clipKey, fileSize: clipBuffer.length };
        } finally {
          fs.promises.unlink(tmpIn).catch(() => {});
          fs.promises.unlink(tmpOut).catch(() => {});
        }
      }),
    // ── Burn Captions into Video ───────────────────────────────────────────
    burnCaptions: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        mediaItemId: z.number(),
        sourceUrl: z.string(),
        segments: z.array(z.object({
          start: z.number(),
          end: z.number(),
          text: z.string(),
        })),
        style: z.object({
          textColor: z.string().default("#FFFFFF"),
          bgColor: z.string().default("#000000"),
          bgOpacity: z.number().min(0).max(1).default(0.6),
          fontSize: z.number().min(12).max(72).default(28),
          bold: z.boolean().default(true),
          italic: z.boolean().default(false),
          shadow: z.boolean().default(true),
          position: z.enum(["bottom", "top", "center"]).default("bottom"),
        }),
      }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const { execFile } = await import("child_process");
        const { promisify } = await import("util");
        const fs = await import("fs");
        const os = await import("os");
        const path = await import("path");
        const execFileAsync = promisify(execFile);
        const tmpDir = os.tmpdir();
        const suffix = Date.now();
        const tmpIn = path.join(tmpDir, `burn-in-${suffix}.mp4`);
        const tmpAss = path.join(tmpDir, `burn-${suffix}.ass`);
        const tmpOut = path.join(tmpDir, `burn-out-${suffix}.mp4`);

        // Helper: convert hex color (#RRGGBB) to ASS color (&H00BBGGRR)
        function hexToAss(hex: string): string {
          const c = hex.replace("#", "").padEnd(6, "0");
          const r = c.slice(0, 2);
          const g = c.slice(2, 4);
          const b = c.slice(4, 6);
          return `&H00${b}${g}${r}`;
        }
        function hexToAssWithAlpha(hex: string, opacity: number): string {
          const c = hex.replace("#", "").padEnd(6, "0");
          const r = c.slice(0, 2);
          const g = c.slice(2, 4);
          const b = c.slice(4, 6);
          const alpha = Math.round((1 - opacity) * 255).toString(16).padStart(2, "0").toUpperCase();
          return `&H${alpha}${b}${g}${r}`;
        }
        function toAssTime(sec: number): string {
          const h = Math.floor(sec / 3600);
          const m = Math.floor((sec % 3600) / 60);
          const s = Math.floor(sec % 60);
          const cs = Math.round((sec % 1) * 100);
          return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
        }
        function sanitizeText(text: string): string {
          // Strip emoji (surrogate pairs) and special chars that ASS can't render
          // Use surrogate pair range for emoji (ES5 compatible, no unicode flag needed)
          return text
            .split("")
            .filter(ch => {
              const code = ch.charCodeAt(0);
              // Remove surrogate pairs (emoji) and misc symbols
              return !(code >= 0xD800 && code <= 0xDFFF) && !(code >= 0x2600 && code <= 0x27BF);
            })
            .join("")
            .replace(/[\r\n]+/g, " ")
            .trim();
        }

        const { style, segments } = input;
        const alignment = style.position === "top" ? 8 : style.position === "center" ? 5 : 2;
        const marginV = style.position === "top" ? 20 : 30;
        const primaryColor = hexToAss(style.textColor);
        const backColor = hexToAssWithAlpha(style.bgColor, style.bgOpacity);
        const boldFlag = style.bold ? "-1" : "0";
        const italicFlag = style.italic ? "-1" : "0";
        const shadowVal = style.shadow ? "1" : "0";
        const borderStyle = style.bgOpacity > 0.05 ? "3" : "1";
        const outline = style.bgOpacity > 0.05 ? "0" : (style.shadow ? "1" : "2");

        const assContent = [
          "[Script Info]",
          "ScriptType: v4.00+",
          "PlayResX: 1920",
          "PlayResY: 1080",
          "ScaledBorderAndShadow: yes",
          "",
          "[V4+ Styles]",
          "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
          `Style: Default,Arial,${style.fontSize},${primaryColor},&H000000FF,&H00000000,${backColor},${boldFlag},${italicFlag},0,0,100,100,0,0,${borderStyle},${outline},${shadowVal},${alignment},10,10,${marginV},1`,
          "",
          "[Events]",
          "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
          ...segments.map(seg =>
            `Dialogue: 0,${toAssTime(seg.start)},${toAssTime(seg.end)},Default,,0,0,0,,${sanitizeText(seg.text)}`
          ),
        ].join("\n");

        console.log(`[burnCaptions] Starting mediaItemId=${input.mediaItemId}, segments=${segments.length}`);
        try {
          const res = await fetch(input.sourceUrl);
          if (!res.ok) throw new Error(`Failed to fetch source video: ${res.status}`);
          const arrayBuf = await res.arrayBuffer();
          await fs.promises.writeFile(tmpIn, Buffer.from(arrayBuf));
          await fs.promises.writeFile(tmpAss, assContent, "utf-8");
          // Check if user is on free/trial — add watermark if so
          let showVideoWatermark = true;
          const dbForWm = await getDb();
          if (dbForWm) {
            const { users: usersTable } = await import("../drizzle/schema");
            const [wmUser] = await dbForWm.select({
              studioAccess: usersTable.studioAccess,
              studioTrialEndsAt: usersTable.studioTrialEndsAt,
            }).from(usersTable).where(eq(usersTable.id, ctx.user.id));
            const sRole = (wmUser as any)?.studioAccess ?? "none";
            const sTrial = (wmUser as any)?.studioTrialEndsAt ?? null;
            const isTrialing = sRole !== "none" && sTrial && new Date(sTrial) > new Date();
            showVideoWatermark = !(sRole !== "none" && !isTrialing);
          }
          const vfFilter = showVideoWatermark
            ? `ass=${tmpAss},drawtext=text='Created with Teachific\u2122':fontcolor=white:fontsize=20:box=1:boxcolor=0x189aa1@0.85:boxborderw=8:x=w-tw-20:y=h-th-20`
            : `ass=${tmpAss}`;
          await execFileAsync("ffmpeg", [
            "-y",
            "-i", tmpIn,
            "-vf", vfFilter,
            "-c:v", "libx264",
            "-preset", "fast",
            "-crf", "23",
            "-c:a", "aac",
            "-movflags", "+faststart",
            tmpOut,
          ], { maxBuffer: 200 * 1024 * 1024 });
          const outBuffer = await fs.promises.readFile(tmpOut);
          const fileKey = `lms-media/${input.orgId}/burned/${input.mediaItemId}-burned-${suffix}.mp4`;
          const { url: burnedUrl } = await storagePut(fileKey, outBuffer, "video/mp4");
          console.log(`[burnCaptions] Done — ${(outBuffer.length / 1024 / 1024).toFixed(1)}MB uploaded`);
          return { url: burnedUrl, fileSize: outBuffer.length };
        } finally {
          fs.promises.unlink(tmpIn).catch(() => {});
          fs.promises.unlink(tmpAss).catch(() => {});
          fs.promises.unlink(tmpOut).catch(() => {});
        }
      }),

    // ── Text-to-Speech ──────────────────────────────────────────────────────
    generateSpeech: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        text: z.string().min(1).max(4096),
        voice: z.enum(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]).default("nova"),
        speed: z.number().min(0.25).max(4.0).default(1.0),
        fileName: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const { ENV } = await import("./_core/env");
        const { orgMediaLibrary } = await import("../drizzle/schema");
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

        // Call the TTS endpoint (OpenAI-compatible)
        const baseUrl = ENV.forgeApiUrl.endsWith("/") ? ENV.forgeApiUrl : `${ENV.forgeApiUrl}/`;
        const ttsUrl = new URL("v1/audio/speech", baseUrl).toString();
        const ttsRes = await fetch(ttsUrl, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${ENV.forgeApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "tts-1",
            input: input.text,
            voice: input.voice,
            speed: input.speed,
            response_format: "mp3",
          }),
        });
        if (!ttsRes.ok) {
          const errText = await ttsRes.text().catch(() => "");
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `TTS generation failed: ${ttsRes.status} ${errText}` });
        }
        const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
        const suffix = Math.random().toString(36).slice(2, 8);
        const baseName = input.fileName
          ? input.fileName.replace(/[^a-z0-9_-]/gi, "-").replace(/\.mp3$/i, "")
          : `tts-${input.voice}-${suffix}`;
        const fileKey = `lms-media/${input.orgId}/audio/${baseName}-${suffix}.mp3`;
        const { url } = await storagePut(fileKey, audioBuffer, "audio/mpeg");

        // Save to media library
        const [row] = await db.insert(orgMediaLibrary).values({
          orgId: input.orgId,
          uploadedBy: ctx.user.id,
          filename: `${baseName}.mp3`,
          mimeType: "audio/mpeg",
          fileSize: audioBuffer.length,
          fileKey,
          url,
          source: "direct" as any,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        const insertId = (row as any).insertId ?? 0;
        return { id: insertId, url, filename: `${baseName}.mp3`, fileSize: audioBuffer.length };
      }),
  }),
  // ── Categories ────────────────────────────────────────────────────────────
  categories: router({
    list: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        return getCategoriesByOrg(input.orgId);
      }),
    create: protectedProcedure
      .input(z.object({ orgId: z.number(), name: z.string().min(1), color: z.string().optional(), description: z.string().optional() }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        return createCategory({ ...input, slug });
      }),
    update: protectedProcedure
      .input(z.object({ id: z.number(), name: z.string().optional(), color: z.string().optional(), description: z.string().optional(), sortOrder: z.number().optional() }))
      .mutation(async ({ input, ctx }) => {
        const cat = await getCategoryById(input.id);
        if (!cat) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, cat.orgId, ctx.user.role);
        const { id, ...data } = input;
        if (data.name) (data as any).slug = data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        return updateCategory(id, data);
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const cat = await getCategoryById(input.id);
        if (!cat) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, cat.orgId, ctx.user.role);
        await deleteCategory(input.id);
        return { ok: true };
      }),
    getCourseCategories: protectedProcedure
      .input(z.object({ courseId: z.number() }))
      .query(async ({ input }) => getCourseCategories(input.courseId)),
    setCourseCategories: protectedProcedure
      .input(z.object({ courseId: z.number(), categoryIds: z.array(z.number()) }))
      .mutation(async ({ input }) => {
        await setCourseCategories(input.courseId, input.categoryIds);
        return { ok: true };
      }),
  }),
  // ── Groups ────────────────────────────────────────────────────────────────
  groups: router({
    list: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        return getGroupsByOrg(input.orgId);
      }),
    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const g = await getGroupById(input.id);
        if (!g) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgRole(ctx.user.id, g.orgId, undefined, ctx.user.role);
        const members = await getGroupMembers(input.id);
        return { ...g, members };
      }),
    create: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        name: z.string().min(1),
        managerName: z.string().optional(),
        managerTitle: z.string().optional(),
        managerEmail: z.string().email().optional(),
        managerPhone: z.string().optional(),
        productIds: z.array(z.number()).optional(),
        seats: z.number().default(10),
        courseId: z.number().optional(),
        notes: z.string().optional(),
        expiresAt: z.date().optional(),
        sendWelcomeEmail: z.boolean().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        const { sendWelcomeEmail, productIds, ...rest } = input;
        const group = await createGroup({
          ...rest,
          managerId: ctx.user.id,
          productIds: productIds ? JSON.stringify(productIds) : null,
        });
        if (sendWelcomeEmail && input.managerEmail && group) {
          const org = await getOrgById(input.orgId);
          await sendEmail({
            to: input.managerEmail,
            subject: `You've been assigned as Group Manager: ${input.name}`,
            html: groupManagerAssignmentHtml({
              managerName: input.managerName ?? "there",
              groupName: input.name,
              orgName: org?.name,
              seats: input.seats,
            }),
          });
          await updateGroup(group.id, { welcomeEmailSent: true });
        }
        return group;
      }),
    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        name: z.string().optional(),
        managerName: z.string().optional(),
        managerTitle: z.string().optional(),
        managerEmail: z.string().email().optional().nullable(),
        managerPhone: z.string().optional().nullable(),
        productIds: z.array(z.number()).optional().nullable(),
        seats: z.number().optional(),
        courseId: z.number().optional().nullable(),
        notes: z.string().optional(),
        expiresAt: z.date().optional().nullable(),
        sendWelcomeEmail: z.boolean().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const g = await getGroupById(input.id);
        if (!g) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, g.orgId, ctx.user.role);
        const { id, sendWelcomeEmail, productIds, ...rest } = input;
        const updated = await updateGroup(id, {
          ...rest,
          productIds: productIds !== undefined ? (productIds ? JSON.stringify(productIds) : null) : undefined,
        });
        if (sendWelcomeEmail && (input.managerEmail ?? g.managerEmail)) {
          const targetEmail = (input.managerEmail ?? g.managerEmail)!;
          const targetName = input.managerName ?? g.managerName ?? 'there';
          const groupName = input.name ?? g.name;
          const org = await getOrgById(g.orgId);
          await sendEmail({
            to: targetEmail,
            subject: `Group Manager Assignment: ${groupName}`,
            html: groupManagerAssignmentHtml({
              managerName: targetName,
              groupName,
              orgName: org?.name,
              seats: input.seats ?? g.seats ?? 0,
            }),
          });
          await updateGroup(id, { welcomeEmailSent: true });
        }
        return updated;
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const g = await getGroupById(input.id);
        if (!g) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, g.orgId, ctx.user.role);
        await deleteGroup(input.id);
        return { ok: true };
      }),
    addMember: protectedProcedure
      .input(z.object({ groupId: z.number(), email: z.string().email(), name: z.string().optional() }))
      .mutation(async ({ input, ctx }) => {
        const g = await getGroupById(input.groupId);
        if (!g) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, g.orgId, ctx.user.role);
        if (g.usedSeats >= g.seats) throw new TRPCError({ code: "BAD_REQUEST", message: "No seats available" });
        return addGroupMember({ groupId: input.groupId, email: input.email, name: input.name, status: 'active' });
      }),
    removeMember: protectedProcedure
      .input(z.object({ memberId: z.number() }))
      .mutation(async ({ input }) => {
        await removeGroupMember(input.memberId);
        return { ok: true };
      }),
    bulkEnroll: protectedProcedure
      .input(z.object({ groupId: z.number(), courseId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const g = await getGroupById(input.groupId);
        if (!g) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, g.orgId, ctx.user.role);
        const members = await getGroupMembers(input.groupId);
        let enrolled = 0;
        let skipped = 0;
        for (const member of members) {
          if (!member.userId) { skipped++; continue; }
          const existing = await getEnrollment(input.courseId, member.userId);
          if (existing) { skipped++; continue; }
          await createEnrollment({
            courseId: input.courseId,
            userId: member.userId,
            orgId: g.orgId,
            enrolledAt: new Date(),
            isActive: true,
          });
          enrolled++;
        }
        // Update group courseId if not set
        if (!g.courseId) await updateGroup(input.groupId, { courseId: input.courseId });
        return { enrolled, skipped, total: members.length };
      }),
    // Group Manager Portal: list groups where the current user is the manager (matched by email)
    listManaged: protectedProcedure
      .query(async ({ ctx }) => {
        const managed = ctx.user.email ? await getGroupsByManager(ctx.user.email) : [];
        // Attach members to each group
        const result = [];
        for (const g of managed) {
          const members = await getGroupMembers(g.id);
          result.push({ ...g, members });
        }
        return result;
      }),
    // Seat tool: assign a seat to a specific email within a managed group
    assignSeat: protectedProcedure
      .input(z.object({ groupId: z.number(), email: z.string().email(), name: z.string().optional() }))
      .mutation(async ({ input, ctx }) => {
        const g = await getGroupById(input.groupId);
        if (!g) throw new TRPCError({ code: 'NOT_FOUND' });
        // Allow if user is the group manager OR an org admin
        const isManager = g.managerId === ctx.user.id;
        if (!isManager) await requireOrgAdmin(ctx.user.id, g.orgId, ctx.user.role);
        if (g.usedSeats >= g.seats) throw new TRPCError({ code: 'BAD_REQUEST', message: 'No seats available in this group' });
        return addGroupMember({ groupId: input.groupId, email: input.email, name: input.name, status: 'active' });
      }),
    // Revoke a seat
    revokeSeat: protectedProcedure
      .input(z.object({ memberId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const member = await getGroupMemberById(input.memberId);
        if (!member) throw new TRPCError({ code: 'NOT_FOUND' });
        const g = await getGroupById(member.groupId);
        if (!g) throw new TRPCError({ code: 'NOT_FOUND' });
        const isManager = ctx.user.email && g.managerEmail === ctx.user.email;
        if (!isManager) await requireOrgAdmin(ctx.user.id, g.orgId, ctx.user.role);
        await removeGroupMember(input.memberId);
        return { ok: true };
      }),
  }),
  // ── Discussions ───────────────────────────────────────────────────────────
  discussions: router({
    list: protectedProcedure
      .input(z.object({ orgId: z.number(), courseId: z.number().optional() }))
      .query(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        return getDiscussionsByOrg(input.orgId, input.courseId);
      }),
    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const d = await getDiscussionById(input.id);
        if (!d) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgRole(ctx.user.id, d.orgId, undefined, ctx.user.role);
        const replies = await getRepliesByDiscussion(input.id);
        return { ...d, replies };
      }),
    create: protectedProcedure
      .input(z.object({ orgId: z.number(), courseId: z.number().optional(), title: z.string().min(1), body: z.string().optional() }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        return createDiscussion({ ...input, authorId: ctx.user.id, authorName: ctx.user.name ?? ctx.user.email ?? 'Unknown' });
      }),
    update: protectedProcedure
      .input(z.object({ id: z.number(), title: z.string().optional(), body: z.string().optional(), isPinned: z.boolean().optional(), status: z.enum(['open','resolved','closed']).optional() }))
      .mutation(async ({ input, ctx }) => {
        const d = await getDiscussionById(input.id);
        if (!d) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgRole(ctx.user.id, d.orgId, undefined, ctx.user.role);
        const { id, ...data } = input;
        return updateDiscussion(id, data);
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const d = await getDiscussionById(input.id);
        if (!d) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, d.orgId, ctx.user.role);
        await deleteDiscussion(input.id);
        return { ok: true };
      }),
    reply: protectedProcedure
      .input(z.object({ discussionId: z.number(), body: z.string().min(1), isInstructorReply: z.boolean().optional() }))
      .mutation(async ({ input, ctx }) => {
        const d = await getDiscussionById(input.discussionId);
        if (!d) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgRole(ctx.user.id, d.orgId, undefined, ctx.user.role);
        return createDiscussionReply({ ...input, authorId: ctx.user.id, authorName: ctx.user.name ?? ctx.user.email ?? 'Unknown' });
      }),
    deleteReply: protectedProcedure
      .input(z.object({ replyId: z.number() }))
      .mutation(async ({ input }) => {
        await deleteDiscussionReply(input.replyId);
        return { ok: true };
      }),
  }),
  // ── Assignments ───────────────────────────────────────────────────────────
  assignments: router({
    list: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        return getAssignmentsByOrg(input.orgId);
      }),
    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const a = await getAssignmentById(input.id);
        if (!a) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgRole(ctx.user.id, a.orgId, undefined, ctx.user.role);
        const submissions = await getSubmissionsByAssignment(input.id);
        return { ...a, submissions };
      }),
    create: protectedProcedure
      .input(z.object({ orgId: z.number(), courseId: z.number().optional(), title: z.string().min(1), description: z.string().optional(), dueDate: z.date().optional(), maxScore: z.number().optional(), allowFileUpload: z.boolean().optional(), allowTextSubmission: z.boolean().optional() }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        return createAssignment({ ...input, status: 'draft' });
      }),
    update: protectedProcedure
      .input(z.object({ id: z.number(), title: z.string().optional(), description: z.string().optional(), dueDate: z.date().optional().nullable(), maxScore: z.number().optional(), status: z.enum(['draft','active','closed']).optional() }))
      .mutation(async ({ input, ctx }) => {
        const a = await getAssignmentById(input.id);
        if (!a) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, a.orgId, ctx.user.role);
        const { id, ...data } = input;
        return updateAssignment(id, data);
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const a = await getAssignmentById(input.id);
        if (!a) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, a.orgId, ctx.user.role);
        await deleteAssignment(input.id);
        return { ok: true };
      }),
    grade: protectedProcedure
      .input(z.object({ submissionId: z.number(), grade: z.string(), score: z.number().optional().nullable(), feedback: z.string().optional().nullable() }))
      .mutation(async ({ input }) => {
        return gradeSubmission(input.submissionId, input.grade, input.score ?? null, input.feedback ?? null);
      }),
  }),
  // ── Certificate Templates ─────────────────────────────────────────────────
  certificateTemplates: router({
    list: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        return getCertificateTemplatesByOrg(input.orgId);
      }),
    create: protectedProcedure
      .input(z.object({ orgId: z.number(), name: z.string().min(1), htmlTemplate: z.string().optional(), isDefault: z.boolean().optional() }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        return createCertificateTemplate(input);
      }),
    update: protectedProcedure
      .input(z.object({ id: z.number(), name: z.string().optional(), htmlTemplate: z.string().optional(), isDefault: z.boolean().optional() }))
      .mutation(async ({ input, ctx }) => {
        const t = await getCertificateTemplateById(input.id);
        if (!t) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, t.orgId!, ctx.user.role);
        const { id, ...data } = input;
        return updateCertificateTemplate(id, data);
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const t = await getCertificateTemplateById(input.id);
        if (!t) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, t.orgId!, ctx.user.role);
        await deleteCertificateTemplate(input.id);
        return { ok: true };
      }),
  }),
  // ── Affiliates ────────────────────────────────────────────────────────────
  affiliates: router({
    list: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        return getAffiliatesByOrg(input.orgId);
      }),
    create: protectedProcedure
      .input(z.object({ orgId: z.number(), name: z.string().min(1), email: z.string().email(), commissionType: z.enum(['percentage','fixed']).optional(), commissionValue: z.number().optional() }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        const code = nanoid(8).toUpperCase();
        return createAffiliate({ ...input, code });
      }),
    update: protectedProcedure
      .input(z.object({ id: z.number(), name: z.string().optional(), commissionType: z.enum(['percentage','fixed']).optional(), commissionValue: z.number().optional(), isActive: z.boolean().optional() }))
      .mutation(async ({ input, ctx }) => {
        const a = await getAffiliateById(input.id);
        if (!a) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, a.orgId, ctx.user.role);
        const { id, ...data } = input;
        return updateAffiliate(id, data);
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const a = await getAffiliateById(input.id);
        if (!a) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, a.orgId, ctx.user.role);
        await deleteAffiliate(input.id);
        return { ok: true };
      }),
  }),
  // ── Revenue Partners ──────────────────────────────────────────────────────
  revenuePartners: router({
    list: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        return getRevenuePartnersByOrg(input.orgId);
      }),
    create: protectedProcedure
      .input(z.object({ orgId: z.number(), name: z.string().min(1), email: z.string().email(), shareType: z.enum(['percentage','fixed']).optional(), shareValue: z.number().optional(), appliesTo: z.enum(['all','specific']).optional(), courseIds: z.string().optional() }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        return createRevenuePartner(input);
      }),
    update: protectedProcedure
      .input(z.object({ id: z.number(), name: z.string().optional(), shareType: z.enum(['percentage','fixed']).optional(), shareValue: z.number().optional(), appliesTo: z.enum(['all','specific']).optional(), courseIds: z.string().optional(), isActive: z.boolean().optional() }))
      .mutation(async ({ input, ctx }) => {
        const rp = await getRevenuePartnerById(input.id);
        if (!rp) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, rp.orgId, ctx.user.role);
        const { id, ...data } = input;
        return updateRevenuePartner(id, data);
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const rp = await getRevenuePartnerById(input.id);
        if (!rp) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, rp.orgId, ctx.user.role);
        await deleteRevenuePartner(input.id);
        return { ok: true };
      }),
  }),
  // ── Course Orders ─────────────────────────────────────────────────────────
  courseOrders: router({
    list: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        return getCourseOrdersByOrg(input.orgId);
      }),
    stats: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        return getCourseOrderStats(input.orgId);
      }),
    create: protectedProcedure
      .input(z.object({ orgId: z.number(), customerEmail: z.string().email(), customerName: z.string().optional(), courseId: z.number().optional(), productName: z.string().optional(), productType: z.enum(['course','bundle','membership','digital']).optional(), amount: z.number(), status: z.enum(['pending','completed','refunded','failed']).optional(), couponCode: z.string().optional(), discountAmount: z.number().optional() }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        return createCourseOrder({ ...input, userId: ctx.user.id });
      }),
    update: protectedProcedure
      .input(z.object({ id: z.number(), status: z.enum(['pending','completed','refunded','failed']).optional(), notes: z.string().optional() }))
      .mutation(async ({ input, ctx }) => {
        const o = await getCourseOrderById(input.id);
        if (!o) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, o.orgId, ctx.user.role);
        const { id, ...data } = input;
        return updateCourseOrder(id, data);
      }),
  }),
  // ── Memberships ───────────────────────────────────────────────────────────
  memberships: router({
    list: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        return getMembershipsByOrg(input.orgId);
      }),
    create: protectedProcedure
      .input(z.object({ orgId: z.number(), name: z.string().min(1), description: z.string().optional(), price: z.number(), billingInterval: z.enum(['monthly','yearly','one_time']).optional(), trialDays: z.number().optional(), courseAccess: z.enum(['all','specific']).optional(), courseIds: z.string().optional() }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        return createMembership(input);
      }),
    update: protectedProcedure
      .input(z.object({ id: z.number(), name: z.string().optional(), description: z.string().optional(), price: z.number().optional(), billingInterval: z.enum(['monthly','yearly','one_time']).optional(), trialDays: z.number().optional(), isActive: z.boolean().optional() }))
      .mutation(async ({ input, ctx }) => {
        const m = await getMembershipById(input.id);
        if (!m) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, m.orgId, ctx.user.role);
        const { id, ...data } = input;
        return updateMembership(id, data);
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const m = await getMembershipById(input.id);
        if (!m) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, m.orgId, ctx.user.role);
        await deleteMembership(input.id);
        return { ok: true };
      }),
    // ── Members ──
    getMembers: protectedProcedure
      .input(z.object({ membershipId: z.number() }))
      .query(async ({ input, ctx }) => {
        const m = await getMembershipById(input.membershipId);
        if (!m) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgRole(ctx.user.id, m.orgId, undefined, ctx.user.role);
        return getMembershipMembers(input.membershipId);
      }),
    addMember: protectedProcedure
      .input(z.object({ membershipId: z.number(), userId: z.number(), status: z.enum(['active','paused','cancelled','expired']).optional() }))
      .mutation(async ({ input, ctx }) => {
        const m = await getMembershipById(input.membershipId);
        if (!m) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, m.orgId, ctx.user.role);
        return addMembershipMember(input);
      }),
    updateMember: protectedProcedure
      .input(z.object({ id: z.number(), status: z.enum(['active','paused','cancelled','expired']).optional() }))
      .mutation(async ({ input, ctx }) => {
        await updateMembershipMember(input.id, { status: input.status });
        return { ok: true };
      }),
    removeMember: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await removeMembershipMember(input.id);
        return { ok: true };
      }),
    // ── Content ──
    getContent: protectedProcedure
      .input(z.object({ membershipId: z.number() }))
      .query(async ({ input, ctx }) => {
        const m = await getMembershipById(input.membershipId);
        if (!m) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgRole(ctx.user.id, m.orgId, undefined, ctx.user.role);
        return getMembershipContentItems(input.membershipId);
      }),
    addContent: protectedProcedure
      .input(z.object({ membershipId: z.number(), contentType: z.enum(['course','digital_product','community','webinar']), contentId: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const m = await getMembershipById(input.membershipId);
        if (!m) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, m.orgId, ctx.user.role);
        return addMembershipContent(input);
      }),
    removeContent: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await removeMembershipContent(input.id);
        return { ok: true };
      }),
    // ── Rules ──
    getRules: protectedProcedure
      .input(z.object({ membershipId: z.number() }))
      .query(async ({ input, ctx }) => {
        const m = await getMembershipById(input.membershipId);
        if (!m) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgRole(ctx.user.id, m.orgId, undefined, ctx.user.role);
        return getMembershipRules(input.membershipId);
      }),
    addRule: protectedProcedure
      .input(z.object({ membershipId: z.number(), triggerType: z.enum(['course_purchase','product_purchase','webinar_registration','tag_added','manual']), triggerEntityId: z.number().optional(), triggerTag: z.string().optional(), action: z.enum(['add_to_membership','remove_from_membership']).optional() }))
      .mutation(async ({ input, ctx }) => {
        const m = await getMembershipById(input.membershipId);
        if (!m) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, m.orgId, ctx.user.role);
        return addMembershipRule(input);
      }),
    updateRule: protectedProcedure
      .input(z.object({ id: z.number(), isActive: z.boolean().optional(), triggerType: z.enum(['course_purchase','product_purchase','webinar_registration','tag_added','manual']).optional(), triggerEntityId: z.number().optional(), triggerTag: z.string().optional(), action: z.enum(['add_to_membership','remove_from_membership']).optional() }))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        await updateMembershipRule(id, data);
        return { ok: true };
      }),
    removeRule: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await removeMembershipRule(input.id);
        return { ok: true };
      }),
  }),
  // ── Bundles ───────────────────────────────────────────────────────────────
  bundles: router({
    list: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        return getBundlesByOrg(input.orgId);
      }),
    create: protectedProcedure
      .input(z.object({ orgId: z.number(), name: z.string().min(1), description: z.string().optional(), price: z.number(), salePrice: z.number().optional(), courseIds: z.string() }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgAdmin(ctx.user.id, input.orgId, ctx.user.role);
        return createBundle(input);
      }),
    update: protectedProcedure
      .input(z.object({ id: z.number(), name: z.string().optional(), description: z.string().optional(), price: z.number().optional(), salePrice: z.number().optional().nullable(), courseIds: z.string().optional(), isActive: z.boolean().optional() }))
      .mutation(async ({ input, ctx }) => {
        const b = await getBundleById(input.id);
        if (!b) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, b.orgId, ctx.user.role);
        const { id, ...data } = input;
        return updateBundle(id, data);
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const b = await getBundleById(input.id);
        if (!b) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, b.orgId, ctx.user.role);
        await deleteBundle(input.id);
        return { ok: true };
      }),
  }),

  // ── Flashcards ───────────────────────────────────────────────────────────────────────
  flashcards: router({
    listDecks: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        return getFlashcardDecksByOrg(input.orgId);
      }),
    getDeck: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        const deck = await getFlashcardDeckById(input.id);
        if (!deck) throw new TRPCError({ code: "NOT_FOUND" });
        return deck;
      }),
    createDeck: protectedProcedure
      .input(z.object({ orgId: z.number(), title: z.string().min(1), description: z.string().optional(), category: z.string().optional(), isPublic: z.boolean().optional() }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        return createFlashcardDeck({ ...input, createdBy: ctx.user.id });
      }),
    updateDeck: protectedProcedure
      .input(z.object({ id: z.number(), title: z.string().optional(), description: z.string().optional(), category: z.string().optional(), isPublic: z.boolean().optional() }))
      .mutation(async ({ input, ctx }) => {
        const deck = await getFlashcardDeckById(input.id);
        if (!deck) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgRole(ctx.user.id, deck.orgId, undefined, ctx.user.role);
        const { id, ...data } = input;
        return updateFlashcardDeck(id, data);
      }),
    deleteDeck: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const deck = await getFlashcardDeckById(input.id);
        if (!deck) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, deck.orgId, ctx.user.role);
        await deleteFlashcardDeck(input.id);
        return { ok: true };
      }),
    getCards: protectedProcedure
      .input(z.object({ deckId: z.number() }))
      .query(async ({ input }) => {
        return getCardsByDeck(input.deckId);
      }),
    saveCards: protectedProcedure
      .input(z.object({
        deckId: z.number(),
        cards: z.array(z.object({
          front: z.string(),
          back: z.string(),
          frontImageUrl: z.string().optional(),
          backImageUrl: z.string().optional(),
          sortOrder: z.number(),
        })),
      }))
      .mutation(async ({ input, ctx }) => {
        const deck = await getFlashcardDeckById(input.deckId);
        if (!deck) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgRole(ctx.user.id, deck.orgId, undefined, ctx.user.role);
        await bulkUpsertCards(input.deckId, input.cards);
        return { ok: true };
      }),
     generateAI: protectedProcedure
      .input(z.object({ orgId: z.number(), topic: z.string().min(3), numCards: z.number().default(15), context: z.string().optional() }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const prompt = input.context
          ? `Create ${input.numCards} flashcards about: "${input.topic}". Use this context:\n${input.context}\nReturn JSON: { "cards": [{ "front": string, "back": string }] }`
          : `Create ${input.numCards} flashcards about: "${input.topic}". Return JSON: { "cards": [{ "front": string, "back": string }] }`;
        const response = await invokeLLM({
          messages: [
            { role: "system", content: "You are an expert educator. Return valid JSON only, no markdown." },
            { role: "user", content: prompt },
          ],
        });
        const rawContent = response.choices?.[0]?.message?.content ?? "{}";
        const content = typeof rawContent === "string" ? rawContent : "{}";
        try {
          const cleaned = content.replace(/```json\n?|```\n?/g, "").trim();
          return JSON.parse(cleaned) as { cards: Array<{ front: string; back: string }> };
        } catch {
          return { cards: [] };
        }
      }),
  }),

  // ── Funnels ─────────────────────────────────────────────────────────────────

  funnels: router({
    list: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const { getFunnelsByOrg } = await import("./funnelDb");
        return getFunnelsByOrg(input.orgId);
      }),

    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const { getFunnelWithSteps } = await import("./funnelDb");
        const funnel = await getFunnelWithSteps(input.id);
        if (!funnel) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgRole(ctx.user.id, funnel.orgId, undefined, ctx.user.role);
        return funnel;
      }),

    create: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        name: z.string().min(1),
        description: z.string().optional(),
        courseId: z.number().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        await requireOrgRole(ctx.user.id, input.orgId, undefined, ctx.user.role);
        const { createFunnel } = await import("./funnelDb");
        return createFunnel(input);
      }),

    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        name: z.string().optional(),
        description: z.string().optional(),
        isActive: z.boolean().optional(),
        courseId: z.number().nullable().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { getFunnelById, updateFunnel } = await import("./funnelDb");
        const funnel = await getFunnelById(input.id);
        if (!funnel) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgRole(ctx.user.id, funnel.orgId, undefined, ctx.user.role);
        const { id, ...data } = input;
        return updateFunnel(id, data as any);
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const { getFunnelById, deleteFunnel } = await import("./funnelDb");
        const funnel = await getFunnelById(input.id);
        if (!funnel) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgAdmin(ctx.user.id, funnel.orgId, ctx.user.role);
        await deleteFunnel(input.id);
        return { ok: true };
      }),

    // ── Steps ────────────────────────────────────────────────────────────────

    createStep: protectedProcedure
      .input(z.object({
        funnelId: z.number(),
        name: z.string().min(1),
        stepType: z.enum(["landing", "sales", "order", "upsell", "downsell", "thank_you", "webinar", "custom"]).optional(),
        sortOrder: z.number().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { getFunnelById, createFunnelStep } = await import("./funnelDb");
        const funnel = await getFunnelById(input.funnelId);
        if (!funnel) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgRole(ctx.user.id, funnel.orgId, undefined, ctx.user.role);
        return createFunnelStep(input);
      }),

    updateStep: protectedProcedure
      .input(z.object({
        id: z.number(),
        name: z.string().optional(),
        stepType: z.enum(["landing", "sales", "order", "upsell", "downsell", "thank_you", "webinar", "custom"]).optional(),
        pageId: z.number().nullable().optional(),
        slug: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { getFunnelStepById, getFunnelById, updateFunnelStep } = await import("./funnelDb");
        const step = await getFunnelStepById(input.id);
        if (!step) throw new TRPCError({ code: "NOT_FOUND" });
        const funnel = await getFunnelById(step.funnelId);
        if (!funnel) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgRole(ctx.user.id, funnel.orgId, undefined, ctx.user.role);
        const { id, ...data } = input;
        return updateFunnelStep(id, data as any);
      }),

    deleteStep: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const { getFunnelStepById, getFunnelById, deleteFunnelStep } = await import("./funnelDb");
        const step = await getFunnelStepById(input.id);
        if (!step) throw new TRPCError({ code: "NOT_FOUND" });
        const funnel = await getFunnelById(step.funnelId);
        if (!funnel) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgRole(ctx.user.id, funnel.orgId, undefined, ctx.user.role);
        await deleteFunnelStep(input.id);
        return { ok: true };
      }),

    reorderSteps: protectedProcedure
      .input(z.object({ funnelId: z.number(), stepIds: z.array(z.number()) }))
      .mutation(async ({ input, ctx }) => {
        const { getFunnelById, reorderFunnelSteps } = await import("./funnelDb");
        const funnel = await getFunnelById(input.funnelId);
        if (!funnel) throw new TRPCError({ code: "NOT_FOUND" });
        await requireOrgRole(ctx.user.id, funnel.orgId, undefined, ctx.user.role);
        await reorderFunnelSteps(input.stepIds);
        return { ok: true };
      }),
  }),

  // ── Lesson Notes ─────────────────────────────────────────────────────────
  notes: router({
    /** Get all notes for the current user in a specific lesson */
    byLesson: protectedProcedure
      .input(z.object({ lessonId: z.number(), courseId: z.number() }))
      .query(async ({ input, ctx }) => {
        const { getNotesByLesson } = await import("./lmsDb");
        return getNotesByLesson(ctx.user.id, input.lessonId);
      }),
    /** Get all notes for the current user in a course (for My Notes tab) */
    byCourse: protectedProcedure
      .input(z.object({ courseId: z.number() }))
      .query(async ({ input, ctx }) => {
        const { getNotesByCourse } = await import("./lmsDb");
        return getNotesByCourse(ctx.user.id, input.courseId);
      }),
    create: protectedProcedure
      .input(z.object({
        courseId: z.number(),
        lessonId: z.number(),
        content: z.string().min(1),
        videoTimestamp: z.number().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { getEnrollment, createNote } = await import("./lmsDb");
        const enrollment = await getEnrollment(input.courseId, ctx.user.id);
        if (!enrollment) throw new TRPCError({ code: "FORBIDDEN", message: "Not enrolled" });
        return createNote({
          userId: ctx.user.id,
          courseId: input.courseId,
          lessonId: input.lessonId,
          enrollmentId: enrollment.id,
          content: input.content,
          videoTimestamp: input.videoTimestamp,
        });
      }),
    update: protectedProcedure
      .input(z.object({ id: z.number(), content: z.string().min(1) }))
      .mutation(async ({ input, ctx }) => {
        const { getNoteById, updateNote } = await import("./lmsDb");
        const note = await getNoteById(input.id);
        if (!note) throw new TRPCError({ code: "NOT_FOUND" });
        if (note.userId !== ctx.user.id) throw new TRPCError({ code: "FORBIDDEN" });
        return updateNote(input.id, input.content);
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const { getNoteById, deleteNote } = await import("./lmsDb");
        const note = await getNoteById(input.id);
        if (!note) throw new TRPCError({ code: "NOT_FOUND" });
        if (note.userId !== ctx.user.id) throw new TRPCError({ code: "FORBIDDEN" });
        await deleteNote(input.id);
        return { ok: true };
      }),
  }),

  // ── Lesson Bookmarks ──────────────────────────────────────────────────────
  bookmarks: router({
    /** Get all bookmarks for the current user in a course */
    byCourse: protectedProcedure
      .input(z.object({ courseId: z.number() }))
      .query(async ({ input, ctx }) => {
        const { getBookmarksByCourse } = await import("./lmsDb");
        return getBookmarksByCourse(ctx.user.id, input.courseId);
      }),
    /** Toggle a bookmark on a lesson (create if not exists, delete if exists) */
    toggle: protectedProcedure
      .input(z.object({
        courseId: z.number(),
        lessonId: z.number(),
        label: z.string().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { getEnrollment, getBookmark, createBookmark, deleteBookmark } = await import("./lmsDb");
        const enrollment = await getEnrollment(input.courseId, ctx.user.id);
        if (!enrollment) throw new TRPCError({ code: "FORBIDDEN", message: "Not enrolled" });
        const existing = await getBookmark(ctx.user.id, input.lessonId);
        if (existing) {
          await deleteBookmark(existing.id);
          return { bookmarked: false };
        }
        await createBookmark({
          userId: ctx.user.id,
          courseId: input.courseId,
          lessonId: input.lessonId,
          enrollmentId: enrollment.id,
          label: input.label,
        });
        return { bookmarked: true };
      }),
    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input, ctx }) => {
        const { getBookmarkById, deleteBookmark } = await import("./lmsDb");
        const bm = await getBookmarkById(input.id);
        if (!bm) throw new TRPCError({ code: "NOT_FOUND" });
        if (bm.userId !== ctx.user.id) throw new TRPCError({ code: "FORBIDDEN" });
        await deleteBookmark(input.id);
        return { ok: true };
      }),
  }),

  // ── Drip Notifications ───────────────────────────────────────────────────
  drip: router({
    // Called by a daily scheduled task — finds lessons that just unlocked today
    // and emails each enrolled student a list of newly available content.
    sendUnlockNotifications: protectedProcedure
      .mutation(async ({ ctx }) => {
        // Only platform admins can trigger this
        if (ctx.user.role !== "site_owner" && ctx.user.role !== "site_admin" && ctx.user.role !== "org_super_admin") {
          throw new TRPCError({ code: "FORBIDDEN" });
        }
        const { getLessonsByCourse, getEnrollmentsByCourse, getCoursesByOrg } = await import("./lmsDb");
        const { getAllOrgs } = await import("./db");
        const orgs = await getAllOrgs();
        const now = new Date();
        const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000); // last 24h
        let totalEmails = 0;
        for (const org of orgs) {
          const orgCourses = await getCoursesByOrg(org.id);
          for (const course of orgCourses) {
            const [lessons, enrollments] = await Promise.all([
              getLessonsByCourse(course.id),
              getEnrollmentsByCourse(course.id),
            ]);
            // Find lessons with drip scheduling
            const dripLessons = lessons.filter(
              (l: any) => l.dripType === "days_after_enrollment" && l.dripDays != null
            );
            if (dripLessons.length === 0) continue;
            for (const enrollment of enrollments) {
              if (!enrollment.isActive) continue;
              const enrolledAt = new Date(enrollment.enrolledAt);
              // Find lessons that unlocked in the last 24h for this enrollment
              const newlyUnlocked = dripLessons.filter((l: any) => {
                const unlockDate = new Date(enrolledAt.getTime() + l.dripDays * 24 * 60 * 60 * 1000);
                return unlockDate >= windowStart && unlockDate <= now;
              });
              if (newlyUnlocked.length === 0) continue;
              // Get user email
              const user = await getUserById(enrollment.userId);
              if (!user?.email) continue;
              const SITE_URL = process.env.VITE_SITE_URL ?? "https://teachific.app";
              const courseUrl = `${SITE_URL}/learn/${(course as any).slug ?? course.id}`;
              try {
                await sendEmail({
                  to: user.email,
                  subject: `New content unlocked in "${course.title}"`,
                  html: dripUnlockHtml({
                    userName: user.name ?? user.email,
                    courseTitle: course.title,
                    orgName: org.name,
                    unlockedLessons: newlyUnlocked.map((l: any) => l.title),
                    courseUrl,
                  }),
                });
                totalEmails++;
              } catch (err) {
                console.error("[Drip] Failed to send unlock email:", err);
              }
            }
          }
        }
        return { totalEmails };
      }),
  }),

  // ─── Order Bumps ────────────────────────────────────────────────────────────
  orderBumps: router({
    list: protectedProcedure
      .input(z.object({ orgId: z.number() }))
      .query(async ({ input }) => {
        const { listOrderBumps } = await import("./orderBumpsDb");
        return listOrderBumps(input.orgId);
      }),

    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        const { getOrderBump } = await import("./orderBumpsDb");
        return getOrderBump(input.id);
      }),

    getForProduct: publicProcedure
      .input(z.object({
        orgId: z.number(),
        productType: z.enum(["course", "download", "quiz"]),
        productId: z.number(),
        placement: z.enum(["before_checkout", "during_checkout", "after_checkout"]).optional(),
      }))
      .query(async ({ input }) => {
        const { getOrderBumpsForProduct } = await import("./orderBumpsDb");
        return getOrderBumpsForProduct(input.orgId, input.productType, input.productId, input.placement);
      }),

    create: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        name: z.string().min(1),
        triggerProductType: z.enum(["course", "download", "quiz"]),
        triggerProductId: z.number(),
        bumpProductType: z.enum(["course", "download", "quiz"]),
        bumpProductId: z.number(),
        placement: z.enum(["before_checkout", "during_checkout", "after_checkout"]).optional(),
        headline: z.string().optional(),
        description: z.string().optional(),
        discountPercent: z.number().min(0).max(100).optional(),
        discountedPrice: z.string().optional(),
        landingPageJson: z.any().optional(),
        buttonText: z.string().optional(),
        declineText: z.string().optional(),
        imageUrl: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const { createOrderBump } = await import("./orderBumpsDb");
        const id = await createOrderBump(input);
        return { id };
      }),

    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        name: z.string().optional(),
        triggerProductType: z.enum(["course", "download", "quiz"]).optional(),
        triggerProductId: z.number().optional(),
        bumpProductType: z.enum(["course", "download", "quiz"]).optional(),
        bumpProductId: z.number().optional(),
        placement: z.enum(["before_checkout", "during_checkout", "after_checkout"]).optional(),
        headline: z.string().optional(),
        description: z.string().optional(),
        discountPercent: z.number().min(0).max(100).optional(),
        discountedPrice: z.string().optional(),
        landingPageJson: z.any().optional(),
        buttonText: z.string().optional(),
        declineText: z.string().optional(),
        imageUrl: z.string().optional(),
        isActive: z.boolean().optional(),
        sortOrder: z.number().optional(),
      }))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        const { updateOrderBump } = await import("./orderBumpsDb");
        await updateOrderBump(id, data);
        return { success: true };
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const { deleteOrderBump } = await import("./orderBumpsDb");
        await deleteOrderBump(input.id);
        return { success: true };
      }),

    recordConversion: publicProcedure
      .input(z.object({
        bumpId: z.number(),
        orgId: z.number(),
        triggerOrderId: z.number().optional(),
        bumpOrderId: z.number().optional(),
        buyerEmail: z.string().optional(),
        accepted: z.boolean(),
        sessionId: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const { recordBumpConversion } = await import("./orderBumpsDb");
        const id = await recordBumpConversion(input);
        return { id };
      }),

    stats: protectedProcedure
      .input(z.object({ bumpId: z.number() }))
      .query(async ({ input }) => {
        const { getBumpConversionStats } = await import("./orderBumpsDb");
        return getBumpConversionStats(input.bumpId);
      }),
  }),

  // ─── Visibility Management ────────────────────────────────────────────────
  visibility: router({
    updateCourse: protectedProcedure
      .input(z.object({
        courseId: z.number(),
        visibility: z.enum(["draft", "published", "hidden", "private", "archived"]),
      }))
      .mutation(async ({ input }) => {
        const { updateCourseVisibility } = await import("./orderBumpsDb");
        await updateCourseVisibility(input.courseId, input.visibility);
        return { success: true };
      }),

    updateDownload: protectedProcedure
      .input(z.object({
        productId: z.number(),
        visibility: z.enum(["draft", "published", "hidden", "private", "archived"]),
      }))
      .mutation(async ({ input }) => {
        const { updateDownloadVisibility } = await import("./orderBumpsDb");
        await updateDownloadVisibility(input.productId, input.visibility);
        return { success: true };
      }),

    updateQuiz: protectedProcedure
      .input(z.object({
        quizId: z.number(),
        visibility: z.enum(["draft", "published", "hidden", "private", "archived"]),
      }))
      .mutation(async ({ input }) => {
        const { updateQuizVisibility } = await import("./orderBumpsDb");
        await updateQuizVisibility(input.quizId, input.visibility);
        return { success: true };
      }),
  }),

  // ─── Private Invites ──────────────────────────────────────────────────────
  privateInvites: router({
    list: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        productType: z.enum(["course", "download", "quiz"]),
        productId: z.number(),
      }))
      .query(async ({ input }) => {
        const { listPrivateInvites } = await import("./orderBumpsDb");
        return listPrivateInvites(input.orgId, input.productType, input.productId);
      }),

    create: protectedProcedure
      .input(z.object({
        orgId: z.number(),
        productType: z.enum(["course", "download", "quiz"]),
        productId: z.number(),
        email: z.string().email(),
      }))
      .mutation(async ({ ctx, input }) => {
        const crypto = await import("crypto");
        const token = crypto.randomBytes(32).toString("hex");
        const { createPrivateInvite } = await import("./orderBumpsDb");
        const id = await createPrivateInvite({
          ...input,
          inviteToken: token,
          invitedBy: ctx.user.id,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        });
        return { id, token };
      }),

    accept: publicProcedure
      .input(z.object({ token: z.string() }))
      .mutation(async ({ input }) => {
        const { getPrivateInviteByToken, acceptPrivateInvite } = await import("./orderBumpsDb");
        const invite = await getPrivateInviteByToken(input.token);
        if (!invite) throw new TRPCError({ code: "NOT_FOUND", message: "Invite not found" });
        if (invite.status === "accepted") throw new TRPCError({ code: "BAD_REQUEST", message: "Invite already accepted" });
        if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Invite has expired" });
        }
        await acceptPrivateInvite(input.token);
        return { productType: invite.productType, productId: invite.productId, orgId: invite.orgId };
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const { deletePrivateInvite } = await import("./orderBumpsDb");
        await deletePrivateInvite(input.id);
        return { success: true };
      }),
  }),
});
