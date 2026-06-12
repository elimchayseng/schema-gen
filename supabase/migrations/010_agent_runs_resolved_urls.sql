-- The concrete URL list a run resolved its goal scope to (issue #27).
-- Written best-effort right after resolveTargetUrls, so the merchant report can
-- compute notReached exactly for ANY scope (site / all_products / all_pages),
-- not just url_list goals whose URLs already live inside the goal snapshot.
-- JSONB array of strings; NULL for runs predating this migration (the report
-- falls back to goal.target.urls for url_list goals, as before).

ALTER TABLE public.agent_runs
  ADD COLUMN resolved_urls JSONB;
