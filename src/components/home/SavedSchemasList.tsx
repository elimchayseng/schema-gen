"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import Link from "next/link";

interface SavedSchema {
  id: string;
  name: string;
  schema_type: string;
  source_url: string | null;
  updated_at: string;
  validation_errors: unknown[] | null;
}

// Schema types that apply to the whole site, not a specific page
const SITE_WIDE_TYPES = new Set(["WebSite", "Organization", "LocalBusiness"]);

function extractDomain(url: string | null): string {
  if (!url) return "Unknown";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Unknown";
  }
}

function extractPagePath(url: string | null): string {
  if (!url) return "/";
  try {
    const u = new URL(url);
    return u.pathname === "/" ? "/" : u.pathname;
  } catch {
    return "/";
  }
}

/** Derive a clean page label from the schemas in a page group */
function getPageLabel(schemas: SavedSchema[]): string {
  const primary = schemas.find((s) => !SITE_WIDE_TYPES.has(s.schema_type));
  if (primary) {
    const dashIdx = primary.name.indexOf("—");
    if (dashIdx !== -1) return primary.name.slice(dashIdx + 1).trim();
    return primary.name;
  }
  return schemas[0]?.name ?? "Unknown";
}

interface SiteGroup {
  domain: string;
  pages: PageGroup[];
  siteWide: SavedSchema[];
  totalErrors: number;
}

interface PageGroup {
  path: string;
  label: string;
  schemas: SavedSchema[];
  errorCount: number;
}

function groupSchemas(schemas: SavedSchema[]): SiteGroup[] {
  const domainMap = new Map<string, SavedSchema[]>();
  for (const s of schemas) {
    const domain = extractDomain(s.source_url);
    const list = domainMap.get(domain) ?? [];
    list.push(s);
    domainMap.set(domain, list);
  }

  const groups: SiteGroup[] = [];
  for (const [domain, domainSchemas] of domainMap) {
    const siteWide: SavedSchema[] = [];
    const pageMap = new Map<string, SavedSchema[]>();

    for (const s of domainSchemas) {
      if (SITE_WIDE_TYPES.has(s.schema_type)) {
        siteWide.push(s);
      } else {
        const path = extractPagePath(s.source_url);
        const list = pageMap.get(path) ?? [];
        list.push(s);
        pageMap.set(path, list);
      }
    }

    const pages: PageGroup[] = [];
    for (const [path, pageSchemas] of pageMap) {
      pages.push({
        path,
        label: getPageLabel(pageSchemas),
        schemas: pageSchemas,
        errorCount: pageSchemas.reduce(
          (sum, s) => sum + (s.validation_errors?.length ?? 0),
          0
        ),
      });
    }
    pages.sort((a, b) => a.label.localeCompare(b.label));

    const totalErrors =
      siteWide.reduce(
        (sum, s) => sum + (s.validation_errors?.length ?? 0),
        0
      ) + pages.reduce((sum, p) => sum + p.errorCount, 0);

    groups.push({ domain, pages, siteWide, totalErrors });
  }

  groups.sort((a, b) => a.domain.localeCompare(b.domain));
  return groups;
}

// --- Animated collapse/expand ---
function useCollapse(defaultOpen: boolean) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">(defaultOpen ? "auto" : 0);

  const toggle = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;

    if (isOpen) {
      // Collapse: measure current height, set it explicitly, then transition to 0
      setHeight(el.scrollHeight);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setHeight(0));
      });
    } else {
      // Expand: transition from 0 to scrollHeight, then set to auto
      setHeight(el.scrollHeight);
    }
    setIsOpen(!isOpen);
  }, [isOpen]);

  const onTransitionEnd = useCallback(() => {
    if (isOpen) setHeight("auto");
  }, [isOpen]);

  return { isOpen, toggle, contentRef, height, onTransitionEnd };
}

// --- Components ---

