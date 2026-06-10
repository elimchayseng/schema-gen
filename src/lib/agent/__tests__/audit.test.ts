import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    inserts: [] as { table: string; payload: Record<string, unknown> }[],
    updates: [] as { table: string; payload: Record<string, unknown> }[],
    singleResult: { data: { id: "run-xyz" } as unknown, error: null as unknown },
    // Result of a select().eq()...  query (loadCommittedUrls). eqs records the filters.
    selectResult: { data: [] as unknown, error: null as unknown },
    eqs: [] as { col: string; val: unknown }[],
  };
  const client = {
    from(table: string) {
      return {
        insert(payload: Record<string, unknown>) {
          state.inserts.push({ table, payload });
          return {
            select: () => ({ single: async () => state.singleResult }),
            then: (resolve: (v: { error: unknown }) => void) =>
              resolve({ error: null }),
          };
        },
        select() {
          const builder = {
            eq(col: string, val: unknown) {
              state.eqs.push({ col, val });
              return builder;
            },
            then(resolve: (v: unknown) => void) {
              resolve(state.selectResult);
            },
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

import {
  createRun,
  finishRun,
  loadCommittedUrls,
  recordAction,
  saveResolvedUrls,
} from "../audit";
import type { ActionRecord, Goal } from "../types";

const goal: Goal = {
  siteId: "site-1",
  target: { scope: "url_list", urls: ["/a"], requireTypes: ["Product"], minOutcome: "valid" },
  constraints: { allowSchemaTypeChange: false },
  autonomy: "auto_apply",
};

describe("audit", () => {
  beforeEach(() => {
    h.state.inserts = [];
    h.state.updates = [];
    h.state.singleResult = { data: { id: "run-xyz" }, error: null };
    h.state.selectResult = { data: [], error: null };
    h.state.eqs = [];
  });

  it("createRun inserts an agent_runs row and returns its id", async () => {
    const id = await createRun(goal);
    expect(id).toBe("run-xyz");
    const row = h.state.inserts.find((i) => i.table === "agent_runs");
    expect(row?.payload).toMatchObject({ site_id: "site-1", status: "running" });
    expect(row?.payload.goal).toEqual(goal);
  });

  it("createRun throws on a Supabase error", async () => {
    h.state.singleResult = { data: null, error: { message: "boom" } };
    await expect(createRun(goal)).rejects.toThrow(/Failed to create agent_run: boom/);
  });

  it("recordAction inserts an agent_actions row with gates", async () => {
    const action: ActionRecord = {
      url: "/products/x",
      action: "generate",
      schemaBefore: null,
      schemaAfter: [{ "@type": "Product" }],
      gates: { L0: { passed: true }, L1: { passed: true }, L2: null, L3: { passed: true } },
      outcome: "staged",
      writeTarget: null,
      costUsd: 0,
    };
    await recordAction("run-1", action);
    const row = h.state.inserts.find((i) => i.table === "agent_actions");
    expect(row?.payload).toMatchObject({
      run_id: "run-1",
      url: "/products/x",
      action: "generate",
      outcome: "staged",
    });
    expect(row?.payload.gates).toEqual(action.gates);
  });

  it("loadCommittedUrls returns the set of l4_pass verify URLs for a run", async () => {
    h.state.selectResult = {
      data: [{ url: "/products/a" }, { url: "/products/b" }],
      error: null,
    };
    const committed = await loadCommittedUrls("run-1");
    expect(committed).toEqual(new Set(["/products/a", "/products/b"]));
    // Filters on the run + the committed-signal (verify / l4_pass).
    expect(h.state.eqs).toEqual([
      { col: "run_id", val: "run-1" },
      { col: "action", val: "verify" },
      { col: "outcome", val: "l4_pass" },
    ]);
  });

  it("loadCommittedUrls degrades to an empty set on a query error (best-effort)", async () => {
    h.state.selectResult = { data: null, error: { message: "boom" } };
    const committed = await loadCommittedUrls("run-1");
    expect(committed).toEqual(new Set());
  });

  it("saveResolvedUrls writes the resolved target list onto the run row", async () => {
    await saveResolvedUrls("run-1", ["/products/a", "/products/b"]);
    const row = h.state.updates.find((u) => u.table === "agent_runs");
    expect(row?.payload).toEqual({ resolved_urls: ["/products/a", "/products/b"] });
  });

  it("finishRun updates the run row with status + ended_at", async () => {
    await finishRun("run-1", {
      status: "done",
      iterations: 1,
      pagesTouched: 4,
      costUsd: 0,
      error: null,
    });
    const row = h.state.updates.find((u) => u.table === "agent_runs");
    expect(row?.payload).toMatchObject({ status: "done", pages_touched: 4 });
    expect(row?.payload.ended_at).toBeTypeOf("string");
  });
});
