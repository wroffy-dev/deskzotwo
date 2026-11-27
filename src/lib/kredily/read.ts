import ExcelJS from "exceljs";
import JSZip from "jszip";
import { columnDates, type KredilyAttendance } from "@/lib/kredily/attendance";
import { readCapped } from "@/lib/legacy-import/files";
import { FileTooLarge, loadWorkbook } from "@/lib/portability/workbook";

/**
 * Kredily's exports as they come (owner, 31 Oct 2026 — moving off Kredily): each file recognised by its headings, not
 * its name, read into one record per employee. Kredily writes a title row (or three) above its headings, its salary
 * structures in yearly amounts, and its pay register one row per person per month with totals between — so nothing
 * here leans on Deskzo's own import reading the first row as headings.
 *
 * Read: the Employee Master ("Directory Export"), Assigned Salary Structures, the Yearly Consolidated Pay Register, the
 * PF Register (UANs, and its month's gross and PF), the Leave Balance report, and — since 31 Oct 2026 — the Consolidated
 * TDS Report (TDS month by month, a month past the pay register when that month was paid in Kredily), the PT Report
 * (its month's PT), Pending Expenses and the Consolidated Attendance Report (src/lib/kredily/attendance.ts). Anything else is listed as not needed. Values are kept as Kredily wrote them;
 * turning them into Deskzo's rows is src/lib/kredily/rows.ts.
 */

export type KredilyPerson = {
  code: string;
  firstName: string;
  middleName: string;
  lastName: string;
  email: string;
  personalEmail: string;
  phone: string;
  /** YYYY-MM-DD, or "" where Kredily had none or it wasn't a date. */
  joinedOn: string;
  dateOfBirth: string;
  gender: string;
  location: string;
  department: string;
  designation: string;
  status: string;
  type: string;
  manager: string;
  annualCtc: number | null;
  aadhaar: string;
  pan: string;
  bank: string;
  ifsc: string;
  account: string;
};

export type KredilyStructure = {
  code: string;
  /** YYYY-MM-DD. */
  effectiveFrom: string;
  pfNumber: string;
  /** Yearly, by Kredily's own component name. */
  annual: Record<string, number>;
  annualCtc: number | null;
};

export type KredilyPay = { code: string; months: number; gross: number; tds: number; pt: number; pf: number; lastMonth: string };

/** One month's pay for a person, from a register of that month (PF, PT): its gross and what was deducted. */
export type KredilyMonth = { gross: number | null; pf: number | null; pt: number | null };

/** A claim still pending in Kredily (owner, 31 Oct 2026: brought across as one awaiting approval). */
export type KredilyExpense = { code: string; category: string; description: string; spentOn: string; amount: number };

export type KredilyRead = {
  people: KredilyPerson[];
  structures: Map<string, KredilyStructure>;
  pay: Map<string, KredilyPay>;
  /** UAN by employee code, from the PF register. */
  uan: Map<string, string>;
  /** Balance by Kredily leave name, by employee code; "-" (not given that type) left out. */
  leave: Map<string, Record<string, number>>;
  leaveTypes: string[];
  /** The pay register's span as Kredily writes it — "01/04/2026 to 30/09/2026". */
  paySpan: string | null;
  /** The pay register's last month, YYYY-MM. */
  payThrough: string | null;
  /** TDS by month (YYYY-MM), by employee code — the Consolidated TDS Report, which runs a month past the pay register. */
  tds: Map<string, Record<string, number>>;
  /** One month's gross, PF and PT by employee code, by month (YYYY-MM) — the PF register and the PT report. */
  months: Map<string, Record<string, KredilyMonth>>;
  expenses: KredilyExpense[];
  /** The Consolidated Attendance Report's marks, day by day (src/lib/kredily/attendance.ts); null without one. */
  attendance: KredilyAttendance | null;
  read: { file: string; as: string }[];
  ignored: string[];
};

type Cell = string | number | Date | null;

const MAX_FILES = 40;

