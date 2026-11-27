import { notFound } from "next/navigation";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { isModuleEnabled } from "@/actions/module";
import { attendanceMonth, type MonthCell, type MonthRow } from "@/actions/attendance";
import { db } from "@/lib/db";
import { getOrganisation } from "@/lib/organisation";
import { getBranding } from "@/actions/branding";
import { monthLabel } from "@/lib/hr/calendar";
import { workspaceClock } from "@/lib/time/workspace";
import { PrintButton } from "@/components/documents/print-button";
import { printCode, printDayWords, PRINT_CODES } from "@/lib/hr/attendance-print";

export const metadata = { title: "Attendance" };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const weekday = (key: string) => WEEKDAYS[new Date(`${key}T00:00:00Z`).getUTCDay()]!;

/** Everybody on one sheet needs the width: A4 turned sideways. */
const SHEET_PAGE = `@page { size: A4 landscape; margin: 8mm; }`;
/** A page for each person, each starting on its own. */
const EACH_PAGE = `@media print { .person-page { break-after: page; } .person-page:last-child { break-after: auto; } }`;

/**
 * A month's attendance on paper (owner, 26 Nov 2026 — "option for HR to print the attendance of whole month of all
 * employees or employee wise"). "sheet": everybody, a row each and a column a day, with the month's totals — as Manage
 * attendance shows it. "each": a page for each person, day by day with in and out, hours and remarks, and a line to
 * sign. The same filters as the screen, and the same people: attendanceMonth decides whose month the viewer may see.
 * For whoever holds "Print attendance" (hr.printAttendance).
 */
export default async function AttendancePrintPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const one = (key: string) => (Array.isArray(query[key]) ? query[key][0] : query[key]) as string | undefined;
  const viewer = await currentUser();
  if (!viewer || !(await isModuleEnabled("hr"))) notFound();
  if (!(await can(viewer.id, "hr.printAttendance"))) notFound();

  const clock = await workspaceClock();
  const now = clock.parts(new Date());
  const month = Math.min(12, Math.max(1, Number(one("month")) || now.month + 1));
  const year = Math.min(2100, Math.max(2000, Number(one("year")) || now.year));
  const layout = one("layout") === "each" ? "each" : "sheet";

  const [data, org, branding] = await Promise.all([
    attendanceMonth({ year, month, userId: one("userId"), departmentId: one("departmentId"), search: one("search"), flag: one("flag") }),
    getOrganisation(),
    getBranding(),
  ]);
  // The company's logo on the left of the heading (owner, 26 Nov 2026): the letterhead's, else the workspace's — as letters print it.
  const logo = org.letterheadLogoDataUrl || branding.logoDataUrl;
  const people = await db.user.findMany({
    where: { id: { in: data.rows.map((r) => r.userId) } },
    select: { id: true, department: { select: { name: true } }, employeeProfile: { select: { employeeCode: true } } },
  });
  const extra = new Map(people.map((p) => [p.id, { code: p.employeeProfile?.employeeCode ?? null, department: p.department?.name ?? null }]));
  const company = org.tradeName || org.legalName;
  const title = `Attendance — ${monthLabel(month, year)}`;
  const printed = `Printed ${clock.dateTime(new Date())} · times in ${clock.zone.replace(/_/g, " ")} (${clock.offsetLabel()})`;
  const hours = data.officeHours;

  return (
    <div className={layout === "sheet" ? "mx-auto max-w-[297mm] bg-white p-8 text-neutral-900 shadow-sm print:p-0 print:shadow-none" : "mx-auto max-w-[210mm] text-neutral-900"}>
      <style>{layout === "sheet" ? SHEET_PAGE : EACH_PAGE}</style>
      <div className="mb-4 flex justify-end print:hidden">
        <PrintButton />
      </div>
      {data.rows.length === 0 && <p className="bg-white p-10 text-center text-sm text-neutral-500">Nobody to print for {monthLabel(month, year)}.</p>}
      {data.rows.length > 0 && layout === "sheet" && <Sheet rows={data.rows} days={data.days} extra={extra} company={company} title={title} printed={printed} measured={!!hours} logo={logo} />}
      {data.rows.length > 0 &&
        layout === "each" &&
        data.rows.map((row) => (
          <PersonPage key={row.userId} row={row} extra={extra.get(row.userId)} company={company} title={title} printed={printed} time={(at) => clock.time(at)} logo={logo} />
        ))}
    </div>
  );
}

