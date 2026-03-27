"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { SchemaComparison } from "@/lib/optimizer/types";
import type { ValidatedRecommendation } from "@/lib/ai/types";
import { copyMergedJsonLdScript } from "@/lib/copy-utils";
import { saveSchema } from "@/lib/save-schema";
import { useAuth } from "@/components/AuthProvider";

interface DeployBarProps {
  comparisons: SchemaComparison[];
  newRecommendations: ValidatedRecommendation[];
  sourceUrl?: string;
  onDeploy?: () => void;
}

function getAllOptimizedSchemas(
  comparisons: SchemaComparison[],
  newRecommendations: ValidatedRecommendation[]
): { schemaType: string; content: Record<string, unknown> }[] {
  const schemas: { schemaType: string; content: Record<string, unknown> }[] = [];

  for (const c of comparisons) {
    if (c.generated) {
      schemas.push({ schemaType: c.schemaType, content: c.generated.jsonld });
    } else if (c.fixed) {
      schemas.push({ schemaType: c.schemaType, content: c.fixed.schema });
    } else if (c.existing) {
      schemas.push({ schemaType: c.schemaType, content: c.existing.schema });
    }
  }

  for (const rec of newRecommendations) {
    schemas.push({ schemaType: rec.type, content: rec.jsonld });
  }

  return schemas;
}

/** Build a human-readable name from the schema content, e.g. "Product — iPhone 15 Pro" */
function schemaDisplayName(
  schemaType: string,
  content: Record<string, unknown>,
  sourceUrl?: string
): string {
  // Most schema types use "name" (Product, Article, Organization, etc.)
  const name =
    (content.name as string) ||
    (content.headline as string) || // Article/BlogPosting
    (content.title as string);

  if (name) return `${schemaType} — ${name}`;

  // Fallback to hostname
  if (sourceUrl) {
    try {
      return `${schemaType} — ${new URL(sourceUrl).hostname}`;
    } catch {
      // invalid URL, fall through
    }
  }

  return schemaType;
}

export default function DeployBar({
  comparisons,
  newRecommendations,
  sourceUrl,
  onDeploy,
}: DeployBarProps) {
  const router = useRouter();
  const { user } = useAuth();
  const [copied, setCopied] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const schemas = getAllOptimizedSchemas(comparisons, newRecommendations);
  const totalSchemas = schemas.length;

  if (totalSchemas === 0) return null;

  const allContents = schemas.map((s) => s.content);
  const merged = allContents.length === 1 ? allContents[0] : allContents;
  const jsonString = JSON.stringify(merged, null, 2);
  const scriptTag = `<script type="application/ld+json">\n${jsonString}\n</script>`;

  async function handleCopyAll() {
    const ok = await copyMergedJsonLdScript(allContents);
    setCopied(ok);
    if (ok) setTimeout(() => setCopied(false), 2000);
  }

  async function handleSaveAll() {
    setSaving(true);
    setSaveError(null);

    try {
      const results = await Promise.all(
        schemas.map((s) =>
          saveSchema({
            name: schemaDisplayName(s.schemaType, s.content, sourceUrl),
            schema_type: s.schemaType,
            content: s.content,
            source_url: sourceUrl,
          })
        )
      );

      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        setSaveError(`Failed to save ${failed.length} schema${failed.length > 1 ? "s" : ""}`);
      } else {
        setSaved(true);
      }
    } catch {
      setSaveError("Network error — please try again");
    } finally {
      setSaving(false);
    }
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

      {/* Save to profile bar */}
      {user && (
        <div className="border-t border-border px-5 py-3 flex items-center justify-between">
          {saved ? (
            <div className="flex items-center gap-2 animate-fade-in-up">
              <span className="text-valid text-sm">&#10003;</span>
              <span className="text-sm text-valid font-medium">
                Saved to your schemas
              </span>
              <button
                onClick={() => router.push("/")}
                className="ml-3 text-xs text-accent hover:text-accent-bright underline underline-offset-2"
              >
                View all schemas
              </button>
            </div>
          ) : (
            <>
              <p className="text-xs text-text-muted">
                Save {totalSchemas === 1 ? "this schema" : `all ${totalSchemas} schemas`} to your profile
              </p>
              <button
                onClick={handleSaveAll}
                disabled={saving}
                className="rounded-md border border-valid/40 bg-valid/10 px-4 py-1.5 text-xs font-bold text-valid transition-all hover:bg-valid/20 disabled:opacity-50"
              >
                {saving ? "Saving\u2026" : "Save to My Schemas"}
              </button>
            </>
          )}
          {saveError && (
            <p className="text-xs text-error ml-3">{saveError}</p>
          )}
        </div>
      )}

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
