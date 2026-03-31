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

// Schema types that represent distinct items worth showing by name
const NAMED_TYPES = new Set([
  "Product",
  "Article",
  "BlogPosting",
  "NewsArticle",
  "Recipe",
  "Event",
  "Course",
  "Book",
  "Movie",
  "SoftwareApplication",
  "VideoObject",
  "MusicRecording",
  "CreativeWork",
]);

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

/** Extract the human-readable name from a schema (the part after "—") */
function extractSchemaName(schema: SavedSchema): string | null {
  const dashIdx = schema.name.indexOf("—");
  if (dashIdx !== -1) return schema.name.slice(dashIdx + 1).trim();
  return null;
}

// --- Grouping types ---

interface SchemaTypeGroup {
  schemaType: string;
  schemas: SavedSchema[];
  cleanCount: number;
  errorCount: number;
  pages: string[];
  isNamed: boolean; // true if instances have distinct names (Product, Article, etc.)
}

interface SiteGroup {
  domain: string;
  typeGroups: SchemaTypeGroup[];
  siteWideTypes: SchemaTypeGroup[];
  totalErrors: number;
  pageCount: number;
}

function groupBySchemaType(schemas: SavedSchema[]): SchemaTypeGroup[] {
  const typeMap = new Map<string, SavedSchema[]>();
  for (const s of schemas) {
    const list = typeMap.get(s.schema_type) ?? [];
    list.push(s);
    typeMap.set(s.schema_type, list);
  }

  const groups: SchemaTypeGroup[] = [];
  for (const [schemaType, typeSchemas] of typeMap) {
    const errorCount = typeSchemas.reduce(
      (sum, s) => sum + (s.validation_errors?.length ?? 0),
      0
    );
    const cleanCount = typeSchemas.filter(
      (s) => !s.validation_errors?.length
    ).length;
    const pages = [
      ...new Set(typeSchemas.map((s) => extractPagePath(s.source_url))),
    ];

    // Only whitelist types represent distinct items worth showing by name
    const isNamed = NAMED_TYPES.has(schemaType);

    groups.push({
      schemaType,
      schemas: typeSchemas,
      cleanCount,
      errorCount,
      pages,
      isNamed,
    });
  }

  groups.sort((a, b) => a.schemaType.localeCompare(b.schemaType));
  return groups;
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
    const pageSpecific: SavedSchema[] = [];
    const pageUrls = new Set<string>();

    for (const s of domainSchemas) {
      if (SITE_WIDE_TYPES.has(s.schema_type)) {
        siteWide.push(s);
      } else {
        pageSpecific.push(s);
      }
      pageUrls.add(extractPagePath(s.source_url));
    }

    const typeGroups = groupBySchemaType(pageSpecific);
    const siteWideTypes = groupBySchemaType(siteWide);

    const totalErrors =
      siteWide.reduce(
        (sum, s) => sum + (s.validation_errors?.length ?? 0),
        0
      ) +
      pageSpecific.reduce(
        (sum, s) => sum + (s.validation_errors?.length ?? 0),
        0
      );

    groups.push({
      domain,
      typeGroups,
      siteWideTypes,
      totalErrors,
      pageCount: pageUrls.size,
    });
  }

  groups.sort((a, b) => a.domain.localeCompare(b.domain));
  return groups;
}

