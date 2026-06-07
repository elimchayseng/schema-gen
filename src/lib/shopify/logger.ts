/**
 * Structured JSON logger for the Shopify client.
 * Mirrors the `log()` convention in src/lib/ai/client.ts (component-tagged JSON),
 * but scrubs sensitive fields so an access token can never leak into logs.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

/** Field names (case-insensitive) whose values must never be logged. */
const SENSITIVE_KEYS = [
  "token",
  "accesstoken",
  "access_token",
  "x-shopify-access-token",
  "authorization",
  "password",
  "secret",
  "client_secret",
  "client_id",
];

const REDACTED = "[REDACTED]";

/**
 * Returns a deep copy of `data` with any sensitive keys masked, recursing into
 * nested plain objects and arrays. Matching is case-insensitive on the key
 * name. Deep (not shallow) so a token tucked inside a nested object — e.g.
 * `{ headers: { authorization } }` — can't slip through into a log line.
 */
export function scrubSensitive(
  data: Record<string, unknown>
): Record<string, unknown> {
  return scrubValue(data) as Record<string, unknown>;
}

function scrubValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(scrubValue);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEYS.includes(key.toLowerCase())
        ? REDACTED
        : scrubValue(v);
    }
    return out;
  }
  return value;
}

export function shopifyLog(
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    component: "shopify",
    message,
    ...(data ? scrubSensitive(data) : {}),
  };
  const fn =
    level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : console.log;
  fn(JSON.stringify(entry));
}
