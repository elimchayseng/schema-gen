/**
 * Per-site Shopify credential resolution (issue #25).
 *
 * Today the agent runs against ONE store configured via env
 * (SHOPIFY_SHOP / SHOPIFY_APP_KEY / SHOPIFY_APP_SECRET). The garnerandtow
 * pilot is a different store, so shop + credentials become per-site rows in
 * `shopify_credentials` (migration 008), read via the service-role client
 * (RLS-locked table — anon/authenticated roles have zero access).
 *
 * Resolution order for resolveShopCredentials(shop):
 *   1. shopify_credentials row for the normalized shop  -> use it
 *   2. no row (or Supabase unreachable) + env app creds  -> env fallback,
 *      so the existing dev-store flow keeps working with zero rows
 *   3. neither                                           -> throw (actionable)
 *
 * The env storefront password is only attached when the requested shop IS the
 * env-configured shop — storefront passwords are store-specific.
 *
 * Secrets are never logged: log lines carry the shop + source only.
 */
import { createAdminClient } from "@/lib/supabase";
import { normalizeShop } from "./config";
import { shopifyLog } from "./logger";
import type { ShopContext } from "./types";

export interface ResolvedShopCredentials {
  /** Normalized shop host, e.g. "garnerandtow.myshopify.com". */
  shop: string;
  appKey: string;
  appSecret: string;
  /** Unlocks a password-gated storefront for L4 live verify; null when none. */
  storefrontPassword: string | null;
  /** Where the credentials came from (observability; never includes secrets). */
  source: "supabase" | "env";
}

interface CredentialsRow {
  shop_domain: string;
  app_key: string;
  app_secret: string;
  storefront_password: string | null;
}

/**
 * Fetch the shopify_credentials row for a shop, or null when absent.
 * Infrastructure failures (missing service key, query error) are returned as
 * an Error value — the caller decides whether env fallback can absorb them.
 */
async function lookupCredentialsRow(
  shop: string
): Promise<CredentialsRow | null | Error> {
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("shopify_credentials")
      .select("shop_domain, app_key, app_secret, storefront_password")
      .eq("shop_domain", shop)
      .maybeSingle();
    if (error) return new Error(error.message);
    return (data as CredentialsRow | null) ?? null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/** The env credential pair, or null when either half is missing. */
function envCredentials(): { appKey: string; appSecret: string } | null {
  const appKey = process.env.SHOPIFY_APP_KEY;
  const appSecret = process.env.SHOPIFY_APP_SECRET;
  return appKey && appSecret ? { appKey, appSecret } : null;
}

/**
 * Resolve the app credentials for a shop: Supabase row first, env fallback.
 * Accepts any shop spelling normalizeShop understands ("garnerandtow",
 * "garnerandtow.myshopify.com", a full URL).
 */
export async function resolveShopCredentials(
  shopDomain: string
): Promise<ResolvedShopCredentials> {
  const shop = normalizeShop(shopDomain);

  const row = await lookupCredentialsRow(shop);
  if (row && !(row instanceof Error)) {
    shopifyLog("debug", "Resolved per-shop Shopify credentials", {
      shop,
      source: "supabase",
    });
    return {
      shop,
      appKey: row.app_key,
      appSecret: row.app_secret,
      storefrontPassword: row.storefront_password ?? null,
      source: "supabase",
    };
  }

  if (row instanceof Error) {
    // Lookup infra failure: fall through to env when possible (keeps the
    // dev-store flow alive), otherwise surface the real cause below.
    shopifyLog("warn", "shopify_credentials lookup failed", {
      shop,
      error: row.message,
    });
  }

  const env = envCredentials();
  if (env) {
    const envShop = process.env.SHOPIFY_SHOP
      ? normalizeShop(process.env.SHOPIFY_SHOP)
      : null;
    shopifyLog("debug", "Resolved per-shop Shopify credentials", {
      shop,
      source: "env",
    });
    return {
      shop,
      appKey: env.appKey,
      appSecret: env.appSecret,
      // Storefront passwords are store-specific: only attach the env one when
      // the requested shop IS the env-configured shop.
      storefrontPassword:
        shop === envShop
          ? process.env.SHOPIFY_STOREFRONT_PASSWORD ?? null
          : null,
      source: "env",
    };
  }

  throw new Error(
    `No Shopify credentials for ${shop}: add a shopify_credentials row ` +
      `(upsertShopCredentials) or set SHOPIFY_APP_KEY + SHOPIFY_APP_SECRET`
  );
}

/**
 * Convenience for the orchestrator: resolve credentials and shape them as the
 * ShopContext that shopifyFetch / assets.ts / themes.ts accept. The storefront
 * password rides along for the L4 verify path (getStorefrontCookie).
 */
export async function resolveShopContext(
  shopDomain: string
): Promise<ShopContext & { storefrontPassword: string | null }> {
  const creds = await resolveShopCredentials(shopDomain);
  return {
    shop: creds.shop,
    credentials: { appKey: creds.appKey, appSecret: creds.appSecret },
    storefrontPassword: creds.storefrontPassword,
  };
}

export interface UpsertShopCredentialsInput {
  /** Any spelling normalizeShop understands; stored normalized. */
  shopDomain: string;
  appKey: string;
  appSecret: string;
  /** Optional; pass null to clear an existing password. */
  storefrontPassword?: string | null;
}

/**
 * Provision (or rotate) per-shop credentials. Service-role write; the table
 * has no anon policies, so this is server-only by construction.
 */
export async function upsertShopCredentials(
  input: UpsertShopCredentialsInput
): Promise<void> {
  const shop = normalizeShop(input.shopDomain);
  const supabase = createAdminClient();
  const { error } = await supabase.from("shopify_credentials").upsert(
    {
      shop_domain: shop,
      app_key: input.appKey,
      app_secret: input.appSecret,
      storefront_password: input.storefrontPassword ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "shop_domain" }
  );
  if (error) {
    // Supabase error messages don't echo row values, so no secret leaks here.
    throw new Error(`Failed to upsert shopify_credentials for ${shop}: ${error.message}`);
  }
  shopifyLog("info", "Upserted per-shop Shopify credentials", { shop });
}
