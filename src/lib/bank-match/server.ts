import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { aiTurn, AiRefusal } from "@/lib/ai/gateway";
import { baseCurrency } from "@/lib/currency";
import { workspacePack } from "@/lib/country-pack";
import { settleInvoice } from "@/lib/receivables";
import { writeOffsFor } from "@/lib/receivables/write-off";
import { RECEIVABLE_DOC_TYPE } from "@/lib/trade-documents";
import { customerSide } from "@/lib/companies/roles";
import { bankCurrencies } from "@/lib/finance/bank-currency";
import { suggestMatches } from "@/lib/ledger/reconcile";
import { teammateWork } from "@/lib/ai/teammate-work";
import { BANK_MATCH_STEPS } from "@/lib/ai/teammate-steps";
import {
  MATCH_SYSTEM,
  PROPOSE_MATCHES,
  matchPrompt,
  matchesSchema,
  nameWords,
  proposeMoneyIn,
  squash,
  type Customer,
  type MoneyInLine,
  type OpenInvoice,
  type Proposal,
  type UnmatchedReceipt,
} from "@/lib/bank-match/rules";

/**
 * Arjun reading the bank's money-in lines nothing in the books matches (owner, 20 Nov 2026 — the rules are ./rules.ts).
 * For one bank account in the workspace's own currency: its statement's money-in lines not matched, and not already
 * among the reconciliation's own suggestions (src/lib/ledger/reconcile.ts); the customers and their open invoices; the
 * receipts already in the books that no line is matched to. Deskzo AI is asked only when somebody presses for it, about
 * the lines the rules couldn't place, once each (`BankLineGuess`), charged to them.
 */

export class BankMatchRefusal extends Error {}

const DAY = 86_400_000;
/** Lines asked of Deskzo AI at a time. */
const ASK_AT_ONCE = 25;
/** Customers offered to it at a time. */
const OFFER_CUSTOMERS = 60;

export type MoneyInItem = { line: { id: string; date: string; narration: string; amount: number }; proposal: Proposal };
export type MoneyInView = {
  /** A foreign-currency account: nothing proposed yet. */
  foreign: boolean;
  items: MoneyInItem[];
  /** Money-in lines with nothing proposed that Deskzo AI hasn't been asked about. */
  unasked: number;
  /** …and those it was asked about and couldn't place. */
  unplaced: number;
};

type Facts = { account: { id: string; ledgerAccountId: string }; lines: MoneyInLine[]; invoices: OpenInvoice[]; customers: Customer[]; unmatched: UnmatchedReceipt[] };

/** Everything the proposals are made from, for one account. Null for an account that isn't there; `foreign` for one in another currency. */
async function facts(bankAccountId: string, now: Date): Promise<Facts | "foreign" | null> {
  const account = await db.bankAccount.findUnique({ where: { id: bankAccountId }, select: { id: true, ledgerAccountId: true } });
  if (!account) return null;
  if ((await bankCurrencies([account.id])).get(account.id)) return "foreign";
  const since = new Date(now.getTime() - 400 * DAY);
  const [statement, book, docs, customers] = await Promise.all([
    db.bankStatementLine.findMany({ where: { bankAccountId: account.id, date: { gte: since } }, orderBy: { date: "desc" }, take: 2000, select: { id: true, date: true, narration: true, reference: true, amount: true, matchedLineId: true } }),
    db.journalLine.findMany({
      where: { accountId: account.ledgerAccountId, entry: { date: { gte: since } } },
      select: { id: true, debit: true, credit: true, narration: true, statementLine: { select: { id: true } }, entry: { select: { date: true, narration: true, payment: { select: { reference: true } } } } },
    }),
    db.tradeDocument.findMany({
      where: { docType: RECEIVABLE_DOC_TYPE, status: { in: ["ISSUED", "PARTIALLY_PAID"] }, currency: baseCurrency() },
      orderBy: { issueDate: "asc" },
      take: 5000,
      select: { id: true, docNumber: true, companyId: true, issueDate: true, total: true, taxableValue: true, paidBefore: true, company: { select: { name: true } }, payments: { select: { amount: true } }, creditsReceived: { select: { amount: true } } },
    }),
    db.company.findMany({ where: await customerSide(), take: 8000, select: { id: true, name: true } }),
  ]);
  const sum = (r: { amount: Prisma.Decimal }[]) => r.reduce((t, x) => t + Number(x.amount), 0);
  const off = await writeOffsFor(docs.map((d) => d.id));
  const invoices: OpenInvoice[] = docs
    .map((d) => ({
      id: d.id,
      number: d.docNumber,
      companyId: d.companyId,
      companyName: d.company.name,
      balance: settleInvoice(Number(d.total), sum(d.payments), sum(d.creditsReceived) + (off.get(d.id) ?? 0), Number(d.paidBefore)).balance,
      total: Number(d.total),
      taxable: Number(d.taxableValue),
      issueDate: d.issueDate,
    }))
    .filter((i) => i.balance >= 0.5);

  // Money in, not matched; less what the reconciliation already suggests matching.
  const open = statement.filter((s) => !s.matchedLineId);
  const bookOpen = book.filter((b) => !b.statementLine);
  const suggested = new Set(
    suggestMatches(
      open.map((s) => ({ id: s.id, date: s.date, narration: s.narration, reference: s.reference, amount: Number(s.amount) })),
      bookOpen.map((b) => ({ id: b.id, date: b.entry.date, narration: b.narration ?? b.entry.narration, reference: b.entry.payment?.reference ?? null, amount: Math.round((Number(b.debit) - Number(b.credit)) * 100) / 100 })),
    ).map((s) => s.statementLineId),
  );
  const lines = open
    .filter((s) => Number(s.amount) > 0 && !suggested.has(s.id))
    .map((s) => ({ id: s.id, date: s.date, narration: s.narration, reference: s.reference, amount: Number(s.amount) }));
  const unmatched: UnmatchedReceipt[] = bookOpen
    .map((b) => ({ id: b.id, date: b.entry.date, amount: Math.round((Number(b.debit) - Number(b.credit)) * 100) / 100, narration: b.narration ?? b.entry.narration ?? "" }))
    .filter((b) => b.amount > 0);
  return { account, lines, invoices, customers, unmatched };
}

