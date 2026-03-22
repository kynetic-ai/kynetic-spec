export interface ClaudeHookCommand {
  type?: string;
  command?: string;
}

export interface ClaudeHookEntry {
  matcher?: string;
  hooks?: ClaudeHookCommand[];
}

export const KSPEC_STOP_HOOK_COMMAND = "kspec session checkpoint --json";

/**
 * Return true only for the exact Stop entry shape that kspec setup installs.
 * User-authored Stop hooks may also call session checkpoint, but setup must not
 * treat those as managed entries.
 */
export function isKspecManagedStopHookEntry(entry: ClaudeHookEntry): boolean {
  if (entry.matcher !== "") {
    return false;
  }

  if (!entry.hooks || entry.hooks.length !== 1) {
    return false;
  }

  const [hook] = entry.hooks;
  return hook?.type === "command" && hook.command === KSPEC_STOP_HOOK_COMMAND;
}
