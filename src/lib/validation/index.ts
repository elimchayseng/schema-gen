// Barrel export for the validation module

export {
  validateSchema,
  validateSchemaString,
  resolveProperties,
  resolveInvalidProperties,
} from "./engine";

export { schemaDefinitions } from "./schema-definitions";

export { fixSchema } from "./fixer";

export {
  canDeploy,
  validateAIOutput,
  fixAndValidateAIOutput,
  validateEditorContent,
  auditCrawledSchema,
  validateBulk,
} from "./integration";

export { getStatusFromValidation } from "./types";

export type {
  ValidationResult,
  ValidationIssue,
  ValidationErrorCode,
  IssueSeverity,
  PropertyDefinition,
  PropertyRequirement,
  PropertyValueType,
  SchemaTypeDefinition,
  SchemaStatus,
  FixApplied,
  FixResult,
} from "./types";
