import { Prisma } from "@prisma/client";
import { workspaceClock } from "@/lib/time/workspace";
import { db } from "@/lib/db";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { addFiles, runningImport } from "@/lib/legacy-import/store";
import { MigrationRefused, type MigrationRow } from "@/lib/migration/state";
import { storeUpload, type MigrationFileRows } from "@/lib/migration/upload";
import { keepBytes } from "@/lib/storage/files";
import { assertRoomFor } from "@/lib/storage/allowance";
import { isStorageFull } from "@/lib/file-refusal";
import { openedCalls, PDF_PATHS } from "./archive-pdf";
import { ZohoBusy, zohoAllowance, zohoGet, ZohoRefused, type ZohoReply } from "./client";
import {
  accountRow,
  billRows,
  challanRows,
  contactRows,
  creditNoteRows,
  customerPaymentRows,
  expenseRows,
  invoiceRows,
  itemRow,
  journalRows,
  movementRow,
  purchaseOrderRows,
  quoteRows,
  refundRow,
  salesOrderRows,
  vendorCreditRows,
  vendorPaymentRows,
} from "./rows";

/**
 * The Zoho button (phase 4 of the Zoho plan, owner 26 Oct 2026): everything Zoho's backup brings, fetched through
 * its API instead and kept as the backup's own rows (./rows.ts), then handed to the same places the backup goes —
 * the master lists' files to the old-CRM import (when the super admin pulls), the books' to the switch
 * (src/lib/migration/upload.ts), which sorts this year from the archive.
 *
 *   · **Calls are spent where they tell:** a list call brings 200 records; a document's lines cost a call each,
 *     so only this year's documents and the still-open quotes, orders and POs are read in full. An earlier year's
 *     document comes from its list row — its number, date, party, status, total and balance — with Zoho's PDF
 *     beside it (one call each; an earlier year's quote's only when asked for — `pdfsWanted`).
 *   · **Within Zoho's limits:** spaced under 100 a minute, and counted against the day's allowance for the
 *     organisation's plan, a tenth kept back for its own use. At the day's end it waits, and the button carries
 *     on tomorrow from where it got to.
 *   · **A part at a time:** the page calls `pullStep` until it says done; each call works a few seconds.
 *   · **The master lists first:** customers, vendors and items go to the old-CRM import as each is fetched; the
 *     books go together at the end.
 *   · Pulling again fetches afresh and replaces what the last pull brought, as uploading the backup again does.
 */

type J = Record<string, unknown>;
type Rows = Record<string, string>[];

type Module = {
  key: string;
  label: string;
  path: string;
  query?: Record<string, string>;
  listKey: string;
  detailKey?: string;
  idField: string;
  /** The old-CRM import's master lists read it, not the switch. */
  master?: boolean;
  /** Whether a listed record is read in full. */
  detail?: (row: J, yearStart: string) => boolean;
  /** Left out altogether: an earlier year's expense or journal is in the opening balances already. */
  skip?: (row: J, yearStart: string) => boolean;
  /** Its rows, by the backup file they belong in. */
  rows: (record: J) => Record<string, Rows>;
  /** Not every organisation has it (delivery challans are Zoho's India edition): Zoho refusing it passes over it. */
  optional?: boolean;
};

const dated = (row: J, yearStart: string) => String(row.date ?? row.journal_date ?? "") >= yearStart;
/** Dated before the year: to the archive whatever its status (src/lib/migration/archive.ts `belongsInArchive`). One with no date is not. */
const beforeYear = (row: J, yearStart: string) => !!row.date && String(row.date) < yearStart;
const OPEN_QUOTE = /^(draft|sent|accepted|open|pending_approval|approved)$/i;
const OPEN_ORDER = /^(draft|open|confirmed|pending_approval|approved|partially_invoiced|onhold)$/i;
const OPEN_PO = /^(draft|open|issued|partially_billed|partially_received|pending_approval|approved)$/i;

export const MODULES: Module[] = [
  {
    key: "customers",
    label: "Customers",
    path: "/contacts",
    query: { contact_type: "customer" },
    listKey: "contacts",
    detailKey: "contact",
    idField: "contact_id",
    master: true,
    detail: () => true,
    rows: (r) => {
      const { contact, people } = contactRows(r, false);
      return { "Contacts.csv": [contact], "Contact_Persons.csv": people };
    },
  },
  {
    key: "vendors",
    label: "Vendors",
    path: "/contacts",
    query: { contact_type: "vendor" },
    listKey: "contacts",
    detailKey: "contact",
    idField: "contact_id",
    master: true,
    detail: () => true,
    rows: (r) => {
      const { contact, people } = contactRows(r, true);
      return { "Vendors.csv": [contact], "Vendor_Contact_Persons.csv": people };
    },
  },
  { key: "items", label: "Items", path: "/items", listKey: "items", idField: "item_id", master: true, rows: (r) => ({ "Item.csv": [itemRow(r)] }) },
  { key: "chart", label: "Chart of accounts", path: "/chartofaccounts", listKey: "chartofaccounts", idField: "account_id", rows: (r) => ({ "Chart_of_Accounts.csv": [accountRow(r)] }) },
  { key: "invoices", label: "Invoices", path: "/invoices", listKey: "invoices", detailKey: "invoice", idField: "invoice_id", detail: dated, rows: (r) => ({ "Invoice.csv": invoiceRows(r) }) },
  {
    key: "creditnotes",
    label: "Credit notes",
    path: "/creditnotes",
    listKey: "creditnotes",
    detailKey: "creditnote",
    idField: "creditnote_id",
    detail: dated,
    rows: (r) => {
      const { rows, applications } = creditNoteRows(r);
      return { "Credit_Note.csv": rows, "Creditnotes_Invoice.csv": applications };
    },
  },
  // A payment from before the year changed since it began — an advance set against this year's invoices — is read in
  // full too, for what it paid and when (owner, 17 Nov 2026 — src/lib/migration/advances.ts).
  { key: "customerpayments", label: "Customer payments", path: "/customerpayments", listKey: "customerpayments", detailKey: "payment", idField: "payment_id", detail: (r, y) => dated(r, y) || String(r.last_modified_time ?? "").slice(0, 10) >= y, rows: (r) => ({ "Customer_Payment.csv": customerPaymentRows(r) }) },
  { key: "bills", label: "Bills", path: "/bills", listKey: "bills", detailKey: "bill", idField: "bill_id", detail: dated, rows: (r) => ({ "Bill.csv": billRows(r) }) },
  { key: "vendorcredits", label: "Vendor credits", path: "/vendorcredits", listKey: "vendorcredits", detailKey: "vendor_credit", idField: "vendor_credit_id", detail: dated, rows: (r) => ({ "Vendor_Credits.csv": vendorCreditRows(r) }) },
  { key: "vendorpayments", label: "Vendor payments", path: "/vendorpayments", listKey: "vendorpayments", detailKey: "vendorpayment", idField: "payment_id", detail: dated, rows: (r) => ({ "Vendor_Payment.csv": vendorPaymentRows(r) }) },
  { key: "expenses", label: "Expenses", path: "/expenses", listKey: "expenses", detailKey: "expense", idField: "expense_id", detail: () => true, skip: (r, y) => !dated(r, y), rows: (r) => ({ "Expense.csv": expenseRows(r) }) },
  { key: "journals", label: "Manual journals", path: "/journals", listKey: "journals", detailKey: "journal", idField: "journal_id", detail: () => true, skip: (r, y) => !dated(r, y), rows: (r) => ({ "Journal.csv": journalRows(r) }) },
  // An earlier year's quote Zoho still calls open goes to the archive, so its list row is enough (owner, 25 Nov 2026): tens
  // of thousands of them, a call each, kept a pull of the quotes going for days.
  { key: "estimates", label: "Quotes", path: "/estimates", listKey: "estimates", detailKey: "estimate", idField: "estimate_id", detail: (r, y) => OPEN_QUOTE.test(String(r.status ?? "")) && !beforeYear(r, y), rows: (r) => ({ "Quote.csv": quoteRows(r) }) },
  { key: "salesorders", label: "Sales orders", path: "/salesorders", listKey: "salesorders", detailKey: "salesorder", idField: "salesorder_id", detail: (r) => OPEN_ORDER.test(String(r.status ?? r.order_status ?? "")), rows: (r) => ({ "Sales_Order.csv": salesOrderRows(r) }) },
  // Every challan, to the archive (owner, 16 Nov 2026): only this year's read in full, an earlier one from its list row.
  { key: "deliverychallans", label: "Delivery challans", path: "/deliverychallans", listKey: "deliverychallans", detailKey: "deliverychallan", idField: "deliverychallan_id", detail: dated, optional: true, rows: (r) => ({ "Delivery_Challan.csv": challanRows(r) }) },
  { key: "purchaseorders", label: "Purchase orders", path: "/purchaseorders", listKey: "purchaseorders", detailKey: "purchaseorder", idField: "purchaseorder_id", detail: (r) => OPEN_PO.test(String(r.status ?? r.order_status ?? "")), rows: (r) => ({ "Purchase_Order.csv": purchaseOrderRows(r) }) },
  {
    key: "banking",
    label: "Transfers and deposits",
    path: "/banktransactions",
    listKey: "banktransactions",
    idField: "transaction_id",
    skip: (r, y) => !dated(r, y),
    rows: (r) => {
      const row = movementRow(r);
      return { "Transfer_Fund.csv": row ? [row] : [] };
    },
  },
  { key: "refunds", label: "Refunds", path: "/creditnotes/refunds", listKey: "creditnote_refunds", idField: "creditnote_refund_id", skip: (r, y) => !dated(r, y), rows: (r) => ({ "Refund.csv": [refundRow(r)] }) },
];

