"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useScan } from "@/components/ScanProvider";

export default function ScanInput() {
  const [url, setUrl] = useState("");
  const { startScan, step } = useScan();
  const router = useRouter();
  const isLoading = step !== "idle" && step !== "done" && step !== "error";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || isLoading) return;
    router.push("/report");
    startScan(url.trim());
  }

  return (
    <div className="pt-16 pb-12">
      <h1 className="text-3xl font-bold text-text-primary mb-2">
        Optimize your structured data
      </h1>
      <p className="text-sm text-text-secondary mb-8 max-w-lg">
        Paste any URL to scan for existing JSON-LD, fix validation errors, and
        generate AI-optimized schema markup ready to deploy.
      </p>

      <form onSubmit={handleSubmit} className="flex gap-3 max-w-2xl">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://your-store.com/products/example"
          required
          className="flex-1 rounded-md border border-border bg-surface-1 px-4 py-3 text-sm text-text-primary placeholder-text-muted focus:border-accent focus:outline-none font-mono"
        />
        <button
          type="submit"
          disabled={isLoading}
          className="rounded-md bg-accent px-6 py-3 text-sm font-bold text-surface-0 transition-colors hover:bg-accent-bright disabled:opacity-50"
        >
          {isLoading ? "Scanning..." : "Optimize"}
        </button>
      </form>
    </div>
  );
}
