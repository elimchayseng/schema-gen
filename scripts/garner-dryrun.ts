/**
 * Live ONE-SHOT DRY-RUN against garnerandtow.com — the POC proof artifact.
 *
 * What this exercises for real: full-site enumeration from the public sitemap
 * (scope "site", page-type matrix), live page scans (read-only GETs), the
 * extraction repair pipeline on the store's actually-broken product JSON-LD,
 * LLM generation + self-repair, and every deterministic gate (L0–L3).
 *
 * What it does NOT do: write anything anywhere (dryRun: true). The authoritative
 * dry-run analysis classifies block origins against the env dev-store theme
 * (garnerandtow has no provisioned credentials yet), so source classifications
 * in this run are indicative only — noted in the output.
 *
 * Run: npx tsx --env-file=.env.local scripts/garner-dryrun.ts
 */
import { runGoal } from "../src/lib/agent/run";
import { buildMerchantReport } from "../src/lib/agent/report";
import { createAdminClient } from "../src/lib/supabase";
import type { Goal } from "../src/lib/agent/types";
import { writeFileSync } from "node:fs";

const DOMAIN = "garnerandtow.com";

async function main() {
  const admin = createAdminClient();

  // Reuse any existing user (single-operator install) to own the site row.
  const { data: anySite, error: anyErr } = await admin
    .from("sites")
    .select("user_id")
    .limit(1)
    .single();
  if (anyErr || !anySite) throw new Error(`need at least one sites row: ${anyErr?.message}`);

  const { data: site, error: siteErr } = await admin
    .from("sites")
    .upsert(
      { user_id: anySite.user_id, domain: DOMAIN },
      { onConflict: "user_id,domain" }
    )
    .select("id")
    .single();
  if (siteErr || !site) throw new Error(`site upsert failed: ${siteErr?.message}`);
  console.log(`site row: ${site.id} (${DOMAIN})`);

  const goal: Goal = {
    siteId: site.id,
    target: { scope: "site", requireTypes: [], minOutcome: "rich_results_eligible" },
    constraints: { maxPages: 30, allowSchemaTypeChange: false },
    autonomy: "auto_apply",
  };

  const t0 = Date.now();
  const result = await runGoal(goal, {
    dryRun: true,
    // 2, not 4: each page fans out several refinement calls; halving the page
    // fan-out keeps the inference endpoint under its congestion threshold.
    concurrency: 2,
    onProgress: (ev) => {
      const bits = [
        ev.phase,
        ev.url ?? "",
        ev.outcome ?? "",
        ev.message ?? "",
        ev.perceived != null ? `perceived=${ev.perceived}` : "",
        ev.queued != null ? `queued=${ev.queued}` : "",
        ev.satisfied != null ? `ok=${ev.satisfied}` : "",
        ev.unsatisfied != null ? `bad=${ev.unsatisfied}` : "",
      ].filter(Boolean);
      console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...bits);
    },
  });
  const secs = Math.round((Date.now() - t0) / 1000);

  console.log("\n========== RUN RESULT ==========");
  console.log(`status=${result.status} in ${secs}s  runId=${result.runId}`);
  console.log(`satisfied=${result.satisfied.length} unsatisfied=${result.unsatisfied.length} skipped=${result.skipped.length}`);
  if (result.haltedBy) console.log(`haltedBy=${result.haltedBy}`);
  for (const u of result.unsatisfied) console.log(`  UNSATISFIED: ${u}`);

  if (result.runId) {
    const { data: run } = await admin
      .from("agent_runs").select("*").eq("id", result.runId).single();
    const { data: actions } = await admin
      .from("agent_actions").select("*").eq("run_id", result.runId)
      .order("created_at", { ascending: true });
    if (run && actions) {
      const report = buildMerchantReport(run, actions);
      writeFileSync(
        "docs/agent/garner-dryrun-report.json",
        JSON.stringify({ generatedAt: new Date().toISOString(), durationSecs: secs, report }, null, 2)
      );
      console.log("\nverdict:", report.verdict.headline, "—", report.verdict.reason);
      console.log("summary:", JSON.stringify(report.summary));
      for (const a of report.requiredMerchantActions) console.log("  ACTION:", a);
      console.log("report written: docs/agent/garner-dryrun-report.json");
    }
  }
  if (result.stagedSnippet) {
    writeFileSync("docs/agent/garner-dryrun-snippet.liquid", result.stagedSnippet);
    console.log("staged snippet written: docs/agent/garner-dryrun-snippet.liquid");
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
