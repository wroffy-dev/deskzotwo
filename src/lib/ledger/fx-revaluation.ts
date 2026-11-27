import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { baseCurrency, getCurrency, isBaseCurrency } from "@/lib/currency";
import { indiaClock } from "@/lib/time/zone";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/chart";
import { bookingRate, isBalanced, reverseLines, settlementRateError, type DraftLine } from "@/lib/ledger/posting";
import { isLockedDate } from "@/lib/ledger/period";
import { lockPosting, resolveAccounts, writeEntry } from "@/lib/ledger/journal";
import { openInRupees, subledgerAt, type TieOutDocument } from "@/lib/close/tieout";
import { dayDate, foreignCurrency, rateFor, storeRate, type KnownRate } from "@/lib/finance/rates";

/**
 * Revaluing foreign balances at a period end (owner, 30 Oct 2026 — AS 11 / Ind AS 21, Zoho Books' "Revalue currency").
 *
 * ## What it does
 *
 * Monetary items in a foreign currency still open at a day — invoices and debit notes not yet paid, credit notes not
 * yet used, bills not yet paid, and the balance of a foreign-currency (EEFC) bank account — are restated at that
 * day's closing rate (`rateFor`, or a rate typed over it, which is kept in the rate table as "typed"). The difference
 * from what the books hold for them is an *unrealised* exchange gain or loss:
 *
 *     Dr/Cr  Accounts Receivable   (per customer — a party line, as every receivable line is)
 *     Dr/Cr  Accounts Payable      (per vendor)
 *     Dr/Cr  <the bank's own ledger account>
 *         Cr/Dr  Unrealised Exchange Gain / (Loss)   (the net)
 *
 * dated the day itself, and the same entry reversed, dated the next day.
 *
 * ## Why the reversal the next day
 *
 * A receipt or payment that settles one of these later books its *realised* difference against the rate the
 * document was raised at (posting.ts `settlementDifference`), not against the closing rate. Left standing, the
 * revaluation and that realised figure would count the same movement twice: $1,000 booked at ₹83, revalued at ₹84
 * (+₹1,000 unrealised), received at ₹85 (+₹2,000 realised) — ₹3,000 of gain on a ₹2,000 movement. Reversed the next
 * day, the unrealised ₹1,000 comes back out of the new period and the realised ₹2,000 stands alone: the balance sheet
 * at the period end is at the closing rate, and the P&L over time sees the true ₹2,000 once.
 *
 * ## What "booked" is
 *
 * The receivables and payables are measured as the close's tie-out measures them (`subledgerAt`, src/lib/close/tieout.ts):
 * each document at the rate its posting used, what was set against it by the day at that rate too. A foreign bank
 * account's is its payments' — each in at the rate it came in at — by the day: an uncleared cheque is not in the bank,
 * and cash never is. That is what the ledger holds for them, so the entry brings each to exactly foreign × closing rate.
 *
 * Not revalued: payments not set against anything (an advance is not a monetary item under Ind AS 21 — money on
 * account usually is a customer's prepayment for goods), a bank account's opening balance or transfers not recorded
 * as payments (they have no foreign amount), and any non-monetary item.
 */

type Tx = Prisma.TransactionClient;

const round2 = (n: number) => Math.round(n * 100) / 100;

export type RevaluationKind = "RECEIVABLE" | "PAYABLE" | "BANK";

/** One open foreign balance, as the books hold it. */
export type ForeignBalance = {
  kind: RevaluationKind;
  /** The document's, or the bank account's id. */
  id: string;
  label: string;
  /** The party, on a receivable or payable. */
  companyId: string | null;
  party: string | null;
  /** The bank account's ledger account. */
  ledgerAccountId: string | null;
  currency: string;
  /** Open, in its own currency: + is owed to us (receivable), owed by us (payable), or in the bank. */
  foreign: number;
  /** What the books hold for it, base, the same sign. */
  booked: number;
};