/**
 * The archived documents whose PDF a pull still has to fetch. An earlier year's quote's waits to be asked for — "Fetch the
 * archive's PDFs only" — as there are tens of thousands, a call each: a pull fetching them for days keeps the night's
 * top-up from starting (./nightly.ts), and so nothing new comes across (owner, 25 Nov 2026).
 */
const pdfsWanted = (m: MigrationRow, mode: PullProgress["mode"]): Prisma.ArchivedDocumentWhereInput => ({
  migrationId: m.id,
  kind: { in: Object.keys(PDF_PATHS) },
  oldId: { not: null },
  file: null,
  ...(mode === "pdfs" ? {} : { NOT: { kind: "QUOTE", date: { lt: new Date(`${m.yearStart}T00:00:00Z`) } } }),
});

/** The kinds whose earlier years can be pulled by themselves, from Zoho's list alone (`PullProgress.earlier`). */
const EARLIER_ALONE = new Set(["estimates"]);

export type PullProgress = {
  module: number;
  page: number;
  /** The list page to read next; 0 once the list is read and only its queue is left. */
  /** The listed records of the page being read in full, not yet fetched. */
  queue: J[];
  /** Rows waiting to be written, by file. */
  buffer: Record<string, Rows>;
  seq: Record<string, number>;
  /** How many records each module brought. */
  counts: Record<string, number>;
  /** Calls by day ("2026-10-26": 1423). */
  calls: Record<string, number>;
  pdfs: number;
  pdfsLeft?: number;
  /**
   * "full" fetches everything and replaces what was there; "topup" (owner, 27 Oct 2026: the backup first, then what
   * Zoho has changed since) only what was created or changed on or after `since`, added on top; "pdfs" only Zoho's
   * PDFs of the archive.
   */
  mode?: "full" | "topup" | "pdfs";
  since?: string;
  /** Whether its master lists' files go to the old-CRM import: the super admin started it (decided then, in their session). */
  master?: boolean;
  /** Until when a step holds it (ISO): the page and the server's tick never work it at once. */
  lease?: string;
  /** How many of each kind Zoho said it holds, when it was counted first (./count.ts) — for "150 of 412". */
  expected?: Record<string, number>;
  /** Ids already kept, for a list that names a record twice (a transfer is listed once a side). */
  seen?: string[];
  /** The master lists already handed to the old-CRM import, by module key — each as soon as it is fetched. */
  handed?: string[];
  /** Only these modules, by key (owner, 28 Oct 2026: "Pull this from Zoho" on a section) — every module when not given. */
  only?: string[];
  /**
   * Only what is dated before the year, to the archive, with `only` (owner, 25 Nov 2026): its list read and nothing in
   * full, added to what is kept — this year's, in the archive and in its section, left as it is.
   */
  earlier?: boolean;
  /** The books' modules handed to the switch already — each as soon as it is fetched — with what they brought. */
  booksHanded?: { module: string; steps: { step: string; units: number }[]; refused: string[] }[];
  /** The files handed on already, by name: the end of the pull leaves them be. */
  handedFiles?: string[];
  /** The switch's steps this pull has given a file already: a later module for the same step (journals) adds to it. */
  bookSteps?: string[];
  /** The modules part of which was handed over before their list was read to the end: the rest adds to it. */
  partHanded?: string[];
  /** Started by the night's top-up (./nightly.ts), which imports what it brought once it is done — and then `imported`. */
  nightly?: boolean;
  imported?: boolean;
  /**
   * "Pull again" after a whole pull finished (owner, 23 Nov 2026: "why it is fetching again? this was done before
   * already" … "Stop it, skip repeats"): run as a top-up from the day before that pull started — only what Zoho created
   * or changed since, added to what came — rather than every year's invoices, quotes and receipts read again over days
   * of Zoho's calls. Counts as a whole pull for the next one's day (`masterListsSince`).
   */
  again?: boolean;
  note?: string | null;
  /**
   * A whole pull again after one that brought the master lists (owner, 17 Nov 2026 — "it started customers fetching
   * again"): customers, vendors and items only when Zoho changed them on or after this day — each read in full costs a
   * call, and twelve thousand customers already in Deskzo cost two days of Zoho's calls. A list pulled by itself
   * ("Pull customers from Zoho") still reads all of it.
   */
  masterSince?: string;
  /**
   * Customers, vendors and items a whole pull passed over, by module key (owner, 20 Nov 2026 — "this fetching was
   * already done"): with no earlier whole pull finished to count from, each already brought across into Deskzo and
   * unchanged in Zoho since is not read again.
   */
  alreadyIn?: Record<string, number>;
};

