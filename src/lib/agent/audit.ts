/**
 * Audit trail writes for agent runs (plan §8). Append-only agent_actions, one
 * agent_runs row per execution. Server-only via the service-role client.
 */
import { createAdminClient } from "@/lib/supabase";
import type { ActionRecord, Goal } from "./types";

export async function createRun(goal: Goal): Promise<string> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("agent_runs")
    .insert({
      site_id: goal.siteId,
      goal,
      status: "running",
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) {
    throw new Error(`Failed to create agent_run: ${error.message}`);
  }
  return (data as { id: string }).id;
}

export async function recordAction(
  runId: string,
  a: ActionRecord
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.from("agent_actions").insert({
    run_id: runId,
    url: a.url,
    action: a.action,
    schema_before: a.schemaBefore ?? null,
    schema_after: a.schemaAfter ?? null,
    gates: a.gates ?? null,
    write_target: a.writeTarget ?? null,
    outcome: a.outcome,
    cost_usd: a.costUsd ?? 0,
  });
  if (error) {
    throw new Error(`Failed to record agent_action: ${error.message}`);
  }
}

export interface FinishRunFields {
  status: "done" | "failed";
  iterations: number;
  pagesTouched: number;
  costUsd: number;
  error: string | null;
}

export async function finishRun(
  runId: string,
  fields: FinishRunFields
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("agent_runs")
    .update({
      status: fields.status,
      iterations: fields.iterations,
      pages_touched: fields.pagesTouched,
      cost_usd: fields.costUsd,
      ended_at: new Date().toISOString(),
      error: fields.error,
    })
    .eq("id", runId);
  if (error) {
    throw new Error(`Failed to finish agent_run: ${error.message}`);
  }
}
