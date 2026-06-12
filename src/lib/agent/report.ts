/**
 * Merchant report (issue #30). buildMerchantReport folds the raw audit trail —
 * one agent_runs row plus its append-only agent_actions rows — into the
 * readable artifact backing "you're good to go": per-page dispositions,
 * plain-English gate verdicts, before/after schema, required merchant actions,
 * and a per-page Google Rich Results deep link.
 *
 * Pure and deterministic: no I/O, no Supabase, no network. Google has no
 * public Rich Results Test API, so "proof" is two clearly separated labels:
 * our own deterministic verdict ("Validated by SchemaGen, gates L0–L4") and a
 * per-page deep link the merchant clicks to confirm with Google themselves.
 */
import { classifyPageType, PAGE_TYPE_MATRIX } from "./page-type-matrix";
import type { GateResults } from "./types";

// ---- Input row shapes (snake_case, exactly as the two tables store them) ----

export interface AgentRunRow {
  id: string;
  site_id: string | null;
  goal: {
    target?: {
      scope?: string;
      urls?: string[];
      requireTypes?: string[];
      minOutcome?: string;
    };
  } | null;
  status: string;
  pages_touched?: number;
  cost_usd?: number;
  started_at: string;
  ended_at: string | null;
  error: string | null;
  /**
   * The concrete URL list the run resolved its scope to (migration 010, issue #27).
   * When present it is the exact notReached baseline; absent (older runs) the report
   * falls back to goal.target.urls for url_list goals, as before.
   */
  resolved_urls?: string[] | null;
}

export interface AgentActionRow {
  url: string;
  // generate | fix | write | verify | rollback | skip | suppress | merchant_action | publish
  action: string;
  schema_before: unknown;
  schema_after: unknown;
  gates: GateResults | null;
  write_target: string | null;
  outcome: string;
  created_at?: string;
}

// ---- Output shape ----

export type PageDisposition =
  | "already_good"
  | "fixed"
  | "generated"
  | "failed"
  | "rolled_back"
  | "skipped";

export type GateLevel = "L0" | "L1" | "L2" | "L3" | "L4";

/** One gate verdict with its plain-English label. passed=null → not evaluated. */
export interface ReportGate {
  level: GateLevel;
  label: string;
  passed: boolean | null;
  detail?: string;
}

export interface ReportPage {
  url: string;
  disposition: PageDisposition;
  /** Schema.org @type values the page carries after the run (or before, if nothing changed). */
  schemaTypes: string[];
  gates: ReportGate[];
  before?: unknown;
  after?: unknown;
  /** "Confirm with Google" deep link (no public API — the merchant clicks through). */
  googleTestUrl: string;
  failureReason?: string;
  /** Optional plain-English context, e.g. "Self-corrected in 2 passes". */
  note?: string;
}

export interface MerchantReport {
  runId: string;
  siteDomain?: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  /** The headline the merchant reads first. */
  verdict: { goodToGo: boolean; headline: string; reason: string };
  summary: {
    pagesChecked: number;
    alreadyGood: number;
    fixed: number;
    generated: number;
    failed: number;
    notReached: number;
  };
  pages: ReportPage[];
  /** Empty when there is nothing the merchant must do. */
  requiredMerchantActions: string[];
  /**
   * Staging mode (issue #26): set when this run PUBLISHED its verified staging
   * theme (a `publish` action row). The fixes are live — no publish step remains.
   */
  publishedThemeId?: string;
  /** The two proof labels, kept verbatim so the UI can never blur the line. */
  proof: { schemaGenLabel: string; googleLabel: string };
}

export const SCHEMAGEN_PROOF_LABEL =
  "Validated by SchemaGen (deterministic gates L0–L4)";
export const GOOGLE_PROOF_LABEL = "Confirm with Google";

const GATE_LABELS: Record<GateLevel, string> = {
  L0: "Built",
  L1: "Valid",
  L2: "Rich-eligible",
  L3: "No-regression",
  L4: "Live-verified",
};

