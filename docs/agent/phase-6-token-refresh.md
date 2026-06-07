# Phase 6 — Token lifecycle & auto re-auth

Source of truth: `AGENT_IMPLEMENTATION_PLAN.md` §5 (token lifecycle) + §9 (Phase 6). Definition of done: `npm run verify` green **and** the acceptance criteria below pass.

**Elevated priority: land this before any Phase 3 live (non-dry-run) run.** The `dev.shopify.com` app issues Admin API tokens via the OAuth `client_credentials` grant, and those tokens **expire in ~24h**. A single agent run can outlive the token, so without auto re-auth a long run dies mid-flight on a `401`.

---

## Goal

Make `getOfflineToken(shop)` self-sustaining: mint tokens on demand, cache them with their expiry, and refresh automatically — so no human ever pastes a token for an ongoing run.

## Background (the constraint)

```bash
curl -X POST "https://<shop>.myshopify.com/admin/oauth/access_token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=$SHOPIFY_APP_KEY" -d "client_secret=$SHOPIFY_APP_SECRET"
# -> { "access_token": "shpat_…", "expires_in": 86399, ... }
```
The app must already be **installed on the shop** (an un-installed app returns `400 app_not_installed`). The token is short-lived, not durable.

## Scope

- **`mintToken(shop)`** in `lib/shopify/config.ts` (or a new `auth.ts`): POST the `client_credentials` grant, parse `{ access_token, expires_in }`, return `{ token, expiresAt }` where `expiresAt = now + expires_in*1000`. Reuse `shopifyFetch`-style timeout handling; this endpoint is on the same `*.myshopify.com` host so the existing SSRF allowlist applies. Never log the token, client_id, or client_secret.
- **`getOfflineToken(shop)` rewrite (replaces the env-only stopgap):**
  1. If a cached token for `shop` exists and `now < expiresAt - BUFFER` (e.g. 5 min), return it.
  2. Otherwise `mintToken(shop)`, cache it, return it.
  - Cache tier: in-memory `Map<shop, {token, expiresAt}>` is enough for a single long-running process; for serverless (Next.js route invocations don't share memory) back it with a `shop_tokens` row so invocations share a fresh token. Keep `SHOPIFY_OFFLINE_TOKEN` env as an optional override for a pinned manual token in dev.
- **Reactive refresh in `client.ts`:** on a `401` (Shopify "Invalid API key or access token"), invalidate the cache for that shop, `mintToken` once, and retry the request **exactly once**. A second `401` is a hard failure (bad credentials / app uninstalled) — do not loop.
- **Data model (optional, for serverless durability):** `shop_tokens(shop PK, access_token <encrypted>, expires_at, scope, updated_at)`. Service-role only (RLS on, no policies), like `theme_backups`. Encrypt the token at rest.

## What this supersedes

- Phase 0's env-only `getOfflineToken` (stopgap).
- §8's "store the encrypted **offline** token" assumption — the durable secret is the **install credential** (`client_id`/`client_secret` + per-shop install state); tokens are ephemeral and self-refresh.

## Process

1. Implement `mintToken` + the new `getOfflineToken` + the `client.ts` 401-retry.
2. Mock the token endpoint in unit tests (never hit live Shopify in unit tests).
3. Run `npm run verify` and fix until green.

## Acceptance criteria

- With an empty/expired cache, a call auto-mints and succeeds — no manual token paste.
- A cached, unexpired token is reused (no redundant mint) until within `BUFFER` of expiry.
- A mid-request `401` triggers exactly **one** re-mint + retry; a second `401` fails hard without looping.
- Token / client_id / client_secret never appear in logs (extend the `logger.ts` scrub test).
- `npm run verify` green; one `RUN_SHOPIFY_INTEGRATION=1`-gated test mints a real token and reads `theme.liquid`.
