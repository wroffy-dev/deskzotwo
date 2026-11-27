"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireModuleAccess } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { refuseWhileViewingAs } from "@/lib/session";
import { workspacePack } from "@/lib/country-pack";
import { workspaceClock } from "@/lib/time/workspace";
import { PEOPLE_ONLY } from "@/lib/people";
import { monthLabel } from "@/lib/hr/calendar";
import { buildSif } from "@/lib/uae/sif";
import { uaeGratuity, type Gratuity } from "@/lib/uae/gratuity";
import { addUaeLeaveTypes } from "@/lib/uae/leave";
import { WPS_BANKS, bankByRoutingCode, bankOfIban, uaeIban } from "@/lib/uae/wps-banks";
import { payFor, routingOf, uaeExpiries, uaeMonth, unpaidDaysBetween, type Expiry } from "@/lib/uae/payroll";
import type { ActionResult } from "@/actions/company";
import { isModuleEnabled } from "@/actions/module";
import { plainError } from "@/lib/plain-error";
import { ensureChartOfAccounts, postUaePayrollPaymentToLedger, postUaePayrollToLedger, reverseUaePayrollPosting } from "@/lib/ledger/journal";

/**
 * UAE payroll (owner, 15 Nov 2026 — src/lib/uae): the WPS setup, each person's UAE pay and papers, the monthly run and
 * its salary file, gratuity, UAE leave and document expiries. A UAE workspace's payroll page is this, not India's.
 * Payroll's module and `payroll.manage`, as India's; nobody sets their own pay or adjusts their own payslip (SEC-43).
 */

const PATH = "/people/payroll";
const NOT_UAE = "UAE payroll is for a workspace in the UAE.";
const NO_RIGHT = "Running payroll needs the payroll permission.";

async function payrollUser(): Promise<{ id: string } | string> {
  const user = await requireModuleAccess("payroll");
  if (workspacePack().country !== "AE") return NOT_UAE;
  if (!(await can(user.id, "payroll.manage"))) return NO_RIGHT;
  return user;
}

async function writer(): Promise<{ id: string } | string> {
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return viewingAs;
  return payrollUser();
}

const num = (v: unknown, max = 10_000_000): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : 0;
  return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n * 100) / 100 : null;
};
const text = (v: unknown, max = 60): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const day = (v: unknown): Date | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? new Date(`${v}T00:00:00Z`) : null);
const key = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");

// ─── The page ───────────────────────────────────────────────────────────────────────────────────────

export type UaePerson = {
  userId: string;
  name: string;
  code: string | null;
  joinedOn: string;
  exitedOn: string;
  mohrePersonId: string;
  iban: string;
  routingCode: string;
  bankName: string | null;
  basic: number;
  housing: number;
  transport: number;
  otherAllowance: number;
  passportNumber: string;
  passportExpiry: string;
  visaExpiry: string;
  emiratesId: string;
  emiratesIdExpiry: string;
  labourCardNumber: string;
  labourCardExpiry: string;
  insuranceExpiry: string;
};
export type UaeRunRow = { id: string; month: number; year: number; label: string; status: string; people: number; total: number };
export type UaeView = {
  setup: { establishmentId: string; payingRoutingCode: string; payingIban: string; employerReference: string };
  banks: { name: string; routingCode: string; top: boolean }[];
  people: UaePerson[];
  runs: UaeRunRow[];
  expiries: (Omit<Expiry, "on"> & { on: string })[];
  me: string;
};

