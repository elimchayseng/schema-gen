import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const r = await admin.from("agent_runs").select("*").order("started_at", { ascending: false }).limit(1);
if (r.error) { console.error("runs error:", r.error.message); process.exit(1); }
const run = r.data[0];
console.log("run:", run.id, "| status:", run.status, "| error:", run.error ?? "none");
const a = await admin.from("agent_actions").select("*").eq("run_id", run.id).order("created_at");
if (a.error) { console.error("actions error:", a.error.message); process.exit(1); }
for (const x of a.data) console.log(`  ${String(x.action).padEnd(16)} ${String(x.outcome).slice(0, 100)}`);
