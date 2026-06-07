import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PageResult } from "@/lib/crawl/types";

vi.mock("@/lib/crawl/process-page", () => ({ processPage: vi.fn() }));

// Supabase capture (used by the persist-audit test; unused when persistAudit:false).
const h = vi.hoisted(() => {
  const state = {
    inserts: [] as { table: string; payload: Record<string, unknown> }[],
    updates: [] as { table: string; payload: Record<string, unknown> }[],
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
  mockProcess.mockImplementation(async (url: string, mode: string) =>
    mode === "optimize" ? optimize(url) : scan(url)
  );
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
    // run finalized
    const runUpdate = h.state.updates.find((u) => u.table === "agent_runs");
    expect(runUpdate?.payload).toMatchObject({ status: "done" });
  });

  it("refuses live apply (dryRun: false) — that is Phase 3", async () => {
    await expect(runGoal(goal, { dryRun: false })).rejects.toThrow(/Phase 3/);
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
