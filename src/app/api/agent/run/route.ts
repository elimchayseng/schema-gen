import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { runGoal, createRun, readControl, setControl } from "@/lib/agent";
import type {
  AgentProgressEvent,
  Goal,
  GoalScope,
  MinOutcome,
} from "@/lib/agent";

/**
 * POST /api/agent/run — start an agent run and stream its progress via SSE.
 *
 * Mirrors the `fix-all` streaming pattern, but the WHOLE goal runs inside this one
 * long-lived request: runGoal drives perceive → plan → act → (live apply) and its
 * onProgress events are forwarded verbatim as SSE `data:` lines. The first event carries
 * the runId so the client can target the control route (`/api/agent/run/[id]`) to kill it.
 *
 * Cancellation: the control route writes agent_runs.control='kill'; runGoal polls it via
 * readControl at each checkpoint and stops BEFORE the atomic apply, so a kill never leaves
 * a half-written theme. The request's AbortSignal (client disconnect) is a secondary kill.
 *
 * dryRun defaults to TRUE. Going live requires the body to explicitly send dryRun:false.
 */
const VALID_SCOPES: GoalScope[] = ["all_products", "all_pages", "url_list"];
const VALID_OUTCOMES: MinOutcome[] = ["valid", "rich_results_eligible"];

interface RunRequestBody {
  siteId?: string;
  dryRun?: boolean;
  target?: {
    scope?: string;
    urls?: string[];
    requireTypes?: string[];
    minOutcome?: string;
  };
  constraints?: {
    maxPages?: number;
    maxIterations?: number;
    maxCostUsd?: number;
    allowSchemaTypeChange?: boolean;
  };
}

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: RunRequestBody;
  try {
    body = (await request.json()) as RunRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { siteId, target, constraints } = body;
  if (!siteId) {
    return NextResponse.json({ error: "siteId is required" }, { status: 400 });
  }

  // Ownership: the site must belong to the authenticated user.
  const { data: site, error: siteError } = await supabase
    .from("sites")
    .select("id")
    .eq("id", siteId)
    .eq("user_id", user.id)
    .single();
  if (siteError || !site) {
    return NextResponse.json({ error: "Site not found" }, { status: 404 });
  }

  // Validate + build the Goal.
  const scope = target?.scope as GoalScope | undefined;
  if (!scope || !VALID_SCOPES.includes(scope)) {
    return NextResponse.json(
      { error: `target.scope must be one of ${VALID_SCOPES.join(", ")}` },
      { status: 400 }
    );
  }
  const minOutcome = (target?.minOutcome ?? "valid") as MinOutcome;
  if (!VALID_OUTCOMES.includes(minOutcome)) {
    return NextResponse.json(
      { error: `target.minOutcome must be one of ${VALID_OUTCOMES.join(", ")}` },
      { status: 400 }
    );
  }
  const requireTypes = target?.requireTypes ?? [];
  if (!Array.isArray(requireTypes) || requireTypes.length === 0) {
    return NextResponse.json(
      { error: "target.requireTypes must be a non-empty array" },
      { status: 400 }
    );
  }
  if (scope === "url_list" && (!target?.urls || target.urls.length === 0)) {
    return NextResponse.json(
      { error: "target.urls is required when scope is url_list" },
      { status: 400 }
    );
  }

  const goal: Goal = {
    siteId,
    target: {
      scope,
      urls: scope === "url_list" ? target?.urls : undefined,
      requireTypes,
      minOutcome,
    },
    constraints: {
      maxPages: constraints?.maxPages,
      maxIterations: constraints?.maxIterations,
      maxCostUsd: constraints?.maxCostUsd,
      allowSchemaTypeChange: constraints?.allowSchemaTypeChange ?? false,
    },
    autonomy: "auto_apply",
  };

  // dryRun defaults TRUE — only an explicit false goes live (writes the theme).
  const dryRun = body.dryRun !== false;

  // Create the run row FIRST so the route can poll its control flag and return the id in
  // the first event. runGoal is then told to use this id (it skips its own createRun).
  let runId: string;
  try {
    runId = await createRun(goal);
  } catch (e) {
    return NextResponse.json(
      { error: `Failed to start run: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (data: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true; // client went away; runGoal halts via signal/control
        }
      };

      try {
        const result = await runGoal(goal, {
          runId,
          dryRun,
          onProgress: (ev: AgentProgressEvent) => send({ ...ev }),
          shouldHalt: () => readControl(runId),
          signal: request.signal,
        });

        send({
          step: "done",
          phase: "done",
          runId: result.runId,
          status: result.status,
          killed: result.killed ?? false,
          dryRun,
          pagesTouched: result.pagesTouched,
          satisfied: result.satisfied,
          unsatisfied: result.unsatisfied,
          skipped: result.skipped,
          haltedBy: result.haltedBy ?? null,
          stagedSnippet: result.stagedSnippet,
          apply: result.apply ?? null,
        });
      } catch (e) {
        send({
          step: "error",
          phase: "done",
          runId,
          status: "failed",
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        closed = true;
        // On client disconnect the stream is already cancelled and close() throws;
        // swallow it so the async start() never rejects unhandled.
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    // Client disconnect → deterministically stop the run. request.signal is unreliable
    // for streamed responses, so the cancel hook (the reliable disconnect signal) writes
    // the DB control flag the loop polls. Best-effort; an already-finished run is a no-op.
    async cancel() {
      try {
        await setControl(runId, "kill");
      } catch {
        /* best-effort */
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
