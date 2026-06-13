import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { createAdminClient } from "@/lib/supabase";
import {
  CredentialOwnershipError,
  upsertShopCredentials,
} from "@/lib/shopify/credentials";
import type { Goal } from "@/lib/agent/types";

/**
 * POST /api/agent/provision — the one-click entry point from the landing page.
 *
 * Takes a merchant homepage URL, normalizes it to a domain, upserts the `sites`
 * row for this user+domain (same upsert the crawl route uses), and returns the
 * default one-shot Goal the agent surface should run.
 *
 * Intentionally thin: no sitemap fetch, no crawl rows, no theme access. The agent
 * run itself (POST /api/agent/run) resolves the sitemap from the domain. Later
 * rounds extend this endpoint (e.g. Shopify OAuth handshake) — the response
 * contract { siteId, domain, goal } must stay stable.
 */
const bodySchema = z.object({
  url: z.string().min(1, "URL is required"),
  /**
   * Optional Shopify connection (issue #25). All three of shopDomain/appKey/
   * appSecret together connect the store: the credentials are stored server-side
   * (service-role only, minted on demand, never echoed back) and the site row is
   * tagged with its myshopify domain so staging write modes become available.
   */
  shopDomain: z.string().optional(),
  appKey: z.string().optional(),
  appSecret: z.string().optional(),
  storefrontPassword: z.string().optional(),
});

const MYSHOPIFY_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** Looks like a real hostname after normalization (e.g. "store.com"). */
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body;
  try {
    body = bodySchema.parse(await request.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof z.ZodError ? err.issues[0].message : "Invalid request" },
      { status: 400 }
    );
  }

  // Normalize to a bare domain.
  const normalizedDomain = body.url
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .toLowerCase();

  if (!DOMAIN_RE.test(normalizedDomain)) {
    return NextResponse.json(
      { error: "Enter a valid store URL, e.g. https://your-store.com" },
      { status: 400 }
    );
  }

  // Upsert the site for this user+domain (idempotent — re-provisioning is safe).
  const { data: site, error: siteError } = await supabase
    .from("sites")
    .upsert(
      { user_id: user.id, domain: normalizedDomain },
      { onConflict: "user_id,domain" }
    )
    .select("id")
    .single();

  if (siteError || !site) {
    // Log the raw DB error server-side only; don't leak schema/constraint text to
    // the client (matches the credential-store error path below).
    console.error("[agent/provision] site upsert failed:", siteError);
    return NextResponse.json(
      { error: "Failed to create site record" },
      { status: 500 }
    );
  }

  // Optional Shopify connection (issue #25). All-or-nothing: a partial credential
  // triple is a caller mistake, not something to silently half-store.
  const credentialFields = [body.shopDomain, body.appKey, body.appSecret];
  const givenCount = credentialFields.filter((f) => f && f.trim()).length;
  let shopConnected = false;
  if (givenCount > 0) {
    if (givenCount < 3) {
      return NextResponse.json(
        {
          error:
            "To connect a Shopify store, provide shopDomain, appKey, and appSecret together",
        },
        { status: 400 }
      );
    }
    const shopDomain = body.shopDomain!.trim().toLowerCase();
    if (!MYSHOPIFY_RE.test(shopDomain)) {
      return NextResponse.json(
        { error: "shopDomain must look like your-store.myshopify.com" },
        { status: 400 }
      );
    }
    try {
      // The credential row is owned by this user (#32): a different account can't
      // overwrite it (confused-deputy / clobbering). Secrets are encrypted at
      // rest by upsertShopCredentials. Service-role writes keep the table
      // server-only (RLS, no anon policies).
      await upsertShopCredentials({
        shopDomain,
        appKey: body.appKey!.trim(),
        appSecret: body.appSecret!.trim(),
        ownerId: user.id,
        ...(body.storefrontPassword?.trim()
          ? { storefrontPassword: body.storefrontPassword.trim() }
          : {}),
      });
      const admin = createAdminClient();
      const { error: shopErr } = await admin
        .from("sites")
        .update({ shop_domain: shopDomain })
        .eq("id", site.id);
      if (shopErr) throw new Error(shopErr.message);
      shopConnected = true;
    } catch (e) {
      if (e instanceof CredentialOwnershipError) {
        // Another account already connected this myshopify domain. 409, not 500
        // — it's a conflict the caller can act on, and we don't leak who owns it.
        return NextResponse.json(
          {
            error:
              "This Shopify store is already connected by another account. " +
              "Contact support if you believe this is your store.",
          },
          { status: 409 }
        );
      }
      console.error("[agent/provision] credential store failed:", e);
      return NextResponse.json(
        { error: "Failed to store Shopify credentials" },
        { status: 500 }
      );
    }
  }

  // The default one-shot goal: the whole site, one button (issues #27/#28).
  // Scope "site" derives per-page required types from the page-type matrix, so
  // requireTypes stays empty; minOutcome "rich_results_eligible" holds the
  // rich-capable types (Product, BreadcrumbList, Organization, ...) to the rich
  // bar while WebSite/CollectionPage/etc. are only ever required to validate.
  // allowSchemaTypeChange is required by the Goal type and defaults to false
  // (novel type changes stay gated), matching /api/agent/run's default.
  const goal: Goal = {
    siteId: site.id,
    target: {
      scope: "site",
      requireTypes: [],
      minOutcome: "rich_results_eligible",
    },
    constraints: {
      maxPages: 50,
      allowSchemaTypeChange: false,
    },
    autonomy: "auto_apply",
  };

  return NextResponse.json({
    siteId: site.id,
    domain: normalizedDomain,
    goal,
    // Secrets are never echoed; the client only learns whether staging unlocked.
    shopConnected,
  });
}
