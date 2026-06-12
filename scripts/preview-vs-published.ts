/** Discriminating experiment: same theme (185610797101, now published) rendered
 *  via preview URL vs published URL — identical blocks ⇒ stale cache; different
 *  ⇒ preview≠published rendering (platform injection / template sections). */
import { extractJsonLd } from "../src/lib/url-validator/extractor";
import { getStorefrontCookie } from "../src/lib/shopify/storefront-password";
import { fetchPage } from "../src/lib/url-validator/fetcher";

const PAGE = "https://ethan-dev-store-1.myshopify.com/products/the-collection-snowboard-hydrogen";
const THEME = 185610797101;

function summarize(html: string) {
  return extractJsonLd(html).map((b) => {
    const p = b.parsed as { "@type"?: string; "@id"?: string } | null;
    return `${p?.["@type"] ?? "PARSE_ERR"}${p?.["@id"] ? `(@id=${p["@id"]})` : ""}:len${b.raw.length}`;
  });
}

async function main() {
  const cookie = await getStorefrontCookie("ethan-dev-store-1.myshopify.com");
  const h = cookie ? { headers: { Cookie: cookie } } : {};
  const preview = await fetchPage(`${PAGE}?preview_theme_id=${THEME}`, h);
  const published = await fetchPage(PAGE, h);
  const a = summarize(preview.html!);
  const b = summarize(published.html!);
  console.log("PREVIEW  :", a.join(" | "));
  console.log("PUBLISHED:", b.join(" | "));
  console.log(JSON.stringify(a) === JSON.stringify(b) ? "IDENTICAL → cache was the issue" : "DIFFERENT → preview≠published rendering gap");
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