export function googleRichResultsUrl(pageUrl: string): string {
  return `https://search.google.com/test/rich-results?url=${encodeURIComponent(pageUrl)}`;
}

// ---- Helpers ----

/** Collect schema.org @type values from a JSON-LD value (object, array, or @graph). */
function extractSchemaTypes(value: unknown): string[] {
  const types = new Set<string>();
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (v === null || typeof v !== "object") return;
    const obj = v as Record<string, unknown>;
    const t = obj["@type"];
    if (typeof t === "string") types.add(t);
    else if (Array.isArray(t)) {
      for (const x of t) if (typeof x === "string") types.add(x);
    }
    if (Array.isArray(obj["@graph"])) visit(obj["@graph"]);
  };
  visit(value);
  return [...types];
}

function isNonEmptySchema(value: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "object" && Object.keys(value).length > 0;
}

/** The hostname most pages share — best-effort, derived from the action URLs. */
function deriveSiteDomain(urls: string[]): string | undefined {
  for (const u of urls) {
    try {
      return new URL(u).hostname;
    } catch {
      /* try the next one */
    }
  }
  return undefined;
}

/** The schema types the goal expects of one URL (matrix-driven for scope "site"). */
function expectedTypesFor(run: AgentRunRow, url: string): string[] {
  if (run.goal?.target?.scope === "site") {
    const pageType = classifyPageType(url);
    return pageType ? PAGE_TYPE_MATRIX[pageType].map((r) => r.type) : [];
  }
  return run.goal?.target?.requireTypes ?? [];
}

/**
 * Translate one merchant_action audit row (authoritative mode, issues #22/#23/#26)
 * into the plain-English action the merchant reads. The outcome string is the
 * structured form the orchestrator/apply recorded:
 *   external_schema:<type|unparseable>:<url>  — app/ScriptTag-injected block we
 *                                               cannot remove via theme edits
 *   not_suppressible:<assetKey>:<reason>      — theme block suppress.ts refused
 *                                               (fails closed; asset untouched)
 *   publish_failed:<themeId>:<message>        — verified staging theme exists but
 *                                               the atomic swap failed
 */
function humanizeMerchantAction(outcome: string): string {
  if (outcome.startsWith("external_schema:")) {
    const rest = outcome.slice("external_schema:".length);
    const sep = rest.indexOf(":");
    const type = sep === -1 ? rest : rest.slice(0, sep);
    const url = sep === -1 ? "" : rest.slice(sep + 1);
    const what =
      type === "unparseable"
        ? "broken structured data"
        : `${type} structured data`;
    return `An app injects ${what}${url ? ` on ${url}` : ""} that SchemaGen cannot remove via theme edits — disable that app's structured-data output to avoid duplicate markup.`;
  }
  if (outcome.startsWith("not_suppressible:")) {
    const rest = outcome.slice("not_suppressible:".length);
    const sep = rest.indexOf(":");
    const assetKey = sep === -1 ? rest : rest.slice(0, sep);
    const reason = sep === -1 ? "" : rest.slice(sep + 1);
    return `Your theme file ${assetKey} emits competing structured data that SchemaGen could not safely silence${reason ? ` (${reason})` : ""} — it was left untouched; remove that markup manually to avoid duplicates.`;
  }
  if (outcome.startsWith("publish_failed:")) {
    const rest = outcome.slice("publish_failed:".length);
    const sep = rest.indexOf(":");
    const themeId = sep === -1 ? rest : rest.slice(0, sep);
    const message = sep === -1 ? "" : rest.slice(sep + 1);
    return `The verified theme ${themeId} could not be published automatically${message ? ` (${message})` : ""} — publish it manually in Online Store → Themes; everything on it has already passed verification.`;
  }
  return outcome;
}

