"use server";

import { revalidatePath } from "next/cache";
import { plainError } from "@/lib/plain-error";
import { isIfsc, normaliseIfsc } from "@/lib/ifsc";
import { db } from "@/lib/db";
import { requireModuleAccess } from "@/lib/modules-access";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { hasEffectivePermission } from "@/actions/permission";
import { mayAccess, paymentAccess } from "@/lib/authz/access";
import { ensureChartOfAccounts, postChequeClearingToLedger } from "@/lib/ledger/journal";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/chart";
import { indiaClock } from "@/lib/time/zone";
import {
  parseStatementCsv,
  reconcile,
  statementFingerprint,
  suggestMatches,
  type BookRow,
  type StatementRow,
} from "@/lib/ledger/reconcile";
import type { ActionResult } from "@/actions/company";
import { clipOrNull, TEXT_MAX } from "@/lib/text/bounded";
import { bankCurrencies, bankCurrencyRefusal, bankCurrencyValue } from "@/lib/finance/bank-currency";
import { foreignBankBalances } from "@/lib/ledger/fx-revaluation";
import { notMigratedYet } from "@/lib/not-migrated";
import { baseCurrency } from "@/lib/currency";

/**
 * Bank accounts, statements, and agreeing the two.
 *
 * The thing this module exists to fix: a single "Bank" account in the chart cannot answer "how much
 * is in the current account", and a book balance that includes cheques nobody has banked will never
 * agree with a statement. Both are handled by giving each real account its own ledger account and
 * keeping uncleared cheques somewhere else until they clear.
 */

async function requireAccounts() {
  const user = await requireModuleAccess("accounting");
  return { user, allowed: await hasEffectivePermission(user.id, "payments.manage") };
}

// ─── Accounts ─────────────────────────────────────────────────────────────────

// The reads take the same "Manage finance records" as the writes: bank balances and the cheques
// waiting to clear are the finance function's, not everybody's with the ledger in the plan.
export async function listBankAccounts() {
  if (!(await requireAccounts()).allowed) return [];
  const rows = await db.bankAccount.findMany({
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    include: { ledgerAccount: { select: { id: true, code: true, name: true } } },
  });
  // Each account's balance today (owner, 30 Oct 2026): what its ledger account holds, in base; and a foreign
  // account's in its own currency too — its payments' amounts (src/lib/ledger/fx-revaluation.ts).
  const [currencies, sums, foreign] = await Promise.all([
    bankCurrencies(rows.map((r) => r.id)),
    db.journalLine.groupBy({ by: ["accountId"], where: { accountId: { in: rows.map((r) => r.ledgerAccountId) } }, _sum: { debit: true, credit: true } }),
    foreignBankBalances(indiaClock.today()).catch((err) => {
      if (notMigratedYet(err)) return [];
      throw err;
    }),
  ]);
  return toPlain(
    rows.map((r) => {
      const sum = sums.find((s) => s.accountId === r.ledgerAccountId);
      const own = foreign.find((f) => f.id === r.id);
      return {
        ...r,
        currency: currencies.get(r.id) ?? null,
        balance: Math.round((Number(sum?._sum.debit ?? 0) - Number(sum?._sum.credit ?? 0)) * 100) / 100,
        foreignBalance: currencies.get(r.id) ? (own?.foreign ?? 0) : null,
      };
    }),
  );
}

/**
 * Adds a bank account, and the ledger account behind it.
 *
 * The first one adopts the existing "Bank Accounts" account rather than creating a sibling, so a
 * business that has been posting to it for a year keeps its history in one place instead of
 * splitting it across two accounts with almost the same name.
 */
