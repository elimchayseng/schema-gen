import { createAdminClient } from "../src/lib/supabase";
async function main() {
  const admin = createAdminClient();
  for (const t of ["shopify_credentials", "merchant_overrides", "theme_backups", "agent_runs"]) {
    const { error } = await admin.from(t).select("*").limit(1);
    console.log(t.padEnd(24), error ? "MISSING: " + error.message.slice(0, 60) : "EXISTS");
  }
  const { error: e2 } = await admin.from("sites").select("shop_domain").limit(1);
  console.log("sites.shop_domain".padEnd(24), e2 ? "MISSING" : "EXISTS");
  const { error: e3 } = await admin.from("agent_runs").select("resolved_urls").limit(1);
  console.log("agent_runs.resolved_urls".padEnd(24), e3 ? "MISSING" : "EXISTS");
}
main();
