import { db } from "@/lib/db";
import { workspaceClock } from "@/lib/time/workspace";
import { RAISED_IN_DESKZO } from "@/lib/documents/imported";
import { formatPaymentId } from "@/lib/order-id";
import { balances, type BillRef, type InventoryLine, type ItemMaster, type LedgerLine, type PartyMaster, type Voucher } from "@/lib/tally/xml";

/**
 * What one export holds (owner, 25 Oct 2026 plan; built 23 Nov 2026 — src/lib/tally): the period's sales invoices, credit
 * and debit notes and customer receipts not sent before, each as its Tally voucher, and the parties and items Tally
 * hasn't got yet. Phase 1 is the sales side; purchases stay in Tally.
 *
 *   · Built from the record's own ledger entry, line by line (its live entries — a reversed one counts for nothing), so
 *     Tally gets exactly what Deskzo posted: the customer from the receivables line, every other line by its account.
 *   · Names: a mapping set on the Tally page, else Tally's own ledger of that exact name (its uploaded masters). An
 *     account with neither stops the export — it never guesses. A customer or item with neither goes as a new master.
 *   · Bill-wise: an invoice is a New Ref by its number; a credit note is set Agst Ref against the invoices it was applied
 *     to; a receipt Agst Ref against each invoice it paid, the rest On Account.
 *   · Only what was raised here (Zoho's, migrated or imported, is in Tally already) and from the start date on.
 */

const DAY = 86_400_000;
const VOUCHER_TYPE = { INVOICE: "Sales", CREDIT_NOTE: "Credit Note", DEBIT_NOTE: "Debit Note" } as const;
type SalesDocType = keyof typeof VOUCHER_TYPE;
const DOC_SOURCES = ["INVOICE", "CREDIT_NOTE", "DEBIT_NOTE"] as const;
const LIVE = { reversesId: null, reversedBy: { is: null } } as const;

export type Unmatched = { key: string; label: string; where: string };
export type ExportRecord = { kind: "DOCUMENT" | "PAYMENT"; recordId: string; voucherType: string; voucherNumber: string };
export type ExportSummary = {
  from: string;
  to: string;
  byType: { type: string; count: number; value: number; first: string | null; last: string | null }[];
  taxByRate: { rate: number; taxable: number; cgst: number; sgst: number; igst: number }[];
  byParty: { party: string; value: number }[];
  newParties: number;
  newItems: number;
  /** Invoices sent with ledger amounts only, though item lines were asked for — and why. */
  withoutItems: string[];
};
export type ExportPlan = {
  vouchers: Voucher[];
  masters: { parties: PartyMaster[]; units: string[]; items: ItemMaster[] };
  records: ExportRecord[];
  /** Accounts with no Tally name — the export is refused until they're matched. */
  unmatched: Unmatched[];
  /** Records left out, and why (nothing posted, a voucher that wouldn't balance). */
  skipped: { label: string; why: string }[];
  /** New masters to be remembered once the export is made: the mapping key and the name it went as. */
  created: { key: string; name: string }[];
  summary: ExportSummary;
};

export type NameBook = {
  mapping: Map<string, string>;
  ledgersByName: Map<string, string>;
  ledgersByGstin: Map<string, string>;
  itemsByName: Map<string, string>;
};

export async function nameBook(): Promise<NameBook> {
  const [mappings, masters] = await Promise.all([db.tallyMapping.findMany({ select: { key: true, tallyName: true } }), db.tallyMaster.findMany({ select: { kind: true, name: true, gstin: true } })]);
  const book: NameBook = { mapping: new Map(mappings.map((m) => [m.key, m.tallyName])), ledgersByName: new Map(), ledgersByGstin: new Map(), itemsByName: new Map() };
  for (const m of masters) {
    if (m.kind === "LEDGER") {
      book.ledgersByName.set(m.name.toLowerCase(), m.name);
      if (m.gstin) book.ledgersByGstin.set(m.gstin, m.name);
    } else book.itemsByName.set(m.name.toLowerCase(), m.name);
  }
  return book;
}

export const accountKey = (id: string, rate?: number) => (rate === undefined ? `ACCOUNT:${id}` : `ACCOUNT:${id}@${rate}`);
export const partyKey = (companyId: string) => `PARTY:${companyId}`;
export const itemKey = (itemId: string | null, name: string) => (itemId ? `ITEM:${itemId}` : `ITEM:name:${name.trim().toLowerCase()}`);

