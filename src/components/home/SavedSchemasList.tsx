"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface SavedSchema {
  id: string;
  name: string;
  schema_type: string;
  source_url: string | null;
  updated_at: string;
  validation_errors: unknown[] | null;
}

export default function SavedSchemasList() {
  const [schemas, setSchemas] = useState<SavedSchema[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/schemas");
        if (res.ok) {
          const data = await res.json();
          setSchemas(data.schemas ?? []);
        }
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="text-xs text-text-muted py-4">Loading schemas...</div>
    );
  }

  if (schemas.length === 0) {
    return (
      <div className="rounded-md border border-border bg-surface-1 px-5 py-8 text-center">
        <p className="text-sm text-text-secondary mb-1">No saved schemas yet</p>
        <p className="text-xs text-text-muted">
          Scan a URL above to generate and save optimized schemas
        </p>
      </div>
    );
  }

  return (
    <div>
      <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-text-muted">
        Saved Schemas
      </h2>
      <div className="rounded-md border border-border overflow-hidden">
        {schemas.map((schema, i) => {
          const errorCount = schema.validation_errors?.length ?? 0;
          return (
            <Link
              key={schema.id}
              href={`/editor?id=${schema.id}`}
              className={`flex items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-surface-2/50 ${
                i !== schemas.length - 1 ? "border-b border-border" : ""
              }`}
            >
              <span className="font-mono text-xs font-medium text-accent w-28 shrink-0">
                {schema.schema_type}
              </span>
              <span className="text-text-primary truncate flex-1">
                {schema.name}
              </span>
              {schema.source_url && (
                <span className="font-mono text-[10px] text-text-muted truncate max-w-48">
                  {schema.source_url}
                </span>
              )}
              {errorCount > 0 && (
                <span className="font-mono text-[10px] text-error">
                  {errorCount} err
                </span>
              )}
              <span className="text-[10px] text-text-muted">
                {new Date(schema.updated_at).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
