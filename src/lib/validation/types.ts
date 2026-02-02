// ============================================================
// Schema Definition Types (PRD Section 8 — Component 1)
// ============================================================

/** How a property is classified for validation */
export type PropertyRequirement = "required" | "recommended" | "optional";

/** The expected value type of a property */
export type PropertyValueType =
  | "Text"
  | "URL"
  | "Number"
  | "Integer"
  | "Boolean"
  | "Date"
  | "DateTime"
  | "Time"
  | "Enum"
  | "Object"
  | "Array";

/** Defines a single property within a schema.org @type */
export interface PropertyDefinition {
  name: string;
  requirement: PropertyRequirement;
  valueType: PropertyValueType;
  /** For Enum valueType — the set of allowed values */
  enumValues?: string[];
  /** For Object valueType — expected nested @type(s) */
  expectedTypes?: string[];
  /** For Array valueType — the type of each array item */
  arrayItemType?: PropertyValueType;
  /** For Array of Objects — expected @type(s) of array items */
  arrayItemExpectedTypes?: string[];
  /** Regex pattern the value must match (Text, Number, etc.) */
  pattern?: string;
  /** Human-readable description for UI tooltips / AI context */
  description?: string;
}

/** Defines a complete schema.org @type with all its valid properties */
export interface SchemaTypeDefinition {
  type: string;
  /** Parent type this inherits from (e.g. "Thing") */
  extends?: string;
  properties: PropertyDefinition[];
  /** Properties explicitly invalid for this type — triggers error with correction guidance */
  invalidProperties?: Record<string, string>;
  description?: string;
}

// ============================================================
// Validation Result Types (PRD Section 8 — Component 2)
// ============================================================

export type IssueSeverity = "error" | "warning";

/** All machine-readable validation error codes */
export type ValidationErrorCode =
  | "INVALID_JSON"
  | "MISSING_CONTEXT"
  | "INVALID_CONTEXT"
  | "MISSING_TYPE"
  | "UNKNOWN_TYPE"
  | "MISSING_REQUIRED"
  | "MISSING_RECOMMENDED"
  | "INVALID_PROPERTY"
  | "INVALID_PROPERTY_PLACEMENT"
  | "INVALID_PROPERTY_TYPE"
  | "INVALID_ENUM_VALUE"
  | "INVALID_URL_FORMAT"
  | "INVALID_DATE_FORMAT"
  | "INVALID_PATTERN"
  | "ENUM_FORMAT"
  | "SUBOPTIMAL_TYPE";

/** A single validation issue found in the schema */
export interface ValidationIssue {
  severity: IssueSeverity;
  /** JSON path to the problem (e.g. "offers.color") */
  path: string;
  message: string;
  code: ValidationErrorCode;
  actualValue?: unknown;
  expectedValue?: string;
  /** Suggested fix — displayed in the UI and used by AI explain */
  suggestion?: string;
}

/** Complete result of validating a JSON-LD object (PRD Section 8.6) */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  summary: {
    errorCount: number;
    warningCount: number;
    schemaType: string | null;
    validationTimeMs: number;
  };
}

// ============================================================
// Page & Workspace Status (PRD Section 6)
// ============================================================

export type SchemaStatus = "error" | "warning" | "valid" | "ignored";

export function getStatusFromValidation(
  result: ValidationResult,
  ignored: boolean
): SchemaStatus {
  if (ignored) return "ignored";
  if (result.errors.length > 0) return "error";
  if (result.warnings.length > 0) return "warning";
  return "valid";
}
