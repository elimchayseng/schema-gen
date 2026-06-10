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

vi.mock("@/lib/supabase-server", () => ({ createSupabaseServerClient: vi.fn() }));
const overridesMock = vi.hoisted(() => ({
  loadOverrides: vi.fn(),
  deleteOverride: vi.fn(),
  getOverride: vi.fn(),
}));
vi.mock("@/lib/agent/overrides", () => overridesMock);

import { createSupabaseServerClient } from "@/lib/supabase-server";
import { GET, DELETE } from "../route";

const mockAuthedClient = vi.mocked(createSupabaseServerClient);

const OVERRIDE = {
  id: "ov-1",
  siteId: "site-1",
  url: "https://shop.example/products/strap",
  schemaType: "Product",
  fieldPath: "brand.name",
  value: "Garner & Tow",
  source: "chat",
  createdAt: "2026-06-09T00:00:00Z",
  updatedAt: "2026-06-09T00:00:00Z",
};

const listUrl = `http://localhost/api/agent/overrides?siteId=site-1&url=${encodeURIComponent(OVERRIDE.url)}`;

beforeEach(() => {
  vi.clearAllMocks();
  overridesMock.loadOverrides.mockResolvedValue([OVERRIDE]);
  overridesMock.getOverride.mockResolvedValue(OVERRIDE);
  overridesMock.deleteOverride.mockResolvedValue(undefined);
});

describe("GET /api/agent/overrides", () => {
  it("401 when unauthenticated", async () => {
    mockAuthedClient.mockResolvedValue(mockAuthed({ user: null }) as never);
    const res = await GET(new Request(listUrl));
    expect(res.status).toBe(401);
    expect(overridesMock.loadOverrides).not.toHaveBeenCalled();
  });

  it("400 when siteId or url is missing", async () => {
    mockAuthedClient.mockResolvedValue(mockAuthed({}) as never);
    const res = await GET(new Request("http://localhost/api/agent/overrides?siteId=site-1"));
    expect(res.status).toBe(400);
  });

  it("404 when the site is not owned by the user", async () => {
    mockAuthedClient.mockResolvedValue(mockAuthed({ site: null }) as never);
    const res = await GET(new Request(listUrl));
    expect(res.status).toBe(404);
    expect(overridesMock.loadOverrides).not.toHaveBeenCalled();
  });

  it("returns the overrides for an owned site", async () => {
    mockAuthedClient.mockResolvedValue(mockAuthed({}) as never);
    const res = await GET(new Request(listUrl));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.overrides).toHaveLength(1);
    expect(data.overrides[0].fieldPath).toBe("brand.name");
    expect(overridesMock.loadOverrides).toHaveBeenCalledWith("site-1", OVERRIDE.url);
  });

  it("500 when the store read fails", async () => {
    mockAuthedClient.mockResolvedValue(mockAuthed({}) as never);
    overridesMock.loadOverrides.mockRejectedValue(new Error("db down"));
    const res = await GET(new Request(listUrl));
    expect(res.status).toBe(500);
  });
});

describe("DELETE /api/agent/overrides", () => {
  const delReq = (id?: string) =>
    new Request(
      `http://localhost/api/agent/overrides${id ? `?id=${id}` : ""}`,
      { method: "DELETE" }
    );

  it("401 when unauthenticated", async () => {
    mockAuthedClient.mockResolvedValue(mockAuthed({ user: null }) as never);
    const res = await DELETE(delReq("ov-1"));
    expect(res.status).toBe(401);
    expect(overridesMock.deleteOverride).not.toHaveBeenCalled();
  });

  it("400 when id is missing", async () => {
    mockAuthedClient.mockResolvedValue(mockAuthed({}) as never);
    const res = await DELETE(delReq());
    expect(res.status).toBe(400);
  });

  it("404 when the override does not exist", async () => {
    mockAuthedClient.mockResolvedValue(mockAuthed({}) as never);
    overridesMock.getOverride.mockResolvedValue(null);
    const res = await DELETE(delReq("ov-missing"));
    expect(res.status).toBe(404);
    expect(overridesMock.deleteOverride).not.toHaveBeenCalled();
  });

  it("404 when the override's site is not owned by the user", async () => {
    mockAuthedClient.mockResolvedValue(mockAuthed({ site: null }) as never);
    const res = await DELETE(delReq("ov-1"));
    expect(res.status).toBe(404);
    expect(overridesMock.deleteOverride).not.toHaveBeenCalled();
  });

  it("deletes an owned override", async () => {
    mockAuthedClient.mockResolvedValue(mockAuthed({}) as never);
    const res = await DELETE(delReq("ov-1"));
    expect(res.status).toBe(200);
    expect(overridesMock.deleteOverride).toHaveBeenCalledWith("ov-1", "site-1");
  });
});
