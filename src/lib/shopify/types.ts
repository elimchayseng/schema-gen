/**
 * Shared types for the Shopify Admin API client (agent Phase 0).
 * Only the fields SchemaGen actually reads are modeled; Shopify returns more.
 */

export interface ShopifyConfig {
  /** Full shop host, e.g. "my-dev-store.myshopify.com". Always normalized + validated. */
  shop: string;
  /** Admin API version, e.g. "2025-01". */
  apiVersion: string;
  /** Base URL: https://<shop>/admin/api/<version> */
  baseUrl: string;
}

export interface ShopifyTheme {
  id: number;
  name: string;
  /** "main" = published/live, "unpublished", "demo", "development". */
  role: string;
  created_at?: string;
  updated_at?: string;
  previewable?: boolean;
  processing?: boolean;
}

export interface ShopifyAsset {
  /** e.g. "layout/theme.liquid". */
  key: string;
  /** Text asset contents. Absent for binary assets (see `attachment`). */
  value?: string;
  /** Base64 contents for binary assets. */
  attachment?: string;
  checksum?: string;
  content_type?: string;
  size?: number;
  theme_id?: number;
  created_at?: string;
  updated_at?: string;
}

export interface ThemeBackup {
  id: string;
  /** FK to agent_runs (added in Phase 2). Nullable for standalone Phase 0 backups. */
  run_id: string | null;
  shop: string;
  theme_id: number;
  asset_key: string;
  /** Exact prior asset value, for byte-identical restore. */
  asset_value_before: string;
  created_at: string;
}
