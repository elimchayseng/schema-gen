"use client";

import { useState } from "react";
import type { SchemaComparison } from "@/lib/optimizer/types";
import type { ValidatedRecommendation } from "@/lib/ai/types";
import { copyMergedJsonLdScript } from "@/lib/copy-utils";

export default function DeployPanel({
  comparisons,
  newRecommendations,
}: {
  comparisons: SchemaComparison[];
  newRecommendations: ValidatedRecommendation[];
}) {
  const [copied, setCopied] = useState(false);

  // Collect the best version of each schema:
  // AI Enhanced > Auto-Fixed > Current
  function getAllOptimizedSchemas(): Record<string, unknown>[] {
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

  async function handleCopyAll() {
    const schemas = getAllOptimizedSchemas();
    if (schemas.length === 0) return;

    const ok = await copyMergedJsonLdScript(schemas);
    setCopied(ok);
    if (ok) setTimeout(() => setCopied(false), 2000);
  }

  const totalSchemas =
    comparisons.length + newRecommendations.length;

  if (totalSchemas === 0) return null;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white">
            Deploy All Optimized Schemas
          </h3>
          <p className="mt-0.5 text-xs text-zinc-400">
            {totalSchemas} schema{totalSchemas !== 1 ? "s" : ""} combined in a
            single script tag, ready to paste into your theme.
          </p>
        </div>
        <button
          onClick={handleCopyAll}
          className="rounded-md bg-indigo-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-indigo-500"
        >
          {copied ? "Copied!" : "Copy All"}
        </button>
      </div>
    </div>
  );
}