export async function uaePayroll(): Promise<ActionResult<UaeView>> {
  const user = await payrollUser();
  if (typeof user === "string") return { ok: false, error: user };
  const clock = await workspaceClock();
  const [setup, rows, users, runs, expiries] = await Promise.all([
    db.uaeWpsSettings.findUnique({ where: { id: "global" } }),
    db.uaeEmployee.findMany(),
    db.user.findMany({ where: { ...PEOPLE_ONLY, OR: [{ active: true }, { employeeProfile: { exitedOn: { not: null } } }] }, select: { id: true, name: true, active: true, employeeProfile: { select: { employeeCode: true, joinedOn: true, exitedOn: true } } }, orderBy: { name: "asc" }, take: 2000 }),
    db.uaePayrollRun.findMany({ orderBy: [{ year: "desc" }, { month: "desc" }], take: 36, include: { payslips: { select: { net: true } } } }),
    uaeExpiries(clock.today()),
  ]);
  const byUser = new Map(rows.map((r) => [r.userId, r]));
  const people: UaePerson[] = users
    .filter((u) => u.active || byUser.has(u.id))
    .map((u) => {
      const r = byUser.get(u.id);
      const routing = r ? routingOf(r) : null;
      return {
        userId: u.id,
        name: u.name,
        code: u.employeeProfile?.employeeCode ?? null,
        joinedOn: key(u.employeeProfile?.joinedOn ?? null),
        exitedOn: key(u.employeeProfile?.exitedOn ?? null),
        mohrePersonId: r?.mohrePersonId ?? "",
        iban: r?.iban ?? "",
        routingCode: r?.routingCode ?? "",
        bankName: (routing ? bankByRoutingCode(routing)?.name : null) ?? bankOfIban(r?.iban)?.name ?? null,
        basic: Number(r?.basic ?? 0),
        housing: Number(r?.housing ?? 0),
        transport: Number(r?.transport ?? 0),
        otherAllowance: Number(r?.otherAllowance ?? 0),
        passportNumber: r?.passportNumber ?? "",
        passportExpiry: key(r?.passportExpiry ?? null),
        visaExpiry: key(r?.visaExpiry ?? null),
        emiratesId: r?.emiratesId ?? "",
        emiratesIdExpiry: key(r?.emiratesIdExpiry ?? null),
        labourCardNumber: r?.labourCardNumber ?? "",
        labourCardExpiry: key(r?.labourCardExpiry ?? null),
        insuranceExpiry: key(r?.insuranceExpiry ?? null),
      };
    });
  return {
    ok: true,
    data: {
      setup: { establishmentId: setup?.establishmentId ?? "", payingRoutingCode: setup?.payingRoutingCode ?? "", payingIban: setup?.payingIban ?? "", employerReference: setup?.employerReference ?? "" },
      banks: WPS_BANKS.map((b) => ({ name: b.name, routingCode: b.routingCode, top: !!b.top })),
      people,
      runs: runs.map((r) => ({ id: r.id, month: r.month, year: r.year, label: monthLabel(r.month, r.year), status: r.status, people: r.payslips.length, total: Math.round(r.payslips.reduce((t, p) => t + Number(p.net), 0) * 100) / 100 })),
      expiries: expiries.map((e) => ({ ...e, on: key(e.on) })),
      me: user.id,
    },
  };
}

// ─── Setup ──────────────────────────────────────────────────────────────────────────────────────────

export async function saveWpsSetup(input: { establishmentId: string; payingRoutingCode: string; payingIban: string; employerReference: string }): Promise<ActionResult<null>> {
  const user = await writer();
  if (typeof user === "string") return { ok: false, error: user };
  const establishmentId = (input?.establishmentId ?? "").replace(/\D/g, "");
  if (establishmentId.length > 13) return { ok: false, error: "The MOHRE establishment ID is up to 13 digits." };
  const routing = (input?.payingRoutingCode ?? "").trim();
  if (routing && !/^\d{9}$/.test(routing)) return { ok: false, error: "A WPS routing code is 9 digits." };
  const iban = text(input?.payingIban, 40);
  if (iban && !uaeIban(iban)) return { ok: false, error: "That isn't a valid UAE IBAN." };
  const data = { establishmentId: establishmentId || null, payingRoutingCode: routing || null, payingIban: iban ? uaeIban(iban) : null, employerReference: text(input?.employerReference, 35), updatedById: user.id };
  await db.uaeWpsSettings.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "UaeWpsSettings", entityId: "global", entityLabel: `WPS setup: ${bankByRoutingCode(routing)?.name ?? (routing || "no bank")}` });
  revalidatePath(PATH);
  return { ok: true, data: null };
}

