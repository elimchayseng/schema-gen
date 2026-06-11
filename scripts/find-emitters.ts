/** Find which staged-theme assets emit JSON-LD and HOW (script tag vs structured_data filter). */
import { assetsList, assetGet } from "../src/lib/shopify/assets";

const THEME = 185610043437;
async function main() {
  const assets = await assetsList(THEME);
  const liquid = assets.filter((a) => a.key.endsWith(".liquid"));
  for (const a of liquid) {
    const full = await assetGet(THEME, a.key);
    const v = full.value ?? "";
    const hasLd = v.includes("application/ld+json");
    const hasFilter = /\|\s*structured_data/.test(v);
    if (hasLd || hasFilter) {
      console.log(`${a.key}  ld+json=${hasLd} structured_data_filter=${hasFilter}`);
      if (hasFilter) {
        const m = v.match(/.{0,80}\|\s*structured_data.{0,40}/g);
        for (const s of m ?? []) console.log("   ", JSON.stringify(s));
      }
    }
  }
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