export async function saveBankAccount(input: {
  id?: string;
  name: string;
  bankName?: string;
  accountNumber?: string;
  ifsc?: string;
  branch?: string;
  isDefault?: boolean;
  /** An EEFC account's currency (owner, 30 Oct 2026); empty or the workspace's own is a base account. Left out, unchanged. */
  currency?: string | null;
}): Promise<ActionResult<{ id: string }>> {
  const { user, allowed } = await requireAccounts();
  if (!allowed) return { ok: false, error: "You can't manage bank accounts." };

  const currency = input.currency === undefined ? undefined : bankCurrencyValue(input.currency);
  if (currency === "invalid") return { ok: false, error: "Choose one of the currencies on the list." };
  if (currency && input.isDefault) {
    return { ok: false, error: "A foreign-currency account can't be the default: a payment that names no account goes to the default, and most are in rupees." };
  }
  if (currency !== undefined && input.id) {
    // Its own-currency balance is the sum of its payments, so they must all be in the currency it is kept in.
    const before = (await bankCurrencies([input.id])).get(input.id) ?? null;
    if (before !== currency) {
      const other = await db.payment.findFirst({
        where: { bankAccountId: input.id, currency: { not: currency ?? baseCurrency() } },
        select: { currency: true },
      });
      if (other) return { ok: false, error: `This account already has payments in ${other.currency}, so it can't be kept in ${currency ?? baseCurrency()}. Open a separate account for it.` };
      const row = await db.bankAccount.findUnique({ where: { id: input.id }, select: { isDefault: true } });
      if (currency && row?.isDefault) return { ok: false, error: "This is the default account. Make another one the default before keeping this one in a foreign currency." };
    }
  }

  const name = input.name.trim();
  if (!name) return { ok: false, error: "Name the account — 'HDFC Current' is enough." };
  // Checked like every other IFSC, after the same cleaning (src/lib/ifsc.ts) — it was stored as typed.
  const ifsc = normaliseIfsc(input.ifsc ?? "");
  if (ifsc && !isIfsc(ifsc)) return { ok: false, error: "That IFSC isn't right — it's four letters, a zero, then six characters, like HDFC0001234." };

  await ensureChartOfAccounts();

  if (input.id) {
    const row = await db.bankAccount.update({
      where: { id: input.id },
      data: {
        name,
        bankName: input.bankName?.trim() || null,
        accountNumber: input.accountNumber?.trim() || null,
        ifsc: ifsc || null,
        branch: input.branch?.trim() || null,
        ...(currency !== undefined ? { currency } : {}),
      },
      select: { id: true, ledgerAccountId: true },
    });
    // The ledger account carries the same name, or the chart drifts from the thing it describes.
    await db.ledgerAccount.update({ where: { id: row.ledgerAccountId }, data: { name } });
    if (input.isDefault) await makeDefault(row.id);
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "BankAccount", entityId: row.id, entityLabel: `Edited the bank account ${name}` });
    revalidatePath("/accounting/banking");
    return { ok: true, data: { id: row.id } };
  }

  const existingCount = await db.bankAccount.count();
  if (currency && existingCount === 0) {
    return { ok: false, error: `The first account becomes the default, which takes every payment that names no account. Add your ${baseCurrency()} account first.` };
  }
  const ledgerAccountId = await ledgerAccountForNewBank(name);

  const created = await db.bankAccount.create({
    data: {
      name,
      bankName: input.bankName?.trim() || null,
      accountNumber: input.accountNumber?.trim() || null,
      ifsc: ifsc || null,
      branch: input.branch?.trim() || null,
      ledgerAccountId,
      ...(currency ? { currency } : {}),
      // The first account is the default whether or not anybody ticked the box — otherwise payments
      // recorded before somebody sets one would have nowhere to go.
      isDefault: input.isDefault || existingCount === 0,
      createdById: user.id,
    },
    select: { id: true },
  });
  if (input.isDefault || existingCount === 0) await makeDefault(created.id);

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "BankAccount",
    entityId: created.id,
    entityLabel: name,
  });
  revalidatePath("/accounting/banking");
  return { ok: true, data: created };
}

async function ledgerAccountForNewBank(name: string): Promise<string> {
  const systemBank = await db.ledgerAccount.findUnique({
    where: { systemKey: SYSTEM_ACCOUNTS.BANK },
    select: { id: true, parentId: true },
  });

  // The first bank account adopts the system BANK account, so history posted to it stays put.
  if (systemBank) {
    const taken = await db.bankAccount.findFirst({ where: { ledgerAccountId: systemBank.id }, select: { id: true } });
    if (!taken) return systemBank.id;
  }

  // Otherwise a sibling under the same parent, taking the next free code in the 111x range.
  const siblings = await db.ledgerAccount.findMany({
    where: { code: { startsWith: "111" } },
    select: { code: true },
  });
  const used = new Set(siblings.map((s) => s.code));
  let code = "";
  for (let i = 1; i <= 9 && !code; i += 1) if (!used.has(`111${i}`)) code = `111${i}`;
  if (!code) code = `11${Date.now().toString().slice(-4)}`;

  const created = await db.ledgerAccount.create({
    data: {
      code,
      name,
      type: "ASSET",
      parentId: systemBank?.parentId ?? null,
      description: "A bank account. Its balance is reconciled against the bank's own statement.",
    },
    select: { id: true },
  });
  return created.id;
}

