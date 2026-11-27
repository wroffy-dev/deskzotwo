import { Prisma, type PaymentMethod } from "@prisma/client";
import { archivedHint } from "./archived-hint";
import { db } from "@/lib/db";
import { normalizeCompanyName } from "@/lib/company-name";
import { postGroupTransferToLedger, postPaymentToLedger, writeEntry } from "@/lib/ledger/journal";
import { groupCompaniesOf } from "@/lib/companies/groups";
import { DOCUMENT_EXTRA_COLUMNS, type HistoryWindow } from "@/lib/portability/documents";
import { RowReader } from "@/lib/portability/importers/types";
import type { workspaceClock } from "@/lib/time/workspace";
import { refreshSettledStatus, settlementOf, type UnitOutcome } from "./documents";
import { findParty } from "./ledger";
import { accountAliases } from "./accounts";

/**
 * A migrated year's payments (src/lib/migration): customer receipts, and payments made to vendors. Each on
 * the day the money moved, applied to the invoices or bills the file names, and posted as Record payment would
 * post it — money in and Receivables down, or Payables down and money out — with nothing else that recording
 * one sets off (no workflow, no order booked, no receipt emailed).
 *
 *   · **One row a document it paid**, as Zoho Books exports payments: rows sharing a payment number are one
 *     payment, its amount and date read from the first; each row with an invoice or bill says how much went
 *     to it. A single one with no amount applied takes as much of the payment as it still owed.
 *   · **What isn't applied stays on account**, as an advance does.
 *   · **The invoice or bill must be in Deskzo**, for the same party — brought across in this migration, or
 *     still open from before the year (the open-documents import). A bill is named by the vendor's own number,
 *     as the old system shows it.
 *   · The bank account it went into or came out of, by name, when the file says; cash when it says cash;
 *     otherwise where Record payment would put it.
 */

export type PaymentSide = "RECEIVED" | "PAID";

export const RECEIPT_COLUMNS = {
  number: "Payment number",
  date: "Date",
  party: "Customer",
  amount: "Amount",
  mode: "Mode",
  reference: "Reference",
  depositTo: "Deposit to",
  invoice: "Invoice",
  applied: "Amount applied",
  notes: "Notes",
} as const;
type Columns = { [K in keyof typeof RECEIPT_COLUMNS]: string };

/** A vendor payment's own words for the same columns. */
export const VENDOR_PAYMENT_COLUMNS: Columns = { ...RECEIPT_COLUMNS, party: "Vendor", depositTo: "Paid through", invoice: "Bill" };

const columnsOf = (side: PaymentSide): Columns => (side === "RECEIVED" ? RECEIPT_COLUMNS : VENDOR_PAYMENT_COLUMNS);

/** The usual headings, Zoho Books' payments among them. To be tightened against a real backup. */
function aliasesOf(side: PaymentSide): Record<string, string[]> {
  const C = columnsOf(side);
  const shared = {
    [C.number]: ["Payment Number", "Payment #", "Payment No", ...(side === "RECEIVED" ? ["Receipt Number", "Receipt No"] : ["Vendor Payment Number", "Vendor Payment #"])],
    [C.date]: ["Payment Date", ...(side === "RECEIVED" ? ["Receipt Date"] : [])],
    [C.amount]: ["Payment Amount", side === "RECEIVED" ? "Amount Received" : "Amount Paid", "Total Amount"],
    [C.mode]: ["Payment Mode", "Mode of Payment", "Payment Method"],
    [C.reference]: ["Reference Number", "Reference#", "Reference No", "Cheque Number", "UTR", "Transaction ID"],
    [C.applied]: [`Amount Applied to ${side === "RECEIVED" ? "Invoice" : "Bill"}`, "Applied Amount", `${side === "RECEIVED" ? "Invoice" : "Bill"} Payment Amount`, "Amount Applied", "Payment Applied"],
    [C.notes]: ["Description", "Remarks", side === "RECEIVED" ? "Customer Notes" : "Vendor Notes"],
  };
  return side === "RECEIVED"
    ? {
        ...shared,
        [C.party]: ["Customer Name", "Party Name", "Company Name"],
        [C.depositTo]: ["Deposit To", "Paid Through", "Bank Account", "Deposited To"],
        [C.invoice]: ["Invoice Number", "Invoice#", "Invoice No", "Applied Invoice Number"],
      }
    : {
        ...shared,
        [C.party]: ["Vendor Name", "Supplier Name", "Supplier", "Party Name"],
        [C.depositTo]: ["Paid Through", "Paid From", "Bank Account", "Payment Account"],
        [C.invoice]: ["Bill Number", "Bill#", "Bill No", "Applied Bill Number", "Vendor Invoice Number"],
      };
}

