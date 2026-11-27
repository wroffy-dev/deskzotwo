/**
 * check:audit-round2-imports — the security audit's round two, 13 Nov 2026 (docs/reports/security-audit-2026-11-11.md
 * §11), group I: bulk imports that skipped the rules their forms enforce. Each fix shown to hold the way it was broken.
 *
 *   R2-01  a payroll manager importing their own salary, bank account or TDS is refused, in the preview and the write,
 *          by the payroll import and through Kredily's; both refuse while viewing as somebody
 *   R2-03  the chart-of-accounts import needs ledger.manageAccounts; an account with entries keeps its type and can't
 *          become a group; nor can one with a system key
 *   R2-04  the expenses import keeps to the importer's claims, the form's amount/tax/description rules, and files a
 *          claim in somebody else's name only for an approver
 *   R2-19  an .xlsx or ZIP that inflates past its cap is refused without being inflated whole; row and column caps;
 *          the import route reads its body with a ceiling
 *   lows   people import pay inputs; items price/tax; Kredily attendance skips payroll-locked months
 *
 * Its own fixture, named ZZR2I, removed in a finally; every assertion is about that fixture (the local database is
 * full). Read-only checks against the workspace's own chart of accounts are previews, which write nothing.
 *
 *   npx tsx scripts/check-audit-round2-imports.ts
 */
import "dotenv/config";
import Module from "node:module";
import { Readable } from "node:stream";
import JSZip from "jszip";
import ExcelJS from "exceljs";
import Papa from "papaparse";
import { db } from "../src/lib/db";

const TAG = "ZZR2I";
const MAIL = "@zzr2i.invalid";
const VIEW_AS = "ZZR2I: refused while viewing as somebody.";
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

let actorId = "";
let viewingAs = false;
const internals = Module as unknown as { _load(req: string, parent: unknown, isMain: boolean): unknown };
const original = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
  if (request.endsWith("lib/session") || request === "@/lib/session") {
    const user = async () => (actorId ? { id: actorId, name: "Zzr2i", role: "PROFILE", email: `${actorId}${MAIL}` } : null);
    return {
      requireUser: async () => {
        const u = await user();
        if (!u) throw new Error("Unauthorized");
        return u;
      },
      currentUser: user,
      viewAsContext: async () => (viewingAs ? { viewer: actorId, subject: "someone" } : null),
      refuseWhileViewingAs: async () => (viewingAs ? VIEW_AS : null),
    };
  }
  return original.call(this, request, parent, isMain);
} as typeof original;

const csvFile = (rows: Record<string, string>[], name = "file.csv") => ({ filename: name, base64: Buffer.from(Papa.unparse(rows)).toString("base64") });

/** `bytes` of one character, made as they are read — never held whole. */
function repeated(bytes: number, char = "a"): Readable {
  const chunk = Buffer.alloc(1024 * 1024, char);
  let left = bytes;
  return new Readable({
    read() {
      if (left <= 0) return this.push(null);
      const n = Math.min(left, chunk.length);
      left -= n;
      this.push(n === chunk.length ? chunk : chunk.subarray(0, n));
    },
  });
}

