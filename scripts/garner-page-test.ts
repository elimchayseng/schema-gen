/**
 * Targeted live test: run ONLY the pages that failed the last full garnerandtow
 * dry-run through the real executor path (processPage optimize → fix → LLM
 * repair → gates L0–L3) with their page-type-matrix requirements. Read-only,
 * no audit rows, no theme writes — minutes instead of the full-site run.
 *
 * Run: npx tsx --env-file=.env.local scripts/garner-page-test.ts
 */
import { executeTask } from "../src/lib/agent/executor";
import {
  classifyPageType,
  requirementsForPage,
} from "../src/lib/agent/page-type-matrix";
import { createAdminClient } from "../src/lib/supabase";
import type { Goal } from "../src/lib/agent/types";

const URLS = [
  "https://garnerandtow.com/blogs/press/urban-cycling-in-fall-what-to-pack-and-wear",
  "https://garnerandtow.com/blogs/press/the-art-of-packing-light-commuter-edition",
  "https://garnerandtow.com/blogs/press/the-5-items-i-never-ride-without",
  "https://garnerandtow.com/blogs/press/why-we-made-the-everyday-line",
  "https://garnerandtow.com/pages/about",
  "https://garnerandtow.com/pages/contact",
];

async function main() {
  const admin = createAdminClient();
  const { data: site } = await admin
    .from("sites")
    .select("id")
    .eq("domain", "garnerandtow.com")
    .limit(1)
    .single();
  if (!site) throw new Error("garnerandtow.com site row missing — run garner-dryrun first");

  const goal: Goal = {
    siteId: site.id,
    target: { scope: "site", requireTypes: [], minOutcome: "rich_results_eligible" },
    constraints: { maxPages: URLS.length, allowSchemaTypeChange: false },
    autonomy: "auto_apply",
  };

  let passed = 0;
  for (const url of URLS) {
    const pageType = classifyPageType(url);
    const requirements = pageType
      ? requirementsForPage(pageType, goal.target.minOutcome)
      : [];
    const t0 = Date.now();
    const ex = await executeTask(goal, {
      url,
      kind: "generate",
      beforeErrorCount: 0,
      beforeHadSchema: false,
      requirements,
    });
    const secs = Math.round((Date.now() - t0) / 1000);
    const ok = ex.satisfied;
    passed += ok ? 1 : 0;
    console.log(
      `${ok ? "PASS" : "FAIL"} (${secs}s) ${url.replace("https://garnerandtow.com", "")}`
    );
    console.log(`     requirements: ${requirements.map((r) => `${r.type}@${r.outcome}`).join(", ")}`);
    console.log(`     outcome: ${ex.action.outcome}`);
    if (!ok && ex.action.gates) {
      for (const [k, v] of Object.entries(ex.action.gates)) {
        if (v && typeof v === "object" && "passed" in v && !v.passed) {
          console.log(`     ${k} FAILED: ${(v as { detail?: string }).detail}`);
        }
      }
    }
  }
  console.log(`\n${passed}/${URLS.length} previously-failing pages now pass`);
  process.exit(passed === URLS.length ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
