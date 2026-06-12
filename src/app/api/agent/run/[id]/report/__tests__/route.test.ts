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
  const { run = baseRun, actions = [] } = opts;
  return {
    from: (table: string) =>
      table === "agent_actions" ? chain({ data: actions }) : chain({ data: run }),
  };
}

vi.mock("@/lib/supabase-server", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ createAdminClient: vi.fn() }));

import { createSupabaseServerClient } from "@/lib/supabase-server";
import { createAdminClient } from "@/lib/supabase";
import { GET } from "../route";

const mockAuthedClient = vi.mocked(createSupabaseServerClient);
const mockAdminClient = vi.mocked(createAdminClient);

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request("http://localhost/api/agent/run/run-1/report");

const baseRun = {
  id: "run-1",
  site_id: "site-1",
  goal: { target: { scope: "all_products", requireTypes: ["Product"], minOutcome: "valid" } },
  status: "done",
  started_at: "2026-06-09T10:00:00Z",
  ended_at: "2026-06-09T10:05:00Z",
  error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAdminClient.mockReturnValue(mockAdmin({}) as never);
});

describe("GET /api/agent/run/[id]/report", () => {
  it("401 when unauthenticated", async () => {
    mockAuthedClient.mockResolvedValue(mockAuthed({ user: null }) as never);
    const res = await GET(req(), params("run-1"));
    expect(res.status).toBe(401);
  });

  it("404 when the run's site is not owned by the user", async () => {
    mockAuthedClient.mockResolvedValue(mockAuthed({ site: null }) as never);
    const res = await GET(req(), params("run-1"));
    expect(res.status).toBe(404);
  });

  it("404 when the run does not exist", async () => {
    mockAuthedClient.mockResolvedValue(mockAuthed({}) as never);
    mockAdminClient.mockReturnValue(mockAdmin({ run: null }) as never);
    const res = await GET(req(), params("run-missing"));
    expect(res.status).toBe(404);
  });

  it("returns the built MerchantReport for an owned run", async () => {
    mockAuthedClient.mockResolvedValue(mockAuthed({}) as never);
    mockAdminClient.mockReturnValue(
      mockAdmin({
        actions: [
          {
            url: "https://shop.example.com/products/a",
            action: "skip",
            schema_before: null,
            schema_after: null,
            gates: null,
            write_target: null,
            outcome: "already_satisfied",
            created_at: "2026-06-09T10:00:01Z",
          },
        ],
      }) as never
    );
    const res = await GET(req(), params("run-1"));
    expect(res.status).toBe(200);
    const report = await res.json();
    expect(report.runId).toBe("run-1");
    expect(report.verdict.goodToGo).toBe(true);
    expect(report.summary.alreadyGood).toBe(1);
    expect(report.pages[0].googleTestUrl).toContain(
      "https://search.google.com/test/rich-results?url="
    );
    expect(report.proof.googleLabel).toBe("Confirm with Google");
  });
});
