"use server";

import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/authz/resolve";
import { db } from "@/lib/db";
import { moveBooksLock } from "@/lib/ledger/books-lock";
import { chooseAccount, listAccounts, makeRestNew } from "@/lib/migration/accounts";
import { openFromArchive, takeBackVoidOpened, voidOpened } from "@/lib/migration/opened";
import { notCounted, takeBackNotCounted } from "@/lib/migration/not-counted";
import { advancesToCarry, carryAdvances } from "@/lib/migration/advances";
import { linkOldOrders, oldOrderLinks } from "@/lib/migration/old-orders";
import { ARCHIVE_LABELS, archiveCheck, archiveCounts, archivedDocumentsPage, rematchArchive, unmatchedParties, type ArchiveKind } from "@/lib/migration/archive";
import { addAdjustment, compareMonths, uploadBalances } from "@/lib/migration/balances";
import { checkPart, importPart, isStepKey, retryWaitingPart, storeFile, stepColumns } from "@/lib/migration/steps";
import { WAIT_LABELS, type WaitFor } from "@/lib/migration/sections";
import { planSectionUndo, undoSection } from "@/lib/migration/undo-section";
import { asDate, dayOf, latestMigration, MigrationRefused, moveSwitchDay, openMigration, startMigration, undoMigration } from "@/lib/migration/state";
import { requireModuleAccess, requireModuleUser } from "@/lib/modules-access";
import { workspaceClock } from "@/lib/time/workspace";
import { latestPull } from "@/lib/zoho/pull";
import { bringWaitingParties } from "@/lib/zoho/waiting-parties";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { parseFile } from "@/lib/portability/import";
import { csvRow } from "@/lib/csv";
import { logActivity } from "@/lib/activity";
import { getSecurityPolicy } from "@/lib/security/store";
import { exportDecision } from "@/lib/security/policy";
import type { ActionResult } from "@/actions/company";

/**
 * Settings › Import & export › Switch to Deskzo (owner, 24 Oct 2026; src/lib/migration): bringing the rest of
 * the financial year across from the old system.
 *
 * Who may: whoever may post journals by hand and import finance data (`ledger.post` + `data.importFinance`),
 * as the opening-balances import asks. Finishing locks the months, so it asks what closing the books asks
 * (`books.close`). Files are read once and kept as rows against the migration until imported.
 */

const MAX_BYTES = 10 * 1024 * 1024;
type FileInput = { filename: string; base64: string };

async function gate(): Promise<{ id: string; name: string }> {
  const user = await requireModuleUser("accounting");
  if (!(await can(user.id, "ledger.post")) || !(await can(user.id, "data.importFinance"))) {
    throw new MigrationRefused("Bringing a year across needs the rights to post journal entries and to import finance data.");
  }
  return user;
}

/**
 * `gate` for the actions only Accounting's own pages use: Accounting open to the person as well. The actions other
 * screens use keep `gate` alone (owner, 3 Nov 2026 — Phase 2 permission fixes, audit L-6).
 */
async function gateIfOpen(...args: Parameters<typeof gate>) {
  await requireModuleAccess("accounting");
  return gate(...args);
}

async function run<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (err) {
    if (err instanceof MigrationRefused) return { ok: false, error: err.message };
    throw err;
  }
}

async function open() {
  const m = await openMigration();
  if (!m) throw new MigrationRefused("No migration is open.");
  return m;
}

async function rowsOf(input: FileInput) {
  if (!input || typeof input.filename !== "string" || typeof input.base64 !== "string") throw new MigrationRefused("Choose a file.");
  if (Buffer.byteLength(input.base64, "base64") > MAX_BYTES) throw new MigrationRefused(`That file is over ${MAX_BYTES / 1024 / 1024}MB — split it by months.`);
  if (!/\.(csv|xlsx)$/i.test(input.filename)) throw new MigrationRefused("Use a .csv or .xlsx file.");
  const rows = await parseFile(input.base64, input.filename);
  if (rows.length === 0) throw new MigrationRefused("That file has no rows.");
  return rows;
}

const refresh = () => {
  revalidatePath("/settings/data/switch");
  revalidatePath("/accounting", "layout");
};

/** The switch moved later — the year grows, and what the old system dates after the old day comes across too. */
export async function moveSwitchDayAction(switchDate: string) {
  return run(async () => {
    const user = await gate();
    const m = await moveSwitchDay(await open(), switchDate, user.id);
    refresh();
    return { switchDate: m.switchDate };
  });
}

export async function startMigrationAction(input: { source: string; yearStart: string; switchDate: string }) {
  return run(async () => {
    const user = await gate();
    const m = await startMigration(input, user.id);
    refresh();
    return { id: m.id };
  });
}