type Extra = { code: string | null; department: string | null };

/** The company's logo, left of the heading — nothing when none is set. */
function Logo({ logo }: { logo: string | null }) {
  if (!logo) return null;
  // eslint-disable-next-line @next/next/no-img-element -- a data: URL, printed; nothing for next/image to optimise.
  return <img src={logo} alt="" className="h-10 w-auto max-w-[45mm] shrink-0 object-contain" />;
}

function Legend() {
  return (
    <p className="mt-2 text-[9px] text-neutral-600">
      {PRINT_CODES.map((c) => (
        <span key={c.code} className="mr-3 whitespace-nowrap">
          <b>{c.code}</b> {c.label}
        </span>
      ))}
    </p>
  );
}

function Sheet({ rows, days, extra, company, title, printed, measured, logo }: { rows: MonthRow[]; days: string[]; extra: Map<string, Extra>; company: string; title: string; printed: string; measured: boolean; logo: string | null }) {
  const th = "border border-neutral-300 px-0.5 py-1 font-semibold";
  const td = "border border-neutral-300 px-0.5 py-0.5 text-center";
  return (
    <>
      <header className="mb-3 flex items-center gap-3 border-b border-neutral-300 pb-2">
        <Logo logo={logo} />
        <div className="min-w-0">
          <h1 className="text-base font-semibold">{title}</h1>
          <p className="text-[10px] text-neutral-600">
            {[company, `${rows.length} ${rows.length === 1 ? "person" : "people"}`, printed].filter(Boolean).join(" · ")}
          </p>
        </div>
      </header>
      <table className="w-full border-collapse text-[8.5px] leading-tight">
        <thead>
          <tr className="bg-neutral-100">
            <th className={`${th} w-[40mm] text-left`}>Employee</th>
            {days.map((d) => (
              <th key={d} className={`${th} text-center`}>
                <div>{Number(d.slice(8))}</div>
                <div className="font-normal text-neutral-500">{weekday(d).slice(0, 2)}</div>
              </th>
            ))}
            <th className={th} title="Present">P</th>
            <th className={th} title="Leave">L</th>
            <th className={th} title="Absent">A</th>
            <th className={th} title="Not recorded">NR</th>
            <th className={`${th} w-[12mm]`}>Working days</th>
            {measured && <th className={`${th} w-[16mm]`}>Hours</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const x = extra.get(row.userId);
            return (
              <tr key={row.userId}>
                <td className="border border-neutral-300 px-1 py-0.5 text-left">
                  <div className="font-medium">{row.name}</div>
                  <div className="text-neutral-500">{[x?.code, x?.department].filter(Boolean).join(" · ")}</div>
                </td>
                {row.cells.map((cell) => {
                  const c = printCode(cell);
                  return (
                    <td key={cell.date} className={`${td} ${c.tone}`}>
                      {c.code}
                      {(cell.late || cell.early) && <sup className="text-neutral-500">*</sup>}
                    </td>
                  );
                })}
                <td className={`${td} font-semibold`}>{row.present}</td>
                <td className={td}>{row.leave}</td>
                <td className={td}>{row.absent}</td>
                <td className={td}>{row.unrecorded}</td>
                <td className={td}>{row.workingDays}</td>
                {measured && <td className={`${td} whitespace-nowrap`}>{row.workedHours !== null && row.expectedHours !== null ? `${row.workedHours.toFixed(1)} / ${row.expectedHours.toFixed(1)}` : "—"}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
      <Legend />
      <p className="text-[9px] text-neutral-600">* came in late or left early. A blank is a day still to come.</p>
    </>
  );
}

function PersonPage({ row, extra, company, title, printed, time, logo }: { row: MonthRow; extra: Extra | undefined; company: string; title: string; printed: string; time: (at: string) => string; logo: string | null }) {
  const th = "border border-neutral-300 px-1.5 py-1 text-left font-semibold";
  const td = "border border-neutral-300 px-1.5 py-0.5";
  const hoursOf = (cell: MonthCell) => (cell.workedMinutes !== null ? `${Math.floor(cell.workedMinutes / 60)}h ${String(cell.workedMinutes % 60).padStart(2, "0")}m` : "");
  return (
    <section className="person-page mb-6 bg-white p-8 text-[10.5px] shadow-sm print:mb-0 print:p-0 print:shadow-none">
      <header className="mb-3 border-b border-neutral-300 pb-2">
        <div className="flex items-center gap-3">
          <Logo logo={logo} />
          <div className="min-w-0">
            <h1 className="text-base font-semibold">{title}</h1>
            <p className="text-[10px] text-neutral-600">
              {[company, printed].filter(Boolean).join(" · ")}
            </p>
          </div>
        </div>
        <p className="mt-2 text-[12px]">
          <b>{row.name}</b>
          {[extra?.code && `Employee code ${extra.code}`, row.designation, extra?.department].filter(Boolean).map((t) => ` · ${t}`)}
        </p>
      </header>
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-neutral-100">
            <th className={th}>Date</th>
            <th className={th}>Day</th>
            <th className={th}>Attendance</th>
            <th className={th}>In</th>
            <th className={th}>Out</th>
            <th className={th}>Hours</th>
            <th className={th}>Remarks</th>
          </tr>
        </thead>
        <tbody>
          {row.cells.map((cell) => {
            const off = !cell.status && cell.offDay;
            return (
              <tr key={cell.date} className={off ? "bg-neutral-50 text-neutral-500" : undefined}>
                <td className={`${td} whitespace-nowrap`}>{Number(cell.date.slice(8))}</td>
                <td className={td}>{weekday(cell.date)}</td>
                <td className={td}>{printDayWords(cell)}</td>
                <td className={td}>{cell.checkInAt ? time(cell.checkInAt) : ""}</td>
                <td className={td}>{cell.checkOutAt ? time(cell.checkOutAt) : ""}</td>
                <td className={`${td} whitespace-nowrap`}>{hoursOf(cell)}</td>
                <td className={td}>{remarks(cell).join("; ")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <table className="print-keep mt-3 border-collapse">
        <tbody>
          <tr>
            {[
              ["Working days", row.workingDays],
              ["Present", row.present],
              ["Leave", row.leave],
              ["Absent", row.absent],
              ["Not recorded", row.unrecorded],
              ...(row.workedHours !== null && row.expectedHours !== null ? [["Hours worked", `${row.workedHours.toFixed(1)} of ${row.expectedHours.toFixed(1)}`] as const] : []),
            ].map(([label, value]) => (
              <td key={label} className="border border-neutral-300 px-2 py-1">
                <div className="text-[9px] text-neutral-500">{label}</div>
                <div className="font-semibold">{value}</div>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      <div className="print-keep mt-12 flex justify-between text-[10px] text-neutral-600">
        <span className="w-48 border-t border-neutral-400 pt-1">Employee&apos;s signature</span>
        <span className="w-48 border-t border-neutral-400 pt-1 text-right">HR&apos;s signature</span>
      </div>
    </section>
  );
}

function remarks(cell: MonthCell): string[] {
  return [
    cell.late && !cell.shortLeave?.excused ? "Late" : null,
    cell.early && !cell.shortLeave?.excused ? "Left early" : null,
    cell.overtime ? "Overtime" : null,
    cell.shortLeave ? `Short leave ${cell.shortLeave.words}${cell.shortLeave.approved ? "" : " (waiting)"}` : null,
    cell.shiftCode ? `Shift ${cell.shiftCode}` : null,
    cell.regularised ? "Corrected" : null,
    cell.pending ? "Correction asked for" : null,
    cell.note,
  ].filter((r): r is string => !!r);
}
