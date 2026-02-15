/**
 * Tests for Auto-Generated Data Sections library functions.
 *
 * AC: @agent-data-sections ac-1 - generateSkillsTable
 * AC: @agent-data-sections ac-2 - generateConventionsSummary
 * AC: @agent-data-sections ac-3 - generateWorkflowsSummary
 */

import { describe, it, expect } from "vitest";
import {
  generateSkillsTable,
  generateConventionsSummary,
  generateWorkflowsSummary,
} from "../src/parser/agent-data-sections.js";
import type {
  LoadedSkill,
  LoadedConvention,
  LoadedWorkflow,
} from "../src/parser/meta.js";

// AC: @agent-data-sections ac-1
describe("generateSkillsTable", () => {
  describe("ac-1: markdown table with skill name, description, and invocation", () => {
    it("should return empty string when no skills provided", () => {
      const result = generateSkillsTable([]);
      expect(result).toBe("");
    });

    it("should return markdown table with header", () => {
      const skills: LoadedSkill[] = [
        {
          id: "task-work",
          name: "Task Work",
          description: "Work on tasks with proper lifecycle",
          _sourceFile: "skills.yaml",
        },
      ];

      const result = generateSkillsTable(skills);

      expect(result).toContain("## Finding Information");
      expect(result).toContain("| Need | Where to look |");
      expect(result).toContain("|------|---------------|");
    });

    it("should include skill description and invocation columns", () => {
      const skills: LoadedSkill[] = [
        {
          id: "task-work",
          name: "Task Work",
          description: "Work on tasks with proper lifecycle",
          _sourceFile: "skills.yaml",
        },
      ];

      const result = generateSkillsTable(skills);

      // Description appears in Need column
      expect(result).toContain("Work on tasks with proper lifecycle");
      // Invocation format /id appears in Where to look column
      expect(result).toContain("`/task-work` skill");
    });

    it("should include one row per skill", () => {
      const skills: LoadedSkill[] = [
        {
          id: "task-work",
          name: "Task Work",
          description: "Work on tasks",
          _sourceFile: "skills.yaml",
        },
        {
          id: "pr-review",
          name: "PR Review",
          description: "Review pull requests",
          _sourceFile: "skills.yaml",
        },
        {
          id: "spec-plan",
          name: "Spec Plan",
          description: "Plan to spec translation",
          _sourceFile: "skills.yaml",
        },
      ];

      const result = generateSkillsTable(skills);

      expect(result).toContain("Work on tasks");
      expect(result).toContain("`/task-work` skill");
      expect(result).toContain("Review pull requests");
      expect(result).toContain("`/pr-review` skill");
      expect(result).toContain("Plan to spec translation");
      expect(result).toContain("`/spec-plan` skill");
    });

    it("should use skill name as fallback when description is missing", () => {
      const skills: LoadedSkill[] = [
        {
          id: "my-skill",
          name: "My Skill",
          _sourceFile: "skills.yaml",
        },
      ];

      const result = generateSkillsTable(skills);

      // Uses name as description
      expect(result).toContain("My Skill");
      expect(result).toContain("`/my-skill` skill");
    });

    it("should include helpful footer text", () => {
      const skills: LoadedSkill[] = [
        {
          id: "test",
          name: "Test",
          description: "Test skill",
          _sourceFile: "skills.yaml",
        },
      ];

      const result = generateSkillsTable(skills);

      expect(result).toContain(
        "Skills inject their full documentation when invoked",
      );
    });
  });
});

