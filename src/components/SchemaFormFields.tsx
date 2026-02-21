"use client";

import { useState, useEffect, useCallback } from "react";

// ─── Utilities ──────────────────────────────────────────────────────────────

function generateId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : String(Date.now() + Math.random());
}

function omitEmpty(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== "" && v !== null && v !== undefined)
  );
}

// ─── Form State Interfaces ──────────────────────────────────────────────────

interface WebSiteFormState {
  name: string;
  url: string;
}

interface OrganizationFormState {
  name: string;
  url: string;
  logo: string;
  description: string;
  telephone: string;
  email: string;
}

interface ArticleFormState {
  headline: string;
  authorName: string;
  datePublished: string;
  dateModified: string;
  image: string;
  publisherName: string;
}

interface ReviewFormState {
  authorName: string;
  ratingValue: string;
  bestRating: string;
  reviewBody: string;
  datePublished: string;
}

interface EventFormState {
  name: string;
  startDate: string;
  endDate: string;
  locationName: string;
  locationAddress: string;
}

interface ProductFormState {
  name: string;
  description: string;
  image: string;
  url: string;
  brandName: string;
  sku: string;
  price: string;
  priceCurrency: string;
  availability: string;
  color: string;
  material: string;
}

interface LocalBusinessFormState {
  name: string;
  url: string;
  telephone: string;
  image: string;
  priceRange: string;
  streetAddress: string;
  addressLocality: string;
  addressRegion: string;
  postalCode: string;
  addressCountry: string;
}

interface FAQEntry {
  id: string;
  question: string;
  answer: string;
}

interface BreadcrumbEntry {
  id: string;
  name: string;
  item: string;
}

interface FAQPageFormState {
  entries: FAQEntry[];
}

interface BreadcrumbListFormState {
  entries: BreadcrumbEntry[];
}

type SchemaFormState =
  | { type: "WebSite"; data: WebSiteFormState }
  | { type: "Organization"; data: OrganizationFormState }
  | { type: "Article"; data: ArticleFormState }
  | { type: "BlogPosting"; data: ArticleFormState }
  | { type: "Review"; data: ReviewFormState }
  | { type: "Event"; data: EventFormState }
  | { type: "Product"; data: ProductFormState }
  | { type: "LocalBusiness"; data: LocalBusinessFormState }
  | { type: "FAQPage"; data: FAQPageFormState }
  | { type: "BreadcrumbList"; data: BreadcrumbListFormState };

// ─── Default State Factories ─────────────────────────────────────────────────

function defaultWebSite(): WebSiteFormState {
  return { name: "", url: "" };
}

function defaultOrganization(): OrganizationFormState {
  return { name: "", url: "", logo: "", description: "", telephone: "", email: "" };
}

function defaultArticle(): ArticleFormState {
  return { headline: "", authorName: "", datePublished: "", dateModified: "", image: "", publisherName: "" };
}

function defaultReview(): ReviewFormState {
  return { authorName: "", ratingValue: "5", bestRating: "5", reviewBody: "", datePublished: "" };
}

function defaultEvent(): EventFormState {
  return { name: "", startDate: "", endDate: "", locationName: "", locationAddress: "" };
}

function defaultProduct(): ProductFormState {
  return {
    name: "", description: "", image: "", url: "",
    brandName: "", sku: "",
    price: "", priceCurrency: "USD",
    availability: "https://schema.org/InStock",
    color: "", material: "",
  };
}

function defaultLocalBusiness(): LocalBusinessFormState {
  return {
    name: "", url: "", telephone: "", image: "", priceRange: "",
    streetAddress: "", addressLocality: "", addressRegion: "",
    postalCode: "", addressCountry: "US",
  };
}

function defaultFAQPage(): FAQPageFormState {
  return { entries: [{ id: generateId(), question: "", answer: "" }] };
}

