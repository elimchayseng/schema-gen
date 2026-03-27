"use client";

import { useState } from "react";
import type { SchemaComparison } from "@/lib/optimizer/types";
import type { ValidatedRecommendation } from "@/lib/ai/types";
import { copyMergedJsonLdScript } from "@/lib/copy-utils";

interface DeployBarProps {
  comparisons: SchemaComparison[];
  newRecommendations: ValidatedRecommendation[];
  onDeploy?: () => void;
}

function getAllOptimizedSchemas(
  comparisons: SchemaComparison[],
  newRecommendations: ValidatedRecommendation[]
): Record<string, unknown>[] {
  const schemas: Record<string, unknown>[] = [];

  for (const c of comparisons) {
    if (c.generated) {
      schemas.push(c.generated.jsonld);
    } else if (c.fixed) {
      schemas.push(c.fixed.schema);
    } else if (c.existing) {
      schemas.push(c.existing.schema);
    }
  }

  for (const rec of newRecommendations) {
    schemas.push(rec.jsonld);
  }

  return schemas;
}

export default function DeployBar({
  comparisons,
  newRecommendations,
  onDeploy,
}: DeployBarProps) {
  const [copied, setCopied] = useState(false);
  const [showJson, setShowJson] = useState(false);

  const schemas = getAllOptimizedSchemas(comparisons, newRecommendations);
  const totalSchemas = schemas.length;

  if (totalSchemas === 0) return null;

  const merged = schemas.length === 1 ? schemas[0] : schemas;
  const jsonString = JSON.stringify(merged, null, 2);
  const scriptTag = `<script type="application/ld+json">\n${jsonString}\n</script>`;

  async function handleCopyAll() {
    const ok = await copyMergedJsonLdScript(schemas);
    setCopied(ok);
    if (ok) setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="mb-6 rounded-lg border border-border bg-surface-1">
      <div className="flex items-center justify-between px-5 py-4">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">
            Optimized JSON-LD
          </h3>
          <p className="mt-0.5 text-xs text-text-secondary">
            {totalSchemas} schema{totalSchemas !== 1 ? "s" : ""} merged into a
            single script tag
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowJson((v) => !v)}
            className="rounded-md border border-border-bright px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
          >
            {showJson ? "Hide" : "Preview"}
          </button>
          <button
            onClick={handleCopyAll}
            className="rounded-md bg-accent px-4 py-1.5 text-xs font-bold text-surface-0 transition-colors hover:bg-accent-bright"
          >
            {copied ? "Copied!" : "Copy All JSON-LD"}
          </button>
          {onDeploy ? (
            <button
              onClick={onDeploy}
              className="rounded-md border border-accent px-4 py-1.5 text-xs font-bold text-accent transition-colors hover:bg-accent hover:text-surface-0"
            >
              Deploy to Shopify
            </button>
          ) : (
            <span className="text-[10px] text-text-muted">
              Auto-deploy coming soon
            </span>
          )}
        </div>
      </div>

      {showJson && (
        <div className="border-t border-border px-5 py-4">
          <pre className="max-h-96 overflow-auto rounded-md bg-surface-0 p-4 font-mono text-xs leading-relaxed text-text-primary">
            {scriptTag}
          </pre>
        </div>
      )}
    </div>
  );
}
