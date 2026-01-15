/**
 * Time parsing and formatting utilities
 */

/**
 * Parse a time specification into a Date.
 * Supports:
 * - ISO8601: "2026-01-14T10:00:00Z", "2026-01-14"
 * - Relative: "1h" (1 hour ago), "2d" (2 days ago), "1w" (1 week ago), "1m" (1 month ago)
 *
 * @param timeSpec The time specification string
 * @returns Date object, or null if invalid
 */
export function parseTimeSpec(timeSpec: string): Date | null {
  // Try ISO8601 first
  const isoDate = new Date(timeSpec);
  if (!isNaN(isoDate.getTime())) {
    return isoDate;
  }

  // Try relative time (e.g., "1h", "2d", "1w", "1m")
  const relativeMatch = timeSpec.match(/^(\d+)([hdwm])$/i);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2].toLowerCase();
    const now = new Date();

    switch (unit) {
      case 'h':
        return new Date(now.getTime() - amount * 60 * 60 * 1000);
      case 'd':
        return new Date(now.getTime() - amount * 24 * 60 * 60 * 1000);
      case 'w':
        return new Date(now.getTime() - amount * 7 * 24 * 60 * 60 * 1000);
      case 'm':
        return new Date(now.getTime() - amount * 30 * 24 * 60 * 60 * 1000);
    }
  }

  return null;
}

/**
 * Format a Date as a human-readable relative time (e.g., "2 hours ago")
 */
export function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (60 * 1000));
  const diffHours = Math.floor(diffMs / (60 * 60 * 1000));
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
  if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7);
    return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  }
  return date.toLocaleDateString();
}