function defaultBreadcrumbList(): BreadcrumbListFormState {
  return {
    entries: [
      { id: generateId(), name: "Home", item: "" },
      { id: generateId(), name: "", item: "" },
    ],
  };
}

function getDefaultFormState(type: string): SchemaFormState {
  switch (type) {
    case "WebSite":        return { type: "WebSite",        data: defaultWebSite() };
    case "Organization":   return { type: "Organization",   data: defaultOrganization() };
    case "Article":        return { type: "Article",        data: defaultArticle() };
    case "BlogPosting":    return { type: "BlogPosting",    data: defaultArticle() };
    case "Review":         return { type: "Review",         data: defaultReview() };
    case "Event":          return { type: "Event",          data: defaultEvent() };
    case "LocalBusiness":  return { type: "LocalBusiness",  data: defaultLocalBusiness() };
    case "FAQPage":        return { type: "FAQPage",        data: defaultFAQPage() };
    case "BreadcrumbList": return { type: "BreadcrumbList", data: defaultBreadcrumbList() };
    case "Product":
    default:               return { type: "Product",        data: defaultProduct() };
  }
}

// ─── Builder Functions (form state → JSON-LD) ───────────────────────────────

function buildWebSiteJson(data: WebSiteFormState): Record<string, unknown> {
  return omitEmpty({ "@context": "https://schema.org", "@type": "WebSite", name: data.name, url: data.url });
}

function buildOrganizationJson(data: OrganizationFormState): Record<string, unknown> {
  return omitEmpty({
    "@context": "https://schema.org", "@type": "Organization",
    name: data.name, url: data.url, logo: data.logo,
    description: data.description, telephone: data.telephone, email: data.email,
  });
}

function buildArticleJson(data: ArticleFormState, type: "Article" | "BlogPosting"): Record<string, unknown> {
  const result: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": type,
  };
  if (data.headline)                            result.headline      = data.headline;
  if (data.authorName)                          result.author        = { "@type": "Person", name: data.authorName };
  if (data.datePublished)                       result.datePublished = data.datePublished;
  if (type === "Article" && data.dateModified)  result.dateModified  = data.dateModified;
  if (data.image)                               result.image         = data.image;
  if (data.publisherName)                       result.publisher     = { "@type": "Organization", name: data.publisherName };
  return result;
}

function buildReviewJson(data: ReviewFormState): Record<string, unknown> {
  const result: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Review",
    reviewRating: {
      "@type": "Rating",
      ratingValue: data.ratingValue || "5",
      bestRating: data.bestRating || "5",
    },
  };
  if (data.authorName)    result.author        = { "@type": "Person", name: data.authorName };
  if (data.reviewBody)    result.reviewBody    = data.reviewBody;
  if (data.datePublished) result.datePublished = data.datePublished;
  return result;
}

function buildEventJson(data: EventFormState): Record<string, unknown> {
  const result: Record<string, unknown> = { "@context": "https://schema.org", "@type": "Event" };
  if (data.name)      result.name      = data.name;
  if (data.startDate) result.startDate = data.startDate;
  if (data.endDate)   result.endDate   = data.endDate;
  if (data.locationName || data.locationAddress) {
    result.location = { "@type": "Place", name: data.locationName, address: data.locationAddress };
  }
  return result;
}

function buildProductJson(data: ProductFormState): Record<string, unknown> {
  const result: Record<string, unknown> = { "@context": "https://schema.org", "@type": "Product" };
  if (data.name)        result.name        = data.name;
  if (data.description) result.description = data.description;
  if (data.image)       result.image       = data.image;
  if (data.url)         result.url         = data.url;
  if (data.sku)         result.sku         = data.sku;
  if (data.color)       result.color       = data.color;
  if (data.material)    result.material    = data.material;
  if (data.brandName)   result.brand       = { "@type": "Brand", name: data.brandName };

  const offer: Record<string, unknown> = { "@type": "Offer" };
  if (data.price)         offer.price         = Number(data.price) || data.price;
  if (data.priceCurrency) offer.priceCurrency = data.priceCurrency;
  if (data.availability)  offer.availability  = data.availability;
  result.offers = offer;

  return result;
}

