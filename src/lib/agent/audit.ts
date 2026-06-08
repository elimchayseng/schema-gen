/**
 * Audit trail writes for agent runs (plan §8). Append-only agent_actions, one
 * agent_runs row per execution. Server-only via the service-role client.
 */
import { createAdminClient } from "@/lib/supabase";
import type { ActionRecord, Goal, HaltSignal } from "./types";

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

/**
 * Read the cross-request control signal (agent_runs.control) the run loop polls at each
 * checkpoint. Best-effort: any read failure degrades to "run" so a transient Supabase
 * hiccup can never accidentally halt an otherwise-healthy run. Only "kill" maps to a
 * halt; "pause" (Phase 5, not yet wired) and anything else are treated as "run".
 */
export async function readControl(runId: string): Promise<HaltSignal> {
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("agent_runs")
      .select("control")
      .eq("id", runId)
      .single();
    if (error || !data) return "run";
    return (data as { control: string }).control === "kill" ? "kill" : "run";
  } catch {
    return "run";
  }
}

/** Write the control signal. The control route uses this; resume/pause map to "run". */
export async function setControl(
  runId: string,
  control: "run" | "pause" | "kill"
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("agent_runs")
    .update({ control })
    .eq("id", runId);
  if (error) {
    throw new Error(`Failed to set agent_run control: ${error.message}`);
  }
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
