/**
 * check:write-off — writing off bad debts (owner, 15 Nov 2026 — src/lib/receivables/write-off.ts, src/actions/write-off.ts).
 *
 *   1. The rules, pure: whole months between two days; UAE bad-debt relief — none in India, none before six months, none
 *      until the customer is told, else the VAT on what's written off; the VAT return's Box 1 adjustment taking 8, 12
 *      and 14 down.
 *   2. India, through the real actions: what's left on a part-paid invoice written off — Bad Debts against the
 *      customer's receivable, the invoice settled (balance, status, the ageing's own loader), refused twice; undone —
 *      reversed, owed again.
 *   3. The UAE: refused relief without the customer told; with it, the VAT out of Output VAT, and on the period's VAT
 *      return as a Box 1 adjustment that takes what's payable down by it.
 *
 * Its own customer (ZZWO …) and invoices, as the super admin; removed in a finally with their entries.
 *
 *   npm run check:write-off
 */
import "dotenv/config";
import Module from "node:module";
import { db } from "../src/lib/db";
import { legacyTenant } from "../src/lib/tenancy/registry";
import { runAsTenant } from "../src/lib/tenancy/resolve";
import type { Tenant } from "../src/lib/tenancy/state";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && !pass ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const day = (d: string) => new Date(`${d}T00:00:00Z`);

