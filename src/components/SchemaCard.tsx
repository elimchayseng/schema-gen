"use client";

import Link from "next/link";
import { useState } from "react";
import type { Schema } from "@/lib/database.types";
import { copyJsonLdScript } from "@/lib/copy-utils";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function SchemaCard({ schema }: { schema: Schema }) {
  const [copied, setCopied] = useState(false);

  const errorCount = schema.validation_errors?.length ?? 0;

  function handleCopy(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    copyJsonLdScript(JSON.stringify(schema.content, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="group rounded-xl border border-zinc-800 bg-zinc-900 p-5 transition-colors hover:border-zinc-700">
      {/* Header row */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="rounded-md bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-300 shrink-0">
            {schema.schema_type}
          </span>
          {errorCount > 0 && (
            <span className="rounded-md bg-red-900/50 px-2 py-0.5 text-xs font-medium text-red-300 shrink-0">
              {errorCount} error{errorCount > 1 ? "s" : ""}
            </span>
          )}
        </div>
        <span className="text-xs text-zinc-500 shrink-0">
          {formatDate(schema.updated_at)}
        </span>
      </div>

      {/* Schema name — clickable */}
      <Link href={`/editor?id=${schema.id}`} className="block">
        <h2 className="mb-1 text-sm font-semibold text-white group-hover:text-indigo-400 leading-snug">
          {schema.name}
        </h2>
        {schema.source_url && (
          <p className="text-xs text-zinc-500 truncate">{schema.source_url}</p>
        )}
      </Link>

      {/* Actions row */}
      <div className="mt-4 flex items-center justify-between">
        <Link
          href={`/editor?id=${schema.id}`}
          className="text-xs text-zinc-400 hover:text-white transition-colors"
        >
          Edit
        </Link>
        <button
          onClick={handleCopy}
          className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white"
        >
          {copied ? "Copied!" : "Copy JSON-LD"}
        </button>
      </div>
    </div>
  );
}
