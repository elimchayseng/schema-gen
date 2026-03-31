"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useScan } from "@/components/ScanProvider";

function LightningBolt() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      className="shrink-0"
    >
      <path
        d="M8.5 1L3 9.5H7.5L7 15L13 6.5H8.5L9 1H8.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

export default function ScanInput() {
  const [url, setUrl] = useState("");
  const [isCrawling, setIsCrawling] = useState(false);
  const [crawlError, setCrawlError] = useState<string | null>(null);
  const { startScan, step } = useScan();
  const router = useRouter();
  const isLoading = step !== "idle" && step !== "done" && step !== "error";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || isLoading) return;
    router.push("/report");
    startScan(url.trim());
  }

  async function handleCrawl() {
    if (!url.trim() || isCrawling) return;
    setIsCrawling(true);
    setCrawlError(null);

    try {
      const res = await fetch("/api/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: url.trim() }),
      });

      const data = await res.json();

      if (!res.ok) {
        setCrawlError(data.error ?? "Failed to start crawl");
        setIsCrawling(false);
        return;
      }

      // Navigate to crawl dashboard
      router.push(`/site/${data.crawlId}`);
    } catch {
      setCrawlError("Failed to connect. Please try again.");
      setIsCrawling(false);
    }
  }

  return (
    <div className="pt-16 pb-12">
      <h1 className="font-serif text-3xl text-text-primary mb-2">
        Optimize your structured data
      </h1>
      <p className="text-sm text-text-secondary mb-8 max-w-lg leading-relaxed">
        Paste any URL to scan a single page, or enter a domain to crawl your
        full site via sitemap and fix every schema at once.
      </p>

      <form onSubmit={handleSubmit} className="flex gap-3 max-w-2xl">
        <input
          type="url"
          value={url}
          onChange={(e) => { setUrl(e.target.value); setCrawlError(null); }}
          placeholder="https://your-store.com"
          required
          className="flex-1 rounded-md border border-border bg-surface-1 px-4 py-3 text-sm text-text-primary placeholder-text-muted focus:border-accent focus:outline-none font-mono"
        />
        <button
          type="submit"
          disabled={isLoading || isCrawling}
          className="btn-optimize flex items-center gap-2 rounded-md bg-accent px-6 py-3 text-sm font-bold text-surface-0 transition-all hover:bg-accent-bright disabled:opacity-50 disabled:animate-none"
        >
          <LightningBolt />
          {isLoading ? "Scanning..." : "Single Page"}
        </button>
        <button
          type="button"
          onClick={handleCrawl}
          disabled={isLoading || isCrawling || !url.trim()}
          className="flex items-center gap-2 rounded-md border-2 border-accent bg-transparent px-6 py-3 text-sm font-bold text-accent transition-all hover:bg-accent/10 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <SitemapIcon />
          {isCrawling ? "Starting..." : "Crawl Full Site"}
        </button>
      </form>

      {crawlError && (
        <div className="mt-3 max-w-2xl rounded-md border border-error/30 bg-error-dim/20 px-4 py-2 text-xs text-error">
          {crawlError}
        </div>
      )}
    </div>
  );
}

function SitemapIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0">
      <circle cx="8" cy="3" r="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <circle cx="3" cy="12" r="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <circle cx="13" cy="12" r="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <line x1="8" y1="5" x2="3" y2="10" stroke="currentColor" strokeWidth="1.5" />
      <line x1="8" y1="5" x2="13" y2="10" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
