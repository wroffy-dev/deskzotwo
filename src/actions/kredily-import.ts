"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type ExpenseCategory } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { refuseWhileViewingAs } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { applyWith, planWith, type ImportPlan } from "@/lib/portability/import";
import { usersImporter } from "@/lib/portability/importers/users";
import { keyOf } from "@/lib/portability/importers/types";
import { peopleImporter } from "@/lib/portability/importers/people";
import { payrollImporter } from "@/lib/portability/importers/payroll";
import { leaveYearOfDay } from "@/lib/hr/leave-year-server";
import { attendancePlan, writeAttendance, type AttendancePlan } from "@/lib/kredily/attendance-days";
import { ensureBalance, TYPED_OPENING } from "@/lib/hr/leave-balance";
import { workspaceClock } from "@/lib/time/workspace";
import { saveLeaveOpenings } from "@/actions/leave-openings";
import { readKredily, type KredilyRead } from "@/lib/kredily/read";
import { FileTooLarge } from "@/lib/portability/workbook";
import { accountRows, emailOf, heldLeaveTypes, isActive, managerRows, payRows, payToDate, peopleToBring, recordRows, type Rows } from "@/lib/kredily/rows";
import { calendarDayRange } from "@/lib/time/zone";
import { routeClaim } from "@/lib/expenses/route";
import { notifyUser } from "@/lib/notify";
import type { ActionResult } from "@/actions/company";

/**
 * People › Import from Kredily (owner, 31 Oct 2026): Kredily's exports, uploaded as they come — the ZIP or the files —
 * read (src/lib/kredily/read.ts), previewed, then brought across in order through Deskzo's own imports: the accounts
 * (switched off for those who have left, and no invitation sent), each one's manager once all exist, the employee
 * records, pay — salary, bank, statutory numbers and this year's pay so far — and leave opening balances. Each step's
 * rows that can't come in are listed with why; the rest land. For whoever may manage people, HR and payroll.
 *
 * Since 31 Oct 2026 (the owner's move off Kredily, first payroll in Deskzo the month after Kredily's last): pay so far
 * runs through the last month the TDS report holds; a Kredily leave type this workspace hasn't got is made, by Kredily's
 * name (Loss of Pay is not a balance); and pending expense claims come across awaiting approval, routed as any claim is.
 * The Consolidated Attendance Report fills each person's days, never one Deskzo already has — with the employee master,
 * or alone, for people whose records are already here.
 */

type Upload = { filename: string; base64: string };
/** `withAbsent`: bring Kredily's absent marks too — left unset, only where somebody was ever marked present. */
type Input = { files: Upload[]; includeLeavers?: boolean; role?: string; withAbsent?: boolean };

const MAX_BYTES = 10 * 1024 * 1024;

export type StepPlan = { creates: number; updates: number; skips: number; errors: { line: number; who: string; error: string }[]; pending: number };
/** `empty`: Kredily's types nobody brought holds a day in, not made; `nil`: of the balances, those at nothing. */
export type LeavePlan = { matched: { kredily: string; deskzo: string }[]; unmatched: string[]; create: string[]; empty: string[]; notBalances: string[]; people: number; balances: number; nil: number };
export type ExpensePlan = { claims: number; amount: number; people: number; notHere: number };
export type { AttendancePlan };
export type KredilyPreview = {
  roles: { key: string; name: string }[];
  role: string;
  read: { file: string; as: string }[];
  ignored: string[];
  paySpan: string | null;
  people: { inFile: number; active: number; leavers: number; bringing: number; noAddress: number };
  accounts: StepPlan;
  managers: number;
  records: StepPlan;
  pay: StepPlan & { salaries: number; payToDate: number; bank: number; through: string | null; later: string[]; estimated: number };
  leave: LeavePlan;
  expenses: ExpensePlan;
  attendance: AttendancePlan | null;
};
export type StepResult = { created: number; updated: number; skipped: number; failed: { line: number; error: string }[] };
export type KredilyResult = {
  accounts: StepResult;
  managers: StepResult;
  records: StepResult;
  pay: StepResult;
  leave: { saved: number; nil: number; error: string | null; typesMade: string[] };
  expenses: { created: number; skipped: number; notHere: number };
  attendance: Awaited<ReturnType<typeof writeAttendance>> | null;
};

