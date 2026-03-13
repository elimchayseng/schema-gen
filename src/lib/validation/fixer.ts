import { validateSchema } from "./engine";
import { resolveProperties, resolveInvalidProperties } from "./engine";
import { schemaDefinitions } from "./schema-definitions";
import type { FixApplied, FixResult, PropertyDefinition, ValidationResult } from "./types";

/**
 * Auto-fix deterministic validation errors in a JSON-LD schema.
 * Deep-clones the input, applies fixes, validates before and after.
 */
export function fixSchema(schema: Record<string, unknown>): FixResult {
  const original = schema;
  const validationBefore = validateSchema(original);
  const fixed = structuredClone(original) as Record<string, unknown>;
  const fixes: FixApplied[] = [];

  // 1. Fix @context
  fixContext(fixed, fixes);

  // 2-4. Recursively fix enum, suboptimal type, and property placement
  const typeName = String(fixed["@type"] ?? "");
  if (typeName && schemaDefinitions[typeName]) {
    fixObject(fixed, typeName, "$", fixes, null);
  }

  const validationAfter = validateSchema(fixed);

  return { original, fixed, fixes, validationBefore, validationAfter };
}

function fixContext(
  obj: Record<string, unknown>,
  fixes: FixApplied[]
): void {
  const ctx = obj["@context"];
  if (!ctx) {
    obj["@context"] = "https://schema.org";
    fixes.push({
      path: "@context",
      code: "MISSING_CONTEXT",
      description: 'Added missing @context "https://schema.org"',
    });
  } else {
    const ctxStr = String(ctx);
    const validContexts = [
      "https://schema.org",
      "https://schema.org/",
      "http://schema.org",
      "http://schema.org/",
    ];
    if (!validContexts.includes(ctxStr)) {
      obj["@context"] = "https://schema.org";
      fixes.push({
        path: "@context",
        code: "INVALID_CONTEXT",
        description: `Changed @context from "${ctxStr}" to "https://schema.org"`,
      });
    }
  }
}

/**
 * Recursively traverse object, fixing enum values, suboptimal types,
 * and misplaced properties.
 */
function fixObject(
  obj: Record<string, unknown>,
  typeName: string,
  basePath: string,
  fixes: FixApplied[],
  parent: { obj: Record<string, unknown>; typeName: string } | null
): void {
  const allProps = resolveProperties(typeName);
  const invalidProps = resolveInvalidProperties(typeName);
  const propMap = new Map(allProps.map((p) => [p.name, p]));

  // Strip unknown properties — not in schema definition and not a known misplaced property
  for (const key of Object.keys(obj)) {
    if (key.startsWith("@")) continue;
    if (propMap.has(key)) continue;
    if (key in invalidProps) continue;

    const path = joinPath(basePath, key);
    delete obj[key];
    fixes.push({
      path,
      code: "INVALID_PROPERTY",
      description: `Removed unknown property '${key}' from ${typeName}`,
    });
  }

  // Fix misplaced properties — move them to the parent if appropriate
  for (const key of Object.keys(obj)) {
    if (key.startsWith("@")) continue;

    if (key in invalidProps && parent) {
      const message = invalidProps[key];
      // Parse target type from the message: "Move to Product"
      const moveMatch = message.match(/Move to (\w+)/);
      if (moveMatch && moveMatch[1] === parent.typeName) {
        const value = obj[key];
        const path = joinPath(basePath, key);

        // Only move if parent doesn't already have this property
        if (!(key in parent.obj) || parent.obj[key] === undefined) {
          parent.obj[key] = value;
          delete obj[key];
          fixes.push({
            path,
            code: "INVALID_PROPERTY_PLACEMENT",
            description: `Moved '${key}' from ${typeName} to ${parent.typeName}`,
          });
        }
      }
    }
  }

  // Fix enum values and suboptimal types
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith("@")) continue;

    const path = joinPath(basePath, key);
    const propDef = propMap.get(key);
    if (!propDef) continue;

    fixValue(obj, key, value, propDef, path, fixes, { obj, typeName });
  }
}

