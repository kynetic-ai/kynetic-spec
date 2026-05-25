/**
 * Unit tests for plan document resource_refs parser support and markdown link
 * extraction.
 *
 * AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
 */

import { describe, it, expect } from "vitest";
import { parsePlanDocument } from "../src/parser/plan-document.js";
import { extractMarkdownResourceLinks } from "../src/parser/entity-local-resources.js";

describe("Plan document resource_refs schema", () => {
  // AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
  it("accepts resource_refs on a manual task definition", () => {
    const parsed = parsePlanDocument(
      `# Plan

## Tasks

\`\`\`yaml
- title: Implement Login
  slug: implement-login
  resource_refs:
    - ./resources/screenshots/login.png
    - ./resources/screenshots/error.png
\`\`\`
`,
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.tasks.additional_tasks).toHaveLength(1);
    expect(parsed.tasks.additional_tasks?.[0].resource_refs).toEqual([
      "./resources/screenshots/login.png",
      "./resources/screenshots/error.png",
    ]);
  });

  it("treats resource_refs as optional on a task definition", () => {
    const parsed = parsePlanDocument(
      `# Plan

## Tasks

\`\`\`yaml
- title: Bare Task
  slug: bare-task
\`\`\`
`,
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.tasks.additional_tasks?.[0].resource_refs).toBeUndefined();
  });
});

describe("Markdown resource link extraction", () => {
  // AC: @plan-resource-derivation-semantics-1 ac-plan-task-resource-refs-are-structured
  it("captures inline image links", () => {
    const links = extractMarkdownResourceLinks(
      `# Plan

See ![alt](./resources/shots/login.png) for a screenshot.
`,
    );
    expect(links).toHaveLength(1);
    expect(links[0].rawTarget).toBe("./resources/shots/login.png");
    expect(links[0].relativePath).toBe("shots/login.png");
  });

  it("captures plain inline links", () => {
    const links = extractMarkdownResourceLinks(
      `# Plan

[Open spec](./resources/spec.pdf).
`,
    );
    expect(links).toHaveLength(1);
    expect(links[0].relativePath).toBe("spec.pdf");
  });

  it("captures reference-style link definitions", () => {
    const links = extractMarkdownResourceLinks(
      `# Plan

See [the spec][spec].

[spec]: ./resources/specs/draft.pdf
`,
    );
    expect(links).toHaveLength(1);
    expect(links[0].relativePath).toBe("specs/draft.pdf");
  });

  it("returns an empty list when no resource links are present", () => {
    const links = extractMarkdownResourceLinks(
      `# Plan

No references here.
`,
    );
    expect(links).toEqual([]);
  });

  it("reports line numbers for each link", () => {
    const links = extractMarkdownResourceLinks(
      `# Plan

para 1
![one](./resources/a.png)
para 3
![two](./resources/b.png)
`,
    );
    expect(links.map((l) => l.line)).toEqual([4, 6]);
  });

  it("does not match links pointing outside ./resources/", () => {
    const links = extractMarkdownResourceLinks(
      `[external](https://example.com)
[sibling](../sibling.md)
[absolute](/etc/passwd)
`,
    );
    expect(links).toEqual([]);
  });
});