async function gate() {
  const user = await requireModuleUser("hr");
  const [people, hr, payroll] = await Promise.all([hasEffectivePermission(user.id, "users.manage"), hasEffectivePermission(user.id, "hr.manage"), hasEffectivePermission(user.id, "payroll.manage")]);
  if (!people || !hr || !payroll) return { user, error: "Bringing people across from Kredily needs managing users, HR and payroll." };
  // Security audit round two, 13 Nov 2026 (R2-01): Kredily's pay goes through the payroll import, so it is refused
  // while viewing as somebody here too — the preview as well as the import, which also asks. The importer itself
  // refuses the row of the person importing (src/lib/portability/importers/payroll.ts).
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { user, error: viewing };
  return { user, error: null };
}

async function readUploads(input: Input): Promise<{ read: KredilyRead } | { error: string }> {
  const files = Array.isArray(input?.files) ? input.files : [];
  if (files.length === 0) return { error: "Upload Kredily's ZIP, or its Excel files." };
  let total = 0;
  const decoded = files.map((f) => {
    const bytes = Buffer.from(String(f.base64 ?? ""), "base64");
    total += bytes.length;
    return { name: String(f.filename ?? "file"), bytes };
  });
  if (total > MAX_BYTES) return { error: `That's over ${MAX_BYTES / 1024 / 1024}MB in all.` };
  try {
    const read = await readKredily(decoded);
    if (read.people.length === 0 && !read.attendance) return { error: "No employee master in these files — export Directory › Employee Master Export from Kredily and add it." };
    return { read };
  } catch (err) {
    // A file refused for its size (R2-19) says so; anything else is the usual answer.
    if (err instanceof FileTooLarge) return { error: err.message };
    return { error: "These files couldn't be read as Kredily's Excel exports." };
  }
}

async function rowsFor(read: KredilyRead, includeLeavers: boolean, role: string) {
  const people = peopleToBring(read, includeLeavers);
  const here = await db.user.findMany({ where: { email: { in: people.map((p) => emailOf(p)), mode: "insensitive" } }, select: { email: true } });
  const existing = new Set(here.map((u) => u.email.toLowerCase()));
  return { people, accounts: accountRows(people, role, existing), managers: managerRows(people, read.people), records: recordRows(people), pay: payRows(people, read) };
}

/** The roles a new account may be given here — any but Admin, which is never handed out by a file — and the one to start with: Employee, the self-service role, where the workspace has it (owner, 1 Nov 2026). */
async function rolesFor(asked?: string) {
  const roles = (await db.role.findMany({ select: { key: true, name: true }, orderBy: { name: "asc" } })).filter((r) => r.key !== "ADMIN");
  const role = roles.find((r) => r.key === asked)?.key ?? roles.find((r) => r.key === "EMPLOYEE")?.key ?? roles.find((r) => r.key === "SALES")?.key ?? roles[0]?.key ?? "";
  return { roles, role };
}

/** A step's plan as the page shows it — a row about an account the first step makes counted as waiting for it, not refused. */
function summarise(plan: ImportPlan, rows: Rows, newEmails: Set<string>, who: (row: Record<string, string>) => string): StepPlan {
  const out: StepPlan = { creates: plan.creates, updates: plan.updates, skips: plan.skips, errors: [], pending: 0 };
  for (const r of plan.rows) {
    if (r.action !== "error") continue;
    const row = rows[r.line - 2] ?? {};
    const email = (row.User ?? row.Email ?? "").toLowerCase();
    if (newEmails.has(email)) out.pending += 1;
    else out.errors.push({ line: r.line, who: who(row), error: r.error ?? "Can't come in." });
  }
  return out;
}