export async function uploadMigrationFile(step: string, input: FileInput) {
  return run(async () => {
    const user = await gateIfOpen();
    if (!isStepKey(step)) throw new MigrationRefused("Choose a step.");
    const m = await open();
    const stored = await storeFile(m, step, input.filename, await rowsOf(input), user.id);
    refresh();
    return stored;
  });
}

export async function checkMigrationPart(fileId: string, offset: number) {
  return run(async () => {
    const user = await gate();
    return checkPart(await open(), String(fileId), Math.max(0, Math.floor(Number(offset) || 0)), user.id);
  });
}

export async function importMigrationPart(fileId: string) {
  return run(async () => {
    const user = await gate();
    const progress = await importPart(await open(), String(fileId), user.id);
    if (progress.done >= progress.units) refresh();
    return progress;
  });
}

/**
 * The waiting rows of a section tried again, a part at a time (owner, 28 Oct 2026): those waiting for `waitFor` — what
 * was just imported — or all of them for "Retry waiting". The page calls it until nothing is left.
 */
export async function retryMigrationWaiting(fileId: string, waitFor: string[] | null, after: number) {
  return run(async () => {
    const user = await gate();
    const wanted = Array.isArray(waitFor) ? waitFor.filter((w): w is WaitFor => w in WAIT_LABELS) : null;
    const progress = await retryWaitingPart(await open(), String(fileId), user.id, wanted, Number.isFinite(Number(after)) ? Number(after) : -1);
    if (progress.left === 0) refresh();
    return progress;
  });
}

/**
 * "Bring these from Zoho" on a section's rows waiting for customers or vendors (src/lib/zoho/waiting-parties.ts): the
 * super admin's, as the master lists from Zoho are. The page then tries the waiting rows again.
 */
export async function bringWaitingFromZoho(fileId: string, list: string) {
  return run(async () => {
    const user = await gate();
    if (!(await actingAsSuperAdmin(user.id))) throw new MigrationRefused("Only the super admin brings customers and vendors from Zoho, as with the master lists.");
    if (list !== "customers" && list !== "vendors") throw new MigrationRefused("Customers or vendors.");
    const done = await bringWaitingParties(await open(), String(fileId), list, user.id);
    refresh();
    return done;
  });
}

/** What undoing one section would take back, with what goes with it — shown before it happens. */
export async function sectionUndoPreview(step: string) {
  return run(async () => {
    await gate();
    if (!isStepKey(step)) throw new MigrationRefused("Choose a section.");
    const plan = await planSectionUndo(await open(), step);
    return { own: plan.own, dependents: plan.dependents, refusal: plan.refusal };
  });
}

/** Undoes one section, and what depends on it; the rest of the switch stays. */
export async function undoMigrationSection(step: string) {
  return run(async () => {
    const user = await gate();
    if (!isStepKey(step)) throw new MigrationRefused("Choose a section.");
    const done = await undoSection(await open(), step, user.id);
    refresh();
    return done;
  });
}

export async function uploadMigrationBalances(input: FileInput & { month?: string | null }) {
  return run(async () => {
    const user = await gateIfOpen();
    const m = await open();
    const result = await uploadBalances(m, await rowsOf(input), input.month || null);
    if (result.failed.length === 0) {
      await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Migration", entityId: m.id, entityLabel: `Uploaded the old system's trial balance for ${result.months.join(", ")} (${input.filename})` });
      refresh();
    }
    return result;
  });
}

export async function addMigrationAdjustment(input: { month: string; debitAccountId: string; creditAccountId: string; amount: number | string; reason: string }) {
  return run(async () => {
    const user = await gate();
    const m = await open();
    const made = await addAdjustment(m, input, user.id);
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "Migration", entityId: m.id, entityLabel: `Migration adjustment ${made.entryNumber} for ${input.month}: ${String(input.reason).slice(0, 120)}` });
    refresh();
    return made;
  });
}

export async function undoMigrationAction() {
  return run(async () => {
    const user = await gate();
    const m = await open();
    const taken = await undoMigration(m.id, user.id);
    refresh();
    return taken;
  });
}

/**
 * Finishes it: every month uploaded and agreeing, then the books locked to the day before the switch, so
 * nothing more is posted into the year that came across. Asks what closing the books asks.
 */
