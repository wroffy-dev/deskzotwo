/**
 * The WPS Salary Information File (owner, 15 Nov 2026 — UAE payroll). One layout for every bank, set by the Central
 * Bank and MOHRE: comma-separated, no heading line, one EDR line per employee (with an EVP line after it when they have
 * variable pay), and one SCR control line last. Named <13-digit employer ID><YYMMDD><HHMMSS>.SIF.
 *
 *   EDR, person ID (MOHRE, 14 digits), the employee's bank routing code, IBAN, pay start, pay end, days, fixed, variable, unpaid leave days
 *   EVP, person ID, the same routing code, housing, conveyance, medical, annual passage, overtime, other, leave encashment
 *   SCR, employer ID (MOHRE, 13 digits), the employer's bank routing code, created (YYYY-MM-DD), HHMM, salary month MMYYYY, lines, total, AED, reference
 *
 * Pure — the run's actions hand it figures (src/actions/uae-payroll.ts); check:uae-payroll reads what it makes.
 */

export type SifLine = {
  name: string;
  personId: string;
  routingCode: string;
  iban: string;
  /** yyyy-mm-dd, within the salary month. */
  payStart: string;
  payEnd: string;
  fixed: number;
  /** Overtime and the rest; when above 0 an EVP line goes with it. */
  overtime: number;
  otherVariable: number;
  unpaidDays: number;
};

export type SifInput = {
  establishmentId: string;
  employerRoutingCode: string;
  /** The month paid, 1–12. */
  month: number;
  year: number;
  /** The moment it's made, as the clock in the UAE reads it; month 1–12. */
  created: { year: number; month: number; day: number; hour: number; minute: number; second: number };
  reference?: string | null;
  lines: SifLine[];
};

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const cents = (n: number) => Math.round(n * 100);
const money = (c: number) => (c / 100).toFixed(2);
const clean = (s: string) => s.replace(/[,\r\n]/g, " ").trim();

/** The file, or why it can't be made — every problem at once, each naming who. */
export function buildSif(input: SifInput): { ok: true; fileName: string; content: string; total: number } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const employer = input.establishmentId.replace(/\D/g, "");
  if (!employer || employer.length > 13) problems.push("The company's MOHRE establishment ID is missing — up to 13 digits, under WPS setup.");
  if (!/^\d{9}$/.test(input.employerRoutingCode)) problems.push("Pick the bank that pays the salaries, under WPS setup.");
  if (input.lines.length === 0) problems.push("Nobody is being paid this month.");
  const monthKey = `${input.year}-${pad(input.month)}`;

  const rows: string[] = [];
  let total = 0;
  for (const l of input.lines) {
    const who = l.name;
    const person = l.personId.replace(/\D/g, "");
    if (!person || person.length > 14) problems.push(`${who}: the MOHRE person ID is missing (14 digits, on the labour card).`);
    if (!/^\d{9}$/.test(l.routingCode)) problems.push(`${who}: no bank routing code — check the IBAN, or type the code.`);
    if (!/^AE\d{21}$/.test(l.iban)) problems.push(`${who}: the IBAN isn't a UAE IBAN (AE and 21 digits).`);
    if (!l.payStart.startsWith(monthKey) || !l.payEnd.startsWith(monthKey) || l.payEnd < l.payStart) problems.push(`${who}: the pay period isn't within the month.`);
    if (l.fixed < 0 || l.overtime < 0 || l.otherVariable < 0) problems.push(`${who}: an amount is below zero, which WPS refuses.`);
    const days = Number(l.payEnd.slice(8, 10)) - Number(l.payStart.slice(8, 10)) + 1;
    const fixed = cents(l.fixed);
    const overtime = cents(l.overtime);
    const other = cents(l.otherVariable);
    total += fixed + overtime + other;
    const id = person.padStart(14, "0");
    rows.push(["EDR", id, l.routingCode, l.iban, l.payStart, l.payEnd, String(days), money(fixed), money(overtime + other), String(Math.round(l.unpaidDays))].join(","));
    if (overtime + other > 0) rows.push(["EVP", id, l.routingCode, "0.00", "0.00", "0.00", "0.00", money(overtime), money(other), "0.00"].join(","));
  }
  if (problems.length) return { ok: false, problems };

  const c = input.created;
  rows.push(
    [
      "SCR",
      employer.padStart(13, "0"),
      input.employerRoutingCode,
      `${c.year}-${pad(c.month)}-${pad(c.day)}`,
      `${pad(c.hour)}${pad(c.minute)}`,
      `${pad(input.month)}${input.year}`,
      String(input.lines.length),
      money(total),
      "AED",
      clean(input.reference ?? "").slice(0, 35),
    ].join(","),
  );
  const fileName = `${employer.padStart(13, "0")}${pad(c.year % 100)}${pad(c.month)}${pad(c.day)}${pad(c.hour)}${pad(c.minute)}${pad(c.second)}.SIF`;
  return { ok: true, fileName, content: rows.join("\r\n") + "\r\n", total: total / 100 };
}
