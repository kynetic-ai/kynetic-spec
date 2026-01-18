/**
 * Command suggestion utilities using fuzzy matching
 */

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  // Initialize matrix
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  // Fill matrix
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j] + 1 // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Find the closest match to a given command
 */
export function findClosestCommand(
  input: string,
  validCommands: string[],
  threshold: number = 3
): string | null {
  let closestMatch: string | null = null;
  let closestDistance = Infinity;

  for (const cmd of validCommands) {
    const distance = levenshteinDistance(input.toLowerCase(), cmd.toLowerCase());

    // Only consider if distance is within threshold
    if (distance <= threshold && distance < closestDistance) {
      closestDistance = distance;
      closestMatch = cmd;
    }
  }

  return closestMatch;
}

/**
 * Common command aliases (only for top-level commands that users might expect)
 */
export const COMMAND_ALIASES: Record<string, string> = {
  // Singular/plural flexibility
  // Note: both 'task' and 'tasks' are valid commands, so no alias needed
};

/**
 * Get all available command names from a Commander program
 */
export function getAllCommands(program: any): string[] {
  const commands: string[] = [];

  // Add top-level commands
  for (const cmd of program.commands) {
    commands.push(cmd.name());

    // Add subcommands
    if (cmd.commands && cmd.commands.length > 0) {
      for (const subcmd of cmd.commands) {
        commands.push(`${cmd.name()} ${subcmd.name()}`);
      }
    }
  }

  return commands;
}
