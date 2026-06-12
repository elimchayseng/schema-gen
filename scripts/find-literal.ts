import { assetsList, assetGet } from "../src/lib/shopify/assets";
const THEME = 185610371117;
const NEEDLES = ["Premium ski wax designed", "A premier online retailer"];
async function main() {
  const assets = await assetsList(THEME);
  const candidates = assets.filter((a) => a.key.endsWith(".liquid") || a.key.endsWith(".json"));
  for (const a of candidates) {
    const v = (await assetGet(THEME, a.key)).value ?? "";
    for (const n of NEEDLES) {
      if (v.includes(n)) console.log(`${a.key} contains ${JSON.stringify(n)}`);
    }
    if (v.includes("schemagen") || v.includes("SCHEMAGEN")) {
      const m = v.match(/.{0,60}(schemagen|SCHEMAGEN)[^\n]{0,60}/g)?.slice(0, 3);
      console.log(`${a.key} mentions schemagen:`, JSON.stringify(m));
    }
  }
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