/** An account's Tally name: its mapping, else Tally's ledger of the same name. */
export function accountName(book: NameBook, account: { id: string; name: string }): string | null {
  return book.mapping.get(accountKey(account.id)) ?? book.ledgersByName.get(account.name.trim().toLowerCase()) ?? null;
}

const round = (n: number) => Math.round(n * 100) / 100;
const num = (d: unknown) => Number(d ?? 0);

type Line = { accountId: string; account: { id: string; name: string; systemKey: string | null; type: string }; companyId: string | null; amount: number };

/** A record's live ledger lines, netted by account and party: credit positive, as Tally writes it. */
function netLines(entries: { lines: { accountId: string; companyId: string | null; debit: unknown; credit: unknown; account: { id: string; name: string; systemKey: string | null; type: string } }[] }[]): Line[] {
  const byKey = new Map<string, Line>();
  for (const e of entries) {
    for (const l of e.lines) {
      const key = `${l.accountId}|${l.companyId ?? ""}`;
      const had = byKey.get(key) ?? { accountId: l.accountId, account: l.account, companyId: l.companyId, amount: 0 };
      had.amount += num(l.credit) - num(l.debit);
      byKey.set(key, had);
    }
  }
  return [...byKey.values()].map((l) => ({ ...l, amount: round(l.amount) })).filter((l) => Math.abs(l.amount) >= 0.005);
}

