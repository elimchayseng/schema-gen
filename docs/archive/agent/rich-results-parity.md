# Google Rich Results parity audit (issue #21)

Audit of `src/lib/validation` against Google's documented structured-data
requirements, per type we emit. Performed 2026-06-09 against the live docs at
`developers.google.com/search/docs/appearance/structured-data/*`.

Where the rules live:

- **Structural shape** (`required`/`recommended` per property): `src/lib/validation/schema-definitions.ts`, enforced by `src/lib/validation/engine.ts`.
- **Conditional Google rules** a flat property table cannot express ("one of the following is required"): `src/lib/validation/rich-results-requirements.ts`, run by `validateSchema` on every root schema. Violations use code `RICH_RESULTS_REQUIREMENT`, mapped to **critical** impact in `getSeverityContext`, so the agent's deterministic L2 gate (`src/lib/agent/gates.ts → hasCriticalIssue`) blocks on them with no LLM involvement.
- **Feature eligibility** (does this type produce a rich result at all): `src/lib/validation/rich-results.ts`.

Severity convention: an `error` makes the schema invalid (L1) and is targeted
by the agent's repair loop; a `warning` with critical impact keeps the schema
structurally valid but blocks rich-results eligibility (L2).

## Per-type mapping

### Product (product snippets) — the pilot-critical type

| Property | Google | Our rule | Notes |
|---|---|---|---|
| `name` | required | required (error) | aligned |
| one of `offers` / `review` / `aggregateRating` | required | **error** via `RICH_RESULTS_REQUIREMENT` | **Fixed in this audit.** Previously `offers` alone was hard-required, which (a) falsely failed the live garnerandtow `@graph` Product that carries `aggregateRating` + `review` but no `offers`, and (b) was redundant with Google's actual one-of rule. `offers` is now `recommended` structurally; the one-of rule is the error. Empty values (`[]`, `""`, `null`) count as absent. |
| `description`, `image`, `sku`, `brand`, `url` | recommended | recommended (warning) | aligned |
| `gtin*` format | n/a (Google validates digits) | pattern-checked | aligned |

### Offer (nested in Product)

| Property | Google (product snippets) | Our rule | Notes |
|---|---|---|---|
| `price` | required | required (error) | aligned |
| `priceCurrency` | recommended (snippets) / **required (merchant listings)** | required (error) | **Intentional deviation (stricter).** We target merchant-listing-grade output for e-commerce pilots; a price without a currency is ambiguous and Merchant listings reject it. |
| `availability`, `priceValidUntil`, `url` | recommended | recommended / optional | aligned enough; `priceValidUntil` optional here (warning-free) — mild under-flag, harmless |

Known gap (accepted, not fixed here): Google accepts `offers` as an **array**
of Offers; our engine expects a single object and flags arrays
(`INVALID_PROPERTY_TYPE`). The deterministic fixer unwraps single-element
arrays, which covers the common Shopify shape. Multi-offer arrays should move
to `AggregateOffer` support — tracked as future work.

### AggregateRating (nested)

| Property | Google | Our rule | Notes |
|---|---|---|---|
| `ratingValue` | required | required (error) | aligned |
| one of `ratingCount` / `reviewCount` | required | **warning** via `RICH_RESULTS_REQUIREMENT` (checked when nested in a root Product) | **Added in this audit.** Warning (not error) because the markup is structurally valid; mapped to critical impact so eligibility still blocks. |
| `bestRating`/`worstRating` | recommended (default 5/1) | optional | aligned |

### Review (nested)

| Property | Google | Our rule | Notes |
|---|---|---|---|
| `author` | required | required (error) | aligned |
| `reviewRating` → `ratingValue` | required | required (error, via Rating definition) | aligned |
| `datePublished`, `reviewBody` | recommended/optional | optional | aligned |
| `itemReviewed` (unnested reviews) | required when not nested | not checked | we only emit reviews nested in Product — acceptable |

### BreadcrumbList / ListItem