function humanizeFailure(outcome: string, gates: GateResults | null): string {
  if (outcome.startsWith("processing_failed:")) {
    return `Processing failed: ${outcome.slice("processing_failed:".length).trim()}`;
  }
  if (outcome === "gate_failed") {
    const firstFail = gates
      ? (["L0", "L1", "L2", "L3"] as const).find((l) => {
          const g = gates[l];
          return g != null && !g.passed;
        })
      : undefined;
    const detail = firstFail ? gates?.[firstFail]?.detail : undefined;
    const label = firstFail ? ` (${GATE_LABELS[firstFail]} gate)` : "";
    return `The generated schema did not pass SchemaGen's quality gates${label}${detail ? `: ${detail}` : ""}`;
  }
  return outcome;
}

/** Fold an act row's stored gates + the page's L4 verdict into labeled gates. */
function buildGates(
  gates: GateResults | null,
  l4: { passed: boolean; detail?: string } | null
): ReportGate[] {
  const levels: GateLevel[] = ["L0", "L1", "L2", "L3", "L4"];
  return levels.map((level) => {
    if (level === "L4") {
      return {
        level,
        label: GATE_LABELS.L4,
        passed: l4 ? l4.passed : (gates?.L4?.passed ?? null),
        ...((l4?.detail ?? gates?.L4?.detail)
          ? { detail: l4?.detail ?? gates?.L4?.detail }
          : {}),
      };
    }
    const g = gates?.[level] ?? null;
    return {
      level,
      label: GATE_LABELS[level],
      passed: g === null || g === undefined ? null : g.passed,
      ...(g?.detail ? { detail: g.detail } : {}),
    };
  });
}

/** Gates for a page that was already good: nothing built, live state already valid. */
function alreadyGoodGates(richRequired: boolean): ReportGate[] {
  return [
    { level: "L0", label: GATE_LABELS.L0, passed: null },
    {
      level: "L1",
      label: GATE_LABELS.L1,
      passed: true,
      detail: "Live schema already valid — nothing to change",
    },
    {
      level: "L2",
      label: GATE_LABELS.L2,
      passed: richRequired ? true : null,
      ...(richRequired
        ? { detail: "Live schema already eligible for rich results" }
        : {}),
    },
    { level: "L3", label: GATE_LABELS.L3, passed: null },
    { level: "L4", label: GATE_LABELS.L4, passed: null },
  ];
}

// ---- Per-URL fold ----

interface UrlActions {
  url: string;
  skips: AgentActionRow[];
  acts: AgentActionRow[]; // generate | fix
  verifies: AgentActionRow[]; // l4_pass | l4_fail
}

function groupByUrl(actions: AgentActionRow[]): Map<string, UrlActions> {
  const byUrl = new Map<string, UrlActions>();
  for (const a of actions) {
    let g = byUrl.get(a.url);
    if (!g) {
      g = { url: a.url, skips: [], acts: [], verifies: [] };
      byUrl.set(a.url, g);
    }
    if (a.action === "skip") g.skips.push(a);
    else if (a.action === "generate" || a.action === "fix") g.acts.push(a);
    else if (a.action === "verify") g.verifies.push(a);
    // "write" and "rollback" rows are footprint-level; handled at run level below.
  }
  return byUrl;
}

// ---- The report builder ----