export const paymentHeadings = (side: PaymentSide) => ({ templateColumns: Object.values(columnsOf(side)), headerAliases: aliasesOf(side) });
export const paymentColumns = (side: PaymentSide): string[] => Object.values(columnsOf(side));

/**
 * Where money went in or came out, as the old chart's map reads the account the file names — null when the map
 * doesn't name it. Deskzo's own Bank Accounts means wherever Record payment would put it.
 */
async function mappedMoney(migrationId: string, through: string): Promise<{ cash: boolean; bankAccountId: string | null } | { error: string } | null> {
  const accountId = (await accountAliases(migrationId)).get(through.trim().toLowerCase());
  if (!accountId) return null;
  const account = await db.ledgerAccount.findUnique({ where: { id: accountId }, select: { name: true, systemKey: true, bankAccount: { select: { id: true } } } });
  if (!account) return null;
  if (account.bankAccount) return { cash: false, bankAccountId: account.bankAccount.id };
  if (account.systemKey === "CASH") return { cash: true, bankAccountId: null };
  if (account.systemKey === "BANK") return { cash: false, bankAccountId: null };
  return { error: `"${through}" is read as ${account.name}, which isn't a bank or cash account — change it in the old chart's map.` };
}

export type ReceiptGroup = { number: string; firstLine: number; rows: { line: number; row: Record<string, string> }[] };

/** Rows sharing a payment number, in file order; a row with no number belongs to the payment above it. */
export function receiptUnits(rows: Record<string, string>[]): ReceiptGroup[] {
  const groups: ReceiptGroup[] = [];
  const byNumber = new Map<string, ReceiptGroup>();
  rows.forEach((row, i) => {
    const number = (row[RECEIPT_COLUMNS.number] ?? "").trim();
    const group = number ? byNumber.get(number) : groups[groups.length - 1];
    if (group) group.rows.push({ line: i + 2, row });
    else {
      const made: ReceiptGroup = { number, firstLine: i + 2, rows: [{ line: i + 2, row }] };
      groups.push(made);
      if (number) byNumber.set(number, made);
    }
  });
  return groups;
}

export function methodOf(text: string): PaymentMethod {
  const t = text.trim().toLowerCase();
  if (/cash/.test(t)) return "CASH";
  if (/cheque|check|\bdd\b|demand draft/.test(t)) return "CHEQUE";
  if (/upi|gpay|phonepe|paytm/.test(t)) return "UPI";
  if (/card/.test(t)) return "CARD";
  if (/bank|neft|rtgs|imps|transfer|wire|ach/.test(t)) return "BANK_TRANSFER";
  return "OTHER";
}

/** A migrated bill as the vendor numbered it (src/lib/migration/purchases.ts). */
export const billKey = (vendorName: string, number: string) => `BILL:${normalizeCompanyName(vendorName)}:${number.trim()}`;

