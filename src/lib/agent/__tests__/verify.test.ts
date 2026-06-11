import { describe, it, expect, vi } from "vitest";
import { l4Verify } from "../verify";

const URL = "https://shop.myshopify.com/products/tee";

/** A valid Product schema (passes the validation engine). */
const VALID_PRODUCT = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Summer Collection Tee",
  description: "A lightweight cotton t-shirt.",
  image: "https://example.com/tee.jpg",
  sku: "TEE-001",
  brand: { "@type": "Brand", name: "Acme" },
  offers: {
    "@type": "Offer",
    price: "29.99",
    priceCurrency: "USD",
    availability: "https://schema.org/InStock",
    url: "https://example.com/tee",
  },
};

function pageWith(schema: unknown): string {
  return `<!doctype html><html><head>
    <script type="application/ld+json">${JSON.stringify(schema)}</script>
    </head><body>tee</body></html>`;
}

const EMPTY_PAGE = `<!doctype html><html><head></head><body>no schema here</body></html>`;

const noSleep = () => Promise.resolve();

describe("l4Verify (live verify)", () => {
  it("passes when the live render carries a valid required type", async () => {
    const fetchHtml = vi.fn(async () => pageWith(VALID_PRODUCT));
    const r = await l4Verify({
      fetchHtml,
      url: URL,
      requireTypes: ["Product"],
      minOutcome: "valid",
      maxAttempts: 1,
    });
    expect(r.passed).toBe(true);
    expect(fetchHtml).toHaveBeenCalledTimes(1);
  });

  it("fails when the snippet did not render (no JSON-LD on the page)", async () => {
    const r = await l4Verify({
      fetchHtml: async () => EMPTY_PAGE,
      url: URL,
      requireTypes: ["Product"],
      minOutcome: "valid",
      maxAttempts: 1,
    });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/no JSON-LD/i);
  });

  it("fails when a required type is missing from the live render", async () => {
    const article = { "@context": "https://schema.org", "@type": "Article", headline: "x" };
    const r = await l4Verify({
      fetchHtml: async () => pageWith(article),
      url: URL,
      requireTypes: ["Product"],
      minOutcome: "valid",
      maxAttempts: 1,
    });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/no valid 'Product'/);
  });

  it("fails when the required type is present but invalid live", async () => {
    const brokenProduct = { "@context": "https://schema.org", "@type": "Product" }; // missing name etc.
    const r = await l4Verify({
      fetchHtml: async () => pageWith(brokenProduct),
      url: URL,
      requireTypes: ["Product"],
      minOutcome: "valid",
      maxAttempts: 1,
    });
    expect(r.passed).toBe(false);
  });

  it("returns a failed GateResult (does not throw) when the fetch errors", async () => {
    const r = await l4Verify({
      fetchHtml: async () => {
        throw new Error("ECONNREFUSED");
      },
      url: URL,
      requireTypes: ["Product"],
      minOutcome: "valid",
      maxAttempts: 1,
    });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/could not fetch/i);
  });

  it("polls past a stale render: empty first, schema on retry", async () => {
    const fetchHtml = vi
      .fn<(url: string) => Promise<string>>()
      .mockResolvedValueOnce(EMPTY_PAGE) // not propagated yet
      .mockResolvedValueOnce(pageWith(VALID_PRODUCT)); // now live
    const sleep = vi.fn(noSleep);
    const r = await l4Verify({
      fetchHtml,
      url: URL,
      requireTypes: ["Product"],
      minOutcome: "valid",
      maxAttempts: 4,
      sleep,
    });
    expect(r.passed).toBe(true);
    expect(fetchHtml).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1); // slept once between the two attempts
  });

  // Issue #28: per-type bars — same contract as the L2 gate's requirements.
  it("per-type requirements: a valid-bar ineligible type passes next to a rich-bar type", async () => {
    const website = {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "Acme",
      url: "https://example.com",
    };
    const html = `<!doctype html><html><head>
      <script type="application/ld+json">${JSON.stringify(VALID_PRODUCT)}</script>
      <script type="application/ld+json">${JSON.stringify(website)}</script>
      </head><body></body></html>`;
    const r = await l4Verify({
      fetchHtml: async () => html,
      url: URL,
      requireTypes: ["Product", "WebSite"],
      minOutcome: "valid",
      requirements: [
        { type: "Product", outcome: "rich_results_eligible" },
        { type: "WebSite", outcome: "valid" }, // ineligible — must NOT be held to rich
      ],
      maxAttempts: 1,
    });
    expect(r.passed).toBe(true);
  });

  it("per-type requirements REPLACE requireTypes/minOutcome when present", async () => {
    const r = await l4Verify({
      fetchHtml: async () => pageWith(VALID_PRODUCT),
      url: URL,
      requireTypes: ["Product"],
      minOutcome: "valid",
      requirements: [{ type: "WebSite", outcome: "valid" }],
      maxAttempts: 1,
    });
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/no valid 'WebSite'/);
  });

  it("exhausts attempts when the page never renders the schema", async () => {
    const fetchHtml = vi.fn(async () => EMPTY_PAGE);
    const sleep = vi.fn(noSleep);
    const r = await l4Verify({
      fetchHtml,
      url: URL,
      requireTypes: ["Product"],
      minOutcome: "valid",
      maxAttempts: 3,
      sleep,
    });
    expect(r.passed).toBe(false);
    expect(fetchHtml).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2); // slept between attempts, not after the last
  });
});

describe("l4Verify dup gate + freshness (dev-store live findings)", () => {
  const PRODUCT_A = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Ski Wax",
    offers: { "@type": "Offer", price: 24.95, priceCurrency: "USD", availability: "https://schema.org/InStock" },
  };
  const PRODUCT_B = { ...PRODUCT_A, name: "Ski Wax (theme copy)" };
  const htmlWith = (...blocks: unknown[]) =>
    blocks
      .map((b) => `<script type="application/ld+json">${JSON.stringify(b)}</script>`)
      .join("\n");

  it("unique:true is enforced THROUGH l4Verify (two valid Products fail)", async () => {
    const res = await l4Verify({
      url: "https://x/p",
      requireTypes: ["Product"],
      minOutcome: "valid",
      unique: true,
      maxAttempts: 1,
      fetchHtml: async () => htmlWith(PRODUCT_A, PRODUCT_B),
    });
    expect(res.passed).toBe(false);
    expect(res.detail).toContain("duplicate schema: 2 valid 'Product'");
  });

  it("freshness: a stale-but-valid render fails until the staged blocks appear", async () => {
    // Attempt 1 serves the STALE render (old valid Product); attempt 2 the fresh one.
    const renders = [htmlWith(PRODUCT_B), htmlWith(PRODUCT_A)];
    let i = 0;
    const res = await l4Verify({
      url: "https://x/p",
      requireTypes: ["Product"],
      minOutcome: "valid",
      expectBlocks: [PRODUCT_A],
      maxAttempts: 2,
      sleep: async () => {},
      fetchHtml: async () => renders[i++],
    });
    expect(res.passed).toBe(true);
    expect(i).toBe(2); // first attempt was rejected as stale
  });

  it("freshness exhausted: never-propagating write fails with a propagation message", async () => {
    const res = await l4Verify({
      url: "https://x/p",
      requireTypes: ["Product"],
      minOutcome: "valid",
      expectBlocks: [PRODUCT_A],
      maxAttempts: 2,
      sleep: async () => {},
      fetchHtml: async () => htmlWith(PRODUCT_B),
    });
    expect(res.passed).toBe(false);
    expect(res.detail).toContain("not yet in the live render");
  });
});
