import { spawnSync } from "node:child_process";
import { info, isJsonMode, output, success } from "./output.js";

export type BranchAction = "created" | "switched" | "rehydrated" | "already_on_branch";

interface BranchSubject {
  label: string;
  ref: string;
  jsonKey: string;
}

interface BranchResultReport {
  branch: string;
  action: BranchAction;
  source?: string;
  guidance: string;
  subject: BranchSubject;
  extraJson?: Record<string, unknown>;
  extraInfo?: string[];
}

function normalizeBranchSlug(preferred: string, fallback: string): string {
  return (
    preferred
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/--+/g, "-") || fallback
  );
}

function shortBranchRef(ref: string): string {
  return ref.replace(/^@/, "").slice(0, 8).toLowerCase();
}

export function computeDispatchBranchName(
  taskRef: string,
  task?: { title?: string; slugs?: string[] },
): string {
  const preferred = task?.slugs?.[0] ?? task?.title ?? taskRef.replace(/^@/, "task");
  return `dispatch/task/${normalizeBranchSlug(preferred, "task")}/${shortBranchRef(taskRef)}`;
}

export function computePlanBranchName(
  planRef: string,
  plan?: { title?: string; slugs?: string[] },
): string {
  const preferred = plan?.slugs?.[0] ?? plan?.title ?? planRef.replace(/^@/, "plan");
  return `plan/${normalizeBranchSlug(preferred, "plan")}/${shortBranchRef(planRef)}`;
}

function runGit(
  args: string[],
  options: { allowFailure?: boolean; captureStdout?: boolean } = {},
): string | void {
  const result = spawnSync("git", args, {
    encoding: "utf-8",
    stdio: options.captureStdout ? "pipe" : ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }

  if ((result.status ?? 1) !== 0) {
    if (options.allowFailure) {
      return;
    }

    const stderr = result.stderr?.trim();
    throw new Error(stderr || `git ${args.join(" ")} failed with exit code ${result.status ?? 1}`);
  }

  if (options.captureStdout) {
    return result.stdout.trim();
  }
}

export function gitRefExists(ref: string): boolean {
  try {
    runGit(["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

function listRemotes(): string[] {
  try {
    const output = runGit(["remote"], { captureStdout: true });
    if (!output) return [];
    const remotes = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return [
      ...remotes.filter((remote) => remote === "origin"),
      ...remotes.filter((remote) => remote !== "origin"),
    ];
  } catch {
    return [];
  }
}

export function findBranchOnRemote(branch: string): string | null {
  for (const remote of listRemotes()) {
    runGit(["fetch", remote, branch], { allowFailure: true });
    if (gitRefExists(`refs/remotes/${remote}/${branch}`)) {
      return `${remote}/${branch}`;
    }
  }
  return null;
}

export function gitCreateBranchFrom(branch: string, startPoint: string): void {
  runGit(["branch", "--track", branch, startPoint]);
}

export function gitCheckout(branch: string): void {
  runGit(["checkout", branch]);
}

export function gitCheckoutNew(branch: string, startPoint?: string): void {
  const args = ["checkout", "-b", branch];
  if (startPoint) {
    args.push(startPoint);
  }
  runGit(args);
}

export function reportBranchResult(result: BranchResultReport): void {
  const actionLabels: Record<BranchAction, string> = {
    created: "Created new branch",
    switched: "Switched to existing branch",
    rehydrated: "Rehydrated branch from remote",
    already_on_branch: "Already on branch",
  };

  if (isJsonMode()) {
    output({
      branch: result.branch,
      action: result.action,
      source: result.source ?? null,
      guidance: result.guidance,
      [result.subject.jsonKey]: result.subject.ref,
      ...result.extraJson,
    });
    return;
  }

  success(`${actionLabels[result.action]}: ${result.branch}`);
  info(`${result.subject.label}: ${result.subject.ref}`);
  if (result.source) {
    info(`Source: ${result.source}`);
  }
  for (const line of result.extraInfo ?? []) {
    info(line);
  }
  info(result.guidance);
}
