/**
 * Parsed contracts for the npm publication workflow. Release semantics live in
 * scripts/validate-release.sh and are covered by behavioral boundary tests.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
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
  needs?: string | string[];
  outputs?: Record<string, string>;
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

// eslint-disable-next-line no-source-scanning/no-source-file-reads -- YAML is the executable Actions artifact.
const workflow = parse(readFileSync(WORKFLOW_PATH, "utf8")) as PublishWorkflow;
const commitOutput = "${{ needs.resolve-release.outputs.commit }}";
const tagOutput = "${{ needs.resolve-release.outputs.tag }}";

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

describe("npm publish workflow contract", () => {
  it("resolves one authoritative release commit and exports it once", () => {
    expect(workflow.on.release.types).toEqual(["published"]);
    const resolve = workflow.jobs["resolve-release"];
    expect(resolve.outputs).toEqual({
      tag: "${{ steps.resolve.outputs.tag }}",
      commit: "${{ steps.resolve.outputs.commit }}",
      version: "${{ steps.resolve.outputs.version }}",
    });
    const resolution = stepNamed(resolve, "Resolve authoritative release");
    expect(resolution.run).toBe("scripts/validate-release.sh resolve");
    expect(resolution.env).toMatchObject({
      EVENT_NAME: "${{ github.event_name }}",
      RELEASE_EVENT_COMMIT: "${{ github.sha }}",
    });
  });

  it("binds both downstream jobs to the same resolved SHA and verifies the tag", () => {
    for (const jobName of ["verify-min-node", "publish"]) {
      const job = workflow.jobs[jobName];
      expect(Array.isArray(job.needs) ? job.needs : [job.needs]).toContain("resolve-release");
      const checkout = stepNamed(job, "Checkout authoritative release commit");
      expect(checkout.uses).toBe("actions/checkout@v4");
      expect(checkout.with).toMatchObject({ ref: commitOutput, "fetch-depth": 0 });
      const binding = stepNamed(job, "Verify authoritative tag binding");
      expect(binding.run).toBe("scripts/validate-release.sh verify");
      expect(binding.env).toMatchObject({ RELEASE_TAG: tagOutput, EXPECTED_COMMIT: commitOutput });
    }
  });

  it("orders validation before install, build, tests, pack, and publication", () => {
    for (const jobName of ["verify-min-node", "publish"]) {
      const job = workflow.jobs[jobName];
      const validation = stepIndex(job, "Verify authoritative tag binding");
      for (const gate of [
        "Install dependencies",
        "Build",
        "Run tests",
        "Verify package contents",
        "Verify clean-source pack",
        "Publish to npm",
      ]) {
        const index = job.steps.findIndex((step) => step.name === gate);
        if (index >= 0) expect(validation).toBeLessThan(index);
      }
    }
    const publish = workflow.jobs.publish;
    expect(stepIndex(publish, "Final remote tag-binding check")).toBe(
      stepIndex(publish, "Publish to npm") - 1,
    );
  });

  it("keeps manual recovery dry by default and requires explicit publication", () => {
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(inputs["dry-run"]).toMatchObject({ default: true, type: "boolean" });
    expect(inputs["release-tag"]).toMatchObject({ required: true, type: "string" });
    const publish = stepNamed(workflow.jobs.publish, "Publish to npm");
    expect(publish.if).toBe(
      "github.event_name == 'release' || (github.event_name == 'workflow_dispatch' && inputs.dry-run == false)",
    );
    expect(publish.run).toBe("npm publish --provenance --access public");
  });

  it("preserves the Node 20 gate and OIDC publish dependency", () => {
    expect(
      stepNamed(workflow.jobs["verify-min-node"], "Setup Node.js").with?.["node-version"],
    ).toBe("20");
    expect(workflow.jobs.publish.needs).toEqual(["resolve-release", "verify-min-node"]);
  });
});
