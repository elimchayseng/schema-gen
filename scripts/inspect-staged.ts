/** Count + classify JSON-LD blocks on the staged dev-store product page. */
import { extractJsonLd } from "../src/lib/url-validator/extractor";
import { getStorefrontCookie } from "../src/lib/shopify/storefront-password";
import { fetchPage } from "../src/lib/url-validator/fetcher";
import { validateSchema } from "../src/lib/validation/engine";

const URL_ = "https://ethan-dev-store-1.myshopify.com/products/selling-plans-ski-wax?preview_theme_id=185610043437";

async function main() {
  const cookie = await getStorefrontCookie("ethan-dev-store-1.myshopify.com");
  const r = await fetchPage(URL_, cookie ? { headers: { Cookie: cookie } } : {});
  if (!r.html) throw new Error(r.error ?? "no html");
  const blocks = extractJsonLd(r.html);
  console.log("blocks:", blocks.length);
  for (const b of blocks) {
    if (b.parseError || b.parsed == null) {
      console.log("- UNPARSEABLE:", b.parseError, b.raw.slice(0, 120));
      continue;
    }
    const v = validateSchema(b.parsed as Record<string, unknown>);
    const types = JSON.stringify(
      Array.isArray(b.parsed)
        ? (b.parsed as { "@type"?: unknown }[]).map((x) => x["@type"])
        : (b.parsed as { "@type"?: unknown })["@type"] ??
          ((b.parsed as { "@graph"?: { "@type"?: unknown }[] })["@graph"] ?? []).map((x) => x["@type"])
    );
    console.log(`- types=${types} valid=${v.valid} errors=${v.summary.errorCount} rawLen=${b.raw.length}`);
  }
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
