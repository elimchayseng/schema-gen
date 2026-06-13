"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";

function BoltIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      className="shrink-0"
      aria-hidden="true"
    >
      <path
        d="M8.5 1L3 9.5H7.5L7 15L13 6.5H8.5L9 1H8.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

/**
 * The single entry point: one URL, one button. Provisions the site
 * (POST /api/agent/provision) and routes straight into the agent surface.
 */
export default function AgentHero() {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Optional one-time Shopify connection — unlocks the staging->publish live
  // apply. All-or-nothing: the API rejects partial triples.
  const [shopDomain, setShopDomain] = useState("");
  const [appKey, setAppKey] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [storefrontPassword, setStorefrontPassword] = useState("");
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || busy) return;
    if (!authLoading && !user) {
      router.push("/login");
      return;
    }
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/agent/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          ...(shopDomain.trim() && {
            shopDomain: shopDomain.trim(),
            appKey: appKey.trim(),
            appSecret: appSecret.trim(),
            ...(storefrontPassword.trim() && {
              storefrontPassword: storefrontPassword.trim(),
            }),
          }),
        }),
      });

      if (res.status === 401 || res.redirected) {
        router.push("/login");
        return;
      }

      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.siteId) {
        setError(data?.error ?? "Couldn't set up your store. Please try again.");
        setBusy(false);
        return;
      }

      // Stay in the busy state through navigation — no flash back to idle.
      router.push(`/agent/${data.siteId}`);
    } catch {
      setError("Failed to connect. Please try again.");
      setBusy(false);
    }
  }

  return (
    <section className="pt-16 pb-10">
      <div className="mb-5 inline-flex items-center gap-1.5 rounded-full border border-fix/30 bg-fix/10 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-fix-bright">
        <BoltIcon />
        Autonomous agent
      </div>

      <h1 className="font-serif text-4xl leading-tight text-text-primary">
        Your store, Google-ready.
        <br />
        Automatically.
      </h1>
      <p className="mt-4 max-w-xl text-sm leading-relaxed text-text-secondary">
        Give SchemaGen your homepage. It scans your whole site, validates the
        structured data on every page, generates and fixes anything missing or
        invalid, injects it into your Shopify theme safely — and comes back
        with proof from Google that your products are rich-results ready.
      </p>

      <form onSubmit={handleSubmit} className="mt-8 max-w-2xl">
        <label
          htmlFor="store-url"
          className="mb-2 block text-[11px] font-medium uppercase tracking-wider text-text-muted"
        >
          Your store&apos;s homepage URL
        </label>
        <div className="flex gap-3">
          <input
            id="store-url"
            type="url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setError(null);
            }}
            placeholder="https://your-store.com"
            required
            className="flex-1 rounded-md border border-border bg-surface-1 px-4 py-3 font-mono text-sm text-text-primary placeholder-text-muted focus:border-fix focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || !url.trim()}
            className="flex shrink-0 items-center gap-2 rounded-md bg-fix px-6 py-3 text-sm font-bold text-text-primary transition-all hover:bg-fix-bright disabled:cursor-not-allowed disabled:opacity-50"
          >
            <BoltIcon />
            {busy ? "Setting up…" : "Optimize my store"}
          </button>
        </div>
        {/* One-time store connection — the only setup the merchant ever does.
            Optional here: without it the agent still scans, validates, and
            previews; with it, the live staging->publish apply unlocks. */}
        <details className="mt-4 rounded-md border border-border bg-surface-card">
          <summary className="cursor-pointer px-4 py-3 text-xs font-medium text-text-secondary hover:text-text-primary">
            Connect your Shopify store (one-time, unlocks automatic publishing)
          </summary>
          <div className="grid gap-3 border-t border-border px-4 py-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
                myshopify domain
              </span>
              <input
                type="text"
                value={shopDomain}
                onChange={(e) => setShopDomain(e.target.value)}
                placeholder="your-store.myshopify.com"
                className="mt-1 w-full rounded-md border border-border bg-surface-1 px-3 py-2 font-mono text-xs text-text-primary placeholder-text-muted focus:border-fix focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
                Storefront password{" "}
                <span className="normal-case text-text-muted">(if gated)</span>
              </span>
              <input
                type="password"
                value={storefrontPassword}
                onChange={(e) => setStorefrontPassword(e.target.value)}
                autoComplete="off"
                className="mt-1 w-full rounded-md border border-border bg-surface-1 px-3 py-2 font-mono text-xs text-text-primary focus:border-fix focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
                App API key
              </span>
              <input
                type="text"
                value={appKey}
                onChange={(e) => setAppKey(e.target.value)}
                autoComplete="off"
                className="mt-1 w-full rounded-md border border-border bg-surface-1 px-3 py-2 font-mono text-xs text-text-primary focus:border-fix focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
                App API secret
              </span>
              <input
                type="password"
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
                autoComplete="off"
                className="mt-1 w-full rounded-md border border-border bg-surface-1 px-3 py-2 font-mono text-xs text-text-primary focus:border-fix focus:outline-none"
              />
            </label>
            <p className="text-[11px] leading-relaxed text-text-muted sm:col-span-2">
              Create an app with <code className="text-text-secondary">read_themes</code>,{" "}
              <code className="text-text-secondary">write_themes</code>,{" "}
              <code className="text-text-secondary">read_products</code> scopes —
              see the setup guide. Credentials are stored server-side and never
              shown again.
            </p>
          </div>
        </details>
      </form>

      {error && (
        <div className="mt-3 max-w-2xl rounded-md border border-error/30 bg-error-dim/20 px-4 py-2 text-xs text-error">
          {error}
        </div>
      )}
    </section>
  );
}