/** Plans the export of a period (YYYY-MM-DD, both days included). Writes nothing. */
export async function planExport(from: string, to: string, opts: { itemLines: boolean; startDate: string | null }): Promise<ExportPlan> {
  const clock = await workspaceClock();
  const effectiveFrom = opts.startDate && opts.startDate > from ? opts.startDate : from;
  const fromAt = clock.startOfDay(effectiveFrom) ?? new Date(`${effectiveFrom}T00:00:00Z`);
  const toAt = new Date((clock.startOfDay(to) ?? new Date(`${to}T00:00:00Z`)).getTime() + DAY);
  const book = await nameBook();
  const plan: ExportPlan = {
    vouchers: [],
    masters: { parties: [], units: [], items: [] },
    records: [],
    unmatched: [],
    skipped: [],
    created: [],
    summary: { from: effectiveFrom, to, byType: [], taxByRate: [], byParty: [], newParties: 0, newItems: 0, withoutItems: [] },
  };
  if (effectiveFrom > to) return plan;

  const exported = new Set((await db.tallyExportRecord.findMany({ select: { kind: true, recordId: true } })).map((r) => `${r.kind}:${r.recordId}`));
  const unmatched = new Map<string, Unmatched>();
  const newParties = new Map<string, PartyMaster>();
  const newItems = new Map<string, ItemMaster>();
  const units = new Set<string>();
  const created = new Map<string, string>();

  const ledgerFor = (account: Line["account"], where: string): string => {
    const name = accountName(book, account);
    if (name) return name;
    unmatched.set(accountKey(account.id), { key: accountKey(account.id), label: account.name, where });
    return account.name;
  };
  const partyFor = (company: { id: string; name: string }, details: Omit<PartyMaster, "name" | "group">): string => {
    const mapped = book.mapping.get(partyKey(company.id)) ?? (details.gstin ? book.ledgersByGstin.get(details.gstin) : undefined) ?? book.ledgersByName.get(company.name.trim().toLowerCase());
    if (mapped) return mapped;
    const name = company.name.trim();
    if (!newParties.has(company.id)) newParties.set(company.id, { name, group: "Sundry Debtors", ...details });
    created.set(partyKey(company.id), name);
    return name;
  };
  const itemFor = (line: { itemId: string | null; name: string; hsnCode: string | null; unit: string | null }): string => {
    const key = itemKey(line.itemId, line.name);
    const mapped = book.mapping.get(key) ?? book.itemsByName.get(line.name.trim().toLowerCase());
    if (mapped) return mapped;
    const name = line.name.trim().slice(0, 200);
    if (!newItems.has(key)) newItems.set(key, { name, unit: unitOf(line.unit), hsn: line.hsnCode });
    created.set(key, name);
    return name;
  };

  // ─── Sales documents ───────────────────────────────────────────────────────────────────────────────────────────
  const docs = await db.tradeDocument.findMany({
    where: { AND: [RAISED_IN_DESKZO, { direction: "SALES", docType: { in: ["INVOICE", "CREDIT_NOTE", "DEBIT_NOTE"] }, status: { notIn: ["DRAFT", "CANCELLED"] }, issueDate: { gte: fromAt, lt: toAt } }] },
    orderBy: [{ issueDate: "asc" }, { docNumber: "asc" }],
    take: 5000,
    select: {
      id: true,
      docNumber: true,
      docType: true,
      issueDate: true,
      reference: true,
      buyerGstin: true,
      partyName: true,
      billingLine1: true,
      billingLine2: true,
      billingCity: true,
      billingState: true,
      billingPincode: true,
      billingCountry: true,
      irn: true,
      ackNo: true,
      ackDate: true,
      currency: true,
      company: { select: { id: true, name: true } },
      againstDocument: { select: { docNumber: true } },
      creditsApplied: { select: { amount: true, invoice: { select: { docNumber: true } } } },
      ewayBills: { where: { ewayBillNumber: { not: null } }, select: { ewayBillNumber: true }, take: 1 },
      lines: { orderBy: { sortOrder: "asc" }, select: { itemId: true, name: true, hsnCode: true, unit: true, quantity: true, taxableValue: true, taxRatePercent: true, cgstAmount: true, sgstAmount: true, igstAmount: true } },
      journalEntries: { where: { source: { in: [...DOC_SOURCES] }, ...LIVE }, select: { lines: { select: { accountId: true, companyId: true, debit: true, credit: true, account: { select: { id: true, name: true, systemKey: true, type: true } } } } } },
    },
  });
  const taxByRate = new Map<number, { taxable: number; cgst: number; sgst: number; igst: number }>();
  for (const d of docs) {
    if (exported.has(`DOCUMENT:${d.id}`)) continue;
    const type = VOUCHER_TYPE[d.docType as SalesDocType];
    const lines = netLines(d.journalEntries);
    if (!lines.length) {
      plan.skipped.push({ label: d.docNumber, why: "Nothing was posted to the ledger for it" });
      continue;
    }
    const where = `${type} ${d.docNumber}`;
    const partyLines = lines.filter((l) => l.account.systemKey === "AR");
    const others = lines.filter((l) => l.account.systemKey !== "AR");
    if (partyLines.length !== 1) {
      plan.skipped.push({ label: d.docNumber, why: "Its receivable isn't one line for one customer" });
      continue;
    }
    const party = partyFor(d.company, {
      gstin: d.buyerGstin,
      state: d.billingState,
      address: [d.billingLine1, d.billingLine2, d.billingCity].filter((s): s is string => !!s),
      pincode: d.billingPincode,
      country: d.billingCountry,
    });
    const partyAmount = partyLines[0]!.amount;
    const bills: BillRef[] =
      d.docType === "CREDIT_NOTE"
        ? creditNoteBills(d.docNumber, partyAmount, d.creditsApplied.map((a) => ({ invoice: a.invoice.docNumber, amount: num(a.amount) })), d.againstDocument?.docNumber ?? null)
        : [{ name: d.docNumber, type: "New Ref", amount: partyAmount }];
    const ledgers: LedgerLine[] = [{ ledger: party, amount: partyAmount, party: true, bills }];

    // Item lines: the one income line spread over the document's lines, each to its item.
    let inventory: InventoryLine[] | undefined;
    const income = others.filter((l) => l.account.type === "INCOME");
    const taxable = round(d.lines.reduce((t, l) => t + num(l.taxableValue), 0));
    if (opts.itemLines && d.currency === "INR") {
      const fits = income.length === 1 && Math.abs(Math.abs(income[0]!.amount) - taxable) < 0.01 && d.lines.every((l) => num(l.quantity) > 0);
      if (fits) {
        const sign = Math.sign(income[0]!.amount);
        inventory = d.lines.map((l) => {
          const unit = unitOf(l.unit);
          units.add(unit);
          const amount = sign * num(l.taxableValue);
          return { item: itemFor(l), unit, quantity: num(l.quantity), rate: round(num(l.taxableValue) / num(l.quantity)), amount: round(amount), ledger: rateLedger(book, income[0]!.account, num(l.taxRatePercent)) ?? ledgerFor(income[0]!.account, where) };
        });
        // Paise lost to rounding go on the last line, so the voucher still comes to the income line exactly.
        const diff = round(income[0]!.amount - inventory.reduce((t, i) => t + i.amount, 0));
        if (diff !== 0) inventory[inventory.length - 1]!.amount = round(inventory[inventory.length - 1]!.amount + diff);
      } else plan.summary.withoutItems.push(`${d.docNumber}: ${income.length !== 1 ? "its value went to more than one income account" : "its lines don't add up to what was posted"}`);
    }
    for (const l of others) {
      if (inventory && l === income[0]) continue;
      const split = taxSplit(book, l, d.lines);
      if (split) for (const s of split) ledgers.push(s);
      else ledgers.push({ ledger: ledgerFor(l.account, where), amount: l.amount });
    }
    const v: Voucher = {
      type,
      number: d.docNumber,
      date: clock.today(d.issueDate),
      party,
      reference: d.reference ?? undefined,
      narration: `${type} ${d.docNumber} — raised in Deskzo`,
      irn: d.irn,
      ackNo: d.ackNo,
      ackDate: d.ackDate ? clock.today(d.ackDate) : null,
      ewayBill: d.ewayBills[0]?.ewayBillNumber ?? null,
      ledgers,
      inventory,
    };
    if (!balances(v)) {
      plan.skipped.push({ label: d.docNumber, why: "Its lines don't balance" });
      continue;
    }
    plan.vouchers.push(v);
    plan.records.push({ kind: "DOCUMENT", recordId: d.id, voucherType: type, voucherNumber: d.docNumber });
    const sign = d.docType === "CREDIT_NOTE" ? -1 : 1;
    for (const l of d.lines) {
      const rate = num(l.taxRatePercent);
      const t = taxByRate.get(rate) ?? { taxable: 0, cgst: 0, sgst: 0, igst: 0 };
      t.taxable += sign * num(l.taxableValue);
      t.cgst += sign * num(l.cgstAmount);
      t.sgst += sign * num(l.sgstAmount);
      t.igst += sign * num(l.igstAmount);
      taxByRate.set(rate, t);
    }
  }

  // ─── Customer receipts ─────────────────────────────────────────────────────────────────────────────────────────
  const migrated = new Set((await db.migrationRecord.findMany({ where: { kind: "payment" }, select: { recordId: true } }).catch(() => [])).map((r) => r.recordId));
  const payments = await db.payment.findMany({
    where: { direction: "RECEIVED", paidOn: { gte: fromAt, lt: toAt } },
    orderBy: [{ paidOn: "asc" }, { paymentSeq: "asc" }],
    take: 5000,
    select: {
      id: true,
      paymentSeq: true,
      paidOn: true,
      reference: true,
      notes: true,
      currency: true,
      company: { select: { id: true, name: true } },
      allocations: { select: { amount: true, document: { select: { docNumber: true } } } },
      journalEntries: { where: { source: "PAYMENT", ...LIVE }, select: { lines: { select: { accountId: true, companyId: true, debit: true, credit: true, account: { select: { id: true, name: true, systemKey: true, type: true } } } } } },
    },
  });
  for (const p of payments) {
    if (exported.has(`PAYMENT:${p.id}`) || migrated.has(p.id)) continue;
    const number = formatPaymentId(p.paymentSeq);
    const lines = netLines(p.journalEntries);
    if (!lines.length) {
      plan.skipped.push({ label: number, why: "Nothing was posted to the ledger for it" });
      continue;
    }
    const partyLines = lines.filter((l) => l.account.systemKey === "AR");
    if (partyLines.length !== 1) {
      plan.skipped.push({ label: number, why: "Its receivable isn't one line for one customer" });
      continue;
    }
    const where = `Receipt ${number}`;
    const party = partyFor(p.company, {});
    const partyAmount = partyLines[0]!.amount;
    const bills = p.currency === "INR" ? receiptBills(partyAmount, p.allocations.filter((a) => a.document).map((a) => ({ invoice: a.document!.docNumber, amount: num(a.amount) }))) : [{ name: number, type: "On Account" as const, amount: partyAmount }];
    const ledgers: LedgerLine[] = [{ ledger: party, amount: partyAmount, party: true, bills }];
    for (const l of lines) if (l.account.systemKey !== "AR") ledgers.push({ ledger: ledgerFor(l.account, where), amount: l.amount });
    const v: Voucher = { type: "Receipt", number, date: clock.today(p.paidOn), party, reference: p.reference ?? undefined, narration: [p.reference, p.notes].filter(Boolean).join(" — ").slice(0, 500) || undefined, ledgers };
    if (!balances(v)) {
      plan.skipped.push({ label: number, why: "Its lines don't balance" });
      continue;
    }
    plan.vouchers.push(v);
    plan.records.push({ kind: "PAYMENT", recordId: p.id, voucherType: "Receipt", voucherNumber: number });
  }

  plan.unmatched = [...unmatched.values()];
  plan.masters = { parties: [...newParties.values()], units: [...units], items: [...newItems.values()] };
  plan.created = [...created.entries()].map(([key, name]) => ({ key, name }));
  plan.summary = { ...plan.summary, ...summarise(plan.vouchers), taxByRate: [...taxByRate.entries()].sort((a, b) => a[0] - b[0]).map(([rate, t]) => ({ rate, taxable: round(t.taxable), cgst: round(t.cgst), sgst: round(t.sgst), igst: round(t.igst) })), newParties: newParties.size, newItems: newItems.size };
  return plan;
}

