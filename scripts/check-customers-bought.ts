/**
 * check:customers-bought — who counts as a customer (owner, 16 Nov 2026: "if any company has active or expired order or
 * even single invoicing done ! - it should show in customer"; src/lib/customers/bought.ts).
 *
 * Companies of its own (Zzcb…): one with an order, one with only an issued invoice, one with only a draft invoice, one
 * with only a cancelled one, one with an invoice in the old system's archive, one whose archived invoice was void, and
 * one with nothing. Each asked through the rule the Customers list uses. Removed in a finally.
 *
 *   npx tsx scripts/check-customers-bought.ts
 */
import "dotenv/config";
import { directClient } from "../src/lib/tenancy/direct-client";

const db = directClient();
const TAG = "Zzcb";
const RUN = Date.now().toString(36);
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};

async function cleanup() {
  const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  await db.archivedDocument.deleteMany({ where: { partyName: { startsWith: TAG } } });
  await db.migration.deleteMany({ where: { source: `${TAG}-check` } });
  await db.tradeDocument.deleteMany({ where: { companyId: { in: companies } } });
  await db.companyProduct.deleteMany({ where: { companyId: { in: companies } } });
  await db.companyLocation.deleteMany({ where: { companyId: { in: companies } } });
  await db.company.deleteMany({ where: { id: { in: companies } } });
}

async function main() {
  const { boughtFromUsWhere } = await import("../src/lib/customers/bought");
  await cleanup();
  try {
    const someone = await db.user.findFirst({ where: { active: true }, select: { id: true } });
    if (!someone) throw new Error("No user to own the records.");
    const company = (name: string) => db.company.create({ data: { name: `${TAG} ${name} ${RUN}`, normalizedName: `${TAG} ${name} ${RUN}`.toLowerCase(), createdById: someone.id }, select: { id: true } });
    const invoice = (companyId: string, status: "ISSUED" | "DRAFT" | "CANCELLED", n: string) =>
      db.tradeDocument.create({ data: { docNumber: `ZZCB-${RUN}-${n}`, docType: "INVOICE", direction: "SALES", status, companyId, createdById: someone.id } });

    const ordered = await company("Ordered");
    const item = await db.item.findFirst({ select: { id: true } });
    if (item) {
      const site = await db.companyLocation.create({ data: { companyId: ordered.id, label: "Head office" } as never, select: { id: true } });
      await db.companyProduct.create({ data: { companyId: ordered.id, locationId: site.id, itemId: item.id, addedByUserId: someone.id } as never });
    }
    const invoiced = await company("Invoiced");
    await invoice(invoiced.id, "ISSUED", "1");
    const drafted = await company("Drafted");
    await invoice(drafted.id, "DRAFT", "2");
    const cancelled = await company("Cancelled");
    await invoice(cancelled.id, "CANCELLED", "3");
    const archived = await company("Archived");
    const voided = await company("Voided");
    const nothing = await company("Nothing");
    const migration = await db.migration.create({ data: { source: `${TAG}-check`, yearStart: new Date("2026-04-01T00:00:00Z"), switchDate: new Date("2026-11-01T00:00:00Z"), createdById: someone.id } });
    const arch = (companyId: string, status: string | null, n: string) =>
      db.archivedDocument.create({ data: { migrationId: migration.id, kind: "INVOICE", key: `INVOICE|${TAG}|${n}`, number: `ZC-${n}`, date: new Date("2024-06-01T00:00:00Z"), year: "2024-25", companyId, partyName: `${TAG} ${n}`, status, total: 1000 } });
    await arch(archived.id, "paid", "A");
    await arch(voided.id, "Void", "V");

    const bought = await boughtFromUsWhere();
    const ids = new Set((await db.company.findMany({ where: { AND: [{ name: { startsWith: TAG } }, bought] }, select: { id: true } })).map((c) => c.id));
    if (item) ok("an order on file makes a customer, as before", ids.has(ordered.id));
    ok("so does one issued invoice, with no order", ids.has(invoiced.id));
    ok("so does an invoice in the old system's archive", ids.has(archived.id));
    ok("a draft invoice doesn't", !ids.has(drafted.id));
    ok("nor a cancelled one", !ids.has(cancelled.id));
    ok("nor an archived invoice Zoho marked void", !ids.has(voided.id));
    ok("nor a company with nothing", !ids.has(nothing.id));
    const notYet = new Set((await db.company.findMany({ where: { AND: [{ name: { startsWith: TAG } }, { NOT: bought }] }, select: { id: true } })).map((c) => c.id));
    ok("the rest are 'not yet' — the Companies list's Awaiting Order bucket", [drafted.id, cancelled.id, voided.id, nothing.id].every((id) => notYet.has(id)) && !notYet.has(invoiced.id) && !notYet.has(archived.id));
  } finally {
    await cleanup();
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} check(s) FAILED.\n` : "\nAll customer checks passed.\n");
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
