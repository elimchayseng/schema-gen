import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    inserts: [] as { table: string; payload: Record<string, unknown> }[],
    updates: [] as { table: string; payload: Record<string, unknown> }[],
    singleResult: { data: { id: "run-xyz" } as unknown, error: null as unknown },
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

import { createRun, finishRun, recordAction } from "../audit";
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
