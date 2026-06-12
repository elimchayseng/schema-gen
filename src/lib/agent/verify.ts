/**
 * L4 live-verify (plan §7, Phase 3). The gate that earns the right to keep a write:
 * after the footprint is written to the theme, re-fetch the RENDERED storefront page,
 * re-extract its JSON-LD, and re-validate that the required schema actually appears and
 * validates live. A staged candidate that gates green (L0–L3) but doesn't render (Liquid
 * guard mismatch, theme stripped the script, snippet not included) fails here.
 *
 *   l4Verify({ fetchHtml, url, requireTypes, minOutcome })
 *     ├─ poll fetchHtml(url) ── extract ── validate (reuses the L1/L2 engine)
 *     │    every required type has a VALID live schema?            ─┐
 *     │    minOutcome=rich? that type is eligible + no critical?    ├─▶ pass
 *     │                                                            ─┘
 *     └─ not satisfied yet AND attempts left ─▶ sleep, retry  (Shopify asset writes
 *          are eventually consistent; an early fetch can see the OLD html)
 *          attempts exhausted ─▶ fail (with the last attempt's reason)
 *
 * No model calls. fetchHtml / sleep are injected so unit tests are network-free and
 * instant; production wires the real page fetcher and a real timer.
 */
import { extractJsonLd } from "@/lib/url-validator/extractor";
import { validateSchema } from "@/lib/validation/engine";
import { getRichResultInfo } from "@/lib/validation/rich-results";
import { hasCriticalIssue, schemaSatisfiesType } from "./gates";
import type { GateResult, MinOutcome, TypeRequirement } from "./types";

const pass = (detail?: string): GateResult => ({ passed: true, detail });
const fail = (detail: string): GateResult => ({ passed: false, detail });

export interface L4VerifyInput {
  /** Fetch the rendered HTML of the live/preview page. Throws or returns "" if unreachable. */
  fetchHtml: (url: string) => Promise<string>;
  /** The storefront URL whose live render must carry the schema. */
  url: string;
  requireTypes: string[];
  minOutcome: MinOutcome;
  /**
   * Per-type bars (issue #28). When present, REPLACES requireTypes/minOutcome —
   * same contract as GateInput.requirements, so L4 stays in lockstep with L1/L2.
   */
  requirements?: TypeRequirement[];
  /**
   * Propagation polling — Shopify asset writes are eventually consistent. Defaults are
   * tuned for production; tests inject {maxAttempts:1} or a fake sleep for determinism.
   */
  maxAttempts?: number;
  /** Injectable delay between attempts (ms-agnostic; tests pass a no-op). */
  sleep?: (attempt: number) => Promise<void>;
  /**
   * Duplicate-prevention gate (issue #24), on for authoritative applies. The rendered
   * page must carry EXACTLY ONE valid block per required type and ZERO remaining
   * invalid/unparseable blocks of a required type — i.e. the suppressed theme block is
   * really gone and only SchemaGen's block answers for that type. The verdict is folded
   * into the same L4 GateResult (detail names the duplicate), so a dup failure takes
   * the exact rollback path an L4 failure does and GateResults/UI stay unchanged.
   */
  unique?: boolean;
  /**
   * Freshness proof: the exact JSON-LD value(s) this run staged for the page.
   * When set, the rendered page must contain every member (canonical-JSON
   * equality) before any other check counts — Shopify's Asset API is
   * eventually consistent, so without this a STALE render that happens to be
   * valid produces a false pass (observed live: the dup gate passed against
   * the pre-write snippet render, then the real write propagated).
   */
  expectBlocks?: unknown;
}

/**
 * Does this UNPARSEABLE block plausibly declare a given @type? Parsing failed, so the
 * only evidence is the raw text — match the `"@type": "X"` literal (whitespace-tolerant).
 */