function buildLocalBusinessJson(data: LocalBusinessFormState): Record<string, unknown> {
  const result: Record<string, unknown> = { "@context": "https://schema.org", "@type": "LocalBusiness" };
  if (data.name)       result.name       = data.name;
  if (data.url)        result.url        = data.url;
  if (data.telephone)  result.telephone  = data.telephone;
  if (data.image)      result.image      = data.image;
  if (data.priceRange) result.priceRange = data.priceRange;

  const addr: Record<string, unknown> = { "@type": "PostalAddress" };
  if (data.streetAddress)   addr.streetAddress   = data.streetAddress;
  if (data.addressLocality) addr.addressLocality = data.addressLocality;
  if (data.addressRegion)   addr.addressRegion   = data.addressRegion;
  if (data.postalCode)      addr.postalCode      = data.postalCode;
  if (data.addressCountry)  addr.addressCountry  = data.addressCountry;
  result.address = addr;
  return result;
}

function buildFAQPageJson(data: FAQPageFormState): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: data.entries
      .filter(e => e.question.trim() || e.answer.trim())
      .map(e => ({
        "@type": "Question",
        name: e.question,
        acceptedAnswer: { "@type": "Answer", text: e.answer },
      })),
  };
}

function buildBreadcrumbListJson(data: BreadcrumbListFormState): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: data.entries.map((e, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: e.name,
      item: e.item,
    })),
  };
}

function buildJson(state: SchemaFormState): Record<string, unknown> {
  switch (state.type) {
    case "WebSite":        return buildWebSiteJson(state.data);
    case "Organization":   return buildOrganizationJson(state.data);
    case "Article":        return buildArticleJson(state.data, "Article");
    case "BlogPosting":    return buildArticleJson(state.data, "BlogPosting");
    case "Review":         return buildReviewJson(state.data);
    case "Event":          return buildEventJson(state.data);
    case "Product":        return buildProductJson(state.data);
    case "LocalBusiness":  return buildLocalBusinessJson(state.data);
    case "FAQPage":        return buildFAQPageJson(state.data);
    case "BreadcrumbList": return buildBreadcrumbListJson(state.data);
  }
}

// ─── Hydration Functions (JSON-LD → form state) ──────────────────────────────

