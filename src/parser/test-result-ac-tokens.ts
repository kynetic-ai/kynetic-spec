import type { TestResultCriterionRef } from "../schema/test-result-runs.js";

const AC_TOKEN_PATTERN = /\bAC:\s*(@[A-Za-z0-9-]+)\s+(ac-[a-z0-9]+(?:-[a-z0-9]+)*)\b/g;

/**
 * Adapter-boundary helper for framework reporters that expose AC tokens in
 * native strings before creating a normalized test-result payload.
 */
export function extractAcceptanceCriterionRefsFromText(text: string): TestResultCriterionRef[] {
  return [...text.matchAll(AC_TOKEN_PATTERN)].map((match) => ({
    item_ref: match[1],
    ac_id: match[2],
  }));
}
