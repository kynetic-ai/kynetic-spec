/**
 * Convention validation module.
 *
 * Validates content against convention rules with domain-specific strategies.
 */

import type { Convention, ConventionValidation } from "../schema/meta.js";

/**
 * Convention validation error
 */
export interface ConventionValidationError {
  domain: string;
  message: string;
  location?: string;
  expected?: string;
}

/**
 * Convention validation result
 */
export interface ConventionValidationResult {
  valid: boolean;
  errors: ConventionValidationError[];
  skipped: string[]; // Domains skipped (e.g., prose conventions)
  stats: {
    conventionsChecked: number;
    conventionsSkipped: number;
  };
}

/**
 * Validate content against a regex pattern
 */
function validateRegex(
  content: string,
  validation: ConventionValidation,
  domain: string,
): ConventionValidationError | null {
  if (!validation.pattern) {
    return {
      domain,
      message: "Regex validation requires a pattern",
    };
  }

  try {
    const regex = new RegExp(validation.pattern);
    if (!regex.test(content)) {
      return {
        domain,
        message:
          validation.message || `Content does not match required pattern`,
        expected: validation.pattern,
      };
    }
  } catch (err) {
    return {
      domain,
      message: `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return null;
}

/**
 * Validate content against an enum of allowed values
 */
function validateEnum(
  content: string,
  validation: ConventionValidation,
  domain: string,
): ConventionValidationError | null {
  if (!validation.allowed || validation.allowed.length === 0) {
    return {
      domain,
      message: "Enum validation requires an allowed list",
    };
  }

  if (!validation.allowed.includes(content.trim())) {
    return {
      domain,
      message: validation.message || `Value not in allowed list`,
      expected: `One of: ${validation.allowed.join(", ")}`,
    };
  }

  return null;
}

/**
 * Validate content against a range (word count, character count, or line count)
 */
function validateRange(
  content: string,
  validation: ConventionValidation,
  domain: string,
): ConventionValidationError | null {
  const unit = validation.unit || "words";

  let count: number;
  switch (unit) {
    case "words":
      count = content
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 0).length;
      break;
    case "chars":
      count = content.length;
      break;
    case "lines":
      count = content.split("\n").length;
      break;
    default:
      return {
        domain,
        message: `Unknown unit: ${unit}`,
      };
  }

  const min = validation.min;
  const max = validation.max;

  if (min !== undefined && count < min) {
    return {
      domain,
      message:
        validation.message ||
        `Content too short: ${count} ${unit}, minimum ${min} ${unit}`,
    };
  }

  if (max !== undefined && count > max) {
    return {
      domain,
      message:
        validation.message ||
        `Content too long: ${count} ${unit}, maximum ${max} ${unit}`,
    };
  }

  return null;
}

/**
 * Validate content against a single convention
 *
 * @param content - The content to validate
 * @param convention - The convention to validate against
 * @returns Validation error if validation fails, null otherwise
 */
export function validateConvention(
  content: string,
  convention: Convention,
): ConventionValidationError | null {
  if (!convention.validation) {
    // Convention has no validation config - it's advisory only
    return null;
  }

  const { validation } = convention;
  const domain = convention.domain;

  switch (validation.type) {
    case "regex":
      return validateRegex(content, validation, domain);
    case "enum":
      return validateEnum(content, validation, domain);
    case "range":
      return validateRange(content, validation, domain);
    case "prose":
      // Prose conventions are advisory only - no validation
      return null;
    default:
      return {
        domain,
        message: `Unknown validation type: ${(validation as any).type}`,
      };
  }
}

/**
 * Validate multiple conventions
 *
 * This is a lower-level API that validates content against a list of conventions.
 * For full validation of a project's conventions against actual content,
 * use the higher-level validateProjectConventions function.
 *
 * @param conventions - Array of conventions to check
 * @param contentMap - Map of domain to content (e.g., { commits: "feat: add feature" })
 * @returns Validation result
 */
export function validateConventions(
  conventions: Convention[],
  contentMap: Record<string, string>,
): ConventionValidationResult {
  const errors: ConventionValidationError[] = [];
  const skipped: string[] = [];
  let checked = 0;

  for (const convention of conventions) {
    if (!convention.validation) {
      skipped.push(convention.domain);
      continue;
    }

    if (convention.validation.type === "prose") {
      skipped.push(convention.domain);
      continue;
    }

    const content = contentMap[convention.domain];
    if (content === undefined) {
      // No content provided for this domain - skip
      continue;
    }

    checked++;
    const error = validateConvention(content, convention);
    if (error) {
      errors.push(error);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    skipped,
    stats: {
      conventionsChecked: checked,
      conventionsSkipped: skipped.length,
    },
  };
}
