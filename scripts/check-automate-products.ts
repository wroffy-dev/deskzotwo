/**
 * check:automate-products — product category, brand and family in Deskzo Automate's rules
 * (src/lib/automate/products.ts; owner, 1 Nov 2026).
 *
 * The rules by hand-worked cases: which data fields pick from which list, which are lists ("contains"),
 * the data picker's labels, and a "contains" rule on brands. Then a fixture of its own in the local
 * database: a lead wanting two products carries their categories, brands and families, without repeats.
 * Everything is named ZZPROBE_AP and removed in a finally.
 *
 *   npm run check:automate-products
 */
import "dotenv/config";
import { directClient } from "../src/lib/tenancy/direct-client";
import { isProductList, productChoiceKind, productOf, productsOf } from "../src/lib/automate/products";
import { triggerPaths } from "../src/lib/automate/triggers";
import { compare } from "../src/lib/automate/conditions";
import { leadFacts } from "../src/lib/automate/emit-leads";

const db = directClient();
const TAG = "ZZPROBE_AP";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};

async function cleanup() {
  const items = (await db.item.findMany({ where: { sku: { startsWith: TAG } }, select: { id: true } })).map((i) => i.id);
  await db.leadRequirement.deleteMany({ where: { itemId: { in: items } } });
  await db.lead.deleteMany({ where: { title: { startsWith: TAG } } });
  await db.item.deleteMany({ where: { id: { in: items } } });
  await db.productFamily.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.brand.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.itemCategory.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.company.deleteMany({ where: { name: { startsWith: TAG } } });
}

async function main() {
  console.log("\n— Which field picks from which list —\n");
  ok("order's product category → categories", productChoiceKind("trigger.order.itemCategory") === "category");
  ok("a document's categories → categories", productChoiceKind("trigger.document.categories") === "category");
  ok("order's brand, a lead's brands → brands", productChoiceKind("trigger.order.brand") === "brand" && productChoiceKind("trigger.lead.brands") === "brand");
  ok("family and families → families", productChoiceKind("trigger.order.family") === "family" && productChoiceKind("trigger.lead.families") === "family");
  ok("any other field keeps its text box", productChoiceKind("trigger.lead.title") === null && productChoiceKind("trigger.company.name") === null);
  ok("a list field starts as contains; an order's single one doesn't", isProductList("trigger.lead.brands") && !isProductList("trigger.order.brand"));

  console.log("\n— The data picker —\n");
  const labels = (type: string) => triggerPaths(type).map((p) => p.label);
  ok("leads offer product categories, brands, families", ["Lead › product categories", "Lead › brands", "Lead › product families"].every((l) => labels("lead.created").includes(l)), labels("lead.created").slice(-3));
  ok("documents too", labels("document.issued").includes("Document › brands") && labels("invoice.paid").includes("Document › product families"));
  ok("orders and renewals: product category, brand, family", ["Order › product category", "Order › brand", "Order › product family"].every((l) => labels("order.created").includes(l) && labels("renewal.due").includes(l)));

  console.log("\n— Rules —\n");
  ok("brands contains Microsoft (any case)", compare("contains", ["Adobe", "Microsoft"], "microsoft"));
  ok("brands doesn't contain Dell", compare("notContains", ["Adobe", "Microsoft"], "Dell"));
  ok("order brand is Microsoft", compare("eq", "Microsoft", "Microsoft"));
  ok("no products: categories is empty", compare("isEmpty", [], null));
  const one = productOf({ sku: "S", category: "Software", brand: { name: "Microsoft" }, productFamily: { name: "Microsoft 365" } });
  ok("one product's fields", one.itemCategory === "Software" && one.brand === "Microsoft" && one.family === "Microsoft 365" && one.itemSku === "S", one);
  const many = productsOf([
    { sku: "A", category: "Software", brand: { name: "Microsoft" }, productFamily: { name: "Microsoft 365" } },
    { sku: "B", category: "Software", brand: { name: "Adobe" }, productFamily: null },
    null,
    { sku: "C", category: null, brand: null, productFamily: null },
  ]);
  ok("many products: no repeats, sorted, blanks and free lines left out", JSON.stringify(many) === JSON.stringify({ categories: ["Software"], brands: ["Adobe", "Microsoft"], families: ["Microsoft 365"] }), many);

  console.log("\n— A lead's payload —\n");
  await cleanup();
  try {
    const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
    if (!admin) throw new Error("The local database has no super admin.");
    const brand = await db.brand.create({ data: { name: `${TAG} Microsoft` } });
    const other = await db.brand.create({ data: { name: `${TAG} Adobe` } });
    const family = await db.productFamily.create({ data: { name: `${TAG} M365`, brandId: brand.id } });
    await db.itemCategory.create({ data: { name: `${TAG} Software` } });
    const item = (sku: string, brandId: string, productFamilyId: string | null) =>
      db.item.create({ data: { name: sku, sku: `${TAG}-${sku}`, type: "SUBSCRIPTION", sellingPrice: 100, createdById: admin.id, category: `${TAG} Software`, brandId, productFamilyId } });
    const a = await item("A", brand.id, family.id);
    const b = await item("B", other.id, null);
    const company = await db.company.create({ data: { name: `${TAG} Customer`, normalizedName: `${TAG.toLowerCase()} customer`, createdById: admin.id } });
    const lead = await db.lead.create({ data: { title: `${TAG} Lead`, companyId: company.id } });
    await db.leadRequirement.createMany({ data: [{ leadId: lead.id, itemId: a.id }, { leadId: lead.id, itemId: b.id }] });
    const facts = await leadFacts(db, lead.id);
    const l = facts?.lead as { categories?: string[]; brands?: string[]; families?: string[] } | undefined;
    ok("the lead carries its products' category", JSON.stringify(l?.categories) === JSON.stringify([`${TAG} Software`]), l?.categories);
    ok("…both brands", JSON.stringify(l?.brands) === JSON.stringify([`${TAG} Adobe`, `${TAG} Microsoft`]), l?.brands);
    ok("…and the one family", JSON.stringify(l?.families) === JSON.stringify([`${TAG} M365`]), l?.families);
    ok("a rule \"brands contains Microsoft\" holds on it", compare("contains", l?.brands, `${TAG} Microsoft`));
  } finally {
    await cleanup();
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} failed` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}

void main();