/** A balance restated at a rate: `gain` positive is a gain, whichever side it is on. */
export type RevaluedBalance = ForeignBalance & { rate: number; revalued: number; gain: number };

export type CurrencySummary = {
  currency: string;
  rate: number | null;
  /** Where the rate came from: the table (its day and source), typed here, or none. */
  rateDay: string | null;
  rateSource: KnownRate["source"] | "entered" | null;
  receivables: { foreign: number; booked: number; revalued: number };
  payables: { foreign: number; booked: number; revalued: number };
  bank: { foreign: number; booked: number; revalued: number };
  gain: number;
};

export type RevaluationTotals = { currencies: CurrencySummary[]; gain: number };

// ─── Pure ──────────────────────────────────────────────────────────────────────────────────────

/** An open foreign document's balance — what `subledgerAt` read — or null when nothing foreign is open on it. */
export function documentBalance(doc: TieOutDocument): ForeignBalance | null {
  if (isBaseCurrency(doc.currency) || doc.docType === "VENDOR_CREDIT") return null;
  // In its own currency, as `openInRupees` is in base: a credit note not yet used takes the receivable down.
  const foreign =
    doc.docType === "CREDIT_NOTE" ? -round2(doc.total - doc.applied) : round2(doc.total - doc.allocated - doc.credited);
  if (Math.abs(foreign) < 0.005) return null;
  return {
    kind: doc.docType === "BILL" ? "PAYABLE" : "RECEIVABLE",
    id: doc.id,
    label: doc.docNumber,
    companyId: doc.companyId,
    party: doc.companyName,
    ledgerAccountId: null,
    currency: doc.currency,
    foreign,
    booked: openInRupees(doc),
  };
}

/** Each balance at its currency's rate. A balance in a currency with no rate is left out — `missingRates` says which. */
export function revalue(balances: ForeignBalance[], rates: Record<string, number>): RevaluedBalance[] {
  const out: RevaluedBalance[] = [];
  for (const b of balances) {
    const rate = rates[b.currency];
    if (!(rate > 0)) continue;
    // Rounded as every conversion here is (`toBase`): foreign × rate to the paisa.
    const revalued = round2(b.foreign * rate);
    // An asset worth more is a gain; a liability worth more is a loss.
    const gain = b.kind === "PAYABLE" ? round2(b.booked - revalued) : round2(revalued - b.booked);
    out.push({ ...b, rate, revalued, gain });
  }
  return out;
}

export function missingRates(balances: ForeignBalance[], rates: Record<string, number>): string[] {
  return [...new Set(balances.map((b) => b.currency))].filter((c) => !(rates[c] > 0)).sort();
}

/** The figures per currency and in all. */
export function summarise(
  balances: ForeignBalance[],
  revalued: RevaluedBalance[],
  rates: Record<string, { rate: number | null; day: string | null; source: CurrencySummary["rateSource"] }>,
): RevaluationTotals {
  const byCurrency = new Map<string, CurrencySummary>();
  const zero = () => ({ foreign: 0, booked: 0, revalued: 0 });
  const summaryOf = (currency: string) => {
    let s = byCurrency.get(currency);
    if (!s) {
      const r = rates[currency];
      s = { currency, rate: r?.rate ?? null, rateDay: r?.day ?? null, rateSource: r?.source ?? null, receivables: zero(), payables: zero(), bank: zero(), gain: 0 };
      byCurrency.set(currency, s);
    }
    return s;
  };
  const bucket = (s: CurrencySummary, kind: RevaluationKind) => (kind === "RECEIVABLE" ? s.receivables : kind === "PAYABLE" ? s.payables : s.bank);
  for (const b of balances) {
    const t = bucket(summaryOf(b.currency), b.kind);
    t.foreign = round2(t.foreign + b.foreign);
    t.booked = round2(t.booked + b.booked);
  }
  let gain = 0;
  for (const r of revalued) {
    const s = summaryOf(r.currency);
    const t = bucket(s, r.kind);
    t.revalued = round2(t.revalued + r.revalued);
    s.gain = round2(s.gain + r.gain);
    gain = round2(gain + r.gain);
  }
  return { currencies: [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency)), gain };
}