// AC: @agent-data-sections ac-2
describe("generateConventionsSummary", () => {
  describe("ac-2: markdown section listing each domain with its rules", () => {
    it("should return empty string when no conventions provided", () => {
      const result = generateConventionsSummary([]);
      expect(result).toBe("");
    });

    it("should return markdown section with Conventions header", () => {
      const conventions: LoadedConvention[] = [
        {
          domain: "commits",
          rules: ["Use conventional commits"],
          _sourceFile: "conventions.yaml",
        },
      ];

      const result = generateConventionsSummary(conventions);

      expect(result).toContain("## Conventions");
    });

    it("should include domain as subsection header", () => {
      const conventions: LoadedConvention[] = [
        {
          domain: "commits",
          rules: ["Use conventional commits"],
          _sourceFile: "conventions.yaml",
        },
      ];

      const result = generateConventionsSummary(conventions);

      expect(result).toContain("### commits");
    });

    it("should list rules as markdown list items", () => {
      const conventions: LoadedConvention[] = [
        {
          domain: "commits",
          rules: [
            "Use conventional commits",
            "Include task trailer",
            "Sign commits with GPG",
          ],
          _sourceFile: "conventions.yaml",
        },
      ];

      const result = generateConventionsSummary(conventions);

      expect(result).toContain("- Use conventional commits");
      expect(result).toContain("- Include task trailer");
      expect(result).toContain("- Sign commits with GPG");
    });

    it("should include multiple domains", () => {
      const conventions: LoadedConvention[] = [
        {
          domain: "commits",
          rules: ["Use conventional commits"],
          _sourceFile: "conventions.yaml",
        },
        {
          domain: "testing",
          rules: ["All ACs must have tests", "Run tests before committing"],
          _sourceFile: "conventions.yaml",
        },
        {
          domain: "code-style",
          rules: ["Use 2-space indentation"],
          _sourceFile: "conventions.yaml",
        },
      ];

      const result = generateConventionsSummary(conventions);

      expect(result).toContain("### commits");
      expect(result).toContain("### testing");
      expect(result).toContain("### code-style");
      expect(result).toContain("- Use conventional commits");
      expect(result).toContain("- All ACs must have tests");
      expect(result).toContain("- Run tests before committing");
      expect(result).toContain("- Use 2-space indentation");
    });

    it("should handle domain with empty rules array", () => {
      const conventions: LoadedConvention[] = [
        {
          domain: "empty-domain",
          rules: [],
          _sourceFile: "conventions.yaml",
        },
      ];

      const result = generateConventionsSummary(conventions);

      expect(result).toContain("### empty-domain");
      // Should not crash, just have header with no rules
    });
  });
});

// AC: @agent-data-sections ac-3
describe("generateWorkflowsSummary", () => {
  describe("ac-3: markdown section listing each workflow with its trigger", () => {
    it("should return empty string when no workflows provided", () => {
      const result = generateWorkflowsSummary([]);
      expect(result).toBe("");
    });

    it("should return markdown section with Workflows header", () => {
      const workflows: LoadedWorkflow[] = [
        {
          id: "pr-review-merge",
          trigger: "When PR needs review",
          _sourceFile: "workflows.yaml",
        },
      ];

      const result = generateWorkflowsSummary(workflows);

      expect(result).toContain("## Workflows");
      expect(result).toContain("Available workflows:");
    });

    it("should list workflow with id and description/trigger", () => {
      const workflows: LoadedWorkflow[] = [
        {
          id: "pr-review-merge",
          trigger: "When PR needs review",
          description: "Review and merge a pull request",
          _sourceFile: "workflows.yaml",
        },
      ];

      const result = generateWorkflowsSummary(workflows);

      expect(result).toContain("**pr-review-merge**");
      expect(result).toContain("Review and merge a pull request");
    });

    it("should use trigger as fallback when description is missing", () => {
      const workflows: LoadedWorkflow[] = [
        {
          id: "task-work-session",
          trigger: "When starting task work",
          _sourceFile: "workflows.yaml",
        },
      ];

      const result = generateWorkflowsSummary(workflows);

      expect(result).toContain("**task-work-session**");
      expect(result).toContain("When starting task work");
    });

    it("should list multiple workflows", () => {
      const workflows: LoadedWorkflow[] = [
        {
          id: "pr-review-merge",
          trigger: "When PR needs review",
          description: "Review and merge a PR",
          _sourceFile: "workflows.yaml",
        },
        {
          id: "task-work-session",
          trigger: "When starting task work",
          description: "Full task lifecycle workflow",
          _sourceFile: "workflows.yaml",
        },
        {
          id: "release",
          trigger: "When releasing a version",
          description: "Create versioned release",
          _sourceFile: "workflows.yaml",
        },
      ];

      const result = generateWorkflowsSummary(workflows);

      expect(result).toContain("**pr-review-merge**");
      expect(result).toContain("Review and merge a PR");
      expect(result).toContain("**task-work-session**");
      expect(result).toContain("Full task lifecycle workflow");
      expect(result).toContain("**release**");
      expect(result).toContain("Create versioned release");
    });

    it("should include usage hint", () => {
      const workflows: LoadedWorkflow[] = [
        {
          id: "test",
          trigger: "test",
          _sourceFile: "workflows.yaml",
        },
      ];

      const result = generateWorkflowsSummary(workflows);

      expect(result).toContain(
        "Use `kspec workflow start @workflow-id` to start a workflow.",
      );
    });
  });
});
