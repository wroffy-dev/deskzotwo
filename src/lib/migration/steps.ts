import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { isModuleEntitled } from "@/lib/modules-access";
import { normalizeCompanyName } from "@/lib/company-name";
import { DOCUMENT_EXTRA_COLUMNS } from "@/lib/portability/documents";
import { readHeadings } from "@/lib/portability/import";
import { workspaceClock } from "@/lib/time/workspace";
import { applyDocument, applyOpenDocument, checkDocument, checkOpenDocument, documentHeadings, documentStepColumns, documentUnits, openHeadings, openStepColumns, type OpenStepType, type UnitOutcome } from "./documents";
import { applyExpense, checkExpense, expenseColumns, expenseHeadings, expenseUnits } from "./expenses";
import { applyJournal, checkJournal, journalColumns, journalHeadings, journalUnits } from "./journals";
import { ledgerContext, type LedgerContext, type StepContext } from "./ledger";
import { applyBill, applyVendorCredit, billColumns, billHeadings, billUnits, checkBill, checkVendorCredit, vendorCreditColumns, vendorCreditHeadings, vendorCreditUnits } from "./purchases";
import { applyPayment, checkPayment, paymentColumns, paymentHeadings, receiptUnits } from "./receipts";
import { waitingFor, type WaitFor } from "./sections";
import { addCounts, MigrationRefused, type MigrationRow } from "./state";
import { fromZoho, isZohoFile, type CreditApplications } from "./zoho";

/**
 * The steps a migration brings its year through, in this order (src/lib/migration): the sales side — invoices,
 * the credit notes that reduce them, the receipts that paid them — then the purchase side — bills, the vendor
 * credits set against them, the payments that settled them — then expenses and manual journals. Each is a
 * file: uploaded once and kept as rows (MigrationFile), checked a part at a time without writing, then imported
 * a part at a time — so a big year never waits on one long request, and an import stopped half way carries on
 * from where it got to.
 */

export const STEPS = [
  { key: "invoices", label: "Invoices", unit: "invoice", units: "invoices" },
  { key: "credit-notes", label: "Credit notes", unit: "credit note", units: "credit notes" },
  { key: "receipts", label: "Customer receipts", unit: "payment", units: "payments" },
  { key: "bills", label: "Bills", unit: "bill", units: "bills" },
  { key: "vendor-credits", label: "Vendor credits", unit: "vendor credit", units: "vendor credits" },
  { key: "vendor-payments", label: "Vendor payments", unit: "payment", units: "vendor payments" },
  { key: "expenses", label: "Expenses", unit: "expense", units: "expenses" },
  { key: "journals", label: "Manual journals", unit: "journal", units: "journals" },
  { key: "quotes", label: "Open quotes", unit: "quote", units: "quotes" },
  { key: "sales-orders", label: "Open sales orders", unit: "sales order", units: "sales orders" },
  { key: "purchase-orders", label: "Open purchase orders", unit: "purchase order", units: "purchase orders" },
] as const;
export type StepKey = (typeof STEPS)[number]["key"];
export const isStepKey = (v: unknown): v is StepKey => STEPS.some((s) => s.key === v);

/**
 * The modules what a step makes lives in. A workspace whose plan leaves one out doesn't get the step: its
 * invoices or bills would be in the books with no page to open them on. Expenses and journals are the books'
 * own vouchers.
 */
const NEEDS: Record<StepKey, readonly string[]> = {
  invoices: ["sales_documents"],
  "credit-notes": ["sales_documents"],
  receipts: ["sales_documents", "payments"],
  bills: ["purchase_documents"],
  "vendor-credits": ["purchase_documents"],
  "vendor-payments": ["purchase_documents", "payments"],
  expenses: [],
  journals: [],
  quotes: ["sales_documents"],
  "sales-orders": ["sales_documents"],
  "purchase-orders": ["purchase_documents"],
};

/** The steps this workspace's plan has room for, in order. */
export async function stepsInPlan(): Promise<StepKey[]> {
  const modules = [...new Set(Object.values(NEEDS).flat())];
  const entitled = new Map(await Promise.all(modules.map(async (k) => [k, await isModuleEntitled(k)] as const)));
  return STEPS.map((s) => s.key).filter((k) => NEEDS[k].every((m) => entitled.get(m)));
}

/** A part at a time: small enough to finish well inside a request, large enough not to crawl. */
export const CHECK_PART = 150;
export const IMPORT_PART = 40;

/** How a step reads its file, splits it into what it brings, and checks and brings each. */
type Step<U> = {
  headings: { templateColumns: string[]; headerAliases: Record<string, string[]> };
  columns(): string[];
  units(rows: Record<string, string>[]): U[];
  check(unit: U, ctx: StepContext): Promise<UnitOutcome>;
  apply(unit: U, ctx: StepContext): Promise<UnitOutcome>;
};
const step = <U>(s: Step<U>) => s as unknown as Step<unknown>;

