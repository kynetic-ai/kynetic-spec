/**
 * HTML Export Tests
 *
 * AC: @gh-pages-export ac-6
 */

import { describe, expect, it } from "vitest";
import { generateHtmlExport, type KspecSnapshot } from "../../src/export/index.js";

describe("HTML Export", () => {
  const mockSnapshot: KspecSnapshot = {
    version: "0.1.0",
    exported_at: "2026-01-28T00:00:00.000Z",
    project: {
      name: "Test Project",
      version: "1.0.0",
    },
    tasks: [
      {
        _ulid: "01TEST000000000000000000",
        slugs: ["test-task"],
        title: "Test Task",
        type: "task",
        status: "pending",
        blocked_by: [],
        depends_on: [],
        context: [],
        priority: 3,
        tags: [],
        vcs_refs: [],
        created_at: "2026-01-01T00:00:00.000Z",
        notes: [],
        todos: [],
      },
    ],
    items: [
      {
        _ulid: "01SPEC000000000000000000",
        slugs: ["test-spec"],
        title: "Test Spec",
        type: "feature",
        tags: [],
        depends_on: [],
        implements: [],
        relates_to: [],
        tests: [],
        traits: [],
        notes: [],
        acceptance_criteria: [
          {
            id: "ac-1",
            given: "test",
            when: "test",
            then: "test",
          },
        ],
      },
    ],
    inbox: [],
    session: null,
    observations: [],
    agents: [],
    workflows: [],
    conventions: [],
  };

  // AC: @gh-pages-export ac-6
  describe("generateHtmlExport", () => {
    it("generates valid HTML document", () => {
      const html = generateHtmlExport(mockSnapshot);

      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("<html lang=\"en\">");
      expect(html).toContain("</html>");
    });

    it("includes project name in title", () => {
      const html = generateHtmlExport(mockSnapshot);

      expect(html).toContain("<title>Test Project - kspec Export</title>");
    });

    it("includes embedded JSON data", () => {
      const html = generateHtmlExport(mockSnapshot);

      expect(html).toContain('<script id="kspec-data" type="application/json">');
      expect(html).toContain("window.KSPEC_STATIC_DATA");
    });

    it("includes export timestamp", () => {
      const html = generateHtmlExport(mockSnapshot);

      expect(html).toContain("Exported:");
    });

    it("shows task count", () => {
      const html = generateHtmlExport(mockSnapshot);

      expect(html).toContain(">1</div>");
      expect(html).toContain("Tasks");
    });

    it("shows read-only banner", () => {
      const html = generateHtmlExport(mockSnapshot);

      expect(html).toContain("Read-only view");
    });

    it("escapes HTML in project name", () => {
      const snapshotWithHtml: KspecSnapshot = {
        ...mockSnapshot,
        project: {
          name: "<script>alert('xss')</script>",
        },
      };

      const html = generateHtmlExport(snapshotWithHtml);

      expect(html).not.toContain("<script>alert('xss')</script>");
      expect(html).toContain("&lt;script&gt;");
    });

    it("escapes JSON for HTML embedding", () => {
      const snapshotWithSpecialChars: KspecSnapshot = {
        ...mockSnapshot,
        project: {
          name: "Test </script> Project",
        },
      };

      const html = generateHtmlExport(snapshotWithSpecialChars);

      // JSON should be escaped to prevent script injection
      expect(html).toContain("\\u003c/script\\u003e");
    });

    it("includes validation badge when validation present", () => {
      const snapshotWithValidation: KspecSnapshot = {
        ...mockSnapshot,
        validation: {
          valid: true,
          errorCount: 0,
          warningCount: 5,
          errors: [],
          warnings: [],
        },
      };

      const html = generateHtmlExport(snapshotWithValidation);

      expect(html).toContain("Valid");
    });

    it("shows error count when validation fails", () => {
      const snapshotWithErrors: KspecSnapshot = {
        ...mockSnapshot,
        validation: {
          valid: false,
          errorCount: 3,
          warningCount: 5,
          errors: [],
          warnings: [],
        },
      };

      const html = generateHtmlExport(snapshotWithErrors);

      expect(html).toContain("3 errors");
    });
  });
});
