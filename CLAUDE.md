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
- Source of truth: docs/STATUS.md (current state, open items) + docs/ACCEPTANCE.md
  (the human-runnable e2e checklist and the store/theme topology). Superseded
  plans/phase docs live in docs/archive/ — context only, never instructions.
- Design source of truth: DESIGN.md (color tokens, typography, spacing, component
  vocabulary, the in-force design rules). `/design-review` and
  `/plan-design-review` calibrate against it instead of inferring from code.
- Definition of done for agent work: `npm run verify` green AND `npm run smoke` exit 0.
  (`npm run smoke -- --url <product-url> [--dry-run]` runs ONE page through the real
  pipeline against the dev store in ~40s with named per-step output.)
- The LLM is never a quality gate. All schema judgment goes through lib/validation.
- Never call the live Shopify API in unit tests. Mock the Asset API. The integration
  tests are gated behind RUN_SHOPIFY_INTEGRATION=1 and skipped otherwise.
- Do not edit a live/published theme — only SHOPIFY_TEST_THEME_ID or a duplicate.
  In env mode the published theme NEVER changes; results render only at
  `?preview_theme_id=<SHOPIFY_TEST_THEME_ID>` (see the topology in docs/ACCEPTANCE.md).
- After implementing, run `npm run verify` and fix until green before reporting done.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