function SiteSection({ group, index }: { group: SiteGroup; index: number }) {
  const { isOpen, toggle, contentRef, height, onTransitionEnd } =
    useCollapse(true);
  const pageCount = group.pages.length;
  const isClean = group.totalErrors === 0;

  return (
    <div
      className="site-group border border-border rounded-md overflow-hidden"
      style={{ animationDelay: `${index * 80}ms` }}
    >
      {/* Domain header */}
      <button
        onClick={toggle}
        className="group w-full flex items-center gap-3 px-4 py-3 bg-surface-1 text-left transition-colors hover:bg-surface-2/60"
      >
        {/* Health dot */}
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
            isClean ? "bg-valid" : "bg-error"
          }`}
          style={{
            boxShadow: isClean
              ? "0 0 6px rgba(16,185,129,0.4)"
              : "0 0 6px rgba(239,68,68,0.4)",
          }}
        />
        <span className="text-sm font-semibold text-text-primary font-serif">
          {group.domain}
        </span>
        <span className="text-[10px] text-text-muted">
          {pageCount} {pageCount === 1 ? "page" : "pages"}
          {group.siteWide.length > 0 &&
            ` · ${group.siteWide.length} site-wide`}
        </span>
        {group.totalErrors > 0 && (
          <span className="font-mono text-[10px] text-error">
            {group.totalErrors} {group.totalErrors === 1 ? "error" : "errors"}
          </span>
        )}
        {/* Animated chevron */}
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          className={`ml-auto text-text-muted transition-transform duration-200 ${
            isOpen ? "rotate-0" : "-rotate-90"
          }`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2.5 3.5L5 6.5L7.5 3.5" />
        </svg>
      </button>

      {/* Animated content */}
      <div
        ref={contentRef}
        onTransitionEnd={onTransitionEnd}
        className="transition-[height] duration-250 ease-in-out overflow-hidden"
        style={{ height: typeof height === "number" ? `${height}px` : "auto" }}
      >
        <div className="divide-y divide-border">
          {group.pages.map((page, i) => (
            <PageSection key={page.path} page={page} index={i} />
          ))}

          {group.siteWide.length > 0 && (
            <div className="px-4 py-2.5">
              <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted mb-1.5">
                Site-wide
              </div>
              <div className="flex flex-wrap gap-1.5">
                {group.siteWide.map((s) => (
                  <SchemaBadge key={s.id} schema={s} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PageSection({ page, index }: { page: PageGroup; index: number }) {
  return (
    <div
      className="page-row relative px-4 py-2.5 transition-all duration-150"
      style={{ animationDelay: `${index * 40}ms` }}
    >
      {/* Accent border on hover */}
      <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-accent scale-y-0 origin-center transition-transform duration-200 page-row-accent" />
      <div className="flex items-center gap-2 mb-1">
        <span className="text-sm text-text-primary font-medium truncate">
          {page.label}
        </span>
        {page.errorCount > 0 ? (
          <span className="font-mono text-[10px] text-error shrink-0">
            {page.errorCount} {page.errorCount === 1 ? "error" : "errors"}
          </span>
        ) : (
          <span className="font-mono text-[10px] text-valid/60 shrink-0">
            clean
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {page.schemas.map((s) => (
          <SchemaBadge key={s.id} schema={s} />
        ))}
      </div>
    </div>
  );
}

function SchemaBadge({ schema }: { schema: SavedSchema }) {
  const errorCount = schema.validation_errors?.length ?? 0;
  return (
    <Link
      href={`/editor?id=${schema.id}`}
      className="schema-badge inline-flex items-center gap-1.5 rounded-sm bg-surface-2 px-2 py-1 text-[10px] font-mono text-text-secondary transition-all duration-150"
    >
      <span className="text-accent font-medium">{schema.schema_type}</span>
      {errorCount > 0 && (
        <span className="text-error">{errorCount} err</span>
      )}
    </Link>
  );
}

// --- Skeleton loading ---
function SkeletonGroup() {
  return (
    <div className="border border-border rounded-md overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 bg-surface-1">
        <div className="w-1.5 h-1.5 rounded-full bg-surface-3 skeleton-shimmer" />
        <div className="h-3.5 w-36 rounded bg-surface-3 skeleton-shimmer" />
        <div className="h-2.5 w-16 rounded bg-surface-2 skeleton-shimmer" style={{ animationDelay: "100ms" }} />
      </div>
      <div className="divide-y divide-border">
        {[1, 2].map((i) => (
          <div key={i} className="px-4 py-2.5">
            <div className="h-3.5 w-40 rounded bg-surface-2 skeleton-shimmer mb-2" style={{ animationDelay: `${i * 80}ms` }} />
            <div className="flex gap-1.5">
              <div className="h-5 w-16 rounded-sm bg-surface-2 skeleton-shimmer" style={{ animationDelay: `${i * 80 + 40}ms` }} />
              <div className="h-5 w-24 rounded-sm bg-surface-2 skeleton-shimmer" style={{ animationDelay: `${i * 80 + 80}ms` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div>
      <div className="mb-3 h-3 w-24 rounded bg-surface-2 skeleton-shimmer" />
      <div className="space-y-3">
        <SkeletonGroup />
        <SkeletonGroup />
      </div>
    </div>
  );
}

// --- Main component ---

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
      } catch (err) {
        console.error("[SavedSchemasList] failed to load schemas:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) return <LoadingSkeleton />;

  if (schemas.length === 0) {
    return (
      <div className="rounded-md border border-border border-dashed bg-surface-1/50 px-5 py-10 text-center">
        <div className="text-2xl mb-3 opacity-40">{ }</div>
        <p className="text-sm text-text-secondary mb-1">
          No schemas yet
        </p>
        <p className="text-xs text-text-muted">
          Paste a URL above to scan, validate, and optimize its structured data
        </p>
      </div>
    );
  }

  const groups = groupSchemas(schemas);
  const totalSchemas = schemas.length;
  const totalSites = groups.length;

  return (
    <div>
      <div className="flex items-baseline gap-3 mb-3">
        <h2 className="font-serif text-xs uppercase tracking-wider text-text-muted">
          Saved Schemas
        </h2>
        <span className="text-[10px] text-text-muted/60">
          {totalSchemas} schemas across {totalSites}{" "}
          {totalSites === 1 ? "site" : "sites"}
        </span>
      </div>
      <div className="space-y-3">
        {groups.map((group, i) => (
          <SiteSection key={group.domain} group={group} index={i} />
        ))}
      </div>
    </div>
  );
}
