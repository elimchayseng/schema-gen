# SchemaGen - Claude Code Project Instructions

## gstack Skills

The following gstack slash-command skills are installed and available:

- `/browse` — Headless browser for web browsing (use this instead of MCP chrome tools)
- `/plan-ceo-review` — CEO-perspective plan review
- `/plan-eng-review` — Engineering-perspective plan review
- `/review` — Code review
- `/ship` — Ship code (commit, PR, etc.)
- `/retro` — Retrospective on recent work

**Always use `/browse` for all web browsing tasks** — do not use MCP chrome/browser tools.

## Impeccable Skills (Frontend Design)

The following [impeccable](https://github.com/pbakaus/impeccable) slash-command skills are installed for frontend design work:

- `/teach-impeccable` — Initial setup to gather design context
- `/audit` — Technical quality checks (accessibility, performance, responsiveness)
- `/critique` — UX design review
- `/normalize` — Align with design system standards
- `/polish` — Pre-shipping quality pass
- `/distill` — Strip designs to their essence
- `/clarify` — Improve UX copy clarity
- `/optimize` — Performance enhancements
- `/harden` — Error handling, i18n, edge cases
- `/animate` — Add purposeful motion
- `/colorize` — Introduce strategic color
- `/bolder` — Amplify understated designs
- `/quieter` — Tone down overly bold designs
- `/delight` — Add moments of joy
- `/extract` — Pull into reusable components
- `/adapt` — Adapt for different devices
- `/onboard` — Design onboarding flows

## Agent build rules
- Source of truth: AGENT_IMPLEMENTATION_PLAN.md. Current task: docs/agent/phase-N-*.md.
- Definition of done for a phase: `npm run verify` is green AND acceptance criteria in the phase file pass.
- The LLM is never a quality gate. All schema judgment goes through lib/validation.
- Never call the live Shopify API in unit tests. Mock the Asset API. The single
  integration test is gated behind RUN_SHOPIFY_INTEGRATION=1 and skipped otherwise.
- Work on branch feat/agent. Commit per phase. Do not edit a live/published theme — only SHOPIFY_TEST_THEME_ID or a duplicate.
- After implementing, run `npm run verify` and fix until green before reporting done.
