/**
 * check:migration-advances — advances from before the year, carried into it (owner, 17 Nov 2026 — "why payments not
 * settled? still shows unpaid"; src/lib/migration/advances.ts, the pull's rows and archive).
 *
 *   1. The pull reads a pre-year payment changed this year in full, and keeps the day and TDS of each application;
 *      the archive keeps them too.
 *   2. The list: payments that settled this year's invoices — only applications on or after the year's first day; a
 *      payment in another currency, or of a customer not in Deskzo, is left saying why; a customer carried by the
 *      opening trial balance is marked so.
 *   3. Carried in: an opening advance on its own day, set against those invoices on their days (TDS included), the
 *      invoices paid; posted against Opening Balance Equity on the year's first day only where the opening balances
 *      don't already hold the customer; and never twice.
 *
 * Own fixture tagged ZZAD, removed in a finally.
 *
 *   npm run check:migration-advances
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const TAG = "ZZAD";
const openingIds: string[] = [];

async function cleanup() {
  const companies = await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = companies.map((c) => c.id);
  const payments = await db.payment.findMany({ where: { companyId: { in: ids } }, select: { id: true } });
  await db.journalEntry.deleteMany({ where: { OR: [{ paymentId: { in: payments.map((p) => p.id) } }, { id: { in: openingIds } }] } });
  await db.payment.deleteMany({ where: { companyId: { in: ids } } });
  await db.tradeDocument.deleteMany({ where: { companyId: { in: ids } } });
  await db.migration.deleteMany({ where: { source: { startsWith: TAG } } });
  await db.company.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  const rows = await import("../src/lib/zoho/rows");
  const pull = await import("../src/lib/zoho/pull");
  const archive = await import("../src/lib/migration/archive");

  section("1. The pull and the archive");
  const pr = rows.customerPaymentRows({ payment_number: "17633", payment_id: "P1", date: "2026-03-30", amount: 33158, customer_name: "Zz", invoices: [{ invoice_number: "WT/26-27/19", amount_applied: 30000, tax_amount_withheld: 3158, apply_date: "2026-04-03" }] });
  ok("a payment's rows say when each application was made, and its TDS", pr[0]?.["Applied On"] === "2026-04-03" && pr[0]?.["Withholding Tax Amount"] === "3158", pr[0]);
  const mod = pull.MODULES.find((x) => x.key === "customerpayments")!;
  ok("a payment from before the year changed since it began is read in full; one untouched since isn't", !!mod.detail?.({ date: "2026-03-30", last_modified_time: "2026-04-03T21:03:02+0530" }, "2026-04-01") && !mod.detail?.({ date: "2026-03-30", last_modified_time: "2026-03-31T10:00:00+0530" }, "2026-04-01") && !!mod.detail?.({ date: "2026-05-01" }, "2026-04-01"));
  const docs = archive.archiveDocuments("receipts", pr.map((r) => ({ ...r, "CustomerPayment ID": "P1", "Unused Amount": "0" }))).documents;
  const line = (docs[0]?.lines as { on?: string; withheld?: number }[] | undefined)?.[0];
  ok("the archive keeps the day and the TDS", line?.on === "2026-04-03" && line?.withheld === 3158, docs[0]?.lines);

  await cleanup();
  const someone = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true, active: true }, select: { id: true } });
  const company = (n: string) => db.company.create({ data: { name: `${TAG} ${n}`, normalizedName: `${TAG.toLowerCase()} ${n.toLowerCase()}`, relationshipType: "CLIENT", createdById: someone.id }, select: { id: true } });
  const left = await company("Left out");
  const kept = await company("In opening");
  const dollar = await company("Dollar");
  const lib = await import("../src/lib/migration/advances");
  const { resolveAccounts, writeEntry } = await import("../src/lib/ledger/journal");

  try {
    const migration = await db.migration.create({ data: { source: `${TAG}-check`, yearStart: new Date("2026-04-01T00:00:00Z"), switchDate: new Date("2026-12-01T00:00:00Z"), createdById: someone.id }, select: { id: true } });
    const m = { id: migration.id, source: `${TAG}-check`, yearStart: "2026-04-01", switchDate: "2026-12-01", status: "OPEN" as const, createdById: someone.id, createdAt: new Date(), finishedAt: null, undoneAt: null, counts: {} };
    const invoice = (n: string, companyId: string, total: number, day: string) =>
      db.tradeDocument.create({ data: { docNumber: `${TAG}-${n}`, docType: "INVOICE", direction: "SALES", status: "ISSUED", companyId, createdById: someone.id, total, issueDate: new Date(`${day}T00:00:00Z`) }, select: { id: true } });
    const inv19 = await invoice("19", left.id, 33158, "2026-04-03");
    const inv60 = await invoice("60", kept.id, 180628.5, "2026-04-10");
    const old = await invoice("OLD", left.id, 5000, "2026-03-15");
    const usd = await invoice("USD", dollar.id, 1000, "2026-05-01");
    await invoice("NB", left.id, 100, "2026-06-01");
    // The customer "In opening" is in the opening trial balance: a balance of theirs on Receivables from it.
    const acc = await db.$transaction((tx) => resolveAccounts(tx, ["AR", "OPENING_BALANCE_EQUITY"]));
    const opening = await db.$transaction((tx) =>
      writeEntry(tx, { date: new Date("2026-04-01T00:00:00Z"), narration: `${TAG} opening balances`, source: "OPENING", userId: someone.id, lines: [{ accountId: acc.get("OPENING_BALANCE_EQUITY")!, debit: 100000, credit: 0 }, { accountId: acc.get("AR")!, debit: 0, credit: 100000, companyId: kept.id }] }),
    );
    openingIds.push(opening.id);
    const archived = (key: string, number: string, companyId: string | null, partyName: string, lines: object[], balance = 0, currency = "INR") =>
      db.archivedDocument.create({ data: { migrationId: migration.id, kind: "CUSTOMER_PAYMENT", key, number, date: new Date("2026-03-30T00:00:00Z"), year: "2025-26", companyId, partyName, currency, total: 1, balance, lines } });
    await archived("A1", "17633", left.id, `${TAG} Left out`, [{ number: `${TAG}-19`, amount: 30000, withheld: 3158, on: "2026-04-03" }, { number: `${TAG}-OLD`, amount: 5000, on: "2026-03-20" }], 500);
    await archived("A2", "17658", kept.id, `${TAG} In opening`, [{ number: `${TAG}-60`, amount: 100000, on: "2026-04-12" }]);
    await archived("A3", "17999", dollar.id, `${TAG} Dollar`, [{ number: `${TAG}-USD`, amount: 1000, on: "2026-05-02" }], 0, "USD");
    await archived("A4", "18000", null, "Zz Nobody", [{ number: `${TAG}-NB`, amount: 100, on: "2026-06-02" }]);
    await archived("A5", "18001", left.id, `${TAG} Left out`, [{ number: `${TAG}-OLD`, amount: 5000, on: "2026-03-20" }]);

    section("2. The list");
    const list = await lib.advancesToCarry(m);
    const by = (n: string) => list.rows.find((r) => r.number === n);
    ok("payments that settled this year's invoices are listed; one used only before the year isn't", !!by("17633") && !!by("17658") && !by("18001"), list.rows.map((r) => r.number));
    ok("  only what was applied on or after the year's first day, TDS included, and what is still unused", by("17633")?.applied.length === 1 && by("17633")?.applied[0]?.amount === 33158 && by("17633")?.unused === 500 && by("17633")?.carried === 33658, by("17633"));
    ok("  a customer the opening balances carry is marked so; one left out is posted", by("17658")?.books === "opening" && by("17633")?.books === "post");
    ok("  another currency, and a customer not in Deskzo, are left saying why", /USD/.test(by("17999")?.left ?? "") && /isn't in Deskzo/.test(by("18000")?.left ?? "") && list.toCarry === 2 && list.left === 2, list);
    ok("  looking changed nothing", (await db.payment.count({ where: { companyId: { in: [left.id, kept.id] } } })) === 0);

    section("3. Carried in");
    const done = await lib.carryAdvances(m, someone.id);
    ok("two carried", done.carried === 2 && done.amount === 33658 + 100000, done);
    const pay = await db.payment.findFirstOrThrow({ where: { companyId: left.id }, include: { allocations: true } });
    ok("an opening advance on its own day, for what it carries", pay.paidOn.toISOString().slice(0, 10) === "2026-03-30" && Number(pay.amount) === 33658 && pay.reference === "17633", { paidOn: pay.paidOn, amount: Number(pay.amount) });
    ok("  set against the invoice on the day Zoho did, TDS included", pay.allocations.length === 1 && pay.allocations[0]!.documentId === inv19.id && Number(pay.allocations[0]!.amount) === 33158 && pay.allocations[0]!.createdAt.toISOString().slice(0, 10) === "2026-04-03");
    const statuses = await db.tradeDocument.findMany({ where: { id: { in: [inv19.id, inv60.id, old.id, usd.id] } }, select: { id: true, status: true } });
    const st = (id: string) => statuses.find((s) => s.id === id)?.status;
    ok("  the invoices it settled are paid; the old one and the dollar one untouched", st(inv19.id) === "PAID" && st(inv60.id) === "PARTIALLY_PAID" && st(old.id) === "ISSUED" && st(usd.id) === "ISSUED", statuses);
    const entryLeft = await db.journalEntry.findFirst({ where: { paymentId: pay.id }, include: { lines: { include: { account: { select: { systemKey: true } } } } } });
    ok("  the customer left out of the opening balances: posted on the year's first day, Receivables against Opening Balance Equity", !!entryLeft && entryLeft.date.toISOString().slice(0, 10) === "2026-04-01" && entryLeft.lines.some((l) => l.account.systemKey === "AR" && Number(l.credit) === 33658 && l.companyId === left.id) && entryLeft.lines.some((l) => l.account.systemKey === "OPENING_BALANCE_EQUITY" && Number(l.debit) === 33658), entryLeft?.lines.map((l) => [l.account.systemKey, Number(l.debit), Number(l.credit)]));
    const payKept = await db.payment.findFirstOrThrow({ where: { companyId: kept.id }, select: { id: true } });
    ok("  the customer the opening balances carry: nothing posted again", (await db.journalEntry.count({ where: { paymentId: payKept.id } })) === 0);
    ok("  each recorded against the migration, so Undo takes it back", (await db.migrationRecord.count({ where: { migrationId: migration.id, key: { startsWith: "ADVANCE:" }, kind: "payment" } })) === 2 && (await db.migrationRecord.count({ where: { migrationId: migration.id, key: { startsWith: "ADVANCE:" }, kind: "journal" } })) === 1);
    const again = await lib.advancesToCarry(m);
    ok("never twice: looking again finds only the two left", again.toCarry === 0 && again.left === 2 && (await lib.carryAdvances(m, someone.id)).carried === 0, again);
  } finally {
    await cleanup();
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  await db.$disconnect();
  if (failures) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