export function buildMerchantReport(
  run: AgentRunRow,
  actions: AgentActionRow[]
): MerchantReport {
  // Defensive ordering: dispositions use the LAST act/verify row per page, so a
  // caller passing unsorted rows must not flip "repaired then passed" into "failed".
  const ordered = [...actions].sort((a, b) =>
    (a.created_at ?? "") < (b.created_at ?? "") ? -1 : 1
  );

  const richRequired = run.goal?.target?.minOutcome === "rich_results_eligible";

  // Run-level rollback signals. Rollback is whole-footprint atomic (apply.ts), so a
  // single rollback row means EVERY staged page was reverted — not just the row's url.
  const rollbackRows = ordered.filter((a) => a.action === "rollback");
  const rolledBack = rollbackRows.some((a) => a.outcome.startsWith("rolled_back"));
  const rollbackFailed = rollbackRows.some((a) =>
    a.outcome.startsWith("rollback_failed")
  );
  const rollbackCause = rollbackRows[rollbackRows.length - 1]?.outcome;

  // Authoritative-mode rows (issues #22/#23/#26). suppress rows mean SchemaGen took
  // ownership of competing theme markup (the dup gate verified exactly one block per
  // type), merchant_action rows are the things only the merchant can do, and a
  // publish row means the verified staging theme was swapped live.
  const suppressRows = ordered.filter((a) => a.action === "suppress");
  const merchantActionRows = ordered.filter((a) => a.action === "merchant_action");
  const publishRow = ordered.filter((a) => a.action === "publish").pop() ?? null;
  const publishedThemeId = publishRow?.write_target ?? undefined;

  const byUrl = groupByUrl(ordered);
  const pages: ReportPage[] = [];
  let stagedNotApplied = 0;
  let fixedOverExistingSchema = 0;
  const publishTargets = new Set<string>();

  for (const g of byUrl.values()) {
    const act = g.acts[g.acts.length - 1] ?? null;
    // The page's L4 verdict is the LAST l4_pass/l4_fail row. Post-publish
    // verification rows share the action kind "verify" but are RUN-level evidence
    // recorded against the first page's url — they must not displace that page's
    // actual L4 verdict (observed live: every published run reported its first
    // page as "previewed only" because post_publish:verified shadowed its l4_pass).
    const l4Row =
      [...g.verifies]
        .reverse()
        .find((v) => v.outcome === "l4_pass" || v.outcome === "l4_fail") ?? null;
    const l4: { passed: boolean; detail?: string } | null = l4Row
      ? {
          passed: l4Row.outcome === "l4_pass",
          ...(l4Row.gates?.L4?.detail
            ? { detail: l4Row.gates.L4.detail }
            : {}),
        }
      : null;
    const googleTestUrl = googleRichResultsUrl(g.url);

    // 1. Pages the planner never queued — their live schema already meets the goal.
    if (!act && g.skips.some((s) => s.outcome === "already_satisfied")) {
      pages.push({
        url: g.url,
        disposition: "already_good",
        schemaTypes: expectedTypesFor(run, g.url),
        gates: alreadyGoodGates(richRequired),
        googleTestUrl,
        note: "This page's structured data was already correct — nothing was changed.",
      });
      continue;
    }

    // 2. Committed by an earlier pass of this run (idempotent resume) — live-verified then.
    if (!act && g.skips.some((s) => s.outcome === "already_committed")) {
      pages.push({
        url: g.url,
        disposition: "fixed",
        schemaTypes: expectedTypesFor(run, g.url),
        gates: buildGates(null, { passed: true }),
        googleTestUrl,
        note: "Applied and live-verified earlier in this run.",
      });
      continue;
    }

    // 3. Pages the executor acted on.
    if (act) {
      const kind: PageDisposition = act.action === "generate" ? "generated" : "fixed";
      const staged = act.outcome.startsWith("staged");
      const before = isNonEmptySchema(act.schema_before)
        ? act.schema_before
        : undefined;
      const after = isNonEmptySchema(act.schema_after)
        ? act.schema_after
        : undefined;
      const schemaTypes = extractSchemaTypes(after ?? before ?? null);
      const selfCorrected = /self-corrected/.test(act.outcome);
      const base = {
        url: g.url,
        schemaTypes,
        before,
        after,
        googleTestUrl,
        ...(selfCorrected
          ? { note: "SchemaGen self-corrected this page until every gate passed." }
          : {}),
      };

      if (!staged) {
        pages.push({
          ...base,
          disposition: "failed",
          gates: buildGates(act.gates, l4),
          failureReason: humanizeFailure(act.outcome, act.gates),
        });
        continue;
      }

      if (rollbackFailed) {
        pages.push({
          ...base,
          disposition: "failed",
          gates: buildGates(act.gates, l4),
          failureReason:
            "Live verification could not complete and the automatic restore failed — this needs human attention before going live.",
        });
        continue;
      }

      if (rolledBack) {
        pages.push({
          ...base,
          disposition: "rolled_back",
          gates: buildGates(act.gates, l4),
          failureReason:
            l4 && !l4.passed
              ? `This page failed live verification, so every change in the run was reverted${l4.detail ? `: ${l4.detail}` : "."}`
              : `All changes were reverted because another page failed live verification${rollbackCause ? ` (${rollbackCause})` : "."}`,
        });
        continue;
      }

      if (l4?.passed) {
        if (l4Row?.write_target) publishTargets.add(l4Row.write_target);
        pages.push({ ...base, disposition: kind, gates: buildGates(act.gates, l4) });
        continue;
      }

      // Staged, gates passed, but never applied live (dry-run / killed pre-apply).
      stagedNotApplied += 1;
      pages.push({
        ...base,
        disposition: kind,
        gates: buildGates(act.gates, null).map((gate) =>
          gate.level === "L4"
            ? { ...gate, passed: null, detail: "Not applied live yet" }
            : gate
        ),
        note: `${"note" in base && base.note ? `${base.note} ` : ""}Previewed only — this fix has not been applied to your store yet.`,
      });
      continue;
    }

    // 4. Rows we can't attribute (e.g. only footprint-level write/verify rows).
    if (g.verifies.length > 0 && l4) {
      pages.push({
        url: g.url,
        disposition: l4.passed ? "fixed" : rolledBack ? "rolled_back" : "failed",
        schemaTypes: expectedTypesFor(run, g.url),
        gates: buildGates(null, l4),
        googleTestUrl,
        ...(l4.passed ? {} : { failureReason: l4.detail ?? "Failed live verification" }),
      });
      if (l4.passed && l4Row?.write_target) {
        publishTargets.add(l4Row.write_target);
      }
    }
  }

  // Pages the goal asked for that never produced an action row (run killed/halted
  // before reaching them). The persisted resolved_urls list (issue #27) makes this
  // exact for ANY scope; older runs without it fall back to url_list goal urls.
  const goalUrls =
    run.resolved_urls ??
    (run.goal?.target?.scope === "url_list" ? (run.goal.target.urls ?? []) : []);
  let notReached = 0;
  for (const u of goalUrls) {
    if (byUrl.has(u)) continue;
    notReached += 1;
    pages.push({
      url: u,
      disposition: "skipped",
      schemaTypes: [],
      gates: buildGates(null, null),
      googleTestUrl: googleRichResultsUrl(u),
      failureReason: "The run ended before this page was checked.",
    });
  }

  // Count fixed pages that still carry the theme/app's original markup.
  for (const p of pages) {
    if (p.disposition === "fixed" && isNonEmptySchema(p.before)) {
      fixedOverExistingSchema += 1;
    }
  }

  const counts = {
    alreadyGood: pages.filter((p) => p.disposition === "already_good").length,
    fixed: pages.filter((p) => p.disposition === "fixed").length,
    generated: pages.filter((p) => p.disposition === "generated").length,
    failed: pages.filter(
      (p) => p.disposition === "failed" || p.disposition === "rolled_back"
    ).length,
  };
  const summary = {
    pagesChecked: pages.length - notReached,
    ...counts,
    notReached,
  };

  // ---- Required merchant actions ----
  const requiredMerchantActions: string[] = [];
  if (rollbackFailed) {
    requiredMerchantActions.push(
      `Your theme may have been left in a partially-changed state: the automatic restore failed${run.error ? ` (${run.error})` : ""}. Contact support before publishing.`
    );
  }
  for (const themeId of publishTargets) {
    // A published theme needs no publish step — the publish row already covers it.
    if (themeId === publishedThemeId) continue;
    requiredMerchantActions.push(
      `Publish theme ${themeId} — the verified schema was applied to an unpublished (staged) theme and only reaches shoppers once that theme is published.`
    );
  }
  if (stagedNotApplied > 0) {
    requiredMerchantActions.push(
      `Apply the run live: ${stagedNotApplied} page${stagedNotApplied === 1 ? " has" : "s have"} verified fixes that are previewed only and not yet on your store.`
    );
  }
  // The merchant_action rows are the precise version of the duplicate warning
  // (authoritative mode names the exact app/asset), deduped on the structured outcome.
  const seenMerchantOutcomes = new Set<string>();
  for (const row of merchantActionRows) {
    if (seenMerchantOutcomes.has(row.outcome)) continue;
    seenMerchantOutcomes.add(row.outcome);
    requiredMerchantActions.push(humanizeMerchantAction(row.outcome));
  }
  // The generic duplicate warning only applies when authoritative mode did NOT run:
  // with suppressions executed (and the dup gate green) the original markup is gone,
  // and anything left was already named precisely by a merchant_action row above.
  const authoritativeRan =
    suppressRows.length > 0 || merchantActionRows.length > 0;
  if (fixedOverExistingSchema > 0 && !authoritativeRan) {
    requiredMerchantActions.push(
      `Your theme or an app still emits the original structured data on ${fixedOverExistingSchema} page${fixedOverExistingSchema === 1 ? "" : "s"}. SchemaGen adds a corrected copy but cannot remove the app's version — disable that app's schema output to avoid duplicates.`
    );
  }

  // ---- Verdict ----
  const allGood =
    pages.length > 0 &&
    summary.failed === 0 &&
    notReached === 0 &&
    !rollbackFailed &&
    (run.status === "done" || run.status === "running");
  const goodToGo = allGood && run.status === "done";

  let headline: string;
  let reason: string;
  if (goodToGo) {
    headline = "You're good to go";
    const parts: string[] = [];
    if (counts.alreadyGood > 0) parts.push(`${counts.alreadyGood} already correct`);
    if (counts.fixed > 0) parts.push(`${counts.fixed} fixed`);
    if (counts.generated > 0) parts.push(`${counts.generated} newly generated`);
    reason = `All ${summary.pagesChecked} page${summary.pagesChecked === 1 ? "" : "s"} checked now carry valid structured data${parts.length ? ` (${parts.join(", ")})` : ""}.${publishedThemeId ? " The verified theme was published to your live store." : ""}`;
  } else {
    headline = "Needs attention";
    if (run.status === "running") {
      reason = "This run is still in progress — results below are partial.";
    } else if (rollbackFailed) {
      reason =
        "The automatic restore failed and your theme needs a human look before anything is published.";
    } else if (rolledBack) {
      reason =
        "A page failed live verification, so every change was safely reverted — your store is unchanged.";
    } else if (summary.failed > 0) {
      reason = `${summary.failed} page${summary.failed === 1 ? "" : "s"} could not be brought up to standard${run.error ? ` (${run.error})` : "."}`;
    } else if (notReached > 0) {
      reason = `The run ended before ${notReached} page${notReached === 1 ? " was" : "s were"} checked${run.error ? ` (${run.error})` : "."}`;
    } else if (pages.length === 0) {
      reason = run.error
        ? `The run did not reach any pages (${run.error}).`
        : "The run did not reach any pages.";
    } else {
      reason = run.error ?? "The run did not finish cleanly.";
    }
  }

  return {
    runId: run.id,
    siteDomain: deriveSiteDomain(pages.map((p) => p.url)),
    status: run.status,
    startedAt: run.started_at,
    endedAt: run.ended_at,
    verdict: { goodToGo, headline, reason },
    summary,
    pages,
    requiredMerchantActions,
    ...(publishedThemeId ? { publishedThemeId } : {}),
    proof: {
      schemaGenLabel: SCHEMAGEN_PROOF_LABEL,
      googleLabel: GOOGLE_PROOF_LABEL,
    },
  };
}
