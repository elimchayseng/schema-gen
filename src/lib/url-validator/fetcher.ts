import type { FetchResult } from "./types";

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB
const TIMEOUT_MS = 10_000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; SchemaGen/1.0; +https://schemagen.app)";

/**
 * Returns true if the hostname resolves to a private/reserved IP range.
 */
export function isPrivateHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();

  // Block well-known private hostnames
  if (
    lower === "localhost" ||
    lower.endsWith(".local") ||
    lower === "0.0.0.0" ||
    lower === "::1" ||
    lower === "[::1]"
  ) {
    return true;
  }

  // Check IPv4 private ranges
  const ipv4Match = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b, c] = ipv4Match.map(Number);
    // 127.0.0.0/8
    if (a === 127) return true;
    // 10.0.0.0/8
    if (a === 10) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 169.254.0.0/16 (link-local)
    if (a === 169 && b === 254) return true;
    // 0.0.0.0/8
    if (a === 0) return true;
  }

  return false;
}

export async function fetchPage(url: string): Promise<FetchResult> {
  // Validate URL and check for SSRF
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return {
      html: "",
      statusCode: 0,
      finalUrl: url,
      error: "Invalid URL",
    };
  }

  if (isPrivateHostname(parsedUrl.hostname)) {
    return {
      html: "",
      statusCode: 0,
      finalUrl: url,
      error: "Private or reserved addresses are not allowed",
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      redirect: "follow",
    });

    clearTimeout(timer);

    // Read response body up to MAX_BODY_BYTES
    const reader = response.body?.getReader();
    if (!reader) {
      return {
        html: "",
        statusCode: response.status,
        finalUrl: response.url || url,
        error: "Response body is empty",
      };
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let done = false;

    while (!done) {
      const { value, done: streamDone } = await reader.read();
      done = streamDone;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > MAX_BODY_BYTES) {
          reader.cancel();
          break;
        }
        chunks.push(value);
      }
    }

    const combined = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    const html = new TextDecoder().decode(combined);

    return {
      html,
      statusCode: response.status,
      finalUrl: response.url || url,
    };
  } catch (err: unknown) {
    clearTimeout(timer);
    const message =
      err instanceof Error
        ? err.name === "AbortError"
          ? "Request timed out after 10 seconds"
          : err.message
        : "Unknown fetch error";
    return {
      html: "",
      statusCode: 0,
      finalUrl: url,
      error: message,
    };
  }
}
