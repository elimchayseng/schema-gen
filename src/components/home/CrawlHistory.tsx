"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface CrawlSummary {
  id: string;
  status: string;
  total_urls: number;
  processed_urls: number;
  created_at: string;
  sites: { domain: string };
}

export default function CrawlHistory() {
  const [crawls, setCrawls] = useState<CrawlSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchCrawls() {
      try {
        const res = await fetch("/api/crawl");
        if (res.ok) {
          const data = await res.json();
          setCrawls(data.crawls ?? []);
        }
      } catch {
        // Non-critical
      }
      setLoading(false);
    }
    fetchCrawls();
  }, []);

  if (loading) return null;
  if (crawls.length === 0) return null;

  return (
    <div className="mb-8">
      <h2 className="font-serif text-xs uppercase tracking-wider text-text-muted mb-3">
        Site Crawls
      </h2>
      <div className="flex flex-col gap-2">
        {crawls.map((crawl) => (
          <Link
            key={crawl.id}
            href={`/site/${crawl.id}`}
            className="flex items-center gap-4 rounded-lg border border-border bg-surface-1 px-4 py-3 hover:bg-surface-2 transition-colors"
          >
            <span className="font-mono text-sm text-text-primary flex-1">
              {crawl.sites.domain}
            </span>
            <span className="text-xs text-text-muted">
              {crawl.processed_urls}/{crawl.total_urls} pages
            </span>
            <CrawlStatusBadge status={crawl.status} />
            <span className="text-[10px] text-text-muted">
              {new Date(crawl.created_at).toLocaleDateString()}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function CrawlStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    completed: "bg-valid/10 text-valid",
    running: "bg-valid/10 text-valid animate-pulse",
    failed: "bg-error/10 text-error",
    pending: "bg-surface-3 text-text-muted",
  };

  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${styles[status] ?? styles.pending}`}
    >
      {status}
    </span>
  );
}
