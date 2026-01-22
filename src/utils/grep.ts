/**
 * Grep-like content search across item fields.
 *
 * Recursively searches all text content (title, description, notes, AC text)
 * and returns matched field paths.
 */

/**
 * Result of grep search on an item
 */
export interface GrepMatch {
  /** Field paths where pattern matched (e.g., "description", "notes[1].content") */
  matchedFields: string[];
}

/**
 * Search an item for a regex pattern across all text fields.
 *
 * @param item - The item to search
 * @param pattern - Regex pattern string
 * @param caseInsensitive - Whether to match case-insensitively (default: true)
 * @returns GrepMatch with matched field paths, or null if no matches
 */
export function grepItem(
  item: Record<string, unknown>,
  pattern: string,
  caseInsensitive = true,
): GrepMatch | null {
  const flags = caseInsensitive ? "i" : "";
  let regex: RegExp;

  try {
    regex = new RegExp(pattern, flags);
  } catch {
    // Invalid regex - treat as literal string
    regex = new RegExp(escapeRegex(pattern), flags);
  }

  const matchedFields: string[] = [];
  searchObject(item, "", regex, matchedFields);

  if (matchedFields.length === 0) {
    return null;
  }

  return { matchedFields };
}

/**
 * Recursively search an object for regex matches in string values.
 */
function searchObject(
  obj: unknown,
  path: string,
  regex: RegExp,
  matches: string[],
): void {
  if (obj === null || obj === undefined) {
    return;
  }

  if (typeof obj === "string") {
    if (regex.test(obj)) {
      matches.push(path);
    }
    return;
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const arrayPath = path ? `${path}[${i}]` : `[${i}]`;
      searchObject(obj[i], arrayPath, regex, matches);
    }
    return;
  }

  if (typeof obj === "object") {
    // Skip internal fields (starting with _)
    for (const [key, value] of Object.entries(obj)) {
      if (key.startsWith("_")) continue;

      const fieldPath = path ? `${path}.${key}` : key;
      searchObject(value, fieldPath, regex, matches);
    }
  }
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Format matched fields for display.
 * Groups and simplifies paths for readability.
 */
export function formatMatchedFields(fields: string[]): string {
  if (fields.length === 0) return "";

  // Simplify common patterns
  const simplified = fields.map((field) => {
    // "acceptance_criteria[0].given" -> "ac[0].given"
    return field
      .replace(/^acceptance_criteria/, "ac")
      .replace(/\.content$/, ""); // notes[0].content -> notes[0]
  });

  // Deduplicate
  const unique = [...new Set(simplified)];

  return unique.join(", ");
}