type Clock = Awaited<ReturnType<typeof workspaceClock>>;
type Ctx = { migrationId: string; window: HistoryWindow; clock: Clock; userId: string };
type Ready = {
  companyId: string;
  partyName: string;
  amount: number;
  paidOn: Date;
  method: PaymentMethod;
  reference: string | null;
  notes: string | null;
  bankAccountId: string | null;
  branchId: string | null;
  allocations: { documentId: string; number: string; amount: number }[];
  /** A customer's TDS withheld from the payment: a receipt of its own, posted to TDS Receivable, applied as the file says. */
  tds: number;
  tdsAllocations: { documentId: string; number: string; amount: number }[];
  /** The documents it was paid ahead of — an advance set against them once they were raised. */
  ahead: string[];
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
/** A receipt keeps its number as its key, as it always has; a vendor payment's is told apart from it. */
const recordKey = (side: PaymentSide, number: string) => (side === "RECEIVED" ? number : `PAID:${number}`);

/**
 * The invoice or bill a row names, for that party: a migrated bill by the vendor's number, else the document number. An
 * invoice not under the party may be under another company in its customer group (owner, 17 Nov 2026 — one legal entity
 * pays, another holds the licence: src/lib/companies/groups.ts) — the money is then set against it across the group.
 */
async function documentNamed(side: PaymentSide, number: string, party: { id: string; name: string }, migrationId: string) {
  const select = { id: true, branchId: true, issueDate: true } as const;
  const live = { status: { notIn: ["DRAFT", "CANCELLED"] as ("DRAFT" | "CANCELLED")[] } };
  if (side === "RECEIVED") {
    const own = await db.tradeDocument.findFirst({ where: { docNumber: number, docType: "INVOICE", companyId: party.id, ...live }, select });
    if (own) return own;
    const group = await groupCompaniesOf(party.id);
    if (!group.length) return null;
    // Rupees only across the group (src/lib/companies/groups.ts).
    return db.tradeDocument.findFirst({ where: { docNumber: number, docType: "INVOICE", companyId: { in: group.map((c) => c.id) }, currency: "INR", ...live }, select });
  }
  const record = await db.migrationRecord.findUnique({ where: { migrationId_kind_key: { migrationId, kind: "document", key: billKey(party.name, number) } }, select: { recordId: true } });
  return db.tradeDocument.findFirst({ where: { ...(record ? { id: record.recordId } : { docNumber: number }), docType: "BILL", companyId: party.id, ...live }, select });
}

async function resolvePayment(side: PaymentSide, group: ReceiptGroup, ctx: Ctx): Promise<{ error: string; line?: number } | { skip: string } | Ready> {
  const C = columnsOf(side);
  const doc = side === "RECEIVED" ? "invoice" : "bill";
  if (!group.number) return { error: `${C.number} is required — each payment keeps the number it had.` };
  const done = await db.migrationRecord.findUnique({ where: { migrationId_kind_key: { migrationId: ctx.migrationId, kind: "payment", key: recordKey(side, group.number) } }, select: { id: true } });
  if (done) return { skip: "already brought across" };

  const head = new RowReader(group.rows[0]!.row, ctx.clock);
  const partyName = head.text(C.party);
  const paidOn = head.date(C.date);
  const amount = head.number(C.amount);
  if (head.error) return { error: head.error };
  const partyId = head.text(DOCUMENT_EXTRA_COLUMNS.partyId);
  if (!partyName && !partyId) return { error: `${C.party} is required.` };
  if (!paidOn) return { error: `${C.date} is required — the day the money ${side === "RECEIVED" ? "came in" : "went out"}.` };
  const day = paidOn.toISOString().slice(0, 10);
  if (day < ctx.window.from || day >= ctx.window.to) return { error: `It's dated ${day}, outside the year being brought across (${ctx.window.from} to the day before ${ctx.window.to}).` };
  if (amount === undefined || amount <= 0) return { error: `${C.amount} must be more than 0.` };
  // What the old system took out of the payment on its way settled the invoice too. A customer's TDS comes across
  // as a receipt of its own (owner, 27 Oct 2026 — below); the bank's charges, and TDS on a vendor payment, a Deskzo
  // payment has no place for: refused, rather than leave the document owing what was settled.
  const withheld = head.number(DOCUMENT_EXTRA_COLUMNS.withheld) ?? 0;
  const charges = head.number(DOCUMENT_EXTRA_COLUMNS.bankCharges) ?? 0;
  if ((side === "PAID" && withheld > 0) || charges > 0) {
    const tdsToo = side === "PAID" && withheld > 0;
    const what = [tdsToo ? `${rupees(withheld)} of TDS withheld` : "", charges > 0 ? `${rupees(charges)} of bank charges` : ""].filter(Boolean).join(" and ");
    return { error: `The old system took ${what} out of this payment, which a Deskzo payment doesn't carry. Bring the payment without it, and the ${tdsToo ? "TDS" : "charges"} as a journal (${tdsToo ? "TDS Payable" : "Bank Fees"} against the ${side === "RECEIVED" ? "customer" : "vendor"}).` };
  }

  const party = await findParty(partyName, partyId);
  if (!party) return { error: `No ${side === "RECEIVED" ? "customer" : "vendor"} named "${partyName}". Import ${side === "RECEIVED" ? "Companies" : "Vendors"} first, or correct the spelling.` };

  const through = head.text(C.depositTo);
  let cash = /^(petty\s*)?cash(\s+in\s+hand)?$/i.test(through);
  let bankAccountId: string | null = null;
  // The old chart's map first (./accounts.ts): Zoho's Undeposited Funds is read as the bank, its banks as Deskzo's.
  const mapped = through && !cash ? await mappedMoney(ctx.migrationId, through) : null;
  if (mapped && "error" in mapped) return { error: mapped.error };
  if (mapped) {
    cash = mapped.cash;
    bankAccountId = mapped.bankAccountId;
  } else if (through && !cash) {
    const bank = await db.bankAccount.findFirst({ where: { name: { equals: through, mode: "insensitive" } }, select: { id: true } });
    if (!bank) return { error: `No bank account named "${through}". Add it under Accounting › Banking first, or leave ${C.depositTo} blank.` };
    bankAccountId = bank.id;
  }

  // What each document it names was paid: the file's amount, else — one alone — what it still owed. A customer's
  // TDS is on each invoice's row, beside what was applied to it.
  const allocations: Ready["allocations"] = [];
  const tdsAllocations: Ready["tdsAllocations"] = [];
  let branchId: string | null = null;
  const named = group.rows.filter((r) => (r.row[C.invoice] ?? "").trim());
  const read: { line: number; number: string; applied: number | undefined; tds: number }[] = [];
  const ahead: string[] = [];
  for (const { line, row } of named) {
    const r = new RowReader(row, ctx.clock);
    const number = r.text(C.invoice);
    const applied = r.number(C.applied);
    const tds = side === "RECEIVED" ? (r.number(DOCUMENT_EXTRA_COLUMNS.withheld) ?? 0) : 0;
    if (r.error) return { error: r.error, line };
    if (tds < 0) return { error: `${DOCUMENT_EXTRA_COLUMNS.withheld} can't be negative.`, line };
    read.push({ line, number, applied, tds });
  }
  // Whether the amount applied to each invoice counts its TDS as well as the money: it does when what is applied comes
  // to more than the payment, and to no more once the TDS is taken out — the money is the payment's amount either way.
  const sumApplied = read.reduce((n, x) => n + (x.applied ?? 0), 0);
  const sumTds = read.reduce((n, x) => n + x.tds, 0);
  const appliedHasTds = sumTds > 0 && sumApplied > amount + 0.01 && sumApplied - sumTds <= amount + 0.01;
  for (const { line, number, applied: given, tds } of read) {
    const applied = given === undefined ? undefined : appliedHasTds ? round2(given - tds) : given;
    const found = await documentNamed(side, number, party, ctx.migrationId);
    if (!found) {
      const hint = await archivedHint(side === "RECEIVED" ? "INVOICE" : "BILL", number, party.id);
      return { error: `${side === "RECEIVED" ? "Invoice" : "Bill"} ${number} for ${party.name} isn't in Deskzo.${hint || ` Bring the ${doc}s across first.`}`, line };
    }
    // Paid ahead (owner, 28 Oct 2026): an advance — against a proforma, say — the old system set against the invoice
    // once it was raised. It comes on its own date, on account until then, and is set against the invoice as there.
    if (found.issueDate > paidOn) ahead.push(number);
    const owed = (await settlementOf(db, found.id))?.settlement.balance ?? 0;
    const amountFor = applied ?? (named.length === 1 ? Math.max(0, Math.min(amount, owed - tds)) : undefined);
    if (amountFor === undefined) return { error: `It pays ${named.length} ${doc}s — give ${C.applied} on each row.`, line };
    if (amountFor < 0) return { error: `${C.applied} can't be negative.`, line };
    if (amountFor + tds > owed + 1) return { error: `${rupees(amountFor + tds)}${tds > 0 ? ` (with ${rupees(tds)} of TDS)` : ""} is more than ${doc} ${number} still owed (${rupees(owed)}).`, line };
    if (amountFor > 0) allocations.push({ documentId: found.id, number, amount: round2(Math.min(amountFor, owed)) });
    if (tds > 0) tdsAllocations.push({ documentId: found.id, number, amount: round2(Math.min(tds, owed - Math.min(amountFor, owed))) });
    branchId ??= found.branchId;
  }
  const allocated = round2(allocations.reduce((n, a) => n + a.amount, 0));
  if (allocated > amount + 0.01) return { error: `It applies ${rupees(allocated)} to ${doc}s, more than the payment's ${rupees(amount)}.` };
  // TDS the file gives with no invoice named stays on account, as money not applied does.
  const tds = round2(named.length ? tdsAllocations.reduce((n, a) => n + a.amount, 0) : side === "RECEIVED" ? withheld : 0);

  return {
    companyId: party.id,
    partyName: party.name,
    amount: round2(amount),
    paidOn,
    method: cash ? "CASH" : methodOf(head.text(C.mode)),
    reference: head.text(C.reference).slice(0, 120) || null,
    notes: head.text(C.notes).slice(0, 1000) || null,
    bankAccountId,
    branchId,
    allocations,
    tds,
    tdsAllocations,
    ahead,
  };
}

export async function checkPayment(side: PaymentSide, group: ReceiptGroup, ctx: Ctx): Promise<UnitOutcome> {
  const label = group.number || `Row ${group.firstLine}`;
  const r = await resolvePayment(side, group, ctx);
  if ("error" in r) return { kind: "error", label, line: r.line ?? group.firstLine, error: r.error };
  if ("skip" in r) return { kind: "skip", label, why: r.skip };
  const applied = r.allocations.reduce((n, a) => n + a.amount, 0);
  const onAccount = round2(r.amount - applied);
  return {
    kind: "create",
    label: `${group.number} · ${r.partyName}`,
    detail: `${r.paidOn.toISOString().slice(0, 10)} · ${rupees(r.amount)}${r.allocations.length ? ` to ${r.allocations.map((a) => a.number).join(", ")}` : ""}${onAccount > 0 ? ` · ${rupees(onAccount)} on account` : ""}${r.tds > 0 ? ` · ${rupees(r.tds)} TDS withheld, to TDS Receivable` : ""}${r.ahead.length ? ` · paid ahead of ${r.ahead.join(", ")}` : ""}`,
  };
}

/**
 * The TDS a customer withheld from a payment (owner, 27 Oct 2026): a receipt of its own beside the money — method
 * Other, "TDS withheld" — applied to the invoices as the file says, and posted Dr TDS / TCS Receivable, Cr the
 * customer's receivable. No bank sees it. Recorded against the migration, so Undo takes it back with the payment.
 */
async function recordTds(tx: Prisma.TransactionClient, r: Ready, number: string, key: string, ctx: Ctx) {
  const [receivable, tdsAccount] = await Promise.all([
    tx.ledgerAccount.findFirst({ where: { systemKey: "AR" }, select: { id: true } }),
    tx.ledgerAccount.findFirst({ where: { systemKey: "TDS_RECEIVABLE" }, select: { id: true } }),
  ]);
  if (!receivable || !tdsAccount) throw new Error("Deskzo's chart has no Accounts Receivable or TDS / TCS Receivable account to post the TDS to.");
  const held = await tx.payment.create({
    data: {
      companyId: r.companyId,
      branchId: r.branchId,
      direction: "RECEIVED",
      amount: new Prisma.Decimal(r.tds),
      paidOn: r.paidOn,
      method: "OTHER",
      reference: "TDS withheld",
      notes: `TDS ${r.partyName} withheld from payment ${number}`,
      bankAccountId: null,
      recordedByUserId: ctx.userId,
    },
    select: { id: true },
  });
  for (const a of r.tdsAllocations) {
    const row = await tx.paymentAllocation.create({ data: { paymentId: held.id, documentId: a.documentId, amount: new Prisma.Decimal(a.amount), allocatedByUserId: ctx.userId }, select: { id: true } });
    // Another group company's invoice: the TDS moves to its account too.
    await postGroupTransferToLedger(tx, { allocationId: row.id, paymentId: held.id, documentId: a.documentId, amount: a.amount, date: r.paidOn, userId: ctx.userId });
  }
  const entry = await writeEntry(tx, {
    date: r.paidOn,
    narration: `TDS withheld by ${r.partyName} from payment ${number}`,
    source: "PAYMENT",
    userId: ctx.userId,
    paymentId: held.id,
    companyId: r.companyId,
    branchId: r.branchId,
    lines: [
      { accountId: tdsAccount.id, debit: r.tds, credit: 0, companyId: r.companyId },
      { accountId: receivable.id, debit: 0, credit: r.tds, companyId: r.companyId },
    ],
  });
  await tx.migrationRecord.create({ data: { migrationId: ctx.migrationId, kind: "payment", recordId: held.id, key: `${key}:TDS` } });
  await tx.migrationRecord.create({ data: { migrationId: ctx.migrationId, kind: "journal", recordId: entry.id, key: `PAYMENT:${key}:TDS:entry` } });
}

export async function applyPayment(side: PaymentSide, group: ReceiptGroup, ctx: Ctx): Promise<UnitOutcome> {
  const label = group.number || `Row ${group.firstLine}`;
  const r = await resolvePayment(side, group, ctx);
  if ("error" in r) return { kind: "error", label, line: r.line ?? group.firstLine, error: r.error };
  if ("skip" in r) return { kind: "skip", label, why: r.skip };
  const key = recordKey(side, group.number);
  try {
    await db.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          companyId: r.companyId,
          branchId: r.branchId,
          direction: side,
          amount: new Prisma.Decimal(r.amount),
          paidOn: r.paidOn,
          method: r.method,
          reference: r.reference,
          notes: r.notes,
          bankAccountId: r.bankAccountId,
          recordedByUserId: ctx.userId,
        },
        select: { id: true },
      });
      const made: { id: string; documentId: string; amount: number }[] = [];
      for (const a of r.allocations) {
        const row = await tx.paymentAllocation.create({ data: { paymentId: payment.id, documentId: a.documentId, amount: new Prisma.Decimal(a.amount), allocatedByUserId: ctx.userId }, select: { id: true } });
        made.push({ id: row.id, documentId: a.documentId, amount: a.amount });
      }
      const entry = await postPaymentToLedger(tx, payment.id, ctx.userId);
      // Set against another group company's invoice: the money moves to its account (nothing for the party's own).
      if (side === "RECEIVED") {
        for (const a of made) await postGroupTransferToLedger(tx, { allocationId: a.id, paymentId: payment.id, documentId: a.documentId, amount: a.amount, date: r.paidOn, userId: ctx.userId });
      }
      await tx.migrationRecord.create({ data: { migrationId: ctx.migrationId, kind: "payment", recordId: payment.id, key } });
      if (entry) await tx.migrationRecord.create({ data: { migrationId: ctx.migrationId, kind: "journal", recordId: entry.id, key: `PAYMENT:${key}:entry` } });
      if (r.tds > 0) await recordTds(tx, r, group.number, key, ctx);
      for (const id of new Set([...r.allocations, ...r.tdsAllocations].map((a) => a.documentId))) await refreshSettledStatus(tx, id);
    });
  } catch (err) {
    return { kind: "error", label, line: group.firstLine, error: err instanceof Error ? err.message : "It couldn't be posted." };
  }
  return { kind: "create", label: `${group.number} · ${r.partyName}`, detail: `${rupees(r.amount)}${r.tds > 0 ? ` and ${rupees(r.tds)} TDS withheld` : ""}` };
}
