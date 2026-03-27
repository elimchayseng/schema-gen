import { schemaDefinitions } from "./schema-definitions";
import type {
  ValidationResult,
  ValidationIssue,
  PropertyDefinition,
  PropertyValueType,
} from "./types";

// ============================================================
// Inheritance resolution
// ============================================================

/**
 * Resolves the full property list for a @type by walking the
 * inheritance chain. Child properties override parent properties
 * with the same name.
 */
export function resolveProperties(typeName: string): PropertyDefinition[] {
  const def = schemaDefinitions[typeName];
  if (!def) return [];

  const parentProps = def.extends ? resolveProperties(def.extends) : [];
  const childNames = new Set(def.properties.map((p) => p.name));
  const inherited = parentProps.filter((p) => !childNames.has(p.name));

  return [...inherited, ...def.properties];
}

/** Returns the set of property names directly defined on a type (not inherited). */
function getOwnPropertyNames(typeName: string): Set<string> {
  const def = schemaDefinitions[typeName];
  if (!def) return new Set();
  return new Set(def.properties.map((p) => p.name));
}

/**
 * Resolves the full invalidProperties map for a type, merging
 * with ancestors.
 */
export function resolveInvalidProperties(
  typeName: string
): Record<string, string> {
  const def = schemaDefinitions[typeName];
  if (!def) return {};

  const parentInvalid = def.extends
    ? resolveInvalidProperties(def.extends)
    : {};

  return { ...parentInvalid, ...(def.invalidProperties ?? {}) };
}

// ============================================================
// Main entry points
// ============================================================

/**
 * Validates a parsed JSON-LD object against schema definitions.
 * This is the core validation function (PRD Section 8, Component 2).
 */
export function validateSchema(input: unknown): ValidationResult {
  const start = performance.now();
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  let schemaType: string | null = null;

  // Must be a plain object
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    errors.push({
      severity: "error",
      path: "$",
      message: "Schema must be a JSON object.",
      code: "INVALID_JSON",
    });
    return buildResult(errors, warnings, schemaType, start);
  }

  const obj = input as Record<string, unknown>;

  // @context
  if (!obj["@context"]) {
    errors.push({
      severity: "error",
      path: "@context",
      message: 'Missing required @context. Expected "https://schema.org".',
      code: "MISSING_CONTEXT",
    });
  } else {
    const ctx = String(obj["@context"]);
    const validContexts = [
      "https://schema.org",
      "https://schema.org/",
      "http://schema.org",
      "http://schema.org/",
    ];
    if (!validContexts.includes(ctx)) {
      errors.push({
        severity: "error",
        path: "@context",
        message: `Invalid @context: "${ctx}". Expected "https://schema.org".`,
        code: "INVALID_CONTEXT",
        actualValue: ctx,
        expectedValue: "https://schema.org",
      });
    }
  }

  // @type
  if (!obj["@type"]) {
    errors.push({
      severity: "error",
      path: "@type",
      message: "Missing required @type property.",
      code: "MISSING_TYPE",
    });
    return buildResult(errors, warnings, schemaType, start);
  }

  schemaType = String(obj["@type"]);

  if (!schemaDefinitions[schemaType]) {
    errors.push({
      severity: "error",
      path: "@type",
      message: `Unknown schema type: "${schemaType}".`,
      code: "UNKNOWN_TYPE",
      actualValue: schemaType,
    });
    return buildResult(errors, warnings, schemaType, start);
  }

  // Validate the root object
  validateObject(obj, schemaType, "$", errors, warnings);

  return buildResult(errors, warnings, schemaType, start);
}

/**
 * Convenience wrapper — validates a raw JSON string.
 * Catches parse errors and returns them as INVALID_JSON.
 */
export function validateSchemaString(jsonString: string): ValidationResult {
  const start = performance.now();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [
        {
          severity: "error",
          path: "$",
          message: `Invalid JSON: ${(e as Error).message}`,
          code: "INVALID_JSON",
        },
      ],
      warnings: [],
      summary: {
        errorCount: 1,
        warningCount: 0,
        schemaType: null,
        validationTimeMs: performance.now() - start,
      },
    };
  }
  return validateSchema(parsed);
}

// ============================================================
// Object-level validation (recursive)
// ============================================================

