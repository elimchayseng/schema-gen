"use client";

import Link from "next/link";
import { Suspense } from "react";
import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { validateSchemaString } from "@/lib/validation";
import type { ValidationResult } from "@/lib/validation/types";
import type { Schema } from "@/lib/database.types";
import SchemaFormFields from "@/components/SchemaFormFields";
import IssueRow from "@/components/IssueRow";
import { copyJsonLdScript } from "@/lib/copy-utils";
import { saveSchema } from "@/lib/save-schema";

// ─── Constants ─────────────────────────────────────────────────────────────

const schemaTypes = [
  "Product",
  "FAQPage",
  "BreadcrumbList",
  "Organization",
  "LocalBusiness",
  "WebSite",
  "Article",
  "BlogPosting",
  "Review",
  "Event",
] as const;

const defaultSchemas: Record<string, Record<string, unknown>> = {
  Product: {
    "@context": "https://schema.org",
    "@type": "Product",
    name: "",
    description: "",
    image: "",
    brand: { "@type": "Brand", name: "" },
    offers: {
      "@type": "Offer",
      price: "",
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
    },
  },
  FAQPage: {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "What is your return policy?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "We offer a 30-day return policy on all items.",
        },
      },
    ],
  },
  BreadcrumbList: {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://example.com" },
      { "@type": "ListItem", position: 2, name: "Products", item: "https://example.com/products" },
    ],
  },
  Organization: {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "",
    url: "",
    logo: "",
    description: "",
  },
  LocalBusiness: {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: "",
    url: "",
    telephone: "",
    address: {
      "@type": "PostalAddress",
      streetAddress: "",
      addressLocality: "",
      addressRegion: "",
      postalCode: "",
      addressCountry: "US",
    },
  },
  WebSite: {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "",
    url: "",
  },
  Article: {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: "",
    author: { "@type": "Person", name: "" },
    datePublished: "",
    dateModified: "",
    image: "",
    publisher: { "@type": "Organization", name: "", logo: { "@type": "ImageObject", url: "" } },
  },
  BlogPosting: {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: "",
    author: { "@type": "Person", name: "" },
    datePublished: "",
    image: "",
  },
  Review: {
    "@context": "https://schema.org",
    "@type": "Review",
    author: { "@type": "Person", name: "" },
    reviewRating: { "@type": "Rating", ratingValue: "5", bestRating: "5" },
    reviewBody: "",
  },
  Event: {
    "@context": "https://schema.org",
    "@type": "Event",
    name: "",
    startDate: "",
    endDate: "",
    location: { "@type": "Place", name: "", address: "" },
  },
};

// ─── Validation Panel ──────────────────────────────────────────────────────