/** Kredily's leave names matched to this workspace's paid leave types, by name or code; the rest made only where somebody holds a day of it. */
async function leaveMatch(read: KredilyRead, held: Set<string>) {
  const types = await db.leaveType.findMany({ where: { active: true, paid: true }, select: { id: true, name: true, code: true } });
  const key = (s: string) => s.toLowerCase().replace(/leave/g, "").replace(/[^a-z0-9]+/g, "");
  const ALIAS: Record<string, string[]> = { compoff: ["compensatoryoff", "co"], earned: ["privilege", "el", "pl"], casual: ["cl"], sick: ["sl"] };
  const matched = new Map<string, { id: string; name: string }>();
  for (const name of read.leaveTypes) {
    const k = key(name);
    const t = types.find((x) => key(x.name) === k || key(x.code) === k || (ALIAS[k] ?? []).includes(key(x.name)) || (ALIAS[k] ?? []).includes(key(x.code)));
    if (t) matched.set(name, { id: t.id, name: t.name });
  }
  const unmatched = read.leaveTypes.filter((n) => !matched.has(n));
  const leave = unmatched.filter((n) => !NOT_A_BALANCE.test(n));
  return { matched, unmatched, create: leave.filter((n) => held.has(n)), empty: leave.filter((n) => !held.has(n)), notBalances: unmatched.filter((n) => NOT_A_BALANCE.test(n)) };
}

/** Kredily's columns that aren't leave anybody holds: loss of pay is days unpaid, not a balance. */
const NOT_A_BALANCE = /loss\s*of\s*pay|^lop$/i;

/** A leave type for each Kredily one this workspace hasn't got (owner, 31 Oct 2026), named as Kredily names it: paid, no yearly grant until somebody sets one. */
async function makeLeaveTypes(names: string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const taken = new Set((await db.leaveType.findMany({ select: { code: true } })).map((t) => t.code.toUpperCase()));
  const last = await db.leaveType.aggregate({ _max: { sortOrder: true } });
  let order = (last._max.sortOrder ?? 0) + 1;
  const made: string[] = [];
  for (const name of names) {
    const initials = name.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0]!.toUpperCase()).join("").slice(0, 4) || "LV";
    let code = initials;
    for (let n = 2; taken.has(code); n++) code = `${initials}${n}`;
    taken.add(code);
    await db.leaveType.create({ data: { code, name, annualQuota: new Prisma.Decimal(0), paid: true, sortOrder: order++ } });
    made.push(name);
  }
  return made;
}

/** Kredily's expense categories as Deskzo's; anything else is Other, Kredily's word kept in the description. */
function expenseCategory(kredily: string): ExpenseCategory {
  const k = kredily.toLowerCase();
  if (/personal vehicle|own vehicle|mileage|\bkm\b/.test(k)) return "MILEAGE";
  if (/fuel|petrol|diesel|cng/.test(k)) return "FUEL";
  if (/toll|parking/.test(k)) return "TOLL_PARKING";
  if (/auto|cab|taxi|metro|ola|uber|rapido|bike|bus|train|rail|flight|air|travel/.test(k)) return "TRAVEL";
  if (/hotel|stay|lodg|accommodation/.test(k)) return "ACCOMMODATION";
  if (/food|meal|lunch|dinner|breakfast|snack/.test(k)) return "MEALS";
  if (/porter|courier|delivery|postage|dunzo/.test(k)) return "COURIER";
  if (/phone|mobile|internet|recharge|data/.test(k)) return "PHONE_INTERNET";
  if (/repair|maintenance|service/.test(k)) return "REPAIRS_MAINTENANCE";
  if (/exam|training|course|certification/.test(k)) return "TRAINING";
  if (/stationery|office/.test(k)) return "OFFICE_SUPPLIES";
  return "OTHER";
}

