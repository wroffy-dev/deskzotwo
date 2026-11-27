import { db } from "@/lib/db";
import { isBaseCurrency } from "@/lib/currency";
import { rateFor } from "@/lib/finance/rates";
import { normalizeCompanyName } from "@/lib/company-name";
import { applyDocumentImport, DOCUMENT_COLUMNS, DOCUMENT_EXTRA_COLUMNS } from "@/lib/portability/documents";
import { HISTORY_COLUMNS } from "./documents";
import { VENDOR_CREDIT_COLUMNS } from "./purchases";
import { RECEIPT_COLUMNS, receiptUnits, VENDOR_PAYMENT_COLUMNS } from "./receipts";
import { neverOwed } from "./archive";
import { settlementOf } from "./documents";
import { MigrationRefused, takeBack, type MigrationRow } from "./state";

/**
 * The earlier years' invoices and bills still owing when the year began, opened in Deskzo from the archive (owner,
 * 27 Oct 2026) — what the open-documents import (Sales › Tax Invoices › Import, Purchase › Vendor bills › Import)
 * does from a file, without the file.
 *
 *   · **What it owed on the first day of the year** is what the old system shows owing now, plus what this year's
 *     payments, credit notes and vendor credits in the switch's own files set against it — those come across in
 *     their steps and settle it again here.
 *   · **Opened as the import opens one**: its own number and date, its total, the rest as settled before, and its
 *     balance posted on the year's first day against Opening Balance Equity — never sales or tax. One line,
 *     "Brought forward", since the archive keeps a document's figures, not its lines.
 *   · Only one whose party Deskzo has (the archive matched it); not one Deskzo has open already. The rest are
 *     listed with why. A hundred a time, so a big year is a few presses.
 *   · **One in a foreign currency** (owner, 17 Nov 2026) opens in that currency, at the workspace's rate for the
 *     year's first day (Settings › Currencies, src/lib/finance/rates.ts) — what a foreign balance is restated at when
 *     the year begins. With no rate for the day it is listed, to type one and press again.
 *   · Recorded against the migration, so Undo takes them back with the rest.
 *   · Never one void, a draft, rejected or waiting for approval in the old system (`neverOwed`): Zoho shows such an
 *     invoice's whole amount as its balance, which once opened void invoices here as owing (owner, 8 Nov 2026), and
 *     rejected ones (21 Nov 2026). `voidOpened` finds those, `takeBackVoidOpened` removes them.
 */