async function makeDefault(id: string) {
  // Exactly one default, always: two would make "where does an unassigned payment go" ambiguous.
  await db.$transaction(async (tx) => {
    await tx.bankAccount.updateMany({ where: { id: { not: id } }, data: { isDefault: false } });
    await tx.bankAccount.update({ where: { id }, data: { isDefault: true, active: true } });
  });
}

export async function setBankAccountActive(id: string, active: boolean): Promise<ActionResult<null>> {
  const { allowed } = await requireAccounts();
  if (!allowed) return { ok: false, error: "You can't manage bank accounts." };

  if (!active) {
    const row = await db.bankAccount.findUnique({ where: { id }, select: { isDefault: true } });
    if (row?.isDefault) {
      return { ok: false, error: "That's the default account. Make another one the default first." };
    }
  }
  await db.bankAccount.update({ where: { id }, data: { active } });
  revalidatePath("/accounting/banking");
  return { ok: true, data: null };
}

export async function setDefaultBankAccount(id: string): Promise<ActionResult<null>> {
  const { allowed } = await requireAccounts();
  if (!allowed) return { ok: false, error: "You can't manage bank accounts." };
  // Every payment that names no account lands in the default, in whatever currency it is (owner, 30 Oct 2026).
  if ((await bankCurrencies([id])).get(id)) return { ok: false, error: "A foreign-currency account can't be the default." };
  await makeDefault(id);
  revalidatePath("/accounting/banking");
  return { ok: true, data: null };
}

// ─── Cheques ──────────────────────────────────────────────────────────────────

/**
 * Cheques written or received that the bank hasn't shown yet — those on the accounts this person
 * reaches, like every other list of payments (`paymentAccess`). Whoever runs Banking usually reaches
 * every account, and then nothing is left out.
 */
export async function unclearedCheques() {
  const { user, allowed } = await requireAccounts();
  if (!allowed) return [];
  return toPlain(
    await db.payment.findMany({
      where: { AND: [{ method: "CHEQUE", clearedOn: null }, await paymentAccess(user.id, "view")] },
      orderBy: { paidOn: "asc" },
      include: { company: { select: { id: true, name: true } }, bankAccount: { select: { id: true, name: true } } },
    }),
  );
}

/**
 * Marks a cheque cleared and moves the money into the bank.
 *
 * This is the entry that makes a bank balance real. Until it runs, the amount sits in cheques in
 * hand — which is where it actually is.
 */
export async function clearCheque(input: {
  paymentId: string;
  clearedOn: string;
  bankAccountId?: string;
}): Promise<ActionResult<null>> {
  const { user, allowed } = await requireAccounts();
  if (!allowed) return { ok: false, error: "You can't clear a cheque." };

  const payment = await db.payment.findUnique({
    where: { id: input.paymentId },
    select: { id: true, method: true, clearedOn: true, paidOn: true, currency: true },
  });
  if (!payment || !(await mayAccess(user.id, "payments", "edit", payment.id))) {
    return { ok: false, error: "That payment no longer exists." };
  }
  if (payment.method !== "CHEQUE") return { ok: false, error: "Only a cheque needs clearing." };
  const currencyRefusal = await bankCurrencyRefusal(input.bankAccountId, payment.currency);
  if (currencyRefusal) return { ok: false, error: currencyRefusal };
  if (payment.clearedOn) return { ok: false, error: "That cheque is already cleared." };

  const clearedOn = new Date(`${input.clearedOn}T00:00:00.000Z`);
  if (Number.isNaN(clearedOn.getTime())) return { ok: false, error: "That isn't a date." };
  // A cheque cannot clear before it was written — the Indian day it was written, not the UTC one: the
  // books keep India's calendar in every workspace.
  if (clearedOn < new Date(`${indiaClock.dateKey(payment.paidOn)}T00:00:00.000Z`)) {
    return { ok: false, error: "A cheque can't clear before the day it was written." };
  }

  try {
    await ensureChartOfAccounts();
    await db.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: { clearedOn, ...(input.bankAccountId ? { bankAccountId: input.bankAccountId } : {}) },
      });
      await postChequeClearingToLedger(tx, payment.id, user.id, clearedOn);
    });
  } catch (error) {
    return { ok: false, error: plainError(error, "Could not clear that cheque.") };
  }

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Payment",
    entityId: payment.id,
    entityLabel: `Cheque cleared on ${input.clearedOn}`,
  });
  revalidatePath("/accounting/banking");
  revalidatePath("/payments");
  return { ok: true, data: null };
}

