import { validateSchema } from "./engine";
import { resolveProperties, resolveInvalidProperties } from "./engine";
import { schemaDefinitions } from "./schema-definitions";
import type { FixApplied, FixResult, PropertyDefinition } from "./types";

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
