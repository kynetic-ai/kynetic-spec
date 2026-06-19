/**
 * Built-in system actors used by kspec-owned maintenance writes.
 *
 * These are not project agents a user dispatches directly; they are stable
 * canonical identities for records authored by kspec data upgrades.
 */

export const KSPEC_UPGRADE_ACTOR = {
  canonicalId: "kspec-upgrade",
  displayName: "kspec upgrade",
} as const;