export async function saveUaePerson(userId: string, input: Partial<Record<keyof UaePerson, unknown>>): Promise<ActionResult<null>> {
  const user = await writer();
  if (typeof user === "string") return { ok: false, error: user };
  if (typeof userId !== "string" || !userId) return { ok: false, error: "Pick somebody." };
  if (userId === user.id) return { ok: false, error: "Somebody else in payroll has to set or change your own pay." };
  const person = await db.user.findFirst({ where: { id: userId, ...PEOPLE_ONLY }, select: { name: true } });
  if (!person) return { ok: false, error: "That person isn't here." };
  const amounts = { basic: num(input.basic), housing: num(input.housing), transport: num(input.transport), otherAllowance: num(input.otherAllowance) };
  if (Object.values(amounts).some((v) => v === null)) return { ok: false, error: "Pay is in AED, 0 or more." };
  const mohre = typeof input.mohrePersonId === "string" ? input.mohrePersonId.replace(/\D/g, "") : "";
  if (mohre.length > 14) return { ok: false, error: "The MOHRE person ID is up to 14 digits." };
  const ibanRaw = text(input.iban, 40);
  const iban = ibanRaw ? uaeIban(ibanRaw) : null;
  if (ibanRaw && !iban) return { ok: false, error: "That isn't a valid UAE IBAN — AE, then 21 digits, with the check digits right." };
  const routing = typeof input.routingCode === "string" ? input.routingCode.trim() : "";
  if (routing && !/^\d{9}$/.test(routing)) return { ok: false, error: "A WPS routing code is 9 digits." };
  const dates = { passportExpiry: input.passportExpiry, visaExpiry: input.visaExpiry, emiratesIdExpiry: input.emiratesIdExpiry, labourCardExpiry: input.labourCardExpiry, insuranceExpiry: input.insuranceExpiry };
  for (const [k, v] of Object.entries(dates)) if (v && !day(v)) return { ok: false, error: `${k} isn't a date.` };
  const data = {
    basic: amounts.basic!,
    housing: amounts.housing!,
    transport: amounts.transport!,
    otherAllowance: amounts.otherAllowance!,
    mohrePersonId: mohre || null,
    iban,
    routingCode: routing || null,
    passportNumber: text(input.passportNumber, 20),
    emiratesId: text(input.emiratesId, 20),
    labourCardNumber: text(input.labourCardNumber, 20),
    passportExpiry: day(input.passportExpiry),
    visaExpiry: day(input.visaExpiry),
    emiratesIdExpiry: day(input.emiratesIdExpiry),
    labourCardExpiry: day(input.labourCardExpiry),
    insuranceExpiry: day(input.insuranceExpiry),
    updatedById: user.id,
  };
  await db.uaeEmployee.upsert({ where: { userId }, create: { userId, ...data }, update: data });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "UaeEmployee", entityId: userId, entityLabel: `UAE pay and papers for ${person.name}` });
  revalidatePath(PATH);
  return { ok: true, data: null };
}

export async function addUaeLeave(): Promise<ActionResult<string[]>> {
  const user = await writer();
  if (typeof user === "string") return { ok: false, error: user };
  const added = await addUaeLeaveTypes();
  if (added.length) await recordAudit({ userId: user.id, action: "CREATE", entityType: "LeaveType", entityId: "uae", entityLabel: `UAE leave types: ${added.join(", ")}` });
  revalidatePath("/people/leave");
  return { ok: true, data: added };
}

// ─── The monthly run ────────────────────────────────────────────────────────────────────────────────

export type UaeSlip = {
  id: string;
  userId: string;
  name: string;
  payStart: string;
  payEnd: string;
  monthDays: number;
  unpaidDays: number;
  monthly: number;
  overtime: number;
  bonus: number;
  deductions: number;
  fixed: number;
  net: number;
  bankName: string | null;
  missing: string[];
  note: string;
};

function missingFor(s: { mohrePersonId: string | null; iban: string | null; routingCode: string | null }): string[] {
  const out: string[] = [];
  if (!s.mohrePersonId) out.push("MOHRE person ID");
  if (!uaeIban(s.iban)) out.push("IBAN");
  if (!s.routingCode) out.push("bank routing code");
  return out;
}

