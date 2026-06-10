import { describe, it, expect, vi, beforeEach } from "vitest";

// Thenable proxy chain that resolves `value` for any query terminator (.single(), await, etc.)
function chain(value: unknown) {
  const self = (): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") return (resolve: (v: unknown) => void) => resolve(value);
          return () => self();
        },
      }
    );
  return self();
}

function mockSupabase(opts: { user?: { id: string } | null; site?: unknown }) {
  const { user = { id: "user-1" }, site = { id: "site-1" } } = opts;
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) },
    from: (table: string) =>
      table === "sites"
        ? chain({ data: site, error: site ? null : { message: "not found" } })
        : chain({ data: null, error: null }),
  };
}

vi.mock("@/lib/supabase-server", () => ({ createSupabaseServerClient: vi.fn() }));
const agentMock = vi.hoisted(() => ({
  runGoal: vi.fn(),
  createRun: vi.fn(),
  readControl: vi.fn(),
  setControl: vi.fn(),
}));
vi.mock("@/lib/agent", () => agentMock);

import { createSupabaseServerClient } from "@/lib/supabase-server";
import { POST } from "../route";

const mockCreateSupabase = vi.mocked(createSupabaseServerClient);

function req(body: unknown) {
  return new Request("http://localhost/api/agent/run", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function drain(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

const goodBody = {
  siteId: "site-1",
  target: { scope: "all_products", requireTypes: ["Product"], minOutcome: "valid" },
};

beforeEach(() => {
  vi.clearAllMocks();
  agentMock.createRun.mockResolvedValue("run-1");
  agentMock.readControl.mockResolvedValue("run");
  agentMock.runGoal.mockResolvedValue({
    runId: "run-1",
    status: "done",
    iterations: 1,
    pagesTouched: 1,
    satisfied: ["https://x/products/a"],
    unsatisfied: [],
    skipped: [],
    stagedSnippet: "<!-- snippet -->",
    apply: null,
    killed: false,
    actions: [],
  });
});

describe("POST /api/agent/run", () => {
  it("401 when unauthenticated", async () => {
    mockCreateSupabase.mockResolvedValue(mockSupabase({ user: null }) as never);
    const res = await POST(req(goodBody));
    expect(res.status).toBe(401);
    expect(agentMock.runGoal).not.toHaveBeenCalled();
  });

  it("404 when the site is not owned by the user", async () => {
    mockCreateSupabase.mockResolvedValue(mockSupabase({ site: null }) as never);
    const res = await POST(req(goodBody));
    expect(res.status).toBe(404);
    expect(agentMock.runGoal).not.toHaveBeenCalled();
  });

  it("400 when target.scope is missing/invalid", async () => {
    mockCreateSupabase.mockResolvedValue(mockSupabase({}) as never);
    const res = await POST(req({ siteId: "site-1", target: { requireTypes: ["Product"] } }));
    expect(res.status).toBe(400);
  });

  it("400 when requireTypes is empty for a non-site scope (pre-existing contract)", async () => {
    mockCreateSupabase.mockResolvedValue(mockSupabase({}) as never);
    const res = await POST(
      req({ siteId: "site-1", target: { scope: "all_products", requireTypes: [] } })
    );
    expect(res.status).toBe(400);
  });

  it("accepts scope 'site' without requireTypes (issue #28: matrix-driven)", async () => {
    mockCreateSupabase.mockResolvedValue(mockSupabase({}) as never);
    const res = await POST(
      req({
        siteId: "site-1",
        target: { scope: "site", minOutcome: "rich_results_eligible" },
      })
    );
    expect(res.status).toBe(200);
    await drain(res);
    expect(agentMock.runGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          scope: "site",
          requireTypes: [],
          minOutcome: "rich_results_eligible",
        }),
      }),
      expect.anything()
    );
  });

  it("streams SSE and forwards onProgress events", async () => {
    mockCreateSupabase.mockResolvedValue(mockSupabase({}) as never);
    agentMock.runGoal.mockImplementation(async (_goal, optsArg) => {
      const o = optsArg as { onProgress?: (e: unknown) => void };
      o.onProgress?.({ phase: "perceive", runId: "run-1", perceived: 1 });
      o.onProgress?.({ phase: "act", url: "https://x/products/a" });
      return {
        runId: "run-1", status: "done", iterations: 1, pagesTouched: 1,
        satisfied: [], unsatisfied: [], skipped: [], stagedSnippet: null,
        apply: null, killed: false, actions: [],
      };
    });

    const res = await POST(req(goodBody));
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const text = await drain(res);
    expect(text).toContain('"phase":"perceive"');
    expect(text).toContain('"phase":"act"');
    expect(text).toContain('"step":"done"'); // terminal event
  });

  it("honors dryRun:false end to end (passes it to runGoal)", async () => {
    mockCreateSupabase.mockResolvedValue(mockSupabase({}) as never);
    const res = await POST(req({ ...goodBody, dryRun: false }));
    await drain(res);
    expect(agentMock.createRun).toHaveBeenCalledTimes(1);
    expect(agentMock.runGoal).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "site-1" }),
      expect.objectContaining({ dryRun: false, runId: "run-1" })
    );
  });

  it("defaults to dryRun:true when omitted", async () => {
    mockCreateSupabase.mockResolvedValue(mockSupabase({}) as never);
    const res = await POST(req(goodBody));
    await drain(res);
    expect(agentMock.runGoal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dryRun: true })
    );
  });
});
