/**
 * check:kredily-import — Kredily's exports read as they come (owner, 31 Oct 2026 — src/lib/kredily).
 *
 *   1. Each file recognised by its headings under Kredily's title rows, whatever it's called; a second copy and the
 *      ESI register (which also names a department and a location) not mistaken for anything.
 *   2. The employee master: names, dates as days, status, PAN, bank; an account number's leading apostrophe gone.
 *   3. Salary: yearly components made monthly, employer PF and LWF kept off pay, anything else into Other allowance,
 *      the gross their sum; PF applies where the employer pays it.
 *   4. Pay so far: the register's months added up per person, its totals rows skipped.
 *   5. Rows for Deskzo's imports: leavers switched off and only when asked, managers by address, an account here
 *      already keeping its role, pay only for those still working.
 *
 * No database: the files are built here.
 *
 *   npm run check:kredily-import
 */
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { monthKey, readKredily } from "../src/lib/kredily/read";
import { accountRows, heldLeaveTypes, managerRows, monthlySalary, payRows, payToDate, peopleToBring, recordRows } from "../src/lib/kredily/rows";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

async function book(sheetName: string, rows: (string | number | null)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function main() {
  const title = "Zz Traders Pvt Ltd";
  const directory = await book("Bulk Upload", [
    ["The same sheet can be used for…", "", "", "Mandatory Fields", "Mandatory Fields"],
    ["Employee ID", "First Name (Mandatory, if no Emp ID)", "Middle Name", "Last Name (Mandatory, if not…)", "Official Email ID (Mandatory…)", "Date of Joining(DD/MM/YYYY) (Mandatory)", "Contact Number (Mandatory, if…)", "DOB(DD/MM/YYYY)", "Gender", "Work Location", "Department", "Designation", "Job Title", "Employee Status", "Employee Type", "Reporting Manager(Emp ID/ Email)", "Annual CTC", "Aadhaar Card", "Pan Card", "Bank", "IFSC", "Account Number", "Personal Email ID"],
    ["ZZ/1", "Asha", "", "Rao", "asha@zz.in", "05/07/2021", "9000000001", "27/03/1990", "Female", "Head Office", "Sales", "Sales Head", "", "Active", "Full Time", "", 1200000, "123456789012", "ABCPR1234K", "HDFC", "hdfc0001234", "'50100012345678", ""],
    ["ZZ/2", "Ravi", "K", "Mehta", "ravi@zz.in", "01/02/2024", "9000000002", "", "Male", "Head Office", "Sales", "Executive", "", "Active", "On Contract", "Asha Rao", 360000, "", "", "", "", "'", "ravi.k@gmail.com"],
    ["ZZ/3", "Old", "", "Hand", "old@zz.in", "01/01/2019", "", "", "", "Head Office", "Sales", "Executive", "", "Inactive", "Full Time", "ZZ/1", 300000, "", "", "", "", "", ""],
    ["ZZ/4", "No", "", "Mail", "", "01/01/2020", "", "", "", "", "", "", "", "Active", "Full Time", "", 0, "", "", "", "", "", ""],
  ]);
  const structures = await book("Sheet", [
    [title, title, title],
    ["Employee ID", "Employee Name", "Location", "Department", "Designation", "PAN Number", "PF Number", "Structure Name", "Structure Effective Date", "Annual CTC", "Basic", "HRA", "LWF", "Conveyance Allowance", "LWF Employer contibution", "PF Employer", "Special Allowance", "Phone Allowance"],
    ["ZZ/1", "Asha Rao", "Gurugram", "Sales", "Sales Head", "ABCPR1234K", "", "Standard", "2026-09-17", 1200000, 480000, 240000, 372, 19200, 744, 21600, 438000, 1200],
    ["ZZ/2", "Ravi Mehta", "Gurugram", "Sales", "Executive", "", "", "Standard", "2026-04-01", 360000, 180000, 90000, 0, 0, 0, 0, 90000, 0],
  ]);
  const register = await book("Sheet", [
    [`${title} - Consolidated Salary Register - 2026 - 2027`],
    [""],
    ["SALARY REGISTER FROM 01/04/2026 TO 30/09/2026"],
    ["Sl.No", "Employee Id", "Employee Name", "Month", "Working Days", "LOP", "Basic", "HRA", "Total Gross", "Employee PF", "Employer PF", "PT", "Income Tax", "Total Deduction", "Net Salary"],
    [1, "ZZ/1", "Asha Rao", "April 2026", 30, 0, 40000, 20000, 98000, 1800, 1800, 0, 9000, 10800, 87200],
    ["", "ZZ/1", "Asha Rao", "May 2026", 31, 0, 40000, 20000, 98000, 1800, 1800, 0, 9000, 10800, 87200],
    ["Total", "", "", "", "", "", 80000, 40000, 196000, 3600, 3600, 0, 18000, 21600, 174400],
    [2, "ZZ/2", "Ravi Mehta", "April 2026", 30, 0, 15000, 7500, 30000, 0, 0, 0, 0, 0, 30000],
  ]);
  const leave = await book("Sheet", [
    [title, title],
    ["Employee ID", "Employee Name", "Department", "Location", "Casual Leave", "Comp Off", "Loss of Pay"],
    ["ZZ/1", "Asha Rao", "Sales", "Head Office", "7.50", "0.00", "-"],
    ["ZZ/2", "Ravi Mehta", "Sales", "Head Office", "-", "1.00", "-"],
  ]);
  const esi = await book("ESI Register", [
    [`${title} - ESI Register - October 2026`],
    ["Sl. No.", "Employee ID", "Employee Name", "IP Number", "Department", "Location", "Days Paid", "ESI Wages", "Employee Share", "Employer Share", "Total Contribution"],
    ["No records for the selected period."],
  ]);
  const zip = new JSZip();
  zip.file("kredily/Directory_Export1.xlsx", directory);
  zip.file("kredily/Salary_Structures_a.xlsx", structures);
  zip.file("kredily/Salary_Structures_b.xlsx", structures);
  zip.file("kredily/Yearly_Consolidated_Pay_Register.xlsx", register);
  zip.file("kredily/Leave_Balance.xlsx", leave);
  zip.file("kredily/ESI_Register.xlsx", esi);
  const read = await readKredily([{ name: "kredily.zip", bytes: Buffer.from(await zip.generateAsync({ type: "uint8array" })) }]);

  section("1. Each file by its headings");
  ok("the master, the structures, the register and the leave are read", read.read.map((r) => r.as).sort().join() === ["Employee master", "Leave balances", "Pay register (pay so far this year)", "Salary structures"].join(), read.read);
  ok("  a second copy of the structures and the ESI register are left out, not misread", read.ignored.some((f) => f.includes("Salary_Structures_b") && f.includes("second copy")) && read.ignored.includes("ESI_Register.xlsx") && read.leaveTypes.join() === "Casual Leave,Comp Off,Loss of Pay", { ignored: read.ignored, leaveTypes: read.leaveTypes });
  const held = heldLeaveTypes(read, read.people.filter((p) => p.code === "ZZ/1"));
  ok("  a leave type is made only where somebody brought holds a day of it", held.has("Casual Leave") && !held.has("Comp Off") && heldLeaveTypes(read, read.people).has("Comp Off"), [...held]);
  ok("  the register's span", read.paySpan === "01/04/2026 to 30/09/2026", read.paySpan);

  section("2. The employee master");
  const asha = read.people.find((p) => p.code === "ZZ/1")!;
  ok("days as days, PAN and IFSC upper-case, the account's apostrophe gone", asha.joinedOn === "2021-07-05" && asha.dateOfBirth === "1990-03-27" && asha.pan === "ABCPR1234K" && asha.ifsc === "HDFC0001234" && asha.account === "50100012345678", asha);
  ok("  an account cell of only an apostrophe is empty", read.people.find((p) => p.code === "ZZ/2")!.account === "");

  section("3. Salary");
  const salary = monthlySalary(read.structures.get("ZZ/1")!);
  ok("yearly made monthly: basic 40,000, HRA 20,000, conveyance 1,600, special 36,500", salary.parts.Basic === "40000.00" && salary.parts.HRA === "20000.00" && salary.parts.Conveyance === "1600.00" && salary.parts["Special allowance"] === "36500.00", salary.parts);
  ok("  employer PF and LWF kept off pay; the phone allowance into Other", salary.parts["Other allowance"] === "100.00" && salary.gross === "98200.00", salary);
  ok("  PF applies where the employer pays it, not where they don't", salary.pf && !monthlySalary(read.structures.get("ZZ/2")!).pf);

  section("4. Pay so far");
  const paid = read.pay.get("ZZ/1")!;
  ok("two months added up, the totals row skipped", paid.months === 2 && paid.gross === 196000 && paid.tds === 18000 && paid.pf === 3600, paid);

  section("5. Rows for Deskzo's imports");
  const active = peopleToBring(read, false);
  const all = peopleToBring(read, true);
  ok("those still working; with leavers asked for, the leaver too — nobody without an address", active.map((p) => p.code).join() === "ZZ/1,ZZ/2" && all.map((p) => p.code).join() === "ZZ/1,ZZ/2,ZZ/3", all.map((p) => p.code));
  const accounts = accountRows(all, "SALES", new Set(["asha@zz.in"]));
  ok("a leaver's account switched off; one here already keeps its role and name", accounts.find((a) => a.Email === "old@zz.in")?.Active === "No" && accounts.find((a) => a.Email === "ravi@zz.in")?.Role === "SALES" && !("Role" in accounts.find((a) => a.Email === "asha@zz.in")!), accounts);
  const managers = managerRows(all, read.people);
  ok("managers by address, from a name or an employee ID", managers.find((m) => m.Email === "ravi@zz.in")?.Manager === "asha@zz.in" && managers.find((m) => m.Email === "old@zz.in")?.Manager === "asha@zz.in", managers);
  const records = recordRows(active);
  ok("a contract employee's type, a gender, a personal email", records.find((r) => r.User === "ravi@zz.in")?.["Employment type"] === "CONTRACT" && records.find((r) => r.User === "asha@zz.in")?.Gender === "FEMALE" && records.find((r) => r.User === "ravi@zz.in")?.["Personal email"] === "ravi.k@gmail.com", records);
  const pay = payRows(all, read);
  ok("pay for those still working only, with the salary, bank, PAN and pay so far", pay.length === 2 && pay[0]!["Monthly gross"] === "98200.00" && pay[0]!["Salary from"] === "2026-09-17" && pay[0]!.IFSC === "HDFC0001234" && pay[0]!["Gross paid this year"] === "196000.00" && !pay.some((r) => r.User === "old@zz.in"), pay[0]);

  section("6. A month past the pay register, the leave and the claims (owner, 31 Oct 2026)");
  // October was paid in Kredily; its pay register runs to September. The TDS report, PF register and PT report know October.
  const tds = await book("Sheet", [
    [`${title} - Consolidated TDS Report - Oct 2026`],
    ["Sl No", "Employee ID", "Employee Name", "Work Location", "Department", "Designation", "Apr 2026", "May 2026", "Oct 2026", "Tax on Income", "Education cess @4%", "Surcharge @10%", "Total TDS"],
    [1, "ZZ/1", "Asha Rao", "Gurugram", "Sales", "Sales Head", 9000, 9000, 9500, 26442, 1058, 0, 27500],
    [2, "ZZ/2", "Ravi Mehta", "Gurugram", "Sales", "Executive", 0, 0, 0, 0, 0, 0, 0],
  ]);
  const pfRegister = await book("Sheet", [
    [`${title} - PF Register - Oct 2026 - Exported on 31 Oct 2026`],
    [""],
    ["PROVIDENT FUND REGISTER FOR Oct, 2026", "", "Total Days :", 31],
    ["Sl. No.", "Employee P.F. \nNumber & UAN No.", "Employee Code, Name, Department \nand Designation", "Paid Days", "Gross \nSalary", "EPF & EPS \nWages", "Employee Contribution \n(12.00%) \nIncluding VPF", "Employer Contribution"],
    ["Sl. No.", "Employee P.F. \nNumber & UAN No.", "Employee Code, Name, Department \nand Designation", "Paid Days", "Gross \nSalary", "EPF & EPS \nWages", "Employee Contribution \n(12.00%) \nIncluding VPF", "E.P.F. (3.67%)"],
    [1, "HR/GGN/0012345/000/1\n101234567890", "ZZ/1\nAsha Rao\nSales\nSales Head", 31, 98000, 15000, 1800, 550],
  ]);
  const ptReport = await book("Sheet", [
    [`${title} - PT Report - Oct 2026 - Exported on 31 Oct 2026`],
    [""],
    ["PROFESSIONAL TAX DETAILS FOR THE PERIOD OF THE MONTH Oct 2026"],
    ["Sl. No.", "Employee Code", "Employee Name", "Department", "Designation", "Location", "Gross Salary on which calculated", "Professional Tax"],
    [1, "ZZ/1", "Asha Rao", "Sales", "Sales Head", "Bengaluru", 98000, 200],
    ["Total", "", "", "", "", "", "", 200],
  ]);
  const pending = await book("Pending Expenses", [
    [`${title} - Pending Expenses`],
    ["October 2026"],
    ["Employee ID", "Employee Name", "Department", "Category", "Description", "Expense Date", "Applied On", "Claimed Amount", "Awaiting", "Ageing (days)"],
    ["ZZ/1", "Asha Rao", "Sales", "Auto", "Client visit, Cyber City", "12/10/2026", "13/10/2026", 150, "", 18],
    ["ZZ/3", "Old Hand", "Sales", "porter Delivery", "", "05/10/2026", "05/10/2026", 420, "", 26],
    ["ZZ/2", "Ravi Mehta", "Sales", "Cab", "", "", "", 0, "", 0],
  ]);
  const zip2 = new JSZip();
  for (const [n, b] of [["Directory_Export1.xlsx", directory], ["Salary_Structures_a.xlsx", structures], ["Yearly_Consolidated_Pay_Register.xlsx", register], ["Leave_Balance.xlsx", leave], ["Consolidated TDS Report-Oct_2026.xlsx", tds], ["PF Register-Oct_2026.xlsx", pfRegister], ["PT Report-Oct_2026.xlsx", ptReport], ["Pending_Expenses.xlsx", pending]] as const) zip2.file(`kredily/${n}`, b);
  const read2 = await readKredily([{ name: "kredily.zip", bytes: Buffer.from(await zip2.generateAsync({ type: "uint8array" })) }]);
  const kinds = read2.read.map((r) => r.as);
  ok("the TDS report, the PF register, the PT report and the pending claims are read too", ["TDS report (tax deducted, month by month)", "PF register (UANs)", "PT report (the month's professional tax)", "Pending expense claims"].every((k) => kinds.includes(k)) && read2.ignored.length === 0, { kinds, ignored: read2.ignored });
  ok("  October from the PF and PT registers: gross 98,000, PF 1,800, PT 200; the UAN out of its shared cell", JSON.stringify(read2.months.get("ZZ/1")?.["2026-10"]) === JSON.stringify({ gross: 98000, pf: 1800, pt: 200 }) && read2.uan.get("ZZ/1") === "101234567890", read2.months.get("ZZ/1"));
  ok("  the register's last month, as a month", read2.payThrough === "2026-05", read2.payThrough);
  const ashaPaid = payToDate(read2.people.find((p) => p.code === "ZZ/1")!, read2);
  ok("pay so far through October: the register's two months and October — gross 2,94,000, PF 5,400, PT 200", ashaPaid?.through === "2026-10" && ashaPaid.gross === 294000 && ashaPaid.pf === 5400 && ashaPaid.pt === 200 && ashaPaid.later.join() === "2026-10" && ashaPaid.estimated.length === 0, ashaPaid);
  ok("  TDS as the TDS report has it, month by month: 27,500", ashaPaid?.tds === 27500, ashaPaid);
  const raviPaid = payToDate(read2.people.find((p) => p.code === "ZZ/2")!, read2);
  ok("no October register for somebody: its gross is the structure's month, and it says so", raviPaid?.gross === 60000 && raviPaid.estimated.join() === "2026-10" && raviPaid.tds === 0, raviPaid);
  const pay2 = payRows(all, read2);
  ok("  the pay rows carry it", pay2.find((r) => r.User === "asha@zz.in")?.["TDS this year"] === "27500.00" && pay2.find((r) => r.User === "asha@zz.in")?.["Gross paid this year"] === "294000.00");
  ok("pending claims: those with a day and an amount, as days", read2.expenses.length === 2 && read2.expenses[0]!.spentOn === "2026-10-12" && read2.expenses[0]!.amount === 150 && read2.expenses[0]!.category === "Auto" && read2.expenses[1]!.code === "ZZ/3", read2.expenses);
  ok("Kredily's months read as months", monthKey("September 2026") === "2026-09" && monthKey("Oct, 2026") === "2026-10" && monthKey("PROVIDENT FUND REGISTER FOR Oct, 2026") === "2026-10" && monthKey("Total") === null);

  console.log(failures === 0 ? `\nAll ${passes} Kredily import checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