// ─── Statements ───────────────────────────────────────────────────────────────

/**
 * Imports a statement CSV.
 *
 * Rows already held are skipped rather than duplicated — people re-download overlapping statements
 * constantly, and an import that double-counts is worse than one that refuses.
 */
export async function importStatement(input: {
  bankAccountId: string;
  csv: string;
}): Promise<ActionResult<{ imported: number; duplicates: number; skipped: number }>> {
  const { user, allowed } = await requireAccounts();
  if (!allowed) return { ok: false, error: "You can't import a statement." };

  const account = await db.bankAccount.findUnique({ where: { id: input.bankAccountId }, select: { id: true } });
  if (!account) return { ok: false, error: "Choose a bank account first." };

  const { rows, skipped } = parseStatementCsv(input.csv);
  if (rows.length === 0) {
    return {
      ok: false,
      error:
        "No transactions were found. The file needs a header row with a date column and either an amount, or separate withdrawal and deposit columns.",
    };
  }

  let imported = 0;
  let duplicates = 0;
  for (const row of rows) {
    const fingerprint = statementFingerprint(row);
    const existing = await db.bankStatementLine.findUnique({
      where: { bankAccountId_fingerprint: { bankAccountId: account.id, fingerprint } },
      select: { id: true },
    });
    if (existing) {
      duplicates += 1;
      continue;
    }
    await db.bankStatementLine.create({
      data: {
        bankAccountId: account.id,
        date: new Date(`${row.date}T00:00:00.000Z`),
        narration: row.narration,
        reference: row.reference,
        amount: row.amount,
        fingerprint,
      },
    });
    imported += 1;
  }

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "BankStatementLine",
    entityId: account.id,
    entityLabel: `Imported ${imported} statement line(s), ${duplicates} already held`,
  });
  revalidatePath("/accounting/banking");
  return { ok: true, data: { imported, duplicates, skipped } };
}

// ─── Reconciliation ───────────────────────────────────────────────────────────

/**
 * A bank line's amount as the statement shows it, money in positive: base on a base account; on a foreign one
 * (owner, 30 Oct 2026) its payment's own amount, signed by the side the line is on.
 */
function bookAmountOf(
  l: { debit: unknown; credit: unknown; entry: { payment: { amount: unknown } | null } },
  currency: string | null,
): number {
  const base = Math.round((Number(l.debit) - Number(l.credit)) * 100) / 100;
  if (!currency || !l.entry.payment) return base;
  return (base < 0 ? -1 : 1) * Math.round(Number(l.entry.payment.amount) * 100) / 100;
}

