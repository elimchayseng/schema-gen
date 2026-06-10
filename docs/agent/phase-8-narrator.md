# Phase 8 — Conversational narrator (read-only)

Source of truth: `AGENT_IMPLEMENTATION_PLAN.md` §1 (keep the LLM out of the control loop). Builds on
Phase 7 (`docs/agent/phase-7-run-readability.md`). Definition of done: `npm run verify` green AND
the acceptance criteria below pass.

> **The shape.** The deterministic engine is the agent's *hands* (unchanged — it still does the work
> and `lib/validation` still judges quality). Phase 8 adds a *voice*: an LLM that translates the
> structured run trace into natural language and answers "why did this page fail?" — but **never
> decides anything and never acts.** This is the read-only v1: narration + explanation, no
> chat-driven control (that is Phase 9).

## Core constraint (do not violate)

Per §1, **the LLM is never a quality gate.** Phase 8 extends that: the LLM is also **never a source
of truth about the run.** The narrator's only input is the structured trace
(`AgentProgressEvent`s, `RunResult`, `ActionRecord`s); its only output is a paraphrase of that
trace. It may not assert a fact — success, failure, a count, a reason — that is not present in the
structured state it was given. This is the anti-hallucination contract.

## Goal

While a run streams and after it ends, the operator reads a plain-English account of what the agent
is doing and where it got stuck, and can ask free-form "why" questions answered from that run's own
audit trail.

## Scope (hybrid narration engine — the chosen v1)

1. **Templated live ticks (no LLM).** Drive fast per-event status text deterministically from the
   Phase 7 progress state: "Scanning your store — 12 of 33 pages…", "Generating schema for
   /products/duffel…", "Paused after 3 pages failed." Cheap, instant, always grounded.

2. **LLM summaries at the moments that matter (grounded).** Call the model only at:
   - phase transitions (perceive→plan→act→done), and
   - end of run, and
   - on demand (a "why?" / "explain" request),
   passing the structured trace as the sole context. Output is a short paraphrase. Reuse the
   Phase 5 LLM cache where the input trace is unchanged. This bounds cost/latency — no per-page
   model call.

3. **Stuck-state taxonomy → explanation + suggestions.** Map each terminal/blocked state to a
   canned frame the narrator fills in: breaker-halted (`consecutive_failures` / `max_cost_exceeded`
   / `rollback_failed`), all-L1-failure pattern, empty/no-sitemap, `processing_failed` (AI error),
   needs-live-creds. Each yields *why it's stuck* + *2–3 suggested next steps* (read-only — Phase 9
   makes them actionable).

4. **A "why?" panel tied to the run.** A read-only chat input that answers questions about the
   current/just-finished run by loading its audit trail (`GET /api/agent/run/<id>`) as grounding
   context: "why did /products/sling fail?" → reads that `ActionRecord`'s gates + `outcome` and
   explains in plain language. It explains; it never starts, changes, kills, or applies a run.

5. **A narrator endpoint.** Add a route (e.g. `POST /api/agent/narrate`) that takes a `runId` (+
   optional question) and returns the grounded NL text. Same ownership check as the run routes.
   The route assembles the structured context; the LLM only renders it.

## Out of scope (explicitly Phase 9+)

- Any chat message that *starts / adjusts / resumes / kills / goes live* on a run.
- Interpreting "optimize my site" into a Goal (Phase 10).
- The LLM choosing tools or branching the control flow.

## Design constraints (from project memory)

- Narrator/AI affordances use **indigo** (it is an AI operation); never orange for non-warning text.
- The narration panel matches the dashboard card motif; no gradient blobs.

## Process

1. Add the templated tick text on top of Phase 7's progress state (no LLM).
2. Add the narrator endpoint + the grounded prompt (trace-in, paraphrase-out, citations to URLs).
3. Build the stuck-state taxonomy table and wire it into the end-of-run summary.
4. Add the read-only "why?" panel calling the narrator endpoint with run context.
5. Unit-test the grounding contract: given a fixed trace, the narrator asserts no count/reason
   absent from that trace (mock the LLM; assert the *prompt* carries only structured state and the
   route never mutates a run).
6. Run `npm run verify` and fix until green.

## Acceptance criteria

- `npm run verify` is green.
- During a run, live status reads as plain English sentences, not raw counts/chips.
- A halted run produces a NL explanation naming the real reason (e.g. consecutive failures) plus
  concrete suggested next steps.
- Asking "why did <url> fail?" returns an answer grounded in that page's `ActionRecord` (correct
  gate + reason), and says so plainly when the run has no such page.
- The narrator path has **no** code path that starts, mutates, kills, or applies a run (verified by
  test + review).
- LLM is not on any quality-gate or control decision (unchanged from §1).
</content>
