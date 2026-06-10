/**
 * Live e2e of the merchant tweak flow (issue #29), no Shopify writes:
 *   1. LLM proposes targeted edits from a natural-language correction
 *   2. applyOverrides applies deterministically; validateSchema gates
 *   3. Override persists to merchant_overrides (sticky)
 *   4. A fresh executor run for the same page shows the override winning
 *      over freshly-generated LLM output ("re-runs never clobber").
 *
 * Run: npx tsx --env-file=.env.local scripts/tweak-flow-e2e.ts
 */
import {
  applyOverrides,
  loadOverrides,
  proposeOverrideEdits,
  saveOverride,
} from "../src/lib/agent/overrides";
import { executeTask } from "../src/lib/agent/executor";
import { validateSchema } from "../src/lib/validation/engine";
import { createAdminClient } from "../src/lib/supabase";
import type { Goal } from "../src/lib/agent/types";

const URL = "https://garnerandtow.com/products/duffel";
const MESSAGE =
  'The brand name is wrong — it must be exactly "Garner & Tow" (with an ampersand), not "Garner and Tow".';

async function main() {
  const admin = createAdminClient();
  const { data: site } = await admin
    .from("sites").select("id").eq("domain", "garnerandtow.com").limit(1).single();
  if (!site) throw new Error("garnerandtow site row missing");
  const goal: Goal = {
    siteId: site.id,
    target: { scope: "site", requireTypes: [], minOutcome: "rich_results_eligible" },
    constraints: { maxPages: 1, allowSchemaTypeChange: false },
    autonomy: "auto_apply",
  };

  // 0. Generate the page's schema fresh (what the agent would stage today).
  console.log("1) generating fresh schema for", URL);
  const first = await executeTask(goal, {
    url: URL, kind: "fix", beforeErrorCount: 1, beforeHadSchema: true,
    requirements: [
      { type: "Product", outcome: "rich_results_eligible" },
      { type: "BreadcrumbList", outcome: "rich_results_eligible" },
    ],
  });
  const staged = first.entry?.jsonld;
  if (!staged) throw new Error(`no staged entry: ${first.action.outcome}`);
  const products = (Array.isArray(staged) ? staged : [staged]) as Record<string, unknown>[];
  const product = products.find((s) => s["@type"] === "Product")!;
  console.log("   staged brand:", JSON.stringify((product as { brand?: unknown }).brand));

  // 1. Merchant speaks; the LLM proposes edits.
  console.log("2) merchant:", MESSAGE);
  const edits = await proposeOverrideEdits({
    currentJsonld: product, schemaType: "Product", url: URL, message: MESSAGE,
  });
  console.log("   proposed edits:", JSON.stringify(edits));

  // 2. Deterministic apply + validation gate (what the chat endpoint does).
  const overrideInputs = edits.map((e) => ({
    schemaType: "Product", fieldPath: e.fieldPath, value: e.value,
  }));
  const { result, applied, conflicts } = applyOverrides(product, overrideInputs);
  if (conflicts.length) throw new Error("conflicts: " + JSON.stringify(conflicts));
  const validation = validateSchema(result as Record<string, unknown>);
  console.log(`3) applied=${applied.length} valid=${validation.valid}`);
  if (!validation.valid) throw new Error("override made schema invalid — would be rejected");

  // 3. Persist as sticky overrides.
  for (const e of edits) {
    await saveOverride({
      siteId: site.id, url: URL, schemaType: "Product",
      fieldPath: e.fieldPath, value: e.value, source: "chat",
    });
  }
  const persisted = await loadOverrides(site.id, URL);
  console.log("4) persisted overrides:", persisted.map((o) => `${o.fieldPath}=${JSON.stringify(o.value)}`));

  // 4. THE STICKY PROOF: a fresh agent run for this page must carry the override.
  console.log("5) fresh executor run (simulating a future re-run)…");
  const second = await executeTask(goal, {
    url: URL, kind: "fix", beforeErrorCount: 1, beforeHadSchema: true,
    requirements: [
      { type: "Product", outcome: "rich_results_eligible" },
      { type: "BreadcrumbList", outcome: "rich_results_eligible" },
    ],
  });
  const staged2 = second.entry?.jsonld;
  const products2 = (Array.isArray(staged2) ? staged2 : [staged2]) as Record<string, unknown>[];
  const product2 = products2.find((s) => s?.["@type"] === "Product");
  const brand2 = (product2 as { brand?: { name?: string } | string })?.brand;
  const brandName = typeof brand2 === "string" ? brand2 : brand2?.name;
  console.log("   re-run staged brand:", JSON.stringify(brand2));
  console.log("   outcome:", second.action.outcome);

  const ok = brandName === "Garner & Tow";
  console.log(ok
    ? "\nPASS: merchant correction survived a full regeneration (sticky override wins)"
    : "\nFAIL: override did not win on re-run");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(2); });