// --- Animated collapse/expand ---
function useCollapse(defaultOpen: boolean) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">(
    defaultOpen ? "auto" : 0
  );

  const toggle = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;

    if (isOpen) {
      setHeight(el.scrollHeight);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setHeight(0));
      });
    } else {
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
  const isClean = group.totalErrors === 0;
  const uniqueTypes =
    group.typeGroups.length + group.siteWideTypes.length;

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
          {group.pageCount} {group.pageCount === 1 ? "page" : "pages"}
          {" · "}
          {uniqueTypes} {uniqueTypes === 1 ? "type" : "types"}
        </span>
        {group.totalErrors > 0 && (
          <span className="font-mono text-[10px] text-error">
            {group.totalErrors} {group.totalErrors === 1 ? "error" : "errors"}
          </span>
        )}
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
          {group.typeGroups.map((tg, i) => (
            <TypeSection key={tg.schemaType} group={tg} index={i} />
          ))}

          {group.siteWideTypes.length > 0 && (
            <div className="px-4 py-2.5">
              <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted mb-1.5">
                Site-wide
              </div>
              <div className="flex flex-wrap gap-1.5">
                {group.siteWideTypes.map((tg) => (
                  <SiteWideBadge key={tg.schemaType} group={tg} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Renders a type group — either as expandable collapsed row or as named items */
function TypeSection({
  group,
  index,
}: {
  group: SchemaTypeGroup;
  index: number;
}) {
  if (group.isNamed) {
    return <NamedTypeSection group={group} index={index} />;
  }
  return <CollapsedTypeSection group={group} index={index} />;
}

/** Named schemas (Product, Article, etc.) — each instance shown with its name */
function NamedTypeSection({
  group,
  index,
}: {
  group: SchemaTypeGroup;
  index: number;
}) {
  return (
    <div
      className="px-4 py-2.5"
      style={{ animationDelay: `${index * 40}ms` }}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-accent">
          {group.schemaType}
        </span>
        {group.schemas.length > 1 && (
          <span className="text-[9px] font-mono text-text-muted bg-surface-2 px-1.5 py-0.5 rounded">
            {group.schemas.length}
          </span>
        )}
        {group.errorCount > 0 ? (
          <span className="font-mono text-[10px] text-error">
            {group.errorCount} {group.errorCount === 1 ? "error" : "errors"}
          </span>
        ) : (
          <span className="font-mono text-[10px] text-valid/60">clean</span>
        )}
      </div>
      <div className="space-y-1">
        {group.schemas.map((s) => {
          const displayName = extractSchemaName(s) ?? s.schema_type;
          const errors = s.validation_errors?.length ?? 0;
          return (
            <Link
              key={s.id}
              href={`/editor?id=${s.id}`}
              className="page-row group/item relative flex items-center gap-2 rounded-sm px-2.5 py-1.5 -mx-1 transition-all duration-150 hover:bg-surface-2/60"
            >
              <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-accent scale-y-0 origin-center transition-transform duration-200 page-row-accent rounded-l" />
              <span className="text-sm text-text-primary truncate">
                {displayName}
              </span>
              {errors > 0 ? (
                <span className="font-mono text-[10px] text-error shrink-0">
                  {errors} err
                </span>
              ) : (
                <span className="font-mono text-[10px] text-valid/60 shrink-0">
                  clean
                </span>
              )}
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                className="ml-auto text-text-muted/0 group-hover/item:text-text-muted transition-colors"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3.5 2L7 5L3.5 8" />
              </svg>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

/** Structural schemas (BreadcrumbList, etc.) — collapsed with count, expandable */
function CollapsedTypeSection({
  group,
  index,
}: {
  group: SchemaTypeGroup;
  index: number;
}) {
  const { isOpen, toggle, contentRef, height, onTransitionEnd } =
    useCollapse(false);
  const count = group.schemas.length;

  // If only 1 instance, link directly instead of expanding
  if (count === 1) {
    const s = group.schemas[0];
    const errors = s.validation_errors?.length ?? 0;
    return (
      <Link
        href={`/editor?id=${s.id}`}
        className="page-row relative flex items-center gap-2 px-4 py-2.5 transition-all duration-150 hover:bg-surface-2/40"
        style={{ animationDelay: `${index * 40}ms` }}
      >
        <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-accent scale-y-0 origin-center transition-transform duration-200 page-row-accent" />
        <span className="text-sm text-text-primary font-medium">
          {group.schemaType}
        </span>
        {errors > 0 ? (
          <span className="font-mono text-[10px] text-error shrink-0">
            {errors} {errors === 1 ? "error" : "errors"}
          </span>
        ) : (
          <span className="font-mono text-[10px] text-valid/60 shrink-0">
            clean
          </span>
        )}
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          className="ml-auto text-text-muted/40"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3.5 2L7 5L3.5 8" />
        </svg>
      </Link>
    );
  }

  return (
    <div style={{ animationDelay: `${index * 40}ms` }}>
      <button
        onClick={toggle}
        className="page-row relative w-full flex items-center gap-2 px-4 py-2.5 text-left transition-all duration-150 hover:bg-surface-2/40"
      >
        <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-accent scale-y-0 origin-center transition-transform duration-200 page-row-accent" />
        <span className="text-sm text-text-primary font-medium">
          {group.schemaType}
        </span>
        <span className="text-[9px] font-mono text-text-muted bg-surface-2 px-1.5 py-0.5 rounded">
          &times;{count}
        </span>
        {group.errorCount > 0 ? (
          <span className="font-mono text-[10px] text-error shrink-0">
            {group.cleanCount}/{count} clean
          </span>
        ) : (
          <span className="font-mono text-[10px] text-valid/60 shrink-0">
            clean
          </span>
        )}
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          className={`ml-auto text-text-muted transition-transform duration-200 ${
            isOpen ? "rotate-90" : "rotate-0"
          }`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3.5 2L7 5L3.5 8" />
        </svg>
      </button>

      <div
        ref={contentRef}
        onTransitionEnd={onTransitionEnd}
        className="transition-[height] duration-200 ease-in-out overflow-hidden"
        style={{ height: typeof height === "number" ? `${height}px` : "auto" }}
      >
        <div className="pl-8 pr-4 pb-2 space-y-0.5">
          {group.schemas.map((s) => {
            const path = extractPagePath(s.source_url);
            const errors = s.validation_errors?.length ?? 0;
            return (
              <Link
                key={s.id}
                href={`/editor?id=${s.id}`}
                className="group/sub flex items-center gap-2 rounded-sm px-2 py-1 text-[11px] transition-colors hover:bg-surface-2/60"
              >
                <span className="text-text-muted font-mono truncate">
                  {path}
                </span>
                {errors > 0 ? (
                  <span className="font-mono text-[10px] text-error shrink-0">
                    {errors} err
                  </span>
                ) : (
                  <span className="font-mono text-[10px] text-valid/60 shrink-0">
                    clean
                  </span>
                )}
                <svg
                  width="8"
                  height="8"
                  viewBox="0 0 10 10"
                  className="ml-auto text-text-muted/0 group-hover/sub:text-text-muted transition-colors shrink-0"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3.5 2L7 5L3.5 8" />
                </svg>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Deduplicated site-wide badge — shows type once with count */
function SiteWideBadge({ group }: { group: SchemaTypeGroup }) {
  const errorCount = group.errorCount;
  const count = group.schemas.length;
  // Link to the most recently updated instance
  const newest = group.schemas.reduce((a, b) =>
    a.updated_at > b.updated_at ? a : b
  );

  return (
    <Link
      href={`/editor?id=${newest.id}`}
      className="schema-badge inline-flex items-center gap-1.5 rounded-sm bg-surface-2 px-2 py-1 text-[10px] font-mono text-text-secondary transition-all duration-150"
    >
      <span className="text-accent font-medium">{group.schemaType}</span>
      {count > 1 && (
        <span className="text-text-muted">&times;{count}</span>
      )}
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
        {[1, 2, 3].map((i) => (
          <div key={i} className="px-4 py-2.5">
            <div className="flex items-center gap-2">
              <div className="h-3.5 w-28 rounded bg-surface-2 skeleton-shimmer" style={{ animationDelay: `${i * 80}ms` }} />
              <div className="h-4 w-8 rounded bg-surface-2 skeleton-shimmer" style={{ animationDelay: `${i * 80 + 40}ms` }} />
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