/** Everything the reconciliation screen needs: both sides, what is matched, and what is suggested. */
export async function reconciliationView(params: { bankAccountId: string; to?: string; statementBalance?: number }) {
  if (!(await requireAccounts()).allowed) return null;
  const account = await db.bankAccount.findUnique({
    where: { id: params.bankAccountId },
    select: { id: true, name: true, ledgerAccountId: true },
  });
  if (!account) return null;

  // As at the end of an Indian day: the one asked for, or today in India. It was the end of the UTC
  // day (`T23:59:59.999Z`), which is 05:29 IST the next morning — so a receipt posted at 01:00 IST on
  // the 1st counted in a reconciliation to the 31st. Journal dates are instants, compared up to the
  // next Indian midnight; statement dates are a `@db.Date`, compared as that calendar day itself. A
  // reconciliation is the books', so India's day in every workspace.
  const asAtDay = params.to && indiaClock.startOfDay(params.to) ? params.to : indiaClock.today();
  const before = indiaClock.endOfDay(asAtDay)!;
  const to = new Date(before.getTime() - 1);

  const [lines, statementLines] = await Promise.all([
    db.journalLine.findMany({
      where: { accountId: account.ledgerAccountId, entry: { date: { lt: before } } },
      orderBy: { entry: { date: "asc" } },
      select: {
        id: true,
        debit: true,
        credit: true,
        narration: true,
        reconciledAt: true,
        entry: { select: { date: true, narration: true, entryNumber: true, payment: { select: { reference: true, amount: true, currency: true } } } },
      },
    }),
    db.bankStatementLine.findMany({
      where: { bankAccountId: account.id, date: { lte: new Date(`${asAtDay}T00:00:00.000Z`) } },
      orderBy: { date: "asc" },
    }),
  ]);

  // A foreign-currency account's statement is in its own currency (owner, 30 Oct 2026), so its book side is too: each
  // payment's own amount, not the base figure it posted. Lines with no payment behind them — a revaluation, a manual
  // journal — have no amount in that currency and are left off; the reconciliation is of the money that moved.
  const currency = (await bankCurrencies([account.id])).get(account.id) ?? null;
  const book: BookRow[] = lines
    .filter((l) => !currency || l.entry.payment?.currency === currency)
    .map((l) => ({
      id: l.id,
      date: l.entry.date,
      narration: l.narration ?? l.entry.narration,
      reference: l.entry.payment?.reference ?? null,
      // Positive is money in, which on a bank account is a debit.
      amount: bookAmountOf(l, currency),
    }));
  const statement: StatementRow[] = statementLines.map((s) => ({
    id: s.id,
    date: s.date,
    narration: s.narration,
    reference: s.reference,
    amount: Number(s.amount),
  }));

  const matchedBookIds = new Set(statementLines.filter((s) => s.matchedLineId).map((s) => s.matchedLineId!));
  const matchedStatementIds = new Set(statementLines.filter((s) => s.matchedLineId).map((s) => s.id));

  const bookBalance = book.reduce((t, b) => t + b.amount, 0);
  // Without a figure from the bank, assume it agrees — the screen then shows only what is in flight,
  // which is still useful, rather than a difference invented out of a zero.
  const statementBalance = params.statementBalance ?? bookBalance;

  const summary = reconcile({
    statementBalance,
    bookBalance,
    statement,
    book,
    matchedStatementIds,
    matchedBookIds,
  });

  const suggestions = suggestMatches(
    statement.filter((s) => !matchedStatementIds.has(s.id)),
    book.filter((b) => !matchedBookIds.has(b.id)),
  );

  const lastReconciliation = await db.bankReconciliation.findFirst({
    where: { bankAccountId: account.id },
    orderBy: { statementDate: "desc" },
    include: { completedBy: { select: { name: true } } },
  });

  return toPlain({
    account: { ...account, currency },
    asAt: to,
    summary,
    suggestions,
    statement,
    book,
    matchedStatementIds: [...matchedStatementIds],
    matchedBookIds: [...matchedBookIds],
    lastReconciliation,
  });
}

/** Ties a statement row to a journal line. Both sides then count as agreed. */
export async function matchStatementLine(statementLineId: string, bookLineId: string): Promise<ActionResult<null>> {
  const { user, allowed } = await requireAccounts();
  if (!allowed) return { ok: false, error: "You can't reconcile." };

  const [line, book] = await Promise.all([
    db.bankStatementLine.findUnique({ where: { id: statementLineId }, select: { id: true, amount: true, matchedLineId: true, bankAccountId: true } }),
    db.journalLine.findUnique({
      where: { id: bookLineId },
      select: { id: true, debit: true, credit: true, entry: { select: { payment: { select: { amount: true, currency: true } } } } },
    }),
  ]);
  if (!line || !book) return { ok: false, error: "That row no longer exists." };
  if (line.matchedLineId) return { ok: false, error: "That statement row is already matched." };

  // In the account's own currency for a foreign one (owner, 30 Oct 2026): the statement is in it.
  const currency = (await bankCurrencies([line.bankAccountId])).get(line.bankAccountId) ?? null;
  if (currency && book.entry.payment?.currency !== currency) {
    return { ok: false, error: `This is a ${currency} account; only a payment in ${currency} can be matched to its statement.` };
  }
  const bookAmount = bookAmountOf(book, currency);
  // Matching two different amounts would make the reconciliation agree while being wrong by the
  // difference — the exact failure this whole screen exists to prevent.
  if (bookAmount !== Number(line.amount)) {
    return { ok: false, error: `Those don't agree: the statement says ${line.amount} and the books say ${bookAmount}.` };
  }

  const taken = await db.bankStatementLine.findFirst({ where: { matchedLineId: bookLineId }, select: { id: true } });
  if (taken) return { ok: false, error: "That entry is already matched to another statement row." };

  await db.$transaction(async (tx) => {
    await tx.bankStatementLine.update({
      where: { id: statementLineId },
      data: { matchedLineId: bookLineId, matchedAt: new Date(), matchedById: user.id },
    });
    await tx.journalLine.update({ where: { id: bookLineId }, data: { reconciledAt: new Date() } });
  });

  revalidatePath("/accounting/banking");
  return { ok: true, data: null };
}