const norm = (s: string) => s.toLowerCase().replace(/\(.*$/, "").replace(/[^a-z0-9]+/g, " ").trim();
const text = (v: Cell) => (v === null || v === undefined ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).replace(/^'+/, "").trim());
const num = (v: Cell) => {
  if (typeof v === "number") return v;
  const t = text(v).replace(/[,₹\s]/g, "");
  if (!t || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** DD/MM/YYYY, YYYY-MM-DD or a date cell, as YYYY-MM-DD; "" for anything else. */
function day(v: Cell): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const t = text(v);
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(t);
  if (dmy) return `${dmy[3]}-${dmy[2]!.padStart(2, "0")}-${dmy[1]!.padStart(2, "0")}`;
  return "";
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "September 2026", "Oct 2026", "Oct, 2026" as YYYY-MM; null for anything else. */
export function monthKey(label: string): string | null {
  const m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4})\b/i.exec(label);
  if (!m) return null;
  return `${m[2]}-${String(MONTHS.indexOf(m[1]!.toLowerCase()) + 1).padStart(2, "0")}`;
}

function cellValue(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || v instanceof Date) return v;
  if (typeof v === "boolean") return String(v);
  const o = v as { text?: string; result?: unknown; richText?: { text: string }[] };
  if (o.richText) return o.richText.map((p) => p.text).join("");
  if (o.text !== undefined) return o.text;
  if (o.result !== undefined && (typeof o.result === "string" || typeof o.result === "number" || o.result instanceof Date)) return o.result;
  return null;
}

function rowsOf(ws: ExcelJS.Worksheet): Cell[][] {
  const out: Cell[][] = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const cells: Cell[] = [];
    for (let c = 1; c <= ws.columnCount; c++) cells.push(cellValue(row.getCell(c).value));
    out.push(cells);
  }
  return out;
}

/** The row (within the first ten) whose cells name every heading asked for, and each heading's column. */
function headings(rows: Cell[][], must: string[]): { at: number; col: Map<string, number> } | null {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const col = new Map<string, number>();
    rows[i]!.forEach((c, j) => {
      const h = norm(text(c));
      if (h && !col.has(h)) col.set(h, j);
    });
    if (must.every((m) => col.has(norm(m)))) return { at: i, col };
  }
  return null;
}

/**
 * Security audit round two, 13 Nov 2026 (R2-19): a Kredily ZIP's files were unpacked whole, and each workbook opened
 * whole, whatever they inflated to. Now each .xlsx in a ZIP is unpacked only as far as `ZIP_LIMITS.fileBytes`, all of
 * them together as far as `.totalBytes`, and each workbook is opened only once its own parts are known to fit
 * (src/lib/portability/workbook.ts).
 */
export const ZIP_LIMITS = { fileBytes: 25 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 };

async function workbooks(files: { name: string; bytes: Buffer }[]): Promise<{ name: string; wb: ExcelJS.Workbook }[]> {
  const out: { name: string; wb: ExcelJS.Workbook }[] = [];
  const add = async (name: string, bytes: Buffer) => {
    if (out.length >= MAX_FILES) return;
    out.push({ name, wb: await loadWorkbook(bytes, name) });
  };
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      const zip = await JSZip.loadAsync(f.bytes);
      let inflated = 0;
      for (const entry of Object.values(zip.files)) {
        if (entry.dir || !/\.xlsx$/i.test(entry.name) || entry.name.includes("__MACOSX")) continue;
        if (out.length >= MAX_FILES) break;
        const bytes = await readCapped(entry, Math.min(ZIP_LIMITS.fileBytes, ZIP_LIMITS.totalBytes - inflated));
        if (!bytes) throw new FileTooLarge(`${entry.name} in ${f.name} unpacks to more than Kredily's exports ever do.`);
        inflated += bytes.length;
        await add(entry.name.split("/").pop()!, bytes);
      }
    } else if (/\.xlsx$/i.test(f.name)) {
      await add(f.name, f.bytes);
    }
  }
  return out;
}