function fixValue(
  container: Record<string, unknown>,
  key: string,
  value: unknown,
  propDef: PropertyDefinition,
  path: string,
  fixes: FixApplied[],
  current: { obj: Record<string, unknown>; typeName: string }
): void {
  if (value === undefined || value === null || value === "") return;

  // Array-to-scalar coercion: property expects URL/Text but LLM gave an array
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    (propDef.valueType === "URL" || propDef.valueType === "Text")
  ) {
    const first = value[0];
    if (typeof first === "string") {
      container[key] = first;
      fixes.push({
        path,
        code: "INVALID_PROPERTY_TYPE",
        description: `Unwrapped array to first ${propDef.valueType} value for '${key}'`,
      });
      return;
    }
  }

  // Array-to-Object unwrap: property expects Object but LLM gave an array
  if (
    Array.isArray(value) &&
    propDef.valueType === "Object"
  ) {
    if (value.length === 1 && typeof value[0] === "object" && value[0] !== null) {
      container[key] = value[0];
      fixes.push({
        path,
        code: "INVALID_PROPERTY_TYPE",
        description: `Unwrapped single-element array to Object for '${key}'`,
      });
      // Continue to process the unwrapped object below
      fixObjectValue(container, key, value[0], propDef, path, fixes, current);
      return;
    }
    // Multiple items — pick first as best effort
    if (value.length > 1 && typeof value[0] === "object" && value[0] !== null) {
      container[key] = value[0];
      fixes.push({
        path,
        code: "INVALID_PROPERTY_TYPE",
        description: `Unwrapped array to first Object for '${key}' (had ${value.length} items)`,
      });
      fixObjectValue(container, key, value[0], propDef, path, fixes, current);
      return;
    }
  }

  switch (propDef.valueType) {
    case "Enum":
      fixEnumValue(container, key, value, propDef, path, fixes);
      break;

    case "Object":
      fixObjectValue(container, key, value, propDef, path, fixes, current);
      break;

    case "Array":
      fixArrayValue(value, propDef, path, fixes, current);
      break;
  }
}

function fixEnumValue(
  container: Record<string, unknown>,
  key: string,
  value: unknown,
  propDef: PropertyDefinition,
  path: string,
  fixes: FixApplied[]
): void {
  if (!propDef.enumValues || typeof value !== "string") return;

  if (!propDef.enumValues.includes(value)) {
    const fullUrl = `https://schema.org/${value}`;
    if (propDef.enumValues.includes(fullUrl)) {
      container[key] = fullUrl;
      fixes.push({
        path,
        code: "ENUM_FORMAT",
        description: `Changed '${value}' to '${fullUrl}'`,
      });
    }
  }
}

function fixObjectValue(
  container: Record<string, unknown>,
  key: string,
  value: unknown,
  propDef: PropertyDefinition,
  path: string,
  fixes: FixApplied[],
  parent: { obj: Record<string, unknown>; typeName: string }
): void {
  // String → object expansion
  if (typeof value === "string" && propDef.expectedTypes?.length) {
    const expandedType = propDef.expectedTypes[0];
    const expanded = { "@type": expandedType, name: value };
    container[key] = expanded;
    fixes.push({
      path,
      code: "SUBOPTIMAL_TYPE",
      description: `Expanded '${value}' to {"@type": "${expandedType}", "name": "${value}"}`,
    });
    return;
  }

  // Recurse into nested objects
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const nested = value as Record<string, unknown>;
    const nestedType = nested["@type"] as string | undefined;
    if (nestedType && schemaDefinitions[nestedType]) {
      fixObject(nested, nestedType, path, fixes, parent);
    }
  }
}

function fixArrayValue(
  value: unknown,
  propDef: PropertyDefinition,
  path: string,
  fixes: FixApplied[],
  parent: { obj: Record<string, unknown>; typeName: string }
): void {
  if (!Array.isArray(value)) return;

  value.forEach((item, index) => {
    if (
      propDef.arrayItemType === "Object" &&
      typeof item === "object" &&
      item !== null &&
      !Array.isArray(item)
    ) {
      const itemObj = item as Record<string, unknown>;
      const itemType = itemObj["@type"] as string | undefined;
      if (itemType && schemaDefinitions[itemType]) {
        fixObject(itemObj, itemType, `${path}[${index}]`, fixes, parent);
      }
    }
  });
}