function rawDeclaresType(raw: string, type: string): boolean {
  return new RegExp(`"@type"\\s*:\\s*"${type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(raw);
}

/** Canonical JSON: stable key order at every depth, for value equality checks. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * A GateResult whose failure may be a freshness miss rather than a verdict:
 * `stale: true` means the staged blocks aren't in the render yet (old cached/
 * unpropagated HTML) — the page can't be judged, only re-polled. Post-publish
 * verification (post-publish.ts) branches on this to tell "cache hasn't
 * converged" apart from "the new theme genuinely renders wrong".
 */
export type RenderVerdict = GateResult & { stale?: boolean };

/** Evaluate one fetched HTML payload against the per-type requirements. Pure. */
export function verifyRenderedHtml(
  html: string,
  requirements: TypeRequirement[],
  unique = false,
  expectBlocks?: unknown
): RenderVerdict {
  const extracted = extractJsonLd(html);
  const unparseable = extracted.filter((e) => e.parseError || e.parsed === null);
  const live = extracted
    .filter((e) => !e.parseError && e.parsed !== null)
    .map((e) => e.parsed as Record<string, unknown>);

  // FRESHNESS (stale-render guard): every staged block must already be in the
  // render, by value. A miss is not a verdict on the schema — it means the
  // Asset API hasn't propagated this write yet; the poll loop retries.
  if (expectBlocks !== undefined) {
    const liveCanon = new Set(live.map(canonicalJson));
    const members = Array.isArray(expectBlocks) ? expectBlocks : [expectBlocks];
    const missing = members.filter((m) => !liveCanon.has(canonicalJson(m)));
    if (missing.length > 0) {
      return {
        passed: false,
        stale: true,
        detail: `staged schema not yet in the live render (${missing.length}/${members.length} block(s) missing — likely still propagating)`,
      };
    }
  }

  if (live.length === 0) {
    return fail("no JSON-LD rendered on the live page");
  }

  const validations = live.map((s) => validateSchema(s));

  // Every required type must have at least one VALID live schema of that type.
  const missing = requirements.find(
    (r) =>
      !live.some(
        (_, i) => validations[i].valid && schemaSatisfiesType(live[i], r.type)
      )
  );
  if (missing) {
    return fail(`no valid '${missing.type}' schema in the live render`);
  }

  // Duplicate-prevention gate (issue #24): with the competing emissions suppressed,
  // each required type must be answered by EXACTLY ONE valid block, and no
  // invalid/unparseable block of a required type may still render (a suppressed
  // theme block that still shows up means the suppression didn't take → rollback).
  if (unique) {
    for (const r of requirements) {
      const validCount = live.filter(
        (_, i) => validations[i].valid && schemaSatisfiesType(live[i], r.type)
      ).length;
      if (validCount !== 1) {
        return fail(
          `duplicate schema: ${validCount} valid '${r.type}' blocks in the live render (expected exactly 1)`
        );
      }
      const invalidCount =
        live.filter(
          (_, i) => !validations[i].valid && schemaSatisfiesType(live[i], r.type)
        ).length +
        unparseable.filter((e) => rawDeclaresType(e.raw, r.type)).length;
      if (invalidCount > 0) {
        return fail(
          `an invalid or unparseable '${r.type}' block still renders on the live page (${invalidCount} found)`
        );
      }
    }
  }

  // Rich-results parity with L2: each rich-bar type must be eligible AND its
  // live valid instances free of critical-impact issues.
  for (const r of requirements) {
    if (r.outcome !== "rich_results_eligible") continue;
    if (getRichResultInfo(r.type)?.eligible !== true) {
      return fail(`${r.type} is not rich-result eligible`);
    }
    const critical = live.some(
      (_, i) =>
        validations[i].valid &&
        schemaSatisfiesType(live[i], r.type) &&
        hasCriticalIssue(validations[i])
    );
    if (critical) {
      return fail(`${r.type}: a critical issue blocks rich results in the live render`);
    }
  }

  return pass(
    `live render carries valid ${requirements.map((r) => r.type).join(", ")}`
  );
}

/**
 * Production default: linear backoff (2s, 4s, 6s) between propagation polls —
 * a Shopify storefront render can lag the Asset API write by seconds, and an
 * instant retry burns all attempts in ~0ms and rolls back a good apply. Tests
 * inject their own sleep (or maxAttempts: 1) so suites stay instant.
 */
const defaultSleep = (attempt: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));

export async function l4Verify(input: L4VerifyInput): Promise<GateResult> {
  const { fetchHtml, url } = input;
  const requirements: TypeRequirement[] =
    input.requirements ??
    input.requireTypes.map((type) => ({ type, outcome: input.minOutcome }));
  const maxAttempts = Math.max(1, input.maxAttempts ?? 4);
  const sleep = input.sleep ?? defaultSleep;

  let last: GateResult = fail("verification did not run");
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let html: string;
    try {
      html = await fetchHtml(url);
    } catch (e) {
      // A fetch failure is a verdict input, never thrown: L4 returns a GateResult so
      // the apply path treats it as a hard-gate failure (→ rollback), not a crash.
      last = fail(
        `could not fetch live render: ${e instanceof Error ? e.message : String(e)}`
      );
      html = "";
    }

    if (html) {
      last = verifyRenderedHtml(
        html,
        requirements,
        input.unique ?? false,
        input.expectBlocks
      );
      if (last.passed) return last;
    }

    // Not satisfied — wait for propagation and retry, unless this was the last attempt.
    if (attempt < maxAttempts - 1) await sleep(attempt);
  }
  return last;
}
