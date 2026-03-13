import { describe, it, expect } from "vitest";
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