/** The old-CRM import's record of each master list's Zoho ids (src/lib/legacy-import/apply.ts). */
const BROUGHT_KINDS: Record<string, string> = { customers: "zoho_contacts", vendors: "zoho_vendors", items: "zoho_items" };

/**
 * Of a page of a master list, the ids already brought across into Deskzo and not changed in Zoho since — the day
 * before they came, as Zoho's "changed" is by day — to be passed over rather than read in full again.
 */
async function broughtAndUnchanged(mod: Module, rows: J[]): Promise<Set<string>> {
  const kind = BROUGHT_KINDS[mod.key];
  if (!kind || !rows.length) return new Set();
  const ids = rows.map((r) => String(r[mod.idField] ?? "")).filter(Boolean);
  const brought = await db.legacyImportRecord.findMany({ where: { kind, oldId: { in: ids } }, select: { oldId: true, createdAt: true } });
  const when = new Map(brought.map((b) => [b.oldId, b.createdAt]));
  const unchanged = new Set<string>();
  for (const r of rows) {
    const id = String(r[mod.idField] ?? "");
    const at = when.get(id);
    if (!at) continue;
    const dayBefore = new Date(at.getTime() - 86_400_000).toISOString().slice(0, 10);
    if (!changedSince(r, dayBefore)) unchanged.add(id);
  }
  return unchanged;
}

/**
 * The day a whole pull again reads the master lists from: the start of the last finished whole pull that brought them,
 * a day earlier for what changed while it ran. None when there was none — the first pull reads everything.
 */
