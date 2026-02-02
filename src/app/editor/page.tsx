"use client";

import Link from "next/link";
import { useState } from "react";

const schemaTypes = [
  "Product",
  "FAQPage",
  "BreadcrumbList",
  "Organization",
  "LocalBusiness",
  "WebSite",
  "Article",
] as const;

const defaultSchema = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "",
  description: "",
  image: "",
  brand: {
    "@type": "Brand",
    name: "",
  },
  offers: {
    "@type": "Offer",
    price: "",
    priceCurrency: "USD",
    availability: "https://schema.org/InStock",
  },
};

export default function EditorPage() {
  const [schemaType, setSchemaType] = useState<string>("Product");
  const [jsonOutput, setJsonOutput] = useState<string>(
    JSON.stringify(defaultSchema, null, 2)
  );

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/dashboard"
            className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-white"
          >
            &larr; Back
          </Link>
          <h1 className="text-xl font-bold text-white">Schema Editor</h1>
        </div>
        <button className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500">
          Save Schema
        </button>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left panel — form controls */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-400">
            Configuration
          </h2>

          <label className="mb-1 block text-sm text-zinc-300">
            Schema Type
          </label>
          <select
            value={schemaType}
            onChange={(e) => setSchemaType(e.target.value)}
            className="mb-5 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none"
          >
            {schemaTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          <label className="mb-1 block text-sm text-zinc-300">Name</label>
          <input
            type="text"
            placeholder="e.g. Summer Collection Tee"
            className="mb-5 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
          />

          <label className="mb-1 block text-sm text-zinc-300">
            Description
          </label>
          <textarea
            rows={3}
            placeholder="Brief product or page description..."
            className="mb-5 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
          />

          <label className="mb-1 block text-sm text-zinc-300">Image URL</label>
          <input
            type="text"
            placeholder="https://cdn.shopify.com/..."
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>

        {/* Right panel — JSON preview */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
              JSON-LD Output
            </h2>
            <button
              onClick={() => navigator.clipboard.writeText(jsonOutput)}
              className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              Copy
            </button>
          </div>
          <pre className="max-h-[500px] overflow-auto rounded-lg bg-zinc-950 p-4 text-xs leading-relaxed text-emerald-400">
            <code>{jsonOutput}</code>
          </pre>
        </div>
      </div>
    </div>
  );
}