export async function finishMigrationAction() {
  return run(async () => {
    const user = await gate();
    if (!(await can(user.id, "books.close"))) throw new MigrationRefused("Finishing locks the months, so it needs the right to close the books — ask an admin.");
    const m = await open();
    const months = await compareMonths(m);
    const missing = months.filter((x) => !x.uploaded).map((x) => x.month);
    if (missing.length) throw new MigrationRefused(`Upload the old system's trial balance for ${missing.join(", ")} first.`);
    const off = months.filter((x) => !x.agrees).map((x) => x.month);
    if (off.length) throw new MigrationRefused(`${off.join(", ")} ${off.length === 1 ? "doesn't" : "don't"} agree with the old system yet.`);
    return closeMigration(m, user.id, "agrees with the old system and is locked", "the year before it was brought across and checked");
  });
}

/** Locks the books to the day before the switch, marks the migration finished and lets its files go. */
async function closeMigration(m: Awaited<ReturnType<typeof open>>, userId: string, audit: string, lockNote: string) {
  const lastDay = dayOf(new Date(asDate(m.switchDate).getTime() - 86_400_000));
  // The lock can't run ahead of the calendar, and the old system is still in use until the switch: finishing waits
  // for the day (owner, 29 Oct 2026 — "You can't lock a period that hasn't finished" said it badly).
  if ((await workspaceClock()).today() < dayOf(asDate(m.switchDate))) {
    throw new MigrationRefused(`Finish on or after ${m.switchDate}, the switch day — the books lock to ${lastDay}, and that day hasn't ended yet. Until then keep working in the old system; on the day, bring its last days across (Zoho: "Top up since the backup"), then finish.`);
  }
  await db.$transaction(async (tx) => {
    const lock = await tx.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } });
    if (!lock?.lockedUntil || dayOf(lock.lockedUntil) < lastDay) {
      const moved = await moveBooksLock(tx, { lockedUntil: lastDay, note: `Switched to Deskzo on ${m.switchDate}: ${lockNote}`, userId });
      if (!moved.ok) throw new MigrationRefused(moved.error);
    }
    await tx.migration.update({ where: { id: m.id }, data: { status: "FINISHED", finishedById: userId, finishedAt: new Date() } });
    await tx.migrationFile.deleteMany({ where: { migrationId: m.id } });
  });
  await recordAudit({ userId, action: "UPDATE", entityType: "Migration", entityId: m.id, entityLabel: `Finished the migration: ${m.yearStart} to ${lastDay} ${audit}` });
  refresh();
  return { lockedUntil: lastDay };
}

/**
 * Finishes it for sales only (owner, 29 Oct 2026): the books stay in another system for the year — Tally, say — and
 * Deskzo runs proposals, invoicing and payments. What came across stays, without the month-end check; the months lock
 * as a full finish locks them, so what Deskzo holds of them stays as the old system had it. Not while a Zoho pull is
 * still bringing things across: what it brings after would have no migration to land in.
 */
export async function finishSalesOnlyAction() {
  return run(async () => {
    const user = await gate();
    if (!(await can(user.id, "books.close"))) throw new MigrationRefused("Finishing locks the months, so it needs the right to close the books — ask an admin.");
    const m = await open();
    const pull = await latestPull(m.id).catch(() => null);
    if (pull && ["FETCHING", "STORING", "PDFS", "WAITING"].includes(pull.status)) {
      throw new MigrationRefused("The Zoho pull is still bringing things across — let it finish first, or it has nowhere to put what it brings.");
    }
    return closeMigration(m, user.id, "brought across for sales only — the books kept in the old system — and locked", "sales brought across; the year's books kept in the old system");
  });
}

/** The old system's chart beside Deskzo's: what each of its accounts is read as (src/lib/migration/accounts.ts). */
export async function migrationAccounts() {
  return run(async () => {
    await gate();
    return listAccounts(await open());
  });
}

/** One old account read as a Deskzo account, made new in Deskzo's chart ("new"), or left waiting (null). */
export async function chooseMigrationAccount(rowId: string, choice: string | null) {
  return run(async () => {
    const user = await gate();
    const m = await open();
    const row = await chooseAccount(m, String(rowId ?? ""), choice === null ? null : String(choice));
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Migration", entityId: m.id, entityLabel: `Old chart: ${row.name} ${row.accountId ? (row.created ? "made new in Deskzo's chart" : "read as a Deskzo account") : "left to choose"}` });
    return row;
  });
}

/** Every old account still waiting made new in Deskzo's chart; the ones that can't be, with why. */
export async function makeRestOfChartNew() {
  return run(async () => {
    const user = await gate();
    const m = await open();
    const done = await makeRestNew(m);
    if (done.made) await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Migration", entityId: m.id, entityLabel: `Old chart: ${done.made} account(s) made new in Deskzo's chart` });
    return done;
  });
}