async function guessesFor(lineIds: string[]) {
  try {
    const rows = await db.bankLineGuess.findMany({ where: { statementLineId: { in: lineIds } }, select: { statementLineId: true, companyId: true, documentIds: true, why: true } });
    return new Map(rows.map((r) => [r.statementLineId, { companyId: r.companyId, documentIds: r.documentIds, why: r.why }]));
  } catch (err) {
    if (notMigratedYet(err)) return new Map<string, { companyId: string | null; documentIds: string[]; why: string }>();
    throw err;
  }
}

/** Arjun's proposals for an account's money-in lines, newest first. */
export async function moneyInView(bankAccountId: string, now = new Date()): Promise<MoneyInView | null> {
  const f = await facts(bankAccountId, now);
  if (!f) return null;
  if (f === "foreign") return { foreign: true, items: [], unasked: 0, unplaced: 0 };
  const guesses = await guessesFor(f.lines.map((l) => l.id));
  const proposals = proposeMoneyIn(f.lines, { invoices: f.invoices, customers: f.customers, unmatched: f.unmatched, guesses, india: workspacePack().india });
  const byLine = new Map(f.lines.map((l) => [l.id, l]));
  const placed = new Set(proposals.map((p) => p.statementLineId));
  const left = f.lines.filter((l) => !placed.has(l.id));
  return {
    foreign: false,
    items: proposals.map((p) => {
      const l = byLine.get(p.statementLineId)!;
      return { line: { id: l.id, date: l.date.toISOString().slice(0, 10), narration: l.narration, amount: l.amount }, proposal: p };
    }),
    unasked: left.filter((l) => !guesses.has(l.id)).length,
    unplaced: left.filter((l) => guesses.has(l.id)).length,
  };
}

