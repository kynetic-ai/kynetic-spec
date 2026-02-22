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
  CONVENTIONS_INTRO,
} from "../src/parser/agent-data-sections.js";
import { computeMetaHash } from "../src/cli/commands/agents.js";
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

    it("should use /kspec:<id> invocation for core skills", () => {
      const skills: LoadedSkill[] = [
        {
          id: "help",
          name: "Kspec Help",
          description: "Get help with kspec commands",
          origin: "core",
          _sourceFile: "skills.yaml",
        },
      ];

      const result = generateSkillsTable(skills);

      expect(result).toContain("`/kspec:help` skill");
      expect(result).not.toContain("`/help` skill");
    });

    it("should use /<id> invocation for project skills (no prefix)", () => {
      const skills: LoadedSkill[] = [
        {
          id: "task-work",
          name: "Task Work",
          description: "Work on tasks",
          origin: "project",
          _sourceFile: "skills.yaml",
        },
      ];

      const result = generateSkillsTable(skills);

      expect(result).toContain("`/task-work` skill");
      expect(result).not.toContain("`/kspec:task-work` skill");
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

  describe("context intro paragraph", () => {
    it("should include intro paragraph between header and first domain", () => {
      const conventions: LoadedConvention[] = [
        {
          domain: "commits",
          rules: ["Use conventional commits"],
          examples: [],
          _sourceFile: "conventions.yaml",
        },
      ];

      const result = generateConventionsSummary(conventions);

      const headerPos = result.indexOf("## Conventions");
      const introPos = result.indexOf(CONVENTIONS_INTRO);
      const domainPos = result.indexOf("### commits");

      expect(introPos).toBeGreaterThan(headerPos);
      expect(introPos).toBeLessThan(domainPos);
    });
  });

  describe("examples rendering", () => {
    it("should render short examples as inline code with em-dash separator", () => {
      const conventions: LoadedConvention[] = [
        {
          domain: "commits",
          rules: ["Use conventional commits"],
          examples: [
            { good: "feat: add login", bad: "Added login" },
          ],
          _sourceFile: "conventions.yaml",
        },
      ];

      const result = generateConventionsSummary(conventions);

      expect(result).toContain("**Examples:**");
      expect(result).toContain(
        "- Good: `feat: add login` — Bad: `Added login`",
      );
    });

    it("should render long examples as quoted multi-line format", () => {
      const longGood =
        "Implemented retry logic with exponential backoff. Chose 3 retries max based on API rate limits.";
      const longBad = "Done";
      const conventions: LoadedConvention[] = [
        {
          domain: "notes",
          rules: ["Be descriptive"],
          examples: [{ good: longGood, bad: longBad }],
          _sourceFile: "conventions.yaml",
        },
      ];

      const result = generateConventionsSummary(conventions);

      expect(result).toContain("**Examples:**");
      expect(result).toContain(`- Good: "${longGood}"`);
      expect(result).toContain(`- Bad: "${longBad}"`);
      // Should NOT use backtick format
      expect(result).not.toContain(`\`${longGood}\``);
    });

    it("should render multiple example pairs correctly", () => {
      const conventions: LoadedConvention[] = [
        {
          domain: "commits",
          rules: ["Use conventional commits"],
          examples: [
            { good: "feat: add login", bad: "Added login" },
            { good: "fix(auth): handle expired tokens", bad: "fixed bug" },
          ],
          _sourceFile: "conventions.yaml",
        },
      ];

      const result = generateConventionsSummary(conventions);

      expect(result).toContain(
        "- Good: `feat: add login` — Bad: `Added login`",
      );
      expect(result).toContain(
        "- Good: `fix(auth): handle expired tokens` — Bad: `fixed bug`",
      );
    });

    it("should not include Examples section when examples array is empty", () => {
      const conventions: LoadedConvention[] = [
        {
          domain: "commits",
          rules: ["Use conventional commits"],
          examples: [],
          _sourceFile: "conventions.yaml",
        },
      ];

      const result = generateConventionsSummary(conventions);

      expect(result).not.toContain("**Examples:**");
    });

    it("should only show examples for conventions that have them", () => {
      const conventions: LoadedConvention[] = [
        {
          domain: "commits",
          rules: ["Use conventional commits"],
          examples: [
            { good: "feat: add login", bad: "Added login" },
          ],
          _sourceFile: "conventions.yaml",
        },
        {
          domain: "naming",
          rules: ["Use camelCase"],
          examples: [],
          _sourceFile: "conventions.yaml",
        },
      ];

      const result = generateConventionsSummary(conventions);

      // Split by domain sections
      const commitsSection = result.slice(
        result.indexOf("### commits"),
        result.indexOf("### naming"),
      );
      const namingSection = result.slice(result.indexOf("### naming"));

      expect(commitsSection).toContain("**Examples:**");
      expect(namingSection).not.toContain("**Examples:**");
    });

    it("should render examples after rules, not before", () => {
      const conventions: LoadedConvention[] = [
        {
          domain: "commits",
          rules: ["Use conventional commits"],
          examples: [
            { good: "feat: add login", bad: "Added login" },
          ],
          _sourceFile: "conventions.yaml",
        },
      ];

      const result = generateConventionsSummary(conventions);

      const rulePos = result.indexOf("- Use conventional commits");
      const examplesPos = result.indexOf("**Examples:**");

      expect(examplesPos).toBeGreaterThan(rulePos);
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

// AC: @cross-platform-and-version-robustness ac-4
describe("computeMetaHash", () => {
  it("should produce different hashes when conventions differ only in examples", () => {
    const skills: LoadedSkill[] = [];
    const workflows: LoadedWorkflow[] = [];

    const conventionsWithoutExamples: LoadedConvention[] = [
      {
        domain: "commits",
        rules: ["Use conventional commits"],
        examples: [],
        _sourceFile: "conventions.yaml",
      },
    ];

    const conventionsWithExamples: LoadedConvention[] = [
      {
        domain: "commits",
        rules: ["Use conventional commits"],
        examples: [{ good: "feat: add login", bad: "Added login" }],
        _sourceFile: "conventions.yaml",
      },
    ];

    const hashWithout = computeMetaHash(skills, conventionsWithoutExamples, workflows);
    const hashWith = computeMetaHash(skills, conventionsWithExamples, workflows);

    expect(hashWithout).not.toBe(hashWith);
  });
});
