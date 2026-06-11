/** Reproduce buildSuppressionPlan inputs: what did perceive see, how does the locator classify? */
import { extractJsonLd } from "../src/lib/url-validator/extractor";
import { getStorefrontCookie } from "../src/lib/shopify/storefront-password";
import { fetchPage } from "../src/lib/url-validator/fetcher";
import { locateSchemaSources, makeSourceLocatorOps } from "../src/lib/shopify/source-locator";
import { processPage } from "../src/lib/crawl/process-page";

const SHOP = "ethan-dev-store-1.myshopify.com";
const PAGE = `https://${SHOP}/products/selling-plans-ski-wax`; // live, published theme
const STAGING_THEME = 185610043437;

async function main() {
  const cookie = await getStorefrontCookie(SHOP);
  const headers = cookie ? { Cookie: cookie } : undefined;

  // 1. What does perceive's processPage("scan") carry in renderedBlocks?
  const scan = await processPage(PAGE, "scan", undefined, { fetchHeaders: headers });
  console.log("scan.status:", scan.status, "renderedBlocks:", scan.renderedBlocks?.length ?? null);

  // 2. Raw extraction for comparison.
  const r = await fetchPage(PAGE, headers ? { headers } : {});
  const blocks = extractJsonLd(r.html!);
  console.log("direct extract blocks:", blocks.length);

  // 3. Locator classification against the staging theme.
  const located = await locateSchemaSources({
    themeId: STAGING_THEME,
    renderedBlocks: (scan.renderedBlocks ?? blocks) as never,
    ops: makeSourceLocatorOps(),
  });
  located.forEach((res, i) => {
    const b = (scan.renderedBlocks ?? blocks)[i];
    const t = b.parseError ? "UNPARSEABLE" : JSON.stringify((b.parsed as { "@type"?: unknown })?.["@type"]);
    console.log(`block[${i}] type=${t} -> ${JSON.stringify(res)}`);
  });
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
