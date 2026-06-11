import { describe, it, expect, vi, beforeEach } from "vitest";

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

// Authed (user-scoped) client: auth + the sites ownership lookup.
function mockAuthed(opts: { user?: { id: string } | null; site?: unknown }) {
  const { user = { id: "user-1" }, site = { id: "site-1" } } = opts;
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) },
    from: (table: string) =>
      table === "sites" ? chain({ data: site }) : chain({ data: null }),
  };
}

// Admin (service-role) client: reads agent_runs / agent_actions.
function mockAdmin(opts: { run?: unknown; actions?: unknown[] }) {
  const { run = { id: "run-1", site_id: "site-1" }, actions = [] } = opts;
  return {
    from: (table: string) =>
      table === "agent_actions" ? chain({ data: actions }) : chain({ data: run }),
  };
}

vi.mock("@/lib/supabase-server", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ createAdminClient: vi.fn() }));
const agentMock = vi.hoisted(() => ({ setControl: vi.fn() }));
vi.mock("@/lib/agent", () => agentMock);

import { createSupabaseServerClient } from "@/lib/supabase-server";
import { createAdminClient } from "@/lib/supabase";
import { GET, POST } from "../route";

const mockAuthedClient = vi.mocked(createSupabaseServerClient);
const mockAdminClient = vi.mocked(createAdminClient);

const params = (id: string) => ({ params: Promise.resolve({ id }) });
function ctrlReq(body: unknown) {
  return new Request("http://localhost/api/agent/run/run-1", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  agentMock.setControl.mockResolvedValue(undefined);
  mockAdminClient.mockReturnValue(mockAdmin({}) as never);
});

describe("POST /api/agent/run/[id] (control)", () => {
  it("401 when unauthenticated", async () => {
    mockAuthedClient.mockResolvedValue(mockAuthed({ user: null }) as never);
    const res = await POST(ctrlReq({ control: "kill" }), params("run-1"));
    expect(res.status).toBe(401);
    expect(agentMock.setControl).not.toHaveBeenCalled();
  });

  it("404 when the run's site is not owned by the user", async () => {
    mockAuthedClient.mockResolvedValue(mockAuthed({ site: null }) as never);
    const res = await POST(ctrlReq({ control: "kill" }), params("run-1"));
    expect(res.status).toBe(404);
    expect(agentMock.setControl).not.toHaveBeenCalled();
  });

  it("kill maps to control='kill'", async () => {
    mockAuthedClient.mockResolvedValue(mockAuthed({}) as never);
    const res = await POST(ctrlReq({ control: "kill" }), params("run-1"));
    expect(res.status).toBe(200);
    expect(agentMock.setControl).toHaveBeenCalledWith("run-1", "kill");
  });

  it("400 on any non-kill control verb (pause/resume stubs were deleted)", async () => {
    mockAuthedClient.mockResolvedValue(mockAuthed({}) as never);
    for (const control of ["frobnicate", "pause", "resume"]) {
      const res = await POST(ctrlReq({ control }), params("run-1"));
      expect(res.status).toBe(400);
    }
    expect(agentMock.setControl).not.toHaveBeenCalled();
  });
});

describe("GET /api/agent/run/[id]", () => {
  it("returns the run row and its actions", async () => {
    mockAuthedClient.mockResolvedValue(mockAuthed({}) as never);
    mockAdminClient.mockReturnValue(
      mockAdmin({ run: { id: "run-1", site_id: "site-1", status: "running" }, actions: [{ id: "a1" }] }) as never
    );
    const res = await GET(new Request("http://localhost/api/agent/run/run-1"), params("run-1"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.run.id).toBe("run-1");
    expect(data.actions).toHaveLength(1);
  });
});