/**
 * The revaluation entry's lines. One party line per customer (vendor) — the sum over their documents — so the
 * receivable stays broken down by party as every other receivable line is; one line per bank account, on its own
 * ledger account; and the net to Unrealised Exchange Gain / (Loss) on the other side.
 */
export function revaluationLines(revalued: RevaluedBalance[]): DraftLine[] {
  const lines: DraftLine[] = [];
  const parties = new Map<string, { kind: RevaluationKind; companyId: string; gain: number }>();
  for (const r of revalued) {
    if (r.kind === "BANK") {
      // An asset: a gain debits it.
      if (r.gain !== 0) {
        lines.push({
          account: SYSTEM_ACCOUNTS.BANK,
          accountIdOverride: r.ledgerAccountId,
          debit: r.gain > 0 ? r.gain : 0,
          credit: r.gain < 0 ? -r.gain : 0,
          narration: `${r.label}: ${r.currency} ${r.foreign.toFixed(getCurrency(r.currency).decimals)} at ${r.rate}`,
        });
      }
      continue;
    }
    const key = `${r.kind}:${r.companyId}`;
    const row = parties.get(key) ?? { kind: r.kind, companyId: r.companyId!, gain: 0 };
    row.gain = round2(row.gain + r.gain);
    parties.set(key, row);
  }
  for (const p of parties.values()) {
    if (p.gain === 0) continue;
    // A receivable is an asset (a gain debits it); a payable a liability (a gain debits it too — we owe less).
    lines.push({
      account: p.kind === "RECEIVABLE" ? SYSTEM_ACCOUNTS.AR : SYSTEM_ACCOUNTS.AP,
      debit: p.gain > 0 ? p.gain : 0,
      credit: p.gain < 0 ? -p.gain : 0,
      companyId: p.companyId,
    });
  }
  const net = round2(revalued.reduce((t, r) => t + r.gain, 0));
  if (net !== 0) {
    lines.push({
      account: SYSTEM_ACCOUNTS.FX_UNREALISED,
      debit: net < 0 ? -net : 0,
      credit: net > 0 ? net : 0,
      narration: net > 0 ? "Unrealised exchange gain" : "Unrealised exchange loss",
    });
  }
  return lines.map((l) => ({ ...l, debit: round2(l.debit), credit: round2(l.credit) }));
}

// ─── Reading what is open ──────────────────────────────────────────────────────────────────────

