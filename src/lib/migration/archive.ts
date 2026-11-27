import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { baseCurrency } from "@/lib/currency";
import { legalNameKey, normalizeCompanyName } from "@/lib/company-name";
import { ZOHO_PARTY_KINDS } from "@/lib/legacy-import/links";
import { leftBehind, settlementOf } from "./documents";
import { MigrationRefused, type MigrationRow } from "./state";
import { readDay } from "./dates";
import { notMigratedYet } from "@/lib/not-migrated";
import { formerNameIndex } from "@/lib/companies/former-names";
import { documentKey } from "./zoho";
import type { StepKey } from "./steps";

/**
 * The old system's earlier years, kept to be read (ArchivedDocument; phase 3 of the Zoho plan, owner 26 Oct 2026:
 * "earlier years as a read-only archive"). Zoho's backup holds every year in one file; what is dated before the
 * year being brought across comes here, not into the books — those years are already summed up in the opening
 * balances — and so do the quotes, sales orders and purchase orders Zoho shows finished, whatever their year.
 *
 *   · **Read from Zoho's own rows**, as its backup has them: a document's lines, its total and what Zoho still
 *     showed owing; a payment's documents and what went to each.
 *   · **Its company** found by Zoho's id through what the master lists logged, else its name; kept by Zoho's name
 *     and id either way, so a company brought in later still finds its history.
 *   · **Uploading the file again** replaces what came from it — the same documents, never twice.
 *   · Seen on each company's page; counted in nothing else.
 */

type Row = Record<string, string>;

export const ARCHIVE_KINDS = ["QUOTE", "SALES_ORDER", "DELIVERY_CHALLAN", "INVOICE", "CREDIT_NOTE", "CUSTOMER_PAYMENT", "PURCHASE_ORDER", "BILL", "VENDOR_CREDIT", "VENDOR_PAYMENT"] as const;
export type ArchiveKind = (typeof ARCHIVE_KINDS)[number];
export const ARCHIVE_LABELS: Record<ArchiveKind, string> = {
  QUOTE: "Quote",
  SALES_ORDER: "Sales order",
  DELIVERY_CHALLAN: "Delivery challan",
  INVOICE: "Invoice",
  CREDIT_NOTE: "Credit note",
  CUSTOMER_PAYMENT: "Payment received",
  PURCHASE_ORDER: "Purchase order",
  BILL: "Bill",
  VENDOR_CREDIT: "Vendor credit",
  VENDOR_PAYMENT: "Payment made",
};