function ValidationPanel({ result }: { result: ValidationResult | null }) {
  if (!result) return null;

  const { errors, warnings } = result;
  const errorCount = errors.length;
  const warningCount = warnings.length;

  if (errorCount === 0 && warningCount === 0) {
    return (
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-800/50 bg-emerald-950/30 px-3 py-2">
        <span className="h-2 w-2 rounded-full bg-emerald-500" />
        <span className="text-xs text-emerald-400 font-medium">Schema is valid</span>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-zinc-700 bg-zinc-950">
      {/* Panel header */}
      <div className="flex items-center gap-3 border-b border-zinc-800 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Validation
        </span>
        {errorCount > 0 && (
          <span className="rounded-full bg-red-900/60 px-2 py-0.5 text-xs font-medium text-red-300">
            {errorCount} error{errorCount > 1 ? "s" : ""}
          </span>
        )}
        {warningCount > 0 && (
          <span className="rounded-full bg-amber-900/60 px-2 py-0.5 text-xs font-medium text-amber-300">
            {warningCount} warning{warningCount > 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Issues list */}
      <div className="max-h-48 overflow-auto p-2 flex flex-col gap-1">
        {errors.map((issue, i) => (
          <IssueRow key={`e-${i}`} issue={issue} />
        ))}
        {warnings.map((issue, i) => (
          <IssueRow key={`w-${i}`} issue={issue} />
        ))}
      </div>
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────

function EditorContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const schemaId = searchParams.get("id");
  const typeParam = searchParams.get("type");

  const initialType =
    typeParam && schemaTypes.includes(typeParam as (typeof schemaTypes)[number])
      ? typeParam
      : "Product";

  const [schemaType, setSchemaType] = useState<string>(initialType);
  const [schemaName, setSchemaName] = useState<string>("");
  const [jsonOutput, setJsonOutput] = useState<string>(
    JSON.stringify(defaultSchemas[initialType] ?? defaultSchemas.Product, null, 2)
  );
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [loadedSchema, setLoadedSchema] = useState<Schema | null>(null);
  const [copied, setCopied] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load schema by id on mount
  useEffect(() => {
    if (!schemaId) return;

    fetch(`/api/schemas/${schemaId}`)
      .then((r) => r.json())
      .then(({ schema }: { schema: Schema }) => {
        if (!schema) return;
        setLoadedSchema(schema);
        setSchemaType(schema.schema_type);
        setSchemaName(schema.name);
        setJsonOutput(JSON.stringify(schema.content, null, 2));
      })
      .catch((err) => console.error("[editor] failed to load schema:", err));
  }, [schemaId]);

  // Live validation — debounced 300ms
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const result = validateSchemaString(jsonOutput);
      setValidationResult(result);
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [jsonOutput]);

  // Callback for SchemaFormFields — updates the JSON textarea whenever the form changes
  const handleFormChange = useCallback((json: Record<string, unknown>) => {
    setJsonOutput(JSON.stringify(json, null, 2));
  }, []);

  // Update schema type — form remounts via key={schemaType} and drives the new JSON output
  const handleTypeChange = useCallback((newType: string) => {
    setSchemaType(newType);
  }, []);

  async function handleSave() {
    if (!schemaName.trim()) {
      setSaveMessage("Please enter a schema name before saving.");
      return;
    }

    setIsSaving(true);
    setSaveMessage(null);

    let content: Record<string, unknown>;
    try {
      content = JSON.parse(jsonOutput);
    } catch {
      setSaveMessage("Cannot save — JSON is invalid.");
      setIsSaving(false);
      return;
    }

    try {
      const result = await saveSchema({
        id: schemaId && loadedSchema ? schemaId : undefined,
        name: schemaName,
        schema_type: schemaType,
        content,
        source_url: loadedSchema?.source_url ?? undefined,
        validation_errors: validationResult?.errors ?? [],
        missing_opportunities: loadedSchema?.missing_opportunities ?? [],
      });

      if (!result.ok) {
        setSaveMessage(result.error ?? "Save failed");
        return;
      }

      const savedSchema = result.schema as Schema | undefined;

      // If this was a new schema, redirect to the editor for that id
      if (!schemaId && savedSchema?.id) {
        router.replace(`/editor?id=${savedSchema.id}`);
        setLoadedSchema(savedSchema);
      } else if (savedSchema) {
        setLoadedSchema(savedSchema);
      }

      setSaveMessage("Saved!");
      setTimeout(() => setSaveMessage(null), 3000);
    } catch {
      setSaveMessage("Network error — please try again");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete() {
    if (!schemaId) return;
    setIsDeleting(true);
    try {
      const res = await fetch(`/api/schemas/${schemaId}`, { method: "DELETE" });
      if (res.ok) {
        router.push("/");
      } else {
        const data = await res.json();
        setSaveMessage(data.error ?? "Delete failed");
        setShowDeleteModal(false);
      }
    } catch {
      setSaveMessage("Network error — delete failed");
      setShowDeleteModal(false);
    } finally {
      setIsDeleting(false);
    }
  }

  function handleCopy() {
    copyJsonLdScript(jsonOutput).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const errorCount = validationResult?.errors.length ?? 0;
  const warningCount = validationResult?.warnings.length ?? 0;

  const saveLabel = isSaving
    ? "Saving…"
    : errorCount > 0
    ? `Save (${errorCount} error${errorCount > 1 ? "s" : ""})`
    : "Save Schema";

  return (
    <div>
      {/* Delete confirmation modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/80 px-4">
          <div className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-6">
            <h2 className="mb-1 text-lg font-bold text-white">Delete Schema</h2>
            <p className="mb-5 text-sm text-zinc-400">
              This action cannot be undone.
            </p>
            <label className="mb-1 block text-sm text-zinc-300">
              Type{" "}
              <span className="font-mono text-white">&ldquo;{schemaName}&rdquo;</span>{" "}
              to confirm:
            </label>
            <input
              type="text"
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder={schemaName}
              autoFocus
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-600 focus:border-red-600 focus:outline-none"
            />
            <div className="mt-4 flex justify-end gap-3">
              <button
                onClick={() => {
                  setShowDeleteModal(false);
                  setDeleteConfirmText("");
                }}
                className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleteConfirmText.trim() !== schemaName.trim() || isDeleting}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-40"
              >
                {isDeleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Top bar */}
      <div className="mb-6 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="rounded-sm px-2 py-1 text-xs text-text-muted transition-colors hover:text-text-secondary"
          >
            &larr; Back
          </Link>
          <h1 className="text-lg font-bold text-text-primary">Schema Editor</h1>
        </div>
        <div className="flex items-center gap-3">
          {saveMessage && (
            <span
              className={`text-sm ${
                saveMessage === "Saved!" ? "text-emerald-400" : "text-red-400"
              }`}
            >
              {saveMessage}
            </span>
          )}
          {loadedSchema && schemaId && (
            <button
              onClick={() => {
                setDeleteConfirmText("");
                setShowDeleteModal(true);
              }}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:border-red-700 hover:text-red-400"
            >
              Delete
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={isSaving}
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50 ${
              errorCount > 0
                ? "bg-amber-600 hover:bg-amber-500"
                : "bg-indigo-600 hover:bg-indigo-500"
            }`}
          >
            {saveLabel}
          </button>
        </div>
      </div>

      {/* Loaded from scan banner */}
      {loadedSchema?.source_url && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-xs text-zinc-400">
          <span>Extracted from</span>
          <a
            href={loadedSchema.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-indigo-400 hover:underline truncate"
          >
            {loadedSchema.source_url}
          </a>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left panel — configuration */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-400">
            Configuration
          </h2>

          <label className="mb-1 block text-sm text-zinc-300">Schema Name</label>
          <input
            type="text"
            value={schemaName}
            onChange={(e) => setSchemaName(e.target.value)}
            placeholder="e.g. Summer Collection Tee"
            className="mb-5 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
          />

          <label className="mb-1 block text-sm text-zinc-300">Schema Type</label>
          {loadedSchema?.source_url ? (
            // Lock type for schemas imported from a URL scan
            <div className="mb-1 flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-2">
              <span className="flex-1 text-sm text-white">{schemaType}</span>
              <span className="shrink-0 rounded bg-zinc-700 px-2 py-0.5 text-xs text-zinc-400">
                locked — from scan
              </span>
            </div>
          ) : (
            <select
              value={schemaType}
              onChange={(e) => handleTypeChange(e.target.value)}
              className="mb-1 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none"
            >
              {schemaTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )}

          {/* Form fields — primary input method; remounts on type change via key */}
          <SchemaFormFields
            key={schemaType}
            schemaType={schemaType}
            onChange={handleFormChange}
            initialValue={loadedSchema?.content ?? null}
          />

          {/* Saved validation errors from scan */}
          {loadedSchema?.validation_errors && loadedSchema.validation_errors.length > 0 && (
            <div className="mb-4 rounded-lg border border-red-800/50 bg-red-950/20 p-3">
              <p className="mb-2 text-xs font-semibold text-red-400 uppercase tracking-wider">
                Issues from scan
              </p>
              <div className="flex flex-col gap-1">
                {loadedSchema.validation_errors.slice(0, 5).map((issue, i) => (
                  <IssueRow key={i} issue={issue} />
                ))}
                {loadedSchema.validation_errors.length > 5 && (
                  <p className="text-xs text-zinc-500 px-2">
                    + {loadedSchema.validation_errors.length - 5} more (fix errors in JSON below)
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Missing opportunities from scan */}
          {loadedSchema?.missing_opportunities && loadedSchema.missing_opportunities.length > 0 && (
            <div className="rounded-lg border border-zinc-700 bg-zinc-800 p-3">
              <p className="mb-2 text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                Also consider adding
              </p>
              <div className="flex flex-wrap gap-2">
                {loadedSchema.missing_opportunities.map((opp, i) => (
                  <button
                    key={i}
                    onClick={() => router.push(`/editor?type=${encodeURIComponent(opp.schemaType)}`)}
                    className="rounded-md border border-zinc-600 px-2 py-1 text-xs text-zinc-300 transition-colors hover:bg-zinc-700"
                    title={opp.reason}
                  >
                    + {opp.schemaType}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right panel — JSON preview + validation */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
              JSON-LD Output
              <span className="ml-2 text-xs font-normal normal-case tracking-normal text-zinc-600">(editable)</span>
            </h2>
            <button
              onClick={handleCopy}
              className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>

          <textarea
            value={jsonOutput}
            onChange={(e) => setJsonOutput(e.target.value)}
            spellCheck={false}
            className="h-64 w-full rounded-lg bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-emerald-400 focus:outline-none resize-none"
          />

          <ValidationPanel result={validationResult} />
        </div>
      </div>
    </div>
  );
}

export default function EditorPage() {
  return (
    <Suspense fallback={<div className="text-zinc-400 text-sm">Loading editor…</div>}>
      <EditorContent />
    </Suspense>
  );
}
