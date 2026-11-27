/**
 * check:audit-fixes (group A1) — the security audit of 11 Nov 2026 (docs/reports/security-audit-2026-11-11.md), trade
 * documents, numbering and settlement, each fix shown to hold the way it was broken:
 *
 *   SEC-11  editing a draft races issuing it — an edit landing mid-issue stops the issue, an issue mid-edit stops the edit
 *   SEC-12  settlement under a lock — two payments, applications or allocations at once settle no more than is owed;
 *           money recorded onto an order has the order's ceiling
 *   SEC-16  a typed number moves its series a short step at most, and one too big for a series is refused
 *   SEC-71  a series can't be moved back below a number already used
 *   SEC-41  linking or unlinking an order's invoice line asks for "Issue tax invoices"; the statement PDF's filename
 *   SEC-69  issuing a document the ledger refuses is a refusal, not a crash
 *
 * Races are run for real: the row is held by a transaction of this script's own while the action reaches it, or two
 * calls go at once with Promise.all. A fixture of its own in the local database, named ZZA1, removed in a finally;
 * the numbering checks run inside a transaction that is rolled back, or put back what they changed.
 *
 *   npx tsx scripts/check-audit-fixes-a1.ts
 */
import "dotenv/config";
import Module from "node:module";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { buildDocumentNumber, expandPrefix } from "../src/lib/document-numbering";

const TAG = "ZZA1";
const RUN = randomUUID().slice(0, 8);
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? "" : (r.error ?? ""));

const internals = Module as unknown as { _load(req: string, parent: unknown, isMain: boolean): unknown };
const original = internals._load;
let actorId = "";
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
  if (request.endsWith("lib/session") || request === "@/lib/session") {
    const user = async () => ({ id: actorId, name: "Probe", role: "ADMIN" });
    return { requireUser: user, currentUser: user, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return original.call(this, request, parent, isMain);
} as typeof original;

/** A document form's input, as the existing audit suite writes it. */
const documentInput = (docType: string, companyId: string, extra: Record<string, unknown> = {}) => ({
  docType,
  companyId,
  currency: "INR",
  exchangeRate: 1,
  gstTreatment: "UNREGISTERED",
  placeOfSupplyCode: "07",
  issueDate: new Date().toISOString().slice(0, 10),
  billing: { line1: "", city: "", state: "", stateCode: "", pincode: "", country: "India" },
  shipping: { line1: "", city: "", state: "", stateCode: "", pincode: "", country: "India" },
  lines: [{ name: "Edited line", quantity: 1, unitPrice: 5000, discountMode: "PERCENT", discountValue: 0, taxRatePercent: 18 }],
  ...extra,
});

/**
 * Holds one trade document's row (FOR UPDATE) in a transaction of its own, starts `action` once it holds it, waits
 * until the action is queued behind the row, then runs `change` and commits — the other request winning the race.
 */
async function whileHeld<T>(documentId: string, action: () => Promise<T>, change: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<unknown>) {
  let held!: () => void;
  const holding = new Promise<void>((r) => (held = r));
  let queued = false;
  // A workspace's client has a pool of two, so the holder watches for the queued claim on its own connection.
  const holder = db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM trade_documents WHERE id = ${documentId} FOR UPDATE`;
      held();
      // Until something is waiting on a row lock (the action's claim), or eight seconds at most.
      for (let i = 0; i < 80 && !queued; i++) {
        await sleep(100);
        const rows = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype IN ('transactionid', 'tuple')`;
        queued = (rows[0]?.n ?? 0) > 0;
      }
      await change(tx);
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
  await holding;
  const result = action();
  await holder;
  return { result: await result, queued };
}