function validateObject(
  obj: Record<string, unknown>,
  typeName: string,
  basePath: string,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
  isNested = false
): void {
  const allProps = resolveProperties(typeName);
  const invalidProps = resolveInvalidProperties(typeName);
  const propMap = new Map(allProps.map((p) => [p.name, p]));
  const ownProps = isNested ? getOwnPropertyNames(typeName) : null;

  // --- Check required / recommended presence ---
  for (const propDef of allProps) {
    const value = obj[propDef.name];
    const path = joinPath(basePath, propDef.name);
    const missing =
      value === undefined || value === null || value === "";

    if (propDef.requirement === "required" && missing) {
      errors.push({
        severity: "error",
        path,
        message: `Required property '${propDef.name}' is missing from ${typeName}.`,
        code: "MISSING_REQUIRED",
        expectedValue: propDef.valueType,
      });
    } else if (propDef.requirement === "recommended" && missing) {
      // Skip inherited recommended properties on nested objects (e.g. description
      // inherited from Thing on HowToStep — noisy and not actionable)
      if (isNested && ownProps && !ownProps.has(propDef.name)) {
        continue;
      }
      warnings.push({
        severity: "warning",
        path,
        message: `Recommended property '${propDef.name}' is missing from ${typeName}.`,
        code: "MISSING_RECOMMENDED",
        expectedValue: propDef.valueType,
      });
    }
  }

  // --- Validate each present property ---
  for (const [key, value] of Object.entries(obj)) {
    // Skip JSON-LD keywords
    if (key.startsWith("@")) continue;

    const path = joinPath(basePath, key);

    // Check explicitly invalid properties (PRD Appendix B)
    if (key in invalidProps) {
      errors.push({
        severity: "error",
        path,
        message: invalidProps[key],
        code: "INVALID_PROPERTY_PLACEMENT",
        actualValue: key,
        suggestion: invalidProps[key],
      });
      continue;
    }

    const propDef = propMap.get(key);

    // Unknown property — flag as error with suggestion
    if (!propDef) {
      errors.push({
        severity: "error",
        path,
        message: `'${key}' is not a valid property for ${typeName}.`,
        code: "INVALID_PROPERTY",
        actualValue: key,
      });
      continue;
    }

    // Validate the value if present
    if (value !== undefined && value !== null && value !== "") {
      validateValue(value, propDef, path, typeName, errors, warnings);
    }
  }
}

// ============================================================
// Value-level validation
// ============================================================

function validateValue(
  value: unknown,
  propDef: PropertyDefinition,
  path: string,
  parentType: string,
  errors: ValidationIssue[],
  warnings: ValidationIssue[]
): void {
  switch (propDef.valueType) {
    case "Text":
      validateText(value, propDef, path, errors);
      break;

    case "URL":
      validateUrl(value, propDef, path, errors, warnings);
      break;

    case "Number":
      validateNumber(value, propDef, path, errors);
      break;

    case "Integer":
      validateInteger(value, propDef, path, errors);
      break;

    case "Boolean":
      if (typeof value !== "boolean") {
        errors.push({
          severity: "error",
          path,
          message: `'${propDef.name}' expected Boolean but got ${typeof value}.`,
          code: "INVALID_PROPERTY_TYPE",
          actualValue: typeof value,
          expectedValue: "Boolean",
        });
      }
      break;

    case "Date":
    case "DateTime":
      validateDate(value, propDef, path, errors);
      break;

    case "Time":
      validateTime(value, propDef, path, errors);
      break;

    case "Enum":
      validateEnum(value, propDef, path, errors, warnings);
      break;

    case "Object":
      validateNestedObject(value, propDef, path, errors, warnings);
      break;

    case "Array":
      validateArray(value, propDef, path, errors, warnings);
      break;
  }
}

// ============================================================
// Type-specific validators
// ============================================================

function validateText(
  value: unknown,
  propDef: PropertyDefinition,
  path: string,
  errors: ValidationIssue[]
): void {
  // Accept strings and also objects that might be a Brand-as-string case
  if (typeof value !== "string") {
    // Special case: if a string was expected but an object was given,
    // flag as suboptimal (handled by caller if needed) or type error
    errors.push({
      severity: "error",
      path,
      message: `'${propDef.name}' expected Text but got ${typeof value}.`,
      code: "INVALID_PROPERTY_TYPE",
      actualValue: typeof value,
      expectedValue: "Text",
    });
    return;
  }

  if (propDef.pattern) {
    const regex = new RegExp(propDef.pattern);
    if (!regex.test(value)) {
      errors.push({
        severity: "error",
        path,
        message: `'${propDef.name}' value "${value}" does not match required pattern: ${propDef.pattern}`,
        code: "INVALID_PATTERN",
        actualValue: value,
        expectedValue: propDef.pattern,
      });
    }
  }
}