/** What was still open on the day of the switch: made live, not posted (./documents.ts). */
const openStep = (type: OpenStepType) =>
  step({ headings: openHeadings(type), columns: () => openStepColumns(type), units: documentUnits, check: (u, ctx) => checkOpenDocument(type, u, ctx), apply: (u, ctx) => applyOpenDocument(type, u, ctx) });

const HANDLERS: Record<StepKey, Step<unknown>> = {
  invoices: step({
    headings: documentHeadings("INVOICE"),
    columns: () => documentStepColumns("INVOICE"),
    units: documentUnits,
    check: (u, ctx) => checkDocument("INVOICE", u, ctx),
    apply: (u, ctx) => applyDocument("INVOICE", u, ctx),
  }),
  "credit-notes": step({
    headings: documentHeadings("CREDIT_NOTE"),
    columns: () => documentStepColumns("CREDIT_NOTE"),
    units: documentUnits,
    check: (u, ctx) => checkDocument("CREDIT_NOTE", u, ctx),
    apply: (u, ctx) => applyDocument("CREDIT_NOTE", u, ctx),
  }),
  receipts: step({
    headings: paymentHeadings("RECEIVED"),
    columns: () => paymentColumns("RECEIVED"),
    units: receiptUnits,
    check: (u, ctx) => checkPayment("RECEIVED", u, ctx),
    apply: (u, ctx) => applyPayment("RECEIVED", u, ctx),
  }),
  bills: step({ headings: billHeadings, columns: billColumns, units: billUnits, check: checkBill, apply: applyBill }),
  "vendor-credits": step({ headings: vendorCreditHeadings, columns: vendorCreditColumns, units: vendorCreditUnits, check: checkVendorCredit, apply: applyVendorCredit }),
  "vendor-payments": step({
    headings: paymentHeadings("PAID"),
    columns: () => paymentColumns("PAID"),
    units: receiptUnits,
    check: (u, ctx) => checkPayment("PAID", u, ctx),
    apply: (u, ctx) => applyPayment("PAID", u, ctx),
  }),
  expenses: step({ headings: expenseHeadings, columns: expenseColumns, units: expenseUnits, check: checkExpense, apply: applyExpense }),
  journals: step({ headings: journalHeadings, columns: journalColumns, units: journalUnits, check: checkJournal, apply: applyJournal }),
  quotes: openStep("PROPOSAL"),
  "sales-orders": openStep("PROFORMA"),
  "purchase-orders": openStep("PURCHASE_ORDER"),
};

export function stepColumns(key: StepKey): string[] {
  return HANDLERS[key].columns();
}

type Unit = { key?: string; number?: string; rows: { row: Record<string, string> }[] };
/** Which document a unit is, for a top-up to replace: its own key, else its number with its party. */
const unitKey = (u: Unit) => u.key ?? `${(u.number ?? "").trim()}|${normalizeCompanyName(u.rows[0]?.row.Party ?? u.rows[0]?.row.Vendor ?? u.rows[0]?.row.Customer ?? "")}`;

/** Keeps a file's rows against the migration, its headings read as the template's. Replaces an earlier one for the step. */
/**
 * `merge` (a top-up from Zoho, src/lib/zoho/pull.ts): what is already kept for the step stays, and only the documents
 * in this file — by their number and party — are replaced or added. The step goes through again from the start; what
 * already came across is passed over as it always is.
 */
