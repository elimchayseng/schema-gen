import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { preprocessHtml, readSSEStream } from "../client";

// ─── Helper to create a ReadableStream-based Response ────────────────────────

function makeSSEResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

// ─── preprocessHtml ──────────────────────────────────────────────────────────

describe("preprocessHtml", () => {
  it("removes script tags", () => {
    const html = '<html><body><script>alert("xss")</script><p>Hello</p></body></html>';
    const result = preprocessHtml(html);
    expect(result).not.toContain("<script");
    expect(result).toContain("Hello");
  });

  it("removes style tags", () => {
    const html = "<html><body><style>body { color: red; }</style><p>Content</p></body></html>";
    const result = preprocessHtml(html);
    expect(result).not.toContain("<style");
    expect(result).toContain("Content");
  });

  it("removes SVG tags", () => {
    const html = '<html><body><svg><circle cx="50" cy="50" r="50"/></svg><p>Text</p></body></html>';
    const result = preprocessHtml(html);
    expect(result).not.toContain("<svg");
    expect(result).toContain("Text");
  });

  it("removes noscript tags", () => {
    const html = "<html><body><noscript>Enable JS</noscript><p>Main</p></body></html>";
    const result = preprocessHtml(html);
    expect(result).not.toContain("<noscript");
    expect(result).toContain("Main");
  });

  it("removes Shopify boilerplate ([data-shopify])", () => {
    const html = '<html><body><div data-shopify>Shopify stuff</div><p>Real content</p></body></html>';
    const result = preprocessHtml(html);
    expect(result).not.toContain("Shopify stuff");
    expect(result).toContain("Real content");
  });

  it("collapses whitespace", () => {
    const html = "<html><body><p>Hello     world</p></body></html>";
    const result = preprocessHtml(html);
    expect(result).not.toContain("     ");
  });

  it("removes HTML comments", () => {
    const html = "<html><body><!-- a comment --><p>Visible</p></body></html>";
    const result = preprocessHtml(html);
    expect(result).not.toContain("<!--");
    expect(result).not.toContain("a comment");
    expect(result).toContain("Visible");
  });

  it("truncates to 30KB", () => {
    const bigContent = "x".repeat(40_000);
    const html = `<html><body><p>${bigContent}</p></body></html>`;
    const result = preprocessHtml(html);
    expect(result.length).toBeLessThanOrEqual(30_000);
  });
});

// ─── readSSEStream ───────────────────────────────────────────────────────────

describe("readSSEStream", () => {
  it("accumulates content from multiple chunks", async () => {
    const response = makeSSEResponse([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);

    const result = await readSSEStream(response, "test-1");
    expect(result).toBe("Hello world");
  });

  it("returns empty string for empty stream", async () => {
    const response = makeSSEResponse([]);
    const result = await readSSEStream(response, "test-2");
    expect(result).toBe("");
  });

  it("skips malformed JSON chunks", async () => {
    const response = makeSSEResponse([
      'data: {"choices":[{"delta":{"content":"Good"}}]}\n\n',
      "data: {this is not json}\n\n",
      'data: {"choices":[{"delta":{"content":" data"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);

    const result = await readSSEStream(response, "test-3");
    expect(result).toBe("Good data");
  });

  it("handles [DONE] sentinel", async () => {
    const response = makeSSEResponse([
      'data: {"choices":[{"delta":{"content":"Done test"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);

    const result = await readSSEStream(response, "test-4");
    expect(result).toBe("Done test");
  });

  it("handles data split across two reads", async () => {
    const response = makeSSEResponse([
      'data: {"choices":[{"del',
      'ta":{"content":"split"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);

    const result = await readSSEStream(response, "test-5");
    expect(result).toBe("split");
  });

  it("ignores SSE comments (: prefix)", async () => {
    const response = makeSSEResponse([
      ": this is a comment\n\n",
      'data: {"choices":[{"delta":{"content":"Real"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);

    const result = await readSSEStream(response, "test-6");
    expect(result).toBe("Real");
  });
});

// ─── generateSchemas caching (Phase 5) ───────────────────────────────────────

// A minimal GeneratorResult that satisfies generatorResultSchema.
const VALID_RESULT = {
  pageType: "product",
  recommendations: [
    {
      type: "Product",
      priority: 1 as const,
      rationale: "It is a product detail page.",
      jsonld: { "@type": "Product", name: "Tee" },
      shopifyInstructions: "render in product template",
    },
  ],
  mergedJsonld: [{ "@type": "Product", name: "Tee" }],
  notes: [],
};

/** An SSE response whose streamed content is the JSON of `obj`. */
function makeResultResponse(obj: unknown): Response {
  const content = JSON.stringify(obj);
  return makeSSEResponse([
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
    "data: [DONE]\n\n",
  ]);
}

describe("generateSchemas caching", () => {
  beforeEach(() => {
    // Fresh module graph → empty cache + env consts captured from the stubs below.
    vi.resetModules();
    vi.stubEnv("HEROKU_INFERENCE_URL", "https://inference.test");
    vi.stubEnv("HEROKU_INFERENCE_KEY", "test-key");
    vi.stubEnv("HEROKU_INFERENCE_MODEL", "test-model");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("serves an identical second call from cache (one fetch, equal result)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeResultResponse(VALID_RESULT));

    const { generateSchemas } = await import("../client");
    const html = "<html><body><h1>Tee</h1><p>A nice tee.</p></body></html>";
    const url = "https://shop.test/products/tee";

    const first = await generateSchemas(html, url);
    const second = await generateSchemas(html, url);

    expect(fetchSpy).toHaveBeenCalledTimes(1); // second call hit the cache
    expect(second).toEqual(first);
    expect(second).not.toBe(first); // returned a clone, not the shared cached object
  });

  it("does not cache across different content (distinct keys → two fetches)", async () => {
    // Fresh Response per call — a ReadableStream body can only be consumed once.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => makeResultResponse(VALID_RESULT));

    const { generateSchemas } = await import("../client");
    await generateSchemas("<html><body>A</body></html>", "https://shop.test/a");
    await generateSchemas("<html><body>B different</body></html>", "https://shop.test/b");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("generateSchemas quote-repair (garnerandtow about page)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("HEROKU_INFERENCE_URL", "https://inference.test");
    vi.stubEnv("HEROKU_INFERENCE_KEY", "test-key");
    vi.stubEnv("HEROKU_INFERENCE_MODEL", "test-model");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("recovers when the model echoes unescaped quotes into a string value", async () => {
    // The model wrote page copy verbatim: `The word "garner" means to gather` —
    // invalid JSON. The structural repair must escape the inner quotes and the
    // zod gate must still accept the recovered result.
    const broken = JSON.stringify(VALID_RESULT).replace(
      '"name":"Tee"',
      '"name":"Tee","description":"The word "garner" means to gather"'
    );
    const response = makeSSEResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: broken } }] })}\n\n`,
      "data: [DONE]\n\n",
    ]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    const { generateSchemas } = await import("../client");
    const result = await generateSchemas(
      "<html><body>About</body></html>",
      "https://shop.test/pages/about"
    );
    const jsonld = result.recommendations[0].jsonld as { description?: string };
    expect(jsonld.description).toBe('The word "garner" means to gather');
  });

  it("still throws when the response is irreparable", async () => {
    const response = makeSSEResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "{ totally broken" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    const { generateSchemas } = await import("../client");
    await expect(
      generateSchemas("<html><body>x</body></html>", "https://shop.test/x")
    ).rejects.toThrow(/not valid JSON/);
  });
});