function validateUrl(
  value: unknown,
  propDef: PropertyDefinition,
  path: string,
  errors: ValidationIssue[],
  warnings: ValidationIssue[]
): void {
  if (typeof value !== "string") {
    errors.push({
      severity: "error",
      path,
      message: `'${propDef.name}' expected URL but got ${typeof value}.`,
      code: "INVALID_PROPERTY_TYPE",
      actualValue: typeof value,
      expectedValue: "URL",
    });
    return;
  }

  try {
    const parsed = new URL(value);
    // Warn if using http instead of https for image URLs
    if (propDef.name === "image" && parsed.protocol === "http:") {
      warnings.push({
        severity: "warning",
        path,
        message: `'${propDef.name}' should use HTTPS.`,
        code: "ENUM_FORMAT",
        actualValue: value,
        suggestion: "Use an HTTPS URL for images.",
      });
    }
  } catch {
    errors.push({
      severity: "error",
      path,
      message: `'${propDef.name}' has invalid URL: "${value}".`,
      code: "INVALID_URL_FORMAT",
      actualValue: value,
      expectedValue: "Valid URL",
    });
  }
}

function validateNumber(
  value: unknown,
  propDef: PropertyDefinition,
  path: string,
  errors: ValidationIssue[]
): void {
  const num = typeof value === "number" ? value : Number(value);
  if (typeof value !== "number" && (typeof value !== "string" || isNaN(num))) {
    errors.push({
      severity: "error",
      path,
      message: `'${propDef.name}' expected Number but got "${value}".`,
      code: "INVALID_PROPERTY_TYPE",
      actualValue: value,
      expectedValue: "Number",
    });
  }
}

function validateInteger(
  value: unknown,
  propDef: PropertyDefinition,
  path: string,
  errors: ValidationIssue[]
): void {
  const num = Number(value);
  if (isNaN(num) || !Number.isInteger(num)) {
    errors.push({
      severity: "error",
      path,
      message: `'${propDef.name}' expected Integer but got "${value}".`,
      code: "INVALID_PROPERTY_TYPE",
      actualValue: value,
      expectedValue: "Integer",
    });
  }
}

function validateDate(
  value: unknown,
  propDef: PropertyDefinition,
  path: string,
  errors: ValidationIssue[]
): void {
  if (typeof value !== "string" || isNaN(Date.parse(value))) {
    errors.push({
      severity: "error",
      path,
      message: `'${propDef.name}' has invalid date format: "${value}".`,
      code: "INVALID_DATE_FORMAT",
      actualValue: value,
      expectedValue: "ISO 8601 date (e.g. 2026-01-15)",
    });
  }
}

function validateTime(
  value: unknown,
  propDef: PropertyDefinition,
  path: string,
  errors: ValidationIssue[]
): void {
  if (typeof value !== "string" || !/^\d{2}:\d{2}(:\d{2})?$/.test(value)) {
    errors.push({
      severity: "error",
      path,
      message: `'${propDef.name}' has invalid time format: "${value}". Expected HH:MM or HH:MM:SS.`,
      code: "INVALID_DATE_FORMAT",
      actualValue: value,
      expectedValue: "HH:MM or HH:MM:SS",
    });
  }
}

function validateEnum(
  value: unknown,
  propDef: PropertyDefinition,
  path: string,
  errors: ValidationIssue[],
  warnings: ValidationIssue[]
): void {
  if (!propDef.enumValues) return;

  const strVal = String(value);

  // Check if they used a short form (e.g. "InStock" instead of full URL)
  if (!propDef.enumValues.includes(strVal)) {
    // See if a full-URL version matches
    const fullUrl = `https://schema.org/${strVal}`;
    if (propDef.enumValues.includes(fullUrl)) {
      warnings.push({
        severity: "warning",
        path,
        message: `Use full URL format: ${fullUrl}`,
        code: "ENUM_FORMAT",
        actualValue: strVal,
        expectedValue: fullUrl,
        suggestion: `Change "${strVal}" to "${fullUrl}".`,
      });
    } else {
      errors.push({
        severity: "error",
        path,
        message: `'${propDef.name}' has invalid value "${strVal}". Expected one of: ${propDef.enumValues.join(", ")}.`,
        code: "INVALID_ENUM_VALUE",
        actualValue: strVal,
        expectedValue: propDef.enumValues.join(" | "),
      });
    }
  }
}

