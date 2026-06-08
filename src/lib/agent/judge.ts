/**
 * L6 soft judge (plan §6, Phase 5). One optional LLM call asking "does this JSON-LD match
 * the page's apparent intent?". It is SOFT by contract:
 *
 *   - it NEVER throws — any error/timeout/parse failure returns a neutral `passed: true`
 *     "unavailable" verdict, so a flaky judge can't fail a run;
 *   - its verdict is recorded as `gates.L6` for auditing but `gatesPassed()` ignores L6,
 *     so it can NEVER block a commit.
 *
 * The actual LLM call is injected (`ask`) so unit tests drive it without network. The
 * default hits the same Heroku Inference endpoint the generator uses, non-streaming.
 */
import type { GateResult } from "./types";

export interface L6JudgeInput {
  url: string;
  candidates: Record<string, unknown>[];
  /** Page type hint from the generator, if known (e.g. "product"). */
  pageType?: string;
  /** Injectable LLM caller (returns the raw assistant message). Defaults to a real call. */
  ask?: (prompt: string) => Promise<string>;
}

const JUDGE_TIMEOUT_MS = 30_000;

function buildPrompt(
  url: string,
  candidates: Record<string, unknown>[],
  pageType?: string
): string {
  const types = candidates
    .map((c) => c["@type"])
    .filter(Boolean)
    .join(", ");
  return [
    "You are a structured-data reviewer. Judge whether the JSON-LD below plausibly",
    "describes the page at the given URL — its TYPE and key fields should match what the",
    "page is actually about. This is a soft sanity check, not strict validation.",
    "",
    `URL: ${url}`,
    pageType ? `Generator page type: ${pageType}` : "",
    `Schema @type(s): ${types || "(none)"}`,
    "",
    "JSON-LD:",
    JSON.stringify(candidates).slice(0, 4000),
    "",
    'Reply with ONLY a JSON object: {"match": true|false, "reason": "<short reason>"}.',
  ]
    .filter(Boolean)
    .join("\n");
}

/** Parse the judge's reply into a verdict. Tolerant: strips fences, finds the JSON object. */
function parseVerdict(raw: string): { match: boolean; reason: string } {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    text = text.slice(start, end + 1);
  }
  const parsed = JSON.parse(text) as { match?: unknown; reason?: unknown };
  return {
    match: parsed.match === true,
    reason:
      typeof parsed.reason === "string" && parsed.reason
        ? parsed.reason
        : "no reason given",
  };
}

async function defaultAsk(prompt: string): Promise<string> {
  const url = process.env.HEROKU_INFERENCE_URL;
  const key = process.env.HEROKU_INFERENCE_KEY;
  const model = process.env.HEROKU_INFERENCE_MODEL;
  if (!url || !key || !model) {
    throw new Error("Missing Heroku Inference environment variables");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS);
  try {
    const res = await fetch(url.replace(/\/+$/, "") + "/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 256,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`judge API returned ${res.status}`);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return json.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the soft L6 judge. Returns a GateResult. NEVER throws: on any failure it returns a
 * neutral `passed: true` "unavailable" verdict so the run is never gated by judge errors.
 */
export async function l6Judge(input: L6JudgeInput): Promise<GateResult> {
  try {
    if (input.candidates.length === 0) {
      return { passed: true, detail: "judge skipped (no candidates)" };
    }
    const ask = input.ask ?? defaultAsk;
    const raw = await ask(buildPrompt(input.url, input.candidates, input.pageType));
    const verdict = parseVerdict(raw);
    return {
      passed: verdict.match,
      detail: `judge: ${verdict.reason}`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { passed: true, detail: `judge unavailable (soft): ${msg}` };
  }
}
