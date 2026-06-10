/**
 * Run-page grouping (Phase 7 — run readability). Pure function over a finished run's
 * URL arrays + the URLs the client observed during perceive. Partitions every page into
 * exactly one bucket so the dashboard can account for all of them.
 *
 * The load-bearing subtlety (eng-review D2): `RunResult.satisfied` is a SUPERSET of
 * `skipped` (run.ts pushes committedSkipped + planned.skipped into BOTH). So "freshly
 * fixed" is `satisfied − skipped`, never `satisfied` itself — otherwise already-good pages
 * get double-counted as fixed.
 *
 *   fixed       = satisfied − skipped         (acted on and newly staged this run)
 *   alreadyGood = skipped                     (already valid / committed in a prior run)
 *   failed      = unsatisfied
 *   notReached  = perceived − satisfied − unsatisfied   (a breaker/kill cut them off)
 *
 * Known limit (tracked as a GitHub issue): pages killed DURING perceive never emit a
 * perceive event, so they aren't in `perceivedUrls` and can't appear in `notReached`.
 */

export interface RunGroupingInput {
  /** Met the goal (superset of skipped). */
  satisfied: string[];
  unsatisfied: string[];
  /** Already-satisfied / committed pages (subset of satisfied). */
  skipped: string[];
  /** Every URL the client saw a perceive (or act) event for. */
  perceivedUrls: string[];
}

export interface RunPageGroups {
  /** Acted on and newly staged this run. */
  fixed: string[];
  /** Already valid before this run, or committed in a prior run. */
  alreadyGood: string[];
  /** Acted on but did not satisfy the goal. */
  failed: string[];
  /** Perceived but never acted on (a breaker or kill stopped the run first). */
  notReached: string[];
}

/** De-duplicate while preserving first-seen order. */
function dedupe(urls: string[]): string[] {
  return [...new Set(urls)];
}

export function groupRunPages(input: RunGroupingInput): RunPageGroups {
  const skippedSet = new Set(input.skipped);
  const satisfiedSet = new Set(input.satisfied);
  const unsatisfiedSet = new Set(input.unsatisfied);

  const fixed = dedupe(input.satisfied).filter((u) => !skippedSet.has(u));
  const alreadyGood = dedupe(input.skipped);
  const failed = dedupe(input.unsatisfied);
  const notReached = dedupe(input.perceivedUrls).filter(
    (u) => !satisfiedSet.has(u) && !unsatisfiedSet.has(u)
  );

  return { fixed, alreadyGood, failed, notReached };
}
