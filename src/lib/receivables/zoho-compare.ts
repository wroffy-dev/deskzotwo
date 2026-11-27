import { db } from "@/lib/db";
import { writeOffsFor } from "@/lib/receivables/write-off";
import { settleInvoice } from "@/lib/receivables";
import { RECEIVABLE_DOC_TYPE } from "@/lib/trade-documents";
import { zohoGet, type ZohoReply } from "@/lib/zoho/client";
import { leftBehind } from "@/lib/migration/documents";

/**
 * Whether what Deskzo says customers owe is right (owner, 6 Nov 2026 — "is it possible receipts are not imported
 * properly or not adjusted?"). Two read-only looks, changing nothing:
 *
 *   · **The receipts check**, from Deskzo alone: the money received, how much of it is set against invoices, how much
 *     sits on account — and who has money on account and invoices open at once, which is what reads as owing when it
 *     may be paid.
 *   · **Compare with Zoho**, a page of Zoho's invoice list at a time (a call a page, 200 invoices): each invoice's
 *     balance there and here. Zoho's list carries the balance, so nothing is read invoice by invoice.
 */

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
/** A rupee of rounding is no difference, as a rupee doesn't hold an invoice open (src/lib/receivables.ts). */
const NOTICEABLE = 1;

const SETTLEMENT = { total: true, paidBefore: true, payments: { select: { amount: true } }, creditsReceived: { select: { amount: true } } } as const;
type Settling = { id?: string; total: unknown; paidBefore: unknown; payments: { amount: unknown }[]; creditsReceived: { amount: unknown }[]; /** Written off as bad debt (src/lib/receivables/write-off.ts). */ writtenOff?: number };
const sum = (rows: { amount: unknown }[]) => rows.reduce((t, r) => t + Number(r.amount), 0);
const balanceOf = (d: Settling) => settleInvoice(Number(d.total), sum(d.payments), sum(d.creditsReceived) + (d.writtenOff ?? 0), Number(d.paidBefore)).balance;
/** The rows, each with what's been written off it. */
async function withWriteOffs<T extends { id: string }>(rows: T[]): Promise<(T & { writtenOff: number })[]> {
  const w = await writeOffsFor(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, writtenOff: w.get(r.id) ?? 0 }));
}

export type OnAccountCustomer = { companyId: string; companySeq: number; name: string; onAccount: number; open: number; couldSettle: number };
export type ReceiptsCheck = {
  payments: number;
  received: number;
  applied: number;
  onAccount: number;
  /** How many payments have money not set against anything. */
  withMoneyLeft: number;
  /** What the Receivables page's total counts: invoices and debit notes still owing. */
  open: number;
  /** Of that, invoices alone — what Compare with Zoho can be held to. */
  openInvoices: number;
  /** Across customers, the money on account that open invoices of theirs could take. */
  couldSettle: number;
  customers: OnAccountCustomer[];
};

const LISTED = 50;

export async function receiptsCheck(): Promise<ReceiptsCheck> {
  const [payments, loaded] = await Promise.all([
    db.payment.findMany({
      where: { direction: "RECEIVED" },
      select: { amount: true, exchangeRate: true, companyId: true, company: { select: { companySeq: true, name: true } }, allocations: { select: { amount: true, paymentAmount: true } } },
    }),
    db.tradeDocument.findMany({
      where: { docType: RECEIVABLE_DOC_TYPE, status: { notIn: ["DRAFT", "CANCELLED", "PAID"] } },
      select: { id: true, docType: true, exchangeRate: true, companyId: true, company: { select: { companySeq: true, name: true } }, ...SETTLEMENT },
    }),
  ]);
  const documents = await withWriteOffs(loaded);

  const people = new Map<string, OnAccountCustomer>();
  const person = (companyId: string, company: { companySeq: number; name: string }) => {
    let found = people.get(companyId);
    if (!found) {
      found = { companyId, companySeq: company.companySeq, name: company.name, onAccount: 0, open: 0, couldSettle: 0 };
      people.set(companyId, found);
    }
    return found;
  };

  let received = 0;
  let applied = 0;
  let onAccount = 0;
  let withMoneyLeft = 0;
  for (const p of payments) {
    const rate = Number(p.exchangeRate) || 1;
    const set = p.allocations.reduce((t, a) => t + Number(a.paymentAmount ?? a.amount), 0);
    const left = Math.max(Number(p.amount) - set, 0);
    received += Number(p.amount) * rate;
    applied += Math.min(set, Number(p.amount)) * rate;
    if (left >= NOTICEABLE) {
      withMoneyLeft += 1;
      onAccount += left * rate;
      person(p.companyId, p.company).onAccount += left * rate;
    }
  }

  let open = 0;
  let openInvoices = 0;
  for (const d of documents) {
    const owed = balanceOf(d) * (Number(d.exchangeRate) || 1);
    if (owed < 0.01) continue;
    open += owed;
    if (d.docType === "INVOICE") openInvoices += owed;
    person(d.companyId, d.company).open += owed;
  }

  let couldSettle = 0;
  for (const c of people.values()) {
    c.couldSettle = round2(Math.min(c.onAccount, c.open));
    couldSettle += c.couldSettle;
    c.onAccount = round2(c.onAccount);
    c.open = round2(c.open);
  }
  const customers = [...people.values()].filter((c) => c.onAccount >= NOTICEABLE).sort((a, b) => b.couldSettle - a.couldSettle || b.onAccount - a.onAccount).slice(0, LISTED);

  return { payments: payments.length, received: round2(received), applied: round2(applied), onAccount: round2(onAccount), withMoneyLeft, open: round2(open), openInvoices: round2(openInvoices), couldSettle: round2(couldSettle), customers };
}

