import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PageResult } from "@/lib/crawl/types";
import type { AgentProgressEvent } from "../types";

vi.mock("@/lib/crawl/process-page", () => ({ processPage: vi.fn() }));

// Supabase capture — lets us assert createRun is (not) called when a runId is supplied.
const h = vi.hoisted(() => {
  const state = {
    inserts: [] as { table: string; payload: Record<string, unknown> }[],
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
        update() {
          return { eq: async () => ({ error: null }) };
        },
      };
    },
  };
  return { state, createAdminClient: vi.fn(() => client) };
});
vi.mock("@/lib/supabase", () => ({ createAdminClient: h.createAdminClient }));

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

function vr(valid: boolean, errorCount: number) {
  return {
    errorCount,
    warningCount: 0,
    schemas: [
      { type: "Product", original: {}, fixed: {}, validation: { valid }, fixesApplied: [] },
    ],
  };
}

function scan(url: string): PageResult {
  if (url === A) {
    return { url, status: "valid", originalSchemas: [validProduct], fixedSchemas: [validProduct], validationResults: vr(true, 0) } as unknown as PageResult;
  }
  return { url, status: "errors", originalSchemas: [{ "@type": "Product" }], fixedSchemas: [{ "@type": "Product" }], validationResults: vr(false, 3) } as unknown as PageResult;
}

function optimize(url: string): PageResult {
  return { url, status: "valid", originalSchemas: [{ "@type": "Product" }], fixedSchemas: [validProduct], validationResults: vr(true, 0) } as unknown as PageResult;
}

const goal: Goal = {
  siteId: "site-1",
  target: { scope: "url_list", urls: [A, B], requireTypes: ["Product"], minOutcome: "valid" },
  constraints: { allowSchemaTypeChange: false },
  autonomy: "auto_apply",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.state.inserts = [];
  mockProcess.mockImplementation(async (url: string, mode: string) =>
    mode === "optimize" ? optimize(url) : scan(url)
  );
  applyMock.fn.mockReset();
  applyMock.fn.mockResolvedValue({ status: "applied", writeTarget: "999", l4: [], actions: [] });
  process.env.SHOPIFY_TEST_THEME_ID = "999";
});

describe("runGoal progress streaming (Phase 4)", () => {
  it("emits events in phase order: perceive* -> plan -> act* -> done", async () => {
    const events: AgentProgressEvent[] = [];
    await runGoal(goal, { persistAudit: false, onProgress: (e) => events.push(e) });

    const phases = events.map((e) => e.phase);
    // first event is a perceive init; plan comes after all perceive; done is last.
    expect(phases[0]).toBe("perceive");
    expect(phases[phases.length - 1]).toBe("done");

    const planIdx = phases.indexOf("plan");
    const firstActIdx = phases.indexOf("act");
    const lastPerceiveIdx = phases.lastIndexOf("perceive");
    expect(planIdx).toBeGreaterThan(lastPerceiveIdx); // plan after perceive completes
    expect(firstActIdx).toBeGreaterThan(planIdx); // act after plan
    // One queued page (B) = two act events under the uniform step contract:
    // "act.page start" (page announced before the LLM batch) then the completion.
    const acts = events.filter((e) => e.phase === "act");
    expect(acts).toHaveLength(2);
    expect(acts[0]?.status).toBe("start");
    expect(acts[1]?.status).toBe("ok");
  });

  it("streams the resolved target total on the first perceive event (#15)", async () => {
    const events: AgentProgressEvent[] = [];
    await runGoal(goal, { persistAudit: false, onProgress: (e) => events.push(e) });

    // The init perceive event carries targetTotal BEFORE any per-URL scan, so the
    // UI can account for pages a mid-perceive kill never reaches.
    const init = events.find((e) => e.phase === "perceive" && e.targetTotal != null);
    expect(init).toBeDefined();
    expect(init?.targetTotal).toBe(2); // goal resolves to A + B
    // It precedes the first per-URL perceive event.
    const initIdx = events.indexOf(init!);
    const firstUrlPerceive = events.findIndex((e) => e.phase === "perceive" && e.url);
    expect(initIdx).toBeLessThan(firstUrlPerceive);
  });

  it("act events carry gate results and running counts", async () => {
    const events: AgentProgressEvent[] = [];
    await runGoal(goal, { persistAudit: false, onProgress: (e) => events.push(e) });

    // The completion event (status ok/fail) carries gates; the "start" one does not.
    const act = events.find((e) => e.phase === "act" && e.status !== "start");
    expect(act?.url).toBe(B);
    expect(act?.gates).not.toBeNull();
    expect(act?.gates?.L1.passed).toBe(true);
    expect(act?.acted).toBe(1);
    // Phase 7: the act event carries the executor outcome so the UI can show WHY a page
    // ended up where it did, live, without hovering. B optimizes to a valid Product -> staged.
    expect(act?.outcome).toBe("staged");
  });

  it("a throwing onProgress never aborts the run", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await runGoal(goal, {
      persistAudit: false,
      onProgress: () => {
        throw new Error("sink exploded");
      },
    });
    expect(result.status).toBe("done");
    expect(result.satisfied).toEqual(expect.arrayContaining([A, B]));
    warnSpy.mockRestore();
  });

  it("uses a caller-supplied runId without creating its own agent_runs row", async () => {
    const events: AgentProgressEvent[] = [];
    const result = await runGoal(goal, {
      runId: "run-from-route",
      persistAudit: true,
      onProgress: (e) => events.push(e),
    });

    expect(result.runId).toBe("run-from-route");
    // createRun inserts into agent_runs; with a supplied id it must NOT run.
    expect(h.state.inserts.filter((i) => i.table === "agent_runs")).toHaveLength(0);
    // the first event carries the runId so the client can target the control route.
    expect(events[0]?.runId).toBe("run-from-route");
  });
});
