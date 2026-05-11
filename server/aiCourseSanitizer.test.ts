import { describe, expect, it } from "vitest";
import {
  makeAiCourseSlug,
  sanitizeAiCoursePayload,
  serializeAiList,
} from "./aiCourseSanitizer";

describe("AI course sanitizer", () => {
  it("keeps generated slugs within the courses.slug column limit", () => {
    const slug = makeAiCourseSlug("Advanced ".repeat(80), "AbC1");

    expect(slug.length).toBeLessThanOrEqual(200);
    expect(slug.endsWith("-abc1")).toBe(true);
  });

  it("serializes newline-delimited overview content as JSON arrays", () => {
    expect(serializeAiList("Outcome one\nOutcome two")).toBe(JSON.stringify(["Outcome one", "Outcome two"]));
  });

  it("trims AI-generated fields to database-safe lengths", () => {
    const payload = sanitizeAiCoursePayload(
      {
        title: "T".repeat(700),
        shortDescription: "S".repeat(700),
        whatYouLearn: "Learn ECG interpretation",
        requirements: JSON.stringify(["R".repeat(700)]),
        targetAudience: "Healthcare professionals",
        modules: [
          {
            title: "M".repeat(700),
            lessons: [{ title: "L".repeat(700), type: "video", description: "  Lesson overview  " }],
          },
        ],
      },
      "xyz9"
    );

    expect(payload.title).toHaveLength(500);
    expect(payload.slug.length).toBeLessThanOrEqual(200);
    expect(payload.shortDescription).toHaveLength(500);
    expect(JSON.parse(payload.whatYouLearn ?? "[]")).toEqual(["Learn ECG interpretation"]);
    expect(JSON.parse(payload.requirements ?? "[]")[0]).toHaveLength(500);
    expect(JSON.parse(payload.targetAudience ?? "[]")).toEqual(["Healthcare professionals"]);
    expect(payload.modules[0].title).toHaveLength(500);
    expect(payload.modules[0].lessons[0].title).toHaveLength(500);
    expect(payload.modules[0].lessons[0].description).toBe("Lesson overview");
  });

  it("trims multibyte text fields by UTF-8 bytes for MySQL text columns", () => {
    const payload = sanitizeAiCoursePayload(
      {
        title: "ECG Unicode Course",
        description: "🫀".repeat(65_000),
        whatYouLearn: Array.from({ length: 100 }, (_, i) => `🫀 outcome ${i}`).join("\n"),
        requirements: "Basic ECG knowledge",
        targetAudience: "Clinicians",
        modules: [
          {
            title: "Module",
            lessons: [{ title: "Lesson", type: "text", description: "🫀".repeat(65_000) }],
          },
        ],
      },
      "ecg1"
    );

    expect(Buffer.byteLength(payload.description ?? "", "utf8")).toBeLessThanOrEqual(60_000);
    expect(Buffer.byteLength(payload.whatYouLearn ?? "", "utf8")).toBeLessThanOrEqual(60_000);
    expect(Buffer.byteLength(payload.modules[0].lessons[0].description ?? "", "utf8")).toBeLessThanOrEqual(59_000);
  });
});