| Property | Google | Our rule | Notes |
|---|---|---|---|
| `itemListElement` | required, **at least two ListItems** | required (error); ≥2 items enforced as a `RICH_RESULTS_REQUIREMENT` warning | **min-2 added in this audit** |
| `ListItem.position` | required | required (error) | aligned |
| `ListItem.name` | required (unless `item` is a Thing with name) | required (error) | aligned for the URL-string form we emit |
| `ListItem.item` | required **except on the last item** (Google falls back to the page URL) | required on every item (error) | **Intentional deviation (stricter).** The engine validates array items without positional context; always emitting `item` is valid and unambiguous, and our generator always fills it. A trailing no-`item` breadcrumb from a third-party theme would be a false positive — accepted risk, revisit if seen live. |

### Organization (knowledge panel / org markup)

Google: **no required properties** ("add the properties that apply").
Ours: `name` + `url` required (error); `logo`, `description`, `sameAs` recommended.
**Intentional deviation (stricter):** an Organization without a name and URL is
useless for the knowledge panel; this is our quality bar, documented here.

### LocalBusiness

| Property | Google | Our rule | Notes |
|---|---|---|---|
| `name` | required | required (inherited from Organization) | aligned |
| `address` | required | required (error) | aligned |
| `url` | recommended | required (inherited) | **Intentional deviation (stricter)** — same rationale as Organization |
| `telephone`, `openingHoursSpecification`, `geo`, `priceRange`, `image` | recommended | recommended/optional | aligned |

### Article / BlogPosting

Google: **no required properties** (headline, image, datePublished,
dateModified, author.name all recommended).
Ours: `headline`, `author`, `datePublished` required (error).
**Intentional deviation (stricter):** these are exactly the fields Google uses
to render the result; emitting an Article without them is pointless. Kept.

### WebSite — eligibility DEPRECATED

Google retired the sitelinks search box on 2024-11-21 and removed its
documentation. `rich-results.ts` now reports `eligible: false` for WebSite.
The structural definition is kept — WebSite markup still helps Google
understand the site name — but it must not be sold or judged as a rich result.

### FAQPage — eligibility DEPRECATED

2023-08: restricted to authoritative government/health sites. 2026-05: removed
from Search entirely (Rich Results Test support dropped June 2026).
`rich-results.ts` now reports `eligible: false`. Structural validation of
FAQPage/Question/Answer is kept for correctness of any markup we still touch.

### HowTo — eligibility DEPRECATED

Google deprecated how-to rich results on 2023-09-13 (desktop removal; mobile
earlier). `rich-results.ts` now reports `eligible: false`. The garnerandtow
`@graph` HowTo remains structurally validated, but the agent must not require
HowTo for a rich-results goal.

### ItemList / CollectionPage / AboutPage / ContactPage

Unchanged: ItemList remains marked eligible (carousel — still documented by
Google); CollectionPage/AboutPage/ContactPage remain `eligible: false`
(recognized, no specific rich result).

## Summary of changes made in this audit

1. `Product.offers`: `required` → `recommended`; new one-of
   `offers|review|aggregateRating` **error** (`rich-results-requirements.ts`).
   Test `engine.test.ts #8` encoded the old wrong rule and was updated; `#8b/#8c`
   added for the one-of semantics.
2. AggregateRating `ratingCount|reviewCount` one-of **warning** (nested in Product).
3. BreadcrumbList minimum two ListItems **warning**.
4. Eligibility map: `WebSite`, `FAQPage`, `HowTo` → `eligible: false` with
   deprecation notes.
5. New error code `RICH_RESULTS_REQUIREMENT`, mapped to critical impact so the
   existing L2 gate and UI severity labels pick it up unchanged.

## Sources

- https://developers.google.com/search/docs/appearance/structured-data/product-snippet
- https://developers.google.com/search/docs/appearance/structured-data/breadcrumb
- https://developers.google.com/search/docs/appearance/structured-data/organization
- https://developers.google.com/search/docs/appearance/structured-data/local-business
- https://developers.google.com/search/docs/appearance/structured-data/article
- https://developers.google.com/search/docs/appearance/structured-data/review-snippet
- https://developers.google.com/search/blog/2023/08/howto-faq-changes
- https://developers.google.com/search/blog/2024/10/sitelinks-search-box
