/**
 * Shared JSON-LD @type extraction (issue #37 dedup).
 *
 * `run.ts` (suppression planning) and `report.ts` (merchant report) each had a
 * byte-identical copy of this walk. One definition: collect every `@type` value
 * declared anywhere in a parsed JSON-LD value, descending into arrays and
 * `@graph` wrappers. Strings and string-arrays are both handled.
 */
export function schemaTypesOf(value: unknown): string[] {
  const types = new Set<string>();
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (v === null || typeof v !== "object") return;
    const obj = v as Record<string, unknown>;
    const t = obj["@type"];
    if (typeof t === "string") types.add(t);
    else if (Array.isArray(t)) {
      for (const x of t) if (typeof x === "string") types.add(x);
    }
    if (Array.isArray(obj["@graph"])) visit(obj["@graph"]);
  };
  visit(value);
  return [...types];
}
