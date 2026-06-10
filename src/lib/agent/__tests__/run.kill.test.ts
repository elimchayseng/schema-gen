import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PageResult } from "@/lib/crawl/types";
import type { HaltSignal } from "../types";

vi.mock("@/lib/crawl/process-page", () => ({ processPage: vi.fn() }));

// Minimal supabase mock (audit is best-effort; these tests run persistAudit:false anyway).
const h = vi.hoisted(() => {
  const client = {
    from() {
      return {
        insert() {
          return {
            select: () => ({ single: async () => ({ data: { id: "run-1" }, error: null }) }),
            then: (resolve: (v: { error: unknown }) => void) => resolve({ error: null }),
          };
        },
        update() {
          return { eq: async () => ({ error: null }) };
        },
      };
    },
  };
  return { createAdminClient: vi.fn(() => client) };
});
vi.mock("@/lib/supabase", () => ({ createAdminClient: h.createAdminClient }));

// The headline guarantee is "applyEntries is never reached after a kill" — so we spy on it
// and assert it is NOT called. makeShopifyOps is stubbed so no real Asset API is touched.
const applyMock = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../apply", () => ({
  applyEntries: applyMock.fn,
  makeShopifyOps: vi.fn(() => ({})),
}));
vi.mock("@/lib/shopify/config", () => ({
  getShopifyConfig: () => ({ shop: "shop.myshopify.com", apiVersion: "2025-01", baseUrl: "x" }),
}));

import { processPage } from "@/lib/crawl/process-page";
import { runGoal } from "../run";
import type { Goal } from "../types";

const mockProcess = vi.mocked(processPage);

const validProduct = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Summer Collection Tee",
  description: "A lightweight cotton t-shirt.",
  image: "https://example.com/tee.jpg",
  sku: "TEE-001",
  brand: { "@type": "Brand", name: "Acme" },
  offers: {
    "@type": "Offer",
    price: 29.99,
    priceCurrency: "USD",
    availability: "https://schema.org/InStock",
    url: "https://example.com/tee",
  },
};

const SHOP = "https://shop.myshopify.com";
const B = `${SHOP}/products/b`; // errors -> fix
const C = `${SHOP}/products/c`; // errors -> fix

function vr(valid: boolean, errorCount: number) {
  return {
    errorCount,
    warningCount: 0,
    schemas: [
      { type: "Product", original: {}, fixed: {}, validation: { valid }, fixesApplied: [] },
    ],
  };
}

const scan = (url: string): PageResult =>
  ({ url, status: "errors", originalSchemas: [{ "@type": "Product" }], fixedSchemas: [{ "@type": "Product" }], validationResults: vr(false, 3) } as unknown as PageResult);
const optimize = (url: string): PageResult =>
  ({ url, status: "valid", originalSchemas: [{ "@type": "Product" }], fixedSchemas: [validProduct], validationResults: vr(true, 0) } as unknown as PageResult);

/** A shouldHalt that yields the given signals in order, then "run" forever. */
function signalSequence(...signals: HaltSignal[]) {
  let i = 0;
  return () => signals[i++] ?? "run";
}

function goalFor(urls: string[]): Goal {
  return {
    siteId: "site-1",
    target: { scope: "url_list", urls, requireTypes: ["Product"], minOutcome: "valid" },
    constraints: { allowSchemaTypeChange: false },
    autonomy: "auto_apply",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockProcess.mockImplementation(async (url: string, mode: string) =>
    mode === "optimize" ? optimize(url) : scan(url)
  );
  applyMock.fn.mockReset();
  applyMock.fn.mockResolvedValue({ status: "applied", writeTarget: "999", l4: [], actions: [] });
  process.env.SHOPIFY_TEST_THEME_ID = "999";
});

describe("runGoal kill (Phase 4) — no half-written theme", () => {
  it("kill at the pre-apply checkpoint never writes the theme (the headline guarantee)", async () => {
    // perceive(run) -> act(run) -> PRE-APPLY(kill). The page is staged but never applied.
    const result = await runGoal(goalFor([B]), {
      persistAudit: false,
      dryRun: false, // live path: applyEntries WOULD run if not killed
      shouldHalt: signalSequence("run", "run", "kill"),
    });

    expect(applyMock.fn).not.toHaveBeenCalled(); // nothing written -> nothing to roll back
    expect(result.killed).toBe(true);
    expect(result.apply ?? null).toBeNull();
    expect(result.status).toBe("failed");
    // the page was still staged (work wasn't wasted) — proves we killed *after* staging.
    expect(result.stagedSnippet).toContain("Summer Collection Tee");
  });

  it("kill mid-perceive stops before any page is processed or applied", async () => {
    const result = await runGoal(goalFor([B, C]), {
      persistAudit: false,
      dryRun: false,
      shouldHalt: signalSequence("kill"),
    });

    expect(mockProcess).not.toHaveBeenCalled(); // killed before the first scan
    expect(applyMock.fn).not.toHaveBeenCalled();
    expect(result.killed).toBe(true);
    expect(result.pagesTouched).toBe(0);
    expect(result.satisfied).toEqual([]);
  });

  it("kill mid-act stops before executing the queued page or applying", async () => {
    // Kill is checked once per BATCH (Phase 5 concurrency): the single perceive batch for
    // [B,C] runs, then the act-batch check kills before any executeTask. So the kill lands
    // on the 2nd signal (perceive-batch=run, act-batch=kill), not the 3rd.
    const result = await runGoal(goalFor([B, C]), {
      persistAudit: false,
      dryRun: false,
      shouldHalt: signalSequence("run", "kill"),
    });

    // perceive scanned both; no optimize (executeTask) ever ran.
    expect(mockProcess).toHaveBeenCalledWith(B, "scan", undefined, {
      fetchHeaders: undefined,
    });
    expect(mockProcess).toHaveBeenCalledWith(C, "scan", undefined, {
      fetchHeaders: undefined,
    });
    expect(mockProcess).not.toHaveBeenCalledWith(expect.anything(), "optimize");
    expect(applyMock.fn).not.toHaveBeenCalled();
    expect(result.killed).toBe(true);
    expect(result.pagesTouched).toBe(0);
  });

  it("an already-aborted signal halts the run as a secondary kill channel", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runGoal(goalFor([B]), {
      persistAudit: false,
      dryRun: false,
      signal: controller.signal,
    });

    expect(applyMock.fn).not.toHaveBeenCalled();
    expect(result.killed).toBe(true);
  });
});
