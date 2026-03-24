import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseTOML, stringify as stringifyTOML } from "smol-toml";

export const KSPEC_PROJECT_DOC_FALLBACK_FILENAME = "kspec-agents.md";

export interface EnsureCodexProjectDocFallbackOptions {
  dryRun?: boolean;
  homeDir?: string;
}

export interface EnsureCodexProjectDocFallbackResult {
  success: boolean;
  action: "added" | "unchanged" | "failed";
  path: string;
  message: string;
}

function resolveHomeDir(homeDir?: string): string {
  if (homeDir) {
    return homeDir;
  }
  const fromEnv = process.env.HOME || process.env.USERPROFILE;
  if (fromEnv) {
    return fromEnv;
  }
  return os.homedir();
}

export function getCodexConfigPath(homeDir?: string): string {
  return path.join(resolveHomeDir(homeDir), ".codex", "config.toml");
}

export async function ensureCodexProjectDocFallback(
  filename = KSPEC_PROJECT_DOC_FALLBACK_FILENAME,
  options: EnsureCodexProjectDocFallbackOptions = {},
): Promise<EnsureCodexProjectDocFallbackResult> {
  const configPath = getCodexConfigPath(options.homeDir);
  const dryRun = options.dryRun ?? false;

  let config: Record<string, unknown> = {};
  try {
    const content = await fs.readFile(configPath, "utf-8");
    config = parseTOML(content) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      // Start with empty config if file doesn't exist.
    } else {
      return {
        success: false,
        action: "failed",
        path: configPath,
        message: "Cannot update Codex config: ~/.codex/config.toml exists but is not valid TOML.",
      };
    }
  }

  const current = config.project_doc_fallback_filenames;
  const filenames: string[] = [];
  if (current === undefined) {
    // No existing setting.
  } else if (Array.isArray(current)) {
    for (const value of current) {
      if (typeof value !== "string") {
        return {
          success: false,
          action: "failed",
          path: configPath,
          message:
            "Cannot update Codex config: project_doc_fallback_filenames must be an array of strings.",
        };
      }
      filenames.push(value);
    }
  } else {
    return {
      success: false,
      action: "failed",
      path: configPath,
      message: "Cannot update Codex config: project_doc_fallback_filenames must be an array.",
    };
  }

  if (filenames.includes(filename)) {
    return {
      success: true,
      action: "unchanged",
      path: configPath,
      message: `${filename} already configured in project_doc_fallback_filenames`,
    };
  }

  config.project_doc_fallback_filenames = [...filenames, filename];

  if (!dryRun) {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, `${stringifyTOML(config)}\n`, "utf-8");
  }

  return {
    success: true,
    action: "added",
    path: configPath,
    message: dryRun
      ? `Would add ${filename} to project_doc_fallback_filenames`
      : `Added ${filename} to project_doc_fallback_filenames`,
  };
}
