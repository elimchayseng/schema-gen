import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PageResult } from "@/lib/crawl/types";

vi.mock("@/lib/crawl/process-page", () => ({ processPage: vi.fn() }));

// Supabase capture (used by the persist-audit test; unused when persistAudit:false).
const h = vi.hoisted(() => {
  const state = {
    inserts: [] as { table: string; payload: Record<string, unknown> }[],
    updates: [] as { table: string; payload: Record<string, unknown> }[],
    // Rows returned by loadCommittedUrls' select().eq()... query (resume).
    committed: [] as { url: string }[],
  };
  const client = {
    from(table: string) {
      return {
        insert(payload: Record<string, unknown>) {
          state.inserts.push({ table, payload });
          return {
            select: () => ({ single: async () => ({ data: { id: "run-1" }, error: null }) }),
            then: (resolve: (v: { error: unknown }) => void) => resolve({ error: null }),
          };
        },
        select() {
          const builder = {
            eq: () => builder,
            then: (resolve: (v: unknown) => void) =>
              resolve({ data: state.committed, error: null }),
          };
          return builder;
        },
        update(payload: Record<string, unknown>) {
          state.updates.push({ table, payload });
          return { eq: async () => ({ error: null }) };
        },
      };
    },
  };
  return { state, createAdminClient: vi.fn(() => client) };
});
vi.mock("@/lib/supabase", () => ({ createAdminClient: h.createAdminClient }));

// Live apply is exercised through a mocked applyEntries — run.test owns the run
// ORCHESTRATION (breaker threading, status mapping, dry-run gating); apply.test owns
// the write/rollback mechanics. makeShopifyOps is stubbed (no real Asset API).
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
const A = `${SHOP}/products/a`; // already valid -> skip
const B = `${SHOP}/products/b`; // errors -> fix
const C = `${SHOP}/products/c`; // no_schema -> generate
const D = `${SHOP}/products/d`; // warnings -> fix
const E = `${SHOP}/products/e`; // no_schema -> generate

function vr(valid: boolean, errorCount: number, warningCount = 0) {
  return {
    errorCount,
    warningCount,
    schemas: [
      {
        type: "Product",
        original: {},
        fixed: {},
        validation: { valid },
        fixesApplied: [],
      },
    ],
  };
}

function scan(url: string): PageResult {
  switch (url) {
    case A:
      return { url, status: "valid", originalSchemas: [validProduct], fixedSchemas: [validProduct], validationResults: vr(true, 0) } as unknown as PageResult;
    case B:
      return { url, status: "errors", originalSchemas: [{ "@type": "Product" }], fixedSchemas: [{ "@type": "Product" }], validationResults: vr(false, 3) } as unknown as PageResult;
    case D:
      return { url, status: "warnings", originalSchemas: [validProduct], fixedSchemas: [validProduct], validationResults: vr(true, 0, 2) } as unknown as PageResult;
    default: // C, E
      return { url, status: "no_schema", originalSchemas: null, fixedSchemas: null, validationResults: null } as unknown as PageResult;
  }
}

function optimize(url: string): PageResult {
  return {
    url,
    status: "valid",
    originalSchemas: [{ "@type": "Product" }],
    fixedSchemas: [validProduct],
    validationResults: vr(true, 0),
  } as unknown as PageResult;
}

const goal: Goal = {
  siteId: "site-1",
  target: { scope: "url_list", urls: [A, B, C, D, E], requireTypes: ["Product"], minOutcome: "valid" },
  constraints: { allowSchemaTypeChange: false },
  autonomy: "auto_apply",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.state.inserts = [];
  h.state.updates = [];
  h.state.committed = [];
  mockProcess.mockImplementation(async (url: string, mode: string) =>
    mode === "optimize" ? optimize(url) : scan(url)
  );
  applyMock.fn.mockReset();
  applyMock.fn.mockResolvedValue({
    status: "applied",
    writeTarget: "999",
    l4: [],
    actions: [],
  });
  process.env.SHOPIFY_TEST_THEME_ID = "999";
});

