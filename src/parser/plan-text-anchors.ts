import { findPlanByRef } from "./plans.js";
import { resolvePlanRevisionContent } from "./plan-revisions.js";
import type { KspecContext } from "./yaml.js";
import type {
  ReviewPlanTextAnchor,
  ReviewRecord,
  ReviewSubject,
} from "../schema/review-records.js";
import { ReviewPlanTextAnchorSchema } from "../schema/review-records.js";

export const PLAN_TEXT_PREAMBLE_SECTION_ID = "preamble";

export interface PlanTextSection {
  id: string;
  content: string;
  heading?: string;
}

export interface PlanTextAnchorValidationFailure {
  field: string;
  message: string;
}

export type PlanTextAnchorValidationResult =
  | { ok: true; anchor: ReviewPlanTextAnchor }
  | { ok: false; failure: PlanTextAnchorValidationFailure };

interface LineSpan {
  text: string;
  start: number;
  end: number;
}

function splitLinesWithSpans(content: string): LineSpan[] {
  const spans: LineSpan[] = [];
  const pattern = /.*(?:\r\n|\n|\r|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const text = match[0];
    if (text === "" && match.index === content.length) break;
    spans.push({ text, start: match.index, end: match.index + text.length });
    if (pattern.lastIndex === content.length) break;
  }
  return spans;
}

function parseHeading(line: string): string | null {
  const withoutLineEnding = line.replace(/\r?\n$|\r$/, "");
  const match = /^(#{1,6})[ \t]+(.+?)\s*$/.exec(withoutLineEnding);
  if (!match) return null;
  return match[2].replace(/[ \t]+#+[ \t]*$/, "").trim();
}

function slugifyHeading(heading: string): string {
  const slug = heading
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

function headingSectionId(heading: string, counts: Map<string, number>): string {
  const base = slugifyHeading(heading);
  const nextCount = (counts.get(base) ?? 0) + 1;
  counts.set(base, nextCount);
  return nextCount === 1 ? base : `${base}-${nextCount}`;
}

/**
 * Divide a plan markdown document into deterministic heading-delimited sections.
 *
 * Heading sections include the heading line itself. The leading section covers
 * content before the first heading and always uses the fixed "preamble" id.
 */
export function sectionPlanMarkdown(content: string): PlanTextSection[] {
  const lines = splitLinesWithSpans(content);
  const headingCounts = new Map<string, number>();
  const sections: PlanTextSection[] = [];
  let current: { id: string; start: number; heading?: string } | null = null;

  for (const line of lines) {
    const heading = parseHeading(line.text);
    if (heading !== null) {
      if (current) {
        sections.push({
          id: current.id,
          content: content.slice(current.start, line.start),
          ...(current.heading ? { heading: current.heading } : {}),
        });
      } else if (line.start > 0) {
        sections.push({
          id: PLAN_TEXT_PREAMBLE_SECTION_ID,
          content: content.slice(0, line.start),
        });
      }

      current = {
        id: headingSectionId(heading, headingCounts),
        start: line.start,
        heading,
      };
    }
  }

  if (current) {
    sections.push({
      id: current.id,
      content: content.slice(current.start),
      ...(current.heading ? { heading: current.heading } : {}),
    });
  } else {
    sections.push({
      id: PLAN_TEXT_PREAMBLE_SECTION_ID,
      content,
    });
  }

  return sections.filter((section) => section.content.length > 0);
}

function codePointSlice(text: string, offset: number, length: number): string {
  return Array.from(text)
    .slice(offset, offset + length)
    .join("");
}

function invalid(field: string, message: string): PlanTextAnchorValidationResult {
  return { ok: false, failure: { field, message } };
}

function planSubjectRef(subject: ReviewSubject): string | null {
  return subject.type === "plan" ? subject.ref : null;
}

/**
 * Validate plan-text anchors at creation time against the subject plan revision.
 * Persisted record loading intentionally remains schema-only.
 */
export async function validatePlanTextAnchorForReview(
  ctx: KspecContext,
  review: Pick<ReviewRecord, "subject">,
  candidate: unknown,
): Promise<PlanTextAnchorValidationResult> {
  const parsed = ReviewPlanTextAnchorSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".") || "anchor";
    return invalid(field, issue?.message || "Invalid plan-text anchor value");
  }

  const subjectRef = planSubjectRef(review.subject);
  if (!subjectRef) {
    return invalid("anchor.type", "plan-text anchors apply only to plan-subject reviews");
  }

  const plan = await findPlanByRef(ctx, subjectRef);
  if (!plan) {
    return invalid("subject.ref", `Plan subject could not be resolved: ${subjectRef}`);
  }

  const revision = plan.revisions.find(
    (candidateRevision) => candidateRevision.ordinal === parsed.data.created_at_rev,
  );
  if (!revision) {
    return invalid(
      "created_at_rev",
      `Plan revision ordinal ${parsed.data.created_at_rev} does not exist on ${subjectRef}`,
    );
  }

  const content = resolvePlanRevisionContent(ctx, plan, revision);
  const section = sectionPlanMarkdown(content).find(
    (candidateSection) => candidateSection.id === parsed.data.section,
  );
  if (!section) {
    return invalid("section", `Plan revision does not contain section "${parsed.data.section}"`);
  }

  const quotedLength = Array.from(parsed.data.quoted_text).length;
  const actual = codePointSlice(section.content, parsed.data.offset, quotedLength);
  if (actual !== parsed.data.quoted_text) {
    return invalid(
      "quoted_text",
      `Quoted text does not match section "${parsed.data.section}" at code-point offset ${parsed.data.offset}`,
    );
  }

  return { ok: true, anchor: parsed.data };
}