function joinPath(base: string, key: string): string {
  return base === "$" ? key : `${base}.${key}`;
}

// ─── Context-aware fixes ─────────────────────────────────────────────────────

export interface FixContext {
  pageUrl?: string;
}

/**
 * Extended fix pipeline: runs structural fixes, then applies context-aware
 * fixes (e.g. auto-filling `url` from page URL), then re-validates.
 */
export function fixSchemaWithContext(
  schema: Record<string, unknown>,
  context?: FixContext
): FixResult {
  const result = fixSchema(schema);
  const fixed = result.fixed;
  const fixes = [...result.fixes];

  if (context?.pageUrl) {
    applyUrlAutoFill(fixed, context.pageUrl, "$", fixes);
  }

  // Re-validate after context fixes
  const validationAfter = validateSchema(fixed);

  return {
    ...result,
    fixed,
    fixes,
    validationAfter,
  };
}

/**
 * Auto-fill missing `url` properties on Product, Article, Offer, etc.
 */
function applyUrlAutoFill(
  obj: Record<string, unknown>,
  pageUrl: string,
  basePath: string,
  fixes: FixApplied[]
): void {
  const type = String(obj["@type"] ?? "");

  // Types where `url` should default to the page URL
  const urlTypes = ["Product", "Article", "BlogPosting", "Organization", "WebSite"];
  if (urlTypes.includes(type) && !obj["url"]) {
    obj["url"] = pageUrl;
    fixes.push({
      path: joinPath(basePath, "url"),
      code: "MISSING_RECOMMENDED",
      description: `Auto-filled 'url' from page URL`,
    });
  }

  // Auto-fill url on nested offers
  if (obj["offers"] && typeof obj["offers"] === "object" && !Array.isArray(obj["offers"])) {
    const offers = obj["offers"] as Record<string, unknown>;
    if (String(offers["@type"] ?? "") === "Offer" && !offers["url"]) {
      offers["url"] = pageUrl;
      fixes.push({
        path: joinPath(basePath, "offers.url"),
        code: "MISSING_RECOMMENDED",
        description: `Auto-filled 'offers.url' from page URL`,
      });
    }
  }
}

// ─── Inherited warning filter ────────────────────────────────────────────────

/**
 * Returns the set of property names defined directly on a type (own properties),
 * not inherited from Thing or other ancestors.
 */
function getOwnPropertyNames(typeName: string): Set<string> {
  const def = schemaDefinitions[typeName];
  if (!def) return new Set();
  return new Set(def.properties.map((p) => p.name));
}

/**
 * Filters out MISSING_RECOMMENDED warnings for properties that are only
 * inherited from Thing (not defined on the type's own properties).
 * Only filters warnings on nested objects (not root-level schemas).
 */
export function filterInheritedWarnings(
  result: ValidationResult
): ValidationResult {
  const filteredWarnings = result.warnings.filter((w) => {
    if (w.code !== "MISSING_RECOMMENDED") return true;

    // Parse the path to determine the type and property
    // Paths look like "offers.description", "brand.description", "description"
    const parts = w.path.split(".");
    if (parts.length < 2) return true; // Root-level property — keep it

    // The property name is the last segment
    const propName = parts[parts.length - 1];
    // We need to figure out the type of the nested object.
    // The warning message typically contains the type: "... on <Type>"
    const typeMatch = w.message.match(/on (\w+)/);
    if (!typeMatch) return true;

    const nestedType = typeMatch[1];
    const ownProps = getOwnPropertyNames(nestedType);

    // If the property is NOT an own property, it's inherited — filter it out
    if (!ownProps.has(propName)) return false;

    return true;
  });

  return {
    ...result,
    warnings: filteredWarnings,
    summary: {
      ...result.summary,
      warningCount: filteredWarnings.length,
    },
  };
}
