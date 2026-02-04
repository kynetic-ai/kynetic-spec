/**
 * CLI parsing utilities
 *
 * AC: @comma-tag-syntax ac-1, ac-2, ac-3 - Parse comma-separated tags
 */

/**
 * Parse tags from Commander.js variadic option.
 * Supports both space-separated and comma-separated syntax.
 *
 * Examples:
 * - --tag cli urgent       → ['cli', 'urgent']
 * - --tag cli,urgent       → ['cli', 'urgent']
 * - --tag cli,urgent api   → ['cli', 'urgent', 'api']
 * - --tag cli --tag urgent → ['cli', 'urgent']
 *
 * AC: @comma-tag-syntax ac-1 - comma-separated values
 * AC: @comma-tag-syntax ac-2 - mixed comma and space separation
 * AC: @comma-tag-syntax ac-3 - preserve existing --tag --tag behavior
 */
export function parseTagsArray(tags: string | string[] | undefined): string[] {
  if (!tags) {
    return [];
  }

  // Commander collects variadic args as array
  const tagArray = Array.isArray(tags) ? tags : [tags];

  // Split each element on commas and flatten
  return tagArray
    .flatMap((tag) => tag.split(","))
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}
