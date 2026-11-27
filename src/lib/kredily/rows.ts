import type { KredilyPerson, KredilyRead, KredilyStructure } from "./read";

/**
 * Kredily's records as rows for Deskzo's own imports (owner, 31 Oct 2026), so every check those make — an address
 * that is already somebody's, a salary over its gross, a PAN or IFSC that isn't one, a month already locked — applies
 * to what came from Kredily too: the accounts (src/lib/portability/importers/users.ts), the employee records
 * (people.ts) and pay (payroll.ts). Leave openings are worked out where they are saved (src/actions/kredily-import.ts).
 */

export type Rows = Record<string, string>[];

const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

const EMPLOYMENT: Record<string, string> = {
  "full time": "FULL_TIME",
  "part time": "PART_TIME",
  intern: "INTERN",
  "on contract": "CONTRACT",
  contract: "CONTRACT",
  consultant: "CONSULTANT",
};
const GENDER: Record<string, string> = { male: "MALE", female: "FEMALE", transgender: "OTHER", other: "OTHER" };

/** Kredily's salary components as Deskzo's; anything else that is pay goes to Other allowance. */
const COMPONENT: Record<string, "Basic" | "HRA" | "Conveyance" | "Medical" | "Special allowance"> = {
  basic: "Basic",
  "basic salary": "Basic",
  hra: "HRA",
  "house rent allowance": "HRA",
  "conveyance allowance": "Conveyance",
  conveyance: "Conveyance",
  "medical allowance": "Medical",
  medical: "Medical",
  "special allowance": "Special allowance",
};
/** Not the employee's monthly pay: what the employer pays on top, and what is taken off. */
const NOT_PAY = /employer|lwf|tds|deduction|\bpf\b|provident|\besi|gratuity|bonus|insurance|tax/i;

export const isActive = (p: KredilyPerson) => /^active$/i.test(p.status);
export const fullName = (p: KredilyPerson) => [p.firstName, p.middleName, p.lastName].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
/** The address their account is made with: the official one, else their own. */
export const emailOf = (p: KredilyPerson) => p.email || p.personalEmail;

/** Who comes across: everyone active, and — when asked — those who have left, as switched-off records. */
export function peopleToBring(read: KredilyRead, includeLeavers: boolean): KredilyPerson[] {
  return read.people.filter((p) => emailOf(p) && (isActive(p) || includeLeavers));
}

/** The accounts: name, address, the role chosen for new ones, active or switched off, department. Managers come in a second pass. */
export function accountRows(people: KredilyPerson[], role: string, existing: Set<string>): Rows {
  // An account already here keeps its role and its name: only a new one is given them.
  return people.map((p) => {
    const here = existing.has(emailOf(p).toLowerCase());
    return { ...(here ? {} : { Name: fullName(p) || emailOf(p), Role: role }), Email: emailOf(p), Active: isActive(p) ? "Yes" : "No", ...(p.department ? { Department: p.department } : {}) };
  });
}

/**
 * Each account's manager, once every account exists — by address where the manager is one of the people being
 * brought, so two people of one name can't be confused; else by the name Kredily wrote.
 */
export function managerRows(people: KredilyPerson[], all: KredilyPerson[]): Rows {
  const byName = new Map<string, string[]>();
  for (const p of all) {
    const key = fullName(p).toLowerCase();
    if (key && emailOf(p)) byName.set(key, [...(byName.get(key) ?? []), emailOf(p)]);
  }
  const byCode = new Map(all.map((p) => [p.code.toLowerCase(), emailOf(p)]));
  return people
    .filter((p) => p.manager)
    .map((p) => {
      const m = p.manager.trim();
      const email = m.includes("@") ? m.toLowerCase() : (byCode.get(m.toLowerCase()) ?? (byName.get(m.toLowerCase())?.length === 1 ? byName.get(m.toLowerCase())![0] : undefined));
      return { Email: emailOf(p), Manager: email ?? m };
    })
    .filter((r) => r.Manager.toLowerCase() !== r.Email.toLowerCase());
}

/** The employee records: code, designation, type, location, joining day, birthday, gender. */
export function recordRows(people: KredilyPerson[]): Rows {
  return people.map((p) => {
    const row: Record<string, string> = { User: emailOf(p), "Employee code": p.code };
    if (p.designation) row.Designation = p.designation;
    const type = EMPLOYMENT[p.type.toLowerCase()];
    if (type) row["Employment type"] = type;
    if (p.location) row["Work location"] = p.location;
    if (p.joinedOn) row["Joined on"] = p.joinedOn;
    if (p.dateOfBirth) row["Date of birth"] = p.dateOfBirth;
    const gender = GENDER[p.gender.toLowerCase()];
    if (gender) row.Gender = gender;
    if (p.personalEmail && p.personalEmail !== p.email) row["Personal email"] = p.personalEmail;
    if (p.phone) row["Personal phone"] = p.phone;
    return row;
  });
}

