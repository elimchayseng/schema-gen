/**
 * Post-publish verification (the gap the dev-store e2e exposed). L4 verifies the
 * staging theme via `?preview_theme_id=` BEFORE the swap — but shoppers and Google
 * only ever see the PUBLISHED render, and Shopify's storefront page cache can keep
 * serving the pre-publish render for a long time after themePublish (observed live:
 * hours on a password-gated dev store, converging page by page). So after the swap,
 * re-verify each touched page at its REAL url.
 *
 * The freshness proof is what makes the verdict trustworthy: a render that does not
 * yet contain this run's staged blocks is a STALE CACHE COPY — it carries no
 * information about the published theme, so it is re-polled, never failed. A render
 * that DOES contain the staged blocks is provably the new theme's output, so any
 * gate failure on it is real:
 *
 *   fetch(url + unique cache-bust param)
 *     ├─ staged blocks absent  ─▶ stale — sleep, re-poll (budget permitting)
 *     ├─ staged blocks present ─▶ run the full gate (validate + dup gate)
 *     │      pass ─▶ page verified
 *     │      fail ─▶ page FAILED — definite, stop polling this page
 *     └─ budget exhausted while stale ─▶ page "stale" (inconclusive, NOT failed)
 *
 * Overall: any failed page ⇒ "failed" (caller republishes the displaced theme);
 * no failures but unconverged pages ⇒ "stale" (publish stands, re-check later);
 * all pages pass ⇒ "verified".
 *
 * No model calls. fetchHtml / sleep are injected so unit tests are network-free.
 */
import type { TypeRequirement } from "./types";
import { verifyRenderedHtml } from "./verify";

export interface PostPublishPage {
  /** The REAL published storefront url (no preview_theme_id). */
  url: string;
  /** The exact JSON-LD this run staged for the page — the freshness proof. */
  expectBlocks: unknown;
  /** Per-page bars, same contract as L4 (issue #28). */
  requirements: TypeRequirement[];
}

export type PostPublishPageStatus = "pass" | "stale" | "fail";

export interface PostPublishPageVerdict {
  url: string;
  status: PostPublishPageStatus;
  detail?: string;
  /** Fetch attempts spent on this page. */
  attempts: number;
}

export type PostPublishStatus = "verified" | "stale" | "failed";

export interface PostPublishResult {
  status: PostPublishStatus;
  pages: PostPublishPageVerdict[];
}

export interface PostPublishInput {
  pages: PostPublishPage[];
  /** Fetch the rendered HTML of a published page (cookie-authenticated upstream). */
  fetchHtml: (url: string) => Promise<string>;
  /** Duplicate-prevention gate (issue #24) — on when the apply carried suppressions. */
  unique: boolean;
  /** Poll budget per page. The default is generous: cache convergence, not asset
   *  propagation, dominates post-publish — see the observed-live note above. */
  maxAttempts?: number;
  /** Injectable delay between rounds (tests pass a no-op). */
  sleep?: (attempt: number) => Promise<void>;
  /** Seed for the cache-bust param so two runs never share a cache key. */
  bustSeed?: string;
}

const DEFAULT_MAX_ATTEMPTS = 12;

/** 5s, 10s, …, capped at 30s — ~5 minutes total at the default budget. */
const defaultSleep = (attempt: number) =>
  new Promise<void>((resolve) =>
    setTimeout(resolve, Math.min(5_000 * (attempt + 1), 30_000))
  );

function bustUrl(url: string, seed: string, attempt: number): string {
  return `${url}${url.includes("?") ? "&" : "?"}sgpp=${seed}-${attempt}`;
}

export async function postPublishVerify(
  input: PostPublishInput
): Promise<PostPublishResult> {
  const maxAttempts = Math.max(1, input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const sleep = input.sleep ?? defaultSleep;
  const seed = input.bustSeed ?? Date.now().toString(36);

  const verdicts = new Map<string, PostPublishPageVerdict>();
  let pending = input.pages.map((p) => ({ page: p, attempts: 0, lastDetail: "" }));

  for (let attempt = 0; attempt < maxAttempts && pending.length > 0; attempt++) {
    const next: typeof pending = [];
    for (const item of pending) {
      const { page } = item;
      item.attempts++;
      let html = "";
      try {
        html = await fetchHtmlOf(input, bustUrl(page.url, seed, attempt));
      } catch (e) {
        // A fetch failure is transient (network blip, 429) — re-poll, never fail:
        // failing here would republish the displaced theme on no evidence at all.
        item.lastDetail = `fetch failed: ${e instanceof Error ? e.message : String(e)}`;
        next.push(item);
        continue;
      }

      const verdict = verifyRenderedHtml(
        html,
        page.requirements,
        input.unique,
        page.expectBlocks
      );
      if (verdict.passed) {
        verdicts.set(page.url, {
          url: page.url,
          status: "pass",
          detail: verdict.detail,
          attempts: item.attempts,
        });
      } else if (verdict.stale) {
        // The staged blocks aren't in this render — it's a pre-publish cache copy,
        // not a verdict on the published theme. Keep polling.
        item.lastDetail = verdict.detail ?? "stale render";
        next.push(item);
      } else {
        // Staged blocks ARE present, so this is provably the new theme's render —
        // a gate failure on it is real. Definite; no amount of polling changes it.
        verdicts.set(page.url, {
          url: page.url,
          status: "fail",
          detail: verdict.detail,
          attempts: item.attempts,
        });
      }
    }
    pending = next;
    if (pending.length > 0 && attempt < maxAttempts - 1) await sleep(attempt);
  }

  // Budget exhausted with pages still stale: inconclusive, explicitly NOT failed.
  for (const item of pending) {
    verdicts.set(item.page.url, {
      url: item.page.url,
      status: "stale",
      detail: item.lastDetail || "cache did not converge within the poll budget",
      attempts: item.attempts,
    });
  }

  const pages = input.pages.map((p) => verdicts.get(p.url)!);
  const status: PostPublishStatus = pages.some((p) => p.status === "fail")
    ? "failed"
    : pages.some((p) => p.status === "stale")
      ? "stale"
      : "verified";
  return { status, pages };
}

/** Indirection so a thrown fetch and a rejected promise take the same path. */
async function fetchHtmlOf(input: PostPublishInput, url: string): Promise<string> {
  const html = await input.fetchHtml(url);
  if (!html) throw new Error("empty response");
  return html;
}
