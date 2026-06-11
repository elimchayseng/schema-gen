/**
 * Audit trail writes for agent runs (plan §8). Append-only agent_actions, one
 * agent_runs row per execution. Server-only via the service-role client.
 */
import { createAdminClient } from "@/lib/supabase";
import type {
  ActionRecord,
  AgentProgressEvent,
  Goal,
  HaltSignal,
} from "./types";

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

/**
 * Persist the run's resolved target URL list (issue #27, migration 010). Written once,
 * right after resolveTargetUrls, so the merchant report can compute notReached exactly
 * for ANY scope — not just url_list goals. Callers treat this like the other audit
 * writes: best-effort (warn + continue on failure).
 */
export async function saveResolvedUrls(
  runId: string,
  urls: string[]
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("agent_runs")
    .update({ resolved_urls: urls })
    .eq("id", runId);
  if (error) {
    throw new Error(`Failed to save resolved_urls: ${error.message}`);
  }
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

/**
 * Idempotent resume (Phase 5, plan §7 item 5). Returns the set of URLs this run has
 * already COMMITTED to the live theme — i.e. an `l4_pass` verify row exists (apply.ts
 * records one per item once its live render verified). A resumed run drops these from
 * its queue so a committed page is never re-processed.
 *
 * Best-effort, like readControl: any read failure degrades to an empty set, so a
 * transient Supabase hiccup can never make a fresh run *look* fully committed and skip
 * everything. In dry-run nothing is committed, so this is naturally empty.
 */
export async function loadCommittedUrls(runId: string): Promise<Set<string>> {
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("agent_actions")
      .select("url")
      .eq("run_id", runId)
      .eq("action", "verify")
      .eq("outcome", "l4_pass");
    if (error || !data) return new Set();
    return new Set((data as { url: string }[]).map((r) => r.url));
  } catch {
    return new Set();
  }
}

/**
 * Persist the latest step event to agent_runs.last_step (migration 013) so a
 * reconnecting client — or anyone reading GET /api/agent/run/[id] — can see exactly
 * where the run is (or where it was when it stalled) without the SSE stream.
 * Unlike the other audit writes this one swallows its own failures: it is called
 * from the hot emit path on every checkpoint, and a missing column (migration not
 * applied) must never break a run or even reach the caller.
 */
export async function recordStep(
  runId: string,
  ev: AgentProgressEvent
): Promise<void> {
  try {
    const supabase = createAdminClient();
    await supabase
      .from("agent_runs")
      .update({
        last_step: {
          phase: ev.phase,
          step: ev.step ?? null,
          status: ev.status ?? null,
          url: ev.url ?? null,
          detail: ev.detail ?? null,
          durationMs: ev.durationMs ?? null,
          at: new Date().toISOString(),
        },
      })
      .eq("id", runId);
  } catch {
    /* best-effort by design */
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
 * halt; anything else is treated as "run".
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

/** Write the control signal. "kill" halts at the next checkpoint; "run" clears it. */
export async function setControl(
  runId: string,
  control: "run" | "kill"
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