export async function previewKredily(input: Input): Promise<ActionResult<KredilyPreview>> {
  const { user, error } = await gate();
  if (error) return { ok: false, error };
  const got = await readUploads(input);
  if ("error" in got) return { ok: false, error: got.error };
  const { read } = got;
  const { roles, role } = await rolesFor(input.role);
  const attendance = read.attendance ? (await attendancePlan(read.attendance, input.withAbsent)).plan : null;
  // The attendance report alone: its people are found by the employee codes Deskzo already has.
  if (read.people.length === 0) {
    const none: StepPlan = { creates: 0, updates: 0, skips: 0, errors: [], pending: 0 };
    return {
      ok: true,
      data: {
        roles,
        role,
        read: read.read,
        ignored: read.ignored,
        paySpan: null,
        people: { inFile: 0, active: 0, leavers: 0, bringing: 0, noAddress: 0 },
        accounts: none,
        managers: 0,
        records: none,
        pay: { ...none, salaries: 0, payToDate: 0, bank: 0, through: null, later: [], estimated: 0 },
        leave: { matched: [], unmatched: [], create: [], empty: [], notBalances: [], people: 0, balances: 0, nil: 0 },
        expenses: { claims: 0, amount: 0, people: 0, notHere: 0 },
        attendance,
      },
    };
  }
  const r = await rowsFor(read, !!input.includeLeavers, role);

  const accounts = await planWith(usersImporter, "users", r.accounts, user.id);
  const newEmails = new Set(accounts.rows.filter((x) => x.action === "create").map((x) => (r.accounts[x.line - 2]?.Email ?? "").toLowerCase()));
  const byEmail = new Map(r.people.map((p) => [emailOf(p).toLowerCase(), p]));
  const who = (row: Record<string, string>) => {
    const p = byEmail.get((row.User ?? row.Email ?? "").toLowerCase());
    return p ? `${p.code} ${[p.firstName, p.lastName].filter(Boolean).join(" ")}` : (row.User ?? row.Email ?? "");
  };
  const [records, pay, leave] = await Promise.all([planWith(peopleImporter, "people", r.records, user.id), planWith(payrollImporter, "payroll", r.pay, user.id), leaveMatch(read, heldLeaveTypes(read, r.people.filter(isActive)))]);
  // Made on import, the types to create bring their balances too.
  const leaveCounts = (t: string) => leave.matched.has(t) || leave.create.includes(t);
  const leavePeople = r.people.filter(isActive).filter((p) => Object.keys(read.leave.get(p.code) ?? {}).some(leaveCounts));
  const paid = r.people
    .filter(isActive)
    .map((p) => payToDate(p, read))
    .filter((x) => x !== null);
  const activeCodes = new Set(r.people.filter(isActive).map((p) => p.code));
  const claims = read.expenses.filter((e) => activeCodes.has(e.code));

  return {
    ok: true,
    data: {
      roles,
      role,
      read: read.read,
      ignored: read.ignored,
      paySpan: read.paySpan,
      people: {
        inFile: read.people.length,
        active: read.people.filter(isActive).length,
        leavers: read.people.filter((p) => !isActive(p)).length,
        bringing: r.people.length,
        noAddress: read.people.filter((p) => !emailOf(p) && (isActive(p) || input.includeLeavers)).length,
      },
      accounts: summarise(accounts, r.accounts, new Set(), who),
      managers: r.managers.length,
      records: summarise(records, r.records, newEmails, who),
      pay: {
        // A pay row finds its person by employee code, which the records step sets first.
        ...summarise(pay, r.pay, new Set([...newEmails, ...records.rows.filter((x) => x.action === "create" || x.action === "update").map((x) => (r.records[x.line - 2]?.User ?? "").toLowerCase())]), who),
        salaries: r.pay.filter((x) => x["Monthly gross"]).length,
        payToDate: r.pay.filter((x) => x["Gross paid this year"]).length,
        bank: r.pay.filter((x) => x["Account number"]).length,
        through: paid.reduce<string | null>((m, x) => (x.through && (!m || x.through > m) ? x.through : m), null),
        later: [...new Set(paid.flatMap((x) => x.later))].sort(),
        estimated: paid.filter((x) => x.estimated.length > 0).length,
      },
      leave: {
        matched: [...leave.matched].map(([kredily, t]) => ({ kredily, deskzo: t.name })),
        unmatched: leave.unmatched,
        create: leave.create,
        empty: leave.empty,
        notBalances: leave.notBalances,
        people: leavePeople.length,
        balances: leavePeople.reduce((t, p) => t + Object.keys(read.leave.get(p.code) ?? {}).filter(leaveCounts).length, 0),
        nil: leavePeople.reduce((t, p) => t + Object.entries(read.leave.get(p.code) ?? {}).filter(([n, v]) => leaveCounts(n) && v === 0).length, 0),
      },
      expenses: {
        claims: claims.length,
        amount: Math.round(claims.reduce((t, e) => t + e.amount, 0) * 100) / 100,
        people: new Set(claims.map((e) => e.code)).size,
        notHere: read.expenses.length - claims.length,
      },
      attendance,
    },
  };
}