/** Tally wants a unit on every item line: the line's, else "Nos". */
const unitOf = (unit: string | null) => (unit?.trim() ? unit.trim().slice(0, 20) : "Nos");

/** An income or tax account's ledger for one GST rate, where the mapping has one. */
function rateLedger(book: NameBook, account: { id: string }, rate: number): string | null {
  return book.mapping.get(accountKey(account.id, rate)) ?? null;
}

/** An output tax line split by rate, when every rate in it has its own Tally ledger and the lines add up to it. */
function taxSplit(book: NameBook, line: Line, docLines: { taxRatePercent: unknown; cgstAmount: unknown; sgstAmount: unknown; igstAmount: unknown }[]): LedgerLine[] | null {
  const field = line.account.systemKey === "OUTPUT_CGST" ? "cgstAmount" : line.account.systemKey === "OUTPUT_SGST" ? "sgstAmount" : line.account.systemKey === "OUTPUT_IGST" ? "igstAmount" : null;
  if (!field) return null;
  const byRate = new Map<number, number>();
  for (const l of docLines) {
    const v = num(l[field]);
    if (v) byRate.set(num(l.taxRatePercent), (byRate.get(num(l.taxRatePercent)) ?? 0) + v);
  }
  if (!byRate.size || ![...byRate.keys()].every((r) => rateLedger(book, line.account, r))) return null;
  const total = [...byRate.values()].reduce((t, v) => t + v, 0);
  if (Math.abs(Math.abs(line.amount) - total) >= 0.01) return null;
  const sign = Math.sign(line.amount);
  return [...byRate.entries()].map(([rate, v]) => ({ ledger: rateLedger(book, line.account, rate)!, amount: round(sign * v) }));
}