/** A ZIP of `files`, deflated; a Readable's bytes streamed through, so a large entry is never in memory whole. */
async function zipOf(files: Record<string, string | Buffer | Readable>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) zip.file(name, data as never);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 }, streamFiles: true });
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`;

async function cleanup() {
  const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  if (ids.length) {
    await db.attendanceDay.deleteMany({ where: { userId: { in: ids } } });
    await db.expense.deleteMany({ where: { userId: { in: ids } } });
    await db.salaryStructure.deleteMany({ where: { userId: { in: ids } } });
    await db.taxDeclaration.deleteMany({ where: { userId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.activityLog.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
    await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
    await db.employeeProfile.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
  await db.payrollRun.deleteMany({ where: { month: 1, year: 2001, note: TAG } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const payrollImport = require("../src/actions/payroll-import") as typeof import("../src/actions/payroll-import");
  const kredilyImport = require("../src/actions/kredily-import") as typeof import("../src/actions/kredily-import");
  const dataImport = require("../src/actions/data-import") as typeof import("../src/actions/data-import");
  const { plan, apply, parseFile } = require("../src/lib/portability/import") as typeof import("../src/lib/portability/import");
  const { planWith } = require("../src/lib/portability/import") as typeof import("../src/lib/portability/import");
  const { payrollImporter, OWN_PAY_REFUSAL } = require("../src/lib/portability/importers/payroll") as typeof import("../src/lib/portability/importers/payroll");
  const { FileTooLarge, inflatedWithin, SHEET_LIMITS } = require("../src/lib/portability/workbook") as typeof import("../src/lib/portability/workbook");
  const { readKredily } = require("../src/lib/kredily/read") as typeof import("../src/lib/kredily/read");
  const { readMigrationUpload } = require("../src/lib/migration/upload") as typeof import("../src/lib/migration/upload");
  const { attendancePlan } = require("../src/lib/kredily/attendance-days") as typeof import("../src/lib/kredily/attendance-days");
  const route = require("../src/app/api/data-import/route") as typeof import("../src/app/api/data-import/route");
  /* eslint-enable @typescript-eslint/no-require-imports */

  await cleanup();
  let madeRun = false;
  try {
    // Not admins: an admin holds every permission. Each holds exactly what the check is about.
    const make = async (key: string, permissions: string[], code?: string) => {
      const u = await db.user.create({
        data: { name: `${TAG} ${key}`, email: `${key}${MAIL}`, role: "PROFILE", passwordHash: "x".repeat(60), ...(code ? { employeeProfile: { create: { employeeCode: code, state: "Delhi" } } } : {}) },
      });
      for (const permission of permissions) await db.userPermission.create({ data: { userId: u.id, permission, allowed: true, reason: TAG } });
      return u;
    };
    const clerk = await make("clerk", ["payroll.manage", "users.manage", "hr.manage", "data.importPeople"], "ZZR2I-001");
    const payOnly = await make("payonly", ["payroll.manage"], "ZZR2I-004");
    const asha = await make("asha", [], "ZZR2I-002");
    const ravi = await make("ravi", [], "ZZR2I-003");
    const approver = await make("approver", ["expenses.approve", "expenses.viewAll"]);
    const noLedger = await make("noledger", ["data.importFinance"]);

    // ── R2-01 ────────────────────────────────────────────────────────────────────────────────────────────
    section("R2-01: your own pay, through the payroll import and Kredily's");
    const payRow = (code: string, over: Record<string, string> = {}) => ({ "Employee code": code, "Salary from": "01/11/2030", "Monthly gross": "50000", Basic: "25000", HRA: "10000", "Account number": "123456789012", "TDS this year": "", ...over });
    const payFile = csvFile([payRow("ZZR2I-001", { "TDS this year": "0", "Gross paid this year": "10" }), payRow("ZZR2I-002")]);
    actorId = clerk.id;
    const preview = await payrollImport.previewPayrollImport(payFile);
    const ownRow = preview.ok ? preview.data.rows.find((r) => r.line === 2) : undefined;
    const other = preview.ok ? preview.data.rows.find((r) => r.line === 3) : undefined;
    ok("the preview refuses the importer's own row, in the salary form's words", ownRow?.action === "error" && ownRow.error === OWN_PAY_REFUSAL, ownRow);
    ok("  and still plans a colleague's", other?.action === "create", other?.action);
    const commit = await payrollImport.commitPayrollImport(payFile);
    ok("the import writes the colleague's and fails their own", commit.ok && commit.data.created === 1 && commit.data.failed.some((f) => f.line === 2 && f.error === OWN_PAY_REFUSAL), commit.ok ? commit.data : commit.error);
    const ownSalary = await db.salaryStructure.count({ where: { userId: clerk.id } });
    const ownProfile = await db.employeeProfile.findUnique({ where: { userId: clerk.id }, select: { bankAccountNumber: true } });
    const ownTax = await db.taxDeclaration.count({ where: { userId: clerk.id } });
    ok("  nothing of theirs was written: no salary, no bank account, no TDS", ownSalary === 0 && !ownProfile?.bankAccountNumber && ownTax === 0, { ownSalary, bank: ownProfile?.bankAccountNumber, ownTax });
    ok("  the colleague's salary landed", (await db.salaryStructure.count({ where: { userId: asha.id } })) === 1);
    let threw = "";
    try {
      await payrollImporter.apply(payRow("ZZR2I-001"), { actorUserId: clerk.id, area: "payroll", pendingKeys: new Set() });
    } catch (err) {
      threw = (err as Error).message;
    }
    ok("the writer refuses the own row on its own account, not trusting the preview", threw === OWN_PAY_REFUSAL, threw);
    // Kredily sends its pay rows through the same importer (src/actions/kredily-import.ts planWith/applyWith).
    const kredilyPlan = await planWith(payrollImporter, "payroll", [{ "Employee code": "ZZR2I-001", "Account number": "999988887777" }], clerk.id);
    ok("Kredily's path: the same own row is refused", kredilyPlan.rows[0]?.action === "error" && kredilyPlan.rows[0].error === OWN_PAY_REFUSAL);

    viewingAs = true;
    const vPreview = await payrollImport.previewPayrollImport(payFile);
    const vCommit = await payrollImport.commitPayrollImport(payFile);
    ok("while viewing as somebody, the payroll preview and import are refused", !vPreview.ok && vPreview.error === VIEW_AS && !vCommit.ok && vCommit.error === VIEW_AS);
    const vKredily = await kredilyImport.previewKredily({ files: [] });
    ok("  so is Kredily's preview (its gate)", !vKredily.ok && vKredily.error === VIEW_AS, vKredily.ok ? "" : vKredily.error);
    const vData = await dataImport.previewImport({ area: "people", filename: "p.csv", base64: csvFile([{ User: `asha${MAIL}` }]).base64 });
    ok("  and every import in Settings › Import & export", !vData.ok && vData.error === VIEW_AS, vData.ok ? "" : vData.error);
    viewingAs = false;
    const kredilyNoFiles = await kredilyImport.previewKredily({ files: [] });
    ok("  as yourself, Kredily's gate lets the payroll manager through", !kredilyNoFiles.ok && /Upload Kredily/.test(kredilyNoFiles.error), kredilyNoFiles.ok ? "" : kredilyNoFiles.error);

    // ── People import lows ──────────────────────────────────────────────────────────────────────────────
    section("Low: the people import's pay inputs");
    const peopleRows = (rows: Record<string, string>[]) => plan("people", rows, actorId);
    actorId = clerk.id;
    const selfDob = await peopleRows([{ User: `clerk${MAIL}`, "Date of birth": "1990-01-01" }]);
    ok("your own date of birth is refused, even with HR's rights", selfDob.rows[0]?.action === "error" && /your own date of birth/.test(selfDob.rows[0].error ?? ""), selfDob.rows[0]);
    const selfSame = await peopleRows([{ User: `clerk${MAIL}`, State: "Delhi", Designation: "Payroll" }]);
    ok("  your own state sent unchanged, beside a designation, is no refusal", selfSame.rows[0]?.action === "update", selfSame.rows[0]);
    const hrOther = await peopleRows([{ User: `asha${MAIL}`, State: "Karnataka" }]);
    ok("HR changes a colleague's state", hrOther.rows[0]?.action === "update", hrOther.rows[0]);
    actorId = payOnly.id;
    const noHr = await peopleRows([{ User: `asha${MAIL}`, State: "Karnataka", "Joined on": "2020-04-01" }]);
    ok("without hr.manage, a colleague's state and joining day are refused", noHr.rows[0]?.action === "error" && /Only HR/.test(noHr.rows[0].error ?? ""), noHr.rows[0]);
    const noHrApply = await apply("people", [{ User: `asha${MAIL}`, State: "Karnataka" }], payOnly.id);
    const ashaState = (await db.employeeProfile.findUnique({ where: { userId: asha.id }, select: { state: true } }))?.state;
    ok("  and the write leaves it alone", noHrApply.failed.length === 1 && ashaState === "Delhi", { failed: noHrApply.failed.length, ashaState });

    // ── R2-03 ────────────────────────────────────────────────────────────────────────────────────────────
    section("R2-03: the chart of accounts");
    actorId = noLedger.id;
    const noPerm = await plan("ledger", [{ Code: `${TAG}-9001`, Name: `${TAG} account`, Type: "EXPENSE" }], noLedger.id);
    ok("without ledger.manageAccounts, even a new account is refused", noPerm.rows[0]?.action === "error" && /can't change the chart of accounts/.test(noPerm.rows[0].error ?? ""), noPerm.rows[0]);
    const noPermApply = await apply("ledger", [{ Code: `${TAG}-9001`, Name: `${TAG} account`, Type: "EXPENSE" }], noLedger.id);
    ok("  and nothing is written", noPermApply.created === 0 && (await db.ledgerAccount.count({ where: { code: `${TAG}-9001` } })) === 0);
    const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
    const posted = await db.ledgerAccount.findFirst({ where: { isGroup: false, systemKey: null, lines: { some: {} } }, select: { code: true, type: true } });
    const keyed = await db.ledgerAccount.findFirst({ where: { isGroup: false, systemKey: { not: null }, lines: { none: {} } }, select: { code: true } });
    if (admin && posted) {
      const otherType = posted.type === "EXPENSE" ? "INCOME" : "EXPENSE";
      const retype = await plan("ledger", [{ Code: posted.code, Type: otherType }], admin.id);
      ok("an account with entries keeps its type (preview only)", retype.rows[0]?.action === "error" && /already has entries, so its type/.test(retype.rows[0].error ?? ""), retype.rows[0]);
      const group = await plan("ledger", [{ Code: posted.code, Group: "true" }], admin.id);
      ok("  nor can it become a group", group.rows[0]?.action === "error" && /can't become a group/.test(group.rows[0].error ?? ""), group.rows[0]);
      const same = await plan("ledger", [{ Code: posted.code, Type: posted.type }], admin.id);
      ok("  its own type handed back is no change", same.rows[0]?.action === "skip", same.rows[0]);
    } else ok("an account with entries to preview against", false, "none in this database");
    if (admin && keyed) {
      const keyedGroup = await plan("ledger", [{ Code: keyed.code, Group: "yes" }], admin.id);
      ok("an account with a system key can't become a group (preview only)", keyedGroup.rows[0]?.action === "error" && /system key/.test(keyedGroup.rows[0].error ?? ""), keyedGroup.rows[0]);
    } else console.log("  (no unposted system-key account here; that case not shown)");

    // ── R2-04 ────────────────────────────────────────────────────────────────────────────────────────────
    section("R2-04: expense claims");
    const ravisClaim = await db.expense.create({ data: { userId: ravi.id, amount: 500, spentOn: new Date("2026-11-01T00:00:00Z"), description: `${TAG} Ravi's private taxi`, status: "DRAFT" } });
    const key = `EXP-${String(ravisClaim.expenseSeq).padStart(6, "0")}`;
    actorId = asha.id;
    const outOfSight = await plan("expenses", [{ Expense: key, Person: `ravi${MAIL}`, Amount: "1", Description: "mine now" }], asha.id);
    const seen = JSON.stringify(outOfSight.rows[0]);
    ok("a claim outside the importer's view answers as a made-up key", outOfSight.rows[0]?.action === "error" && /No expense with key/.test(outOfSight.rows[0].error ?? ""), outOfSight.rows[0]);
    ok("  and the preview reads none of it out", !seen.includes("private taxi") && !seen.includes("500"));
    const forRavi = await plan("expenses", [{ Person: `ravi${MAIL}`, Amount: "100", "Spent on": "2026-11-02", Description: `${TAG} filed for Ravi` }], asha.id);
    ok("filing a claim in somebody else's name is refused", forRavi.rows[0]?.action === "error" && /only raise expenses for yourself/.test(forRavi.rows[0].error ?? ""), forRavi.rows[0]);
    const own = (over: Record<string, string>) => ({ Person: `asha${MAIL}`, Amount: "100", "Spent on": "2026-11-02", Description: `${TAG} cab`, ...over });
    const bad = await plan("expenses", [own({ Amount: "0" }), own({ Amount: "-50" }), own({ Tax: "5000" }), own({ Description: "x".repeat(3000) }), own({ "Spent on": "1900-01-01" })], asha.id);
    ok("the form's rules: no zero or negative amount, tax within it, 2,000 characters, a real day", bad.rows.every((r) => r.action === "error"), bad.rows.map((r) => r.error));
    const fine = await apply("expenses", [own({})], asha.id);
    ok("  a claim of your own within them is raised", fine.created === 1 && (await db.expense.count({ where: { userId: asha.id } })) === 1, fine);
    const ashas = await db.expense.findFirstOrThrow({ where: { userId: asha.id }, select: { expenseSeq: true } });
    const ashaKey = `EXP-${String(ashas.expenseSeq).padStart(6, "0")}`;
    const move = await plan("expenses", [{ Expense: ashaKey, Person: `ravi${MAIL}` }], asha.id);
    ok("moving your claim to somebody else is refused", move.rows[0]?.action === "error" && /approves expenses/.test(move.rows[0].error ?? ""), move.rows[0]);
    actorId = approver.id;
    const seeNotEdit = await plan("expenses", [{ Expense: key, Person: `ravi${MAIL}`, Amount: "900" }], approver.id);
    ok("an approver who sees every claim but edits only their own can't change Ravi's", seeNotEdit.rows[0]?.action === "error" && /may see but not change/.test(seeNotEdit.rows[0].error ?? ""), seeNotEdit.rows[0]);
    const unchanged = await plan("expenses", [{ Expense: key, Person: `ravi${MAIL}`, Amount: "500" }], approver.id);
    ok("  Ravi's row handed back unchanged is a skip, as an exported file needs", unchanged.rows[0]?.action === "skip", unchanged.rows[0]);
    const onBehalf = await plan("expenses", [{ Person: `ravi${MAIL}`, Amount: "100", "Spent on": "2026-11-02", Description: `${TAG} on Ravi's behalf` }], approver.id);
    ok("  but may raise one on Ravi's behalf, as on the form", onBehalf.rows[0]?.action === "create", onBehalf.rows[0]);
    ok("Ravi's claim is untouched throughout", Number((await db.expense.findUniqueOrThrow({ where: { id: ravisClaim.id } })).amount) === 500);

    // ── Items low ────────────────────────────────────────────────────────────────────────────────────────
    section("Low: items");
    if (admin) {
      const items = await plan("items", [{ Name: `${TAG} widget`, Price: "-5", Type: "GOOD" }, { Name: `${TAG} gadget`, Price: "10", "Tax %": "250", Type: "GOOD" }], admin.id);
      ok("a negative price and 250% tax are refused (preview only)", items.rows[0]?.action === "error" && /negative/.test(items.rows[0].error ?? "") && items.rows[1]?.action === "error" && /0 to 100/.test(items.rows[1].error ?? ""), items.rows.map((r) => r.error));
    }

    // ── Kredily attendance low ───────────────────────────────────────────────────────────────────────────
    section("Low: Kredily attendance in a payroll-locked month");
    const existingRun = await db.payrollRun.findUnique({ where: { month_year: { month: 1, year: 2001 } } });
    if (!existingRun) {
      await db.payrollRun.create({ data: { month: 1, year: 2001, status: "LOCKED", note: TAG } });
      madeRun = true;
    }
    if (madeRun || existingRun?.status !== "DRAFT") {
      const att = { from: "2001-01-01", to: "2001-02-28", marks: [{ code: "ZZR2I-002", date: "2001-01-15", mark: "P" }, { code: "ZZR2I-002", date: "2001-01-16", mark: "P" }, { code: "ZZR2I-002", date: "2001-02-15", mark: "P" }] };
      const { plan: ap, rows } = await attendancePlan(att, true, { userIds: [asha.id] });
      ok("days in January 2001 (payroll locked) are left out; February's comes", rows.length === 1 && ap.locked === 2 && new Date(rows[0]?.date ?? 0).toISOString().startsWith("2001-02-15"), { days: rows.length, locked: ap.locked });
    }

    // ── R2-19 ────────────────────────────────────────────────────────────────────────────────────────────
    section("R2-19: files that inflate past their caps");
    const real = new ExcelJS.Workbook();
    const ws = real.addWorksheet("Leads");
    ws.addRow(["Name", "Phone"]);
    ws.addRow(["Asha", "98100 00000"]);
    const realRows = await parseFile(Buffer.from(await real.xlsx.writeBuffer()).toString("base64"), "ok.xlsx");
    ok("an ordinary .xlsx still reads", realRows.length === 1 && realRows[0]?.Name === "Asha", realRows);

    const bombBytes = 300 * 1024 * 1024;
    const bomb = await zipOf({ "[Content_Types].xml": CONTENT_TYPES, "xl/worksheets/sheet1.xml": repeated(bombBytes) });
    ok(`  (the crafted sheet: ${Math.round(bomb.length / 1024)} KB in the file, ${bombBytes / 1024 / 1024} MB unpacked)`, bomb.length < 2 * 1024 * 1024);
    const entry = (await JSZip.loadAsync(bomb)).file("xl/worksheets/sheet1.xml")!;
    const before = process.memoryUsage();
    const started = Date.now();
    let refusal: unknown = null;
    try {
      await parseFile(bomb.toString("base64"), "bomb.xlsx");
    } catch (err) {
      refusal = err;
    }
    const grew = process.memoryUsage().rss - before.rss;
    ok("a sheet unpacking past 50 MB is refused, with words for the sender", refusal instanceof FileTooLarge && /unpacks to more than 50 MB/.test((refusal as Error).message), refusal instanceof Error ? refusal.message : refusal);
    ok(`  without unpacking it whole (memory grew ${Math.round(grew / 1024 / 1024)} MB, ${Date.now() - started} ms)`, grew < 150 * 1024 * 1024);
    const counted = await inflatedWithin(entry, SHEET_LIMITS.entryBytes);
    ok("  the counter stops at the cap", counted === null);

    const manyRows = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${Array.from({ length: SHEET_LIMITS.rows + 5 }, (_, i) => `<row r="${i + 1}"/>`).join("")}</sheetData></worksheet>`;
    const rowsBomb = await zipOf({ "[Content_Types].xml": CONTENT_TYPES, "xl/worksheets/sheet1.xml": manyRows });
    let rowsRefusal = "";
    try {
      await parseFile(rowsBomb.toString("base64"), "rows.xlsx");
    } catch (err) {
      rowsRefusal = (err as Error).message;
    }
    ok("a sheet of more than 100,000 rows is refused before it is parsed", /more than 1,00,000 rows/.test(rowsRefusal), rowsRefusal);
    const bigCsv = "Name\n" + "a\n".repeat(SHEET_LIMITS.rows + 1);
    let csvRefusal = "";
    try {
      await parseFile(Buffer.from(bigCsv).toString("base64"), "rows.csv");
    } catch (err) {
      csvRefusal = (err as Error).message;
    }
    ok("  a CSV too", /more than 1,00,000 rows/.test(csvRefusal), csvRefusal);
    const wide = Array.from({ length: SHEET_LIMITS.columns + 1 }, (_, i) => `c${i}`).join(",") + "\n" + Array.from({ length: SHEET_LIMITS.columns + 1 }, () => "x").join(",");
    let wideRefusal = "";
    try {
      await parseFile(Buffer.from(wide).toString("base64"), "wide.csv");
    } catch (err) {
      wideRefusal = (err as Error).message;
    }
    ok("  and one of more than 500 columns", /at most 500/.test(wideRefusal), wideRefusal);

    const kredilyZip = await zipOf({ "Directory Export.xlsx": repeated(30 * 1024 * 1024) });
    let kredilyRefusal: unknown = null;
    try {
      await readKredily([{ name: "kredily.zip", bytes: kredilyZip }]);
    } catch (err) {
      kredilyRefusal = err;
    }
    ok("Kredily: a file in the ZIP unpacking past 25 MB is refused", kredilyRefusal instanceof FileTooLarge, kredilyRefusal instanceof Error ? kredilyRefusal.message : kredilyRefusal);
    const kredilyBomb = await zipOf({ "Directory Export.xlsx": bomb });
    let kredilyBombRefusal: unknown = null;
    try {
      await readKredily([{ name: "kredily.zip", bytes: kredilyBomb }]);
    } catch (err) {
      kredilyBombRefusal = err;
    }
    ok("  and a small workbook in it whose sheet inflates past 50 MB", kredilyBombRefusal instanceof FileTooLarge && /unpacks to more than 50 MB/.test((kredilyBombRefusal as Error).message), kredilyBombRefusal instanceof Error ? kredilyBombRefusal.message : kredilyBombRefusal);

    const migrationZip = await zipOf({ "Invoice.csv": repeated(90 * 1024 * 1024) });
    let migrationRefusal = "";
    try {
      await readMigrationUpload([{ name: "zoho.zip", bytes: migrationZip }]);
    } catch (err) {
      migrationRefusal = (err as Error).message;
    }
    ok("the switch: a CSV in the ZIP unpacking past 80 MB is refused", /over 80 MB unpacked/.test(migrationRefusal), migrationRefusal);

    actorId = clerk.id;
    let sent = 0;
    const chunked = new Request("http://localhost:3000/api/data-import", {
      method: "POST",
      headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" },
      body: new ReadableStream({
        pull(c) {
          if ((sent += 1) > 40) return c.close();
          c.enqueue(new Uint8Array(1024 * 1024).fill(32));
        },
      }),
      duplex: "half",
    } as RequestInit);
    const response = await route.POST(chunked);
    ok("the import route refuses a 40 MB body sent with no length, reading no further", response.status === 413 && sent < 40, { status: response.status, megabytesRead: sent });
  } finally {
    await cleanup();
    if (madeRun) await db.payrollRun.deleteMany({ where: { month: 1, year: 2001, note: TAG } });
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  await db.$disconnect();
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