export async function uaeRun(runId: string): Promise<ActionResult<{ id: string; label: string; status: string; slips: UaeSlip[]; total: number }>> {
  const user = await payrollUser();
  if (typeof user === "string") return { ok: false, error: user };
  const run = typeof runId === "string" ? await db.uaePayrollRun.findUnique({ where: { id: runId }, include: { payslips: { orderBy: { name: "asc" } } } }) : null;
  if (!run) return { ok: false, error: "That month isn't there." };
  const slips: UaeSlip[] = run.payslips.map((p) => ({
    id: p.id,
    userId: p.userId,
    name: p.name,
    payStart: key(p.payStart),
    payEnd: key(p.payEnd),
    monthDays: p.monthDays,
    unpaidDays: Number(p.unpaidDays),
    monthly: Number(p.basic) + Number(p.housing) + Number(p.transport) + Number(p.otherAllowance),
    overtime: Number(p.overtime),
    bonus: Number(p.bonus),
    deductions: Number(p.deductions),
    fixed: Number(p.fixed),
    net: Number(p.net),
    bankName: bankByRoutingCode(p.routingCode)?.name ?? null,
    missing: missingFor(p),
    note: p.note ?? "",
  }));
  return { ok: true, data: { id: run.id, label: monthLabel(run.month, run.year), status: run.status, slips, total: Math.round(slips.reduce((t, s) => t + s.net, 0) * 100) / 100 } };
}

/** Starts a month — or, for a draft, works it out again from today's pay and attendance, keeping what was typed. */
export async function startUaeRun(month: number, year: number): Promise<ActionResult<{ runId: string; skipped: string[] }>> {
  const user = await writer();
  if (typeof user === "string") return { ok: false, error: user };
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year) || year < 2020 || year > 2100) return { ok: false, error: "Pick a month." };
  const existing = await db.uaePayrollRun.findUnique({ where: { month_year: { month, year } }, include: { payslips: true } });
  if (existing && existing.status !== "DRAFT") return { ok: false, error: `${monthLabel(month, year)} is locked — unlock it to work it out again.` };
  const { slips, skipped } = await uaeMonth(year, month);
  const typed = new Map((existing?.payslips ?? []).map((p) => [p.userId, p]));
  const runId = await db.$transaction(async (tx) => {
    const run = existing ?? (await tx.uaePayrollRun.create({ data: { month, year, createdById: user.id }, select: { id: true } }));
    await tx.uaePayslip.deleteMany({ where: { runId: run.id } });
    for (const s of slips) {
      const before = typed.get(s.userId);
      const overtime = Number(before?.overtime ?? 0);
      const bonus = Number(before?.bonus ?? 0);
      const deductions = Number(before?.deductions ?? 0);
      const daysHere = Math.round((s.payEnd.getTime() - s.payStart.getTime()) / 86_400_000) + 1;
      const pay = payFor(s.components, { monthDays: s.monthDays, daysHere, unpaidDays: s.unpaidDays, deductions, overtime, bonus });
      await tx.uaePayslip.create({
        data: { runId: run.id, userId: s.userId, name: s.name, monthDays: s.monthDays, payStart: s.payStart, payEnd: s.payEnd, unpaidDays: s.unpaidDays, ...s.components, overtime, bonus, deductions, fixed: pay.fixed, net: pay.net, mohrePersonId: s.mohrePersonId, iban: s.iban, routingCode: s.routingCode, note: before?.note ?? null },
      });
    }
    return run.id;
  });
  await recordAudit({ userId: user.id, action: existing ? "UPDATE" : "CREATE", entityType: "UaePayrollRun", entityId: runId, entityLabel: `UAE payroll ${monthLabel(month, year)}: ${slips.length} people` });
  revalidatePath(PATH);
  return { ok: true, data: { runId, skipped } };
}

