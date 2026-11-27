/**
 * Revaluing foreign balances, and foreign-currency (EEFC) bank accounts (owner, 30 Oct 2026 — src/lib/ledger/fx-revaluation.ts,
 * src/lib/finance/bank-currency.ts).
 *
 *   · The preview of a USD receivable, payable and EEFC balance: open in dollars, booked in rupees, at the closing rate.
 *   · Posting: one balanced entry on the day (party lines on AR / AP, the bank's own account, the net to Unrealised
 *     Exchange Gain / (Loss)), its reversal the next day, a typed rate kept as "typed", and the record.
 *   · Refused: a second run for the same day, a day inside closed books, an undo inside closed books.
 *   · Undo removes both entries and the record.
 *   · A USD receipt into the EEFC account posts at its own rate to that account's ledger account; a rupee one is refused;
 *     the account's reconciliation reads in dollars.
 *   · The trial balance still balances, and the close's receivables/payables tie-out still agrees on the revaluation's day.
 *
 * The dev database is shared and full, so everything here happens on days in June–July 2019, before any of its own
 * entries: a set-up check proves nothing foreign was open then, so every figure asserted is the fixture's. Never reaches
 * the network (the rate lookup is a stand-in). Removes exactly what it made, in a finally — including the book lock it
 * sets for a moment to 30 June 2019, and the 2019-20 journal counter if it made it.
 *
 *   npm run check:fx-revaluation
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "ADMIN", name: "Zzprobe Revalue" });
    return { requireUser: async () => user(), currentUser: async () => user(), viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_FXREVAL";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const noon = (s: string) => new Date(`${s}T12:00:00.000Z`);
const round2 = (n: number) => Math.round(n * 100) / 100;

const AS_OF = "2019-06-30";
const NEXT = "2019-07-01";

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fx = require("../src/lib/ledger/fx-revaluation") as typeof import("../src/lib/ledger/fx-revaluation");
  const rates = require("../src/lib/finance/rates") as typeof import("../src/lib/finance/rates");
  const journal = require("../src/lib/ledger/journal") as typeof import("../src/lib/ledger/journal");
  const record = require("../src/lib/receivables/record") as typeof import("../src/lib/receivables/record");
  const bankCurrency = require("../src/lib/finance/bank-currency") as typeof import("../src/lib/finance/bank-currency");
  const tieout = require("../src/lib/close/tieout") as typeof import("../src/lib/close/tieout");
  const { SYSTEM_ACCOUNTS } = require("../src/lib/ledger/chart") as typeof import("../src/lib/ledger/chart");
  /* eslint-enable @typescript-eslint/no-require-imports */

  rates.rateLookup.lookup = async () => ({ ok: false, reason: "offline in the check" });

  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!admin) throw new Error("no super admin to act as");
  actorId = admin.id;

  const made = {
    companies: [] as string[], documents: [] as string[], payments: [] as string[], rates: [] as string[],
    bank: null as string | null, ledgerAccount: null as string | null,
  };
  const lockBefore = await db.ledgerLock.findUnique({ where: { id: "global" } });
  const counterBefore = await db.journalCounter.findUnique({ where: { financialYear: "2019-20" } });
  const restoreLock = async () => {
    if (lockBefore) await db.ledgerLock.update({ where: { id: "global" }, data: { lockedUntil: lockBefore.lockedUntil, note: lockBefore.note } });
    else await db.ledgerLock.deleteMany({ where: { id: "global" } });
  };
  const lockTo = async (d: string) => {
    await db.ledgerLock.upsert({ where: { id: "global" }, create: { id: "global", lockedUntil: day(d), note: TAG }, update: { lockedUntil: day(d), note: TAG } });
  };

  try {
    section("Set-up");
    await journal.ensureChartOfAccounts();
    const unrealised = await db.ledgerAccount.findUnique({ where: { systemKey: SYSTEM_ACCOUNTS.FX_UNREALISED }, select: { id: true, code: true, type: true } });
    ok("the chart has Unrealised Exchange Gain / (Loss)", !!unrealised && unrealised.type === "INCOME", `${unrealised?.code}`);
    ok("the books aren't locked over the fixture's days", !lockBefore?.lockedUntil || lockBefore.lockedUntil < day(AS_OF), lockBefore?.lockedUntil?.toISOString());
    const baseline = await fx.foreignBalancesAt(AS_OF);
    ok("nothing foreign was open at the fixture's day before it", baseline.length === 0, `${baseline.length} balances`);
    ok("no revaluation stands at the fixture's day", (await db.fxRevaluation.count({ where: { asOf: day(AS_OF) } })) === 0);
    const usdRows = await db.exchangeRate.count({ where: { currency: "USD", day: { gte: day("2019-06-01"), lte: day("2019-07-31") } } });
    ok("no USD rates are kept for the fixture's days", usdRows === 0, `${usdRows}`);

    const head = await db.branch.findFirst({ where: { isHeadOffice: true }, select: { id: true } });
    const company = async (name: string, relationshipType: "CLIENT" | "VENDOR") => {
      const c = await db.company.create({
        data: { name: `${TAG} ${name}`, normalizedName: `${TAG} ${name}`.toLowerCase(), createdById: actorId, ownerUserId: actorId, relationshipType, stage: "CUSTOMER" },
        select: { id: true },
      });
      made.companies.push(c.id);
      return c.id;
    };
    const customer = await company("Customer Inc", "CLIENT");
    const vendor = await company("Vendor LLC", "VENDOR");

    const document = async (docType: "INVOICE" | "BILL", companyId: string, total: number, rate: number, issued: string) => {
      const d = await db.tradeDocument.create({
        data: {
          docNumber: `${TAG}-${docType}-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
          docType,
          direction: docType === "BILL" ? "PURCHASE" : "SALES",
          companyId,
          createdById: actorId,
          status: "ISSUED",
          issueDate: noon(issued),
          currency: "USD",
          exchangeRate: rate,
          taxableValue: total,
          total,
          ...(head ? { branchId: head.id } : {}),
        },
        select: { id: true },
      });
      made.documents.push(d.id);
      await db.$transaction((tx) => journal.postDocumentToLedger(tx, d.id, actorId));
      return d.id;
    };
    // $1,000 invoice at ₹83 (AR 83,000); $500 bill at ₹82 (AP 41,000).
    const invoice = await document("INVOICE", customer, 1000, 83, "2019-06-10");
    await document("BILL", vendor, 500, 82, "2019-06-12");

    section("An EEFC account");
    const ledger = await db.ledgerAccount.create({
      data: { code: `ZZ${Date.now().toString().slice(-8)}`, name: `${TAG} USD account`, type: "ASSET" },
      select: { id: true },
    });
    made.ledgerAccount = ledger.id;
    const bank = await db.bankAccount.create({ data: { name: `${TAG} EEFC USD`, ledgerAccountId: ledger.id, currency: "USD", isDefault: false } });
    made.bank = bank.id;
    ok("a rupee payment into it is refused", !!(await bankCurrency.bankCurrencyRefusal(bank.id, "INR")));
    ok("  a euro one too", !!(await bankCurrency.bankCurrencyRefusal(bank.id, "EUR")));
    ok("  a dollar one is welcome", (await bankCurrency.bankCurrencyRefusal(bank.id, "USD")) === null);
    ok("an account's currency reads back", (await bankCurrency.bankCurrencies([bank.id])).get(bank.id) === "USD");

    // $400 of the invoice received at ₹84 into the EEFC account: Dr EEFC 33,600 / Cr AR 33,600; FX gain 400 (Dr AR).
    const receipt = await db.$transaction((tx) =>
      record.recordPaymentOnInvoice(tx, {
        invoiceId: invoice, companyId: customer, branchId: head?.id ?? "", amount: 400, applied: 400, currency: "USD", rate: 84,
        paidOn: noon("2019-06-20"), method: "BANK_TRANSFER", reference: `${TAG}-R1`, notes: null, bankAccountId: bank.id, userId: actorId,
      }),
    );
    made.payments.push(receipt.id);
    const bankLines = await db.journalLine.findMany({ where: { accountId: ledger.id }, select: { debit: true, credit: true, entry: { select: { source: true, paymentId: true } } } });
    ok(
      "a USD receipt into it posts at its own rate to the account's ledger account",
      bankLines.length === 1 && Number(bankLines[0]!.debit) === 33600 && bankLines[0]!.entry.paymentId === receipt.id,
      JSON.stringify(bankLines.map((l) => [Number(l.debit), Number(l.credit)])),
    );
    const eefc = (await fx.foreignBankBalances(AS_OF)).find((b) => b.id === bank.id);
    ok("its balance is $400, booked ₹33,600", eefc?.foreign === 400 && eefc.booked === 33600, JSON.stringify(eefc));

    section("The preview");
    // The day's rate in the table, as a fetch would keep it: ₹84.50.
    await rates.storeRate({ currency: "USD", day: AS_OF, rate: 84.5, source: "fetched" });
    const keepRate = async (d: string) => {
      const row = await db.exchangeRate.findUnique({ where: { day_currency: { day: day(d), currency: "USD" } }, select: { id: true } });
      if (row && !made.rates.includes(row.id)) made.rates.push(row.id);
    };
    await keepRate(AS_OF);
    const p1 = await fx.previewRevaluation(AS_OF);
    const usd1 = p1.totals.currencies.find((c) => c.currency === "USD");
    ok("one currency, at the table's rate for the day", p1.totals.currencies.length === 1 && usd1?.rate === 84.5 && usd1.rateSource === "fetched" && usd1.rateDay === AS_OF, JSON.stringify(usd1 && { rate: usd1.rate, source: usd1.rateSource, day: usd1.rateDay }));
    ok("receivable: $600 open, ₹49,800 booked, ₹50,700 at ₹84.50", usd1?.receivables.foreign === 600 && usd1.receivables.booked === 49800 && usd1.receivables.revalued === 50700, JSON.stringify(usd1?.receivables));
    ok("payable: $500 open, ₹41,000 booked, ₹42,250 at ₹84.50", usd1?.payables.foreign === 500 && usd1.payables.booked === 41000 && usd1.payables.revalued === 42250, JSON.stringify(usd1?.payables));
    ok("bank: $400, ₹33,600 booked, ₹33,800 at ₹84.50", usd1?.bank.foreign === 400 && usd1.bank.booked === 33600 && usd1.bank.revalued === 33800, JSON.stringify(usd1?.bank));
    // 900 − 1,250 + 200
    ok("net: a ₹150 loss", usd1?.gain === -150 && p1.totals.gain === -150, `${p1.totals.gain}`);
    ok("  nothing missing, nothing posted, not locked", p1.missingRates.length === 0 && !p1.existingId && !p1.locked);

    const p2 = await fx.previewRevaluation(AS_OF, { USD: 85 });
    const usd2 = p2.totals.currencies[0];
    // 1,200 − 1,500 + 400
    ok("a rate typed over it: ₹85 → a ₹100 gain", usd2?.rate === 85 && usd2.rateSource === "entered" && p2.totals.gain === 100, `${usd2?.rate} ${p2.totals.gain}`);

    section("Posting");
    const posted = await fx.postRevaluation({ asOf: AS_OF, rates: { USD: 85 }, userId: actorId, today: "2026-10-31" });
    const row = await db.fxRevaluation.findUnique({ where: { id: posted.id } });
    ok("a record of it: the day, the rate, the net", !!row && row.asOf.toISOString().slice(0, 10) === AS_OF && (row.rates as Record<string, number>).USD === 85 && Number(row.net) === 100, JSON.stringify(row && { rates: row.rates, net: Number(row.net) }));
    const typed = await db.exchangeRate.findUnique({ where: { day_currency: { day: day(AS_OF), currency: "USD" } } });
    ok("the typed rate became the day's, as typed", typed?.source === "typed" && Number(typed.rate) === 85, `${typed?.source} ${typed?.rate}`);

    const entries = await db.journalEntry.findMany({
      where: { id: { in: [row!.entryId, row!.reversalEntryId] } },
      select: { id: true, date: true, source: true, reversesId: true, lines: { select: { accountId: true, debit: true, credit: true, companyId: true } } },
    });
    const entry = entries.find((e) => e.id === row!.entryId)!;
    const reversal = entries.find((e) => e.id === row!.reversalEntryId)!;
    const [ar, ap] = await Promise.all([
      db.ledgerAccount.findUnique({ where: { systemKey: SYSTEM_ACCOUNTS.AR }, select: { id: true } }),
      db.ledgerAccount.findUnique({ where: { systemKey: SYSTEM_ACCOUNTS.AP }, select: { id: true } }),
    ]);
    const line = (e: typeof entry, accountId: string | undefined) => e.lines.find((l) => l.accountId === accountId);
    const sum = (e: typeof entry, k: "debit" | "credit") => round2(e.lines.reduce((t, l) => t + Number(l[k]), 0));
    ok("the entry is on the day, under its own source", entry.date.toISOString() === noon(AS_OF).toISOString() && entry.source === "FX_REVALUATION");
    ok("  balanced: ₹1,600 each side", sum(entry, "debit") === 1600 && sum(entry, "credit") === 1600, `${sum(entry, "debit")} / ${sum(entry, "credit")}`);
    ok("  Dr Accounts Receivable ₹1,200, on the customer", Number(line(entry, ar?.id)?.debit) === 1200 && line(entry, ar?.id)?.companyId === customer);
    ok("  Cr Accounts Payable ₹1,500, on the vendor", Number(line(entry, ap?.id)?.credit) === 1500 && line(entry, ap?.id)?.companyId === vendor);
    ok("  Dr the EEFC account ₹400", Number(line(entry, ledger.id)?.debit) === 400);
    ok("  Cr Unrealised Exchange Gain / (Loss) ₹100", Number(line(entry, unrealised?.id)?.credit) === 100);
    ok("the reversal is the next day, every line the other way", reversal.date.toISOString() === noon(NEXT).toISOString() && reversal.reversesId === entry.id && sum(reversal, "debit") === 1600 && Number(line(reversal, unrealised?.id)?.debit) === 100 && Number(line(reversal, ar?.id)?.credit) === 1200);

    const p3 = await fx.previewRevaluation(AS_OF);
    ok("the preview says it is posted", p3.existingId === posted.id);
    ok("  and the EEFC balance is unchanged by it — the revaluation isn't a payment", (await fx.foreignBankBalances(AS_OF)).find((b) => b.id === bank.id)?.booked === 33600);

    section("Refusals");
    const refused = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return "";
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    };
    const twice = await refused(() => fx.postRevaluation({ asOf: AS_OF, rates: { USD: 85 }, userId: actorId, today: "2026-10-31" }));
    ok("a second run for the same day is refused", /already revalued/i.test(twice), twice);
    const future = await refused(() => fx.postRevaluation({ asOf: "2026-11-30", userId: actorId, today: "2026-10-31" }));
    ok("a day not over yet is refused", /has ended/i.test(future), future);

    await lockTo(AS_OF);
    const undoLocked = await refused(() => fx.undoRevaluation(posted.id));
    ok("undo inside closed books is refused", /closed/i.test(undoLocked), undoLocked);
    ok("  and the preview says the day is locked", (await fx.previewRevaluation(AS_OF)).locked);
    await restoreLock();

    section("Undo");
    await fx.undoRevaluation(posted.id);
    const left = await db.journalEntry.count({ where: { id: { in: [row!.entryId, row!.reversalEntryId] } } });
    ok("both entries are gone, and the record", left === 0 && (await db.fxRevaluation.count({ where: { id: posted.id } })) === 0, `${left} entries left`);

    await lockTo(AS_OF);
    const intoLocked = await refused(() => fx.postRevaluation({ asOf: AS_OF, rates: { USD: 85 }, userId: actorId, today: "2026-10-31" }));
    ok("posting into closed books is refused", /closed/i.test(intoLocked), intoLocked);
    await restoreLock();

    section("Posted again; the books still agree");
    const again = await fx.postRevaluation({ asOf: AS_OF, rates: { USD: 85 }, userId: actorId, today: "2026-10-31" });
    ok("posted again once undone", again.net === 100, `${again.net}`);
    const all = await db.journalLine.aggregate({ _sum: { debit: true, credit: true } });
    ok("the trial balance balances", round2(Number(all._sum.debit ?? 0)) === round2(Number(all._sum.credit ?? 0)), `${all._sum.debit} / ${all._sum.credit}`);
    const june = new Date(Date.UTC(2019, 5, 1));
    const [arTie, apTie] = await Promise.all([tieout.tieOutAt("AR", june), tieout.tieOutAt("AP", june)]);
    ok("the receivables tie-out still agrees at 30 June (the revaluation set aside)", arTie.ok && arTie.detail.difference === 0, `${arTie.detail.ageing} vs ${arTie.detail.ledger}`);
    ok("  and the payables one", apTie.ok && apTie.detail.difference === 0, `${apTie.detail.ageing} vs ${apTie.detail.ledger}`);
    const arAtJune = await db.journalLine.aggregate({ where: { accountId: ar!.id, companyId: customer, entry: { date: { lt: new Date("2019-06-30T18:30:00.000Z") } } }, _sum: { debit: true, credit: true } });
    ok("the customer's receivable at 30 June is $600 at ₹85", round2(Number(arAtJune._sum.debit) - Number(arAtJune._sum.credit)) === 51000, `${Number(arAtJune._sum.debit) - Number(arAtJune._sum.credit)}`);
    const arAfter = await db.journalLine.aggregate({ where: { accountId: ar!.id, companyId: customer }, _sum: { debit: true, credit: true } });
    ok("  and back at its booked ₹49,800 from 1 July", round2(Number(arAfter._sum.debit) - Number(arAfter._sum.credit)) === 49800, `${Number(arAfter._sum.debit) - Number(arAfter._sum.credit)}`);

    // The rest of the invoice received on 10 July at ₹86: the realised gain is against the booked ₹83 — $600 × 3 =
    // ₹1,800 — not against the revaluation's ₹85. With the reversal, ₹100 + ₹1,800 … only the ₹1,800 stands after July.
    const rest = await db.$transaction((tx) =>
      record.recordPaymentOnInvoice(tx, {
        invoiceId: invoice, companyId: customer, branchId: head?.id ?? "", amount: 600, applied: 600, currency: "USD", rate: 86,
        paidOn: noon("2019-07-10"), method: "BANK_TRANSFER", reference: `${TAG}-R2`, notes: null, bankAccountId: bank.id, userId: actorId,
      }),
    );
    made.payments.push(rest.id);
    const realised = await db.journalLine.aggregate({
      where: { account: { systemKey: SYSTEM_ACCOUNTS.FX_GAIN_LOSS }, entry: { paymentId: rest.id, source: "FX" } },
      _sum: { credit: true, debit: true },
    });
    ok("settling later books the realised gain against the booked rate: ₹1,800", round2(Number(realised._sum.credit ?? 0) - Number(realised._sum.debit ?? 0)) === 1800);
    const arDone = await db.journalLine.aggregate({ where: { accountId: ar!.id, companyId: customer }, _sum: { debit: true, credit: true } });
    ok("  and the customer's receivable is nil — nothing counted twice", round2(Number(arDone._sum.debit) - Number(arDone._sum.credit)) === 0);
    const unrealisedNet = await db.journalLine.aggregate({ where: { accountId: unrealised!.id, entry: { source: "FX_REVALUATION", date: { gte: noon(AS_OF), lte: noon(NEXT) } } }, _sum: { debit: true, credit: true } });
    ok("  the unrealised figure nets to nil across the two days", round2(Number(unrealisedNet._sum.credit ?? 0) - Number(unrealisedNet._sum.debit ?? 0)) === 0);

    section("Reconciling the EEFC account");
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const bankActions = require("../src/actions/bank") as typeof import("../src/actions/bank");
      const view = await bankActions.reconciliationView({ bankAccountId: bank.id, to: "2019-07-31" });
      ok(
        "its book side is in dollars, payments only (the revaluation has no dollar amount)",
        !!view && view.account.currency === "USD" && view.book.length === 2 && view.book.map((b) => b.amount).sort((a, b) => a - b).join(",") === "400,600",
        JSON.stringify(view?.book.map((b) => b.amount)),
      );
      ok("  its book balance is $1,000", view?.summary.bookBalance === 1000, `${view?.summary.bookBalance}`);
      const refusedBase = await bankActions.setDefaultBankAccount(bank.id);
      ok("a foreign account can't be made the default", !refusedBase.ok, refusedBase.ok ? "" : refusedBase.error);
      const toInr = await bankActions.saveBankAccount({ id: bank.id, name: `${TAG} EEFC USD`, currency: "" });
      ok("  nor switched to rupees once it holds dollar payments", !toInr.ok, toInr.ok ? "" : toInr.error);
    } catch (e) {
      ok("the bank actions ran", false, e instanceof Error ? e.message : String(e));
    }
  } finally {
    await restoreLock().catch(() => {});
    const revaluations = await db.fxRevaluation.findMany({ where: { asOf: { gte: day("2019-06-01"), lte: day("2019-07-31") } } });
    for (const r of revaluations) {
      await db.journalEntry.deleteMany({ where: { id: r.reversalEntryId } });
      await db.journalEntry.deleteMany({ where: { id: r.entryId } });
      await db.fxRevaluation.delete({ where: { id: r.id } });
    }
    const mine = { OR: [{ documentId: { in: made.documents } }, { paymentId: { in: made.payments } }] };
    await db.journalEntry.deleteMany({ where: { AND: [mine, { reversesId: { not: null } }] } });
    await db.journalEntry.deleteMany({ where: mine });
    await db.paymentAllocation.deleteMany({ where: { paymentId: { in: made.payments } } });
    await db.auditLog.deleteMany({ where: { entityId: { in: [...made.payments, ...made.documents] } } }).catch(() => {});
    await db.payment.deleteMany({ where: { id: { in: made.payments } } });
    await db.tradeDocument.deleteMany({ where: { id: { in: made.documents } } });
    await db.company.deleteMany({ where: { id: { in: made.companies } } });
    if (made.bank) await db.bankAccount.delete({ where: { id: made.bank } }).catch(() => {});
    if (made.ledgerAccount) await db.ledgerAccount.delete({ where: { id: made.ledgerAccount } }).catch(() => {});
    await db.exchangeRate.deleteMany({ where: { OR: [{ id: { in: made.rates } }, { currency: "USD", day: { gte: day("2019-06-01"), lte: day("2019-07-31") } }] } });
    if (!counterBefore) await db.journalCounter.deleteMany({ where: { financialYear: "2019-20" } });
    const leftover =
      (await db.company.count({ where: { name: { startsWith: TAG } } })) +
      (await db.journalEntry.count({ where: { date: { gte: day("2019-06-01"), lt: day("2019-08-01") } } })) +
      (await db.bankAccount.count({ where: { name: { startsWith: TAG } } }));
    ok("the fixture cleaned up after itself", leftover === 0, `${leftover} left behind`);
  }
}

main()
  .then(async () => {
    await db.$disconnect();
    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} failed.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error);
    await db.$disconnect();
    process.exit(1);
  });
