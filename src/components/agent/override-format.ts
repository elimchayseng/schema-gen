/**
 * Display helpers + client-side DTOs for merchant overrides (issue #29).
 * Kept separate from SchemaTweakPanel so future surfaces (e.g. the agent
 * report) can render overrides consistently.
 */

/** Wire shape of one override row as returned by GET /api/agent/overrides. */
export interface MerchantOverrideDto {
  id: string;
  siteId: string;
  url: string;
  schemaType: string;
  fieldPath: string;
  value: unknown;
  source: "chat" | "manual";
  createdAt: string;
  updatedAt: string;
}

/** One edit as returned by POST /api/agent/overrides/chat. */
export interface ChatEditDto {
  fieldPath: string;
  value: unknown;
  reason: string;
}

const MAX_VALUE_CHARS = 80;

/** Compact, human-readable rendering of an override value. */
export function formatOverrideValue(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    // Shorten schema.org enum URLs to their leaf ("PreOrder").
    const enumMatch = value.match(/^https?:\/\/schema\.org\/(\w+)$/);
    text = enumMatch ? enumMatch[1] : value;
  } else {
    text = JSON.stringify(value);
  }
  return text.length > MAX_VALUE_CHARS
    ? `${text.slice(0, MAX_VALUE_CHARS - 1)}…`
    : text;
}

/** "offers.0.availability" → "offers[0].availability" for readability. */
export function prettyFieldPath(fieldPath: string): string {
  return fieldPath.replace(/\.(\d+)(?=\.|$)/g, "[$1]");
}
