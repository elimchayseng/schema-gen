import Link from "next/link";

const placeholderSchemas = [
  {
    id: "1",
    name: "Product — Summer Collection Tee",
    type: "Product",
    updatedAt: "2025-01-15",
  },
  {
    id: "2",
    name: "FAQ — Shipping & Returns",
    type: "FAQPage",
    updatedAt: "2025-01-12",
  },
  {
    id: "3",
    name: "Breadcrumb — Category Nav",
    type: "BreadcrumbList",
    updatedAt: "2025-01-10",
  },
];

export default function DashboardPage() {
  return (
    <div>
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Workspace</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Manage your Shopify schema markup templates.
          </p>
        </div>
        <Link
          href="/editor"
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
        >
          + New Schema
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {placeholderSchemas.map((schema) => (
          <Link
            key={schema.id}
            href={`/editor?id=${schema.id}`}
            className="group rounded-xl border border-zinc-800 bg-zinc-900 p-5 transition-colors hover:border-zinc-700"
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="rounded-md bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-300">
                {schema.type}
              </span>
              <span className="text-xs text-zinc-500">{schema.updatedAt}</span>
            </div>
            <h2 className="text-sm font-semibold text-white group-hover:text-indigo-400">
              {schema.name}
            </h2>
          </Link>
        ))}
      </div>

      {placeholderSchemas.length === 0 && (
        <div className="rounded-xl border border-dashed border-zinc-800 p-12 text-center">
          <p className="text-zinc-500">
            No schemas yet. Create your first one to get started.
          </p>
        </div>
      )}
    </div>
  );
}
