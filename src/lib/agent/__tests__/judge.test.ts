import { describe, it, expect, vi } from "vitest";
import { l6Judge } from "../judge";

const candidates = [{ "@type": "Product", name: "Tee" }];

describe("l6Judge (soft, never throws, never gates)", () => {
  it("returns passed=true on a match verdict", async () => {
    const ask = vi.fn(async () => '{"match": true, "reason": "Product matches a PDP"}');
    const r = await l6Judge({ url: "https://x/products/tee", candidates, ask });
    expect(r.passed).toBe(true);
    expect(r.detail).toContain("Product matches");
  });

  it("returns passed=false on a mismatch verdict (still recorded, never throws)", async () => {
    const ask = vi.fn(async () => '{"match": false, "reason": "type does not fit the page"}');
    const r = await l6Judge({ url: "https://x/products/tee", candidates, ask });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("does not fit");
  });

  it("tolerates code fences and surrounding prose around the JSON", async () => {
    const ask = vi.fn(
      async () => 'Sure!\n```json\n{"match": true, "reason": "ok"}\n```\nDone.'
    );
    const r = await l6Judge({ url: "https://x", candidates, ask });
    expect(r.passed).toBe(true);
  });

  it("degrades to a soft passing verdict when the LLM throws", async () => {
    const ask = vi.fn(async () => {
      throw new Error("inference down");
    });
    const r = await l6Judge({ url: "https://x", candidates, ask });
    expect(r.passed).toBe(true); // soft: never blocks
    expect(r.detail).toContain("judge unavailable");
    expect(r.detail).toContain("inference down");
  });

  it("degrades to a soft passing verdict on unparseable output", async () => {
    const ask = vi.fn(async () => "totally not json");
    const r = await l6Judge({ url: "https://x", candidates, ask });
    expect(r.passed).toBe(true);
    expect(r.detail).toContain("judge unavailable");
  });

  it("skips (soft pass) when there are no candidates and makes no LLM call", async () => {
    const ask = vi.fn(async () => '{"match": false, "reason": "x"}');
    const r = await l6Judge({ url: "https://x", candidates: [], ask });
    expect(r.passed).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
});