const C = DOCUMENT_COLUMNS;
const BATCH = 100;
type Kind = "INVOICE" | "BILL";
type Row = Record<string, string>;

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (text: string | undefined) => {
  const n = Number(String(text ?? "").replace(/[,₹\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
/** An invoice by its number alone; a bill by its number with its vendor, as vendors' numbers repeat. */
const keyOf = (kind: Kind, number: string, party: string) => (kind === "INVOICE" ? number.trim().toLowerCase() : `${normalizeCompanyName(party)}|${number.trim().toLowerCase()}`);

async function stepRows(migrationId: string, step: string): Promise<Row[]> {
  const files = await db.migrationFile.findMany({ where: { migrationId, step }, select: { rows: true } });
  return files.flatMap((f) => (Array.isArray(f.rows) ? (f.rows as Row[]) : []));
}

/** What this year's files set against each earlier document, by its key. */
async function laterApplied(migrationId: string, kind: Kind): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const add = (key: string, amount: number) => amount > 0 && map.set(key, round2((map.get(key) ?? 0) + amount));
  const P = kind === "INVOICE" ? RECEIPT_COLUMNS : VENDOR_PAYMENT_COLUMNS;
  for (const group of receiptUnits(await stepRows(migrationId, kind === "INVOICE" ? "receipts" : "vendor-payments"))) {
    const head = group.rows[0]!.row;
    const rows = group.rows.map(({ row }) => ({ number: (row[P.invoice] ?? "").trim(), applied: num(row[P.applied]), tds: kind === "INVOICE" ? num(row[DOCUMENT_EXTRA_COLUMNS.withheld]) : 0 }));
    // As the receipts step reads it: what is applied counts the TDS too when, without it, it fits the payment.
    const sumApplied = rows.reduce((n, r) => n + r.applied, 0);
    const sumTds = rows.reduce((n, r) => n + r.tds, 0);
    const amount = num(head[P.amount]);
    const hasTds = sumTds > 0 && sumApplied > amount + 0.01 && sumApplied - sumTds <= amount + 0.01;
    for (const r of rows) if (r.number) add(keyOf(kind, r.number, head[P.party] ?? ""), hasTds ? r.applied : r.applied + r.tds);
  }
  if (kind === "INVOICE") {
    const seen = new Set<string>();
    for (const row of await stepRows(migrationId, "credit-notes")) {
      const note = (row[C.number] ?? "").trim();
      if (!note || seen.has(note)) continue;
      seen.add(note);
      if (row[C.against]) add(keyOf(kind, row[C.against]!, ""), num(row[HISTORY_COLUMNS.applied]));
      for (const part of (row[DOCUMENT_EXTRA_COLUMNS.alsoApplied] ?? "").split("|")) {
        const [invoice, amount] = part.split("=");
        if (invoice?.trim()) add(keyOf(kind, invoice, ""), num(amount));
      }
    }
  } else {
    const V = VENDOR_CREDIT_COLUMNS;
    const seen = new Set<string>();
    for (const row of await stepRows(migrationId, "vendor-credits")) {
      const credit = (row[V.number] ?? "").trim();
      if (!credit || seen.has(credit)) continue;
      seen.add(credit);
      if (row[V.bill]) add(keyOf(kind, row[V.bill]!, row[V.party] ?? ""), num(row[V.applied]));
    }
  }
  return map;
}

export type OpenedOutcome = { opened: number; left: { number: string; party: string; why: string }[]; more: number };

/** Opens up to a hundred of the earlier years' invoices or bills still owing when the year began. */
export async function openFromArchive(m: MigrationRow, kind: Kind, userId: string): Promise<OpenedOutcome> {
  if (m.status !== "OPEN") throw new MigrationRefused("The migration isn't open.");
  const archived = await db.archivedDocument.findMany({
    where: { migrationId: m.id, kind },
    orderBy: [{ date: "asc" }, { number: "asc" }],
    select: { number: true, date: true, partyName: true, companyId: true, currency: true, status: true, total: true, balance: true },
  });
  const later = await laterApplied(m.id, kind);
  const companies = new Map((await db.company.findMany({ where: { id: { in: [...new Set(archived.flatMap((a) => (a.companyId ? [a.companyId] : [])))] } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  const left: OpenedOutcome["left"] = [];
  // One rate a currency for the whole press: the year's first day's.
  const rates = new Map<string, number | null>();
  const toOpen: { number: string; companyId: string; row: Row }[] = [];
  let more = 0;
  for (const a of archived) {
    if (neverOwed(a.status)) continue;
    const owed = round2(Number(a.balance ?? 0) + (later.get(keyOf(kind, a.number, a.partyName)) ?? 0));
    if (owed <= 0.5) continue;
    const open = await db.tradeDocument.findFirst({ where: { docNumber: a.number, docType: kind, ...(kind === "BILL" && a.companyId ? { companyId: a.companyId } : {}) }, select: { id: true } });
    if (open) continue;
    const name = a.companyId ? companies.get(a.companyId) : undefined;
    if (!name) {
      left.push({ number: a.number, party: a.partyName, why: "Deskzo doesn't have this party yet — bring it through the old-CRM import's master lists, then Match the archive again" });
      continue;
    }
    const currency = (a.currency ?? "").trim().toUpperCase();
    const foreign = !!currency && !isBaseCurrency(currency);
    if (foreign && !rates.has(currency)) rates.set(currency, (await rateFor(currency, m.yearStart))?.rate ?? null);
    const rate = foreign ? rates.get(currency) : 1;
    if (!rate) {
      left.push({ number: a.number, party: a.partyName, why: `In ${currency}, and Deskzo has no ${currency} rate for ${m.yearStart} — type one in Settings › Currencies, then press again` });
      continue;
    }
    const total = round2(Number(a.total));
    if (owed > total + 1) {
      const over = round2(owed - Number(a.balance ?? 0)).toLocaleString("en-IN", { minimumFractionDigits: 2 });
      left.push({ number: a.number, party: a.partyName, why: `This year's files set ${foreign ? `${currency} ${over}` : `₹${over}`} against it, more than it could have owed` });
      continue;
    }
    if (toOpen.length >= BATCH) {
      more += 1;
      continue;
    }
    toOpen.push({
      number: a.number,
      companyId: a.companyId!,
      row: {
        [C.number]: a.number,
        [C.date]: a.date.toISOString().slice(0, 10),
        [C.party]: name,
        [C.item]: "Brought forward",
        [C.description]: `${kind === "INVOICE" ? "Invoice" : "Bill"} ${a.number} from the old system, still owing when the year began`,
        [C.quantity]: "1",
        [C.rate]: String(total),
        [C.tax]: "0",
        [C.balance]: String(Math.min(owed, total)),
        ...(foreign ? { [DOCUMENT_EXTRA_COLUMNS.currency]: currency, [DOCUMENT_EXTRA_COLUMNS.exchangeRate]: String(rate) } : {}),
      },
    });
  }
  if (toOpen.length === 0) return { opened: 0, left, more };

  const started = new Date();
  const applied = await applyDocumentImport(kind, toOpen.map((t) => t.row), userId, { openingDate: m.yearStart });
  for (const f of applied.failed) {
    const t = toOpen[f.line - 2];
    if (t) left.push({ number: t.number, party: t.row[C.party]!, why: f.error });
  }
  // What it made, against the migration, so Undo takes it back.
  const made = await db.tradeDocument.findMany({
    where: { docType: kind, origin: "IMPORTED", createdAt: { gte: started }, OR: toOpen.map((t) => ({ docNumber: t.number, companyId: t.companyId })) },
    select: { id: true, docNumber: true, companyId: true },
  });
  for (const d of made) {
    await db.migrationRecord.upsert({
      where: { migrationId_kind_key: { migrationId: m.id, kind: "document", key: `OPENED:${kind}:${d.companyId}:${d.docNumber}` } },
      create: { migrationId: m.id, kind: "document", recordId: d.id, key: `OPENED:${kind}:${d.companyId}:${d.docNumber}` },
      update: {},
    });
  }
  return { opened: made.length, left, more };
}

/** `zohoStatus`: what the old system calls it — void, rejected, waiting for approval. */
export type VoidOpenedRow = { kind: Kind; number: string; party: string; date: string; owing: number; held: string | null; zohoStatus: string };
export type VoidOpened = { rows: VoidOpenedRow[]; owing: number; toTakeBack: number; held: number };
type Found = VoidOpenedRow & { recordId: string };

/**
 * What was opened from the archive though the old system shows it never owed — void, a draft, rejected or waiting for
 * approval (`neverOwed`). Those with anything set against them are held, for a person.
 */
async function findVoidOpened(migrationId: string): Promise<Found[]> {
  const records = await db.migrationRecord.findMany({ where: { migrationId, kind: "document", key: { startsWith: "OPENED:" } }, select: { id: true, recordId: true } });
  if (records.length === 0) return [];
  const documentIds = records.map((r) => r.recordId);
  const [docs, archived, paid, credited, children] = await Promise.all([
    db.tradeDocument.findMany({ where: { id: { in: documentIds } }, select: { id: true, docNumber: true, docType: true, companyId: true, issueDate: true, company: { select: { name: true } } } }),
    db.archivedDocument.findMany({ where: { migrationId, kind: { in: ["INVOICE", "BILL"] } }, select: { kind: true, number: true, companyId: true, status: true } }),
    db.paymentAllocation.findMany({ where: { documentId: { in: documentIds } }, select: { documentId: true } }),
    db.creditNoteApplication.findMany({ where: { invoiceId: { in: documentIds } }, select: { invoiceId: true } }),
    db.tradeDocument.findMany({ where: { OR: [{ sourceDocumentId: { in: documentIds } }, { againstDocumentId: { in: documentIds } }] }, select: { sourceDocumentId: true, againstDocumentId: true } }),
  ]);
  const isVoid = new Map(archived.filter((a) => neverOwed(a.status)).map((a) => [a.kind === "BILL" ? `BILL|${a.companyId}|${a.number}` : `INVOICE|${a.number}`, (a.status ?? "").replace(/_/g, " ")]));
  const hasPayment = new Set(paid.map((p) => p.documentId));
  const hasCredit = new Set(credited.map((c) => c.invoiceId));
  const hasChild = new Set(children.flatMap((c) => [c.sourceDocumentId, c.againstDocumentId]));
  const recordOf = new Map(records.map((r) => [r.recordId, r.id]));
  const found: Found[] = [];
  for (const d of docs) {
    const zohoStatus = isVoid.get(d.docType === "BILL" ? `BILL|${d.companyId}|${d.docNumber}` : `INVOICE|${d.docNumber}`);
    if (zohoStatus === undefined) continue;
    const held = hasPayment.has(d.id) ? "A payment is set against it" : hasCredit.has(d.id) ? "A credit note is set against it" : hasChild.has(d.id) ? "Another document was made from it" : null;
    found.push({
      recordId: recordOf.get(d.id)!,
      kind: d.docType as Kind,
      number: d.docNumber ?? "",
      party: d.company?.name ?? "",
      date: d.issueDate.toISOString().slice(0, 10),
      owing: round2((await settlementOf(db, d.id))?.settlement.balance ?? 0),
      held,
      zohoStatus,
    });
  }
  return found.sort((a, b) => b.owing - a.owing);
}

/** The list a person checks before anything goes. Changes nothing. */
export async function voidOpened(m: MigrationRow): Promise<VoidOpened> {
  const found = await findVoidOpened(m.id);
  const free = found.filter((f) => !f.held);
  return { rows: found.map((f) => ({ kind: f.kind, number: f.number, party: f.party, date: f.date, owing: f.owing, held: f.held, zohoStatus: f.zohoStatus })), owing: round2(free.reduce((n, f) => n + f.owing, 0)), toTakeBack: free.length, held: found.length - free.length };
}

/** Takes back up to a hundred of them, each with its opening entry, as Undo would. Found again here, never from what the page sent. */
export async function takeBackVoidOpened(m: MigrationRow): Promise<{ takenBack: number; owing: number; more: number }> {
  if (m.status !== "OPEN") throw new MigrationRefused("The migration isn't open.");
  const free = (await findVoidOpened(m.id)).filter((f) => !f.held);
  const batch = free.slice(0, BATCH);
  if (batch.length === 0) return { takenBack: 0, owing: 0, more: 0 };
  const taken = await takeBack(m.id, new Set(batch.map((f) => f.recordId)));
  return { takenBack: taken.documents, owing: round2(batch.reduce((n, f) => n + f.owing, 0)), more: free.length - batch.length };
}
