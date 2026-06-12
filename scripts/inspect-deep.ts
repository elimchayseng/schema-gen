import { extractJsonLd } from "../src/lib/url-validator/extractor";
import { getStorefrontCookie } from "../src/lib/shopify/storefront-password";
import { fetchPage } from "../src/lib/url-validator/fetcher";
import { assetGet } from "../src/lib/shopify/assets";

const THEME = 185610371117;
const URL_ = `https://ethan-dev-store-1.myshopify.com/products/the-collection-snowboard-hydrogen`;

async function main() {
  const cookie = await getStorefrontCookie("ethan-dev-store-1.myshopify.com");
  const r = await fetchPage(URL_, cookie ? { headers: { Cookie: cookie } } : {});
  const blocks = extractJsonLd(r.html!);
  blocks.forEach((b, i) => {
    const t = (b.parsed as { "@type"?: unknown })?.["@type"];
    console.log(`--- block[${i}] type=${JSON.stringify(t)} len=${b.raw.length}`);
    console.log(b.raw.replace(/\s+/g, " ").slice(0, 220));
  });
  for (const key of ["sections/product-information.liquid", "sections/featured-product.liquid"]) {
    const a = await assetGet(THEME, key);
    const v = a.value ?? "";
    console.log(`\n=== ${key}: SUPPRESS markers=${(v.match(/SCHEMAGEN:SUPPRESS/g) ?? []).length}, structured_data occurrences=${(v.match(/structured_data/g) ?? []).length}`);
    const idx = v.indexOf("structured_data");
    if (idx >= 0) console.log(v.slice(Math.max(0, idx - 200), idx + 120).replace(/\n/g, "\\n"));
  }
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
