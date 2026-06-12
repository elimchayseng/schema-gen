/**
 * User-approved finale: publish the verified staging theme (atomic swap, the
 * displaced theme remains as instant rollback) and delete the two stale
 * staging duplicates from earlier attempts.
 */
import { themePublish, themeDelete, themesList } from "../src/lib/shopify/themes";

const PUBLISH = 185610797101; // verified by run 3b5b9b74 (3/3 L4 + dup gate + freshness)
const DELETE = [185610043437, 185610371117]; // superseded attempts 1 and 2

async function main() {
  const before = await themesList();
  console.log("before:", before.map((t) => `${t.id}:${t.role}:${t.name}`).join("\n        "));
  const main_ = before.find((t) => t.role === "main");

  await themePublish(PUBLISH);
  console.log(`published ${PUBLISH} (displaced ${main_?.id} — your instant rollback)`);

  for (const id of DELETE) {
    try {
      await themeDelete(id);
      console.log(`deleted stale staging theme ${id}`);
    } catch (e) {
      console.log(`could not delete ${id}: ${e instanceof Error ? e.message : e}`);
    }
  }
  const after = await themesList();
  console.log("after: ", after.map((t) => `${t.id}:${t.role}:${t.name}`).join("\n        "));
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