export async function storeFile(m: MigrationRow, key: StepKey, filename: string, fileRows: Record<string, string>[], userId: string, applications?: CreditApplications, merge = false) {
  if (m.status !== "OPEN") throw new MigrationRefused("The migration isn't open.");
  if (!(await stepsInPlan()).includes(key)) {
    const units = STEPS.find((s) => s.key === key)!.units;
    throw new MigrationRefused(`Your plan doesn't include the module ${units} are kept in, so they can't come across as ${units}. Bring what they posted in the manual journals file instead.`);
  }
  const handler = HANDLERS[key];
  // A row of empty cells is nothing — a backup trimmed in a spreadsheet keeps thousands of them.
  fileRows = fileRows.filter((r) => Object.values(r).some((v) => typeof v === "string" && v.trim() !== ""));
  // Zoho's own export is read heading by heading (./zoho.ts); anything else through the step's aliases.
  const zoho = isZohoFile(key, fileRows);
  const { rows, readAs } = zoho ? { rows: fromZoho(key, fileRows, applications), readAs: [] } : readHeadings(handler.headings, fileRows);
  let kept: Record<string, string>[] = rows;
  if (merge) {
    const prev = await db.migrationFile.findFirst({ where: { migrationId: m.id, step: key }, select: { rows: true } });
    if (prev) {
      const fresh = new Set((handler.units(rows) as Unit[]).map(unitKey));
      const stays = (handler.units(prev.rows as Record<string, string>[]) as Unit[]).filter((u) => !fresh.has(unitKey(u))).flatMap((u) => u.rows.map((r) => r.row));
      kept = [...stays, ...rows];
    }
  }
  const units = handler.units(kept).length;
  if (units === 0) throw new MigrationRefused("That file has nothing in it to bring across.");
  const known = new Set([...handler.columns(), ...Object.values(DOCUMENT_EXTRA_COLUMNS)]);
  const unknown = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => c && !known.has(c) && c !== "Status" && c !== "Balance due");
  const made = await db.$transaction(async (tx) => {
    await tx.migrationFile.deleteMany({ where: { migrationId: m.id, step: key } });
    return tx.migrationFile.create({ data: { migrationId: m.id, step: key, filename, rows: kept as Prisma.InputJsonValue, units, createdById: userId }, select: { id: true } });
  });
  return { fileId: made.id, units, readAs, unknown, zoho };
}

async function fileOf(m: MigrationRow, fileId: string) {
  const file = await db.migrationFile.findFirst({ where: { id: fileId, migrationId: m.id }, select: { id: true, step: true, rows: true, units: true, done: true, failures: true } });
  if (!file || !isStepKey(file.step)) throw new MigrationRefused("That file isn't there any more. Upload it again.");
  return { ...file, step: file.step as StepKey, rows: file.rows as Record<string, string>[] };
}

/** The books are read once a part, and only by the steps that ask for them. */
async function contextFor(m: MigrationRow, userId: string): Promise<StepContext> {
  let ledger: Promise<LedgerContext> | null = null;
  return {
    migrationId: m.id,
    window: { from: m.yearStart, to: m.switchDate },
    clock: await workspaceClock(),
    userId,
    ledger: () => (ledger ??= ledgerContext(m.id)),
  };
}

/** Checks the next part from `offset`, writing nothing. */
export async function checkPart(m: MigrationRow, fileId: string, offset: number, userId: string): Promise<{ outcomes: UnitOutcome[]; next: number; units: number }> {
  const file = await fileOf(m, fileId);
  const handler = HANDLERS[file.step];
  const units = handler.units(file.rows);
  const ctx = await contextFor(m, userId);
  const part = units.slice(offset, offset + CHECK_PART);
  const outcomes: UnitOutcome[] = [];
  for (const unit of part) outcomes.push(await handler.check(unit, ctx));
  return { outcomes, next: offset + part.length, units: units.length };
}

/**
 * A unit that didn't come across: where it is in the file (`unit`, its index — for a retry to find it again) and, when
 * it is only missing what another section brings, what it waits for (./sections.ts). Kept before `unit` was: no index,
 * so a retry goes through the file again, passing over what came.
 */
export type ImportFailure = { line: number; key: string; error: string; unit?: number; waitFor?: WaitFor };

export type ImportProgress = { done: number; units: number; created: number; skipped: number; failed: ImportFailure[] };

const failureOf = (unit: number, outcome: { line: number; label: string; error: string }): ImportFailure => {
  const waits = waitingFor(outcome.error);
  return { line: outcome.line, key: outcome.label, error: outcome.error, unit, ...(waits ? { waitFor: waits } : {}) };
};

/**
 * Imports the next part of the file, from where the last part stopped. A unit that fails is kept with why in the
 * file's failures and the import moves past it; fixing the file and uploading it again brings what was left,
 * passing over what already came. One that only waits for another section is kept as waiting (./sections.ts).
 */
export async function importPart(m: MigrationRow, fileId: string, userId: string): Promise<ImportProgress> {
  if (m.status !== "OPEN") throw new MigrationRefused("The migration isn't open.");
  const file = await fileOf(m, fileId);
  const handler = HANDLERS[file.step];
  const units = handler.units(file.rows);
  const ctx = await contextFor(m, userId);
  const part = units.slice(file.done, file.done + IMPORT_PART);
  let created = 0;
  let skipped = 0;
  const failed: ImportFailure[] = [];
  for (const [i, unit] of part.entries()) {
    const outcome = await handler.apply(unit, ctx);
    if (outcome.kind === "create") created += 1;
    else if (outcome.kind === "skip") skipped += 1;
    else failed.push(failureOf(file.done + i, outcome));
  }
  const done = file.done + part.length;
  const earlier = (file.failures as ImportFailure[] | null) ?? [];
  await db.migrationFile.update({ where: { id: file.id }, data: { done, failures: [...earlier, ...failed] as Prisma.InputJsonValue } });
  await addCounts(m.id, { [file.step]: created });
  return { done, units: units.length, created, skipped, failed: [...earlier, ...failed] };
}