export async function adjustUaePayslip(id: string, input: { overtime: unknown; bonus: unknown; deductions: unknown; unpaidDays: unknown; note: unknown }): Promise<ActionResult<null>> {
  const user = await writer();
  if (typeof user === "string") return { ok: false, error: user };
  const slip = typeof id === "string" ? await db.uaePayslip.findUnique({ where: { id }, include: { run: { select: { status: true } } } }) : null;
  if (!slip) return { ok: false, error: "That payslip isn't there." };
  if (slip.run.status !== "DRAFT") return { ok: false, error: "This month is locked." };
  if (slip.userId === user.id) return { ok: false, error: "Somebody else in payroll has to change your own payslip." };
  const overtime = num(input.overtime);
  const bonus = num(input.bonus);
  const deductions = num(input.deductions);
  const daysHere = Math.round((slip.payEnd.getTime() - slip.payStart.getTime()) / 86_400_000) + 1;
  const unpaidDays = num(input.unpaidDays, daysHere);
  if (overtime === null || bonus === null || deductions === null) return { ok: false, error: "Amounts are in AED, 0 or more." };
  if (unpaidDays === null) return { ok: false, error: `Unpaid days are 0 to ${daysHere}.` };
  const components = { basic: Number(slip.basic), housing: Number(slip.housing), transport: Number(slip.transport), otherAllowance: Number(slip.otherAllowance) };
  const pay = payFor(components, { monthDays: slip.monthDays, daysHere, unpaidDays, deductions, overtime, bonus });
  await db.uaePayslip.update({ where: { id }, data: { overtime, bonus, deductions, unpaidDays, fixed: pay.fixed, net: pay.net, note: text(input.note, 200) } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "UaePayslip", entityId: id, entityLabel: `UAE payslip for ${slip.name}: AED ${pay.net.toFixed(2)}` });
  revalidatePath(PATH);
  return { ok: true, data: null };
}

/**
 * Locks a month — its wages reach the books (src/lib/ledger/journal.ts postUaePayrollToLedger) where Accounting is on —
 * or unlocks it, taking that entry back out. A paid month stays locked.
 */
export async function setUaeRunLocked(runId: string, locked: boolean): Promise<ActionResult<null>> {
  const user = await writer();
  if (typeof user === "string") return { ok: false, error: user };
  const run = typeof runId === "string" ? await db.uaePayrollRun.findUnique({ where: { id: runId }, include: { payslips: true } }) : null;
  if (!run) return { ok: false, error: "That month isn't there." };
  if (run.status === "PAID") return { ok: false, error: "This month is paid — it stays as it is." };
  if (locked && run.status !== "DRAFT") return { ok: true, data: null };
  if (!locked && run.status !== "LOCKED") return { ok: true, data: null };
  if (locked && run.payslips.some((p) => missingFor(p).length)) return { ok: false, error: "Some people are missing their MOHRE ID, IBAN or bank — fill them in and work the month out again first." };
  const books = await isModuleEnabled("accounting");
  try {
    if (books) await ensureChartOfAccounts();
    await db.$transaction(
      async (tx) => {
        await tx.uaePayrollRun.update({ where: { id: runId }, data: locked ? { status: "LOCKED", lockedAt: new Date(), lockedById: user.id } : { status: "DRAFT", lockedAt: null, lockedById: null } });
        if (books) {
          if (locked) await postUaePayrollToLedger(tx, runId, user.id);
          else await reverseUaePayrollPosting(tx, runId, user.id);
        }
      },
      { timeout: 60_000 },
    );
  } catch (error) {
    return { ok: false, error: plainError(error, `${monthLabel(run.month, run.year)} couldn't be ${locked ? "locked" : "unlocked"}.`) };
  }
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "UaePayrollRun", entityId: runId, entityLabel: `UAE payroll ${monthLabel(run.month, run.year)} ${locked ? "locked" : "unlocked"}` });
  revalidatePath(PATH);
  revalidatePath("/accounting/journal");
  return { ok: true, data: null };
}

