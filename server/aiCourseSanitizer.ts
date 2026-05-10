const COURSE_TITLE_MAX_LENGTH = 500;
const COURSE_SLUG_MAX_LENGTH = 200;
const CURRICULUM_TITLE_MAX_LENGTH = 500;
const LIST_ITEM_MAX_LENGTH = 500;
const SHORT_DESCRIPTION_MAX_LENGTH = 500;

export interface AiCourseLessonInput {
  title: string;
  type: string;
  description?: string;
}

export interface AiCourseModuleInput {
  title: string;
  lessons: AiCourseLessonInput[];
}

export interface AiCoursePayloadInput {
  title: string;
  description?: string;
  shortDescription?: string;
  whatYouLearn?: string;
  requirements?: string;
  targetAudience?: string;
  modules: AiCourseModuleInput[];
}

export interface SanitizedAiCoursePayload {
  title: string;
  slug: string;
  description?: string;
  shortDescription?: string;
  whatYouLearn?: string;
  requirements?: string;
  targetAudience?: string;
  modules: AiCourseModuleInput[];
}

function normalizeWhitespace(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join("").trim();
}

function truncateNormalized(value: string | undefined, maxLength: number): string | undefined {
  const normalized = normalizeWhitespace(value);
  return normalized ? truncate(normalized, maxLength) : undefined;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function makeAiCourseSlug(title: string, suffix: string): string {
  const safeSuffix = slugify(suffix) || "ai";
  const fallbackBase = "course";
  const maxBaseLength = COURSE_SLUG_MAX_LENGTH - safeSuffix.length - 1;
  const rawBase = slugify(title) || fallbackBase;
  const base = rawBase.slice(0, Math.max(maxBaseLength, fallbackBase.length)).replace(/-+$/g, "") || fallbackBase;
  return `${base}-${safeSuffix}`.slice(0, COURSE_SLUG_MAX_LENGTH);
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    // Plain newline-delimited text is expected from the AI wizard.
  }
  return trimmed.split(/\r?\n/);
}

export function serializeAiList(value: string | undefined): string | undefined {
  const items = parseList(value)
    .map((item) => truncateNormalized(item, LIST_ITEM_MAX_LENGTH))
    .filter((item): item is string => Boolean(item));
  return items.length > 0 ? JSON.stringify(items) : undefined;
}

export function sanitizeAiCoursePayload(input: AiCoursePayloadInput, suffix: string): SanitizedAiCoursePayload {
  const title = truncateNormalized(input.title, COURSE_TITLE_MAX_LENGTH) ?? "Untitled Course";
  return {
    title,
    slug: makeAiCourseSlug(title, suffix),
    description: truncateNormalized(input.description, 65_000),
    shortDescription: truncateNormalized(input.shortDescription, SHORT_DESCRIPTION_MAX_LENGTH),
    whatYouLearn: serializeAiList(input.whatYouLearn),
    requirements: serializeAiList(input.requirements),
    targetAudience: serializeAiList(input.targetAudience),
    modules: input.modules.map((module, moduleIndex) => ({
      title: truncateNormalized(module.title, CURRICULUM_TITLE_MAX_LENGTH) ?? `Module ${moduleIndex + 1}`,
      lessons: module.lessons.map((lesson, lessonIndex) => ({
        title: truncateNormalized(lesson.title, CURRICULUM_TITLE_MAX_LENGTH) ?? `Lesson ${lessonIndex + 1}`,
        type: truncateNormalized(lesson.type, 32) ?? "text",
        description: truncateNormalized(lesson.description, 65_000),
      })),
    })),
  };
}
