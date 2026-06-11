/** The final proof: the PUBLISHED storefront (no preview param) carries the schema. */
import { extractJsonLd } from "../src/lib/url-validator/extractor";
import { getStorefrontCookie } from "../src/lib/shopify/storefront-password";
import { fetchPage } from "../src/lib/url-validator/fetcher";
import { validateSchema } from "../src/lib/validation/engine";

const PAGES = [
  "https://ethan-dev-store-1.myshopify.com/products/selling-plans-ski-wax",
  "https://ethan-dev-store-1.myshopify.com/products/the-3p-fulfilled-snowboard",
  "https://ethan-dev-store-1.myshopify.com/products/the-collection-snowboard-hydrogen",
];

async function main() {
  const cookie = await getStorefrontCookie("ethan-dev-store-1.myshopify.com");
  let allOk = true;
  for (const url of PAGES) {
    const busted = `${url}?schemagen_cachebust=${process.pid}`;
    const r = await fetchPage(busted, cookie ? { headers: { Cookie: cookie } } : {});
    const blocks = extractJsonLd(r.html!);
    const valid = blocks.filter((b) => !b.parseError && b.parsed != null && validateSchema(b.parsed as Record<string, unknown>).valid);
    const typeOf = (p: unknown) => (p as { "@type"?: string })["@type"];
    const products = valid.filter((b) => typeOf(b.parsed) === "Product").length;
    const crumbs = valid.filter((b) => typeOf(b.parsed) === "BreadcrumbList").length;
    const unparseable = blocks.filter((b) => b.parseError).length;
    const ok = products === 1 && crumbs === 1 && unparseable === 0;
    allOk = allOk && ok;
    console.log(`${ok ? "PASS" : "FAIL"} ${url.split("/products/")[1]}: ${products} Product, ${crumbs} BreadcrumbList, ${unparseable} unparseable (of ${blocks.length} blocks)`);
  }
  console.log(allOk ? "\nLIVE PUBLISHED STOREFRONT: exactly-one verified on all 3 pages" : "\nFAIL");
  process.exit(allOk ? 0 : 1);
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