/** The earlier years' invoices, then bills, still owing when the year began, opened from the archive (src/lib/migration/opened.ts). */
export async function openArchivedDocuments() {
  return run(async () => {
    const user = await gate();
    const m = await open();
    const invoices = await openFromArchive(m, "INVOICE", user.id);
    const bills = invoices.more ? { opened: 0, left: [], more: 0 } : await openFromArchive(m, "BILL", user.id);
    const opened = invoices.opened + bills.opened;
    if (opened) await recordAudit({ userId: user.id, action: "CREATE", entityType: "Migration", entityId: m.id, entityLabel: `Earlier years: ${opened} invoice(s) and bill(s) still owing opened from the archive` });
    // Bills wait while invoices have more to open, so each press stays a hundred at most; "more" asks for another.
    return { opened, left: [...invoices.left, ...bills.left], more: invoices.more + bills.more };
  });
}

/** Documents opened from the archive though the old system shows them void: the list, which changes nothing. */
export async function listVoidOpened() {
  return run(async () => {
    await gate();
    return voidOpened(await open());
  });
}

/** Takes those back with their opening entries, up to a hundred at a press. */
export async function removeVoidOpened() {
  return run(async () => {
    const user = await gate();
    const m = await open();
    const done = await takeBackVoidOpened(m);
    if (done.takenBack) await recordAudit({ userId: user.id, action: "DELETE", entityType: "Migration", entityId: m.id, entityLabel: `Earlier years: took back ${done.takenBack} document(s) void in the old system, ₹${done.owing.toLocaleString("en-IN")}` });
    return done;
  });
}

/**
 * This year's invoices and credit notes brought across though Zoho doesn't count them — rejected, waiting for approval,
 * void or a draft there (owner, 17 Nov 2026; src/lib/migration/not-counted.ts). Asks Zoho; changes nothing.
 */
export async function listNotCounted() {
  return run(async () => {
    await gate();
    return notCounted(await open());
  });
}

/** Takes those back with their ledger entries — found again from Zoho, never from what the page sent. */
export async function removeNotCounted() {
  return run(async () => {
    const user = await gate();
    const m = await open();
    const done = await takeBackNotCounted(m);
    if (done.takenBack) await recordAudit({ userId: user.id, action: "DELETE", entityType: "Migration", entityId: m.id, entityLabel: `This year: took back ${done.takenBack} document(s) Zoho doesn't count (rejected, awaiting approval, void or draft there), net ₹${done.total.toLocaleString("en-IN")}` });
    return done;
  });
}

/**
 * Advances from before the year that Zoho set against this year's invoices, to carry in (owner, 17 Nov 2026;
 * src/lib/migration/advances.ts). The list; changes nothing.
 */
export async function listAdvances() {
  return run(async () => {
    await gate();
    return advancesToCarry(await open());
  });
}

/** Carries them in, a hundred at a press — found again, never from what the page sent. */
export async function carryAdvancesIn() {
  return run(async () => {
    const user = await gate();
    const m = await open();
    const done = await carryAdvances(m, user.id);
    if (done.carried) await recordAudit({ userId: user.id, action: "CREATE", entityType: "Migration", entityId: m.id, entityLabel: `Carried ${done.carried} advance(s) from before the year into it, ₹${done.amount.toLocaleString("en-IN")}` });
    return done;
  });
}

/**
 * Old orders and the old system's invoices that billed them (owner, 21 Nov 2026; src/lib/migration/old-orders.ts).
 * The list; changes nothing.
 */
export async function listOldOrderLinks() {
  return run(async () => {
    await gate();
    return oldOrderLinks(await open());
  });
}

/** Links the sure pairs — or, `nearest`, those left to choose by nearest date — five hundred at a press, found again. */
export async function linkOldOrdersNow(nearest = false) {
  return run(async () => {
    const user = await gate();
    const m = await open();
    const done = await linkOldOrders(m, { nearest: nearest === true });
    if (done.linked) await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Migration", entityId: m.id, entityLabel: `Linked ${done.linked} old order(s) to the old system's invoices that billed them${nearest === true ? ", each to the invoice nearest its date" : ""}` });
    return done;
  });
}

/** The old system's earlier years kept to be read, and the per-company check of what they still owe (src/lib/migration/archive.ts). */
export async function migrationArchive() {
  return run(async () => {
    await gate();
    const m = await open();
    const [counts, check] = await Promise.all([archiveCounts(m.id), archiveCheck(m.id)]);
    return { counts, ...check };
  });
}

/**
 * The earlier years as a spreadsheet (owner, 29 Oct 2026: "export option here"): "companies" — one row a company the
 * archive names that Deskzo doesn't have, to bring in; "unmatched" — those documents; "all" — every document kept.
 */
