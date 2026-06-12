import { describe, it, expect } from "vitest";
import {
  SUPPRESS_PREFIX,
  SUPPRESS_SUFFIX,
  findJsonLdScriptRanges,
  findUnsuppressibleReason,
  listSuppressions,
  suppressJsonLdEmission,
  unsuppressAll,
} from "../suppress";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Realistic Dawn-style product-schema snippet: Liquid loops INSIDE the script. */
const DAWN_SNIPPET = `{%- liquid
  assign current_variant = product.selected_or_first_available_variant
-%}
<div class="product__title">{{ product.title }}</div>
<script type="application/ld+json">
  {
    "@context": "http://schema.org/",
    "@type": "Product",
    "name": {{ product.title | json }},
    "sku": {{ current_variant.sku | json }},
    "offers": [
      {%- for variant in product.variants -%}
      {
        "@type": "Offer",
        "price": {{ variant.price | divided_by: 100.00 | json }}
      }{% unless forloop.last %},{% endunless %}
      {%- endfor -%}
    ]
  }
</script>
<script type="text/javascript">console.log("not ld+json");</script>
`;

const TWO_BLOCKS = `<header></header>
<script type="application/ld+json">{ "@type": "Product", "name": "A" }</script>
<main></main>
<script type="application/ld+json">{ "@type": "BreadcrumbList" }</script>
<footer></footer>
`;

function wrapOf(element: string): string {
  return SUPPRESS_PREFIX + element + SUPPRESS_SUFFIX;
}

// ---------------------------------------------------------------------------
// findJsonLdScriptRanges
// ---------------------------------------------------------------------------

