/**
 * check:statutory-files — a payroll month's bank transfer, PF ECR and ESI return (src/lib/hr/statutory-files.ts),
 * against files worked out by hand. Pure: no database.
 *
 *   npm run check:statutory-files
 */
import { computePf } from "../src/lib/hr/payroll";
import { ageOn, bankCsv, buildBank, buildEcr, buildEsi, type StatutoryRow } from "../src/lib/hr/statutory-files";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

const blank: StatutoryRow = {
  name: "",
  employeeCode: null,
  uan: null,
  esicNumber: null,
  dateOfBirth: null,
  exitedOn: null,
  monthDays: 31,
  paidDays: 31,
  lopDays: 0,
  grossEarnings: 0,
  pfEmployee: 0,
  pfEmployer: 0,
  pfWages: 0,
  epsWages: 0,
  epsEmployer: 0,
  esiEmployee: 0,
  esiEmployer: 0,
  netPay: 0,
  bankAccountNumber: null,
  bankIfsc: null,
  bankName: null,
};
const row = (r: Partial<StatutoryRow>): StatutoryRow => ({ ...blank, ...r });
const AUG = { year: 2026, month: 8 };

section("Age on the 1st — the pension stops at 58");
ok("58 on the 1st itself", ageOn(d("1968-08-01"), AUG) === 58, ageOn(d("1968-08-01"), AUG));
ok("57 when the birthday is later in the month", ageOn(d("1968-08-15"), AUG) === 57, ageOn(d("1968-08-15"), AUG));
ok("no date of birth: no age", ageOn(null, AUG) === null);

section("The engine keeps the pension's wages");
{
  const pf = computePf(30000, { applicable: true, onFullBasic: true, period: { year: 2026, month: 11 } });
  ok("PF on the full basic: wages 30,000", pf.wages === 30000, pf);
  ok("the pension's wages stop at the ceiling, 25,000 from Sep 2026", pf.epsWages === 25000, pf.epsWages);
  ok("the employer's pension is 8.33% of that", Math.abs(pf.eps - 2082.5) <= 1, pf.eps);
}

section("PF ECR");
{
  const ecr = buildEcr(
    [
      // Within the ceiling, two days' loss of pay.
      row({ name: "Asha Rao", uan: "100200300400", dateOfBirth: d("1990-04-10"), grossEarnings: 30000, pfWages: 15000, epsWages: 15000, epsEmployer: 1250, pfEmployee: 1800, pfEmployer: 1800, lopDays: 2 }),
      // Over 58: no pension — the employer's whole 12% to EPF. PF on 20,000; EDLI stops at the ceiling.
      row({ name: "R. K. Mehta-Singh", uan: "1002 0030 0401", dateOfBirth: d("1960-05-01"), grossEarnings: 25000, pfWages: 20000, epsWages: 15000, epsEmployer: 1250, pfEmployee: 2400, pfEmployer: 2400 }),
      // A payslip from before the split was kept: worked back from 1,800 = 12% of 15,000.
      row({ name: "Old Slip", uan: "100200300402", grossEarnings: 18000, pfEmployee: 1800, pfEmployer: 1800 }),
      // No UAN: left out, and said so.
      row({ name: "No Uan", employeeCode: "E9", pfEmployee: 1800, pfEmployer: 1800, pfWages: 15000 }),
      // A short UAN.
      row({ name: "Short Uan", uan: "12345", pfEmployee: 1800, pfEmployer: 1800, pfWages: 15000 }),
      // Not in PF: not in the file, and not a problem.
      row({ name: "Not In Pf", grossEarnings: 50000 }),
    ],
    AUG,
    15000,
  );
  const lines = ecr.content.split("\n");
  ok("three members", ecr.included === 3 && lines.length === 3, ecr.included);
  ok("within the ceiling", lines[0] === "100200300400#~#ASHA RAO#~#30000#~#15000#~#15000#~#15000#~#1800#~#1250#~#550#~#2#~#0", lines[0]);
  ok("over 58: no pension, 2,400 to EPF, EDLI at the ceiling", lines[1] === "100200300401#~#R. K. MEHTA SINGH#~#25000#~#20000#~#0#~#15000#~#2400#~#0#~#2400#~#0#~#0", lines[1]);
  ok("an old payslip worked back", lines[2] === "100200300402#~#OLD SLIP#~#18000#~#15000#~#15000#~#15000#~#1800#~#1250#~#550#~#0#~#0", lines[2]);
  ok("two left out, each named", ecr.problems.length === 2 && ecr.problems[0] === "No Uan (E9) — no UAN on their record" && ecr.problems[1] === "Short Uan — the UAN isn't 12 digits", ecr.problems);
}

