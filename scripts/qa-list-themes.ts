import { themesList } from "../src/lib/shopify/themes";
import { resolveShopCredentials } from "../src/lib/shopify/credentials";
async function main() {
  const creds = await resolveShopCredentials("ethan-dev-store-1.myshopify.com").catch(() => undefined);
  const themes = await themesList(creds ? { shop: "ethan-dev-store-1.myshopify.com", credentials: { appKey: creds.appKey, appSecret: creds.appSecret } } : undefined);
  for (const t of themes) console.log(`${t.role.padEnd(12)} ${t.id}  ${t.name}`);
}
main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
