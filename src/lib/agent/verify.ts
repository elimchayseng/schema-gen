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
import { hasCriticalIssue, schemaTypesOf } from "./gates";
import type { GateResult, MinOutcome } from "./types";

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
   * Propagation polling — Shopify asset writes are eventually consistent. Defaults are
   * tuned for production; tests inject {maxAttempts:1} or a fake sleep for determinism.
   */
  maxAttempts?: number;
  /** Injectable delay between attempts (ms-agnostic; tests pass a no-op). */
  sleep?: (attempt: number) => Promise<void>;
}

/** Evaluate one fetched HTML payload against the requirement. Pure. */
function verifyHtml(
  html: string,
  requireTypes: string[],
  minOutcome: MinOutcome
): GateResult {
  const extracted = extractJsonLd(html);
  const live = extracted
    .filter((e) => !e.parseError && e.parsed !== null)
    .map((e) => e.parsed as Record<string, unknown>);

  if (live.length === 0) {
    return fail("no JSON-LD rendered on the live page");
  }

  const validations = live.map((s) => validateSchema(s));

  // Every required type must have at least one VALID live schema of that type.
  const missing = requireTypes.find(
    (t) => !live.some((_, i) => validations[i].valid && schemaTypesOf(live[i]).includes(t))
  );
  if (missing) {
    return fail(`no valid '${missing}' schema in the live render`);
  }

  // Rich-results parity with L2: the type must be eligible AND its live valid
  // instances free of critical-impact issues.
  if (minOutcome === "rich_results_eligible") {
    for (const t of requireTypes) {
      if (getRichResultInfo(t)?.eligible !== true) {
        return fail(`${t} is not rich-result eligible`);
      }
      const critical = live.some(
        (_, i) =>
          validations[i].valid &&
          schemaTypesOf(live[i]).includes(t) &&
          hasCriticalIssue(validations[i])
      );
      if (critical) {
        return fail(`${t}: a critical issue blocks rich results in the live render`);
      }
    }
  }

  return pass(`live render carries valid ${requireTypes.join(", ")}`);
}

const defaultSleep = () => Promise.resolve();

export async function l4Verify(input: L4VerifyInput): Promise<GateResult> {
  const { fetchHtml, url, requireTypes, minOutcome } = input;
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
      last = verifyHtml(html, requireTypes, minOutcome);
      if (last.passed) return last;
    }

    // Not satisfied — wait for propagation and retry, unless this was the last attempt.
    if (attempt < maxAttempts - 1) await sleep(attempt);
  }
  return last;
}