const step = (r: { created: number; updated: number; skipped: number; failed: { line: number; error: string }[] }): StepResult => ({ created: r.created, updated: r.updated, skipped: r.skipped, failed: r.failed.map((f) => ({ line: f.line, error: f.error })) });

export async function importKredily(input: Input): Promise<ActionResult<KredilyResult>> {
  const { user, error } = await gate();
  if (error) return { ok: false, error };
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  const got = await readUploads(input);
  if ("error" in got) return { ok: false, error: got.error };
  const { read } = got;
  if (read.people.length === 0) {
    const attendance = read.attendance ? await writeAttendance(read.attendance, input.withAbsent) : null;
    const none: StepResult = { created: 0, updated: 0, skipped: 0, failed: [] };
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "Import", entityId: "kredily", entityLabel: `Brought Kredily's attendance history: ${attendance?.created ?? 0} days` });
    revalidatePath("/people/attendance");
    return { ok: true, data: { accounts: none, managers: none, records: none, pay: none, leave: { saved: 0, nil: 0, error: null, typesMade: [] }, expenses: { created: 0, skipped: 0, notHere: 0 }, attendance } };
  }
  const { role } = await rolesFor(input.role);
  const r = await rowsFor(read, !!input.includeLeavers, role);

  // In order: the accounts; each one's manager now that all exist; the records; pay.
  const accounts = step(await applyWith(usersImporter, "users", r.accounts, user.id));
  const managers = step(await applyWith(usersImporter, "users", r.managers, user.id));
  // A record names its account by key: by address, only an active account is found, and those who have left are switched off.
  const made = await db.user.findMany({ where: { email: { in: r.records.map((x) => x.User!), mode: "insensitive" } }, select: { email: true, userSeq: true } });
  const keyOfEmail = new Map(made.map((u) => [u.email.toLowerCase(), keyOf("USR", u.userSeq)]));
  const recordRowsKeyed = r.records.map((x) => ({ ...x, User: keyOfEmail.get(x.User!.toLowerCase()) ?? x.User! }));
  const records = step(await applyWith(peopleImporter, "people", recordRowsKeyed, user.id));
  const pay = step(await applyWith(payrollImporter, "payroll", r.pay, user.id));

  // Leave: Kredily's balance today, as an opening for the year — the year's own grant so far taken off it (or, where
  // that is more than the balance, the difference counted as taken before Deskzo), so the balance reads as Kredily's.
  const held = heldLeaveTypes(read, r.people.filter(isActive));
  const typesMade = await makeLeaveTypes((await leaveMatch(read, held)).create);
  const { matched } = await leaveMatch(read, held);
  let nil = 0;
  const today = (await workspaceClock()).calendarDate(new Date());
  const year = await leaveYearOfDay(today);
  const half = (n: number) => Math.round(n * 2) / 2;
  const leaveRows: { userId: string; typeId: string; opening: number; usedBefore: number }[] = [];
  const users = await db.user.findMany({ where: { email: { in: r.people.filter(isActive).map((p) => emailOf(p)), mode: "insensitive" } }, select: { id: true, email: true } });
  const userOf = new Map(users.map((u) => [u.email.toLowerCase(), u.id]));
  for (const p of r.people.filter(isActive)) {
    const userId = userOf.get(emailOf(p).toLowerCase());
    if (!userId) continue;
    for (const [name, value] of Object.entries(read.leave.get(p.code) ?? {})) {
      const type = matched.get(name);
      if (!type) continue;
      await ensureBalance(userId, type.id, year, today);
      const b = await db.leaveBalance.findUnique({ where: { userId_typeId_year: { userId, typeId: type.id, year } }, omit: { ...TYPED_OPENING, usedBefore: false } });
      if (!b) continue;
      const own = Number(b.credited) + Number(b.adjustment) - (Number(b.used) - Number(b.usedBefore ?? 0));
      const gap = half(value - own);
      leaveRows.push({ userId, typeId: type.id, opening: Math.max(0, gap), usedBefore: Math.max(0, -gap) });
      if (value === 0) nil += 1;
    }
  }
  let leave: KredilyResult["leave"] = { saved: 0, nil: 0, error: null, typesMade };
  if (leaveRows.length) {
    const saved = await saveLeaveOpenings({ year, rows: leaveRows, note: "Brought from Kredily" });
    leave = saved.ok ? { saved: saved.data.saved, nil, error: null, typesMade } : { saved: 0, nil: 0, error: saved.error, typesMade };
  }

  // Pending claims: submitted and routed as any claim is (src/lib/expenses/route.ts), dated as Kredily had them; the same
  // claim brought twice is one. Each approver is told once, of all theirs, rather than once a claim.
  const userByCode = new Map<string, string>();
  for (const p of r.people.filter(isActive)) {
    const id = userOf.get(emailOf(p).toLowerCase());
    if (id) userByCode.set(p.code, id);
  }
  const routes = new Map<string, Awaited<ReturnType<typeof routeClaim>>>();
  const told = new Map<string, number>();
  const expenses: KredilyResult["expenses"] = { created: 0, skipped: 0, notHere: 0 };
  for (const e of read.expenses) {
    const userId = userByCode.get(e.code);
    const spentOn = calendarDayRange(e.spentOn, null)?.gte;
    if (!userId || !spentOn) {
      expenses.notHere += 1;
      continue;
    }
    const description = [e.category, e.description].filter(Boolean).join(" — ").slice(0, 500) || "Expense brought from Kredily";
    const amount = new Prisma.Decimal(e.amount);
    if (await db.expense.findFirst({ where: { userId, spentOn, amount, description }, select: { id: true } })) {
      expenses.skipped += 1;
      continue;
    }
    const route = routes.get(userId) ?? (await routeClaim(userId));
    routes.set(userId, route);
    await db.expense.create({ data: { userId, category: expenseCategory(e.category), amount, spentOn, description, status: "SUBMITTED", submittedAt: new Date(), ...route } });
    expenses.created += 1;
    if (route.approverUserId) told.set(route.approverUserId, (told.get(route.approverUserId) ?? 0) + 1);
  }
  for (const [approver, n] of told) {
    await notifyUser({
      userId: approver,
      type: "EXPENSE_SUBMITTED",
      title: `${n} expense claim${n === 1 ? "" : "s"} brought from Kredily need${n === 1 ? "s" : ""} your approval`,
      message: "Claims still pending in Kredily, now waiting in Deskzo.",
      link: "/expenses",
    });
  }

  const attendance = read.attendance ? await writeAttendance(read.attendance, input.withAbsent) : null;

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "Import",
    entityId: "kredily",
    entityLabel: `Brought people across from Kredily: ${accounts.created} accounts made, ${records.created + records.updated} records, ${pay.created + pay.updated} pay rows, ${leave.saved} leave balances (${leave.nil} at nil)${typesMade.length ? ` (${typesMade.length} leave types made)` : ""}, ${expenses.created} pending expense claims${attendance ? `, ${attendance.created} attendance days` : ""}`,
  });
  revalidatePath("/people");
  revalidatePath("/expenses");
  revalidatePath("/people/attendance");
  return { ok: true, data: { accounts, managers, records, pay, leave, expenses, attendance } };
}
