/**
 * Copy a single JSON-LD object wrapped in a script tag to the clipboard.
 * Returns true on success, false on failure.
 */
export async function copyJsonLdScript(json: string): Promise<boolean> {
  try {
    const script = `<script type="application/ld+json">\n${json}\n</script>`;
    await navigator.clipboard.writeText(script);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy multiple JSON-LD schemas merged into a single script tag.
 * If there's only one schema, it's not wrapped in an array.
 * Returns true on success, false on failure.
 */
export async function copyMergedJsonLdScript(
  schemas: Record<string, unknown>[]
): Promise<boolean> {
  try {
    const merged = schemas.length === 1 ? schemas[0] : schemas;
    const script = `<script type="application/ld+json">\n${JSON.stringify(
      merged,
      null,
      2
    )}\n</script>`;
    await navigator.clipboard.writeText(script);
    return true;
  } catch {
    return false;
  }
}
