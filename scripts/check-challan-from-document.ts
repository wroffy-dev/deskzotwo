/**
 * check:challan-from-document — a delivery challan made from a proposal, a proforma or a tax invoice (owner, 16 Nov 2026:
 * "create delivery challan button from proposal, proforma invoice and tax invoice"; src/actions/delivery-challan.ts).
 *
 * An issued invoice of two lines: a first challan for part of one line, issued and numbered, its value and tax in
 * proportion; what is left offered next time; more than is left refused; a draft, a cancelled document and a purchase
 * order refused; somebody without the challan's permissions refused. Its own records (Zzdc…), removed in a finally.
 *
 *   npx tsx scripts/check-challan-from-document.ts
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

const db = directClient();
const MAIL = "@zzprobe-dc.invalid";
const TAG = "Zzdc";
const RUN = Date.now().toString(36);

let actor: { id: string; name: string; email: string; role: string } | null = null;
const load = Module.createRequire(__filename);
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown; _resolveFilename(r: string, p: unknown, m: boolean): string };
const substitutes = new Map<string, unknown>([
  [
    load.resolve("../src/lib/session"),
    {
      requireUser: async () => {
        if (!actor) throw new Error("No caller.");
        return actor;
      },
      currentUser: async () => actor,
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => null,
    },
  ],
  [load.resolve("next/cache"), { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn }],
]);
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && substitutes.has(resolved)) return substitutes.get(resolved);
  return realLoad.call(this, request, parent, isMain);
} as typeof realLoad;

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};

async function cleanup() {
  const users = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  await db.tradeDocument.deleteMany({ where: { companyId: { in: companies }, sourceDocumentId: { not: null } } });
  await db.tradeDocument.deleteMany({ where: { companyId: { in: companies } } });
  await db.company.deleteMany({ where: { id: { in: companies } } });
  await db.auditLog.deleteMany({ where: { userId: { in: users } } });
  await db.userPermission.deleteMany({ where: { userId: { in: users } } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: { in: users } } });
}

async function main() {
  const dc = load("../src/actions/delivery-challan") as typeof import("../src/actions/delivery-challan");
  const { documentWriteKey } = load("../src/lib/documents/write-permission") as typeof import("../src/lib/documents/write-permission");
  await cleanup();
  try {
    const grants = (keys: string[], allowed = true) => ({ create: keys.map((permission) => ({ permission, allowed, reason: "ZZDC" })) });
    const dcKeys = [documentWriteKey("DELIVERY_CHALLAN", "create"), documentWriteKey("DELIVERY_CHALLAN", "issue")];
    const base = ["documents.view", "companies.viewAll", "documents.viewAll"];
    const maker = await db.user.create({ data: { name: "Maker Zzdc", email: `maker${MAIL}`, role: "ADMIN", passwordHash: "x".repeat(60), permissionGrants: grants([...base, ...dcKeys]) } });
    const without = await db.user.create({ data: { name: "Without Zzdc", email: `without${MAIL}`, role: "SALES", passwordHash: "x".repeat(60), permissionGrants: grants(dcKeys, false) } });
    const as = (u: { id: string; name: string; email: string; role: string }) => (actor = { id: u.id, name: u.name, email: u.email, role: u.role });
    const customer = await db.company.create({ data: { name: `${TAG} Customer ${RUN}`, normalizedName: `${TAG} customer ${RUN}`.toLowerCase(), createdById: maker.id } });

    const line = (name: string, qty: number, price: number, sortOrder: number) => {
      const taxable = qty * price;
      return { name, quantity: qty, unitPrice: price, taxRatePercent: 18, taxableValue: taxable, cgstAmount: taxable * 0.09, sgstAmount: taxable * 0.09, igstAmount: 0, lineTotal: taxable * 1.18, hsnCode: "8471", unit: "Nos", sortOrder };
    };
    const doc = (docType: "INVOICE" | "PROPOSAL" | "PURCHASE_ORDER", status: "ISSUED" | "DRAFT" | "CANCELLED", suffix: string) =>
      db.tradeDocument.create({
        data: {
          docNumber: `ZZDC-${RUN}-${suffix}`,
          docType,
          direction: docType === "PURCHASE_ORDER" ? "PURCHASE" : "SALES",
          status,
          companyId: customer.id,
          createdById: maker.id,
          buyerGstin: "29AAAAA0000A1Z5",
          placeOfSupplyCode: "29",
          lines: { create: [line("Laptop", 10, 50_000, 0), line("Dock", 4, 5_000, 1)] },
        },
        select: { id: true, docNumber: true },
      });
    const invoice = await doc("INVOICE", "ISSUED", "INV");
    const draft = await doc("PROPOSAL", "DRAFT", "QT");
    const cancelled = await doc("INVOICE", "CANCELLED", "CAN");
    const po = await doc("PURCHASE_ORDER", "ISSUED", "PO");

    console.log("\n— Who and what —\n");
    as(without);
    ok("somebody without the challan's permissions is refused", !(await dc.deliveryChallanSource(invoice.id)).ok);
    as(maker);
    for (const [label, d] of [["a draft proposal", draft], ["a cancelled invoice", cancelled], ["a purchase order", po]] as const) {
      ok(`${label} can't have one`, !(await dc.deliveryChallanSource(d.id)).ok);
    }

    console.log("\n— The first challan —\n");
    const source = await dc.deliveryChallanSource(invoice.id);
    ok("an issued invoice offers every line, all of it left", source.ok && source.data.lines.map((l) => `${l.name}:${l.left}`).join() === "Laptop:10,Dock:4", source.ok ? source.data.lines : source.error);
    const nothing = await dc.createDeliveryChallan({ documentId: invoice.id, lines: [{ sortOrder: 0, quantity: 0 }] });
    ok("nothing to send is refused", !nothing.ok);
    const first = await dc.createDeliveryChallan({ documentId: invoice.id, lines: [{ sortOrder: 0, quantity: 4 }], notes: "Vehicle KA01 1234" });
    ok("4 laptops go", first.ok, first.ok ? first.data : first.error);
    const made = first.ok ? await db.tradeDocument.findUnique({ where: { id: first.data.id }, include: { lines: true } }) : null;
    ok(
      "  issued and numbered, linked to the invoice, its parties and place of supply copied",
      made?.docType === "DELIVERY_CHALLAN" && made.status === "ISSUED" && !!made.docNumber && made.sourceDocumentId === invoice.id && made.buyerGstin === "29AAAAA0000A1Z5" && made.placeOfSupplyCode === "29" && made.einvoiceStatus === "NOT_APPLICABLE",
      made && { type: made.docType, status: made.status, number: made.docNumber },
    );
    ok(
      "  one line, its value and tax in proportion: 4 × 50,000 = 2,00,000 + 18%",
      made?.lines.length === 1 && Number(made.lines[0]!.quantity) === 4 && Number(made.lines[0]!.taxableValue) === 200_000 && Number(made.lines[0]!.cgstAmount) === 18_000 && Number(made.total) === 236_000,
      made && { lines: made.lines.map((l) => [Number(l.quantity), Number(l.taxableValue), Number(l.cgstAmount)]), total: Number(made.total) },
    );
    ok("  the note kept, and the invoice as its reference", made?.notes === "Vehicle KA01 1234" && made.reference === `Tax invoice ${invoice.docNumber}`);
    ok("  never posted to the books", !!made && (await db.journalEntry.count({ where: { documentId: made.id } })) === 0);

    console.log("\n— What is left —\n");
    const again = await dc.deliveryChallanSource(invoice.id);
    ok("next time: 6 laptops and 4 docks left, the first challan named", again.ok && again.data.lines.map((l) => `${l.name}:${l.sent}/${l.left}`).join() === "Laptop:4/6,Dock:0/4" && again.data.challans.length === 1, again.ok ? again.data : again.error);
    const tooMany = await dc.createDeliveryChallan({ documentId: invoice.id, lines: [{ sortOrder: 0, quantity: 7 }] });
    ok("more than is left is refused, saying how many", !tooMany.ok && /6 left/.test(tooMany.error), tooMany.ok ? "ACCEPTED" : tooMany.error);
    const rest = await dc.createDeliveryChallan({ documentId: invoice.id, lines: [{ sortOrder: 0, quantity: 6 }, { sortOrder: 1, quantity: 4 }] });
    const done = await dc.deliveryChallanSource(invoice.id);
    ok("the rest goes; nothing left after", rest.ok && done.ok && done.data.lines.every((l) => l.left === 0), done.ok ? done.data.lines : "");
    if (first.ok) await db.tradeDocument.update({ where: { id: first.data.id }, data: { status: "CANCELLED" } });
    const freed = await dc.deliveryChallanSource(invoice.id);
    ok("a cancelled challan gives its quantity back", freed.ok && freed.data.lines.find((l) => l.name === "Laptop")?.left === 4, freed.ok ? freed.data.lines : "");
  } finally {
    await cleanup();
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} check(s) FAILED.\n` : "\nAll challan-from-document checks passed.\n");
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => undefined);
  process.exit(1);
});