/** A structure's yearly components as Deskzo's monthly ones, the gross their sum. */
export function monthlySalary(s: KredilyStructure): { parts: Record<string, string>; gross: string; pf: boolean } {
  const parts: Record<string, number> = {};
  let other = 0;
  for (const [name, yearly] of Object.entries(s.annual)) {
    const key = name.toLowerCase().trim();
    const component = COMPONENT[key];
    const monthly = Math.round((yearly / 12) * 100) / 100;
    if (component) parts[component] = Math.round(((parts[component] ?? 0) + monthly) * 100) / 100;
    else if (!NOT_PAY.test(name) && monthly > 0) other = Math.round((other + monthly) * 100) / 100;
  }
  if (other > 0) parts["Other allowance"] = other;
  const gross = Object.values(parts).reduce((t, v) => t + v, 0);
  const pfEmployer = Object.entries(s.annual).find(([name]) => /pf employer|employer pf|provident/i.test(name))?.[1] ?? 0;
  return { parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, money(v)])), gross: money(gross), pf: pfEmployer > 0 };
}

export type PaidSoFar = { gross: number; tds: number; pt: number; pf: number; through: string | null; later: string[]; estimated: string[] };

/**
 * What was paid in Kredily this year (owner, 31 Oct 2026: the first payroll in Deskzo is the month after the last one
 * Kredily paid). The pay register's months; then any month the TDS report holds past it — paid in Kredily, but not in
 * the register yet — its gross from that month's PF register or PT report, else the salary structure's monthly gross
 * (`estimated` names those months), its PF and PT from those registers. TDS is the TDS report's own, month by month,
 * where there is one: it is what was deducted, the register's split of it aside.
 */
export function payToDate(p: KredilyPerson, read: KredilyRead): PaidSoFar | null {
  const register = read.pay.get(p.code);
  const tdsByMonth = read.tds.get(p.code);
  const later = Object.keys(tdsByMonth ?? {})
    .filter((m) => (read.payThrough ? m > read.payThrough : !register))
    .sort();
  if (!register && later.length === 0) return null;
  const out: PaidSoFar = { gross: register?.gross ?? 0, tds: register?.tds ?? 0, pt: register?.pt ?? 0, pf: register?.pf ?? 0, through: read.payThrough, later, estimated: [] };
  const structure = read.structures.get(p.code);
  const monthlyGross = structure && (structure.annualCtc ?? 0) > 0 ? Number(monthlySalary(structure).gross) : null;
  for (const month of later) {
    const that = read.months.get(p.code)?.[month];
    const gross = that?.gross ?? monthlyGross;
    if (gross === null || gross === undefined) continue;
    if (that?.gross === null || that?.gross === undefined) out.estimated.push(month);
    out.gross += gross;
    out.pf += that?.pf ?? 0;
    out.pt += that?.pt ?? 0;
    out.through = month;
  }
  if (tdsByMonth && Object.keys(tdsByMonth).length) out.tds = Object.values(tdsByMonth).reduce((t, v) => t + v, 0);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { ...out, gross: r2(out.gross), tds: r2(out.tds), pt: r2(out.pt), pf: r2(out.pf) };
}

/**
 * Pay: the salary (where Kredily has a structure with a CTC), bank and statutory numbers, and what was paid so far
 * this year — for those who are active. A person with none of these has no row.
 */
export function payRows(people: KredilyPerson[], read: KredilyRead): Rows {
  const rows: Rows = [];
  for (const p of people.filter(isActive)) {
    const row: Record<string, string> = { User: emailOf(p), "Employee code": p.code };
    const s = read.structures.get(p.code);
    if (s && (s.annualCtc ?? 0) > 0) {
      const salary = monthlySalary(s);
      if (Number(salary.gross) > 0) {
        Object.assign(row, salary.parts, { "Monthly gross": salary.gross, "Salary from": s.effectiveFrom || p.joinedOn, "PF applies": salary.pf ? "Yes" : "No" });
      }
    }
    if (p.account) row["Account number"] = p.account;
    if (p.ifsc) row.IFSC = p.ifsc;
    if (p.bank) row["Bank name"] = p.bank;
    if (p.pan) row.PAN = p.pan;
    if (/^\d{12}$/.test(p.aadhaar)) row.Aadhaar = p.aadhaar;
    const uan = read.uan.get(p.code);
    if (uan) row.UAN = uan;
    if (s?.pfNumber) row["PF number"] = s.pfNumber;
    const paid = payToDate(p, read);
    if (paid) {
      row["Gross paid this year"] = money(paid.gross);
      row["TDS this year"] = money(paid.tds);
      row["PT this year"] = money(paid.pt);
      row["PF this year"] = money(paid.pf);
    }
    if (Object.keys(row).length > 2) rows.push(row);
  }
  return rows;
}

/**
 * Kredily's leave columns somebody brought actually holds — more than nothing (owner, 31 Oct 2026: the first import made
 * eight types, Maternity to "Leave Type 2", that nobody had a day in). A type held by nobody isn't made here.
 */
export function heldLeaveTypes(read: KredilyRead, people: KredilyPerson[]): Set<string> {
  const held = new Set<string>();
  for (const p of people) {
    for (const [name, value] of Object.entries(read.leave.get(p.code) ?? {})) if (value > 0) held.add(name);
  }
  return held;
}
