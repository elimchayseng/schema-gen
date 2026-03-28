-- Unique index so crawl re-runs upsert instead of duplicating schemas
CREATE UNIQUE INDEX IF NOT EXISTS idx_schemas_user_url_type
  ON public.schemas(user_id, source_url, schema_type);
