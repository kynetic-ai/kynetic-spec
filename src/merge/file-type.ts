/**
 * File type detection for kspec merge driver.
 *
 * Determines which merge strategy to apply based on file path patterns.
 */

/**
 * Types of kspec files that require different merge strategies
 */
export enum FileType {
  /** Task files: *.tasks.yaml */
  Tasks = "tasks",
  /** Inbox files: *.inbox.yaml */
  Inbox = "inbox",
  /** Spec module files: modules/*.yaml */
  SpecModules = "spec_modules",
  /** Manifest file: kynetic.yaml */
  Manifest = "manifest",
  /** Meta file: kynetic.meta.yaml */
  Meta = "meta",
  /** Unrecognized files (fallback to default behavior) */
  Unknown = "unknown",
}

/**
 * Detect the type of a kspec file based on its path.
 *
 * @param filePath - Path to the file (can be relative or absolute)
 * @returns The detected file type
 */
export function detectFileType(filePath: string): FileType {
  // Normalize path separators for cross-platform compatibility
  const normalizedPath = filePath.replace(/\\/g, "/");

  // Extract just the filename for pattern matching
  const parts = normalizedPath.split("/");
  const fileName = parts[parts.length - 1];

  // Check for manifest (exact match)
  if (fileName === "kynetic.yaml") {
    return FileType.Manifest;
  }

  // Check for meta file (exact match)
  if (fileName === "kynetic.meta.yaml") {
    return FileType.Meta;
  }

  // Check for task files (*.tasks.yaml pattern)
  if (fileName.endsWith(".tasks.yaml")) {
    return FileType.Tasks;
  }

  // Check for inbox files (*.inbox.yaml pattern)
  if (fileName.endsWith(".inbox.yaml")) {
    return FileType.Inbox;
  }

  // Check for spec modules (in modules/ directory)
  // Match both "/modules/" and "modules/" at start of path
  if (
    (normalizedPath.includes("/modules/") ||
      normalizedPath.startsWith("modules/")) &&
    fileName.endsWith(".yaml")
  ) {
    return FileType.SpecModules;
  }

  // Fallback for unrecognized files
  return FileType.Unknown;
}
