/**
 * Source contracts for the npm publication workflow.
 *
 * These checks intentionally inspect the workflow artifact itself: GitHub
 * Actions is the runtime, so the checked-in YAML is the executable behavior
 * under test.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_PATH = join(ROOT, ".github", "workflows", "publish.yml");

interface WorkflowStep {
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  needs?: string;
  steps: WorkflowStep[];
}

interface PublishWorkflow {
  on: {
    release: { types: string[] };
    workflow_dispatch: {
      inputs: Record<string, { required: boolean; default?: boolean; type: string }>;
    };
  };
  jobs: Record<string, WorkflowJob>;
}

// eslint-disable-next-line no-source-scanning/no-source-file-reads -- The workflow YAML is the executable release artifact whose source contract is under test.
const workflow = parse(readFileSync(WORKFLOW_PATH, "utf8")) as PublishWorkflow;
const releaseTagExpression =
  "${{ github.event_name == 'release' && github.event.release.tag_name || inputs.release-tag }}";

function stepNamed(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps.find((candidate) => candidate.name === name);
  expect(step, `${name} step is required`).toBeDefined();
  return step!;
}

function stepIndex(job: WorkflowJob, name: string): number {
  const index = job.steps.findIndex((step) => step.name === name);
  expect(index, `${name} step is required`).toBeGreaterThanOrEqual(0);
  return index;
}

describe("npm publish workflow source contract", () => {
  it("checks out the immutable release tag in both verification and publication jobs", () => {
    expect(workflow.on.release.types).toEqual(["published"]);

    for (const jobName of ["verify-min-node", "publish"]) {
      const checkout = stepNamed(workflow.jobs[jobName], "Checkout release tag");
      expect(checkout.uses).toBe("actions/checkout@v4");
      expect(checkout.with?.ref).toBe(releaseTagExpression);
      expect(checkout.with?.["fetch-depth"]).toBe(0);
    }
  });

  it("validates tag grammar, checked-out commit, and package version before package gates", () => {
    for (const jobName of ["verify-min-node", "publish"]) {
      const job = workflow.jobs[jobName];
      const validation = stepNamed(job, "Validate release tag and package version");
      expect(validation.run).toContain("refs/tags/$TAG^{commit}");
      expect(validation.run).toContain("git rev-parse HEAD");
      expect(validation.run).toContain(
        'PACKAGE_VERSION="$(node -p "require(\'./package.json\').version")"',
      );
      expect(validation.run).toContain('if [[ "$PACKAGE_VERSION" != "$VERSION" ]]');
      expect(validation.run).toContain('if [[ "$LOCK_VERSION" != "$VERSION" ]]');
      expect(validation.run).toMatch(/\^v\(0\|\[1-9\]/);
      expect(validation.env?.RELEASE_TAG).toBe(releaseTagExpression);
      expect(validation.env?.EVENT_NAME).toBe("${{ github.event_name }}");
      expect(validation.run).not.toContain("${{");

      const validationIndex = stepIndex(job, "Validate release tag and package version");
      for (const gate of [
        "Install dependencies",
        "Build",
        "Run tests",
        "Verify package contents",
        "Verify clean-source pack",
      ]) {
        const gateIndex = job.steps.findIndex((step) => step.name === gate);
        if (gateIndex >= 0) expect(validationIndex).toBeLessThan(gateIndex);
      }
    }
  });

  it("makes manual runs dry by default and binds recovery to an existing published release tag", () => {
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(inputs["dry-run"]).toMatchObject({ default: true, type: "boolean" });
    expect(inputs["release-tag"]).toMatchObject({ required: true, type: "string" });

    for (const jobName of ["verify-min-node", "publish"]) {
      const validation = stepNamed(
        workflow.jobs[jobName],
        "Validate release tag and package version",
      );
      expect(validation.run).toContain('if [[ "$EVENT_NAME" == "workflow_dispatch" ]]');
      expect(validation.run).toContain("gh api");
      expect(validation.run).toContain("published_at");
      expect(validation.run).toContain(".draft");
    }
  });

  it("publishes only automatic releases or explicitly non-dry manual recovery runs", () => {
    expect(workflow.jobs.publish.needs).toBe("verify-min-node");
    const minimumNodeSetup = stepNamed(workflow.jobs["verify-min-node"], "Setup Node.js");
    expect(minimumNodeSetup.with?.["node-version"]).toBe("20");
    const publish = stepNamed(workflow.jobs.publish, "Publish to npm");
    expect(publish.if).toBe(
      "github.event_name == 'release' || (github.event_name == 'workflow_dispatch' && inputs.dry-run == false)",
    );
    expect(publish.run).toBe("npm publish --provenance --access public");
  });
});
