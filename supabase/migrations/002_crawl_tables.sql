-- Site-wide crawl tables
-- Supports: sitemap crawl, batch processing, per-page schema tracking

-- Sites: one row per unique domain scanned
CREATE TABLE public.sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sites_user_id ON public.sites(user_id);
CREATE UNIQUE INDEX idx_sites_user_domain ON public.sites(user_id, domain);

-- Crawl jobs: one row per crawl run
CREATE TABLE public.crawl_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  total_urls INTEGER NOT NULL DEFAULT 0,
  processed_urls INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_crawl_jobs_site_status ON public.crawl_jobs(site_id, status);

-- Page schemas: one row per URL per crawl
CREATE TABLE public.page_schemas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  crawl_id UUID NOT NULL REFERENCES public.crawl_jobs(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'valid', 'warnings', 'errors', 'no_schema', 'failed')),
  original_schema JSONB,
  fixed_schema JSONB,
  validation_results JSONB,
  error_reason TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  deploy_status TEXT NOT NULL DEFAULT 'not_deployed' CHECK (deploy_status IN ('not_deployed', 'pending_review', 'deployed', 'deploy_failed')),
  processing_started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX idx_page_schemas_crawl_status ON public.page_schemas(crawl_id, status);
CREATE INDEX idx_page_schemas_site_url ON public.page_schemas(site_id, url);

-- RLS policies
ALTER TABLE public.sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crawl_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.page_schemas ENABLE ROW LEVEL SECURITY;

-- Sites: users can only see and manage their own sites
CREATE POLICY "Users can read own sites"
  ON public.sites FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own sites"
  ON public.sites FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own sites"
  ON public.sites FOR DELETE
  USING (auth.uid() = user_id);

-- Crawl jobs: users can manage crawls for their own sites
CREATE POLICY "Users can read own crawl jobs"
  ON public.crawl_jobs FOR SELECT
  USING (site_id IN (SELECT id FROM public.sites WHERE user_id = auth.uid()));

CREATE POLICY "Users can insert own crawl jobs"
  ON public.crawl_jobs FOR INSERT
  WITH CHECK (site_id IN (SELECT id FROM public.sites WHERE user_id = auth.uid()));

CREATE POLICY "Users can update own crawl jobs"
  ON public.crawl_jobs FOR UPDATE
  USING (site_id IN (SELECT id FROM public.sites WHERE user_id = auth.uid()));

-- Page schemas: users can manage page schemas for their own sites
CREATE POLICY "Users can read own page schemas"
  ON public.page_schemas FOR SELECT
  USING (site_id IN (SELECT id FROM public.sites WHERE user_id = auth.uid()));

CREATE POLICY "Users can insert own page schemas"
  ON public.page_schemas FOR INSERT
  WITH CHECK (site_id IN (SELECT id FROM public.sites WHERE user_id = auth.uid()));

CREATE POLICY "Users can update own page schemas"
  ON public.page_schemas FOR UPDATE
  USING (site_id IN (SELECT id FROM public.sites WHERE user_id = auth.uid()));
