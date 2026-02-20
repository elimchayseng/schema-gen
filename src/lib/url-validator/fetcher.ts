import type { FetchResult } from "./types";

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB
const TIMEOUT_MS = 10_000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; SchemaGen/1.0; +https://schemagen.app)";

export async function fetchPage(url: string): Promise<FetchResult> {
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