describe("runGoal (5-page fixture, dry-run)", () => {
  it("skips the already-valid page and brings the rest to all-valid", async () => {
    const result = await runGoal(goal, { persistAudit: false });

    expect(result.status).toBe("done");
    expect(result.skipped).toEqual([A]); // planner never queued the valid page
    expect(result.unsatisfied).toEqual([]);
    expect(result.satisfied).toEqual(expect.arrayContaining([A, B, C, D, E]));
    expect(result.pagesTouched).toBe(4);

    // one skip action + four executed (B,D fix; C,E generate)
    const byAction = (a: string) => result.actions.filter((x) => x.action === a);
    expect(byAction("skip")).toHaveLength(1);
    expect(byAction("fix")).toHaveLength(2);
    expect(byAction("generate")).toHaveLength(2);

    // staged snippet contains the generated product JSON-LD
    expect(result.stagedSnippet).toContain("Summer Collection Tee");

    // scan x5, optimize x4
    expect(mockProcess).toHaveBeenCalledTimes(9);
  });

  it("every executed action carries gate results", async () => {
    const result = await runGoal(goal, { persistAudit: false });
    const executed = result.actions.filter((a) => a.action !== "skip");
    expect(executed).toHaveLength(4);
    for (const a of executed) {
      expect(a.gates).not.toBeNull();
      expect(a.gates?.L1.passed).toBe(true);
    }
  });

  it("persists an agent_runs row and an agent_action per action", async () => {
    await runGoal(goal, { persistAudit: true });

    const runInserts = h.state.inserts.filter((i) => i.table === "agent_runs");
    const actionInserts = h.state.inserts.filter((i) => i.table === "agent_actions");
    expect(runInserts).toHaveLength(1);
    expect(actionInserts).toHaveLength(5); // 1 skip + 4 executed
    // executed actions persist their gates
    const withGates = actionInserts.filter((i) => i.payload.gates != null);
    expect(withGates).toHaveLength(4);
    // resolved target list persisted right after resolution (issue #27)…
    const resolvedUpdate = h.state.updates.find(
      (u) => u.table === "agent_runs" && "resolved_urls" in u.payload
    );
    expect(resolvedUpdate?.payload).toEqual({ resolved_urls: [A, B, C, D, E] });
    // …and the run finalized
    const runUpdate = h.state.updates.find(
      (u) => u.table === "agent_runs" && "status" in u.payload
    );
    expect(runUpdate?.payload).toMatchObject({ status: "done" });
  });

  it("dry-run never invokes the live apply", async () => {
    await runGoal(goal, { persistAudit: false });
    expect(applyMock.fn).not.toHaveBeenCalled();
  });

  it("degrades gracefully when audit is unavailable (best-effort)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.createAdminClient.mockImplementationOnce(() => {
      throw new Error("supabase unreachable");
    });

    const result = await runGoal(goal, { persistAudit: true });

    expect(result.status).toBe("done"); // analysis still completes
    expect(result.runId).toBeNull(); // audit degraded off
    expect(result.satisfied).toEqual(expect.arrayContaining([A, B, C, D, E]));
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ---- Phase 5 hardening ----

describe("runGoal Phase 5 hardening", () => {
  it("resume: a page already committed (l4_pass) is never re-processed", async () => {
    h.state.committed = [{ url: B }]; // B was committed live by a prior slice of this run

    const result = await runGoal(goal, { persistAudit: true }); // persistAudit → runId set

    // B is skipped entirely — neither scanned nor optimized.
    expect(mockProcess).not.toHaveBeenCalledWith(B, "scan");
    expect(mockProcess).not.toHaveBeenCalledWith(B, "optimize");
    // It still counts as satisfied/skipped and gets an audit row.
    expect(result.satisfied).toContain(B);
    expect(result.skipped).toContain(B);
    expect(
      result.actions.some((a) => a.url === B && a.outcome === "already_committed")
    ).toBe(true);
    // Only A,C,D,E were perceived; C,D,E acted on (A is already valid → planner skip).
    expect(result.pagesTouched).toBe(3);
    expect(result.status).toBe("done");
  });

  it("resume is inert for a fresh run (no committed rows → behaves as before)", async () => {
    const result = await runGoal(goal, { persistAudit: false }); // no runId → no lookup
    expect(result.pagesTouched).toBe(4);
    expect(result.satisfied).toEqual(expect.arrayContaining([A, B, C, D, E]));
  });

  it("concurrency: never runs more than `concurrency` processPage calls at once", async () => {
    let active = 0;
    let maxActive = 0;
    mockProcess.mockImplementation(async (url: string, mode: string) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 0)); // hold the slot open across a tick
      active--;
      return mode === "optimize" ? optimize(url) : scan(url);
    });

    await runGoal(goal, { persistAudit: false, concurrency: 2 });

    expect(maxActive).toBeGreaterThan(1); // actually parallelized
    expect(maxActive).toBeLessThanOrEqual(2); // but never above the cap
  });

});