/** Whether this workspace has the revaluation table and the bank account's currency yet. */
export async function revaluationHere(): Promise<boolean> {
  try {
    await db.fxRevaluation.findFirst({ select: { id: true } });
    await db.bankAccount.findFirst({ select: { currency: true } });
    return true;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
}

function isDay(day: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && indiaClock.startOfDay(day) !== null;
}

/** The day after `day`, yyyy-mm-dd. */
export function nextDay(day: string): string {
  return new Date(dayDate(day).getTime() + 86_400_000).toISOString().slice(0, 10);
}

/** Where a day's entry goes: 12:00 UTC, which is that calendar day whichever clock reads it (as payroll's). */
export function entryDateOf(day: string): Date {
  return new Date(`${day}T12:00:00.000Z`);
}

/**
 * A foreign-currency bank account's balance at the end of a day, in its own currency and as the books hold it.
 * Its payments only: received in, paid out; a cheque once cleared by the day (until then it sits in cheques in
 * hand, not the bank), and never a cash payment (resolveMoneyAccount puts those in cash whatever account they name).
 */
export async function foreignBankBalances(asOf: string): Promise<ForeignBalance[]> {
  const to = indiaClock.endOfDay(asOf);
  if (!to) return [];
  const accounts = await db.bankAccount.findMany({
    where: { currency: { not: null } },
    select: { id: true, name: true, currency: true, ledgerAccountId: true },
  });
  const foreignAccounts = accounts.filter((a) => foreignCurrency(a.currency));
  if (foreignAccounts.length === 0) return [];
  const payments = await db.payment.findMany({
    where: {
      bankAccountId: { in: foreignAccounts.map((a) => a.id) },
      paidOn: { lt: to },
      method: { not: "CASH" },
      OR: [{ method: { not: "CHEQUE" } }, { clearedOn: { lte: dayDate(asOf) } }],
    },
    select: { bankAccountId: true, direction: true, amount: true, currency: true, exchangeRate: true },
  });
  return foreignAccounts.map((a) => {
    let foreign = 0;
    let booked = 0;
    for (const p of payments) {
      // Only its own currency: the account refuses any other (src/lib/finance/bank-currency.ts).
      if (p.bankAccountId !== a.id || p.currency !== a.currency) continue;
      const sign = p.direction === "PAID" ? -1 : 1;
      foreign = round2(foreign + sign * Number(p.amount));
      // As its posting converted it (postPaymentToLedger).
      booked = round2(booked + sign * round2(Number(p.amount) * bookingRate(p)));
    }
    return {
      kind: "BANK" as const,
      id: a.id,
      label: a.name,
      companyId: null,
      party: null,
      ledgerAccountId: a.ledgerAccountId,
      currency: a.currency!,
      foreign,
      booked,
    };
  }).filter((b) => Math.abs(b.foreign) >= 0.005 || Math.abs(b.booked) >= 0.005);
}

/** Every open foreign balance at the end of `asOf`: receivables, payables and foreign bank accounts. */
export async function foreignBalancesAt(asOf: string): Promise<ForeignBalance[]> {
  const to = indiaClock.endOfDay(asOf);
  if (!to) throw new Error(`Not a day: ${asOf}`);
  const foreignOnly: Prisma.TradeDocumentWhereInput = { currency: { not: baseCurrency() } };
  // Payments are read only to compute unapplied money, which isn't revalued — an empty list skips them.
  const scope = { documents: foreignOnly, payments: { id: { in: [] as string[] } } };
  const [ar, ap, bank] = await Promise.all([subledgerAt("AR", to, scope), subledgerAt("AP", to, { ...scope, vendors: { id: { in: [] } } }), foreignBankBalances(asOf)]);
  const documents = [...ar.documents, ...ap.documents].map(documentBalance).filter((b): b is ForeignBalance => b !== null);
  return [...documents, ...bank];
}

// ─── The preview, and posting it ───────────────────────────────────────────────────────────────

export type RevaluationPreview = {
  asOf: string;
  /** Closed to a day on or after this one: nothing can be posted. */
  locked: boolean;
  /** Already revalued on this day. */
  existingId: string | null;
  balances: RevaluedBalance[];
  totals: RevaluationTotals;
  missingRates: string[];
};

/**
 * The closing rate per currency: one typed here wins, else the rate table's for the day (or the latest within a
 * week, looked up and kept when there is none — `rateFor`).
 */
async function ratesFor(currencies: string[], asOf: string, typed: Record<string, number>, opts: { fetch?: boolean }) {
  const out: Record<string, { rate: number | null; day: string | null; source: CurrencySummary["rateSource"] }> = {};
  for (const c of currencies) {
    const given = typed[c];
    if (given !== undefined && Number.isFinite(given) && given > 0) {
      out[c] = { rate: given, day: asOf, source: "entered" };
      continue;
    }
    const known = await rateFor(c, asOf, opts);
    out[c] = known ? { rate: known.rate, day: known.day, source: known.source } : { rate: null, day: null, source: null };
  }
  return out;
}

export async function previewRevaluation(asOf: string, typed: Record<string, number> = {}, opts: { fetch?: boolean } = {}): Promise<RevaluationPreview> {
  if (!isDay(asOf)) throw new Error("Pick the day to revalue at.");
  const balances = await foreignBalancesAt(asOf);
  const currencies = [...new Set([...balances.map((b) => b.currency), ...Object.keys(typed).filter(foreignCurrency)])].sort();
  const known = await ratesFor(currencies, asOf, typed, opts);
  const rates = Object.fromEntries(Object.entries(known).filter(([, r]) => r.rate !== null).map(([c, r]) => [c, r.rate!]));
  const revalued = revalue(balances, rates);
  const [lock, existing] = await Promise.all([
    db.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } }),
    db.fxRevaluation.findUnique({ where: { asOf: dayDate(asOf) }, select: { id: true } }),
  ]);
  return {
    asOf,
    locked: isLockedDate(entryDateOf(asOf), lock?.lockedUntil),
    existingId: existing?.id ?? null,
    balances: revalued,
    totals: summarise(balances, revalued, known),
    missingRates: missingRates(balances, rates),
  };
}