/** The salaries have left the bank: the month is paid, and the payment reaches the books where Accounting is on. */
export async function markUaeRunPaid(runId: string, paidOn: string): Promise<ActionResult<null>> {
  const user = await writer();
  if (typeof user === "string") return { ok: false, error: user };
  const on = day(paidOn);
  if (!on) return { ok: false, error: "Pick the day the salaries were paid." };
  const run = typeof runId === "string" ? await db.uaePayrollRun.findUnique({ where: { id: runId } }) : null;
  if (!run) return { ok: false, error: "That month isn't there." };
  if (run.status !== "LOCKED") return { ok: false, error: run.status === "PAID" ? "This month is already paid." : "Lock the month first." };
  const books = await isModuleEnabled("accounting");
  try {
    if (books) await ensureChartOfAccounts();
    await db.$transaction(
      async (tx) => {
        const moved = await tx.uaePayrollRun.updateMany({ where: { id: runId, status: "LOCKED" }, data: { status: "PAID" } });
        if (moved.count !== 1) throw new Error("The month changed a moment ago — refresh and look again.");
        if (books) {
          // Locked while Accounting was off: the wages go in first, so the payment settles something.
          await postUaePayrollToLedger(tx, runId, user.id);
          await postUaePayrollPaymentToLedger(tx, runId, user.id, on);
        }
      },
      { timeout: 60_000 },
    );
  } catch (error) {
    return { ok: false, error: plainError(error, `${monthLabel(run.month, run.year)} couldn't be marked paid.`) };
  }
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "UaePayrollRun", entityId: runId, entityLabel: `UAE payroll ${monthLabel(run.month, run.year)} paid on ${paidOn}` });
  revalidatePath(PATH);
  revalidatePath("/accounting/journal");
  return { ok: true, data: null };
}

export async function deleteUaeRun(runId: string): Promise<ActionResult<null>> {
  const user = await writer();
  if (typeof user === "string") return { ok: false, error: user };
  const run = typeof runId === "string" ? await db.uaePayrollRun.findUnique({ where: { id: runId } }) : null;
  if (!run) return { ok: false, error: "That month isn't there." };
  if (run.status !== "DRAFT") return { ok: false, error: "Unlock the month before removing it." };
  await db.uaePayrollRun.delete({ where: { id: runId } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "UaePayrollRun", entityId: runId, entityLabel: `UAE payroll ${monthLabel(run.month, run.year)} removed` });
  revalidatePath(PATH);
  return { ok: true, data: null };
}

/** The WPS salary file for a locked month — every problem listed when it can't be made. */
export async function uaeSalaryFile(runId: string): Promise<ActionResult<{ fileName: string; content: string; total: number }>> {
  const user = await payrollUser();
  if (typeof user === "string") return { ok: false, error: user };
  const run = typeof runId === "string" ? await db.uaePayrollRun.findUnique({ where: { id: runId }, include: { payslips: { orderBy: { name: "asc" } } } }) : null;
  if (!run) return { ok: false, error: "That month isn't there." };
  if (run.status === "DRAFT") return { ok: false, error: "Lock the month first, so the file and the payslips agree." };
  const setup = await db.uaeWpsSettings.findUnique({ where: { id: "global" } });
  const clock = await workspaceClock();
  const now = clock.parts(new Date());
  const built = buildSif({
    establishmentId: setup?.establishmentId ?? "",
    employerRoutingCode: setup?.payingRoutingCode ?? "",
    month: run.month,
    year: run.year,
    created: { year: now.year, month: now.month + 1, day: now.day, hour: now.hour, minute: now.minute, second: now.second },
    reference: setup?.employerReference,
    lines: run.payslips
      .filter((p) => Number(p.net) > 0)
      .map((p) => ({ name: p.name, personId: p.mohrePersonId ?? "", routingCode: p.routingCode ?? "", iban: p.iban ?? "", payStart: key(p.payStart), payEnd: key(p.payEnd), fixed: Number(p.fixed), overtime: Number(p.overtime), otherVariable: Number(p.bonus), unpaidDays: Number(p.unpaidDays) })),
  });
  if (!built.ok) return { ok: false, error: built.problems.join(" · ") };
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "UaePayrollRun", entityId: run.id, entityLabel: `WPS salary file ${built.fileName}: AED ${built.total.toFixed(2)}` });
  return { ok: true, data: { fileName: built.fileName, content: built.content, total: built.total } };
}

// ─── Gratuity ───────────────────────────────────────────────────────────────────────────────────────