section("ESI return");
{
  const NOV = { year: 2026, month: 11 };
  const esi = buildEsi(
    [
      row({ name: "Full Month", esicNumber: "1100223344", paidDays: 30, grossEarnings: 20000.4, esiEmployee: 150, esiEmployer: 650 }),
      row({ name: "Left Mid", esicNumber: "1100223345", paidDays: 10, grossEarnings: 6000, esiEmployee: 45, esiEmployer: 195, exitedOn: d("2026-11-10") }),
      row({ name: "On Leave", esicNumber: "1100223346", paidDays: 0, grossEarnings: 0, esiEmployer: 1 }),
      row({ name: "Left Before", esicNumber: "1100223347", paidDays: 0, esiEmployee: 1, exitedOn: d("2026-10-31") }),
      row({ name: "Bad Ip", employeeCode: "E7", esicNumber: "110022334", esiEmployee: 150 }),
      row({ name: "Not Covered", grossEarnings: 40000 }),
    ],
    NOV,
  );
  const [full, left, leave, before] = esi.content;
  ok("four insured people", esi.included === 4, esi.included);
  ok("a full month: days, whole-rupee wages, reason 0", JSON.stringify(full) === JSON.stringify({ ipNumber: "1100223344", name: "Full Month", days: 30, wages: 20000, reasonCode: 0, lastWorkingDay: "" }), full);
  ok("left in the month: reason 2 and the last working day", left?.reasonCode === 2 && left.lastWorkingDay === "10/11/2026" && left.days === 10, left);
  ok("no days, still employed: reason 1", leave?.reasonCode === 1 && leave.lastWorkingDay === "", leave);
  ok("left in an earlier month: not left this month", before?.reasonCode === 1 && before.lastWorkingDay === "", before);
  ok("a 9-digit IP number left out", esi.problems.length === 1 && esi.problems[0] === "Bad Ip (E7) — the ESI IP number isn't 10 digits", esi.problems);
}

section("Bank transfer");
{
  const bank = buildBank([
    row({ name: "Asha Rao", netPay: 25432.5, bankAccountNumber: "0012 3456 7890", bankIfsc: "hdfc0001234", bankName: "HDFC Bank" }),
    row({ name: 'Ravi "RK" Kumar', netPay: 18000, bankAccountNumber: "998877665544", bankIfsc: "SBIN0000123" }),
    row({ name: "Bad Ifsc", netPay: 10000, bankAccountNumber: "123456789", bankIfsc: "SBIN123" }),
    row({ name: "No Account", employeeCode: "E3", netPay: 10000 }),
    row({ name: "Nothing Due", netPay: 0 }),
  ]);
  ok("two payments", bank.included === 2, bank.included);
  ok("total 43,432.50", bank.total === 43432.5, bank.total);
  ok("account spaces dropped, IFSC upper-cased", bank.content[0]?.accountNumber === "001234567890" && bank.content[0]?.ifsc === "HDFC0001234", bank.content[0]);
  ok("bad IFSC and no account left out", bank.problems.join(" | ") === "Bad Ifsc — the IFSC isn't valid | No Account (E3) — no bank account on their record", bank.problems);
  const csv = bankCsv(bank.content, "Salary Nov 2026").split("\r\n");
  ok("a header line", csv[0] === '"Beneficiary Name","Account Number","IFSC","Amount","Narration"', csv[0]);
  ok("amounts to two places", csv[1] === '"Asha Rao","001234567890","HDFC0001234","25432.50","Salary Nov 2026"', csv[1]);
  ok("quotes doubled", csv[2] === '"Ravi ""RK"" Kumar","998877665544","SBIN0000123","18000.00","Salary Nov 2026"', csv[2]);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll statutory-file checks pass");
process.exit(failures ? 1 : 0);
