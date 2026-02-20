-- ============================================================
-- SchemaGen Phase 1 — Initial Schema
-- Run this in the Supabase SQL editor
-- ============================================================

-- profiles: extends auth.users
CREATE TABLE public.profiles (
  id           UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email        TEXT,
  full_name    TEXT,
  is_anonymous BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- schemas: user-saved JSON-LD schemas (editor + scan saves)
CREATE TABLE public.schemas (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  schema_type           TEXT NOT NULL,
  content               JSONB NOT NULL,
  source_url            TEXT,
  validation_errors     JSONB,
  missing_opportunities JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_schemas_user_id   ON public.schemas(user_id);
CREATE INDEX idx_schemas_updated_at ON public.schemas(updated_at DESC);

-- ============================================================
-- Triggers
-- ============================================================

-- Auto-create profile on any new auth.users row (anon or named)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, is_anonymous)
  VALUES (
    NEW.id,
    NEW.email,
    CASE WHEN NEW.email IS NULL THEN TRUE ELSE FALSE END
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER set_schemas_updated_at
  BEFORE UPDATE ON public.schemas
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- Row-Level Security
-- ============================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schemas  ENABLE ROW LEVEL SECURITY;

-- Profiles: all authenticated users can read, only own row for update
CREATE POLICY "profiles_read_all"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (TRUE);

CREATE POLICY "profiles_update_own"
  ON public.profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id);

-- Schemas: open reads; writes scoped to own user_id
CREATE POLICY "schemas_read_all"
  ON public.schemas FOR SELECT
  TO authenticated
  USING (TRUE);

CREATE POLICY "schemas_insert_own"
  ON public.schemas FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "schemas_update_own"
  ON public.schemas FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "schemas_delete_own"
  ON public.schemas FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);