/** How each step's Zoho file reads as archived documents: its id, number, date, party and figures, by heading. */
type Spec = {
  kind: ArchiveKind;
  id: string;
  number: string;
  date: string;
  party: string;
  partyId?: string;
  status?: string;
  total: string;
  balance?: string;
  due?: string;
  reference?: string;
  /** A payment: the documents it paid, how much went to each, and — Zoho's pull — the TDS withheld and the day. */
  payment?: { number: string; amount: string; withheld?: string; on?: string };
  /** A document line's quantity and rate headings. */
  quantity?: string;
  rate?: string;
  tax?: string;
};
const SPECS: Partial<Record<StepKey, Spec>> = {
  invoices: { kind: "INVOICE", id: "Invoice ID", number: "Invoice Number", date: "Invoice Date", party: "Customer Name", partyId: "Customer ID", status: "Invoice Status", total: "Total", balance: "Balance", due: "Due Date", reference: "PurchaseOrder", quantity: "Quantity", rate: "Item Price", tax: "Item Tax %" },
  "credit-notes": { kind: "CREDIT_NOTE", id: "CreditNotes ID", number: "Credit Note Number", date: "Credit Note Date", party: "Customer Name", partyId: "Customer ID", status: "Credit Note Status", total: "Total", balance: "Balance", reference: "Associated Invoice Number", quantity: "Quantity", rate: "Item Price", tax: "Item Tax %" },
  receipts: { kind: "CUSTOMER_PAYMENT", id: "CustomerPayment ID", number: "Payment Number", date: "Date", party: "Customer Name", partyId: "CustomerID", status: "Payment Status", total: "Amount", balance: "Unused Amount", reference: "Reference Number", payment: { number: "Invoice Number", amount: "Amount Applied to Invoice", withheld: "Withholding Tax Amount", on: "Applied On" } },
  bills: { kind: "BILL", id: "Bill ID", number: "Bill Number", date: "Bill Date", party: "Vendor Name", status: "Bill Status", total: "Total", balance: "Balance", due: "Due Date", reference: "PurchaseOrder", quantity: "Quantity", rate: "Rate", tax: "Tax Percentage" },
  "vendor-credits": { kind: "VENDOR_CREDIT", id: "Vendor Credit ID", number: "Vendor Credit Number", date: "Vendor Credit Date", party: "Vendor Name", partyId: "Vendor ID", status: "Vendor Credit Status", total: "Total", balance: "Balance", reference: "Associated Bill Number", quantity: "Quantity", rate: "Item Price", tax: "Item Tax %" },
  "vendor-payments": { kind: "VENDOR_PAYMENT", id: "VendorPayment ID", number: "Payment Number", date: "Date", party: "Vendor Name", status: "Payment Status", total: "Amount", balance: "Unused Amount", reference: "Reference Number", payment: { number: "Bill Number", amount: "Bill Amount" } },
  quotes: { kind: "QUOTE", id: "Quote ID", number: "Quote Number", date: "Quote Date", party: "Customer Name", partyId: "Customer ID", status: "Quote Status", total: "Total", reference: "Reference ID", quantity: "Quantity", rate: "Item Price", tax: "Item Tax %" },
  "sales-orders": { kind: "SALES_ORDER", id: "SalesOrder ID", number: "SalesOrder Number", date: "Order Date", party: "Customer Name", partyId: "Customer ID", status: "Status", total: "Total", reference: "Reference#", quantity: "QuantityOrdered", rate: "Item Price", tax: "Item Tax %" },
  "purchase-orders": { kind: "PURCHASE_ORDER", id: "Purchase Order ID", number: "Purchase Order Number", date: "Purchase Order Date", party: "Vendor Name", status: "Purchase Order Status", total: "Total", reference: "Reference#", quantity: "QuantityOrdered", rate: "Item Price", tax: "Item Tax %" },
};

/**
 * Zoho's delivery challans (owner, 16 Nov 2026: "delivery challans not fetched from zoho books"): every one, whatever
 * its year or status, kept in the archive to be read — a challan moves goods, not money, so there is nothing for the
 * books, and Deskzo's own challans are raised from an order or invoice. Read from the pull's Delivery_Challan file
 * (src/lib/zoho/rows.ts challanRows), routed here by src/lib/migration/upload.ts.
 */
const CHALLAN_SPEC: Spec = { kind: "DELIVERY_CHALLAN", id: "Delivery Challan ID", number: "Delivery Challan Number", date: "Challan Date", party: "Customer Name", partyId: "Customer ID", status: "Status", total: "Total", reference: "Reference#", quantity: "Quantity", rate: "Item Price", tax: "Item Tax %" };

/** A file of Zoho's delivery challans, as the pull writes it. */
export function isZohoChallans(rows: Row[]): boolean {
  const first = rows[0];
  return first !== undefined && "Delivery Challan ID" in first && "Delivery Challan Number" in first;
}

/** Zoho's delivery challans as archived documents — all of them. */
export function archiveChallans(rows: Row[]): { documents: ArchiveDraft[]; undated: number } {
  return archiveBySpec(CHALLAN_SPEC, rows);
}

/** Which steps' Zoho files have an archive side, and the heading each dates a document by. */
export const archiveDateHeading = (step: StepKey): string | null => SPECS[step]?.date ?? null;

/** Zoho's finished quotes, orders and POs: read, not worked on — the open ones become live (./zoho.ts). */
const FINISHED: Partial<Record<StepKey, { status: string; finished: RegExp }>> = {
  quotes: { status: "Quote Status", finished: /^(invoiced|declined|expired|void|rejected)$/i },
  "sales-orders": { status: "Status", finished: /^(invoiced|closed|void|cancelled|declined|fulfilled)$/i },
  "purchase-orders": { status: "Purchase Order Status", finished: /^(billed|closed|cancelled|void)$/i },
};