/** A credit note's bills: against each invoice it was applied to; what's left against its invoice, else a new reference. */
export function creditNoteBills(number: string, partyAmount: number, applied: { invoice: string; amount: number }[], against: string | null): BillRef[] {
  const sign = Math.sign(partyAmount) || 1;
  const bills: BillRef[] = applied.filter((a) => a.amount > 0).map((a) => ({ name: a.invoice, type: "Agst Ref" as const, amount: round(sign * a.amount) }));
  const rest = round(partyAmount - bills.reduce((t, b) => t + b.amount, 0));
  if (Math.abs(rest) >= 0.005) bills.push(against && !applied.length ? { name: against, type: "Agst Ref", amount: rest } : { name: number, type: "New Ref", amount: rest });
  return bills;
}

/** A receipt's bills: against each invoice it paid, the rest on account. */
export function receiptBills(partyAmount: number, allocations: { invoice: string; amount: number }[]): BillRef[] {
  const sign = Math.sign(partyAmount) || 1;
  const byInvoice = new Map<string, number>();
  for (const a of allocations) if (a.amount > 0) byInvoice.set(a.invoice, (byInvoice.get(a.invoice) ?? 0) + a.amount);
  const bills: BillRef[] = [...byInvoice.entries()].map(([invoice, amount]) => ({ name: invoice, type: "Agst Ref" as const, amount: round(sign * amount) }));
  const rest = round(partyAmount - bills.reduce((t, b) => t + b.amount, 0));
  if (Math.abs(rest) >= 0.005) bills.push({ name: "On Account", type: "On Account", amount: rest });
  return bills;
}

function summarise(vouchers: Voucher[]): Pick<ExportSummary, "byType" | "byParty"> {
  const byType = new Map<string, { count: number; value: number; first: string | null; last: string | null }>();
  const byParty = new Map<string, number>();
  for (const v of vouchers) {
    const party = v.ledgers.find((l) => l.party);
    const value = Math.abs(party?.amount ?? 0);
    const t = byType.get(v.type) ?? { count: 0, value: 0, first: null, last: null };
    t.count += 1;
    t.value = round(t.value + value);
    t.first ??= v.number;
    t.last = v.number;
    byType.set(v.type, t);
    byParty.set(v.party, round((byParty.get(v.party) ?? 0) - (party?.amount ?? 0)));
  }
  return {
    byType: [...byType.entries()].map(([type, t]) => ({ type, ...t })),
    byParty: [...byParty.entries()].map(([party, value]) => ({ party, value })).sort((a, b) => a.party.localeCompare(b.party)),
  };
}