// ---- Phase 3 live path ----

const P1 = `${SHOP}/products/p1`;
const P2 = `${SHOP}/products/p2`;
const P3 = `${SHOP}/products/p3`;

const liveGoal: Goal = {
  siteId: "site-1",
  target: { scope: "url_list", urls: [P1, P2, P3], requireTypes: ["Product"], minOutcome: "valid" },
  constraints: { allowSchemaTypeChange: false },
  autonomy: "auto_apply",
};

/** An optimize result whose candidate is an INVALID Product → gates L1 fail. */
function failingOptimize(url: string): PageResult {
  return {
    url,
    status: "errors",
    originalSchemas: null,
    fixedSchemas: [{ "@type": "Product" }], // missing required fields → invalid
    validationResults: vr(false, 4),
  } as unknown as PageResult;
}

describe("runGoal Phase 3 live apply", () => {
  it("dryRun:false with all pages valid → invokes apply, status done, targets SHOPIFY_TEST_THEME_ID", async () => {
    const result = await runGoal(liveGoal, { dryRun: false, persistAudit: false });

    expect(applyMock.fn).toHaveBeenCalledTimes(1);
    const passed = applyMock.fn.mock.calls[0][0];
    expect(passed.themeId).toBe(999); // wrote to the test theme, never the published one
    expect(passed.items).toHaveLength(3);
    expect(result.status).toBe("done");
    expect(result.apply?.status).toBe("applied");
  });

  it("L4 rollback → run status rolled_back, run continues (no throw)", async () => {
    applyMock.fn.mockResolvedValue({
      status: "rolled_back",
      writeTarget: "999",
      l4: [{ passed: false, detail: "no JSON-LD rendered" }],
      actions: [
        { url: P1, action: "rollback", schemaBefore: null, schemaAfter: null, gates: null, outcome: "rolled_back: L4 failed" },
      ],
    });

    const result = await runGoal(liveGoal, { dryRun: false, persistAudit: false });
    expect(result.status).toBe("rolled_back");
    expect(result.actions.some((a) => a.action === "rollback")).toBe(true);
  });

  it("rollback-failure → run status paged, error surfaced", async () => {
    applyMock.fn.mockResolvedValue({
      status: "paged",
      writeTarget: "999",
      l4: [{ passed: false }],
      actions: [],
      error: "Shopify 500 on restore",
    });

    const result = await runGoal(liveGoal, { dryRun: false, persistAudit: false });
    expect(result.status).toBe("paged");
  });

  it("consecutive-failure breaker halts mid-loop, no apply (same halt path the cost breaker uses)", async () => {
    mockProcess.mockImplementation(async (url: string, mode: string) =>
      mode === "optimize" ? failingOptimize(url) : ({
        url, status: "no_schema", originalSchemas: null, fixedSchemas: null, validationResults: null,
      } as unknown as PageResult)
    );

    const result = await runGoal(liveGoal, {
      dryRun: false,
      persistAudit: false,
      breakers: { maxConsecutiveFailures: 3 },
    });

    expect(result.haltedBy).toBe("consecutive_failures");
    expect(result.status).toBe("failed");
    expect(applyMock.fn).not.toHaveBeenCalled(); // halted before apply
    expect(result.pagesTouched).toBe(3);
  });

  it("dryRun:false with a bad/missing test theme id throws (never targets published)", async () => {
    delete process.env.SHOPIFY_TEST_THEME_ID;
    await expect(
      runGoal(liveGoal, { dryRun: false, persistAudit: false })
    ).rejects.toThrow(/SHOPIFY_TEST_THEME_ID/);
  });
});