/** `restart`: the file is to go through again from its start (failures kept before units were numbered). */
export type RetryProgress = { after: number; left: number; created: number; failed: ImportFailure[]; restart?: boolean };

/**
 * Tries the waiting units again, a part at a time (owner, 28 Oct 2026): the ones waiting for `waitFor` (any, when not
 * given), from the unit after `after`. Each brought across leaves the failures; one that still can't keeps its new why.
 * A failure kept before units were numbered can't be found again, so the file goes through again instead — passing
 * over what came, as an upload of it would.
 */
export async function retryWaitingPart(m: MigrationRow, fileId: string, userId: string, waitFor: WaitFor[] | null, after: number): Promise<RetryProgress> {
  if (m.status !== "OPEN") throw new MigrationRefused("The migration isn't open.");
  const file = await fileOf(m, fileId);
  const failures = (file.failures as ImportFailure[] | null) ?? [];
  const wanted = (f: ImportFailure) => !!f.waitFor && (!waitFor || waitFor.includes(f.waitFor));
  if (failures.some((f) => wanted(f) && f.unit === undefined)) {
    await db.migrationFile.update({ where: { id: file.id }, data: { done: 0, failures: [] } });
    return { after: Number.MAX_SAFE_INTEGER, left: 0, created: 0, failed: [], restart: true };
  }
  const handler = HANDLERS[file.step];
  const units = handler.units(file.rows);
  const ctx = await contextFor(m, userId);
  const todo = failures.filter((f) => wanted(f) && f.unit! > after).sort((a, b) => a.unit! - b.unit!);
  const part = todo.slice(0, IMPORT_PART);
  const tried = new Set(part.map((f) => f.unit!));
  const again: ImportFailure[] = [];
  let created = 0;
  for (const f of part) {
    const unit = units[f.unit!];
    if (!unit) continue;
    const outcome = await handler.apply(unit, ctx);
    if (outcome.kind === "create") created += 1;
    else if (outcome.kind === "error") again.push(failureOf(f.unit!, outcome));
  }
  const kept = [...failures.filter((f) => f.unit === undefined || !tried.has(f.unit)), ...again].sort((a, b) => (a.unit ?? 0) - (b.unit ?? 0));
  await db.migrationFile.update({ where: { id: file.id }, data: { failures: kept as Prisma.InputJsonValue } });
  await addCounts(m.id, { [file.step]: created });
  return { after: part.length ? part[part.length - 1]!.unit! : Number.MAX_SAFE_INTEGER, left: todo.length - part.length, created, failed: kept };
}

/** Each step's file as it stands — for the page. */
export async function stepFiles(m: MigrationRow) {
  const files = await db.migrationFile.findMany({ where: { migrationId: m.id }, select: { id: true, step: true, filename: true, units: true, done: true, failures: true, createdAt: true } });
  return files.map((f) => ({ ...f, failures: (f.failures as ImportFailure[] | null) ?? [] }));
}

/** The columns worth seeing of a step's file, in this order, those the step has — the first names the record. */
const PREVIEW_COLUMNS = ["Number", "Credit number", "Payment number", "Journal number", "Date", "Party", "Customer", "Vendor", "Expense account", "Paid through", "Status", "Amount", "Total", "Invoice", "Bill", "Reference"];
const PREVIEW_UNITS = 200;

export type StepPreview = { step: StepKey; units: number; columns: string[]; rows: string[][] };

/**
 * What a step holds, ready to check and import (owner, 5 Nov 2026: "also show what all is handed over"): how many
 * it brings, and the last 200 of them as the file has them, one row a record. Read only; null when it holds nothing.
 */
export async function stepPreview(m: MigrationRow, key: StepKey): Promise<StepPreview | null> {
  const file = await db.migrationFile.findFirst({ where: { migrationId: m.id, step: key }, orderBy: { createdAt: "desc" }, select: { rows: true, units: true } });
  if (!file) return null;
  const all = (HANDLERS[key].units(file.rows as Record<string, string>[]) as Unit[]).slice(-PREVIEW_UNITS).reverse();
  const own = new Set(stepColumns(key));
  const columns = PREVIEW_COLUMNS.filter((c) => own.has(c));
  const lines = all.some((u) => u.rows.length > 1);
  return {
    step: key,
    units: file.units,
    columns: lines ? [...columns, "Lines"] : columns,
    rows: all.map((u) => {
      const head = u.rows[0]?.row ?? {};
      const cells = columns.map((c) => head[c] ?? "");
      return lines ? [...cells, String(u.rows.length)] : cells;
    }),
  };
}