/** The customers to offer Deskzo AI for these lines: those a narration shares a telling word with, then those an amount fits. */
function offerFor(lines: MoneyInLine[], customers: Customer[], invoices: OpenInvoice[]): (Customer & { invoices: OpenInvoice[] })[] {
  const byCompany = new Map<string, OpenInvoice[]>();
  for (const i of invoices) byCompany.set(i.companyId, [...(byCompany.get(i.companyId) ?? []), i]);
  const runs = lines.map((l) => squash(l.narration));
  const amounts = lines.map((l) => l.amount);
  const scored = customers.map((c) => {
    const telling = nameWords(c.name).filter((w) => w.length >= 3);
    // A narration runs names together and cuts them short: a telling word's first four letters is enough to offer it.
    const word = telling.some((w) => runs.some((r) => r.includes(w.slice(0, Math.min(w.length, 4)))));
    const own = byCompany.get(c.id) ?? [];
    const fits = own.some((i) => amounts.some((a) => Math.abs(i.balance - a) <= 0.5 || (a < i.balance && a > i.balance * 0.85)));
    return { c, score: (word ? 2 : 0) + (fits ? 1 : 0) };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, OFFER_CUSTOMERS)
    .map((s) => ({ ...s.c, invoices: byCompany.get(s.c.id) ?? [] }));
}

/**
 * Deskzo AI asked about the lines the rules couldn't place — up to ASK_AT_ONCE, each once — and what it read kept as a
 * guess (none, where it couldn't say). Charged to `userId`. Returns how many lines it placed.
 */
export async function askAboutMoneyIn(bankAccountId: string, userId: string, now = new Date()): Promise<{ asked: number; placed: number }> {
  const f = await facts(bankAccountId, now);
  if (!f) throw new BankMatchRefusal("That bank account isn't there any more.");
  if (f === "foreign") throw new BankMatchRefusal("Arjun reads money in on accounts in your own currency only, for now.");
  const guesses = await guessesFor(f.lines.map((l) => l.id));
  const proposals = proposeMoneyIn(f.lines, { invoices: f.invoices, customers: f.customers, unmatched: f.unmatched, guesses, india: workspacePack().india });
  const placed = new Set(proposals.map((p) => p.statementLineId));
  const lines = f.lines.filter((l) => !placed.has(l.id) && !guesses.has(l.id)).slice(0, ASK_AT_ONCE);
  if (!lines.length) return { asked: 0, placed: 0 };
  const offered = offerFor(lines, f.customers, f.invoices);
  const keep = async (rows: { statementLineId: string; companyId: string | null; documentIds: string[]; why: string }[]) => {
    await db.bankLineGuess.createMany({ data: rows.map((r) => ({ ...r, why: r.why.slice(0, 300), createdById: userId })), skipDuplicates: true });
  };
  if (!offered.length) {
    await keep(lines.map((l) => ({ statementLineId: l.id, companyId: null, documentIds: [], why: "No customer's name is anything like it." })));
    return { asked: lines.length, placed: 0 };
  }

  return teammateWork(
    { teammate: "arjun", userId, kind: "bank.match", subject: `bank:${bankAccountId}`, label: `${lines.length} bank line${lines.length === 1 ? "" : "s"} to place`, href: "/accounting/banking", steps: BANK_MATCH_STEPS },
    async (work) => {
      let outcome;
      try {
        outcome = await aiTurn({ userId, feature: "bank.match", system: MATCH_SYSTEM, history: [{ role: "user", text: matchPrompt(lines, offered) }], tools: [PROPOSE_MATCHES] });
      } catch (err) {
        if (err instanceof AiRefusal) throw new BankMatchRefusal(err.message);
        throw err;
      }
      await work.step(1);
      const call = outcome.toolCalls.find((c) => c.name === PROPOSE_MATCHES.name);
      const read = matchesSchema.parse(call?.input ?? {});
      const rows = lines.map((l, i) => {
        const m = read.matches.find((x) => x.line === i + 1);
        const c = m?.customer ? offered[m.customer - 1] : undefined;
        if (!m || !c) return { statementLineId: l.id, companyId: null, documentIds: [] as string[], why: m?.why || "Arjun couldn't place it." };
        const numbers = new Set((m.invoices ?? []).map(squash));
        return { statementLineId: l.id, companyId: c.id, documentIds: c.invoices.filter((v) => numbers.has(squash(v.number))).map((v) => v.id), why: m.why || `Read as ${c.name}` };
      });
      await work.step(2);
      await keep(rows);
      return { asked: lines.length, placed: rows.filter((r) => r.companyId).length };
    },
    (r) => `Placed ${r.placed} of ${r.asked}`,
  );
}

/** A statement line as the confirming action needs it, with the account behind it. */
export async function statementLineFor(id: string) {
  return db.bankStatementLine.findUnique({
    where: { id },
    select: { id: true, date: true, narration: true, reference: true, amount: true, matchedLineId: true, bankAccount: { select: { id: true, ledgerAccountId: true } } },
  });
}

/** The journal line a payment posted to a bank account's ledger account. */
export async function bankLineOfPayment(paymentId: string, ledgerAccountId: string): Promise<string | null> {
  return (await db.journalLine.findFirst({ where: { accountId: ledgerAccountId, entry: { paymentId } }, select: { id: true } }))?.id ?? null;
}

/** Receipts already in the books on this account, unmatched, of this amount within a month — what makes recording it again a duplicate. */
export async function sameReceiptInBooks(ledgerAccountId: string, amount: number, date: Date): Promise<number> {
  const rows = await db.journalLine.findMany({
    where: { accountId: ledgerAccountId, statementLine: null, debit: new Prisma.Decimal(amount), entry: { date: { gte: new Date(date.getTime() - 30 * DAY), lte: new Date(date.getTime() + 30 * DAY) } } },
    select: { id: true, credit: true },
  });
  return rows.filter((r) => Number(r.credit) === 0).length;
}