type J = Record<string, unknown>;
export type InvoiceDifference = { number: string; customer: string; companySeq: number | null; date: string; currency: string; zoho: number; deskzo: number; difference: number };
export type NotInDeskzo = { number: string; customer: string; date: string; currency: string; zoho: number; archived: boolean };
export type ComparePage = {
  page: number;
  hasMore: boolean;
  checked: number;
  /** In rupees: what Zoho says these invoices owe, and what Deskzo says of the ones it has. */
  zohoOwing: number;
  deskzoOwing: number;
  matches: number;
  differences: InvoiceDifference[];
  notInDeskzo: NotInDeskzo[];
};
type DeskzoInvoice = Settling & { docNumber: string | null; exchangeRate: unknown; company: { companySeq: number } | null };

/**
 * One page of Zoho's list against Deskzo's invoices of those numbers. One Zoho doesn't count — a draft, void, rejected,
 * waiting for approval or approved but not sent (`leftBehind`, the import's own rule; owner, 18 Nov 2026: ten such were
 * listed as "owing in Zoho, not open here") — owes nothing in Zoho, whatever balance it shows.
 */
export function compareRows(rows: J[], invoices: DeskzoInvoice[], archived: ReadonlySet<string>, page: number, hasMore: boolean): ComparePage {
  const here = new Map(invoices.map((d) => [d.docNumber ?? "", d]));
  const out: ComparePage = { page, hasMore, checked: 0, zohoOwing: 0, deskzoOwing: 0, matches: 0, differences: [], notInDeskzo: [] };
  for (const r of rows) {
    const number = String(r.invoice_number ?? "").trim();
    if (!number) continue;
    out.checked += 1;
    const status = String(r.status ?? "").toLowerCase();
    const zoho = leftBehind(status) ? 0 : round2(Number(r.balance ?? 0));
    const zohoRate = Number(r.exchange_rate) || 1;
    out.zohoOwing += zoho * zohoRate;
    const customer = String(r.customer_name ?? "");
    const date = String(r.date ?? "");
    const currency = String(r.currency_code ?? "INR");
    const mine = here.get(number);
    if (!mine) {
      if (zoho >= NOTICEABLE) out.notInDeskzo.push({ number, customer, date, currency, zoho, archived: archived.has(number) });
      continue;
    }
    const deskzo = round2(balanceOf(mine));
    out.deskzoOwing += deskzo * (Number(mine.exchangeRate) || 1);
    const difference = round2(deskzo - zoho);
    if (Math.abs(difference) >= NOTICEABLE) out.differences.push({ number, customer, companySeq: mine.company?.companySeq ?? null, date, currency, zoho, deskzo, difference });
    else out.matches += 1;
  }
  out.zohoOwing = round2(out.zohoOwing);
  out.deskzoOwing = round2(out.deskzoOwing);
  return out;
}

export async function compareInvoicesPage(page: number): Promise<ComparePage> {
  const reply = (await zohoGet("/invoices", { page, per_page: 200 })) as ZohoReply;
  const rows = (reply.invoices as J[] | undefined) ?? [];
  const numbers = rows.map((r) => String(r.invoice_number ?? "").trim()).filter(Boolean);
  const [invoices, archived] = await Promise.all([
    db.tradeDocument.findMany({
      where: { docType: "INVOICE", docNumber: { in: numbers }, status: { notIn: ["DRAFT", "CANCELLED"] } },
      select: { id: true, docNumber: true, exchangeRate: true, company: { select: { companySeq: true } }, ...SETTLEMENT },
    }),
    db.archivedDocument.findMany({ where: { kind: "INVOICE", number: { in: numbers } }, select: { number: true } }),
  ]);
  return compareRows(rows, await withWriteOffs(invoices), new Set(archived.map((a) => a.number)), page, !!reply.page_context?.has_more_page);
}