describe("findJsonLdScriptRanges", () => {
  it("returns the WHOLE element — opening tag through closing </script>", () => {
    const ranges = findJsonLdScriptRanges(DAWN_SNIPPET);
    expect(ranges).toHaveLength(1);
    const r = ranges[0];
    expect(r.text.startsWith('<script type="application/ld+json">')).toBe(true);
    expect(r.text.endsWith("</script>")).toBe(true);
    expect(DAWN_SNIPPET.slice(r.start, r.end)).toBe(r.text);
    // The Liquid inside the element is part of the range.
    expect(r.text).toContain("{%- for variant in product.variants -%}");
  });

  it("ignores non-ld+json scripts", () => {
    const ranges = findJsonLdScriptRanges(DAWN_SNIPPET);
    expect(ranges.some((r) => r.text.includes("console.log"))).toBe(false);
  });

  it("finds multiple elements in document order", () => {
    const ranges = findJsonLdScriptRanges(TWO_BLOCKS);
    expect(ranges).toHaveLength(2);
    expect(ranges[0].text).toContain('"Product"');
    expect(ranges[1].text).toContain('"BreadcrumbList"');
    expect(ranges[0].end).toBeLessThanOrEqual(ranges[1].start);
  });

  it("matches single-quoted type attributes, extra attributes, and `</script >`", () => {
    const text =
      "<script data-x=\"1\" type='application/ld+json' async>{}</script >";
    const ranges = findJsonLdScriptRanges(text);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].text).toBe(text);
  });

  it("yields no range for an unterminated element (documented safe-terminator assumption)", () => {
    const ranges = findJsonLdScriptRanges(
      '<script type="application/ld+json">{ "@type": "Product"'
    );
    expect(ranges).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// suppressJsonLdEmission
// ---------------------------------------------------------------------------

describe("suppressJsonLdEmission", () => {
  it("wraps the whole emitting element in the reversible marker sandwich", () => {
    const res = suppressJsonLdEmission(DAWN_SNIPPET, { match: { contains: '"Product"' } });
    if (!res.ok) throw new Error(res.reason);
    expect(res.changed).toBe(true);
    expect(res.suppressed).toBe(1);
    const [element] = findJsonLdScriptRanges(DAWN_SNIPPET);
    expect(res.text).toContain(wrapOf(element.text));
    // Everything outside the wrapper is byte-identical.
    expect(res.text.replace(wrapOf(element.text), element.text)).toBe(DAWN_SNIPPET);
  });

  it("round-trips: unsuppressAll(suppress(x)) === x", () => {
    const res = suppressJsonLdEmission(DAWN_SNIPPET, { match: {} });
    if (!res.ok) throw new Error(res.reason);
    expect(unsuppressAll(res.text)).toBe(DAWN_SNIPPET);
  });

  it("is idempotent: suppressing an already-suppressed region is a no-op", () => {
    const once = suppressJsonLdEmission(DAWN_SNIPPET, { match: {} });
    if (!once.ok) throw new Error(once.reason);
    const twice = suppressJsonLdEmission(once.text, { match: {} });
    if (!twice.ok) throw new Error(twice.reason);
    expect(twice.changed).toBe(false);
    expect(twice.suppressed).toBe(0);
    expect(twice.text).toBe(once.text);
  });

  it("`contains` selects only the matching element, leaving others untouched", () => {
    const res = suppressJsonLdEmission(TWO_BLOCKS, {
      match: { contains: '"BreadcrumbList"' },
    });
    if (!res.ok) throw new Error(res.reason);
    expect(res.suppressed).toBe(1);
    const productElement =
      '<script type="application/ld+json">{ "@type": "Product", "name": "A" }</script>';
    // The Product element is NOT wrapped.
    expect(res.text).toContain(productElement);
    expect(res.text).not.toContain(wrapOf(productElement));
    expect(unsuppressAll(res.text)).toBe(TWO_BLOCKS);
  });

  it("`index` selects the Nth element", () => {
    const res = suppressJsonLdEmission(TWO_BLOCKS, { match: { index: 0 } });
    if (!res.ok) throw new Error(res.reason);
    expect(res.suppressed).toBe(1);
    expect(res.text).toContain(
      wrapOf(
        '<script type="application/ld+json">{ "@type": "Product", "name": "A" }</script>'
      )
    );
  });

  it("an empty match suppresses every JSON-LD element", () => {
    const res = suppressJsonLdEmission(TWO_BLOCKS, { match: {} });
    if (!res.ok) throw new Error(res.reason);
    expect(res.suppressed).toBe(2);
    expect(unsuppressAll(res.text)).toBe(TWO_BLOCKS);
  });

  it("fails when `index` is out of bounds", () => {
    const res = suppressJsonLdEmission(TWO_BLOCKS, { match: { index: 5 } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("index 5");
  });

  it("fails when `contains` matches nothing", () => {
    const res = suppressJsonLdEmission(TWO_BLOCKS, {
      match: { contains: "no-such-text" },
    });
    expect(res.ok).toBe(false);
  });

  it("fails when the asset has no JSON-LD element at all", () => {
    const res = suppressJsonLdEmission("<div>{{ product.title }}</div>", {
      match: {},
    });
    expect(res.ok).toBe(false);
  });

  // ---- Liquid-safety: not-suppressible regions -----------------------------

  it("refuses a region containing {% raw %}", () => {
    const text = `<script type="application/ld+json">
{% raw %}{ "@type": "Product" }{% endraw %}
</script>`;
    const res = suppressJsonLdEmission(text, { match: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("raw");
  });

  it("refuses a region containing {% comment %}", () => {
    const text = `<script type="application/ld+json">
{% comment %}legacy{% endcomment %}{ "@type": "Product" }
</script>`;
    const res = suppressJsonLdEmission(text, { match: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("comment");
  });

  it("refuses whitespace-control tag variants ({%- raw -%}) too", () => {
    const text = `<script type="application/ld+json">
{%- raw -%}x{%- endraw -%}
</script>`;
    const res = suppressJsonLdEmission(text, { match: {} });
    expect(res.ok).toBe(false);
  });

  it("refuses a region with an unbalanced closing tag ({% endif %} whose if is outside)", () => {
    const text = `{% if product.available %}
<script type="application/ld+json">
{ "@type": "Product" }
{% endif %}{% if true %}
</script>`;
    const res = suppressJsonLdEmission(text, { match: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("endif");
  });

  it("refuses a region with an unclosed block tag", () => {
    const text = `<script type="application/ld+json">
{% if product.available %}{ "@type": "Product" }
</script>
{% endif %}`;
    const res = suppressJsonLdEmission(text, { match: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("unclosed");
  });

  it("allows BALANCED block tags inside the region (for/endfor, if/endif, unless/endunless)", () => {
    // DAWN_SNIPPET's element contains for/endfor + unless/endunless — must pass.
    const res = suppressJsonLdEmission(DAWN_SNIPPET, { match: {} });
    expect(res.ok).toBe(true);
  });

  it("refuses a region already containing stray SCHEMAGEN:SUPPRESS marker text", () => {
    const text = `<script type="application/ld+json">
{ "@type": "Product", "note": "SCHEMAGEN:SUPPRESS:END" }
</script>`;
    const res = suppressJsonLdEmission(text, { match: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("SCHEMAGEN:SUPPRESS");
  });

  it("is all-or-nothing: one bad region among the matches fails the whole call", () => {
    const text = `<script type="application/ld+json">{ "@type": "Product" }</script>
<script type="application/ld+json">{% raw %}{}{% endraw %}</script>`;
    const res = suppressJsonLdEmission(text, { match: {} });
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// unsuppressAll
// ---------------------------------------------------------------------------

describe("unsuppressAll", () => {
  it("is a no-op when nothing is suppressed", () => {
    expect(unsuppressAll(DAWN_SNIPPET)).toBe(DAWN_SNIPPET);
  });

  it("removes multiple wrappers, restoring original bytes exactly", () => {
    const res = suppressJsonLdEmission(TWO_BLOCKS, { match: {} });
    if (!res.ok) throw new Error(res.reason);
    expect(res.suppressed).toBe(2);
    expect(unsuppressAll(res.text)).toBe(TWO_BLOCKS);
  });

  it("round-trip property holds across varied content (incl. $-sequences)", () => {
    const variants = [
      DAWN_SNIPPET,
      TWO_BLOCKS,
      // `$&` / `$'` must survive: unsuppressAll uses a replacement function.
      `<script type="application/ld+json">{ "regex": "$& $' $1 $$" }</script>`,
      `\r\n<script type="application/ld+json">\r\n{ "@type": "Product" }\r\n</script>\r\n`,
      `<p>before</p><script type='application/ld+json'>{ "a": "b" }</script><p>after</p>`,
    ];
    for (const original of variants) {
      const res = suppressJsonLdEmission(original, { match: {} });
      if (!res.ok) throw new Error(res.reason);
      expect(unsuppressAll(res.text)).toBe(original);
    }
  });
});

// ---------------------------------------------------------------------------
// listSuppressions
// ---------------------------------------------------------------------------

describe("listSuppressions", () => {
  it("returns an empty list for an unsuppressed asset", () => {
    expect(listSuppressions(DAWN_SNIPPET)).toEqual([]);
  });

  it("reports range + inner bounds + preview for each suppression", () => {
    const res = suppressJsonLdEmission(TWO_BLOCKS, { match: {} });
    if (!res.ok) throw new Error(res.reason);
    const listings = listSuppressions(res.text);
    expect(listings).toHaveLength(2);
    for (const l of listings) {
      // Outer range covers the whole wrapper; inner range is the original element.
      expect(res.text.slice(l.start, l.end).startsWith(SUPPRESS_PREFIX)).toBe(true);
      expect(res.text.slice(l.start, l.end).endsWith(SUPPRESS_SUFFIX)).toBe(true);
      expect(res.text.slice(l.inner.start, l.inner.end)).toMatch(
        /^<script[\s\S]*<\/script>$/
      );
    }
    expect(listings[0].preview).toContain('"Product"');
    expect(listings[1].preview).toContain('"BreadcrumbList"');
    expect(listings[0].end).toBeLessThanOrEqual(listings[1].start);
  });

  it("truncates long previews", () => {
    const long = `<script type="application/ld+json">{ "description": "${"x".repeat(
      500
    )}" }</script>`;
    const res = suppressJsonLdEmission(long, { match: {} });
    if (!res.ok) throw new Error(res.reason);
    const [l] = listSuppressions(res.text);
    expect(l.preview.length).toBeLessThanOrEqual(121); // 120 + ellipsis
    expect(l.preview.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findUnsuppressibleReason (direct unit coverage)
// ---------------------------------------------------------------------------

describe("findUnsuppressibleReason", () => {
  it("accepts plain JSON and output tags", () => {
    expect(
      findUnsuppressibleReason('{ "name": {{ product.title | json }} }')
    ).toBeNull();
  });

  it("accepts an inline {% liquid %} tag (its body is not separate tag openers)", () => {
    expect(
      findUnsuppressibleReason("{% liquid\n  assign a = 1\n  echo a\n%}")
    ).toBeNull();
  });

  it("refuses section-owned tags ({% schema %}, {% javascript %}, {% stylesheet %})", () => {
    expect(findUnsuppressibleReason("{% schema %}{}{% endschema %}")).toContain(
      "schema"
    );
    expect(findUnsuppressibleReason("{% javascript %}x{% endjavascript %}")).toContain(
      "javascript"
    );
    expect(findUnsuppressibleReason("{% stylesheet %}x{% endstylesheet %}")).toContain(
      "stylesheet"
    );
  });

  it("refuses mismatched block pairs ({% if %}…{% endfor %})", () => {
    expect(findUnsuppressibleReason("{% if a %}{% endfor %}")).toContain("endfor");
  });
});