const internals = Module as unknown as { _load(req: string, parent: unknown, isMain: boolean): unknown };
const originalLoad = internals._load;
let actorId = "";
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {} };
  if (request.endsWith("lib/session") || request === "@/lib/session") {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    const user = async () => ({ id: actorId, name: "Probe", role: "ADMIN" });
    return { ...real, requireUser: user, currentUser: user, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/lib/modules-access" || request.endsWith("lib/modules-access")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    const user = async () => ({ id: actorId, name: "Probe", role: "ADMIN" });
    return { ...real, requireModuleUser: user, requireModuleAccess: user, moduleAvailableForTenant: async () => true };
  }
  if (request === "@/actions/module" || request.endsWith("actions/module")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, isModuleEnabled: async () => true };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const TAG = "ZZWO";

async function main() {
  section("1. The rules");
  const w = await import("../src/lib/receivables/write-off");
  ok("whole months: 1 Mar → 1 Oct is 7, → 30 Aug is 5", w.monthsBetween(day("2026-03-01"), day("2026-10-01")) === 7 && w.monthsBetween(day("2026-03-01"), day("2026-08-30")) === 5);
  const base = { uae: true, issueDate: day("2026-03-01"), writtenOffOn: day("2026-10-01"), total: 1050, vat: 50, amount: 1050, customerNotifiedOn: day("2026-09-20") };
  ok("India: no relief, and nothing to explain", JSON.stringify(w.badDebtRelief({ ...base, uae: false })) === '{"vat":0,"why":null}');
  ok("UAE before six months: none, and why", w.badDebtRelief({ ...base, writtenOffOn: day("2026-08-30") }).why?.includes("Six months") === true);
  ok("  the customer not told: none, and why", w.badDebtRelief({ ...base, customerNotifiedOn: null }).why?.includes("Tell the customer") === true);
  ok("  all met: the VAT on what's written off — 50 on all of it, 25 on half", w.badDebtRelief(base).vat === 50 && w.badDebtRelief({ ...base, amount: 525 }).vat === 25);
  const vr = await import("../src/lib/vat/return");
  const sale = { id: "s", number: "S1", direction: "SALES" as const, sign: 1 as const, reverseCharge: false, emirate: "Dubai" as const, lines: [{ category: "STANDARD", rate: 5, taxable: 1000, vat: 50 }] };
  const plain = vr.buildVatReturn([sale]);
  const relieved = vr.buildVatReturn([sale], [{ emirate: "Dubai", vat: 20 }]);
  const dubai = relieved.box1.find((r) => r.emirate === "Dubai");
  ok("the return: Box 1 Dubai adjusted −20, boxes 8, 12, 14 down by 20", dubai?.adjustment === -20 && relieved.box12 === plain.box12 - 20 && relieved.box14 === plain.box14 - 20 && relieved.badDebtRelief === 20, { dubai, relieved: relieved.box12, plain: plain.box12 });
  ok("  and the CSV says so in its own column", vr.vatReturnRows(relieved).some((row) => row[1] === "Standard rated supplies in Dubai" && row[4] === "-20.00"));

  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!admin) throw new Error("no super admin to act as");
  actorId = admin.id;
  const home = await legacyTenant();
  if (!home) throw new Error("no workspace to act as");
  const india: Tenant = { ...home, country: "IN" };
  const uae: Tenant = { ...home, country: "AE" };

  const companyId = `zzwo_${Date.now()}`;
  const invoices: string[] = [];
  try {
    await db.$executeRaw`INSERT INTO "companies" ("id", "name", "normalizedName", "relationshipType", "createdById", "ownerUserId", "updatedAt") VALUES (${companyId}, ${`${TAG} Customer`}, ${`${TAG.toLowerCase()} customer`}, 'CLIENT'::"CompanyRelationshipType", ${admin.id}, ${admin.id}, now())`;
    let n = 0;
    const invoice = async (total: number, vat: number, issued: string) => {
      const doc = await db.tradeDocument.create({
        data: { docType: "INVOICE", direction: "SALES", status: "ISSUED", companyId, docNumber: `${TAG}-${Date.now()}-${++n}`, taxableValue: total - vat, igstAmount: vat, total, createdById: admin.id, issueDate: day(issued), dueDate: day(issued) } as never,
        select: { id: true, docNumber: true },
      });
      invoices.push(doc.id);
      return doc;
    };
    const a = await import("../src/actions/write-off");
    const { invoiceBalance } = await import("../src/lib/collect/balance");
    const { subledgerAt } = await import("../src/lib/close/tieout");
    const status = async (id: string) => (await db.tradeDocument.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
    const entryOf = async (id: string) => {
      const row = await db.invoiceWriteOff.findUnique({ where: { invoiceId: id }, select: { journalEntryId: true } });
      return row?.journalEntryId ? db.journalEntry.findUnique({ where: { id: row.journalEntryId }, select: { id: true, source: true, lines: { select: { debit: true, credit: true, companyId: true, account: { select: { systemKey: true } } } } } }) : null;
    };
    const line = (e: Awaited<ReturnType<typeof entryOf>>, key: string) => e?.lines.find((l) => l.account.systemKey === key);

    section("2. India");
    await runAsTenant(india, async () => {
      const inv = await invoice(11800, 1800, "2026-09-01");
      const p = await db.payment.create({ data: { companyId, amount: 1800, paidOn: day("2026-09-10"), method: "BANK_TRANSFER", direction: "RECEIVED", recordedByUserId: admin.id } as never, select: { id: true } });
      await db.paymentAllocation.create({ data: { paymentId: p.id, documentId: inv.id, amount: 1800, allocatedByUserId: admin.id } });
      ok("the invoice owes 10,000 after a part payment", (await invoiceBalance(inv.id))?.balance === 10000);
      const preview = await a.writeOffPreview(inv.id, "2026-11-10", null);
      ok("the preview: 10,000 to go, no relief in India", preview.ok && preview.data.balance === 10000 && preview.data.relief === 0 && !preview.data.uae, preview);
      ok("a write-off with no reason is refused", !(await a.writeOffInvoice({ invoiceId: inv.id, writtenOffOn: "2026-11-10", reason: "" })).ok);
      const done = await a.writeOffInvoice({ invoiceId: inv.id, writtenOffOn: "2026-11-10", reason: "Customer closed down" });
      ok("written off: 10,000", done.ok && done.data.amount === 10000 && done.data.relief === 0, done);
      ok("  the invoice settled: nothing owed, marked paid", (await invoiceBalance(inv.id))?.balance === 0 && (await status(inv.id)) === "PAID");
      const entry = await entryOf(inv.id);
      ok("  posted as a write-off: Bad Debts 10,000 against the customer's receivable", entry?.source === "WRITE_OFF" && Number(line(entry, "BAD_DEBTS")?.debit) === 10000 && Number(line(entry, "AR")?.credit) === 10000 && line(entry, "AR")?.companyId === companyId, entry);
      const { documents } = await subledgerAt("AR", day("2026-11-30"), { documents: { id: inv.id } });
      const d = documents.find((x) => x.id === inv.id);
      ok("  the ageing's own loader counts it settled", !!d && Math.abs(d.total - d.allocated - d.credited) < 0.01, d);
      ok("  as of before it was written off, still owed", ((await subledgerAt("AR", day("2026-11-05"), { documents: { id: inv.id } })).documents.find((x) => x.id === inv.id)?.credited ?? -1) === 0);
      ok("written off twice: refused", !(await a.writeOffInvoice({ invoiceId: inv.id, writtenOffOn: "2026-11-10", reason: "Again" })).ok);
      const undone = await a.undoWriteOff(inv.id);
      const reversal = entry ? await db.journalEntry.findFirst({ where: { reversesId: entry.id } }) : null;
      ok("undone: the entry reversed, 10,000 owed again, part-paid", undone.ok && !!reversal && (await invoiceBalance(inv.id))?.balance === 10000 && (await status(inv.id)) === "PARTIALLY_PAID", undone);
      ok("  a write-off ahead of today is refused", !(await a.writeOffInvoice({ invoiceId: inv.id, writtenOffOn: "2099-01-01", reason: "Too early" })).ok);
    });

    section("3. The UAE");
    await runAsTenant(uae, async () => {
      const inv = await invoice(1050, 50, "2026-03-01");
      const early = await a.writeOffPreview(inv.id, "2026-10-01", null);
      ok("the preview: no relief until the customer is told", early.ok && early.data.uae && early.data.relief === 0 && /Tell the customer/.test(early.data.reliefWhy ?? ""), early);
      ok("claiming relief without it is refused", !(await a.writeOffInvoice({ invoiceId: inv.id, writtenOffOn: "2026-10-01", reason: "Gone", claimRelief: true })).ok);
      const told = await a.writeOffPreview(inv.id, "2026-10-01", "2026-09-20");
      ok("  told: 50 VAT claimable", told.ok && told.data.relief === 50, told);
      const { getVatReturn } = await import("../src/actions/vat-return");
      const before = await getVatReturn("2026-Q4");
      const done = await a.writeOffInvoice({ invoiceId: inv.id, writtenOffOn: "2026-10-01", reason: "Customer left the UAE", customerNotifiedOn: "2026-09-20", claimRelief: true });
      ok("written off with 50 VAT relief", done.ok && done.data.relief === 50, done);
      const entry = await entryOf(inv.id);
      ok("  Bad Debts 1,000, Output VAT 50, the receivable 1,050", Number(line(entry, "BAD_DEBTS")?.debit) === 1000 && Number(line(entry, "OUTPUT_IGST")?.debit) === 50 && Number(line(entry, "AR")?.credit) === 1050, entry);
      const after = await getVatReturn("2026-Q4");
      ok(
        "the Q4 return: relief up by 50, what's payable down by 50",
        before.ok && after.ok && Math.abs(after.data.vat.badDebtRelief - before.data.vat.badDebtRelief - 50) < 0.01 && Math.abs(before.data.vat.box14 - after.data.vat.box14 - 50) < 0.01,
        before.ok && after.ok ? { before: before.data.vat.box14, after: after.data.vat.box14, relief: after.data.vat.badDebtRelief } : { before, after },
      );
      ok("  shown under an emirate's adjustment", after.ok && after.data.vat.box1.some((r) => r.adjustment <= -50));
    });
  } finally {
    const rows = await db.invoiceWriteOff.findMany({ where: { invoiceId: { in: invoices } }, select: { journalEntryId: true } });
    const keyed = (await db.journalEntry.findMany({ where: { postingKey: { startsWith: "write-off:" }, lines: { some: { companyId } } }, select: { id: true } })).map((e) => e.id);
    const originals = [...new Set([...rows.map((r) => r.journalEntryId).filter((v): v is string => !!v), ...keyed])];
    await db.journalEntry.deleteMany({ where: { reversesId: { in: originals } } });
    await db.journalEntry.deleteMany({ where: { id: { in: originals } } });
    await db.invoiceWriteOff.deleteMany({ where: { invoiceId: { in: invoices } } });
    const payments = (await db.payment.findMany({ where: { companyId }, select: { id: true } })).map((p) => p.id);
    await db.paymentAllocation.deleteMany({ where: { paymentId: { in: payments } } });
    await db.payment.deleteMany({ where: { id: { in: payments } } });
    await db.tradeDocument.deleteMany({ where: { id: { in: invoices } } });
    await db.company.deleteMany({ where: { id: companyId } });
  }
}

main()
  .then(() => {
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