function hydrateFormState(type: string, json: Record<string, unknown>): SchemaFormState | null {
  const jsonType = json["@type"] as string | undefined;
  if (jsonType && jsonType !== type) return null; // type mismatch — don't hydrate

  const str = (v: unknown) => (v !== undefined && v !== null ? String(v) : "");
  const nested = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

  switch (type) {
    case "WebSite":
      return { type: "WebSite", data: { name: str(json.name), url: str(json.url) } };

    case "Organization":
      return {
        type: "Organization",
        data: {
          name: str(json.name), url: str(json.url), logo: str(json.logo),
          description: str(json.description), telephone: str(json.telephone), email: str(json.email),
        },
      };

    case "Article":
    case "BlogPosting": {
      const author = nested(json.author);
      const publisher = nested(json.publisher);
      return {
        type: type as "Article" | "BlogPosting",
        data: {
          headline: str(json.headline),
          authorName: str(author.name),
          datePublished: str(json.datePublished),
          dateModified: str(json.dateModified),
          image: str(json.image),
          publisherName: str(publisher.name),
        },
      };
    }

    case "Review": {
      const author = nested(json.author);
      const rating = nested(json.reviewRating);
      return {
        type: "Review",
        data: {
          authorName: str(author.name),
          ratingValue: str(rating.ratingValue) || "5",
          bestRating: str(rating.bestRating) || "5",
          reviewBody: str(json.reviewBody),
          datePublished: str(json.datePublished),
        },
      };
    }

    case "Event": {
      const location = nested(json.location);
      return {
        type: "Event",
        data: {
          name: str(json.name),
          startDate: str(json.startDate),
          endDate: str(json.endDate),
          locationName: str(location.name),
          locationAddress: str(location.address),
        },
      };
    }

    case "Product": {
      const brand = nested(json.brand);
      const offers = nested(json.offers);
      return {
        type: "Product",
        data: {
          name: str(json.name), description: str(json.description),
          image: str(json.image), url: str(json.url),
          brandName: str(brand.name), sku: str(json.sku),
          price: str(offers.price), priceCurrency: str(offers.priceCurrency) || "USD",
          availability: str(offers.availability) || "https://schema.org/InStock",
          color: str(json.color), material: str(json.material),
        },
      };
    }

    case "LocalBusiness": {
      const address = nested(json.address);
      return {
        type: "LocalBusiness",
        data: {
          name: str(json.name), url: str(json.url), telephone: str(json.telephone),
          image: str(json.image), priceRange: str(json.priceRange),
          streetAddress: str(address.streetAddress), addressLocality: str(address.addressLocality),
          addressRegion: str(address.addressRegion), postalCode: str(address.postalCode),
          addressCountry: str(address.addressCountry) || "US",
        },
      };
    }

    case "FAQPage": {
      const mainEntity = Array.isArray(json.mainEntity) ? (json.mainEntity as Record<string, unknown>[]) : [];
      return {
        type: "FAQPage",
        data: {
          entries: mainEntity.length > 0
            ? mainEntity.map(q => {
                const answer = nested(q.acceptedAnswer);
                return { id: generateId(), question: str(q.name), answer: str(answer.text) };
              })
            : [{ id: generateId(), question: "", answer: "" }],
        },
      };
    }

    case "BreadcrumbList": {
      const items = Array.isArray(json.itemListElement) ? (json.itemListElement as Record<string, unknown>[]) : [];
      return {
        type: "BreadcrumbList",
        data: {
          entries: items.length > 0
            ? items.map(el => ({ id: generateId(), name: str(el.name), item: str(el.item) }))
            : [{ id: generateId(), name: "Home", item: "" }, { id: generateId(), name: "", item: "" }],
        },
      };
    }

    default:
      return null;
  }
}

// ─── Reusable Internal Field Components ─────────────────────────────────────

const inputClass =
  "w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-500 focus:border-indigo-500 focus:outline-none";

function Field({
  label, value, onChange, type = "text", placeholder = "", required = false,
}: {
  label: string; value: string; onChange: (v: string) => void;
  type?: string; placeholder?: string; required?: boolean;
}) {
  return (
    <div className="mb-3">
      <label className="mb-1 block text-sm text-zinc-300">
        {label}
        {required && <span className="ml-1 text-red-400">*</span>}
      </label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={inputClass}
      />
    </div>
  );
}

function TextareaField({
  label, value, onChange, rows = 3, placeholder = "",
}: {
  label: string; value: string; onChange: (v: string) => void;
  rows?: number; placeholder?: string;
}) {
  return (
    <div className="mb-3">
      <label className="mb-1 block text-sm text-zinc-300">{label}</label>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className={`${inputClass} resize-none`}
      />
    </div>
  );
}

function SelectField({
  label, value, onChange, options,
}: {
  label: string; value: string; onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="mb-3">
      <label className="mb-1 block text-sm text-zinc-300">{label}</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className={inputClass}
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <p className="mb-3 mt-5 border-t border-zinc-800 pt-4 text-xs font-semibold uppercase tracking-wider text-zinc-500">
      {label}
    </p>
  );
}

// ─── Multi-Entry: FAQ ────────────────────────────────────────────────────────

