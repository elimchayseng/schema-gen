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

// Authed (user-scoped) client: auth + the sites upsert.
function mockAuthed(opts: { user?: { id: string } | null; siteResult?: unknown }) {
  const {
    user = { id: "user-1" },
    siteResult = { data: { id: "site-1" }, error: null },
  } = opts;
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) },
    from: (table: string) =>
      table === "sites" ? chain(siteResult) : chain({ data: null, error: null }),
  };
}

vi.mock("@/lib/supabase-server", () => ({ createSupabaseServerClient: vi.fn() }));
const adminMock = vi.hoisted(() => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase", () => adminMock);
const credentialsMock = vi.hoisted(() => {
  // Re-declare the real error class so `instanceof` in the route works under mock.
  class CredentialOwnershipError extends Error {
    constructor(shop: string) {
      super(`Shop ${shop} is already connected by another account`);
      this.name = "CredentialOwnershipError";
    }
  }
  return { upsertShopCredentials: vi.fn(), CredentialOwnershipError };
});
vi.mock("@/lib/shopify/credentials", () => credentialsMock);

import { createSupabaseServerClient } from "@/lib/supabase-server";
import { POST } from "../route";

const mockAuthedClient = vi.mocked(createSupabaseServerClient);

function req(body: unknown) {
  return new Request("http://localhost/api/agent/provision", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const SECRETS = {
  shopDomain: "garner-tow.myshopify.com",
  appKey: "app-key-SECRET",
  appSecret: "app-secret-SECRET",
  storefrontPassword: "storefront-pass-SECRET",
};

beforeEach(() => {
  vi.clearAllMocks();
  // The 500 paths deliberately console.error the raw failure server-side.
  vi.spyOn(console, "error").mockImplementation(() => {});
  credentialsMock.upsertShopCredentials.mockResolvedValue(undefined);
  adminMock.createAdminClient.mockReturnValue({
    from: () => chain({ error: null }),
  } as never);
});

describe("POST /api/agent/provision", () => {
  it("401 when unauthenticated", async () => {
    mockAuthedClient.mockResolvedValue(mockAuthed({ user: null }) as never);
    const res = await POST(req({ url: "https://garnerandtow.com" }));
    expect(res.status).toBe(401);
    expect(credentialsMock.upsertShopCredentials).not.toHaveBeenCalled();
  });

  it("400 when the url does not normalize to a domain", async () => {
    mockAuthedClient.mockResolvedValue(mockAuthed({}) as never);
    const res = await POST(req({ url: "not a real url" }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("valid store URL");
  });

  it("400 on a partial credential triple (only shopDomain given)", async () => {
    mockAuthedClient.mockResolvedValue(mockAuthed({}) as never);
    const res = await POST(
      req({ url: "https://garnerandtow.com", shopDomain: SECRETS.shopDomain })
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("together");
    expect(credentialsMock.upsertShopCredentials).not.toHaveBeenCalled();
  });

  it("400 when shopDomain is not *.myshopify.com", async () => {
    mockAuthedClient.mockResolvedValue(mockAuthed({}) as never);
    const res = await POST(
      req({
        url: "https://garnerandtow.com",
        ...SECRETS,
        shopDomain: "garnerandtow.com",
      })
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("myshopify.com");
    expect(credentialsMock.upsertShopCredentials).not.toHaveBeenCalled();
  });

  it("500 with a GENERIC error when the site upsert fails (no raw DB detail leaked)", async () => {
    mockAuthedClient.mockResolvedValue(
      mockAuthed({
        siteResult: {
          data: null,
          error: { message: 'duplicate key value violates unique constraint "sites_pkey"' },
        },
      }) as never
    );
    const res = await POST(req({ url: "https://garnerandtow.com" }));
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("Failed to create site record");
    expect(text).not.toContain("duplicate key");
    expect(text).not.toContain("sites_pkey");
  });

  it("409 when the shop is already connected by another account (#32)", async () => {
    mockAuthedClient.mockResolvedValue(mockAuthed({}) as never);
    credentialsMock.upsertShopCredentials.mockRejectedValue(
      new credentialsMock.CredentialOwnershipError(SECRETS.shopDomain)
    );
    const res = await POST(req({ url: "https://garnerandtow.com", ...SECRETS }));
    expect(res.status).toBe(409);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("already connected by another account");
    // Don't leak which account owns it.
    expect(text).not.toContain("user-");
  });

  it("500 with a GENERIC error when upsertShopCredentials throws (no detail leaked)", async () => {
    mockAuthedClient.mockResolvedValue(mockAuthed({}) as never);
    credentialsMock.upsertShopCredentials.mockRejectedValue(
      new Error('relation "shop_credentials" does not exist')
    );
    const res = await POST(req({ url: "https://garnerandtow.com", ...SECRETS }));
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("Failed to store Shopify credentials");
    expect(text).not.toContain("shop_credentials");
    expect(text).not.toContain("does not exist");
  });

  it("happy path: returns siteId/domain/goal/shopConnected and NEVER echoes the secrets", async () => {
    mockAuthedClient.mockResolvedValue(mockAuthed({}) as never);
    const res = await POST(req({ url: "https://GarnerAndTow.com/some/page", ...SECRETS }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      siteId: "site-1",
      domain: "garnerandtow.com", // normalized: scheme/path stripped, lowercased
      shopConnected: true,
    });
    expect(data.goal).toMatchObject({
      siteId: "site-1",
      target: { scope: "site", requireTypes: [], minOutcome: "rich_results_eligible" },
      autonomy: "auto_apply",
    });
    expect(credentialsMock.upsertShopCredentials).toHaveBeenCalledWith({
      shopDomain: SECRETS.shopDomain,
      appKey: SECRETS.appKey,
      appSecret: SECRETS.appSecret,
      storefrontPassword: SECRETS.storefrontPassword,
      // The row is owned by the authenticated user (#32).
      ownerId: "user-1",
    });
    // The response contract: secrets are stored server-side, never echoed back.
    const text = JSON.stringify(data);
    expect(text).not.toContain(SECRETS.appKey);
    expect(text).not.toContain(SECRETS.appSecret);
    expect(text).not.toContain(SECRETS.storefrontPassword);
  });
});
