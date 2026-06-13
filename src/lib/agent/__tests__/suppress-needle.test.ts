/**
 * Issue #34: the suppression `contains` needle must identify EXACTLY ONE JSON-LD
 * script element in the asset. A literal shared across sibling blocks would make
 * suppressJsonLdEmission wrap them all — silently silencing legitimate structured
 * data. pickContainsLiteral must refuse a shared literal and prefer a unique one.
 */
import { describe, it, expect } from "vitest";
import { pickContainsLiteral } from "../run";

// Two JSON-LD script elements in one theme asset. Both carry the canonical store
// URL (a shared literal); only the Product block carries "Sling Bag".
const ASSET_TWO_BLOCKS = `
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product","name":"Sling Bag","url":"https://garnerandtow.com"}
</script>
<div>markup</div>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Organization","url":"https://garnerandtow.com"}
</script>
`;

const PRODUCT_RAW =
  '{"@context":"https://schema.org","@type":"Product","name":"Sling Bag","url":"https://garnerandtow.com"}';

describe("pickContainsLiteral — needle uniqueness (#34)", () => {
  it("prefers a literal unique to one block over a longer shared one", () => {
    const needle = pickContainsLiteral(PRODUCT_RAW, ASSET_TWO_BLOCKS);
    // The longest literal is the shared canonical URL — but it appears in BOTH
    // script elements, so it must be rejected in favor of the unique "Sling Bag".
    expect(needle).toBe('"Sling Bag"');
  });

  it("returns undefined when every candidate literal is shared across blocks", () => {
    // Two byte-identical Product blocks — every literal appears in both, so none
    // can uniquely target one without collaterally wrapping the other.
    const dupBlock =
      '{"@type":"Product","url":"https://garnerandtow.com"}';
    const assetBothIdentical = `
<script type="application/ld+json">${dupBlock}</script>
<script type="application/ld+json">${dupBlock}</script>`;
    expect(pickContainsLiteral(dupBlock, assetBothIdentical)).toBeUndefined();
  });

  it("uses the longest in-asset literal when the asset has a single block", () => {
    const oneBlock = `<script type="application/ld+json">${PRODUCT_RAW}</script>`;
    const needle = pickContainsLiteral(PRODUCT_RAW, oneBlock);
    // Single block → uniqueness is trivially satisfied → longest literal wins.
    expect(needle).toBe('"https://garnerandtow.com"');
  });

  it("falls back to the longest literal when no asset text is available", () => {
    expect(pickContainsLiteral(PRODUCT_RAW, null)).toBe(
      '"https://garnerandtow.com"'
    );
  });

  it("falls back to the longest in-asset literal for a render-time emission (no static <script>)", () => {
    // The asset emits JSON-LD via Liquid output, so there's no static script
    // element to range-check — the longest literal present in the asset is used.
    const renderTimeAsset =
      'window.x = {{ product | json }}; const u = "https://garnerandtow.com";';
    expect(pickContainsLiteral(PRODUCT_RAW, renderTimeAsset)).toBe(
      '"https://garnerandtow.com"'
    );
  });

  it("returns undefined when the block has no usable quoted literal", () => {
    expect(pickContainsLiteral("{}", ASSET_TWO_BLOCKS)).toBeUndefined();
  });
});
