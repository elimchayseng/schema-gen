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
    // Rows returned to loadCommittedUrls (resume). Empty by default.
    committed: [] as { url: string }[],
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
            then: (resolve: (v: unknown) => void) =>
              resolve({ data: state.committed, error: null }),
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

// Themes API (issue #26 surface) — fully mocked. assertSafeWriteTheme is a no-op
// here: the guard's role/existence checks are unit-tested in themes.test.ts.
const themesMock = vi.hoisted(() => ({
  prepareStagingTheme: vi.fn(),
  themePublish: vi.fn(),
  themeDelete: vi.fn(),
  themesList: vi.fn(),
  assertSafeWriteTheme: vi.fn(),
}));
vi.mock("@/lib/shopify/themes", () => ({
  ...themesMock,
  MANAGED_STAGING_PREFIX: "SchemaGen Staging",
}));

// Post-publish verification (post-publish.ts) — mocked so the publish path never
// fetches the real storefront; its verdict drives the auto-rollback branches.
const postPublishMock = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../post-publish", () => ({ postPublishVerify: postPublishMock.fn }));

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
  h.state.committed = [];
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
  postPublishMock.fn.mockResolvedValue({
    status: "verified",
    pages: [
      { url: P1, status: "pass", attempts: 1 },
      { url: P2, status: "pass", attempts: 1 },
    ],
  });
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

    // Post-publish verification ran against the REAL urls with the staged blocks
    // as the freshness proof, and its verdict landed on the staging outcome.
    expect(postPublishMock.fn).toHaveBeenCalledTimes(1);
    const ppInput = postPublishMock.fn.mock.calls[0][0];
    expect(ppInput.pages.map((p: { url: string }) => p.url)).toEqual([P1, P2]);
    expect(ppInput.pages[0].expectBlocks).toBeDefined();
    expect(result.staging?.postPublish?.status).toBe("verified");
    const ppRow = result.actions.find(
      (a) => a.action === "verify" && a.outcome === "post_publish:verified"
    );
    expect(ppRow).toBeDefined();

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
    // Nothing went live, so there is nothing to post-publish verify.
    expect(postPublishMock.fn).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("post-publish FAILED: the displaced theme is republished (auto-rollback), run is rolled_back", async () => {
    postPublishMock.fn.mockResolvedValue({
      status: "failed",
      pages: [
        { url: P1, status: "fail", detail: "duplicate schema: 2 valid 'Product' blocks", attempts: 1 },
        { url: P2, status: "pass", attempts: 1 },
      ],
    });

    const result = await runGoal(goal, {
      dryRun: false,
      persistAudit: false,
      writeTheme: { mode: "staging", publish: true },
    });

    // First publish swapped staging live; the rollback republished the SOURCE.
    expect(themesMock.themePublish).toHaveBeenCalledTimes(2);
    expect(themesMock.themePublish.mock.calls[0][0]).toBe(STAGING_ID);
    expect(themesMock.themePublish.mock.calls[1][0]).toBe(SOURCE_ID);

    expect(result.status).toBe("rolled_back");
    expect(result.staging?.published).toBe(false);
    expect(result.staging?.postPublish?.status).toBe("failed");
    expect(result.staging?.postPublish?.rolledBack).toBe(true);
    const rb = result.actions.find(
      (a) => a.action === "rollback" && a.outcome.startsWith("post_publish_rollback:")
    );
    expect(rb?.outcome).toContain(String(SOURCE_ID));
    // The failing staging theme is evidence — never deleted.
    expect(themesMock.themeDelete).not.toHaveBeenCalled();
  });

  it("resume does NOT trust a staging l4_pass: a 'committed' page is still re-processed (#33)", async () => {
    // A prior slice of this run recorded l4_pass for P1 — but in staging mode that
    // passed against the STAGING theme's preview, not the live store. If that run
    // never published, P1 isn't live; resume must re-process it, not skip it.
    h.state.committed = [{ url: P1 }];

    await runGoal(goal, {
      dryRun: false,
      persistAudit: true, // → runId set → resume lookup runs
      writeTheme: { mode: "staging", publish: true },
    });

    // P1 is re-scanned, not skipped (env-only resume-skip).
    const scannedP1 = mockProcess.mock.calls.some(
      (c) => c[0] === P1 && c[1] === "scan"
    );
    expect(scannedP1).toBe(true);
  });

  it("post-publish FAILED but the live theme changed since our publish: republish is SKIPPED (#33)", async () => {
    postPublishMock.fn.mockResolvedValue({
      status: "failed",
      pages: [{ url: P1, status: "fail", detail: "duplicate schema", attempts: 1 }],
    });
    // Between our swap and the post-publish check, someone published a DIFFERENT
    // theme — so the current live theme is no longer our staging theme.
    const OTHER_LIVE = 999;
    themesMock.themesList.mockResolvedValue([
      { id: OTHER_LIVE, role: "main", name: "Someone else's theme" },
    ]);

    const result = await runGoal(goal, {
      dryRun: false,
      persistAudit: false,
      writeTheme: { mode: "staging", publish: true },
    });

    // Only the original swap published; we must NOT republish the stale source
    // (that would demote the newer live theme OTHER_LIVE).
    expect(themesMock.themePublish).toHaveBeenCalledTimes(1);
    expect(themesMock.themePublish.mock.calls[0][0]).toBe(STAGING_ID);
    expect(themesMock.themePublish).not.toHaveBeenCalledWith(SOURCE_ID, expect.anything());

    const skipped = result.actions.find(
      (a) =>
        a.action === "merchant_action" &&
        a.outcome.startsWith("post_publish_rollback_skipped:live_theme_changed:")
    );
    expect(skipped?.outcome).toContain(String(OTHER_LIVE));
    expect(result.staging?.postPublish?.rolledBack).toBe(false);
  });

  it("post-publish FAILED and the republish also fails: paged, merchant told which theme to publish", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    postPublishMock.fn.mockResolvedValue({
      status: "failed",
      pages: [{ url: P1, status: "fail", detail: "no valid 'Product'", attempts: 2 }],
    });
    themesMock.themePublish
      .mockResolvedValueOnce(undefined) // the swap itself succeeds
      .mockRejectedValueOnce(new Error("republish 500")); // the undo fails

    const result = await runGoal(goal, {
      dryRun: false,
      persistAudit: false,
      writeTheme: { mode: "staging", publish: true },
    });

    expect(result.status).toBe("paged");
    expect(result.staging?.postPublish?.rolledBack).toBe(false);
    const row = result.actions.find(
      (a) => a.action === "merchant_action" && a.outcome.startsWith("post_publish_rollback_failed:")
    );
    expect(row?.outcome).toContain(String(SOURCE_ID));
    warnSpy.mockRestore();
  });

  it("post-publish STALE (cache didn't converge): publish stands, run is done, verdict surfaced", async () => {
    postPublishMock.fn.mockResolvedValue({
      status: "stale",
      pages: [{ url: P1, status: "stale", detail: "cache did not converge", attempts: 12 }],
    });

    const result = await runGoal(goal, {
      dryRun: false,
      persistAudit: false,
      writeTheme: { mode: "staging", publish: true },
    });

    // Inconclusive is NOT failure: no republish, the swap stands.
    expect(themesMock.themePublish).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("done");
    expect(result.staging?.published).toBe(true);
    expect(result.staging?.postPublish?.status).toBe("stale");
  });

  it("post-publish verifier crash: publish stands (no rollback on zero evidence)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    postPublishMock.fn.mockRejectedValue(new Error("verifier exploded"));

    const result = await runGoal(goal, {
      dryRun: false,
      persistAudit: false,
      writeTheme: { mode: "staging", publish: true },
    });

    expect(themesMock.themePublish).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("done");
    expect(result.staging?.published).toBe(true);
    expect(result.staging?.postPublish?.status).toBe("stale");
    const row = result.actions.find(
      (a) => a.action === "verify" && a.outcome.startsWith("post_publish:error:")
    );
    expect(row?.outcome).toContain("verifier exploded");
    warnSpy.mockRestore();
  });

  it("publish:false: post-publish verification never runs", async () => {
    await runGoal(goal, {
      dryRun: false,
      persistAudit: false,
      writeTheme: { mode: "staging", publish: false },
    });
    expect(postPublishMock.fn).not.toHaveBeenCalled();
  });
});