export async function exportMigrationArchive(which: "companies" | "unmatched" | "all") {
  return run(async () => {
    const user = await gate();
    // Security audit round two, 13 Nov 2026 (low): the earlier years are every invoice and bill the old system held, and
    // this file skipped what every finance download has (src/actions/data-export.ts, src/lib/receivables/aging-export.ts):
    // the finance export permission, the workspace's row limit, and a line in the activity log either way.
    const what = which === "companies" ? "the earlier years' companies not in Deskzo" : which === "unmatched" ? "the earlier years' documents without a company" : "the earlier years' documents";
    if (!(await can(user.id, "data.exportFinance"))) {
      await logActivity({ kind: "PERMISSION_DENIED", severity: "WARNING", summary: `${user.name} tried to download ${what} without the export permission`, metadata: { report: "migration-archive", which } });
      throw new MigrationRefused("Downloading financial data needs the export permission.");
    }
    const policy = await getSecurityPolicy();
    const allowedOrRefused = async (rows: number) => {
      const verdict = exportDecision(rows, policy);
      if (verdict.allowed) return;
      await logActivity({ kind: "EXPORT", severity: "WARNING", summary: `${user.name} was refused a download of ${what} — ${rows.toLocaleString("en-IN")} rows, over the limit`, metadata: { report: "migration-archive", which, rows, limit: policy.exportRowLimit } });
      throw new MigrationRefused(verdict.reason);
    };
    const logged = async (rows: number) =>
      logActivity({ kind: "EXPORT", severity: "NOTICE", summary: `${user.name} downloaded ${what} — ${rows.toLocaleString("en-IN")} rows`, metadata: { report: "migration-archive", which, rows } });

    const m = await open();
    const day = dayOf(new Date());
    if (which === "companies") {
      const parties = await unmatchedParties(m.id);
      await allowedOrRefused(parties.length);
      const lines = [csvRow(["Company (old system)", "Old system id", "Was", "Documents", "Which", "First", "Last"]), ...parties.map((p) => csvRow([p.name, p.oldId ?? "", p.role, p.documents, p.kinds, p.first, p.last]))];
      await logged(parties.length);
      return { filename: `earlier-years-companies-not-in-deskzo-${day}.csv`, csv: lines.join("\n") };
    }
    const lines = [csvRow(["Kind", "Number", "Date", "Year", "Company (old system)", "Old system id", "Company in Deskzo", "Status", "Currency", "Total", "Still owing", "Due", "Reference"])];
    for (let after: string | null = null; ; ) {
      const page = await archivedDocumentsPage(m.id, which === "unmatched", after);
      for (const d of page) {
        lines.push(csvRow([ARCHIVE_LABELS[d.kind as ArchiveKind] ?? d.kind, d.number, dayOf(d.date), d.year, d.partyName, d.partyOldId ?? "", d.deskzoCompany, d.status ?? "", d.currency ?? "", Number(d.total), d.balance === null ? "" : Number(d.balance), d.dueDate ? dayOf(d.dueDate) : "", d.reference ?? ""]));
      }
      // Checked as the pages come, so a file over the limit is refused without being built whole.
      await allowedOrRefused(lines.length - 1);
      if (page.length < 5000) break;
      after = page[page.length - 1]!.id;
    }
    await logged(lines.length - 1);
    return { filename: `earlier-years-${which === "unmatched" ? "without-a-company" : "all"}-${day}.csv`, csv: lines.join("\n") };
  });
}

/** The archive's documents with no company yet, matched to the companies brought in since — no call to Zoho. */
export async function rematchMigrationArchive() {
  return run(async () => {
    const user = await gate();
    const m = await open();
    const result = await rematchArchive(m.id);
    if (result.matched) await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Migration", entityId: m.id, entityLabel: `Matched ${result.matched} earlier-year documents to their companies` });
    return result;
  });
}

/** A step's template, as CSV: its columns and nothing else. */
export async function migrationTemplate(step: string) {
  return run(async () => {
    await gate();
    if (step === "balances") return { filename: "trial-balances.csv", csv: `${csvRow(["Month", "Account code", "Account", "Debit", "Credit"])}\n` };
    if (!isStepKey(step)) throw new MigrationRefused("Choose a step.");
    return { filename: `${step}.csv`, csv: `${csvRow(stepColumns(step))}\n` };
  });
}

/** For the page's header: whether anything is open. */
export async function migrationSummary() {
  await requireModuleAccess("accounting");
  const m = await latestMigration().catch(() => null);
  return m ? { status: m.status, yearStart: m.yearStart, switchDate: m.switchDate } : null;
}