export async function uaeGratuityFor(userId: string, lastDay: string): Promise<ActionResult<Gratuity & { basic: number; joinedOn: string; unpaidDays: number }>> {
  const user = await payrollUser();
  if (typeof user === "string") return { ok: false, error: user };
  const last = day(lastDay);
  if (!last) return { ok: false, error: "Pick the last working day." };
  const [row, profile] = typeof userId === "string" ? await Promise.all([db.uaeEmployee.findUnique({ where: { userId } }), db.employeeProfile.findUnique({ where: { userId }, select: { joinedOn: true } })]) : [null, null];
  if (!row || Number(row.basic) <= 0) return { ok: false, error: "Set their basic pay first." };
  if (!profile?.joinedOn) return { ok: false, error: "Their joining day isn't on their profile." };
  if (last < profile.joinedOn) return { ok: false, error: "The last day is before they joined." };
  const unpaidDays = await unpaidDaysBetween(userId, profile.joinedOn, last);
  const g = uaeGratuity({ basicMonthly: Number(row.basic), joinedOn: profile.joinedOn, lastDay: last, unpaidDays });
  return { ok: true, data: { ...g, basic: Number(row.basic), joinedOn: key(profile.joinedOn), unpaidDays } };
}

/** A person's own UAE payslips, from locked months — for everybody, not only payroll. */
export async function myUaePayslips(): Promise<{ id: string; label: string; fixed: number; overtime: number; bonus: number; deductions: number; unpaidDays: number; net: number }[]> {
  const user = await requireModuleAccess("payroll");
  if (workspacePack().country !== "AE") return [];
  const slips = await db.uaePayslip.findMany({ where: { userId: user.id, run: { status: { in: ["LOCKED", "PAID"] } } }, include: { run: { select: { month: true, year: true } } }, orderBy: [{ run: { year: "desc" } }, { run: { month: "desc" } }], take: 24 });
  return slips.map((p) => ({ id: p.id, label: monthLabel(p.run.month, p.run.year), fixed: Number(p.fixed), overtime: Number(p.overtime), bonus: Number(p.bonus), deductions: Number(p.deductions), unpaidDays: Number(p.unpaidDays), net: Number(p.net) }));
}

export type UaePayslipDoc = {
  id: string;
  month: number;
  year: number;
  status: string;
  name: string;
  employeeCode: string | null;
  designation: string | null;
  joinedOn: string;
  mohrePersonId: string | null;
  ibanLast4: string | null;
  bankName: string | null;
  payStart: string;
  payEnd: string;
  monthDays: number;
  unpaidDays: number;
  basic: number;
  housing: number;
  transport: number;
  otherAllowance: number;
  overtime: number;
  bonus: number;
  deductions: number;
  fixed: number;
  net: number;
  note: string | null;
};

/**
 * One UAE payslip, for its printed page (src/app/(print)/payslips/uae/[id]/print): the person it's for, once the month
 * is locked, or whoever runs payroll — anybody else, or a draft to its owner, is nothing.
 */
export async function getUaePayslip(id: string): Promise<UaePayslipDoc | null> {
  const user = await requireModuleAccess("payroll");
  if (workspacePack().country !== "AE" || typeof id !== "string") return null;
  const p = await db.uaePayslip.findUnique({ where: { id }, include: { run: { select: { month: true, year: true, status: true } } } });
  if (!p) return null;
  const mine = p.userId === user.id && p.run.status !== "DRAFT";
  if (!mine && !(await can(user.id, "payroll.manage"))) return null;
  const profile = await db.employeeProfile.findUnique({ where: { userId: p.userId }, select: { employeeCode: true, designation: true, joinedOn: true } });
  return {
    id: p.id,
    month: p.run.month,
    year: p.run.year,
    status: p.run.status,
    name: p.name,
    employeeCode: profile?.employeeCode ?? null,
    designation: profile?.designation ?? null,
    joinedOn: key(profile?.joinedOn ?? null),
    mohrePersonId: p.mohrePersonId,
    ibanLast4: p.iban ? p.iban.slice(-4) : null,
    bankName: bankByRoutingCode(p.routingCode)?.name ?? null,
    payStart: key(p.payStart),
    payEnd: key(p.payEnd),
    monthDays: p.monthDays,
    unpaidDays: Number(p.unpaidDays),
    basic: Number(p.basic),
    housing: Number(p.housing),
    transport: Number(p.transport),
    otherAllowance: Number(p.otherAllowance),
    overtime: Number(p.overtime),
    bonus: Number(p.bonus),
    deductions: Number(p.deductions),
    fixed: Number(p.fixed),
    net: Number(p.net),
    note: p.note,
  };
}