function FAQFormSection({
  entries,
  onUpdate,
}: {
  entries: FAQEntry[];
  onUpdate: (entries: FAQEntry[]) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(
    entries.length > 0 ? entries[entries.length - 1].id : null
  );

  function addEntry() {
    const newEntry: FAQEntry = { id: generateId(), question: "", answer: "" };
    onUpdate([...entries, newEntry]);
    setExpandedId(newEntry.id);
  }

  function removeEntry(id: string) {
    if (entries.length <= 1) return;
    onUpdate(entries.filter(e => e.id !== id));
    if (expandedId === id) setExpandedId(null);
  }

  function updateEntry(id: string, field: "question" | "answer", value: string) {
    onUpdate(entries.map(e => (e.id === id ? { ...e, [field]: value } : e)));
  }

  return (
    <div className="mt-1">
      <div className="flex flex-col gap-2">
        {entries.map((entry, index) => {
          const isExpanded = expandedId === entry.id;
          const preview = entry.question.trim() || `Question ${index + 1}`;
          return (
            <div key={entry.id} className="rounded-lg border border-zinc-700 bg-zinc-800/50">
              {/* Card header */}
              <div className="flex items-center gap-2 px-3 py-2">
                <button
                  type="button"
                  onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                  className="flex flex-1 items-center gap-2 text-left"
                >
                  <span className="shrink-0 text-xs font-mono text-zinc-500">{index + 1}.</span>
                  <span className="flex-1 truncate text-sm text-zinc-300">{preview}</span>
                  <span className={`shrink-0 text-zinc-500 text-xs transition-transform ${isExpanded ? "rotate-180" : ""}`}>▼</span>
                </button>
                <button
                  type="button"
                  onClick={() => removeEntry(entry.id)}
                  disabled={entries.length <= 1}
                  className="shrink-0 rounded p-0.5 text-xs text-zinc-500 transition-colors hover:text-red-400 disabled:opacity-30"
                  title="Remove"
                >
                  ×
                </button>
              </div>

              {/* Expanded fields */}
              {isExpanded && (
                <div className="border-t border-zinc-700 px-3 pb-3 pt-3">
                  <Field
                    label="Question"
                    value={entry.question}
                    onChange={v => updateEntry(entry.id, "question", v)}
                    placeholder="What is your return policy?"
                    required
                  />
                  <TextareaField
                    label="Answer"
                    value={entry.answer}
                    onChange={v => updateEntry(entry.id, "answer", v)}
                    placeholder="We offer a 30-day return policy on all items."
                    rows={3}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={addEntry}
        className="mt-3 w-full rounded-lg border border-dashed border-zinc-600 py-2 text-xs font-medium text-zinc-400 transition-colors hover:border-indigo-500 hover:text-indigo-400"
      >
        + Add Question
      </button>
    </div>
  );
}

// ─── Multi-Entry: Breadcrumb ─────────────────────────────────────────────────

function BreadcrumbFormSection({
  entries,
  onUpdate,
}: {
  entries: BreadcrumbEntry[];
  onUpdate: (entries: BreadcrumbEntry[]) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(
    entries.length > 0 ? entries[entries.length - 1].id : null
  );

  function addEntry() {
    const newEntry: BreadcrumbEntry = { id: generateId(), name: "", item: "" };
    onUpdate([...entries, newEntry]);
    setExpandedId(newEntry.id);
  }

  function removeEntry(id: string) {
    if (entries.length <= 1) return;
    onUpdate(entries.filter(e => e.id !== id));
    if (expandedId === id) setExpandedId(null);
  }

  function updateEntry(id: string, field: "name" | "item", value: string) {
    onUpdate(entries.map(e => (e.id === id ? { ...e, [field]: value } : e)));
  }

  return (
    <div className="mt-1">
      <div className="flex flex-col gap-2">
        {entries.map((entry, index) => {
          const isExpanded = expandedId === entry.id;
          const preview = entry.name.trim() || `Crumb ${index + 1}`;
          return (
            <div key={entry.id} className="rounded-lg border border-zinc-700 bg-zinc-800/50">
              {/* Card header */}
              <div className="flex items-center gap-2 px-3 py-2">
                <button
                  type="button"
                  onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                  className="flex flex-1 items-center gap-2 text-left"
                >
                  <span className="shrink-0 rounded bg-zinc-700 px-1.5 py-0.5 text-xs font-mono text-zinc-400">
                    {index + 1}
                  </span>
                  <span className="flex-1 truncate text-sm text-zinc-300">{preview}</span>
                  <span className={`shrink-0 text-zinc-500 text-xs transition-transform ${isExpanded ? "rotate-180" : ""}`}>▼</span>
                </button>
                <button
                  type="button"
                  onClick={() => removeEntry(entry.id)}
                  disabled={entries.length <= 1}
                  className="shrink-0 rounded p-0.5 text-xs text-zinc-500 transition-colors hover:text-red-400 disabled:opacity-30"
                  title="Remove"
                >
                  ×
                </button>
              </div>

              {/* Expanded fields */}
              {isExpanded && (
                <div className="border-t border-zinc-700 px-3 pb-3 pt-3">
                  <Field
                    label="Label"
                    value={entry.name}
                    onChange={v => updateEntry(entry.id, "name", v)}
                    placeholder="Home"
                    required
                  />
                  <Field
                    label="URL"
                    type="url"
                    value={entry.item}
                    onChange={v => updateEntry(entry.id, "item", v)}
                    placeholder="https://example.com"
                    required
                  />
                  <p className="text-xs text-zinc-500">Position {index + 1} — auto-numbered from order above</p>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={addEntry}
        className="mt-3 w-full rounded-lg border border-dashed border-zinc-600 py-2 text-xs font-medium text-zinc-400 transition-colors hover:border-indigo-500 hover:text-indigo-400"
      >
        + Add Crumb
      </button>
    </div>
  );
}

// ─── Per-Type Form Renderers ─────────────────────────────────────────────────

const availabilityOptions = [
  { value: "https://schema.org/InStock",            label: "In Stock" },
  { value: "https://schema.org/OutOfStock",         label: "Out of Stock" },
  { value: "https://schema.org/PreOrder",           label: "Pre-Order" },
  { value: "https://schema.org/SoldOut",            label: "Sold Out" },
  { value: "https://schema.org/BackOrder",          label: "Back Order" },
  { value: "https://schema.org/OnlineOnly",         label: "Online Only" },
  { value: "https://schema.org/InStoreOnly",        label: "In Store Only" },
  { value: "https://schema.org/LimitedAvailability",label: "Limited Availability" },
];

function renderFormFields(
  state: SchemaFormState,
  setFormState: React.Dispatch<React.SetStateAction<SchemaFormState>>
): React.ReactNode {
  switch (state.type) {
    case "WebSite": {
      const d = state.data;
      const upd = (p: Partial<WebSiteFormState>) =>
        setFormState({ type: "WebSite", data: { ...d, ...p } });
      return (
        <>
          <Field label="Site Name" value={d.name} onChange={v => upd({ name: v })} required placeholder="Acme Inc." />
          <Field label="URL" type="url" value={d.url} onChange={v => upd({ url: v })} required placeholder="https://example.com" />
        </>
      );
    }

    case "Organization": {
      const d = state.data;
      const upd = (p: Partial<OrganizationFormState>) =>
        setFormState({ type: "Organization", data: { ...d, ...p } });
      return (
        <>
          <Field label="Name" value={d.name} onChange={v => upd({ name: v })} required />
          <Field label="URL" type="url" value={d.url} onChange={v => upd({ url: v })} required placeholder="https://example.com" />
          <Field label="Logo URL" type="url" value={d.logo} onChange={v => upd({ logo: v })} placeholder="https://example.com/logo.png" />
          <TextareaField label="Description" value={d.description} onChange={v => upd({ description: v })} rows={2} />
          <Field label="Telephone" value={d.telephone} onChange={v => upd({ telephone: v })} placeholder="+1-800-555-0100" />
          <Field label="Email" type="email" value={d.email} onChange={v => upd({ email: v })} />
        </>
      );
    }

    case "Article":
    case "BlogPosting": {
      const t = state.type;
      const d = state.data;
      const upd = (p: Partial<ArticleFormState>) =>
        setFormState({ type: t, data: { ...d, ...p } });
      return (
        <>
          <Field label="Headline" value={d.headline} onChange={v => upd({ headline: v })} required />
          <Field label="Author Name" value={d.authorName} onChange={v => upd({ authorName: v })} required placeholder="Jane Smith" />
          <Field label="Date Published" type="date" value={d.datePublished} onChange={v => upd({ datePublished: v })} required />
          {t === "Article" && (
            <Field label="Date Modified" type="date" value={d.dateModified} onChange={v => upd({ dateModified: v })} />
          )}
          <Field label="Image URL" type="url" value={d.image} onChange={v => upd({ image: v })} placeholder="https://example.com/image.jpg" />
          <Field label="Publisher Name" value={d.publisherName} onChange={v => upd({ publisherName: v })} placeholder="Acme Inc." />
        </>
      );
    }

    case "Review": {
      const d = state.data;
      const upd = (p: Partial<ReviewFormState>) =>
        setFormState({ type: "Review", data: { ...d, ...p } });
      return (
        <>
          <Field label="Author Name" value={d.authorName} onChange={v => upd({ authorName: v })} required placeholder="Jane Smith" />
          <SectionHeader label="Rating" />
          <Field label="Rating Value" type="number" value={d.ratingValue} onChange={v => upd({ ratingValue: v })} required placeholder="5" />
          <Field label="Best Rating" type="number" value={d.bestRating} onChange={v => upd({ bestRating: v })} placeholder="5" />
          <TextareaField label="Review Body" value={d.reviewBody} onChange={v => upd({ reviewBody: v })} rows={3} />
          <Field label="Date Published" type="date" value={d.datePublished} onChange={v => upd({ datePublished: v })} />
        </>
      );
    }

    case "Event": {
      const d = state.data;
      const upd = (p: Partial<EventFormState>) =>
        setFormState({ type: "Event", data: { ...d, ...p } });
      return (
        <>
          <Field label="Event Name" value={d.name} onChange={v => upd({ name: v })} required />
          <Field label="Start Date" type="date" value={d.startDate} onChange={v => upd({ startDate: v })} required />
          <Field label="End Date" type="date" value={d.endDate} onChange={v => upd({ endDate: v })} />
          <SectionHeader label="Location" />
          <Field label="Venue Name" value={d.locationName} onChange={v => upd({ locationName: v })} placeholder="Madison Square Garden" />
          <Field label="Address" value={d.locationAddress} onChange={v => upd({ locationAddress: v })} placeholder="4 Pennsylvania Plaza, New York, NY 10001" />
        </>
      );
    }

    case "Product": {
      const d = state.data;
      const upd = (p: Partial<ProductFormState>) =>
        setFormState({ type: "Product", data: { ...d, ...p } });
      return (
        <>
          <Field label="Product Name" value={d.name} onChange={v => upd({ name: v })} required />
          <TextareaField label="Description" value={d.description} onChange={v => upd({ description: v })} rows={2} />
          <Field label="Image URL" type="url" value={d.image} onChange={v => upd({ image: v })} placeholder="https://example.com/product.jpg" />
          <Field label="Product URL" type="url" value={d.url} onChange={v => upd({ url: v })} placeholder="https://example.com/products/item" />
          <Field label="SKU" value={d.sku} onChange={v => upd({ sku: v })} placeholder="ABC-123" />
          <Field label="Color" value={d.color} onChange={v => upd({ color: v })} placeholder="Blue" />
          <Field label="Material" value={d.material} onChange={v => upd({ material: v })} placeholder="Cotton" />
          <SectionHeader label="Brand" />
          <Field label="Brand Name" value={d.brandName} onChange={v => upd({ brandName: v })} placeholder="Acme" />
          <SectionHeader label="Pricing & Availability" />
          <Field label="Price" type="number" value={d.price} onChange={v => upd({ price: v })} required placeholder="29.99" />
          <Field label="Currency (ISO 4217)" value={d.priceCurrency} onChange={v => upd({ priceCurrency: v })} placeholder="USD" />
          <SelectField label="Availability" value={d.availability} onChange={v => upd({ availability: v })} options={availabilityOptions} />
        </>
      );
    }

    case "LocalBusiness": {
      const d = state.data;
      const upd = (p: Partial<LocalBusinessFormState>) =>
        setFormState({ type: "LocalBusiness", data: { ...d, ...p } });
      return (
        <>
          <Field label="Business Name" value={d.name} onChange={v => upd({ name: v })} required />
          <Field label="Website URL" type="url" value={d.url} onChange={v => upd({ url: v })} placeholder="https://example.com" />
          <Field label="Telephone" value={d.telephone} onChange={v => upd({ telephone: v })} placeholder="+1-800-555-0100" />
          <Field label="Image URL" type="url" value={d.image} onChange={v => upd({ image: v })} placeholder="https://example.com/photo.jpg" />
          <Field label="Price Range" value={d.priceRange} onChange={v => upd({ priceRange: v })} placeholder="$$" />
          <SectionHeader label="Address" />
          <Field label="Street Address" value={d.streetAddress} onChange={v => upd({ streetAddress: v })} required placeholder="123 Main St" />
          <Field label="City" value={d.addressLocality} onChange={v => upd({ addressLocality: v })} required placeholder="Springfield" />
          <Field label="State / Region" value={d.addressRegion} onChange={v => upd({ addressRegion: v })} placeholder="IL" />
          <Field label="Postal Code" value={d.postalCode} onChange={v => upd({ postalCode: v })} placeholder="62701" />
          <Field label="Country" value={d.addressCountry} onChange={v => upd({ addressCountry: v })} placeholder="US" />
        </>
      );
    }

    case "FAQPage": {
      const d = state.data;
      return (
        <FAQFormSection
          entries={d.entries}
          onUpdate={entries => setFormState({ type: "FAQPage", data: { entries } })}
        />
      );
    }

    case "BreadcrumbList": {
      const d = state.data;
      return (
        <BreadcrumbFormSection
          entries={d.entries}
          onUpdate={entries => setFormState({ type: "BreadcrumbList", data: { entries } })}
        />
      );
    }
  }
}

// ─── Main Component ──────────────────────────────────────────────────────────

interface SchemaFormFieldsProps {
  schemaType: string;
  onChange: (json: Record<string, unknown>) => void;
  initialValue?: Record<string, unknown> | null;
}

export default function SchemaFormFields({ schemaType, onChange, initialValue }: SchemaFormFieldsProps) {
  const [formState, setFormState] = useState<SchemaFormState>(() => getDefaultFormState(schemaType));

  // Hydrate from initialValue when a saved schema is loaded
  useEffect(() => {
    if (!initialValue) return;
    const hydrated = hydrateFormState(schemaType, initialValue);
    if (hydrated) setFormState(hydrated);
  }, [initialValue, schemaType]);

  // Fire onChange whenever form state changes
  const stableOnChange = useCallback(onChange, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    stableOnChange(buildJson(formState));
  }, [formState, stableOnChange]);

  return (
    <div className="mt-4">
      {renderFormFields(formState, setFormState)}
    </div>
  );
}