/**
 * Posts a revaluation: the entry on `asOf`, its reversal the next day, and the record that ties them together — in
 * one transaction. A rate given in `rates` that differs from the table's for the day is kept there as "typed".
 */
export async function postRevaluation(input: { asOf: string; rates?: Record<string, number>; userId: string; today?: string }) {
  const asOf = input.asOf;
  if (!isDay(asOf)) throw new Error("Pick the day to revalue at.");
  const today = input.today ?? indiaClock.today();
  if (asOf > today) throw new Error("A revaluation is at a day that has ended — pick today or earlier.");
  const typed: Record<string, number> = {};
  for (const [currency, rate] of Object.entries(input.rates ?? {})) {
    if (!foreignCurrency(currency)) continue;
    const error = settlementRateError(Number(rate));
    if (error) throw new Error(`${currency}: ${error}`);
    typed[currency] = Number(rate);
  }

  const preview = await previewRevaluation(asOf, typed);
  if (preview.locked) throw new Error(`The books are closed to ${asOf} or later — a revaluation can't be posted into a closed period.`);
  if (preview.existingId) throw new Error(`Foreign balances were already revalued at ${asOf}. Undo that one first to post it again.`);
  if (preview.missingRates.length > 0) throw new Error(`Enter the closing rate for ${preview.missingRates.join(", ")}.`);
  const lines = revaluationLines(preview.balances);
  if (lines.length < 2 || !isBalanced(lines)) throw new Error("Nothing to revalue: every foreign balance is already at the closing rate.");

  // Typed figures become the day's rate (a fetch never overwrites them) — only those that differ from what the
  // table would have answered, so a rate merely accepted keeps its own source.
  for (const [currency, rate] of Object.entries(typed)) {
    const known = await rateFor(currency, asOf, { fetch: false });
    if (!known || known.day !== asOf || Math.abs(known.rate - rate) > 1e-9) {
      await storeRate({ currency, day: asOf, rate, source: "typed", setById: input.userId });
    }
  }

  const rates = Object.fromEntries(preview.totals.currencies.filter((c) => c.rate !== null).map((c) => [c.currency, c.rate]));
  return db.$transaction(async (tx: Tx) => {
    await lockPosting(tx, `fx-revaluation:${asOf}`);
    const already = await tx.fxRevaluation.findUnique({ where: { asOf: dayDate(asOf) }, select: { id: true } });
    if (already) throw new Error(`Foreign balances were already revalued at ${asOf}.`);
    const keys = [...new Set(lines.filter((l) => !l.accountIdOverride).map((l) => l.account))];
    const accounts = await resolveAccounts(tx, keys);
    const rows = lines.map((l) => ({
      accountId: l.accountIdOverride ?? accounts.get(l.account)!,
      debit: l.debit,
      credit: l.credit,
      companyId: l.companyId ?? null,
      narration: l.narration ?? null,
    }));
    const narration = `Foreign balances revalued at ${asOf} closing rates (${Object.entries(rates).map(([c, r]) => `${c} ${r}`).join(", ")})`;
    const entry = await writeEntry(tx, { date: entryDateOf(asOf), narration, source: "FX_REVALUATION", userId: input.userId, lines: rows });
    // The next day, the same lines the other way — see the top of this file for why.
    const reversal = await writeEntry(tx, {
      date: entryDateOf(nextDay(asOf)),
      narration: `Reversal of ${entry.entryNumber} — the ${asOf} revaluation, reversed the next day`,
      source: "FX_REVALUATION",
      userId: input.userId,
      lines: reverseLines(rows),
      reversesId: entry.id,
    });
    const record = await tx.fxRevaluation.create({
      data: {
        asOf: dayDate(asOf),
        rates: rates as Prisma.InputJsonValue,
        totals: preview.totals as unknown as Prisma.InputJsonValue,
        net: new Prisma.Decimal(preview.totals.gain.toFixed(2)),
        entryId: entry.id,
        reversalEntryId: reversal.id,
        postedById: input.userId,
      },
      select: { id: true },
    });
    return { id: record.id, net: preview.totals.gain, entryNumber: entry.entryNumber, reversalNumber: reversal.entryNumber };
  });
}

