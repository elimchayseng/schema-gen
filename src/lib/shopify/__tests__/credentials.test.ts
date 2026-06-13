/**
 * Unit tests for per-site credential resolution (issue #25).
 * Supabase is fully mocked — no live API, no service-role key needed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoisted supabase chain mock:
//   createAdminClient().from("shopify_credentials").select().eq().maybeSingle()
//   createAdminClient().from("shopify_credentials").upsert(row, opts)
const h = vi.hoisted(() => {
  const maybeSingle = vi.fn();
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const upsert = vi.fn();
  const from = vi.fn(() => ({ select, upsert }));
  const createAdminClient = vi.fn(() => ({ from }));
  return { maybeSingle, eq, select, upsert, from, createAdminClient };
});

vi.mock("@/lib/supabase", () => ({ createAdminClient: h.createAdminClient }));

import {
  resolveShopCredentials,
  resolveShopContext,
  upsertShopCredentials,
} from "../credentials";

const row = {
  shop_domain: "garnerandtow.myshopify.com",
  app_key: "row-key",
  app_secret: "row-secret",
  storefront_password: "row-pass",
};

describe("resolveShopCredentials", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SHOPIFY_SHOP;
    delete process.env.SHOPIFY_APP_KEY;
    delete process.env.SHOPIFY_APP_SECRET;
    delete process.env.SHOPIFY_STOREFRONT_PASSWORD;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("returns the Supabase row when one exists (normalizing the input shop)", async () => {
    h.maybeSingle.mockResolvedValue({ data: row, error: null });

    const creds = await resolveShopCredentials("garnerandtow");

    expect(creds).toEqual({
      shop: "garnerandtow.myshopify.com",
      appKey: "row-key",
      appSecret: "row-secret",
      storefrontPassword: "row-pass",
      source: "supabase",
    });
    expect(h.from).toHaveBeenCalledWith("shopify_credentials");
    expect(h.eq).toHaveBeenCalledWith(
      "shop_domain",
      "garnerandtow.myshopify.com"
    );
  });

  it("normalizes a null storefront_password", async () => {
    h.maybeSingle.mockResolvedValue({
      data: { ...row, storefront_password: null },
      error: null,
    });
    const creds = await resolveShopCredentials("garnerandtow.myshopify.com");
    expect(creds.storefrontPassword).toBeNull();
  });

  it("falls back to env when no row exists and env creds are set", async () => {
    h.maybeSingle.mockResolvedValue({ data: null, error: null });
    process.env.SHOPIFY_SHOP = "env-store";
    process.env.SHOPIFY_APP_KEY = "env-key";
    process.env.SHOPIFY_APP_SECRET = "env-secret";
    process.env.SHOPIFY_STOREFRONT_PASSWORD = "env-pass";

    const creds = await resolveShopCredentials("env-store.myshopify.com");

    expect(creds).toEqual({
      shop: "env-store.myshopify.com",
      appKey: "env-key",
      appSecret: "env-secret",
      storefrontPassword: "env-pass", // shop matches env SHOPIFY_SHOP
      source: "env",
    });
  });

  it("omits the env storefront password for a different shop", async () => {
    h.maybeSingle.mockResolvedValue({ data: null, error: null });
    process.env.SHOPIFY_SHOP = "env-store";
    process.env.SHOPIFY_APP_KEY = "env-key";
    process.env.SHOPIFY_APP_SECRET = "env-secret";
    process.env.SHOPIFY_STOREFRONT_PASSWORD = "env-pass";

    const creds = await resolveShopCredentials("other-store");

    expect(creds.storefrontPassword).toBeNull();
    expect(creds.source).toBe("env");
  });

  it("falls back to env when the Supabase lookup errors", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.maybeSingle.mockResolvedValue({
      data: null,
      error: { message: "connection refused" },
    });
    process.env.SHOPIFY_APP_KEY = "env-key";
    process.env.SHOPIFY_APP_SECRET = "env-secret";

    const creds = await resolveShopCredentials("garnerandtow");
    expect(creds.source).toBe("env");
    warnSpy.mockRestore();
  });

  it("falls back to env when createAdminClient itself throws (no service key)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.createAdminClient.mockImplementationOnce(() => {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
    });
    process.env.SHOPIFY_APP_KEY = "env-key";
    process.env.SHOPIFY_APP_SECRET = "env-secret";

    const creds = await resolveShopCredentials("garnerandtow");
    expect(creds.source).toBe("env");
    warnSpy.mockRestore();
  });

  it("throws an actionable error when there is no row and no env", async () => {
    h.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(resolveShopCredentials("garnerandtow")).rejects.toThrow(
      /No Shopify credentials for garnerandtow\.myshopify\.com/
    );
  });

  it("never logs the app secret or storefront password", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.maybeSingle.mockResolvedValue({ data: row, error: null });

    await resolveShopCredentials("garnerandtow");

    const logged = [...logSpy.mock.calls, ...warnSpy.mock.calls]
      .map((c) => String(c[0]))
      .join("\n");
    expect(logged).not.toContain("row-secret");
    expect(logged).not.toContain("row-pass");
    expect(logged).not.toContain("row-key");
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe("resolveShopContext", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shapes credentials as a ShopContext for shopifyFetch", async () => {
    h.maybeSingle.mockResolvedValue({ data: row, error: null });
    const ctx = await resolveShopContext("garnerandtow");
    expect(ctx).toEqual({
      shop: "garnerandtow.myshopify.com",
      credentials: { appKey: "row-key", appSecret: "row-secret" },
      storefrontPassword: "row-pass",
    });
  });
});

describe("upsertShopCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The owner-guard pre-read (#32) selects owner_id before writing. Default to
    // "no existing row" unless a test overrides it.
    h.maybeSingle.mockResolvedValue({ data: null, error: null });
  });
  // No CREDENTIAL_ENCRYPTION_KEY in the test env, so encryptSecret is a
  // passthrough and stored secret values equal the plaintext (asserted below).

  it("normalizes the shop and upserts on shop_domain", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    h.upsert.mockResolvedValue({ error: null });

    await upsertShopCredentials({
      shopDomain: "https://GarnerAndTow.myshopify.com/admin",
      appKey: "new-key",
      appSecret: "new-secret",
      storefrontPassword: "new-pass",
      ownerId: "user-1",
    });

    expect(h.from).toHaveBeenCalledWith("shopify_credentials");
    const [payload, opts] = h.upsert.mock.calls[0];
    expect(payload).toMatchObject({
      shop_domain: "garnerandtow.myshopify.com",
      app_key: "new-key",
      app_secret: "new-secret",
      storefront_password: "new-pass",
      owner_id: "user-1",
    });
    expect(typeof payload.updated_at).toBe("string");
    expect(opts).toEqual({ onConflict: "shop_domain" });

    // The provisioning log line never carries secrets.
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).not.toContain("new-secret");
    expect(logged).not.toContain("new-pass");
    logSpy.mockRestore();
  });

  it("defaults a missing storefront password to null", async () => {
    h.upsert.mockResolvedValue({ error: null });
    await upsertShopCredentials({
      shopDomain: "garnerandtow",
      appKey: "k",
      appSecret: "s",
    });
    expect(h.upsert.mock.calls[0][0].storefront_password).toBeNull();
  });

  it("throws when the upsert fails", async () => {
    h.upsert.mockResolvedValue({ error: { message: "permission denied" } });
    await expect(
      upsertShopCredentials({ shopDomain: "x", appKey: "k", appSecret: "s" })
    ).rejects.toThrow(/Failed to upsert shopify_credentials/);
  });

  it("claims a legacy null-owner row for the calling user", async () => {
    h.maybeSingle.mockResolvedValue({ data: { owner_id: null }, error: null });
    h.upsert.mockResolvedValue({ error: null });
    await upsertShopCredentials({
      shopDomain: "garnerandtow",
      appKey: "k",
      appSecret: "s",
      ownerId: "user-1",
    });
    expect(h.upsert.mock.calls[0][0].owner_id).toBe("user-1");
  });

  it("refuses to overwrite a row owned by a different user", async () => {
    h.maybeSingle.mockResolvedValue({ data: { owner_id: "user-1" }, error: null });
    await expect(
      upsertShopCredentials({
        shopDomain: "garnerandtow",
        appKey: "k",
        appSecret: "s",
        ownerId: "user-2",
      })
    ).rejects.toThrow(/already connected by another account/);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("refuses an ownerless internal caller against an owned row", async () => {
    h.maybeSingle.mockResolvedValue({ data: { owner_id: "user-1" }, error: null });
    await expect(
      upsertShopCredentials({ shopDomain: "garnerandtow", appKey: "k", appSecret: "s" })
    ).rejects.toThrow(/already connected by another account/);
  });

  it("lets the same owner rotate their own credentials", async () => {
    h.maybeSingle.mockResolvedValue({ data: { owner_id: "user-1" }, error: null });
    h.upsert.mockResolvedValue({ error: null });
    await upsertShopCredentials({
      shopDomain: "garnerandtow",
      appKey: "k2",
      appSecret: "s2",
      ownerId: "user-1",
    });
    expect(h.upsert.mock.calls[0][0].owner_id).toBe("user-1");
  });
});
