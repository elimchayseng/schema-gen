/**
 * Staging write strategy (issue #26): runGoal under
 * opts.writeTheme = { mode: "staging", publish } — duplicate, write, verify,
 * publish/cleanup. Everything is mocked (themes API, credentials, applyEntries,
 * Supabase, processPage) — no network, no LLM, no live Shopify.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PageResult } from "@/lib/crawl/types";

vi.mock("@/lib/crawl/process-page", () => ({ processPage: vi.fn() }));

// Supabase capture (getSiteRow only — staging tests run persistAudit:false).
const h = vi.hoisted(() => {
  const state = {
    site: { domain: "shop.com", shop_domain: "shop.myshopify.com" } as {
      domain: string;
      shop_domain: string | null;
    },
  };
  const client = {
    from() {
      return {
        insert() {
          return {
            select: () => ({ single: async () => ({ data: { id: "run-1" }, error: null }) }),
            then: (resolve: (v: { error: unknown }) => void) => resolve({ error: null }),
          };
        },
        select() {
          const builder = {
            eq: () => builder,
            single: async () => ({ data: state.site, error: null }),
            then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
          };
          return builder;
        },
        update() {
          return { eq: async () => ({ error: null }) };
        },
      };
    },
  };
  return { state, createAdminClient: vi.fn(() => client) };
});
vi.mock("@/lib/supabase", () => ({ createAdminClient: h.createAdminClient }));

// The L6 judge never runs (judge:false default) but is mocked so no import can reach out.
const judgeMock = vi.hoisted(() => ({ fn: vi.fn(async () => ({ passed: true, detail: "ok" })) }));
vi.mock("../judge", () => ({ l6Judge: judgeMock.fn }));

// Live apply mechanics live in apply.test.ts — here applyEntries is a mock whose
// return value drives the publish/cleanup branches.
const applyMock = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../apply", () => ({
  applyEntries: applyMock.fn,
  makeShopifyOps: vi.fn(() => ({})),
}));

vi.mock("@/lib/shopify/config", () => ({
  getShopifyConfig: () => ({ shop: "shop.myshopify.com", apiVersion: "2025-01", baseUrl: "x" }),
  normalizeShop: (s: string) => s,
}));

// Storefront password handling: behave as "no password configured" (deterministic).
vi.mock("@/lib/shopify/storefront-password", () => ({
  getStorefrontCookie: vi.fn(async () => null),
  isStorefrontPasswordConfigured: vi.fn(() => false),
  looksPasswordGated: vi.fn(() => false),
}));

// Themes API (issue #26 surface) — fully mocked.
const themesMock = vi.hoisted(() => ({
  prepareStagingTheme: vi.fn(),
  themePublish: vi.fn(),
  themeDelete: vi.fn(),
  themesList: vi.fn(),
}));
vi.mock("@/lib/shopify/themes", () => themesMock);

// Per-site credentials (issue #25) — resolved once, threaded into every theme call.
const credsMock = vi.hoisted(() => ({
  resolveShopContext: vi.fn(async () => ({
    shop: "shop.myshopify.com",
    storefrontPassword: null,
  })),
}));
vi.mock("@/lib/shopify/credentials", () => credsMock);

import { processPage } from "@/lib/crawl/process-page";
import { runGoal } from "../run";
import type { AgentProgressEvent, Goal } from "../types";

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
const P1 = `${SHOP}/products/p1`;
const P2 = `${SHOP}/products/p2`;

function noSchema(url: string): PageResult {
  return {
    url,
    status: "no_schema",
    originalSchemas: null,
    fixedSchemas: null,
    validationResults: null,
  } as unknown as PageResult;
}

function optimize(url: string): PageResult {
  return {
    url,
    status: "valid",
    originalSchemas: null,
    fixedSchemas: [validProduct],
    validationResults: {
      errorCount: 0,
      warningCount: 0,
      schemas: [
        { type: "Product", original: {}, fixed: {}, validation: { valid: true }, fixesApplied: [] },
      ],
    },
  } as unknown as PageResult;
}

const goal: Goal = {
  siteId: "site-1",
  target: { scope: "url_list", urls: [P1, P2], requireTypes: ["Product"], minOutcome: "valid" },
  constraints: { allowSchemaTypeChange: false },
  autonomy: "auto_apply",
};

const STAGING_ID = 777;
const SOURCE_ID = 111;
const PREVIEW = `https://shop.myshopify.com/?preview_theme_id=${STAGING_ID}`;

beforeEach(() => {
  vi.clearAllMocks();
  h.state.site = { domain: "shop.com", shop_domain: "shop.myshopify.com" };
  credsMock.resolveShopContext.mockResolvedValue({
    shop: "shop.myshopify.com",
    storefrontPassword: null,
  });
  mockProcess.mockImplementation(async (url: string, mode: string) =>
    mode === "optimize" ? optimize(url) : noSchema(url)
  );
  applyMock.fn.mockResolvedValue({
    status: "applied",
    writeTarget: String(STAGING_ID),
    l4: [],
    actions: [],
  });
  themesMock.prepareStagingTheme.mockResolvedValue({
    stagingThemeId: STAGING_ID,
    previewUrl: PREVIEW,
    sourceThemeId: SOURCE_ID,
  });
  themesMock.themePublish.mockResolvedValue(undefined);
  themesMock.themeDelete.mockResolvedValue(undefined);
  themesMock.themesList.mockResolvedValue([]);
  process.env.SHOPIFY_TEST_THEME_ID = "999";
});

describe("runGoal staging write strategy (issue #26)", () => {
  it("staging + publish happy path: duplicate → write to duplicate → publish", async () => {
    const events: AgentProgressEvent[] = [];
    const result = await runGoal(goal, {
      dryRun: false,
      persistAudit: false,
      writeTheme: { mode: "staging", publish: true },
      onProgress: (ev) => events.push(ev),
    });

    // One duplicate, and the apply wrote to IT — never the env theme.
    expect(themesMock.prepareStagingTheme).toHaveBeenCalledTimes(1);
    expect(applyMock.fn).toHaveBeenCalledTimes(1);
    expect(applyMock.fn.mock.calls[0][0].themeId).toBe(STAGING_ID);

    // The verified duplicate was swapped live, with the displaced theme on record.
    expect(themesMock.themePublish).toHaveBeenCalledTimes(1);
    expect(themesMock.themePublish.mock.calls[0][0]).toBe(STAGING_ID);
    const publishRow = result.actions.find((a) => a.action === "publish");
    expect(publishRow?.outcome.startsWith("published:")).toBe(true);

    expect(result.status).toBe("done");
    expect(result.staging?.published).toBe(true);
    expect(result.staging?.rollbackThemeId).toBe(SOURCE_ID);
    expect(result.staging?.stagingThemeId).toBe(STAGING_ID);

    // Progress: the preview URL goes out on "stage" the moment the duplicate exists,
    // and the swap announces itself on "publish".
    expect(events.some((e) => e.phase === "stage" && e.previewUrl === PREVIEW)).toBe(true);
    expect(events.some((e) => e.phase === "publish")).toBe(true);
  });

  it("rolled_back apply: nothing published, the evidence-free duplicate is deleted", async () => {
    applyMock.fn.mockResolvedValue({
      status: "rolled_back",
      writeTarget: String(STAGING_ID),
      l4: [{ passed: false, detail: "no JSON-LD rendered" }],
      actions: [],
    });

    const result = await runGoal(goal, {
      dryRun: false,
      persistAudit: false,
      writeTheme: { mode: "staging", publish: true },
    });

    expect(themesMock.themePublish).not.toHaveBeenCalled();
    expect(themesMock.themeDelete).toHaveBeenCalledTimes(1);
    expect(themesMock.themeDelete.mock.calls[0][0]).toBe(STAGING_ID);
    expect(result.staging?.deleted).toBe(true);
    expect(result.staging?.published).toBe(false);
    expect(result.status).toBe("rolled_back");
  });

  it("paged apply: the staging theme is forensic evidence — NEVER deleted", async () => {
    applyMock.fn.mockResolvedValue({
      status: "paged",
      writeTarget: String(STAGING_ID),
      l4: [{ passed: false }],
      actions: [],
      error: "Shopify 500 on restore",
    });

    const result = await runGoal(goal, {
      dryRun: false,
      persistAudit: false,
      writeTheme: { mode: "staging", publish: true },
    });

    expect(themesMock.themeDelete).not.toHaveBeenCalled();
    expect(themesMock.themePublish).not.toHaveBeenCalled();
    expect(result.status).toBe("paged");
  });

  it("publish:false: applied but left unpublished for merchant review", async () => {
    const result = await runGoal(goal, {
      dryRun: false,
      persistAudit: false,
      writeTheme: { mode: "staging", publish: false },
    });

    expect(result.apply?.status).toBe("applied");
    expect(themesMock.themePublish).not.toHaveBeenCalled();
    expect(result.staging?.published).toBe(false);
    expect(result.staging?.stagingThemeId).toBe(STAGING_ID);
  });

  it("default env mode: no staging theme is ever prepared", async () => {
    const result = await runGoal(goal, { dryRun: false, persistAudit: false });

    expect(themesMock.prepareStagingTheme).not.toHaveBeenCalled();
    expect(applyMock.fn.mock.calls[0][0].themeId).toBe(999); // env SHOPIFY_TEST_THEME_ID
    expect(result.staging ?? null).toBeNull();
  });

  it("themePublish throws: run completes, publish_failed merchant action, unpublished", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    themesMock.themePublish.mockRejectedValue(new Error("swap rejected"));

    const result = await runGoal(goal, {
      dryRun: false,
      persistAudit: false,
      writeTheme: { mode: "staging", publish: true },
    });

    const row = result.actions.find((a) => a.action === "merchant_action");
    expect(row?.outcome.startsWith("publish_failed:")).toBe(true);
    expect(row?.outcome).toContain("swap rejected");
    expect(result.staging?.published).toBe(false);
    // The verified staging theme is intact — never deleted on a failed swap.
    expect(themesMock.themeDelete).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