export async function unmatchStatementLine(statementLineId: string): Promise<ActionResult<null>> {
  const { allowed } = await requireAccounts();
  if (!allowed) return { ok: false, error: "You can't reconcile." };

  const line = await db.bankStatementLine.findUnique({
    where: { id: statementLineId },
    select: { matchedLineId: true },
  });
  if (!line?.matchedLineId) return { ok: false, error: "That row isn't matched." };
  const matchedLineId = line.matchedLineId;

  await db.$transaction(async (tx) => {
    await tx.bankStatementLine.update({
      where: { id: statementLineId },
      data: { matchedLineId: null, matchedAt: null, matchedById: null },
    });
    await tx.journalLine.update({ where: { id: matchedLineId }, data: { reconciledAt: null } });
  });
  revalidatePath("/accounting/banking");
  return { ok: true, data: null };
}

/** Accepts every suggestion in one go. Each still goes through the amount check. */
export async function acceptSuggestedMatches(
  bankAccountId: string,
  pairs: { statementLineId: string; bookLineId: string }[],
): Promise<ActionResult<{ matched: number; failed: number }>> {
  const { allowed } = await requireAccounts();
  if (!allowed) return { ok: false, error: "You can't reconcile." };

  let matched = 0;
  let failed = 0;
  for (const pair of pairs) {
    const result = await matchStatementLine(pair.statementLineId, pair.bookLineId);
    if (result.ok) matched += 1;
    else failed += 1;
  }
  revalidatePath("/accounting/banking");
  void bankAccountId;
  return { ok: true, data: { matched, failed } };
}

/** Records that somebody agreed the two at a date — including, honestly, when they didn't quite. */
export async function completeReconciliation(input: {
  bankAccountId: string;
  statementDate: string;
  statementBalance: number;
  note?: string;
}): Promise<ActionResult<null>> {
  const { user, allowed } = await requireAccounts();
  if (!allowed) return { ok: false, error: "You can't reconcile." };

  const view = await reconciliationView({
    bankAccountId: input.bankAccountId,
    to: input.statementDate,
    statementBalance: input.statementBalance,
  });
  if (!view) return { ok: false, error: "That bank account no longer exists." };

  await db.bankReconciliation.upsert({
    where: {
      bankAccountId_statementDate: {
        bankAccountId: input.bankAccountId,
        statementDate: new Date(`${input.statementDate}T00:00:00.000Z`),
      },
    },
    create: {
      bankAccountId: input.bankAccountId,
      statementDate: new Date(`${input.statementDate}T00:00:00.000Z`),
      statementBalance: input.statementBalance,
      bookBalance: view.summary.bookBalance,
      difference: view.summary.difference,
      // Capped (owner, 15 Nov 2026 — input bounds).
      note: clipOrNull(input.note, TEXT_MAX.paragraph),
      completedById: user.id,
    },
    update: {
      statementBalance: input.statementBalance,
      bookBalance: view.summary.bookBalance,
      difference: view.summary.difference,
      note: clipOrNull(input.note, TEXT_MAX.paragraph),
      completedById: user.id,
      completedAt: new Date(),
    },
  });

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "BankReconciliation",
    entityId: input.bankAccountId,
    // The difference is recorded even when it isn't nil. A reconciliation that only gets saved when
    // it balances is a reconciliation nobody ever saves.
    entityLabel: `Reconciled ${view.account.name} to ${input.statementDate}, difference ₹${view.summary.difference}`,
  });
  revalidatePath("/accounting/banking");
  return { ok: true, data: null };
}
