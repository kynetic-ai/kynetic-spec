/**
 * Parsing utilities for merge driver.
 *
 * Handles reading and parsing all three versions (base, ours, theirs)
 * of a YAML file, with graceful fallback when parsing fails.
 */

import * as fs from "node:fs/promises";
import { parseYaml } from "../parser/yaml.js";
import type { ParseResult, ParsedVersions } from "./types.js";

/**
 * Parse all three versions of a YAML file.
 *
 * AC: @yaml-merge-driver ac-1
 * Parses base, ours, and theirs as structured data instead of text.
 *
 * AC: @yaml-merge-driver ac-11
 * Returns parse failure if any file cannot be parsed.
 *
 * @param basePath Path to base version (common ancestor)
 * @param oursPath Path to ours version (current branch)
 * @param theirsPath Path to theirs version (incoming branch)
 * @returns ParseResult with parsed versions or error
 */
export async function parseYamlVersions(
  basePath: string,
  oursPath: string,
  theirsPath: string,
): Promise<ParseResult> {
  try {
    // Read all three files
    const [baseContent, oursContent, theirsContent] = await Promise.all([
      fs.readFile(basePath, "utf-8"),
      fs.readFile(oursPath, "utf-8"),
      fs.readFile(theirsPath, "utf-8"),
    ]);

    // Parse all three versions
    let base: unknown;
    let ours: unknown;
    let theirs: unknown;

    try {
      base = parseYaml(baseContent);
    } catch (err) {
      return {
        success: false,
        error: `Failed to parse base: ${err instanceof Error ? err.message : String(err)}`,
        failedFile: "base",
      };
    }

    try {
      ours = parseYaml(oursContent);
    } catch (err) {
      return {
        success: false,
        error: `Failed to parse ours: ${err instanceof Error ? err.message : String(err)}`,
        failedFile: "ours",
      };
    }

    try {
      theirs = parseYaml(theirsContent);
    } catch (err) {
      return {
        success: false,
        error: `Failed to parse theirs: ${err instanceof Error ? err.message : String(err)}`,
        failedFile: "theirs",
      };
    }

    return {
      success: true,
      versions: { base, ours, theirs },
    };
  } catch (err) {
    // File read error
    return {
      success: false,
      error: `Failed to read files: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