async function cleanup() {
  const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  const docs = (await db.tradeDocument.findMany({ where: { OR: [{ companyId: { in: companies } }, { docNumber: { startsWith: `${TAG}/` } }] }, select: { id: true } })).map((d) => d.id);
  const items = (await db.item.findMany({ where: { sku: { startsWith: TAG } }, select: { id: true } })).map((i) => i.id);
  const orders = (await db.companyProduct.findMany({ where: { OR: [{ itemId: { in: items } }, { companyId: { in: companies } }] }, select: { id: true } })).map((o) => o.id);
  const payments = (await db.payment.findMany({ where: { companyId: { in: companies } }, select: { id: true } })).map((p) => p.id);
  const users = (await db.user.findMany({ where: { email: { endsWith: "@zza1.invalid" } }, select: { id: true } })).map((u) => u.id);
  const records = [...docs, ...orders, ...payments, ...companies];
  await db.automationEvent.deleteMany({ where: { recordId: { in: records } } });
  await db.auditLog.deleteMany({ where: { OR: [{ entityId: { in: records } }, { userId: { in: users } }] } });
  await db.requestKey.deleteMany({ where: { recordId: { in: records } } });
  for (const id of companies) await db.renderGrant.deleteMany({ where: { subject: { contains: id } } });
  await db.journalEntry.deleteMany({ where: { reversesId: { not: null }, OR: [{ paymentId: { in: payments } }, { documentId: { in: docs } }, { companyId: { in: companies } }] } });
  await db.journalEntry.deleteMany({ where: { OR: [{ paymentId: { in: payments } }, { documentId: { in: docs } }, { companyId: { in: companies } }] } });
  await db.paymentAllocation.deleteMany({ where: { OR: [{ paymentId: { in: payments } }, { documentId: { in: docs } }, { companyProductId: { in: orders } }] } });
  await db.payment.deleteMany({ where: { id: { in: payments } } });
  await db.creditNoteApplication.deleteMany({ where: { OR: [{ invoiceId: { in: docs } }, { creditNoteId: { in: docs } }] } });
  await db.tradeDocumentLine.updateMany({ where: { companyProductId: { in: orders } }, data: { companyProductId: null } });
  await db.tradeDocument.updateMany({ where: { id: { in: docs } }, data: { againstDocumentId: null } });
  await db.tradeDocument.deleteMany({ where: { id: { in: docs } } });
  await db.companyProduct.deleteMany({ where: { id: { in: orders } } });
  await db.item.deleteMany({ where: { id: { in: items } } });
  await db.companyLocation.deleteMany({ where: { companyId: { in: companies } } });
  await db.company.deleteMany({ where: { id: { in: companies } } });
  await db.userPermission.deleteMany({ where: { userId: { in: users } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
}

class Rollback extends Error {}

async function main() {
  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!admin) throw new Error("no super admin to act as");
  actorId = admin.id;

  const { advanceSerialPast, seriesFor, typedSerialProblem, MAX_TYPED_STEP } = await import("../src/lib/trade-number");
  const { statementFilename } = await import("../src/lib/statements/render");
  const { updateTradeDocument, issueTradeDocument } = await import("../src/actions/trade-document");
  const { recordInvoicePayment, applyCreditNote } = await import("../src/actions/receivable");
  const { recordPayment, allocatePayment } = await import("../src/actions/payment");
  const { recordBillPayment } = await import("../src/actions/payable");
  const { saveNumberSetting } = await import("../src/actions/document-number");
  const { linkInvoiceLine, unlinkInvoiceLine } = await import("../src/actions/order-billing");

  // ── SEC-16, inside a transaction that is rolled back ─────────────────────────────────────────
  section("SEC-16: a typed number and its series");
  ok("trailing digits past what a series holds are refused for our own documents", /too large/.test(typedSerialProblem("INVOICE", "INV 99999999999") ?? ""));
  ok("  2147483647 too — one past it wouldn't fit the column", typedSerialProblem("PROPOSAL", "QT/2147483647") !== null);
  ok("  an ordinary number is fine", typedSerialProblem("INVOICE", "INV/2026-27/0042") === null);
  ok("  a vendor's bill carries the vendor's number, whatever its length", typedSerialProblem("BILL", "VEND-202611110000123456") === null);

  const seen: Record<string, number | string> = {};
  try {
    await db.$transaction(
      async (tx) => {
        const docType = "DELIVERY_CHALLAN" as const;
        await tx.documentNumberSetting.upsert({
          where: { docType },
          create: { docType, mode: "AUTO", scope: "COMPANY", prefix: `${TAG}/DC/`, nextNumber: 100, padding: 4 },
          update: { mode: "AUTO", scope: "COMPANY", prefix: `${TAG}/DC/`, nextNumber: 100, padding: 4 },
        });
        const next = async () => (await tx.documentNumberSetting.findUnique({ where: { docType }, select: { nextNumber: true } }))!.nextNumber;
        await advanceSerialPast(tx, docType, `${TAG}/DC/0105`);
        seen.near = await next();
        await advanceSerialPast(tx, docType, `${TAG}/DC/${106 + MAX_TYPED_STEP + 1}`);
        seen.far = await next();
        await advanceSerialPast(tx, docType, `${TAG}/DC/2147483646`);
        seen.edge = await next();
        try {
          await advanceSerialPast(tx, docType, `${TAG}/DC/99999999999`);
          seen.huge = await next();
        } catch (err) {
          seen.huge = `threw: ${(err as Error).message.slice(0, 80)}`;
        }
        await advanceSerialPast(tx, docType, `${TAG}/DC/5000`, null, new Date(), { anyStep: true });
        seen.imported = await next();

        // The same under a per-branch series: measured from the series' own next number.
        await tx.documentNumberSetting.update({ where: { docType }, data: { scope: "BRANCH" } });
        const series = await seriesFor(tx, docType, null);
        if (series.ref.kind === "series") {
          const expanded = expandPrefix(series.prefix, new Date(), series.ctx);
          const start = series.nextNumber;
          const read = async () => (await seriesFor(tx, docType, null)).nextNumber;
          await advanceSerialPast(tx, docType, `${expanded}${start + MAX_TYPED_STEP + 50}`);
          seen.branchFar = (await read()) - start;
          await advanceSerialPast(tx, docType, `${expanded}${start + 3}`);
          seen.branchNear = (await read()) - start;
        } else {
          seen.branchFar = "no head office";
        }
        throw new Rollback();
      },
      { timeout: 30_000 },
    );
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  ok("a typed number a few ahead moves the series past it", seen.near === 106, seen);
  ok("  one more than a thousand ahead leaves it where it was", seen.far === 106);
  ok("  one at the column's edge too — the workspace's series isn't pushed to overflow", seen.edge === 106);
  ok("  one past what the column holds neither moves it nor crashes", seen.huge === 106);
  ok("  a number brought from the old system still moves it, however far", seen.imported === 5001);
  if (typeof seen.branchFar === "number") {
    ok("a branch's series: far ahead leaves it, a few ahead moves it", seen.branchFar === 0 && seen.branchNear === 4, seen);
  } else {
    ok("a branch's series — no head office to test with (skipped)", true, seen.branchFar);
  }

  await cleanup();
  try {
    const customer = await db.company.create({ data: { name: `${TAG} Customer`, normalizedName: `${TAG.toLowerCase()} customer`, createdById: admin.id }, select: { id: true } });
    const vendor = await db.company.create({ data: { name: `${TAG} Vendor`, normalizedName: `${TAG.toLowerCase()} vendor`, createdById: admin.id }, select: { id: true } });
    const today = new Date().toISOString().slice(0, 10);
    const issueDate = new Date(`${today}T00:00:00Z`);
    // On the head office, as a document saved today is: one with no branch is adopted by the next head-office
    // lookup, which would queue behind the row the races below hold.
    const branchId = (await db.branch.findFirst({ where: { isHeadOffice: true }, select: { id: true } }))?.id ?? null;
    const doc = (n: string, data: Record<string, unknown>) =>
      db.tradeDocument.create({
        data: {
          docNumber: `${TAG}/${RUN}/${n}`,
          direction: "SALES",
          status: "ISSUED",
          companyId: customer.id,
          createdById: admin.id,
          issueDate,
          branchId,
          ...data,
        } as Parameters<typeof db.tradeDocument.create>[0]["data"],
        select: { id: true },
      });
    const line = { name: "Original line", quantity: 1, unitPrice: 1000, taxableValue: 1000, lineTotal: 1000 };

    // ── SEC-11 ─────────────────────────────────────────────────────────────────────────────────
    section("SEC-11: editing a draft while it is issued");
    const draftA = await doc("QT-A", { docType: "PROPOSAL", status: "DRAFT", total: 1000, taxableValue: 1000, lines: { create: [line] } });
    // The issue reads the draft, then an edit commits before the issue's claim reaches the row.
    const issueRace = await whileHeld(
      draftA.id,
      () => issueTradeDocument({ id: draftA.id }),
      (tx) => tx.tradeDocument.update({ where: { id: draftA.id }, data: { notes: "edited by somebody else", total: 9_99_999 } }),
    );
    const afterA = await db.tradeDocument.findUnique({ where: { id: draftA.id }, select: { status: true } });
    ok(
      "an edit saved while the issue was on its way stops the issue — it isn't issued unchecked",
      !issueRace.result.ok && /changed while it was being issued/.test(errorOf(issueRace.result)) && afterA?.status === "DRAFT",
      { queued: issueRace.queued, result: issueRace.result, status: afterA?.status },
    );
    // Back under the approval limits the edit took it past, so the control asks only what the race did.
    await db.tradeDocument.update({ where: { id: draftA.id }, data: { total: 1000 } });
    const control = await issueTradeDocument({ id: draftA.id });
    ok("  issued again with nothing in its way, it goes through", control.ok, control);

    const draftB = await doc("QT-B", { docType: "PROPOSAL", status: "DRAFT", total: 1000, taxableValue: 1000, lines: { create: [line] } });
    // The edit reads the draft, then an issue commits before the edit's claim reaches the row.
    const editRace = await whileHeld(
      draftB.id,
      () => updateTradeDocument({ ...documentInput("PROPOSAL", customer.id), id: draftB.id }),
      (tx) => tx.tradeDocument.update({ where: { id: draftB.id }, data: { status: "ISSUED", issuedAt: new Date() } }),
    );
    const linesB = await db.tradeDocumentLine.findMany({ where: { documentId: draftB.id }, select: { name: true } });
    ok(
      "an edit reaching a draft that was issued meanwhile is refused, and the issued lines stay as issued",
      !editRace.result.ok && /issued document can't be edited/.test(errorOf(editRace.result)) && linesB.length === 1 && linesB[0]!.name === "Original line",
      { queued: editRace.queued, result: editRace.result, lines: linesB },
    );

    // ── SEC-69 ─────────────────────────────────────────────────────────────────────────────────
    section("SEC-69: a ledger refusal at issue");
    // Totals that don't add up — 1,180 owed against 1,000 of sales and no tax — as a draft saved by an older build might.
    const lopsided = await doc("INV-X", { docType: "INVOICE", status: "DRAFT", total: 1180, taxableValue: 1000, lines: { create: [line] } });
    let issued: Awaited<ReturnType<typeof issueTradeDocument>> | string;
    try {
      issued = await issueTradeDocument({ id: lopsided.id });
    } catch (err) {
      issued = `threw: ${(err as Error).message}`;
    }
    const lopsidedNow = await db.tradeDocument.findUnique({ where: { id: lopsided.id }, select: { status: true } });
    ok(
      "an entry that doesn't balance comes back as a refusal, and the draft stays a draft",
      typeof issued !== "string" && !issued.ok && /doesn't balance/.test(errorOf(issued)) && lopsidedNow?.status === "DRAFT",
      { issued, status: lopsidedNow?.status },
    );

    // ── SEC-12 ─────────────────────────────────────────────────────────────────────────────────
    section("SEC-12: settling at the same moment");
    const invoice = await doc("INV-1", { docType: "INVOICE", total: 1000, taxableValue: 1000 });
    const pay = (ref: string) => recordInvoicePayment({ invoiceId: invoice.id, amount: 600, paidOn: today, method: "BANK_TRANSFER", reference: `${TAG}-${RUN}-${ref}` });
    const both = await Promise.all([pay("a"), pay("b")]);
    const settledInv = await db.paymentAllocation.aggregate({ where: { documentId: invoice.id }, _sum: { amount: true } });
    ok(
      "two payments of 600 at once on a 1,000 invoice: one goes through, the other is told what's left",
      both.filter((r) => r.ok).length === 1 && Number(settledInv._sum.amount) === 600 && both.some((r) => /outstanding/.test(errorOf(r))),
      { results: both, settled: Number(settledInv._sum.amount) },
    );

    const note = await doc("CN-1", { docType: "CREDIT_NOTE", total: 500, taxableValue: 500 });
    const invP = await doc("INV-2", { docType: "INVOICE", total: 1000, taxableValue: 1000 });
    const invQ = await doc("INV-3", { docType: "INVOICE", total: 1000, taxableValue: 1000 });
    const credits = await Promise.all([
      applyCreditNote({ creditNoteId: note.id, invoiceId: invP.id, amount: 400 }),
      applyCreditNote({ creditNoteId: note.id, invoiceId: invQ.id, amount: 400 }),
    ]);
    const spent = await db.creditNoteApplication.aggregate({ where: { creditNoteId: note.id }, _sum: { amount: true } });
    ok(
      "a 500 credit note applied to two invoices at once, 400 each: it's spent once",
      credits.filter((r) => r.ok).length === 1 && Number(spent._sum.amount) === 400,
      { results: credits, spent: Number(spent._sum.amount) },
    );

    const bill = await db.tradeDocument.create({
      data: { docNumber: `${TAG}/${RUN}/BILL-1`, docType: "BILL", direction: "PURCHASE", status: "ISSUED", companyId: vendor.id, createdById: admin.id, issueDate, branchId, total: 1000, taxableValue: 1000 },
      select: { id: true },
    });
    const payBill = (ref: string) => recordBillPayment({ billId: bill.id, amount: "600", paidOn: today, method: "BANK_TRANSFER", reference: `${TAG}-${RUN}-${ref}` });
    const bills = await Promise.all([payBill("c"), payBill("d")]);
    const paidOut = await db.paymentAllocation.aggregate({ where: { documentId: bill.id }, _sum: { amount: true } });
    ok(
      "two payments of 600 at once on a 1,000 vendor bill: one goes out",
      bills.filter((r) => r.ok).length === 1 && Number(paidOut._sum.amount) === 600,
      { results: bills, paid: Number(paidOut._sum.amount) },
    );

    const item = await db.item.create({ data: { name: `${TAG} Licence`, sku: `${TAG}-${RUN}-LIC`, type: "SERVICE", sellingPrice: 1000, taxRatePercent: 18, createdById: admin.id }, select: { id: true } });
    const location = await db.companyLocation.create({ data: { companyId: customer.id, label: "HO", isPrimary: true } });
    const order = () =>
      db.companyProduct.create({ data: { companyId: customer.id, locationId: location.id, itemId: item.id, quantity: 1, unitPrice: 1000, orderStatus: "APPROVED", addedByUserId: admin.id }, select: { id: true } });
    const { computeOrderFinancials } = await import("../src/lib/orders/financials");
    const orderTotal = computeOrderFinancials({ quantity: 1, unitPrice: 1000, item: { sellingPrice: 1000, taxRatePercent: 18 }, allocations: [] }).total;

    const o1 = await order();
    const tooMuch = await recordPayment({ companyId: customer.id, amount: orderTotal + 5000, paidOn: today, method: "BANK_TRANSFER", reference: `${TAG}-${RUN}-e`, allocateToOrderId: o1.id });
    ok(`a payment of ${orderTotal + 5000} recorded onto an order of ${orderTotal} is refused, naming what's owed`, !tooMuch.ok && /still outstanding/.test(errorOf(tooMuch)), tooMuch);
    const half = Math.round(orderTotal * 0.6);
    const onOrder = (ref: string) => recordPayment({ companyId: customer.id, amount: half, paidOn: today, method: "BANK_TRANSFER", reference: `${TAG}-${RUN}-${ref}`, allocateToOrderId: o1.id });
    const orderPays = await Promise.all([onOrder("f"), onOrder("g")]);
    const onO1 = await db.paymentAllocation.aggregate({ where: { companyProductId: o1.id }, _sum: { amount: true } });
    ok(
      `  two of ${half} at once onto it: one lands`,
      orderPays.filter((r) => r.ok).length === 1 && Number(onO1._sum.amount) === half,
      { results: orderPays, allocated: Number(onO1._sum.amount) },
    );

    const o2 = await order();
    const lump = await recordPayment({ companyId: customer.id, amount: 1000, paidOn: today, method: "BANK_TRANSFER", reference: `${TAG}-${RUN}-h` });
    if (!lump.ok) throw new Error(`payment on account: ${lump.error}`);
    const allocations = await Promise.all([
      allocatePayment({ paymentId: lump.data.id, companyProductId: o2.id, amount: 600 }),
      allocatePayment({ paymentId: lump.data.id, companyProductId: o2.id, amount: 600 }),
    ]);
    const fromLump = await db.paymentAllocation.aggregate({ where: { paymentId: lump.data.id }, _sum: { amount: true } });
    ok(
      "a 1,000 payment on account allocated twice at once, 600 each: it's spent once",
      allocations.filter((r) => r.ok).length === 1 && Number(fromLump._sum.amount) === 600,
      { results: allocations, allocated: Number(fromLump._sum.amount) },
    );

    // ── SEC-71 ─────────────────────────────────────────────────────────────────────────────────
    section("SEC-71: a series doesn't go back");
    const setting = await db.documentNumberSetting.findUnique({ where: { docType: "PROPOSAL" } });
    if (!setting || setting.scope !== "COMPANY") {
      ok("proposals aren't counted in the company series here (skipped)", true, setting?.scope ?? "no setting");
    } else {
      const headOffice = await db.branch.findFirst({ where: { isHeadOffice: true }, select: { code: true, gstRegistration: { select: { code: true } } } });
      const ctx = { branchCode: headOffice?.code ?? null, registrationCode: headOffice?.gstRegistration?.code ?? null };
      const ahead = setting.nextNumber + 10;
      await db.tradeDocument.create({
        data: { docNumber: buildDocumentNumber(setting.prefix, ahead, setting.padding, new Date(), ctx), docType: "PROPOSAL", direction: "SALES", status: "ISSUED", companyId: customer.id, createdById: admin.id, branchId, total: 1 },
      });
      const base = { docType: "PROPOSAL", mode: setting.mode, prefix: setting.prefix, padding: setting.padding };
      const back = await saveNumberSetting({ ...base, nextNumber: setting.nextNumber + 5 });
      ok(
        `a next number below one already used (${ahead}) is refused — even one that is itself free`,
        !back.ok && /only moves forward/.test(errorOf(back)),
        back,
      );
      const stillThere = await db.documentNumberSetting.findUnique({ where: { docType: "PROPOSAL" }, select: { nextNumber: true } });
      ok("  and the series is as it was", stillThere?.nextNumber === setting.nextNumber, stillThere);
      const forward = await saveNumberSetting({ ...base, nextNumber: ahead + 1 });
      ok("  one past it is saved", forward.ok, forward);
      // Put back what was there, unless something has numbered a proposal since.
      await db.documentNumberSetting.updateMany({ where: { docType: "PROPOSAL", nextNumber: ahead + 1 }, data: { nextNumber: setting.nextNumber } });
    }

    // ── SEC-41 ─────────────────────────────────────────────────────────────────────────────────
    section("SEC-41: the link between an order and an issued invoice; the statement's filename");
    const o3 = await order();
    const billed = await doc("INV-4", { docType: "INVOICE", total: 1000, taxableValue: 1000, lines: { create: [{ ...line, companyProductId: o3.id }] } });
    const billedLine = (await db.tradeDocumentLine.findFirst({ where: { documentId: billed.id }, select: { id: true } }))!;
    const clerk = await db.user.create({ data: { name: "ZZ A1 Clerk", email: `clerk-${RUN}@zza1.invalid`, passwordHash: "!", role: "ACCOUNTS" }, select: { id: true } });
    await db.userPermission.create({ data: { userId: clerk.id, permission: "docs.issueInvoice", allowed: false, reason: TAG } });
    actorId = clerk.id;
    const refused = await unlinkInvoiceLine(o3.id, billedLine.id);
    const stillLinked = await db.tradeDocumentLine.findUnique({ where: { id: billedLine.id }, select: { companyProductId: true } });
    ok("without \"Issue tax invoices\", taking an issued invoice's line off its order is refused", !refused.ok && stillLinked?.companyProductId === o3.id, { refused, stillLinked });
    await db.userPermission.deleteMany({ where: { userId: clerk.id } });
    const allowed = await unlinkInvoiceLine(o3.id, billedLine.id);
    ok("  the same person holding it: taken off", allowed.ok, allowed);
    await db.userPermission.create({ data: { userId: clerk.id, permission: "docs.issueInvoice", allowed: false, reason: TAG } });
    const relink = await linkInvoiceLine(o3.id, billedLine.id);
    ok("  and linking it back asks the same", !relink.ok, relink);
    actorId = admin.id;

    ok(
      "the statement's filename keeps only letters, digits and dashes, whatever it is handed",
      statementFilename("Acme \"Ltd\"", { from: '2026-01-01"; x="y', to: "2026-01-31\r\nSet-Cookie: a=b" }) === "Statement-Acme-Ltd-2026-01-01xy-to-2026-01-31Set-Cookieab.pdf",
      statementFilename("Acme \"Ltd\"", { from: '2026-01-01"; x="y', to: "2026-01-31\r\nSet-Cookie: a=b" }),
    );
    const { setTestPdfRenderer } = await import("../src/lib/documents/pdf");
    setTestPdfRenderer(async () => Buffer.from("%PDF-1.4 test"));
    const { GET } = await import("../src/app/api/statements/[side]/[companyId]/pdf/route");
    const res = await GET(new Request(`http://localhost/api/statements/AR/${customer.id}/pdf?from=${encodeURIComponent('2026-01-01"; filename="evil.exe')}&to=2026-01-31&show=all`), {
      params: Promise.resolve({ side: "AR", companyId: customer.id }),
    });
    const disposition = res.headers.get("content-disposition") ?? "";
    ok(
      "the statement PDF route leaves out a period that isn't a calendar day",
      res.status === 200 && disposition === `attachment; filename="Statement-ZZA1-Customer-start-to-2026-01-31.pdf"`,
      { status: res.status, disposition },
    );
    setTestPdfRenderer(null);
  } finally {
    actorId = admin.id;
    await cleanup();
    await db.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} audit-fix (A1) checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