const clean = (v: string | undefined) => (v ?? "").trim();
const num = (v: string | undefined) => {
  const n = Number(clean(v).replace(/,/g, ""));
  return clean(v) && Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** "2026-07-13", "13-07-2026", "13/07/2026", "2026-07-13 10:22:00" → the day, or null. */
export function dayOf(text: string | undefined): string | null {
  return readDay(text);
}

/** The Indian financial year a day falls in: "2024-25" for anything from 1 April 2024 to 31 March 2025. */
export function yearOf(day: string): string {
  const y = Number(day.slice(0, 4));
  const start = Number(day.slice(5, 7)) >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** Whether a Zoho row belongs in the archive rather than the step: dated before the year, or a finished quote, order or PO. */
export function belongsInArchive(step: StepKey, row: Row, yearStart: string): boolean {
  const heading = archiveDateHeading(step);
  const day = heading ? dayOf(row[heading]) : null;
  const earlier = !!day && day < yearStart;
  const finished = FINISHED[step];
  // A quote, order or PO: finished, or raised before the year (owner, 27 Oct 2026) — Zoho left thousands "open"
  // that were invoiced and billed on their own, never converted, and only this year's open ones are live.
  if (finished) return earlier || finished.finished.test(clean(row[finished.status]).replace(/\s+/g, "_"));
  return earlier;
}

/** Rows whose date can't be read, by the heading a step dates them by — for the upload to name, with an example. */
export function unreadableDates(step: StepKey, rows: Row[]): { rows: number; example: string } | null {
  const heading = archiveDateHeading(step);
  if (!heading) return null;
  const bad = rows.filter((r) => clean(r[heading]) && !dayOf(r[heading]));
  return bad.length ? { rows: bad.length, example: clean(bad[0]![heading]).slice(0, 40) } : null;
}

export type ArchiveDraft = Omit<Prisma.ArchivedDocumentCreateManyInput, "migrationId" | "companyId">;

/** A Zoho file's rows as archived documents: rows sharing a Zoho id are one, its figures from the first. */
export function archiveDocuments(step: StepKey, rows: Row[]): { documents: ArchiveDraft[]; undated: number } {
  const spec = SPECS[step];
  if (!spec) return { documents: [], undated: 0 };
  return archiveBySpec(spec, rows);
}

function archiveBySpec(spec: Spec, rows: Row[]): { documents: ArchiveDraft[]; undated: number } {
  const groups = new Map<string, Row[]>();
  rows.forEach((row, i) => {
    const id = documentKey(row, spec.id, spec.number) || `#${i}`;
    groups.set(id, [...(groups.get(id) ?? []), row]);
  });
  const documents: ArchiveDraft[] = [];
  let undated = 0;
  for (const [oldId, group] of groups) {
    const head = group[0]!;
    const date = dayOf(head[spec.date]);
    const number = clean(head[spec.number]);
    if (!date || !number) {
      undated += 1;
      continue;
    }
    const partyName = clean(head[spec.party]) || "(no party)";
    const lines = spec.payment
      ? group.filter((r) => clean(r[spec.payment!.number])).map((r) => {
          const p = spec.payment!;
          const withheld = p.withheld ? round2(num(r[p.withheld])) : 0;
          const on = p.on ? dayOf(r[p.on]) : null;
          return { number: clean(r[p.number]), amount: round2(num(r[p.amount])), ...(withheld ? { withheld } : {}), ...(on ? { on } : {}) };
        })
      : // A document read from a list has no lines of its own: none, rather than one empty.
        group.filter((r) => clean(r["Item Name"]) || clean(r.SKU) || clean(r["Item Desc"]) || clean(r.Description) || num(r["Item Total"])).map((r) => ({
          item: clean(r["Item Name"]) || clean(r.SKU) || null,
          description: clean(r["Item Desc"]) || clean(r.Description) || null,
          quantity: num(r[spec.quantity!]) || 1,
          rate: num(r[spec.rate!]),
          discount: num(r["Discount Amount"]),
          tax: num(r[spec.tax!]),
          amount: round2(num(r["Item Total"])),
        }));
    documents.push({
      kind: spec.kind,
      key: `${spec.kind}:${normalizeCompanyName(partyName)}:${number}`,
      number,
      date: new Date(`${date}T00:00:00Z`),
      year: yearOf(date),
      partyName,
      partyOldId: spec.partyId ? clean(head[spec.partyId]) || null : null,
      status: spec.status ? clean(head[spec.status]) || null : null,
      currency: clean(head["Currency Code"]) || null,
      total: new Prisma.Decimal(round2(num(head[spec.total]))),
      balance: spec.balance && clean(head[spec.balance]) ? new Prisma.Decimal(round2(num(head[spec.balance]))) : null,
      dueDate: spec.due && dayOf(head[spec.due]) ? new Date(`${dayOf(head[spec.due])}T00:00:00Z`) : null,
      reference: spec.reference ? clean(head[spec.reference]).slice(0, 200) || null : null,
      lines: lines as Prisma.InputJsonValue,
      oldId: oldId.startsWith("#") || oldId.startsWith("n:") ? null : oldId,
    });
  }
  return { documents, undated };
}

const PAYMENTS = new Set<string>(["CUSTOMER_PAYMENT", "VENDOR_PAYMENT"] satisfies ArchiveKind[]);

/**
 * Keeps a step's archived documents against the migration, replacing what an earlier upload of the same kind
 * brought — so a file given again is the same documents, not two of each.
 */
export async function storeArchive(m: MigrationRow, kind: ArchiveKind, documents: ArchiveDraft[], merge = false): Promise<number> {
  if (m.status !== "OPEN") throw new MigrationRefused("The migration isn't open.");
  // Their companies: by Zoho's id through what the master lists logged, else by name.
  const oldIds = [...new Set(documents.map((d) => d.partyOldId).filter((x): x is string => !!x))];
  const byOldId = new Map<string, string>();
  for (let i = 0; i < oldIds.length; i += 1000) {
    const found = await db.legacyImportRecord.findMany({ where: { kind: { in: [...ZOHO_PARTY_KINDS] }, oldId: { in: oldIds.slice(i, i + 1000) } }, select: { oldId: true, recordId: true } });
    for (const r of found) byOldId.set(r.oldId, r.recordId);
  }
  const byName = await companiesByName(documents.map((d) => d.partyName));
  // One per key, the last in the file standing.
  const unique = new Map(documents.map((d) => [d.key, d]));
  const rows = [...unique.values()].map((d) => ({ ...d, migrationId: m.id, companyId: (d.partyOldId && byOldId.get(d.partyOldId)) || byName(d.partyName) || null }));
  // A document already kept stays the same row, so Zoho's PDF beside it (ArchivedDocumentFile) stays too.
  const existing = new Map((await db.archivedDocument.findMany({ where: { migrationId: m.id, kind }, select: { id: true, key: true } })).map((d) => [d.key, d.id]));
  await db.$transaction(
    async (tx) => {
      // A top-up adds and updates; only a whole upload says what is no longer there.
      if (!merge) await tx.archivedDocument.deleteMany({ where: { migrationId: m.id, kind, key: { notIn: rows.map((r) => r.key) } } });
      for (const row of rows) {
        const id = existing.get(row.key);
        if (!id) continue;
        // A document read from Zoho's list says nothing of its lines: those kept — from the backup, or when it was read in
        // full — stay. (A payment's are the documents it went to, and none is a real answer.)
        const { lines, ...head } = row;
        const linesUnread = !PAYMENTS.has(row.kind) && Array.isArray(lines) && lines.length === 0;
        await tx.archivedDocument.update({ where: { id }, data: linesUnread ? head : row });
      }
      const fresh = rows.filter((r) => !existing.has(r.key));
      for (let i = 0; i < fresh.length; i += 1000) await tx.archivedDocument.createMany({ data: fresh.slice(i, i + 1000) });
    },
    { timeout: 300_000 },
  );
  return rows.length;
}

/** A Zoho file's rows split: what goes to the archive, and what the step brings. */
export function splitForArchive(step: StepKey, rows: Row[], yearStart: string): { archive: Row[]; step: Row[] } {
  if (!SPECS[step]) return { archive: [], step: rows };
  const archive: Row[] = [];
  const keep: Row[] = [];
  // A document's later lines carry its id but may leave its date blank: they follow its first.
  const spec = SPECS[step]!;
  const decided = new Map<string, boolean>();
  for (const row of rows) {
    const id = documentKey(row, spec.id, spec.number);
    const known = id ? decided.get(id) : undefined;
    const goes = known ?? belongsInArchive(step, row, yearStart);
    if (id && known === undefined) decided.set(id, goes);
    (goes ? archive : keep).push(row);
  }
  return { archive, step: keep };
}

export type ArchiveYear = { year: string; kinds: { kind: ArchiveKind; count: number; total: number; balance: number }[] };

/** A company's archive by year, newest first — for its page. */
/**
 * Never owed, whatever the old system shows as its balance: void, cancelled or a draft — and rejected or waiting for
 * approval, never issued, as the import leaves them behind (./documents.ts `leftBehind`; owner, 21 Nov 2026: WT/25-26/3472,
 * rejected in Zoho, opened here as ₹1,13,280 owing). Zoho keeps such an invoice's full amount as its balance.
 */
export const neverOwed = (status: string | null | undefined): boolean => /void|cancel|draft/i.test(status ?? "") || leftBehind(status ?? "") !== null;

/** What an archived document owes in the old system. */
export const owedInArchive = (doc: { status: string | null; balance: unknown }): number => (neverOwed(doc.status) ? 0 : round2(Number(doc.balance ?? 0)));

export async function companyArchive(companyId: string) {
  const docs = await db.archivedDocument.findMany({
    where: { companyId },
    orderBy: [{ date: "desc" }, { number: "desc" }],
    select: { id: true, kind: true, number: true, date: true, year: true, status: true, currency: true, total: true, balance: true, reference: true, oldId: true, file: { select: { size: true } } },
  });
  const years = new Map<string, Map<ArchiveKind, { count: number; total: number; balance: number }>>();
  for (const d of docs) {
    const kinds = years.get(d.year) ?? years.set(d.year, new Map()).get(d.year)!;
    const k = kinds.get(d.kind as ArchiveKind) ?? { count: 0, total: 0, balance: 0 };
    k.count += 1;
    k.total = round2(k.total + Number(d.total));
    k.balance = round2(k.balance + owedInArchive(d));
    kinds.set(d.kind as ArchiveKind, k);
  }
  return {
    years: [...years].map(([year, kinds]) => ({ year, kinds: ARCHIVE_KINDS.filter((k) => kinds.has(k)).map((kind) => ({ kind, ...kinds.get(kind)! })) })) as ArchiveYear[],
    // `unfetched`: no PDF kept and none asked for yet — an empty file is one Zoho had none of.
    documents: docs.map(({ file, ...d }) => ({ ...d, date: d.date.toISOString().slice(0, 10), total: Number(d.total), balance: d.balance === null ? null : owedInArchive(d), pdf: (file?.size ?? 0) > 0, unfetched: !file })),
  };
}

export const companyHasArchive = async (companyId: string) => (await db.archivedDocument.count({ where: { companyId } }).catch(() => 0)) > 0;

/** How much the migration has archived, by kind — for its page. */
export async function archiveCounts(migrationId: string): Promise<{ kind: ArchiveKind; count: number; unmatched: number }[]> {
  const all = await db.archivedDocument.groupBy({ by: ["kind"], where: { migrationId }, _count: { _all: true } });
  const loose = await db.archivedDocument.groupBy({ by: ["kind"], where: { migrationId, companyId: null }, _count: { _all: true } });
  return ARCHIVE_KINDS.filter((k) => all.some((a) => a.kind === k)).map((kind) => ({
    kind,
    count: all.find((a) => a.kind === kind)!._count._all,
    unmatched: loose.find((a) => a.kind === kind)?._count._all ?? 0,
  }));
}

/** `zoho` and `deskzo` are in `currency`, the document's own — a dollar invoice's balance is dollars in both. */
export type ArchiveDifference = { kind: "INVOICE" | "BILL"; number: string; partyName: string; companyId: string | null; currency: string; zoho: number; deskzo: number | null; why: string };

/**
 * The per-company check (the plan's phase 3 test): every earlier-year invoice or bill the old system still shows
 * owing is open in Deskzo — brought by the open-documents import — and owes the same there, once this year's
 * payments have come across; and nothing open in Deskzo from before the year is settled in the old system.
 * Differences by company, so each can be looked at where it is.
 */
export async function archiveCheck(migrationId: string): Promise<{ agree: number; differences: ArchiveDifference[] }> {
  const archived = await db.archivedDocument.findMany({ where: { migrationId, kind: { in: ["INVOICE", "BILL"] } }, select: { kind: true, number: true, partyName: true, companyId: true, status: true, balance: true, currency: true } });
  const base = baseCurrency();
  const differences: ArchiveDifference[] = [];
  let agree = 0;
  for (const a of archived) {
    const zoho = owedInArchive(a);
    const type = a.kind as "INVOICE" | "BILL";
    const currency = a.currency?.trim().toUpperCase() || base;
    // An earlier invoice is open in Deskzo by its own number; a bill by its number with its vendor.
    const doc = await db.tradeDocument.findFirst({ where: { docNumber: a.number, docType: type, origin: "IMPORTED", ...(type === "BILL" && a.companyId ? { companyId: a.companyId } : {}) }, select: { id: true } });
    if (!doc) {
      if (zoho > 1) differences.push({ kind: type, number: a.number, partyName: a.partyName, companyId: a.companyId, currency, zoho, deskzo: null, why: "Still owing in the old system, and not open in Deskzo — bring it with the open-documents import" });
      else agree += 1;
      continue;
    }
    const deskzo = round2((await settlementOf(db, doc.id))?.settlement.balance ?? 0);
    if (Math.abs(deskzo - zoho) > 1) differences.push({ kind: type, number: a.number, partyName: a.partyName, companyId: a.companyId, currency, zoho, deskzo, why: zoho === 0 ? "Settled in the old system, still open in Deskzo" : "Owes a different amount in each" });
    else agree += 1;
  }
  return { agree, differences: differences.sort((x, y) => x.partyName.localeCompare(y.partyName) || x.number.localeCompare(y.number)) };
}

/**
 * Archived documents that found no company when they came in — the old system's company wasn't in Deskzo yet —
 * matched again now: by the old system's id through what the master lists logged, else by name. No call to Zoho.
 * Run by its button on the switch page, and by itself when an old-CRM import finishes.
 */
/**
 * The companies a list of old names are, by name: the same name first, then the same in another legal form — "ABC Pvt
 * Ltd" in Zoho for "ABC Private Limited" in Deskzo (owner, 29 Oct 2026), by the key the database keeps on each company
 * (`legalNameKey`, src/lib/companies/by-name.ts) — taken only when one company alone has it, as the importers do. A
 * workspace without the key yet matches by the same name only.
 */
async function companiesByName(partyNames: string[]): Promise<(name: string) => string | undefined> {
  const names = [...new Set(partyNames.map(normalizeCompanyName))];
  const byName = new Map<string, string>();
  for (let i = 0; i < names.length; i += 1000) {
    for (const c of await db.company.findMany({ where: { normalizedName: { in: names.slice(i, i + 1000) } }, select: { id: true, normalizedName: true } })) byName.set(c.normalizedName, c.id);
  }
  const keys = [...new Set(partyNames.filter((n) => !byName.has(normalizeCompanyName(n))).map(legalNameKey).filter(Boolean))];
  const byKey = new Map<string, string | null>();
  try {
    for (let i = 0; i < keys.length; i += 1000) {
      const found = await db.$queryRaw<{ id: string; key: string }[]>`select "id", "legalNameKey" as "key" from "companies" where "legalNameKey" = any(${keys.slice(i, i + 1000)})`;
      // Two companies with one key are left alone: the name can't tell which.
      for (const c of found) byKey.set(c.key, byKey.has(c.key) ? null : c.id);
    }
  } catch (err) {
    if (!notMigratedYet(err) && !/42883|function company_legal_name_key/.test(err instanceof Error ? err.message : String(err))) throw err;
  }
  // Last, a name the company went by before — Zoho's "ABC Pvt Ltd" for what is now "ABC Ltd" (owner, 18 Nov 2026).
  const former = await formerNameIndex();
  return (name) => byName.get(normalizeCompanyName(name)) ?? byKey.get(legalNameKey(name)) ?? (byKey.has(legalNameKey(name)) ? undefined : former(name)?.id) ?? undefined;
}

export async function rematchArchive(migrationId: string): Promise<{ matched: number; left: number }> {
  const loose = await db.archivedDocument.findMany({ where: { migrationId, companyId: null }, select: { id: true, partyName: true, partyOldId: true } });
  if (loose.length === 0) return { matched: 0, left: 0 };
  const oldIds = [...new Set(loose.map((d) => d.partyOldId).filter((x): x is string => !!x))];
  const byOldId = new Map<string, string>();
  for (let i = 0; i < oldIds.length; i += 1000) {
    for (const r of await db.legacyImportRecord.findMany({ where: { kind: { in: [...ZOHO_PARTY_KINDS] }, oldId: { in: oldIds.slice(i, i + 1000) } }, select: { oldId: true, recordId: true } })) byOldId.set(r.oldId, r.recordId);
  }
  const byName = await companiesByName(loose.map((d) => d.partyName));
  // One update a company, for all its documents.
  const toCompany = new Map<string, string[]>();
  for (const d of loose) {
    const companyId = (d.partyOldId && byOldId.get(d.partyOldId)) || byName(d.partyName);
    if (companyId) toCompany.set(companyId, [...(toCompany.get(companyId) ?? []), d.id]);
  }
  let matched = 0;
  for (const [companyId, ids] of toCompany) {
    for (let i = 0; i < ids.length; i += 1000) matched += (await db.archivedDocument.updateMany({ where: { id: { in: ids.slice(i, i + 1000) }, companyId: null }, data: { companyId } })).count;
  }
  return { matched, left: loose.length - matched };
}

const CUSTOMER_KINDS: string[] = ["QUOTE", "SALES_ORDER", "INVOICE", "CREDIT_NOTE", "CUSTOMER_PAYMENT"];

/**
 * The companies the archive names that Deskzo doesn't have (owner, 29 Oct 2026: "export option here"): one row a
 * company, as the old system named it, with its id there, what it was to the business by the documents it has —
 * customer, vendor or both — and how many of each. The list to bring in through the master lists, then match again.
 */
export async function unmatchedParties(migrationId: string) {
  const groups = await db.archivedDocument.groupBy({
    by: ["partyName", "partyOldId", "kind"],
    where: { migrationId, companyId: null },
    _count: { _all: true },
    _min: { date: true },
    _max: { date: true },
  });
  const parties = new Map<string, { name: string; oldId: string | null; kinds: Map<string, number>; first: Date | null; last: Date | null }>();
  for (const g of groups) {
    const key = `${g.partyOldId ?? ""}|${normalizeCompanyName(g.partyName)}`;
    const p = parties.get(key) ?? { name: g.partyName, oldId: g.partyOldId, kinds: new Map(), first: null, last: null };
    p.kinds.set(g.kind, (p.kinds.get(g.kind) ?? 0) + g._count._all);
    if (g._min.date && (!p.first || g._min.date < p.first)) p.first = g._min.date;
    if (g._max.date && (!p.last || g._max.date > p.last)) p.last = g._max.date;
    parties.set(key, p);
  }
  return [...parties.values()]
    .map((p) => {
      const kinds = [...p.kinds.keys()];
      const customer = kinds.some((k) => CUSTOMER_KINDS.includes(k));
      const vendor = kinds.some((k) => !CUSTOMER_KINDS.includes(k));
      return {
        name: p.name,
        oldId: p.oldId,
        role: customer && vendor ? "Customer and vendor" : customer ? "Customer" : "Vendor",
        documents: [...p.kinds.values()].reduce((a, b) => a + b, 0),
        kinds: [...p.kinds].map(([k, n]) => `${n} ${ARCHIVE_LABELS[k as ArchiveKind] ?? k}`).join(", "),
        first: p.first ? p.first.toISOString().slice(0, 10) : "",
        last: p.last ? p.last.toISOString().slice(0, 10) : "",
      };
    })
    .sort((a, b) => b.documents - a.documents || a.name.localeCompare(b.name));
}

/** Every archived document, or only those with no company yet — a page at a time, for the export. */
export async function archivedDocumentsPage(migrationId: string, onlyUnmatched: boolean, after: string | null, take = 5000) {
  const rows = await db.archivedDocument.findMany({
    where: { migrationId, ...(onlyUnmatched ? { companyId: null } : {}) },
    orderBy: { id: "asc" },
    ...(after ? { cursor: { id: after }, skip: 1 } : {}),
    take,
    select: { id: true, kind: true, number: true, date: true, year: true, partyName: true, partyOldId: true, companyId: true, status: true, currency: true, total: true, balance: true, dueDate: true, reference: true },
  });
  const ids = [...new Set(rows.map((r) => r.companyId).filter((x): x is string => !!x))];
  const names = new Map((await db.company.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  return rows.map((r) => ({ ...r, deskzoCompany: r.companyId ? (names.get(r.companyId) ?? "") : "" }));
}