function validateNestedObject(
  value: unknown,
  propDef: PropertyDefinition,
  path: string,
  errors: ValidationIssue[],
  warnings: ValidationIssue[]
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    // Special suboptimal-type warning: string where Object expected (e.g. brand as "Nike")
    if (typeof value === "string" && propDef.expectedTypes?.length) {
      warnings.push({
        severity: "warning",
        path,
        message: `'${propDef.name}' should be a ${propDef.expectedTypes[0]} object with 'name' for best results.`,
        code: "SUBOPTIMAL_TYPE",
        actualValue: typeof value,
        expectedValue: propDef.expectedTypes[0],
        suggestion: `Use {"@type": "${propDef.expectedTypes[0]}", "name": "${value}"} instead of a plain string.`,
      });
      return;
    }

    errors.push({
      severity: "error",
      path,
      message: `'${propDef.name}' expected Object but got ${Array.isArray(value) ? "Array" : typeof value}.`,
      code: "INVALID_PROPERTY_TYPE",
      actualValue: Array.isArray(value) ? "Array" : typeof value,
      expectedValue: "Object",
    });
    return;
  }

  const nested = value as Record<string, unknown>;
  const nestedType = nested["@type"] as string | undefined;

  if (!nestedType) {
    // Object without @type — can't recursively validate, but not an error
    // (some nested objects like simple {"name": "..."} are fine)
    return;
  }

  // Check that the nested @type is one of the expected types
  if (
    propDef.expectedTypes?.length &&
    !propDef.expectedTypes.includes(nestedType)
  ) {
    // Only error if the type is truly unknown; if it's just unexpected,
    // still validate it if we have definitions for it
    if (!schemaDefinitions[nestedType]) {
      errors.push({
        severity: "error",
        path: `${path}.@type`,
        message: `Expected @type "${propDef.expectedTypes.join('" or "')}" but got unknown type "${nestedType}".`,
        code: "UNKNOWN_TYPE",
        actualValue: nestedType,
        expectedValue: propDef.expectedTypes.join(" | "),
      });
      return;
    }
  }

  // Recursively validate the nested object if we have definitions
  if (schemaDefinitions[nestedType]) {
    validateObject(nested, nestedType, path, errors, warnings, true);
  }
}

function validateArray(
  value: unknown,
  propDef: PropertyDefinition,
  path: string,
  errors: ValidationIssue[],
  warnings: ValidationIssue[]
): void {
  if (!Array.isArray(value)) {
    errors.push({
      severity: "error",
      path,
      message: `'${propDef.name}' expected Array but got ${typeof value}.`,
      code: "INVALID_PROPERTY_TYPE",
      actualValue: typeof value,
      expectedValue: "Array",
    });
    return;
  }

  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;

    if (propDef.arrayItemType === "Object") {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        errors.push({
          severity: "error",
          path: itemPath,
          message: `Array item at index ${index} expected Object but got ${typeof item}.`,
          code: "INVALID_PROPERTY_TYPE",
          actualValue: typeof item,
          expectedValue: "Object",
        });
        return;
      }

      const itemObj = item as Record<string, unknown>;
      const itemType = itemObj["@type"] as string | undefined;

      if (itemType && schemaDefinitions[itemType]) {
        validateObject(itemObj, itemType, itemPath, errors, warnings, true);
      } else if (
        itemType &&
        propDef.arrayItemExpectedTypes?.length &&
        !propDef.arrayItemExpectedTypes.includes(itemType)
      ) {
        errors.push({
          severity: "error",
          path: `${itemPath}.@type`,
          message: `Expected @type "${propDef.arrayItemExpectedTypes.join('" or "')}" but got "${itemType}".`,
          code: "UNKNOWN_TYPE",
          actualValue: itemType,
          expectedValue: propDef.arrayItemExpectedTypes.join(" | "),
        });
      }
    } else if (propDef.arrayItemType === "URL") {
      if (typeof item !== "string") {
        errors.push({
          severity: "error",
          path: itemPath,
          message: `Array item at index ${index} expected URL string but got ${typeof item}.`,
          code: "INVALID_PROPERTY_TYPE",
          actualValue: typeof item,
          expectedValue: "URL",
        });
        return;
      }
      try {
        new URL(item);
      } catch {
        errors.push({
          severity: "error",
          path: itemPath,
          message: `Array item at index ${index} has invalid URL: "${item}".`,
          code: "INVALID_URL_FORMAT",
          actualValue: item,
          expectedValue: "Valid URL",
        });
      }
    }
  });
}

// ============================================================
// Helpers
// ============================================================

function joinPath(base: string, key: string): string {
  return base === "$" ? key : `${base}.${key}`;
}

function buildResult(
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
  schemaType: string | null,
  start: number
): ValidationResult {
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    summary: {
      errorCount: errors.length,
      warningCount: warnings.length,
      schemaType,
      validationTimeMs: performance.now() - start,
    },
  };
}
