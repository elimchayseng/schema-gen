-- Authoritative override mode (issues #23/#24) + staging publish (#26 wiring).
-- Three new append-only action kinds in the audit trail:
--   suppress        — a competing theme JSON-LD emission was reversibly silenced
--                     on the write-target theme (suppress.ts markers)
--   merchant_action — structured "the merchant must do X" record (e.g. an app
--                     injects schema we cannot remove via theme edits)
--   publish         — the staging theme was published (atomic swap); outcome
--                     carries the rollback artifact (the previous live theme id)

ALTER TABLE public.agent_actions
  DROP CONSTRAINT agent_actions_action_check;

ALTER TABLE public.agent_actions
  ADD CONSTRAINT agent_actions_action_check
  CHECK (action IN (
    'generate', 'fix', 'write', 'verify', 'rollback', 'skip',
    'suppress', 'merchant_action', 'publish'
  ));