export async function readKredily(files: { name: string; bytes: Buffer }[]): Promise<KredilyRead> {
  const result: KredilyRead = { people: [], structures: new Map(), pay: new Map(), uan: new Map(), leave: new Map(), leaveTypes: [], paySpan: null, payThrough: null, tds: new Map(), months: new Map(), expenses: [], attendance: null, read: [], ignored: [] };
  const inMonth = (code: string, month: string, part: Partial<KredilyMonth>) => {
    const byMonth = result.months.get(code) ?? {};
    const was = byMonth[month] ?? { gross: null, pf: null, pt: null };
    byMonth[month] = { gross: part.gross ?? was.gross, pf: part.pf ?? was.pf, pt: part.pt ?? was.pt };
    result.months.set(code, byMonth);
  };
  const seen = new Set<string>();

  for (const { name, wb } of await workbooks(files)) {
    const ws = wb.worksheets.find((w) => w.name === "Bulk Upload") ?? wb.worksheets[0];
    if (!ws) continue;
    const rows = rowsOf(ws);
    const get = (h: { col: Map<string, number> }, row: Cell[], heading: string): Cell => {
      const j = h.col.get(norm(heading));
      return j === undefined ? null : (row[j] ?? null);
    };

    // The Consolidated Attendance Report: Employee ID, Employee Name and a column per day ("1 Jan", "2 Jan" …).
    const att = headings(rows, ["Employee ID", "Employee Name"]);
    const title = att ? rows.slice(0, att.at).map((r) => r.map(text).find(Boolean) ?? "").join(" ") : "";
    const dates = att ? columnDates(rows[att.at]!.map(text), title, new Date().toISOString().slice(0, 10)) : [];
    if (att && dates.filter(Boolean).length >= 7) {
      if (seen.has("attendance")) { result.ignored.push(`${name} (a second attendance report)`); continue; }
      seen.add("attendance");
      const marks: KredilyAttendance["marks"] = [];
      for (const row of rows.slice(att.at + 1)) {
        const code = text(get(att, row, "Employee ID"));
        if (!code) continue;
        dates.forEach((date, j) => {
          const mark = date ? text(row[j] ?? null) : "";
          if (date && mark) marks.push({ code, date, mark });
        });
      }
      const span = dates.filter((d): d is string => !!d);
      result.attendance = { from: span[0]!, to: span[span.length - 1]!, marks };
      result.read.push({ file: name, as: "Attendance history" });
      continue;
    }

    // The Employee Master: "Official Email ID" beside "Employee ID".
    const dir = headings(rows, ["Employee ID", "Official Email ID", "Date of Joining"]);
    if (dir) {
      if (seen.has("directory")) { result.ignored.push(`${name} (a second employee master)`); continue; }
      seen.add("directory");
      for (const row of rows.slice(dir.at + 1)) {
        const code = text(get(dir, row, "Employee ID"));
        if (!code) continue;
        result.people.push({
          code,
          firstName: text(get(dir, row, "First Name")),
          middleName: text(get(dir, row, "Middle Name")),
          lastName: text(get(dir, row, "Last Name")),
          email: text(get(dir, row, "Official Email ID")).toLowerCase(),
          personalEmail: text(get(dir, row, "Personal Email ID")).toLowerCase(),
          phone: text(get(dir, row, "Contact Number")),
          joinedOn: day(get(dir, row, "Date of Joining")),
          dateOfBirth: day(get(dir, row, "DOB")),
          gender: text(get(dir, row, "Gender")),
          location: text(get(dir, row, "Work Location")),
          department: text(get(dir, row, "Department")),
          designation: text(get(dir, row, "Designation")) || text(get(dir, row, "Job Title")),
          status: text(get(dir, row, "Employee Status")),
          type: text(get(dir, row, "Employee Type")),
          manager: text(get(dir, row, "Reporting Manager")),
          annualCtc: num(get(dir, row, "Annual CTC")),
          aadhaar: text(get(dir, row, "Aadhaar Card")).replace(/\s+/g, ""),
          pan: text(get(dir, row, "Pan Card")).toUpperCase(),
          bank: text(get(dir, row, "Bank")),
          ifsc: text(get(dir, row, "IFSC")).toUpperCase(),
          account: text(get(dir, row, "Account Number")).replace(/\s+/g, ""),
        });
      }
      result.read.push({ file: name, as: "Employee master" });
      continue;
    }

    // Assigned Salary Structures: "Structure Name" and "Annual CTC", yearly components after it.
    const st = headings(rows, ["Employee ID", "Structure Name", "Annual CTC"]);
    if (st) {
      if (seen.has("structures")) { result.ignored.push(`${name} (a second copy of the salary structures)`); continue; }
      seen.add("structures");
      const ctcAt = st.col.get(norm("Annual CTC"))!;
      const headerRow = rows[st.at]!;
      for (const row of rows.slice(st.at + 1)) {
        const code = text(get(st, row, "Employee ID"));
        if (!code) continue;
        const annual: Record<string, number> = {};
        headerRow.forEach((h, j) => {
          if (j <= ctcAt) return;
          const label = text(h);
          const value = num(row[j] ?? null);
          if (label && value !== null) annual[label] = value;
        });
        result.structures.set(code, { code, effectiveFrom: day(get(st, row, "Structure Effective Date")), pfNumber: text(get(st, row, "PF Number")), annual, annualCtc: num(get(st, row, "Annual CTC")) });
      }
      result.read.push({ file: name, as: "Salary structures" });
      continue;
    }

    // The Yearly Consolidated Pay Register: a row per person per month, "Total Gross" among its headings.
    const pay = headings(rows, ["Employee Id", "Month", "Total Gross"]);
    if (pay) {
      if (seen.has("pay")) { result.ignored.push(`${name} (a second copy of the pay register)`); continue; }
      seen.add("pay");
      const span = rows.slice(0, pay.at).map((r) => r.map(text).join(" ")).find((t) => /from .* to /i.test(t));
      result.paySpan = span ? (/from (.+?) to (\S+)/i.exec(span)?.slice(1, 3).join(" to ") ?? null) : null;
      for (const row of rows.slice(pay.at + 1)) {
        const code = text(get(pay, row, "Employee Id"));
        const month = text(get(pay, row, "Month"));
        if (!code || !month) continue;
        const p = result.pay.get(code) ?? { code, months: 0, gross: 0, tds: 0, pt: 0, pf: 0, lastMonth: "" };
        p.months += 1;
        p.gross += num(get(pay, row, "Total Gross")) ?? 0;
        p.tds += (num(get(pay, row, "Income Tax")) ?? 0) || (num(get(pay, row, "TDS Deduction")) ?? 0);
        p.pt += num(get(pay, row, "PT")) ?? 0;
        p.pf += num(get(pay, row, "Employee PF")) ?? 0;
        p.lastMonth = month;
        result.pay.set(code, p);
        const key = monthKey(month);
        if (key && (!result.payThrough || key > result.payThrough)) result.payThrough = key;
      }
      for (const p of result.pay.values()) Object.assign(p, { gross: Math.round(p.gross * 100) / 100, tds: Math.round(p.tds * 100) / 100, pt: Math.round(p.pt * 100) / 100, pf: Math.round(p.pf * 100) / 100 });
      result.read.push({ file: name, as: "Pay register (pay so far this year)" });
      continue;
    }

    // The Consolidated TDS Report: a column per month ("Apr 2026" … "Oct 2026") and "Total TDS".
    const tds = headings(rows, ["Employee ID", "Total TDS"]);
    if (tds) {
      if (seen.has("tds")) { result.ignored.push(`${name} (a second TDS report)`); continue; }
      seen.add("tds");
      const monthCols = rows[tds.at]!.map((h, j) => ({ month: /^[A-Za-z]{3,9}\.? \d{4}$/.test(text(h)) ? monthKey(text(h)) : null, j })).filter((m) => m.month);
      for (const row of rows.slice(tds.at + 1)) {
        const code = text(get(tds, row, "Employee ID"));
        if (!code) continue;
        const byMonth: Record<string, number> = {};
        for (const m of monthCols) {
          const v = num(row[m.j] ?? null);
          if (v !== null) byMonth[m.month!] = v;
        }
        result.tds.set(code, byMonth);
      }
      result.read.push({ file: name, as: "TDS report (tax deducted, month by month)" });
      continue;
    }

    // The PT report: one month's gross and professional tax by employee code.
    const pt = headings(rows, ["Employee Code", "Professional Tax"]);
    if (pt) {
      const month = monthKey(rows.slice(0, pt.at).map((r) => r.map(text).join(" ")).join(" "));
      const grossAt = rows[pt.at]!.findIndex((c) => /gross/i.test(text(c)));
      for (const row of rows.slice(pt.at + 1)) {
        const code = text(get(pt, row, "Employee Code"));
        if (!code || !month || /^total$/i.test(code)) continue;
        inMonth(code, month, { pt: num(get(pt, row, "Professional Tax")), gross: grossAt >= 0 ? num(row[grossAt] ?? null) : null });
      }
      result.read.push({ file: name, as: "PT report (the month's professional tax)" });
      continue;
    }

    // Pending expenses: claims not yet decided, brought across as awaiting approval.
    const ex = headings(rows, ["Employee ID", "Category", "Expense Date", "Claimed Amount"]);
    if (ex) {
      if (seen.has("expenses")) { result.ignored.push(`${name} (a second pending expenses report)`); continue; }
      seen.add("expenses");
      for (const row of rows.slice(ex.at + 1)) {
        const code = text(get(ex, row, "Employee ID"));
        const amount = num(get(ex, row, "Claimed Amount"));
        const spentOn = day(get(ex, row, "Expense Date"));
        if (!code || amount === null || amount <= 0 || !spentOn) continue;
        result.expenses.push({ code, category: text(get(ex, row, "Category")), description: text(get(ex, row, "Description")), spentOn, amount });
      }
      result.read.push({ file: name, as: "Pending expense claims" });
      continue;
    }

    // The PF register: "Employee P.F. Number & UAN No." beside "Employee Code, Name, Department…" in one cell each.
    const pf = rows.slice(0, 10).findIndex((r) => r.some((c) => /p\.?\s*f\.?\s*number.*uan/i.test(text(c).replace(/\s+/g, " "))));
    if (pf >= 0) {
      const headerRow = rows[pf]!;
      const uanAt = headerRow.findIndex((c) => /uan/i.test(text(c)));
      const whoAt = headerRow.findIndex((c) => /employee code/i.test(text(c)));
      // The month's gross and the employee's own contribution — a month the pay register may not reach yet.
      const grossAt = headerRow.findIndex((c) => /gross/i.test(text(c)));
      const ownAt = headerRow.findIndex((c) => /employee contribution/i.test(text(c)));
      const month = monthKey(rows.slice(0, pf).map((r) => r.map(text).join(" ")).join(" "));
      for (const row of rows.slice(pf + 1)) {
        const who = text(row[whoAt] ?? null);
        const ids = text(row[uanAt] ?? null);
        const code = /^\s*([A-Za-z0-9/_-]+)/.exec(who)?.[1];
        const uan = /\b(\d{12})\b/.exec(ids)?.[1];
        if (code && uan) result.uan.set(code, uan);
        if (code && uan && month) inMonth(code, month, { gross: grossAt >= 0 ? num(row[grossAt] ?? null) : null, pf: ownAt >= 0 ? num(row[ownAt] ?? null) : null });
      }
      result.read.push({ file: name, as: "PF register (UANs)" });
      continue;
    }

    // The Leave Balance report: Employee ID, Name, Department, Location, then a column per leave type.
    const lv = headings(rows, ["Employee ID", "Employee Name", "Department", "Location"]);
    // Not the ESI register or the salary payout, which also name a department and a location.
    if (lv && !headings(rows, ["Employee ID", "Payment Mode"]) && !headings(rows, ["Employee ID", "ESI Wages"]) && !headings(rows, ["Employee ID", "IP Number"])) {
      if (seen.has("leave")) { result.ignored.push(`${name} (a second leave balance report)`); continue; }
      seen.add("leave");
      const headerRow = rows[lv.at]!;
      const locAt = lv.col.get(norm("Location"))!;
      const types = headerRow.map((h, j) => ({ name: text(h), j })).filter((t) => t.j > locAt && t.name);
      result.leaveTypes = types.map((t) => t.name);
      for (const row of rows.slice(lv.at + 1)) {
        const code = text(get(lv, row, "Employee ID"));
        if (!code) continue;
        const balances: Record<string, number> = {};
        for (const t of types) {
          const v = num(row[t.j] ?? null);
          if (v !== null) balances[t.name] = v;
        }
        result.leave.set(code, balances);
      }
      result.read.push({ file: name, as: "Leave balances" });
      continue;
    }

    result.ignored.push(name);
  }
  return result;
}
