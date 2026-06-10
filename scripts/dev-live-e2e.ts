/**
 * FULL LIVE APPLY E2E on the dev store (the store we hold credentials for):
 * per-site provisioning (#25) → staging duplicate (#26) → authoritative
 * suppression of theme-native schema (#23) → duplicate-prevention gate (#24)
 * → L4 live verify → publish (atomic swap) → merchant report.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/dev-live-e2e.ts themes     # list themes only
 *   npx tsx --env-file=.env.local scripts/dev-live-e2e.ts run        # staging, no publish
 *   npx tsx --env-file=.env.local scripts/dev-live-e2e.ts publish    # staging + publish
 */
import { runGoal } from "../src/lib/agent/run";
import { buildMerchantReport } from "../src/lib/agent/report";
import { upsertShopCredentials } from "../src/lib/shopify/credentials";
import { themesList } from "../src/lib/shopify/themes";
import { createAdminClient } from "../src/lib/supabase";
import type { Goal } from "../src/lib/agent/types";
import { writeFileSync } from "node:fs";

const SHOP = "ethan-dev-store-1.myshopify.com";
const PRODUCTS = [
  `https://${SHOP}/products/selling-plans-ski-wax`,
  `https://${SHOP}/products/the-3p-fulfilled-snowboard`,
  `https://${SHOP}/products/the-collection-snowboard-hydrogen`,
];

async function main() {
  const mode = process.argv[2] ?? "themes";

  if (mode === "themes") {
    const themes = await themesList();
    for (const t of themes) console.log(`${t.id}  role=${t.role.padEnd(12)} ${t.name}`);
    return;
  }

  const admin = createAdminClient();

  // Provision the dev store through the REAL per-site path (issue #25): store the
  // env credentials in shopify_credentials and tag the site row with shop_domain.
  await upsertShopCredentials({
    shopDomain: SHOP,
    appKey: process.env.SHOPIFY_APP_KEY!,
    appSecret: process.env.SHOPIFY_APP_SECRET!,
    ...(process.env.SHOPIFY_STOREFRONT_PASSWORD
      ? { storefrontPassword: process.env.SHOPIFY_STOREFRONT_PASSWORD }
      : {}),
  });
  const { data: anySite } = await admin.from("sites").select("user_id").limit(1).single();
  const { data: site, error: siteErr } = await admin
    .from("sites")
    .upsert({ user_id: anySite!.user_id, domain: SHOP, shop_domain: SHOP }, { onConflict: "user_id,domain" })
    .select("id")
    .single();
  if (siteErr || !site) throw new Error(`site upsert failed: ${siteErr?.message}`);
  console.log(`provisioned: site=${site.id} shop=${SHOP} (credentials row + shop_domain)`);

  const goal: Goal = {
    siteId: site.id,
    target: { scope: "url_list", urls: PRODUCTS, requireTypes: ["Product"], minOutcome: "rich_results_eligible" },
    // authoritative ON: suppress the theme's own Product JSON-LD in the staging
    // duplicate so the dup gate can demand exactly one valid Product block.
    constraints: { maxPages: PRODUCTS.length, allowSchemaTypeChange: false, authoritative: true },
    autonomy: "auto_apply",
  };

  const t0 = Date.now();
  const result = await runGoal(goal, {
    dryRun: false,
    concurrency: 2,
    writeTheme: { mode: "staging", publish: mode === "publish" },
    onProgress: (ev) => {
      const bits = [ev.phase, ev.url ?? "", ev.outcome ?? "", ev.message ?? "", ev.previewUrl ?? ""].filter(Boolean);
      console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...bits);
    },
  });
  const secs = Math.round((Date.now() - t0) / 1000);

  console.log("\n========== LIVE APPLY RESULT ==========");
  console.log(`status=${result.status} in ${secs}s runId=${result.runId}`);
  console.log(`satisfied=${result.satisfied.length} unsatisfied=${result.unsatisfied.length}`);
  console.log(`apply: ${result.apply?.status} writeTarget=${result.apply?.writeTarget}`);
  console.log(`L4: ${result.apply?.l4.filter((v) => v?.passed).length}/${result.apply?.l4.length} passed`);
  console.log(`suppressedAssets: ${JSON.stringify(result.apply?.suppressedAssets ?? [])}`);
  console.log(`staging: ${JSON.stringify(result.staging)}`);

  if (result.runId) {
    const { data: run } = await admin.from("agent_runs").select("*").eq("id", result.runId).single();
    const { data: actions } = await admin
      .from("agent_actions").select("*").eq("run_id", result.runId)
      .order("created_at", { ascending: true });
    if (run && actions) {
      const report = buildMerchantReport(run, actions);
      writeFileSync("docs/agent/dev-live-apply-report.json", JSON.stringify({ generatedAt: new Date().toISOString(), report }, null, 2));
      console.log(`\nverdict: ${report.verdict.headline} — ${report.verdict.reason}`);
      for (const a of report.requiredMerchantActions) console.log("  ACTION:", a);
      if (report.publishedThemeId) console.log(`  PUBLISHED THEME: ${report.publishedThemeId}`);
      console.log("report written: docs/agent/dev-live-apply-report.json");
    }
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
