import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase-server";
import { runGoal, createRun, readControl } from "@/lib/agent";
import type {
  AgentProgressEvent,
  Goal,
  GoalScope,
  MinOutcome,
  WriteThemeStrategy,
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
 * a half-written theme. A TRANSPORT drop is deliberately NOT a kill: live runs outlast any
 * single HTTP connection (Node's server.requestTimeout severs streamed responses at ~300s,
 * observed live mid-theme-duplicate), so the run continues server-side and persists its
 * result; the dashboard reconnects via GET /api/agent/run/[id] polling. Stopping a run is
 * an explicit act (the Stop button → control route), never an inference from a dead socket.
 *
 * dryRun defaults to TRUE. Going live requires the body to explicitly send dryRun:false.
 */
const VALID_SCOPES: GoalScope[] = ["site", "all_products", "all_pages", "url_list"];
const VALID_OUTCOMES: MinOutcome[] = ["valid", "rich_results_eligible"];

/**
 * Client-friendly string enum for RunOptions.writeTheme (issues #25/#26).
 * "env" (default) keeps today's SHOPIFY_TEST_THEME_ID behavior; the staging
 * modes duplicate the published theme and require the site to have a connected
 * shop (sites.shop_domain set via /api/agent/provision).
 */
const VALID_WRITE_THEMES = ["env", "staging", "staging_publish"] as const;
type WriteThemeParam = (typeof VALID_WRITE_THEMES)[number];

interface RunRequestBody {
  siteId?: string;
  dryRun?: boolean;
  writeTheme?: string;
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

  // Ownership: the site must belong to the authenticated user. shop_domain
  // rides along so the staging write modes can verify the site is provisioned.
  const { data: site, error: siteError } = await supabase
    .from("sites")
    .select("id, shop_domain")
    .eq("id", siteId)
    .eq("user_id", user.id)
    .single();
  if (siteError || !site) {
    return NextResponse.json({ error: "Site not found" }, { status: 404 });
  }

  // writeTheme: client-friendly string enum → RunOptions.WriteThemeStrategy.
  const writeThemeParam = (body.writeTheme ?? "env") as WriteThemeParam;
  if (!VALID_WRITE_THEMES.includes(writeThemeParam)) {
    return NextResponse.json(
      { error: `writeTheme must be one of ${VALID_WRITE_THEMES.join(", ")}` },
      { status: 400 }
    );
  }
  const siteShopDomain =
    (site as { shop_domain?: string | null }).shop_domain ?? null;
  if (writeThemeParam !== "env" && !siteShopDomain) {
    return NextResponse.json(
      {
        error:
          "Staging requires a connected Shopify store. Provision this site first " +
          "(POST /api/agent/provision with shopDomain, appKey, and appSecret).",
      },
      { status: 400 }
    );
  }
  const writeTheme: WriteThemeStrategy =
    writeThemeParam === "env"
      ? { mode: "env" }
      : { mode: "staging", publish: writeThemeParam === "staging_publish" };

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
  // Scope "site" derives per-page required types from the page-type matrix
  // (issue #28), so requireTypes is optional there; every other scope keeps the
  // pre-existing non-empty requirement unchanged.
  const requireTypes = target?.requireTypes ?? [];
  if (
    !Array.isArray(requireTypes) ||
    (scope !== "site" && requireTypes.length === 0)
  ) {
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

      // HEARTBEAT — the run has long phases that emit no progress for minutes
      // (theme duplicate is O(assets) Admin API calls; post-publish verification
      // polls the storefront cache). An SSE connection with no bytes in flight
      // gets idle-killed by the HTTP stack (observed live: the browser saw
      // "fetch failed" mid-duplicate, the cancel hook killed the run, and a
      // half-copied theme was orphaned). SSE comment lines (": …") are ignored
      // by EventSource and skipped by the dashboard's parser, so this keeps the
      // pipe warm without touching event semantics.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: keepalive\n\n`));
        } catch {
          closed = true;
        }
      }, 15_000);

      try {
        const result = await runGoal(goal, {
          runId,
          dryRun,
          writeTheme,
          onProgress: (ev: AgentProgressEvent) => send({ ...ev }),
          shouldHalt: () => readControl(runId),
          // No request.signal: a dropped connection must not abort live Shopify
          // work mid-flight (it orphaned a half-copied staging theme when it did).
          // Kills are explicit via the control route only.
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
          staging: result.staging ?? null,
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
        clearInterval(heartbeat);
        // On client disconnect the stream is already cancelled and close() throws;
        // swallow it so the async start() never rejects unhandled.
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    // Client disconnect is NOT a kill (see header). The HTTP stack severs long
    // streams (~300s requestTimeout) even with heartbeats flowing; killing here
    // turned every long staging phase into a dead run. The run finishes and
    // persists server-side; the dashboard resyncs by polling the control route.
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