export async function masterListsSince(migrationId: string): Promise<string | null> {
  const done = await db.zohoPull.findMany({ where: { migrationId, status: "DONE" }, orderBy: { startedAt: "desc" }, take: 20, select: { startedAt: true, progress: true } });
  // The latest finished whole pull by whoever brings the master lists: one that read them all, or one that read what
  // changed since an earlier one — either way, everything up to its start is in. A stopped pull is FAILED, never this.
  const last = done.find((p) => {
    const g = (p.progress ?? {}) as Partial<PullProgress>;
    return g.master === true && (((g.mode ?? "full") === "full" && (!!g.masterSince || (g.counts?.customers ?? 0) > 0)) || g.again === true) && !g.only?.length;
  });
  if (!last) return null;
  const day = new Date(last.startedAt);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

/**
 * The day Zoho's calls are counted against: the workspace's own calendar day, as Zoho resets an organisation's daily
 * allowance at its midnight — not UTC's, which in India turns over at 5:30 am and kept a new day's pull waiting on the
 * day before's count (owner, 31 Oct 2026).
 */
export const callDay = async () => (await workspaceClock()).calendarDate(new Date()).toISOString().slice(0, 10);
const emptyProgress = (): PullProgress => ({ module: 0, page: 1, queue: [], buffer: {}, seq: {}, counts: {}, calls: {}, pdfs: 0, seen: [], note: null });

export type PullView = { id: string; status: string; progress: PullProgress; allowance: number; callsToday: number; outcome: unknown; error: string | null; module: string | null; busy?: boolean };

async function view(pullId: string): Promise<PullView> {
  const p = await db.zohoPull.findUniqueOrThrow({ where: { id: pullId } });
  const progress = p.progress as unknown as PullProgress;
  const day = await callDay();
  return { id: p.id, status: p.status, progress: { ...progress, queue: [], buffer: {}, seen: [] }, allowance: (await zohoAllowance()).allowance, callsToday: (progress.calls?.[day] ?? 0) + (await openedCalls(day)), outcome: p.outcome, error: p.error, module: MODULES[progress.module]?.label ?? null };
}

/**
 * What the switch page shows of a pull on each section (owner, 28 Oct 2026): the sections still to be fetched — the
 * module being read and those after it, of the ones asked for — and the modules a section's "Pull this" asks for.
 */
export function sectionsStillToCome(view: PullView | null): string[] {
  if (!view || !["FETCHING", "WAITING"].includes(view.status)) return [];
  const p = view.progress;
  // The earlier years alone go to the archive, not to a section.
  if (p.earlier) return [];
  return MODULES.slice(p.module)
    .filter((mod) => !mod.master && (!p.only || p.only.includes(mod.key)))
    .flatMap((mod) => (mod.key === "chart" ? ["chart"] : (MODULE_STEPS[mod.key] ?? [])));
}

/** The migration's latest pull, for the page. */
export async function latestPull(migrationId: string): Promise<PullView | null> {
  const p = await db.zohoPull.findFirst({ where: { migrationId }, orderBy: { startedAt: "desc" }, select: { id: true } });
  return p ? view(p.id) : null;
}

/** A fresh pull, from the first module. One at a time: one already going carries on instead. */
export async function startPull(m: MigrationRow, userId: string, expected: Record<string, number> = {}, options: { mode?: "full" | "topup" | "pdfs"; since?: string; only?: string[]; nightly?: boolean; everything?: boolean; earlier?: boolean } = {}): Promise<PullView> {
  if (m.status !== "OPEN") throw new MigrationRefused("The migration isn't open.");
  const conn = await db.zohoConnection.findUnique({ where: { id: "default" }, select: { refreshToken: true, organizationId: true } });
  if (!conn?.refreshToken || !conn.organizationId) throw new MigrationRefused("Connect Deskzo to your Zoho Books organisation first.");
  const going = await db.zohoPull.findFirst({ where: { migrationId: m.id, status: { in: ["FETCHING", "STORING", "PDFS", "WAITING"] } }, select: { id: true } });
  if (going) return view(going.id);
  // Only the kinds a pull has, as whole numbers: shown beside what came, never acted on.
  const known = Object.fromEntries(Object.entries(expected ?? {}).filter(([k, v]) => MODULES.some((mod) => mod.key === k) && Number.isInteger(v) && v >= 0 && v < 10_000_000));
  const master = await actingAsSuperAdmin(userId);
  let mode: "full" | "topup" | "pdfs" = options.mode === "topup" || options.mode === "pdfs" ? options.mode : "full";
  let since = mode === "topup" ? (options.since ?? "") : "";
  if (mode === "topup" && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new MigrationRefused("Give the day the backup was taken — the top-up brings what Zoho has changed since.");
  // PDFs only: straight past the fetching to the archive's PDFs.
  // One module, or a few, by itself: only keys a pull has; a master list only for whoever may have it.
  const only = (options.only ?? []).filter((k, i, all) => MODULES.some((mod) => mod.key === k && (!mod.master || master)) && all.indexOf(k) === i);
  if (options.only?.length && !only.length) throw new MigrationRefused("Nothing to pull — that list is the super admin's, through the old-CRM import.");
  if (options.earlier && (!only.length || mode !== "full" || !only.every((k) => EARLIER_ALONE.has(k)))) throw new MigrationRefused("Only the quotes' earlier years can be pulled by themselves.");
  // Everything again, by whoever brings the master lists: only those changed since the last whole pull that brought them.
  let masterSince = mode === "full" && master && !only.length ? await masterListsSince(m.id) : null;
  // Pulling again after a whole pull finished: only what Zoho changed since, unless everything is asked for by name.
  const again = !!masterSince && !options.everything;
  if (again) {
    mode = "topup";
    since = masterSince!;
    masterSince = null;
  }
  const start = {
    ...emptyProgress(),
    expected: known,
    master,
    mode,
    ...(since ? { since } : {}),
    ...(only.length ? { only } : {}),
    ...(options.earlier ? { earlier: true } : {}),
    ...(options.nightly ? { nightly: true } : {}),
    ...(mode === "pdfs" ? { module: MODULES.length } : {}),
    ...(masterSince ? { masterSince, note: `Customers, vendors and items: only those changed in Zoho since ${masterSince} — the rest came with the last pull. "Pull customers from Zoho" reads them all.` } : {}),
    ...(again ? { again: true, note: `Pulling again: only what Zoho created or changed since ${since} — everything up to then came with the last whole pull. "Read everything again" reads all of it.` } : {}),
  };
  const made = await db.zohoPull.create({ data: { migrationId: m.id, startedById: userId, status: mode === "pdfs" ? "PDFS" : "FETCHING", progress: start as unknown as Prisma.InputJsonValue }, select: { id: true } });
  return view(made.id);
}

async function flush(pullId: string, progress: PullProgress) {
  for (const [file, rows] of Object.entries(progress.buffer)) {
    if (!rows.length) continue;
    const seq = progress.seq[file] ?? 0;
    await db.zohoPullPage.create({ data: { pullId, file, seq, rows: rows as Prisma.InputJsonValue } });
    progress.seq[file] = seq + 1;
  }
  progress.buffer = {};
}

// A stopped pull stays stopped: a step still running when somebody stopped it can't put it back.
const save = (pullId: string, status: string, progress: PullProgress, extra: Partial<{ error: string | null; outcome: Prisma.InputJsonValue; finishedAt: Date }> = {}) =>
  db.zohoPull.updateMany({ where: { id: pullId, status: { not: "FAILED" } }, data: { status, progress: progress as unknown as Prisma.InputJsonValue, ...extra } });

/**
 * Stops whatever pull is still going (owner, 29 Oct 2026): what it brought across stays, and nothing more comes — so a
 * pull left waiting on Zoho, or one whose connection is gone, no longer holds Finish back.
 */
export async function stopPulls(migrationId: string, reason: string): Promise<number> {
  const { count } = await db.zohoPull.updateMany({ where: { migrationId, status: { in: ["FETCHING", "STORING", "PDFS", "WAITING"] } }, data: { status: "FAILED", error: reason, finishedAt: new Date() } });
  return count;
}

/**
 * Works the pull forward for up to `budgetMs` — from the page while it is open, and from the server's tick
 * (`zohoChores`) whether it is or not. One at a time: a step first takes the pull's lease, and a pull another
 * step holds answers busy rather than being worked twice.
 */
/**
 * An archived document's PDF as Zoho sent it — into the storage box when the server has one (src/lib/storage/files.ts),
 * the row keeping its reference and the PDF's own size. Null: a PDF Zoho won't give, noted as an empty file, so the pull
 * moves past it rather than asking again.
 *
 * False: the workspace's storage is full (storage in the plans, 20 Nov 2026 — src/lib/file-refusal.ts) — nothing is
 * written, so the document is still waiting for its PDF, and is fetched again once there is room.
 *
 * One kept in the meantime — somebody opened it while a pull was asking for it, or the other way about — stands: a
 * document has one file. Only an empty one gives way to a real PDF.
 */
export async function keepArchivedPdf(documentId: string, pdf: Buffer | null): Promise<boolean> {
  if (!pdf) {
    await db.archivedDocumentFile.createMany({ data: [{ documentId, contentType: "none", data: new Uint8Array(), size: 0 }], skipDuplicates: true });
    return true;
  }
  let data: Uint8Array<ArrayBuffer>;
  try {
    data = await keepBytes("archived-documents", pdf, "application/pdf");
  } catch (err) {
    if (!isStorageFull(err)) throw err;
    console.warn(`[zoho] an earlier-year PDF wasn't kept: ${err.message}`);
    return false;
  }
  const { count } = await db.archivedDocumentFile.createMany({ data: [{ documentId, data, size: pdf.length }], skipDuplicates: true });
  if (count === 0) await db.archivedDocumentFile.updateMany({ where: { documentId, size: 0 }, data: { contentType: "application/pdf", data, size: pdf.length } });
  return true;
}

/** The note on a pull whose PDFs wait for the workspace's storage. */
const storageFullNote = (left: number) =>
  `Your workspace's storage is full, with ${left.toLocaleString("en-IN")} earlier-year PDFs still to fetch. They carry on by themselves once an administrator adds storage in Settings › Billing — everything else is in.`;

/** Whether the workspace has no room left for another file (its limit reached); a check costing no call to Zoho. */
async function storageFull(): Promise<boolean> {
  try {
    await assertRoomFor(1);
    return false;
  } catch (err) {
    if (isStorageFull(err)) return true;
    throw err;
  }
}

export async function pullStep(m: MigrationRow, pullId: string, userId: string, budgetMs = 8000): Promise<PullView> {
  const found = await db.zohoPull.findFirst({ where: { id: pullId, migrationId: m.id }, select: { status: true } });
  if (!found) throw new MigrationRefused("That pull isn't there.");
  if (found.status === "DONE" || found.status === "FAILED") return view(pullId);
  const until = new Date(Date.now() + budgetMs + 60_000).toISOString();
  const claimed = await db.$executeRaw`update "zoho_pulls" set "progress" = jsonb_set("progress", '{lease}', to_jsonb(${until}::text)) where "id" = ${pullId} and coalesce("progress"->>'lease', '') < ${new Date().toISOString()}`;
  if (claimed === 0) return { ...(await view(pullId)), busy: true };
  const pull = (await db.zohoPull.findUnique({ where: { id: pullId } }))!;
  const progress = { ...emptyProgress(), ...(pull.progress as unknown as PullProgress) };
  // A pull started before this was recorded asks now, in the session that is stepping it.
  const master = progress.master ?? (await actingAsSuperAdmin(userId).catch(() => false));
  const { allowance } = await zohoAllowance();
  let status = pull.status === "WAITING" ? (progress.module >= MODULES.length ? "PDFS" : "FETCHING") : pull.status;
  const day = await callDay();
  const spend = () => (progress.calls[day] = (progress.calls[day] ?? 0) + 1);
  // PDFs opened one at a time (./open-archived-pdf.ts) are the same organisation's calls.
  const opened = await openedCalls(day);
  const room = () => (progress.calls[day] ?? 0) + opened < allowance;
  // Asked once a step: after that, a PDF there's no room for is refused as it is kept (`keepArchivedPdf`).
  let storageAsked = false;
  progress.note = null;

  // Counted from when the work begins, so a short step still does some.
  const started = Date.now();
  try {
    while (Date.now() - started < budgetMs) {
      if (status === "FETCHING") {
        const mod = MODULES[progress.module];
        if (!mod) {
          status = "STORING";
          continue;
        }
        // Passed over before anything is asked of Zoho, so a pull waiting for tomorrow names the module it waits at.
        if (progress.only && !progress.only.includes(mod.key)) {
          // Pulling only some modules: the rest are passed over without a call.
          progress.module += 1;
          progress.page = 1;
          continue;
        }
        if (mod.master && !master) {
          // The master lists are the super admin's (the old-CRM import); the books carry on without them.
          progress.module += 1;
          progress.page = 1;
          continue;
        }
        if (!room()) {
          status = "WAITING";
          progress.note = `Zoho allows about ${allowance.toLocaleString("en-IN")} calls a day on this plan, and today's are used. It carries on by itself after midnight — nothing to press, and the page can stay closed.`;
          break;
        }
        const queued = progress.queue.shift();
        if (queued) {
          spend();
          let detail: J = {};
          try {
            detail = ((await zohoGet(`${mod.path}/${String(queued[mod.idField])}`)) as ZohoReply)[mod.detailKey!] as J;
          } catch (err) {
            // An optional module's record Zoho won't give in full is kept from its list row.
            if (!(mod.optional && err instanceof ZohoRefused)) throw err;
          }
          keep(progress, mod, { ...queued, ...(detail ?? {}) });
          continue;
        }
        // Its list read to the end and every record in full: the next module.
        if (progress.page === 0) {
          progress.module += 1;
          progress.page = 1;
          progress.seen = [];
          await flush(pullId, progress);
          if (mod.master) await handOver(pullId, userId, progress);
          else await handBooks(m, pullId, userId, progress, mod);
          await save(pullId, status, progress);
          continue;
        }
        spend();
        let reply: ZohoReply;
        try {
          reply = (await zohoGet(mod.path, { ...(mod.query ?? {}), page: progress.page, per_page: 200 })) as ZohoReply;
        } catch (err) {
          // Not in this organisation's Zoho (delivery challans outside its India edition): passed over, and said so.
          if (!(mod.optional && err instanceof ZohoRefused)) throw err;
          progress.note = `${mod.label} weren't read: ${err.message}`;
          progress.page = 0;
          continue;
        }
        const listed = (reply[mod.listKey] as J[] | undefined) ?? [];
        // A whole pull with no earlier one finished to count from: what is in Deskzo already and unchanged is passed over.
        const alreadyIn = mod.master && progress.mode === "full" && !progress.masterSince && !progress.only?.length ? await broughtAndUnchanged(mod, listed) : new Set<string>();
        if (alreadyIn.size) progress.alreadyIn = { ...(progress.alreadyIn ?? {}), [mod.key]: (progress.alreadyIn?.[mod.key] ?? 0) + alreadyIn.size };
        const records = listed.filter(
          (r) =>
            !alreadyIn.has(String(r[mod.idField] ?? "")) &&
            !mod.skip?.(r, m.yearStart) &&
            (!progress.earlier || beforeYear(r, m.yearStart)) &&
            (progress.mode !== "topup" || mod.key === "chart" || changedSince(r, progress.since!)) &&
            // A whole pull again: the master lists only where Zoho changed them since the last (`masterSince`).
            (!progress.masterSince || !mod.master || mod.key === "chart" || changedSince(r, progress.masterSince)),
        );
        for (const r of records) {
          if (mod.detail?.(r, m.yearStart) && mod.detailKey) {
            // Zoho's list moves while it is read (a quote added shifts the pages), so a record can be listed on two
            // pages: read in full once (owner, 23 Nov 2026 — WT/26-27/QT/3131 came across with every line twice).
            const id = String(r[mod.idField] ?? "");
            const queued = (progress.seen ??= []);
            if (id && queued.includes(id)) continue;
            if (id) queued.push(id);
            progress.queue.push(r);
          } else keep(progress, mod, r);
        }
        // No more pages: 0 until what this page queued has been read in full.
        progress.page = reply.page_context?.has_more_page ? progress.page + 1 : 0;
        await flush(pullId, progress);
        await save(pullId, status, progress);
        continue;
      }
      if (status === "STORING") {
        await flush(pullId, progress);
        const outcome = progress.mode === "pdfs" ? null : await store(m, pullId, userId, master, progress.mode === "topup" || !!progress.earlier, progress.handedFiles);
        await save(pullId, "PDFS", progress, { outcome: outcome as unknown as Prisma.InputJsonValue });
        status = "PDFS";
        continue;
      }
      if (status === "PDFS") {
        const wanted = pdfsWanted(m, progress.mode);
        const doc = await db.archivedDocument.findFirst({ where: wanted, select: { id: true, kind: true, oldId: true } });
        progress.pdfsLeft = await db.archivedDocument.count({ where: wanted });
        if (!doc) {
          status = "DONE";
          break;
        }
        // Out of storage, the PDFs wait without spending Zoho's calls on files that can't be kept, and the next tick
        // looks again — the pull isn't stopped, and nothing half kept is written.
        const askStorage = !storageAsked;
        storageAsked = true;
        if (askStorage && (await storageFull())) {
          status = "WAITING";
          progress.note = storageFullNote(progress.pdfsLeft);
          break;
        }
        if (!room()) {
          status = "WAITING";
          progress.note = `Zoho's calls for today are used, with ${progress.pdfsLeft.toLocaleString("en-IN")} earlier-year PDFs still to fetch. It carries on by itself after midnight — everything else is in.`;
          break;
        }
        spend();
        let pdf: Buffer | null;
        try {
          pdf = (await zohoGet(`${PDF_PATHS[doc.kind]}/${doc.oldId}`, {}, "pdf")) as Buffer;
        } catch (err) {
          if (!(err instanceof ZohoRefused)) throw err;
          pdf = null;
        }
        if (!(await keepArchivedPdf(doc.id, pdf))) {
          status = "WAITING";
          progress.note = storageFullNote(progress.pdfsLeft);
          break;
        }
        progress.pdfs += 1;
        continue;
      }
      break;
    }
  } catch (err) {
    delete progress.lease;
    await flush(pullId, progress).catch(() => undefined);
    if (err instanceof ZohoBusy) {
      progress.note = err.message;
      await save(pullId, err.daily ? "WAITING" : status, progress);
      return view(pullId);
    }
    if (err instanceof ZohoRefused || err instanceof MigrationRefused) {
      await save(pullId, "FAILED", progress, { error: err.message, finishedAt: new Date() });
      return view(pullId);
    }
    throw err;
  }
  await flush(pullId, progress);
  delete progress.lease;
  await save(pullId, status, progress, status === "DONE" ? { finishedAt: new Date() } : {});
  return view(pullId);
}

/** A record's rows into the buffer, once. */
function keep(progress: PullProgress, mod: Module, record: J) {
  // The banking list names a record twice — a transfer once a side. (A record read in full is kept once by its queue.)
  const id = mod.key === "banking" ? String(record[mod.idField] ?? "") : "";
  if (id) {
    const seen = (progress.seen ??= []);
    if (seen.includes(id)) return;
    seen.push(id);
  }
  for (const [file, rows] of Object.entries(mod.rows(record))) {
    if (!rows.length) continue;
    (progress.buffer[file] ??= []).push(...rows);
  }
  progress.counts[mod.key] = (progress.counts[mod.key] ?? 0) + 1;
}

const MASTER_FILES = new Set(["Contacts.csv", "Contact_Persons.csv", "Vendors.csv", "Vendor_Contact_Persons.csv", "Item.csv"]);

/**
 * A master list handed to the old-CRM import as soon as it is fetched (owner, 26 Oct 2026: "fetch 1000, then
 * another 1000"), so the customers are there to check and bring across while the books are still being fetched —
 * which go on as one import at the end, a payment needing its invoice. With an old-CRM import running, the list
 * waits for the pull's end instead, as it did before.
 */
async function handOver(pullId: string, userId: string, progress: PullProgress) {
  const merge = progress.mode === "topup";
  if (await runningImport()) return;
  const pages = await db.zohoPullPage.findMany({ where: { pullId, file: { in: [...MASTER_FILES] } }, orderBy: [{ file: "asc" }, { seq: "asc" }], select: { file: true, rows: true } });
  const files = new Map<string, Rows>();
  for (const p of pages) files.set(p.file, [...(files.get(p.file) ?? []), ...(p.rows as Rows)]);
  if (files.size) {
    // Every master list still here goes: one kept back while an import ran rides along with the next.
    await addFiles(await masterFiles([...files], merge), userId);
    await db.zohoPullPage.deleteMany({ where: { pullId, file: { in: [...files.keys()] } } });
  }
  progress.handed = MODULES.slice(0, progress.module)
    .filter((mod) => mod.master)
    .map((mod) => mod.key);
}

/** The files each book module fills, as its `rows` names them. */
const MODULE_FILES: Record<string, string[]> = {
  chart: ["Chart_of_Accounts.csv"],
  invoices: ["Invoice.csv"],
  creditnotes: ["Credit_Note.csv", "Creditnotes_Invoice.csv"],
  customerpayments: ["Customer_Payment.csv"],
  bills: ["Bill.csv"],
  vendorcredits: ["Vendor_Credits.csv"],
  vendorpayments: ["Vendor_Payment.csv"],
  expenses: ["Expense.csv"],
  journals: ["Journal.csv"],
  estimates: ["Quote.csv"],
  salesorders: ["Sales_Order.csv"],
  deliverychallans: ["Delivery_Challan.csv"],
  purchaseorders: ["Purchase_Order.csv"],
  banking: ["Transfer_Fund.csv"],
  refunds: ["Refund.csv"],
};

/** The switch's steps each book module's files go to — journals takes three modules' (src/lib/migration/upload.ts). */
export const MODULE_STEPS: Record<string, string[]> = {
  chart: [],
  invoices: ["invoices"],
  creditnotes: ["credit-notes"],
  customerpayments: ["receipts"],
  bills: ["bills"],
  vendorcredits: ["vendor-credits"],
  vendorpayments: ["vendor-payments"],
  expenses: ["expenses"],
  journals: ["journals"],
  estimates: ["quotes"],
  salesorders: ["sales-orders"],
  // To the archive, no step (src/lib/migration/upload.ts).
  deliverychallans: [],
  purchaseorders: ["purchase-orders"],
  banking: ["journals"],
  refunds: ["journals"],
};

/**
 * A book module handed to the switch the moment it is fetched (owner, 28 Oct 2026: "every section on its own, straight
 * away"): its files stored to their step, ready to check and import while the next modules are still being fetched.
 * A step a later module also feeds (journals: transfers, deposits, refunds) is added to, not replaced. Bill.csv stays
 * in the pull too, for a vendor payment that names its bills only by Zoho's id.
 *
 * `part`: handed over before the module's list was read to the end (`handOverFetched`). Only a whole list says what
 * Zoho no longer has, so a part replaces nothing — it adds, and what comes after adds to it. A part used to replace what
 * was kept: the quotes handed over with only this year's fetched, and the pull stopped, took every earlier year's quote
 * out of the archive with its PDF (owner, 25 Nov 2026 — WT/25-26/QT/4648).
 */
async function handBooks(m: MigrationRow, pullId: string, userId: string, progress: PullProgress, mod: Module, part = false) {
  const names = new Set(MODULE_FILES[mod.key] ?? []);
  const pages = await db.zohoPullPage.findMany({ where: { pullId, file: { in: [...names] } }, orderBy: [{ file: "asc" }, { seq: "asc" }], select: { file: true, rows: true } });
  const files = new Map<string, Rows>();
  for (const p of pages) files.set(p.file, [...(files.get(p.file) ?? []), ...(p.rows as Rows)]);
  if (mod.key === "vendorpayments") {
    const bills = await db.zohoPullPage.findMany({ where: { pullId, file: "Bill.csv" }, select: { rows: true } });
    const billNumbers = new Map(bills.flatMap((b) => b.rows as Rows).map((r) => [r["Bill ID"], r["Bill Number"]]));
    for (const r of files.get("Vendor_Payment.csv") ?? []) if (!r["Bill Number"] && r["Bill ID"]) r["Bill Number"] = billNumbers.get(r["Bill ID"]) ?? "";
  }
  const books: MigrationFileRows[] = [...files].filter(([, rows]) => rows.length).map(([name, rows]) => ({ name, rows }));
  const steps = MODULE_STEPS[mod.key] ?? [];
  const entry: NonNullable<PullProgress["booksHanded"]>[number] = { module: mod.key, steps: [], refused: [] };
  if (books.length) {
    const merge = progress.mode === "topup" || !!progress.earlier || part || !!progress.partHanded?.includes(mod.key) || steps.some((s) => progress.bookSteps?.includes(s));
    try {
      const outcome = await storeUpload(m, books, null, userId, merge);
      entry.steps = outcome.stored.map((s) => ({ step: s.step, units: s.units }));
      entry.refused = outcome.refused.map((r) => r.error);
      progress.bookSteps = [...new Set([...(progress.bookSteps ?? []), ...outcome.stored.map((s) => s.step)])];
      if (part) progress.partHanded = [...new Set([...(progress.partHanded ?? []), mod.key])];
    } catch (err) {
      if (!(err instanceof MigrationRefused)) throw err;
      entry.refused = [err.message];
    }
  }
  // Nothing new since it was last handed over: what that brought still stands.
  const before = progress.booksHanded?.find((b) => b.module === mod.key);
  if (books.length || !before) progress.booksHanded = [...(progress.booksHanded ?? []).filter((b) => b.module !== mod.key), entry];
  // Refused: it stays in the pull, to go when what stopped it is put right — and said on the page.
  if (entry.refused.length) return;
  progress.handedFiles = [...new Set([...(progress.handedFiles ?? []), ...names])];
  const done = [...names].filter((n) => n !== "Bill.csv");
  if (done.length) await db.zohoPullPage.deleteMany({ where: { pullId, file: { in: done } } });
}

/**
 * What has been fetched so far, handed over without waiting for its module to finish (owner, 5 Nov 2026 — "the data
 * which can come, can't it import?"): each book module with rows still in the pull goes to its section, the one being
 * fetched included, whole documents only. When more comes it is added, each record replacing its own copy; what was kept from
 * before stays too, as the module still going hasn't reached all of it (`handBooks` `part`). A module finished and handed
 * already is left be — only its Bill.csv stays behind, for the vendor payments.
 */
export async function handOverFetched(m: MigrationRow, pullId: string, userId: string): Promise<PullView> {
  const found = await db.zohoPull.findFirst({ where: { id: pullId, migrationId: m.id }, select: { status: true } });
  if (!found) throw new MigrationRefused("That pull isn't there.");
  if (!["FETCHING", "WAITING"].includes(found.status)) return view(pullId);
  const until = new Date(Date.now() + 5 * 60_000).toISOString();
  const claimed = await db.$executeRaw`update "zoho_pulls" set "progress" = jsonb_set("progress", '{lease}', to_jsonb(${until}::text)) where "id" = ${pullId} and coalesce("progress"->>'lease', '') < ${new Date().toISOString()}`;
  if (claimed === 0) return { ...(await view(pullId)), busy: true };
  const pull = (await db.zohoPull.findUnique({ where: { id: pullId } }))!;
  const progress = { ...emptyProgress(), ...(pull.progress as unknown as PullProgress) };
  try {
    await flush(pullId, progress);
    const held = new Set((await db.zohoPullPage.findMany({ where: { pullId }, distinct: ["file"], select: { file: true } })).map((p) => p.file));
    for (const [at, mod] of MODULES.entries()) {
      if (mod.master || !(MODULE_FILES[mod.key] ?? []).some((f) => held.has(f))) continue;
      const handed = progress.booksHanded?.find((b) => b.module === mod.key);
      if (at < progress.module && handed && handed.refused.length === 0) continue;
      // Finished but refused when it was handed: the whole of it, so as it would have gone then.
      await handBooks(m, pullId, userId, progress, mod, at >= progress.module);
    }
  } finally {
    delete progress.lease;
    await save(pullId, pull.status, progress);
  }
  return view(pullId);
}

/** What the pull fetched, handed on: the master lists' files to the old-CRM import, the books' to the switch. */
async function store(m: MigrationRow, pullId: string, userId: string, master: boolean, merge = false, handed: string[] = []) {
  // What was handed on as its module finished (`handBooks`) isn't handed again — only what is left.
  const pages = await db.zohoPullPage.findMany({ where: { pullId, file: { notIn: handed } }, orderBy: [{ file: "asc" }, { seq: "asc" }], select: { file: true, rows: true } });
  const files = new Map<string, Rows>();
  for (const p of pages) files.set(p.file, [...(files.get(p.file) ?? []), ...(p.rows as Rows)]);

  // A vendor payment names its bills by Zoho's id; the bills give their numbers.
  const billNumbers = new Map((files.get("Bill.csv") ?? []).map((r) => [r["Bill ID"], r["Bill Number"]]));
  for (const r of files.get("Vendor_Payment.csv") ?? []) if (!r["Bill Number"] && r["Bill ID"]) r["Bill Number"] = billNumbers.get(r["Bill ID"]) ?? "";

  const masters = [...files].filter(([name, rows]) => MASTER_FILES.has(name) && rows.length);
  let masterRun: string | null = null;
  if (masters.length && master) {
    const run = await addFiles(await masterFiles(masters, merge), userId);
    masterRun = run.id;
  }
  const books: MigrationFileRows[] = [...files].filter(([name, rows]) => !MASTER_FILES.has(name) && rows.length).map(([name, rows]) => ({ name, rows }));
  const outcome = books.length ? await storeUpload(m, books, null, userId, merge) : null;
  // What is handed on is kept where it went; the pull's own copy goes.
  await db.zohoPullPage.deleteMany({ where: { pullId } });
  return { masterFiles: masters.map(([name, rows]) => ({ name, rows: rows.length })), masterRun, books: outcome };
}

/** Each master list's own id column: a top-up's record replaces the backup's of the same id. */
const MASTER_IDS: Record<string, string> = { "Contacts.csv": "Contact ID", "Vendors.csv": "Contact ID", "Contact_Persons.csv": "Contact Person ID", "Vendor_Contact_Persons.csv": "Contact Person ID", "Item.csv": "Item ID" };

/**
 * The master lists as the old-CRM import keeps them. A top-up's are added to the files of the same name already in
 * its draft — the backup's — each record replacing the one of its id; with no draft (the lists imported already)
 * they make a new one of their own, and importing it brings only what is new.
 */
async function masterFiles(files: [string, Rows][], merge: boolean) {
  const draft = merge ? await db.legacyImport.findFirst({ where: { status: "DRAFT" }, orderBy: { createdAt: "desc" }, select: { id: true } }) : null;
  const out = [];
  for (const [name, rows] of files) {
    let all = rows;
    if (draft) {
      const prev = await db.legacyImportFile.findFirst({ where: { importId: draft.id, name }, select: { chunks: { orderBy: { seq: "asc" }, select: { rows: true } } } });
      const idColumn = MASTER_IDS[name];
      if (prev && idColumn) {
        const fresh = new Set(rows.map((r) => r[idColumn]).filter(Boolean));
        all = [...prev.chunks.flatMap((c) => c.rows as Rows).filter((r) => !fresh.has(r[idColumn] ?? "")), ...rows];
      }
    }
    out.push({ name, headers: [...new Set(all.flatMap((r) => Object.keys(r)))], rows: all });
  }
  return out;
}

/** Created or changed on or after the day, as the list row says; a row that says neither is taken. */
function changedSince(row: J, since: string): boolean {
  const when = String(row.last_modified_time ?? row.updated_time ?? row.created_time ?? row.date ?? "");
  return !when || when.slice(0, 10) >= since;
}

/** The columns worth seeing of each file the pull fills, the first being what names the record. */
const PREVIEW_COLUMNS: Record<string, string[]> = {
  "Contacts.csv": ["Display Name", "GST Identification Number (GSTIN)", "Billing City", "Billing State", "EmailID"],
  "Vendors.csv": ["Display Name", "GST Identification Number (GSTIN)", "Billing City", "Billing State", "EmailID"],
  "Contact_Persons.csv": ["Customer Name", "First Name", "Last Name", "EmailID", "MobilePhone"],
  "Vendor_Contact_Persons.csv": ["Display Name", "First Name", "Last Name", "EmailID", "MobilePhone"],
  "Item.csv": ["Item Name", "SKU", "HSN/SAC", "Rate", "Status"],
  "Chart_of_Accounts.csv": ["Account Name", "Account Type", "Account Status"],
  "Invoice.csv": ["Invoice Number", "Invoice Date", "Customer Name", "Invoice Status", "Total", "Balance"],
  "Credit_Note.csv": ["Credit Note Number", "Credit Note Date", "Customer Name", "Credit Note Status", "Total"],
  "Creditnotes_Invoice.csv": ["Credit Note Number", "Invoice Number", "Amount"],
  "Customer_Payment.csv": ["Payment Number", "Date", "Customer Name", "Amount", "Invoice Number"],
  "Bill.csv": ["Bill Number", "Bill Date", "Vendor Name", "Bill Status", "Total"],
  "Vendor_Credits.csv": ["Vendor Credit Number", "Vendor Credit Date", "Vendor Name", "Total"],
  "Vendor_Payment.csv": ["Payment Number", "Date", "Vendor Name", "Amount", "Bill Number"],
  "Expense.csv": ["Expense Date", "Expense Account", "Paid Through", "Total"],
  "Journal.csv": ["Journal Number", "Journal Date", "Account", "Debit", "Credit"],
  "Quote.csv": ["Quote Number", "Quote Date", "Customer Name", "Quote Status", "Total"],
  "Sales_Order.csv": ["SalesOrder Number", "Order Date", "Customer Name", "Status", "Total"],
  "Delivery_Challan.csv": ["Delivery Challan Number", "Challan Date", "Customer Name", "Challan Type", "Status", "Total"],
  "Purchase_Order.csv": ["Purchase Order Number", "Purchase Order Date", "Vendor Name", "Purchase Order Status", "Total"],
  "Transfer_Fund.csv": ["Transaction Date", "Transaction Type", "From Account", "To Account", "Total"],
  "Refund.csv": ["Date", "Credit Note Number", "Customer Name", "Amount"],
};
/** A document's file has a row a line: shown once a document, by its number. */
const ONE_A_DOCUMENT = new Set(["Invoice.csv", "Credit_Note.csv", "Bill.csv", "Vendor_Credits.csv", "Quote.csv", "Sales_Order.csv", "Delivery_Challan.csv", "Purchase_Order.csv", "Journal.csv"]);
const PREVIEW_ROWS = 200;

export type PullPreview = { files: { file: string; rows: number }[]; file: string | null; columns: string[]; rows: string[][] };

/**
 * What a pull has fetched so far, before it is handed on (owner, 26 Oct 2026: "show data after every 200"): each
 * file and how many rows it holds, and the newest 200 of one of them with the columns worth seeing. Read only.
 */
export async function pullPreview(pullId: string, file: string | null): Promise<PullPreview> {
  const counts = await db.$queryRaw<{ file: string; rows: number }[]>`select "file", sum(jsonb_array_length("rows"))::int as "rows" from "zoho_pull_pages" where "pullId" = ${pullId} group by "file"`;
  const order = Object.keys(PREVIEW_COLUMNS);
  const files = counts.map((c) => ({ file: c.file, rows: Number(c.rows) })).sort((a, b) => order.indexOf(a.file) - order.indexOf(b.file));
  // The file asked for, else the one fetched most recently.
  const chosen = files.find((f) => f.file === file)?.file ?? (await db.zohoPullPage.findFirst({ where: { pullId }, orderBy: { id: "desc" }, select: { file: true } }))?.file ?? null;
  if (!chosen) return { files, file: null, columns: [], rows: [] };
  const columns = PREVIEW_COLUMNS[chosen] ?? [];
  const rows: string[][] = [];
  const shown = new Set<string>();
  // Newest pages first, until 200 are in hand.
  for (let seq: number | undefined; rows.length < PREVIEW_ROWS; ) {
    const page = await db.zohoPullPage.findFirst({ where: { pullId, file: chosen, ...(seq !== undefined ? { seq: { lt: seq } } : {}) }, orderBy: { seq: "desc" }, select: { seq: true, rows: true } });
    if (!page) break;
    seq = page.seq;
    for (const r of [...(page.rows as Rows)].reverse()) {
      if (ONE_A_DOCUMENT.has(chosen)) {
        const key = r[columns[0]!] ?? "";
        if (shown.has(key)) continue;
        shown.add(key);
      }
      rows.push(columns.map((c) => r[c] ?? ""));
      if (rows.length >= PREVIEW_ROWS) break;
    }
  }
  return { files, file: chosen, columns, rows };
}

/**
 * The server's part (owner, 26 Oct 2026: "does it stop if I close the laptop" — no longer): every tick of the
 * workspace's heartbeat (src/lib/marketing/heartbeat.ts, every five minutes) works the open migration's pull for
 * up to `budgetMs`, page open or not, and a pull waiting for Zoho's next day carries on by itself once it comes.
 */
export async function zohoChores({ budgetMs }: { budgetMs: number }): Promise<{ worked: number } | null> {
  const pulls = await db.zohoPull
    .findMany({ where: { status: { in: ["FETCHING", "STORING", "PDFS", "WAITING"] } }, orderBy: { startedAt: "asc" }, select: { id: true, migrationId: true, startedById: true } })
    // A workspace whose database hasn't reached the Zoho tables yet has none to work.
    .catch(() => null);
  if (!pulls?.length) return null;
  const { openMigration } = await import("@/lib/migration/state");
  const m = await openMigration();
  let worked = 0;
  for (const p of pulls) {
    if (!m || m.id !== p.migrationId) continue;
    // A pull started before who started it was recorded: the server has no session to ask, so it asks the database.
    const starter = await db.user.findUnique({ where: { id: p.startedById }, select: { isSuperAdmin: true, active: true } });
    await db.$executeRaw`update "zoho_pulls" set "progress" = jsonb_set("progress", '{master}', to_jsonb(${Boolean(starter?.isSuperAdmin && starter.active)}::boolean)) where "id" = ${p.id} and not ("progress" ? 'master')`;
    await pullStep(m, p.id, p.startedById, budgetMs);
    worked += 1;
  }
  return { worked };
}