/**
 * Undoes a revaluation while its day is open: both entries deleted, then the record. Deleted rather than reversed
 * (owner, 30 Oct 2026): the pair already nets to nil from the next day, and a third and fourth entry to cancel two
 * that cancel each other would only clutter the journal. A closed day keeps it — reopen the period first.
 */
export async function undoRevaluation(id: string): Promise<{ asOf: string }> {
  return db.$transaction(async (tx: Tx) => {
    const row = await tx.fxRevaluation.findUnique({ where: { id }, select: { id: true, asOf: true, entryId: true, reversalEntryId: true } });
    if (!row) throw new Error("That revaluation no longer exists.");
    const asOf = row.asOf.toISOString().slice(0, 10);
    await lockPosting(tx, `fx-revaluation:${asOf}`);
    const lock = await tx.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } });
    if (isLockedDate(entryDateOf(asOf), lock?.lockedUntil)) {
      throw new Error(`The books are closed to ${lock!.lockedUntil!.toISOString().slice(0, 10)}, which takes in ${asOf}. Reopen the period to undo it.`);
    }
    // The reversal first: it points at the original.
    await tx.journalEntry.deleteMany({ where: { id: row.reversalEntryId, source: "FX_REVALUATION" } });
    await tx.journalEntry.deleteMany({ where: { id: row.entryId, source: "FX_REVALUATION" } });
    await tx.fxRevaluation.delete({ where: { id: row.id } });
    return { asOf };
  });
}

export async function listRevaluations() {
  const rows = await db.fxRevaluation.findMany({ orderBy: { asOf: "desc" }, take: 100 });
  const ids = rows.flatMap((r) => [r.entryId, r.reversalEntryId, r.postedById]);
  const [entries, users] = await Promise.all([
    db.journalEntry.findMany({ where: { id: { in: ids } }, select: { id: true, entryNumber: true } }),
    db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
  ]);
  const numberOf = new Map(entries.map((e) => [e.id, e.entryNumber]));
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  const lock = await db.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } });
  return rows.map((r) => {
    const asOf = r.asOf.toISOString().slice(0, 10);
    return {
      id: r.id,
      asOf,
      rates: r.rates as Record<string, number>,
      net: Number(r.net),
      entryNumber: numberOf.get(r.entryId) ?? null,
      reversalNumber: numberOf.get(r.reversalEntryId) ?? null,
      postedBy: nameOf.get(r.postedById) ?? null,
      postedAt: r.postedAt,
      locked: isLockedDate(entryDateOf(asOf), lock?.lockedUntil),
    };
  });
}
