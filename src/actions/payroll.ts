"use server";

import { revalidatePath } from "next/cache";
import { plainError } from "@/lib/plain-error";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { isModuleEntitled, requireModuleAccess, requireModuleUser } from "@/lib/modules-access";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { isModuleEnabled } from "@/actions/module";
import { ensureChartOfAccounts, postPayrollPaymentToLedger, postPayrollToLedger, reversePayrollPosting } from "@/lib/ledger/journal";
import { payableForPayroll } from "@/actions/incentive";
import { attachToPayslips, releaseRunEarnings } from "@/lib/hr/incentive-payout";
import { hasEffectivePermission } from "@/actions/permission";
import { dateOnly, daysInMonth, monthLabel, monthRange } from "@/lib/hr/calendar";
import { lossOfPayDays } from "@/lib/hr/loss-of-pay";
import { hiddenFileIds, isFileHidden } from "@/lib/hr/file-visibility";
import { computePayslip, esiContributionPeriodStart, monthlyGross, monthlyStatutory, salaryPartsInMonth, type StatutoryFixed } from "@/lib/hr/payroll";
import { DEFAULT_SPLIT_RULES, STRUCTURE_EXTRAS_READ, componentsOfStructure, statutoryFixedOf, type ComponentDefault, type SplitRules } from "@/lib/hr/salary-split";
import { formatCalendarDay } from "@/lib/time/zone";
import { workOutTds } from "@/lib/hr/tds";
import { computeProfessionalTax, normaliseState, ptRuleFor, seniorCitizenIn } from "@/lib/hr/professional-tax";
import { alsoPaidBySettlement, payrollMonth, ptHistoryFor, settlementsRelyingOn, workStateOf } from "@/lib/hr/payroll-month";
import { GST_STATE_CODES } from "@/lib/gst-engine";
import { branchIdentity } from "@/lib/branches/identity";
import { payrollRunSchema, payslipAdjustSchema, salaryStructureSchema, taxDeclarationSchema } from "@/lib/validation/hr";
import { TAX_YEARS, taxYearOf } from "@/lib/hr/income-tax";
import { lockedRunFrom } from "@/lib/hr/salary-locks";
import { notMigratedYet } from "@/lib/not-migrated";
import { workspaceClock } from "@/lib/time/workspace";
import { owedLoans } from "@/lib/hr/loans";
import { monthStart, recoveriesFor } from "@/lib/hr/loan-rules";
import { refuseWhileViewingAs } from "@/lib/session";
import type { ActionResult } from "@/actions/company";

/**
 * Salary structures and the monthly payroll run.
 *
 * Everything here is behind a single permission, `payroll.manage`, with one exception: a person may
 * always read their own payslips. Pay is the most sensitive data in the app — not because it is
 * secret from the person it belongs to, but because it is nobody else's business.
 */

// Everything exported from this file must be an async function — a "use server" module publishes
// each export as an endpoint, and Next refuses a synchronous one outright. Pure helpers such as
// annualCtcOf stay in src/lib/hr/payroll.ts, where the client imports them directly.
const n = (value: Prisma.Decimal | Prisma.Decimal.Value | null | undefined) => Number(value ?? 0);
const dec = (value: number) => new Prisma.Decimal(value);

async function requirePayrollAccess() {
  const user = await requireModuleUser("payroll");
  const allowed = await hasEffectivePermission(user.id, "payroll.manage");
  return { user, allowed };
}

/**
 * `requirePayrollAccess` for the actions only Payroll's own pages use: Payroll open to the person as well. The actions other
 * screens use keep `requirePayrollAccess` alone (owner, 3 Nov 2026 — Phase 2 permission fixes, audit L-6).
 */
async function requirePayrollAccessIfOpen(...args: Parameters<typeof requirePayrollAccess>) {
  await requireModuleAccess("payroll");
  return requirePayrollAccess(...args);
}

/**
 * Security audit, 11 Nov 2026 (SEC-43): whoever runs payroll set their own salary (₹99 lakh, saved with nobody else
 * seeing) and could adjust their own payslip. Nobody sets or adjusts their own pay — somebody else in payroll does, as
 * with loans and settlements. Viewing as somebody, "own" would compare the borrowed person (SEC-19), so that is
 * refused too. Not exported: a "use server" export is an endpoint.
 */
async function ownPayRefusal(actorId: string, userId: string): Promise<string | null> {
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return viewingAs;
  return actorId === userId ? "Somebody else in payroll has to set or change your own pay." : null;
}

// ─── Salary structures ────────────────────────────────────────────────────────

/** What someone is on, newest first. Their own, or anyone's with the permission. */
export async function salaryHistory(userId: string) {
  const { user, allowed } = await requirePayrollAccess();
  if (!allowed && user.id !== userId) return [];
  const rows = await db.salaryStructure.findMany({
    where: { userId },
    orderBy: { effectiveFrom: "desc" },
    include: { createdBy: { select: { name: true } } },
    omit: STRUCTURE_EXTRAS_READ,
  });
  // The one they're on can be corrected in place until a locked month has paid from it (updateSalaryStructure).
  const editable = allowed && rows[0] ? !(await lockedRunFrom(rows[0].effectiveFrom)) : false;
  return toPlain(rows.map((row, i) => ({ ...row, editable: i === 0 && editable })));
}

/** The structure in force on a date — the newest one that had already started. */
async function structureOn(userId: string, on: Date) {
  return db.salaryStructure.findFirst({
    where: { userId, effectiveFrom: { lte: on } },
    orderBy: { effectiveFrom: "desc" },
    omit: STRUCTURE_EXTRAS_READ,
  });
}

/** Every structure that has taken effect by `on` — split into the month's parts by `salaryPartsInMonth`. */
async function structuresBy(userId: string, on: Date) {
  return db.salaryStructure.findMany({ where: { userId, effectiveFrom: { lte: on } }, orderBy: { effectiveFrom: "asc" }, omit: STRUCTURE_EXTRAS_READ });
}

// A structure as the engine takes it, the company's own components included (src/lib/hr/salary-split.ts).
const componentsOf = componentsOfStructure;

const BUILT_IN_NAMES = ["basic", "hra", "house rent allowance", "conveyance", "medical", "special allowance", "other allowance"];

/** The company's own components on a structure, checked: named once each, never as one of the six. */
function customComponentsOrRefusal(lines: { name: string; amount: number }[]): { ok: true; lines: { name: string; amount: number }[] } | { ok: false; error: string } {
  const seen = new Set<string>();
  const kept: { name: string; amount: number }[] = [];
  for (const line of lines) {
    const key = line.name.trim().toLowerCase();
    if (BUILT_IN_NAMES.includes(key)) return { ok: false, error: `“${line.name}” is one of the built-in components — enter it there.` };
    if (seen.has(key)) return { ok: false, error: `“${line.name}” is in the structure twice.` };
    seen.add(key);
    if (line.amount > 0) kept.push({ name: line.name.trim(), amount: Math.round(line.amount * 100) / 100 });
  }
  return { ok: true, lines: kept };
}

export async function saveSalaryStructure(input: unknown): Promise<ActionResult<{ id: string }>> {
  const { user, allowed } = await requirePayrollAccess();
  if (!allowed) return { ok: false, error: "You can't set salaries." };

  const parsed = salaryStructureSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;
  const own = await ownPayRefusal(user.id, data.userId);
  if (own) return { ok: false, error: own };

  const target = await db.user.findUnique({ where: { id: data.userId }, select: { name: true } });
  if (!target) return { ok: false, error: "That user no longer exists." };

  const effectiveFrom = dateOnly(data.effectiveFrom);

  // A second structure starting on the same day is almost certainly a double-submit, and having two
  // would make "which one applied in March" unanswerable.
  const clash = await db.salaryStructure.findFirst({
    where: { userId: data.userId, effectiveFrom },
    select: { id: true },
  });
  if (clash) return { ok: false, error: "There's already a structure starting on that date. Edit it, or pick another date." };

  // Refused rather than silently ignored: changing pay for a month already locked would make the
  // payslip disagree with the structure it claims to come from.
  const locked = await lockedRunFrom(effectiveFrom);
  if (locked) {
    return {
      ok: false,
      error: `Payroll for ${monthLabel(locked.month, locked.year)} is already locked. A structure starting on or before that month would contradict payslips already issued.`,
    };
  }

  const custom = customComponentsOrRefusal(data.customComponents);
  if (!custom.ok) return custom;
  const fixed = statutoryFixedOrRefusal(data, custom.lines);
  if (!fixed.ok) return fixed;
  const tdsBelow = await fixedTdsBelowRefusal(data, custom.lines, fixed.fixed);
  if (tdsBelow) return { ok: false, error: tdsBelow };

  const created = await db.salaryStructure.create({
    data: {
      userId: data.userId,
      effectiveFrom,
      ...structureFields(data, custom.lines, fixed.fixed),
      createdById: user.id,
    },
    select: { id: true },
  });

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "SalaryStructure",
    entityId: created.id,
    entityLabel: `Salary set for ${target.name} from ${data.effectiveFrom}${fixedWords(fixed.fixed, fixed.below)}`,
  });
  revalidatePath("/people/payroll");
  revalidatePath(`/people/${data.userId}`);
  return { ok: true, data: created };
}

type StructureInput = ReturnType<typeof salaryStructureSchema.parse>;

/**
 * PF, ESI and TDS fixed at the split (owner, 23 Oct 2026), kept only for a scheme that's on — and refused when
 * the person's own share and TDS would take more than the month's gross.
 */
function statutoryFixedOrRefusal(data: StructureInput, custom: { name: string; amount: number }[]): { ok: true; fixed: StatutoryFixed; below: string[] } | { ok: false; error: string } {
  const typed = data.statutoryFixed;
  const fixed: StatutoryFixed = {};
  if (data.pfApplicable) Object.assign(fixed, { pfEmployee: typed.pfEmployee, pfEmployer: typed.pfEmployer });
  if (data.esiApplicable) Object.assign(fixed, { esiEmployee: typed.esiEmployee, esiEmployer: typed.esiEmployer });
  fixed.tds = typed.tds;
  for (const key of Object.keys(fixed) as (keyof StatutoryFixed)[]) if (fixed[key] === undefined) delete fixed[key];

  const components = componentsOf({ ...data, customComponents: custom });
  const gross = monthlyGross(components);
  const own = monthlyStatutory(components, data, fixed);
  if (Object.keys(fixed).length && own.pfEmployee + own.esiEmployee + (fixed.tds ?? 0) > gross) {
    return { ok: false, error: "PF, ESI and TDS come to more than the monthly gross. Check the amounts fixed for them." };
  }
  // Security audit round three, 14 Nov 2026 (R3-14): a figure fixed below what the law asks for — PF at 12% of basic
  // up to the wage ceiling, ESI at its rates while covered — is under-deducting, and is taken only with the reason in
  // the note. Above it is the employer's choice and needs none.
  const statutory = monthlyStatutory(components, data, {});
  const rupees = (v: number) => `₹${v.toLocaleString("en-IN")}`;
  const below: string[] = [];
  for (const [key, label] of [["pfEmployee", "the employee's PF"], ["pfEmployer", "the employer's PF"], ["esiEmployee", "the employee's ESI"], ["esiEmployer", "the employer's ESI"]] as const) {
    const value = fixed[key];
    if (value !== undefined && value < statutory[key]) below.push(`${label} (${rupees(value)}, the law's ${rupees(statutory[key])})`);
  }
  if (below.length && !data.note?.trim()) {
    return { ok: false, error: `Fixed below the statutory figure: ${below.join("; ")}. Say why in the note, or leave it to Deskzo.` };
  }
  return { ok: true, fixed, below };
}

/**
 * R3-14: TDS fixed on a structure below what Deskzo works out for this month at that rate is under-deducting too —
 * taken only with the reason in the note. Nothing to compare in a tax year Deskzo has no rates for.
 */
async function fixedTdsBelowRefusal(data: StructureInput, custom: { name: string; amount: number }[], fixed: StatutoryFixed): Promise<string | null> {
  if (fixed.tds === undefined || data.note?.trim()) return null;
  const today = (await workspaceClock()).calendarDate(new Date());
  const profile = await db.employeeProfile.findUnique({ where: { userId: data.userId }, select: { joinedOn: true, exitedOn: true, dateOfBirth: true, gender: true, state: true } });
  const components = componentsOf({ ...data, customComponents: custom });
  const flags = { pfApplicable: data.pfApplicable, esiApplicable: data.esiApplicable, ptApplicable: data.ptApplicable };
  const own = monthlyStatutory(components, flags, fixed);
  const tds = await workOutTds({
    userId: data.userId,
    year: today.getUTCFullYear(),
    month: today.getUTCMonth() + 1,
    thisMonth: { gross: monthlyGross(components), pf: own.pfEmployee, pt: 0 },
    rate: { components, flags, fixed: { ...fixed, tds: undefined }, state: profile?.state ?? null, gender: profile?.gender ?? null },
    joinedOn: profile?.joinedOn ?? null,
    exitedOn: profile?.exitedOn ?? null,
    dateOfBirth: profile?.dateOfBirth ?? null,
  });
  if (!tds || tds.amount <= fixed.tds) return null;
  return `TDS fixed at ₹${fixed.tds.toLocaleString("en-IN")} a month is below the ₹${tds.amount.toLocaleString("en-IN")} Deskzo works out for this month. Say why in the note, or leave it to Deskzo.`;
}

/** How the audit trail says PF, ESI or TDS were fixed — which of them, never the amounts — and, R3-14, when below the law's. */
function fixedWords(fixed: StatutoryFixed, below: string[] = []) {
  const named = [fixed.pfEmployee !== undefined || fixed.pfEmployer !== undefined ? "PF" : null, fixed.esiEmployee !== undefined || fixed.esiEmployer !== undefined ? "ESI" : null, fixed.tds !== undefined ? "TDS" : null].filter(Boolean);
  return named.length ? ` (${named.join(", ")} fixed by hand${below.length ? ", below the statutory figure with a reason given" : ""})` : "";
}

/** What a structure saves, from the form — the six, the flags, the company's own components, and how it was given. */
function structureFields(data: StructureInput, custom: { name: string; amount: number }[], fixed: StatutoryFixed) {
  return {
    basic: dec(data.basic),
    hra: dec(data.hra),
    conveyance: dec(data.conveyance),
    medical: dec(data.medical),
    specialAllowance: dec(data.specialAllowance),
    otherAllowance: dec(data.otherAllowance),
    pfApplicable: data.pfApplicable,
    esiApplicable: data.esiApplicable,
    ptApplicable: data.ptApplicable,
    note: data.note?.trim() || null,
    customComponents: custom.length ? (custom as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    statutoryFixed: Object.keys(fixed).length ? (fixed as Prisma.InputJsonValue) : Prisma.DbNull,
    annualCtc: data.annualCtc !== undefined ? dec(data.annualCtc) : null,
    revisionBasis: data.revisionBasis ?? null,
    revisionValue: data.revisionBasis && data.revisionValue !== undefined ? dec(data.revisionValue) : null,
  };
}

/**
 * Changes a structure in place (owner, 21 Oct 2026: "HR can edit it") — the one somebody is on, while no
 * locked month has paid from it. One a locked or paid payslip came from is history: revise instead.
 */
export async function updateSalaryStructure(id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const { user, allowed } = await requirePayrollAccess();
  if (!allowed) return { ok: false, error: "You can't set salaries." };
  const parsed = salaryStructureSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  const existing = await db.salaryStructure.findUnique({ where: { id }, select: { userId: true, effectiveFrom: true, user: { select: { name: true } } } });
  if (!existing || existing.userId !== data.userId) return { ok: false, error: "That salary structure isn't there any more." };
  const own = await ownPayRefusal(user.id, existing.userId);
  if (own) return { ok: false, error: own };
  const effectiveFrom = dateOnly(data.effectiveFrom);
  // Neither the day it ran from nor the day it would run from may be in a locked month.
  for (const day of [existing.effectiveFrom, effectiveFrom]) {
    const locked = await lockedRunFrom(day);
    if (locked) {
      return {
        ok: false,
        error: `Payroll for ${monthLabel(locked.month, locked.year)} is locked and was paid from this structure. Revise the salary from a later date instead.`,
      };
    }
  }
  if (effectiveFrom.getTime() !== existing.effectiveFrom.getTime()) {
    const clash = await db.salaryStructure.findFirst({ where: { userId: data.userId, effectiveFrom, id: { not: id } }, select: { id: true } });
    if (clash) return { ok: false, error: "There's already a structure starting on that date." };
  }
  const custom = customComponentsOrRefusal(data.customComponents);
  if (!custom.ok) return custom;
  const fixed = statutoryFixedOrRefusal(data, custom.lines);
  if (!fixed.ok) return fixed;
  const tdsBelow = await fixedTdsBelowRefusal(data, custom.lines, fixed.fixed);
  if (tdsBelow) return { ok: false, error: tdsBelow };

  await db.salaryStructure.update({ where: { id }, data: { effectiveFrom, ...structureFields(data, custom.lines, fixed.fixed) } });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "SalaryStructure",
    entityId: id,
    entityLabel: `Salary from ${data.effectiveFrom} corrected for ${existing.user.name}${fixedWords(fixed.fixed, fixed.below)}`,
  });
  revalidatePath("/people/payroll");
  revalidatePath(`/people/${data.userId}`);
  return { ok: true, data: { id } };
}

// ─── How a CTC is split, and the company's own components ────────────────────────

/** The split rules, the defaults while nobody has set them, or null where the tables aren't there yet. */
async function splitRulesNow(): Promise<SplitRules | null> {
  try {
    const row = await db.salarySplitRules.findUnique({ where: { id: "global" } });
    return row
      ? { basicPercent: n(row.basicPercent), hraPercent: n(row.hraPercent), conveyance: n(row.conveyance), medical: n(row.medical) }
      : DEFAULT_SPLIT_RULES;
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

/**
 * What the salary dialog splits a CTC with (owner, 21 Oct 2026): the company's rules and its own active
 * components, with what a split starts each at. Whoever runs payroll; null otherwise.
 */
export async function salarySplitSetup(): Promise<{ rules: SplitRules; components: (ComponentDefault & { id: string })[]; migrated: boolean } | null> {
  const { allowed } = await requirePayrollAccess();
  if (!allowed) return null;
  const rules = await splitRulesNow();
  if (!rules) return { rules: DEFAULT_SPLIT_RULES, components: [], migrated: false };
  const rows = await db.salaryComponent.findMany({ where: { active: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  return { rules, components: rows.map((r) => ({ id: r.id, name: r.name, mode: r.mode, value: n(r.value) })), migrated: true };
}

/** Everything Settings › People › Salary structure shows: the rules, and every component, switched off too. */
export async function salarySetupForSettings() {
  const { allowed } = await requirePayrollAccess();
  if (!allowed) return null;
  const rules = await splitRulesNow();
  if (!rules) return null;
  const rows = await db.salaryComponent.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  return { rules, components: rows.map((r) => ({ id: r.id, name: r.name, mode: r.mode, value: n(r.value), active: r.active })) };
}

export async function saveSplitRules(input: SplitRules): Promise<ActionResult<null>> {
  const { user, allowed } = await requirePayrollAccess();
  if (!allowed) return { ok: false, error: "Only whoever runs payroll can change how a CTC is split." };
  const rules = {
    basicPercent: Number(input.basicPercent),
    hraPercent: Number(input.hraPercent),
    conveyance: Number(input.conveyance),
    medical: Number(input.medical),
  };
  if (!(rules.basicPercent > 0 && rules.basicPercent <= 100)) return { ok: false, error: "Basic is a percentage of the CTC above 0 and up to 100." };
  if (!(rules.hraPercent >= 0 && rules.hraPercent <= 100)) return { ok: false, error: "HRA is a percentage of basic from 0 to 100." };
  if (!(rules.conveyance >= 0 && rules.medical >= 0) || !Number.isFinite(rules.conveyance + rules.medical)) {
    return { ok: false, error: "Conveyance and medical are amounts a month, 0 or more." };
  }
  await db.salarySplitRules.upsert({
    where: { id: "global" },
    create: { id: "global", ...rules, updatedById: user.id },
    update: { ...rules, updatedById: user.id },
  });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "SalarySplitRules", entityId: "global", entityLabel: `CTC split: basic ${rules.basicPercent}%, HRA ${rules.hraPercent}% of basic` });
  revalidatePath("/settings/salary-structure");
  return { ok: true, data: null };
}

/** Adds or changes one of the company's own components. A name is one component, whatever its case. */
export async function saveSalaryComponent(input: { id?: string; name: string; mode: "FIXED" | "PERCENT_OF_BASIC"; value: number; active?: boolean }): Promise<ActionResult<{ id: string }>> {
  const { user, allowed } = await requirePayrollAccess();
  if (!allowed) return { ok: false, error: "Only whoever runs payroll can change the salary components." };
  const name = (input.name ?? "").trim().replace(/\s+/g, " ");
  if (!name) return { ok: false, error: "Name the component — “Food allowance”, say." };
  if (name.length > 40) return { ok: false, error: "Keep the name under 40 characters." };
  if (BUILT_IN_NAMES.includes(name.toLowerCase())) return { ok: false, error: `${name} is built in already.` };
  if (input.mode !== "FIXED" && input.mode !== "PERCENT_OF_BASIC") return { ok: false, error: "Choose a fixed amount or a percentage of basic." };
  const value = Number(input.value);
  if (!Number.isFinite(value) || value < 0 || (input.mode === "PERCENT_OF_BASIC" && value > 100)) {
    return { ok: false, error: input.mode === "PERCENT_OF_BASIC" ? "A percentage of basic from 0 to 100." : "An amount a month, 0 or more." };
  }
  const clash = await db.salaryComponent.findFirst({ where: { name: { equals: name, mode: "insensitive" }, ...(input.id ? { id: { not: input.id } } : {}) }, select: { id: true } });
  if (clash) return { ok: false, error: `There's already a component called ${name}.` };
  const data = { name, mode: input.mode, value: dec(value), ...(input.active !== undefined ? { active: input.active } : {}) };
  const row = input.id
    ? await db.salaryComponent.update({ where: { id: input.id }, data, select: { id: true } })
    : await db.salaryComponent.create({ data: { ...data, sortOrder: await db.salaryComponent.count() }, select: { id: true } });
  await recordAudit({ userId: user.id, action: input.id ? "UPDATE" : "CREATE", entityType: "SalaryComponent", entityId: row.id, entityLabel: `Salary component ${name}` });
  revalidatePath("/settings/salary-structure");
  return { ok: true, data: row };
}

/**
 * Removes one of the company's own components from the list. Structures that carry it keep it — they hold
 * its name and amount — so nobody's pay changes; it's only no longer offered.
 */
export async function deleteSalaryComponent(id: string): Promise<ActionResult<null>> {
  const { user, allowed } = await requirePayrollAccess();
  if (!allowed) return { ok: false, error: "Only whoever runs payroll can change the salary components." };
  const row = await db.salaryComponent.findUnique({ where: { id }, select: { name: true } });
  if (!row) return { ok: false, error: "That component isn't there any more." };
  await db.salaryComponent.delete({ where: { id } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "SalaryComponent", entityId: id, entityLabel: `Salary component ${row.name}` });
  revalidatePath("/settings/salary-structure");
  return { ok: true, data: null };
}

// ─── The monthly run ──────────────────────────────────────────────────────────

export async function listPayrollRuns() {
  const { allowed } = await requirePayrollAccessIfOpen();
  if (!allowed) return [];
  return toPlain(
    await db.payrollRun.findMany({
      orderBy: [{ year: "desc" }, { month: "desc" }],
      take: 24,
      include: { _count: { select: { payslips: true } } },
    }),
  );
}

/**
 * Builds (or rebuilds) a month's payslips from the structures and attendance in force.
 *
 * Re-runnable while the run is a draft, and deliberately so: attendance gets corrected right up to
 * the day payroll is cut, and the alternative is somebody editing figures by hand. Locking is what
 * makes it final.
 */
export async function runPayroll(input: unknown): Promise<ActionResult<{ id: string; count: number; skipped: string[] }>> {
  const { user, allowed } = await requirePayrollAccessIfOpen();
  if (!allowed) return { ok: false, error: "You can't run payroll." };

  const parsed = payrollRunSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { month, year } = parsed.data;

  const existing = await db.payrollRun.findUnique({ where: { month_year: { month, year } } });
  if (existing && existing.status !== "DRAFT") {
    return { ok: false, error: `${monthLabel(month, year)} is already ${existing.status.toLowerCase()} and can't be recalculated.` };
  }

  const { to } = monthRange(year, month);
  const monthDays = daysInMonth(year, month);

  // Anyone employed for part of the month at least, and for which days (src/lib/hr/payroll-month.ts).
  const { people, skipped } = await payrollMonth(year, month);

  // Professional tax follows the place of work (src/lib/hr/payroll.ts:101-103): the state of the branch
  // someone works at, for people whose branch is set. Nobody else changes — owner decision Q5, pending
  // the CA's C9. Each branch is resolved once, and never inside a transaction.
  const branchIds = [...new Set(people.map((p) => p.branchId).filter((id): id is string => Boolean(id)))];
  const workStates = new Map(
    await Promise.all(
      branchIds.map(async (id) => {
        const identity = await branchIdentity(id);
        return [id, identity.stateCode ? (GST_STATE_CODES[identity.stateCode] ?? null) : identity.state] as const;
      }),
    ),
  );

  const run =
    existing ??
    (await db.payrollRun.create({ data: { month, year, createdById: user.id } }));

  const slips: Prisma.PayslipCreateManyInput[] = [];

  // Read before anything is replaced. A manual deduction, and income tax wherever somebody typed it
  // over Deskzo's figure, were typed by whoever runs payroll, so a recalculation carries them across
  // rather than silently wipe them. Worked-out TDS is worked out again.
  const carried = new Map(
    (
      await db.payslip.findMany({
        where: { runId: run.id },
        select: { userId: true, incomeTax: true, incomeTaxBasis: true, otherDeduction: true, otherDeductionNote: true },
      })
    ).map((slip) => [slip.userId, slip]),
  );

  // Approved incentives waiting to go out with this month's salary. Paid through payroll rather
  // than separately, because performance pay is taxable salary and belongs on the payslip — paying
  // it outside would leave it off Form 16 and out of the PT and ESI computation.
  //
  // Only where the plan has Incentives: it is another module's action, and throws outside its plan
  // (src/lib/modules-access.ts requireModuleUser) — Deskzo People sells payroll without Incentives.
  // Earnings approved before a plan dropped Incentives stay approved and unpaid, never lost: the
  // month they are back in the plan, the next run pays them.
  // A recalculation takes this run's own earnings again too (R3-03): they are put back to approved below, with the
  // payslips they were on, and attached to the new ones.
  const incentives = (await isModuleEntitled("incentives")) ? await payableForPayroll(month, year, run.id) : [];
  const incentiveByUser = new Map<string, { total: number; ids: string[]; labels: string[] }>();
  for (const row of incentives) {
    const bucket = incentiveByUser.get(row.userId) ?? { total: 0, ids: [], labels: [] };
    bucket.total = Math.round((bucket.total + row.amount) * 100) / 100;
    bucket.ids.push(row.id);
    bucket.labels.push(row.label);
    incentiveByUser.set(row.userId, bucket);
  }

  // Professional tax looks back at this financial year's earlier payslips: Tamil Nadu charges on the
  // half-year's income, and nobody pays more than ₹2,500 a year (src/lib/hr/professional-tax.ts).
  const ptHistory = await ptHistoryFor(people.map((p) => p.id), year, month);

  // Loans and salary advances recovered from pay (owner, 31 Oct 2026 — src/lib/hr/loans.ts): what each still owes,
  // this run's own recoveries left out so it works them out afresh, and each payslip's share per loan.
  const owed = await owedLoans(people.map((p) => p.id), { exceptRun: run.id });
  const recoveriesByUser = new Map<string, { loanId: string; amount: number }[]>();

  for (const person of people) {
    const incentive = incentiveByUser.get(person.id)?.total ?? 0;
    // Their settlement pays this month's days. Nothing else to pay means no payslip; an approved
    // incentive still goes out here, on a payslip of no days, so it is taxed and marked paid like
    // anyone else's — a settlement has no line that would do either.
    if (person.salaryInSettlement && incentive <= 0) {
      skipped.push(`${person.name} — this month's salary is in their full and final settlement`);
      continue;
    }
    // The month by salary structure: a revision inside it pays each part at its own rate.
    const structures = await structuresBy(person.id, to);
    const salaryParts = salaryPartsInMonth(structures, year, month);
    const structure = salaryParts[salaryParts.length - 1]?.structure;
    if (!structure) {
      skipped.push(`${person.name} — no salary structure`);
      continue;
    }

    const lop = person.salaryInSettlement ? 0 : await lossOfPayDays(person.id, year, month, person.employment);
    // With a revision, the loss of pay is counted in each part's own days, so a day off is docked at
    // the rate it would have been paid at.
    const employed = person.employment;
    const parts =
      salaryParts.length > 1 && !person.salaryInSettlement
        ? await Promise.all(
            salaryParts.map(async (p) => {
              const firstDay = Math.max(p.firstDay, employed.firstDay);
              const lastDay = Math.min(p.lastDay, employed.lastDay);
              const lopDays = lastDay >= firstDay ? await lossOfPayDays(person.id, year, month, { firstDay, lastDay }) : 0;
              return { components: componentsOf(p.structure), firstDay: p.firstDay, lastDay: p.lastDay, lopDays };
            }),
          )
        : undefined;
    const backdated = salaryParts[0]?.backdated && employed.firstDay < salaryParts[0].structure.effectiveFrom.getUTCDate();
    const prior = carried.get(person.id);
    const flags = { pfApplicable: structure.pfApplicable, esiApplicable: structure.esiApplicable, ptApplicable: structure.ptApplicable };
    // PF, ESI and TDS fixed at the split, on the structure in force at the month's end — as the flags are.
    const fixed = statutoryFixedOf(structure.statutoryFixed);
    const workState = (person.branchId ? workStates.get(person.branchId) : null) ?? person.state ?? null;
    // ESI coverage is settled for a contribution period (April–September, October–March) by the rate at its start —
    // or at joining, for somebody who joined inside it (src/lib/hr/payroll.ts esiContributionPeriodStart).
    const esiPeriod = esiContributionPeriodStart(year, month);
    const periodFirstDay = new Date(Date.UTC(esiPeriod.year, esiPeriod.month - 1, 1));
    const coveredFrom = person.joinedOn && person.joinedOn > periodFirstDay ? person.joinedOn : periodFirstDay;
    const atPeriodStart = [...structures].reverse().find((s) => s.effectiveFrom <= coveredFrom) ?? structures[0];
    const slipInput = {
      esiPeriodRate: atPeriodStart ? monthlyGross(componentsOf(atPeriodStart)) : undefined,
      components: componentsOf(structure),
      parts,
      flags,
      fixed,
      monthDays,
      lopDays: lop,
      employment: person.employment,
      salaryInSettlement: person.salaryInSettlement,
      state: workState,
      gender: person.gender,
      ptHistory: ptHistory.get(person.id),
      seniorCitizen: seniorCitizenIn(person.dateOfBirth, month >= 4 ? year : year - 1),
      leavingThisMonth: person.leaving,
      month,
      year,
      incentive,
    };

    // TDS: a figure typed on this month's draft is kept — and so is one on a payslip from before Deskzo
    // worked it out (no basis), where every figure was typed. Then a monthly TDS fixed on the salary
    // structure, taken whole in a month that pays salary: it's the year's tax spread over its months, not
    // pay for time. Otherwise it's worked out from the tax year so far (src/lib/hr/tds.ts), on the payslip
    // as computed without it; then the payslip is computed again with it, since Punjab's development tax
    // follows income tax.
    const typed = !!prior && (prior.incomeTaxBasis === "TYPED" || (prior.incomeTaxBasis === null && n(prior.incomeTax) > 0));
    const fixedTds = !typed && fixed.tds !== undefined;
    let incomeTax = typed ? n(prior.incomeTax) : 0;
    let tds: Awaited<ReturnType<typeof workOutTds>> = null;
    let fixedTdsShort: string | null = null;
    if (fixedTds) {
      const first = computePayslip({ ...slipInput, incomeTax: 0, incomeTaxWorkedOut: true });
      const unpaid = first.paidDays <= 0;
      incomeTax = unpaid ? 0 : fixed.tds!;
      // Security audit round three, 14 Nov 2026 (R3-14): fixed below what the year works out to is under-deducting;
      // the payslip says so, so it is seen before the run is locked.
      if (!unpaid) {
        const due = await workOutTds({
          userId: person.id,
          year,
          month,
          thisMonth: { gross: first.grossEarnings, pf: first.pfEmployee, pt: first.professionalTax },
          rate: { components: componentsOf(structure), flags, fixed, state: workState, gender: person.gender },
          joinedOn: person.joinedOn,
          exitedOn: person.exitedOn,
          dateOfBirth: person.dateOfBirth,
        });
        if (due && due.amount > incomeTax) {
          fixedTdsShort = `TDS fixed on the salary structure (₹${incomeTax.toLocaleString("en-IN")}) is below the ₹${due.amount.toLocaleString("en-IN")} the tax year comes to this month — check it before locking.`;
        }
      }
    } else if (!typed) {
      const first = computePayslip({ ...slipInput, incomeTax: 0, incomeTaxWorkedOut: true });
      tds = await workOutTds({
        userId: person.id,
        year,
        month,
        thisMonth: { gross: first.grossEarnings, pf: first.pfEmployee, pt: first.professionalTax },
        rate: { components: componentsOf(structure), flags, fixed, state: workState, gender: person.gender },
        joinedOn: person.joinedOn,
        exitedOn: person.exitedOn,
        dateOfBirth: person.dateOfBirth,
      });
      incomeTax = tds?.amount ?? 0;
    }
    const result = computePayslip({ ...slipInput, incomeTax, incomeTaxWorkedOut: !!tds || fixedTds });
    const basis = typed ? ("TYPED" as const) : fixedTds ? ("FIXED" as const) : tds ? ("WORKED_OUT" as const) : null;
    if (!typed && !tds && !fixedTds && result.grossEarnings > 0) {
      result.warnings = [...result.warnings.filter((w) => !w.startsWith("No income tax entered")), "Deskzo doesn't work out TDS for this tax year — type it on the payslip."];
    }
    // Security audit round three, 14 Nov 2026 (low): a deduction typed on the draft is carried, but never past the
    // pay — a net below nothing used to drop the person out of the bank file without a word. What doesn't fit is
    // left for next month, and the payslip says so; statutory deductions alone above gross are flagged, and the run
    // can't be locked until they're corrected (setPayrollStatus).
    const statutoryAndTax = result.pfEmployee + result.esiEmployee + result.professionalTax + incomeTax;
    const typedOther = n(prior?.otherDeduction);
    const otherDeduction = Math.max(0, Math.min(typedOther, Math.round((result.grossEarnings - statutoryAndTax) * 100) / 100));
    const netNotes: string[] = [];
    if (otherDeduction < typedOther) {
      netNotes.push(`₹${(Math.round((typedOther - otherDeduction) * 100) / 100).toLocaleString("en-IN")} of the other deduction wasn't taken — it would have left the net pay below nothing. Recover it next month.`);
    }
    if (statutoryAndTax > result.grossEarnings) {
      netNotes.push("PF, ESI, professional tax and TDS come to more than the gross, so the net pay is negative. Correct the TDS before locking — a run can't be locked with a negative net.");
    }
    if (fixedTdsShort) netNotes.push(fixedTdsShort);
    const beforeLoans = statutoryAndTax + otherDeduction;
    // Instalments due this month, held to what the pay can bear after everything else.
    const recoveries = recoveriesFor(
      owed.filter((l) => l.userId === person.id).map((l) => ({ id: l.id, approved: true, disbursed: l.disbursed, firstMonth: l.firstMonth, instalmentAmount: l.instalmentAmount, outstanding: l.outstanding })),
      monthStart(year, month),
      result.grossEarnings - beforeLoans,
    );
    const loanRecovery = Math.round(recoveries.reduce((t, r) => t + r.amount, 0) * 100) / 100;
    if (recoveries.length > 0) recoveriesByUser.set(person.id, recoveries);
    const totalDeductions = beforeLoans + loanRecovery;

    slips.push({
      runId: run.id,
      userId: person.id,
      monthDays: dec(result.monthDays),
      paidDays: dec(result.paidDays),
      lopDays: dec(result.lopDays),
      basic: dec(result.components.basic),
      hra: dec(result.components.hra),
      conveyance: dec(result.components.conveyance),
      medical: dec(result.components.medical),
      specialAllowance: dec(result.components.specialAllowance),
      otherAllowance: dec(result.components.otherAllowance),
      // The company's own components, pro-rated like the six; written only where there are some, so a
      // workspace not migrated yet — which has none — writes what it always did.
      ...(result.components.custom?.length ? { customEarnings: result.components.custom as unknown as Prisma.InputJsonValue } : {}),
      incentive: dec(result.incentive),
      grossEarnings: dec(result.grossEarnings),
      pfEmployee: dec(result.pfEmployee),
      pfEmployer: dec(result.pfEmployer),
      esiEmployee: dec(result.esiEmployee),
      esiEmployer: dec(result.esiEmployer),
      professionalTax: dec(result.professionalTax),
      incomeTax: dec(incomeTax),
      incomeTaxBasis: basis,
      taxWorking: tds ? (tds as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      otherDeduction: dec(otherDeduction),
      otherDeductionNote: prior?.otherDeductionNote ?? null,
      // Written only where there is some, so a workspace not migrated yet writes what it always did.
      ...(loanRecovery > 0 ? { loanRecovery: dec(loanRecovery) } : {}),
      // The PF return's figures (src/lib/hr/statutory-files.ts) — written only with PF, as above.
      ...(result.pfWages > 0 ? { pfWages: dec(result.pfWages), epsWages: dec(result.epsWages), epsEmployer: dec(result.epsEmployer) } : {}),
      totalDeductions: dec(totalDeductions),
      netPay: dec(result.grossEarnings - totalDeductions),
      employerCost: dec(result.employerCost),
      note:
        [
          ...result.warnings,
          ...(tds?.warnings ?? []),
          ...netNotes,
          ...(backdated ? [`No salary structure before ${formatCalendarDay(salaryParts[0]!.structure.effectiveFrom)} — the days before it were paid at the one from that day.`] : []),
        ].join(" ") || null,
    });
  }

  // Replaced wholesale rather than reconciled row by row: a recalculation is a fresh answer to the
  // same question, and matching old rows to new ones would only create ways for the two to diverge.
  //
  // Security audit round three, 14 Nov 2026 (R3-03, R3-04): all of it in one transaction that first claims the run
  // while it is still a draft — a run locked meanwhile is left as it was locked, never rewritten under the lock. This
  // run's incentives go back to approved before its payslips go (the relation is SetNull: they were left "Paid" with
  // no payslip and never paid again), and are attached to the new payslips in the same transaction, so an earning is
  // never left between the two.
  const rewritten = await db.$transaction(async (tx) => {
    const claim = await tx.payrollRun.updateMany({ where: { id: run.id, status: "DRAFT" }, data: { updatedAt: new Date() } });
    if (claim.count === 0) return false;
    await releaseRunEarnings(run.id, tx);
    await tx.payslip.deleteMany({ where: { runId: run.id } });
    await tx.payslip.createMany({ data: slips });

    // Marked paid only for people who actually got a payslip.
    if (incentiveByUser.size > 0) {
      const written = await tx.payslip.findMany({
        where: { runId: run.id, userId: { in: [...incentiveByUser.keys()] } },
        select: { id: true, userId: true },
      });
      const pairs = written.flatMap((slip) =>
        (incentiveByUser.get(slip.userId)?.ids ?? []).map((earningId) => ({ earningId, payslipId: slip.id })),
      );
      if (pairs.length > 0) await attachToPayslips(pairs, tx);
    }

    // Each loan's share of a payslip's recovery, tied to the payslip — replaced with it on the next recalculation.
    if (recoveriesByUser.size > 0) {
      const written = await tx.payslip.findMany({ where: { runId: run.id, userId: { in: [...recoveriesByUser.keys()] } }, select: { id: true, userId: true } });
      const rows = written.flatMap((slip) =>
        (recoveriesByUser.get(slip.userId) ?? []).map((r) => ({ loanId: r.loanId, amount: dec(r.amount), on: monthStart(year, month), payslipId: slip.id })),
      );
      if (rows.length > 0) await tx.loanRepayment.createMany({ data: rows });
    }
    return true;
  }, { timeout: 60_000 });
  if (!rewritten) return { ok: false, error: `${monthLabel(month, year)} was locked a moment ago and can't be recalculated.` };

  await recordAudit({
    userId: user.id,
    action: existing ? "UPDATE" : "CREATE",
    entityType: "PayrollRun",
    entityId: run.id,
    entityLabel: `Payroll for ${monthLabel(month, year)} — ${slips.length} payslip(s)`,
  });
  revalidatePath("/people/payroll");
  return { ok: true, data: { id: run.id, count: slips.length, skipped } };
}

export async function getPayrollRun(
  id: string,
  filters?: { search?: string; departmentId?: string; sort?: string; flag?: string },
) {
  const { allowed } = await requirePayrollAccessIfOpen();
  if (!allowed) return null;

  // Sorting by net or by loss of pay is what a register is read for — "who is being paid least this
  // month and why" is one question, and scanning 200 alphabetical rows is not an answer to it.
  const orderBy =
    filters?.sort === "net"
      ? { netPay: "desc" as const }
      : filters?.sort === "lop"
        ? { lopDays: "desc" as const }
        : { user: { name: "asc" as const } };

  const run = await db.payrollRun.findUnique({
    where: { id },
    include: {
      lockedBy: { select: { name: true } },
      payslips: {
        where: {
          ...(filters?.flag === "lop" ? { lopDays: { gt: 0 } } : {}),
          ...(filters?.flag === "flagged" ? { note: { not: null } } : {}),
          ...(filters?.departmentId ? { user: { departmentId: filters.departmentId } } : {}),
          ...(filters?.search
            ? {
                user: {
                  OR: [
                    { name: { contains: filters.search, mode: "insensitive" as const } },
                    { employeeProfile: { employeeCode: { contains: filters.search, mode: "insensitive" as const } } },
                  ],
                },
              }
            : {}),
        },
        orderBy,
        omit: { incomeTaxBasis: false, taxWorking: false },
        include: { user: { select: { id: true, userSeq: true, name: true, employeeProfile: { select: { employeeCode: true, designation: true } } } } },
      },
    },
  });
  return run ? toPlain(run) : null;
}

/** The whole month regardless of filters, so the header totals describe the run and not the view. */
export async function payrollRunTotals(id: string) {
  const { allowed } = await requirePayrollAccessIfOpen();
  if (!allowed) return null;
  const agg = await db.payslip.aggregate({
    where: { runId: id },
    _sum: { grossEarnings: true, totalDeductions: true, netPay: true, employerCost: true },
    _count: { _all: true },
  });
  return {
    count: agg._count._all,
    gross: n(agg._sum.grossEarnings),
    deductions: n(agg._sum.totalDeductions),
    net: n(agg._sum.netPay),
    cost: n(agg._sum.employerCost),
  };
}

/** Hand-entered figures the engine deliberately does not compute. */
export async function adjustPayslip(input: unknown): Promise<ActionResult<null>> {
  const { user, allowed } = await requirePayrollAccessIfOpen();
  if (!allowed) return { ok: false, error: "You can't edit payslips." };

  const parsed = payslipAdjustSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  const slip = await db.payslip.findUnique({
    where: { id: data.id },
    omit: { incomeTaxBasis: false, taxWorking: false, loanRecovery: false },
    include: { run: { select: { status: true, month: true, year: true } }, user: { select: { name: true } } },
  });
  if (!slip) return { ok: false, error: "That payslip no longer exists." };
  const own = await ownPayRefusal(user.id, slip.userId);
  if (own) return { ok: false, error: own };
  if (slip.run.status !== "DRAFT") {
    return { ok: false, error: "That month is locked. A locked payslip is a record, not a draft." };
  }
  const state = await workStateOf(slip.userId);
  const { year, month } = slip.run;
  const monthEnd = monthRange(year, month).to;

  // TDS: worked out again on request; a figure changed from the one on the payslip is typed, and a
  // recalculation keeps it; the same figure saved again keeps whatever it was.
  let incomeTax = data.incomeTax;
  let incomeTaxBasis = slip.incomeTaxBasis;
  let taxWorking: Prisma.InputJsonValue | typeof Prisma.DbNull | undefined;
  if (data.workOutTax) {
    const structure = await structureOn(slip.userId, monthEnd);
    const profile = await db.employeeProfile.findUnique({ where: { userId: slip.userId }, select: { joinedOn: true, exitedOn: true, dateOfBirth: true, gender: true } });
    if (!structure) return { ok: false, error: "No salary structure on file, so there's no rate to work the year out on." };
    const tds = await workOutTds({
      userId: slip.userId,
      year,
      month,
      thisMonth: { gross: n(slip.grossEarnings), pf: n(slip.pfEmployee), pt: n(slip.professionalTax) },
      rate: {
        components: componentsOf(structure),
        flags: { pfApplicable: structure.pfApplicable, esiApplicable: structure.esiApplicable, ptApplicable: structure.ptApplicable },
        fixed: statutoryFixedOf(structure.statutoryFixed),
        state,
        gender: profile?.gender ?? null,
      },
      joinedOn: profile?.joinedOn ?? null,
      exitedOn: profile?.exitedOn ?? null,
      dateOfBirth: profile?.dateOfBirth ?? null,
    });
    if (!tds) return { ok: false, error: "Deskzo doesn't work out TDS for this tax year — type it." };
    incomeTax = tds.amount;
    incomeTaxBasis = "WORKED_OUT";
    taxWorking = tds as unknown as Prisma.InputJsonValue;
  } else if (Math.abs(data.incomeTax - n(slip.incomeTax)) >= 0.005) {
    incomeTaxBasis = "TYPED";
    taxWorking = Prisma.DbNull;
  }

  // Punjab's development tax follows income tax (src/lib/hr/professional-tax.ts): typing income tax in,
  // or taking it out, decides whether this payslip owes it. Every other state's stands as the run set it.
  let professionalTax = n(slip.professionalTax);
  const rule = state ? ptRuleFor(normaliseState(state), year, month) : null;
  if (rule?.rule.kind === "INCOME_TAX_PAYERS") {
    const structure = await structureOn(slip.userId, monthEnd);
    const history = (await ptHistoryFor([slip.userId], slip.run.year, slip.run.month)).get(slip.userId);
    const profile = await db.employeeProfile.findUnique({ where: { userId: slip.userId }, select: { dateOfBirth: true } });
    professionalTax = computeProfessionalTax({
      monthGross: n(slip.grossEarnings),
      state,
      month: slip.run.month,
      year: slip.run.year,
      applicable: structure?.ptApplicable ?? false,
      paidThisYear: history?.paidThisYear,
      deductsIncomeTax: incomeTax > 0,
      seniorCitizen: seniorCitizenIn(profile?.dateOfBirth, slip.run.month >= 4 ? slip.run.year : slip.run.year - 1),
    }).amount;
  }

  const statutory = n(slip.pfEmployee) + n(slip.esiEmployee) + professionalTax;
  // The loan instalments the run recovered stand: they are worked out from the loans, not typed here.
  const totalDeductions = statutory + incomeTax + data.otherDeduction + n(slip.loanRecovery);
  // Security audit round three, 14 Nov 2026 (low): a net below nothing used to be saved, and then dropped out of the
  // bank file without a word. Refused, saying how much too much.
  const net = Math.round((n(slip.grossEarnings) - totalDeductions) * 100) / 100;
  if (net < 0) {
    return {
      ok: false,
      error: `That takes ₹${Math.abs(net).toLocaleString("en-IN")} more than the gross of ₹${n(slip.grossEarnings).toLocaleString("en-IN")}. Lower the deduction and recover the rest next month.`,
    };
  }

  // R3-04: claimed while the run is still a draft, in the same transaction as the write — a lock that lands between
  // the check above and this write leaves the locked payslip as it was.
  const written = await db.$transaction(async (tx) => {
    const claim = await tx.payrollRun.updateMany({ where: { id: slip.runId, status: "DRAFT" }, data: { updatedAt: new Date() } });
    if (claim.count === 0) return false;
    await tx.payslip.update({
      where: { id: data.id },
      data: {
        professionalTax: dec(professionalTax),
        incomeTax: dec(incomeTax),
        incomeTaxBasis,
        ...(taxWorking !== undefined ? { taxWorking } : {}),
        otherDeduction: dec(data.otherDeduction),
        otherDeductionNote: data.otherDeductionNote?.trim() || null,
        totalDeductions: dec(totalDeductions),
        netPay: dec(net),
        note: data.note?.trim() || slip.note,
      },
    });
    return true;
  });
  if (!written) return { ok: false, error: "That month was locked a moment ago. A locked payslip is a record, not a draft." };

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Payslip",
    entityId: data.id,
    entityLabel: `Adjusted ${slip.user.name}'s payslip for ${monthLabel(slip.run.month, slip.run.year)}`,
  });
  revalidatePath("/people/payroll");
  return { ok: true, data: null };
}

/**
 * Locking, then marking paid.
 *
 * Locking is the point of no return, so it is its own deliberate step rather than a side effect of
 * anything else. After it, the payslips are a statement that has been made.
 */
/**
 * Security audit round three, 14 Nov 2026 (R3-04): the only ways a run moves. A paid run could be taken back to
 * locked, then to draft and recalculated — rewriting payslips already paid and dropping their TDS challan links —
 * because only paid→draft was refused. Paid is final: a correction to a paid month is made in a later month.
 */
const RUN_MOVES: Record<"DRAFT" | "LOCKED" | "PAID", readonly ("DRAFT" | "LOCKED" | "PAID")[]> = {
  DRAFT: ["LOCKED"],
  LOCKED: ["DRAFT", "PAID"],
  PAID: [],
};

/** Whether the bank copy on payslips (20261214100000_payslip_bank_copy) is in this workspace's database yet. */
async function payslipBankCopyMigrated(): Promise<boolean> {
  try {
    await db.payslip.findFirst({ select: { bankAccountNumber: true } });
    return true;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
}

/** How many of a run's payslips a TDS challan accounts for; nothing where challans aren't migrated yet. */
async function challanLinkedPayslips(runId: string): Promise<number> {
  try {
    return await db.tdsChallanLink.count({ where: { payslip: { runId } } });
  } catch (err) {
    if (notMigratedYet(err)) return 0;
    throw err;
  }
}

export async function setPayrollStatus(id: string, status: "LOCKED" | "PAID" | "DRAFT"): Promise<ActionResult<null>> {
  const { user, allowed } = await requirePayrollAccessIfOpen();
  if (!allowed) return { ok: false, error: "You can't change a payroll run." };
  if (status !== "DRAFT" && status !== "LOCKED" && status !== "PAID") return { ok: false, error: "Choose draft, locked or paid." };

  const run = await db.payrollRun.findUnique({ where: { id }, select: { status: true, month: true, year: true, _count: { select: { payslips: true } } } });
  if (!run) return { ok: false, error: "That run no longer exists." };

  if (run.status === status) return { ok: false, error: `${monthLabel(run.month, run.year)} is already ${status.toLowerCase()}.` };
  if (!RUN_MOVES[run.status].includes(status)) {
    return {
      ok: false,
      error:
        run.status === "PAID"
          ? "A run that has been paid stays paid. Correct anything in it through a later month's payroll."
          : "Lock the run before marking it paid.",
    };
  }

  if (status === "LOCKED" && run._count.payslips === 0) {
    return { ok: false, error: "There's nothing to lock — run the payroll first." };
  }
  // A run calculated before somebody's full and final settlement was made still pays them the month
  // the settlement pays too. Recalculating leaves them out (src/lib/hr/payroll-month.ts); locking
  // first would make the double payment a statement.
  if (status === "LOCKED" && run.status === "DRAFT") {
    const paidTwice = await alsoPaidBySettlement(id, run.year, run.month);
    if (paidTwice.length > 0) {
      return {
        ok: false,
        error: `${paidTwice.join(", ")} ${paidTwice.length === 1 ? "is" : "are"} also paid for ${monthLabel(run.month, run.year)} in a full and final settlement. Recalculate the run so it leaves them out, then lock it.`,
      };
    }
  }
  // A negative net can't be paid and fell out of the bank file unseen (security audit round three, low).
  if (status === "LOCKED") {
    const negative = await db.payslip.findMany({ where: { runId: id, netPay: { lt: 0 } }, select: { user: { select: { name: true } } } });
    if (negative.length > 0) {
      return {
        ok: false,
        error: `${negative.map((s) => s.user.name).join(", ")} ${negative.length === 1 ? "has" : "have"} a net pay below nothing. Correct the deductions on ${negative.length === 1 ? "that payslip" : "those payslips"}, then lock the run.`,
      };
    }
  }
  if (status === "DRAFT" && run.status === "LOCKED") {
    const relying = await settlementsRelyingOn(id, run.year, run.month);
    if (relying.length > 0) {
      return {
        ok: false,
        error: `${relying.join(", ")}'s full and final settlement is approved and leaves part of ${monthLabel(run.month, run.year)} to this run's payslip. Recalculating would pay those days to nobody — put the settlement back to draft first, and recalculate it once this run is locked again.`,
      };
    }
    // R3-04: TDS deposited against these payslips is in a challan; recalculating would drop the links.
    const challaned = await challanLinkedPayslips(id);
    if (challaned > 0) {
      return {
        ok: false,
        error: `${challaned} of ${monthLabel(run.month, run.year)}'s payslips are in a TDS challan already. Take them out of the challan before reopening the run.`,
      };
    }
  }

  // R3-04 and R3-11: the move is claimed from the status it was checked at, so two at once land once. Locking copies
  // each person's bank account onto their payslip, so the bank file pays the account that was locked. Reopening
  // reverses the run's wage entry in the same transaction — the books never keep figures the payslips no longer
  // have — and is refused when that month's books are closed.
  const bankCopy = status === "LOCKED" ? await payslipBankCopyMigrated() : false;
  let moved = false;
  try {
    moved = await db.$transaction(async (tx) => {
      const claim = await tx.payrollRun.updateMany({
        where: { id, status: run.status },
        data: {
          status,
          ...(status === "LOCKED" ? { lockedAt: new Date(), lockedById: user.id } : {}),
          ...(status === "PAID" ? { paidAt: new Date() } : {}),
          ...(status === "DRAFT" ? { lockedAt: null, lockedById: null } : {}),
        },
      });
      if (claim.count === 0) return false;
      if (bankCopy) {
        const slips = await tx.payslip.findMany({
          where: { runId: id },
          select: { id: true, user: { select: { name: true, employeeProfile: { select: { bankAccountNumber: true, bankIfsc: true, bankName: true } } } } },
        });
        for (const slip of slips) {
          const bank = slip.user.employeeProfile;
          await tx.payslip.update({
            where: { id: slip.id },
            data: { bankAccountNumber: bank?.bankAccountNumber ?? null, bankIfsc: bank?.bankIfsc ?? null, bankName: bank?.bankName ?? null, bankHolderName: slip.user.name },
          });
        }
      }
      if (status === "DRAFT") await reversePayrollPosting(tx, id, user.id);
      return true;
    }, { timeout: 60_000 });
  } catch (error) {
    return { ok: false, error: plainError(error, `${monthLabel(run.month, run.year)} couldn't be marked ${status.toLowerCase()}.`) };
  }
  if (!moved) return { ok: false, error: "The run changed a moment ago — refresh and look again." };

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "PayrollRun",
    entityId: id,
    entityLabel: `${monthLabel(run.month, run.year)} payroll marked ${status.toLowerCase()}`,
  });

  // Locking is when a run stops being a calculation and becomes a statement, so that is when it
  // reaches the books. A draft run is still being corrected, and a wage bill that moves after it has
  // been posted is how a P&L ends up disagreeing with the payslips behind it.
  let postingWarning: string | null = null;
  if (status === "LOCKED") postingWarning = await postPayrollRunToBooks(id, user.id);
  // And marking it paid is the net actually leaving the bank — a separate event on a separate day,
  // which is the whole reason salaries payable exists between the two.
  if (status === "PAID") postingWarning = await postPayrollPaymentToBooks(id, user.id);

  revalidatePath("/people/payroll");
  revalidatePath("/accounting/journal");
  if (postingWarning) {
    return { ok: false, error: `Marked ${status.toLowerCase()}, but it didn't reach the ledger: ${postingWarning}` };
  }
  return { ok: true, data: null };
}

/**
 * Books a locked run.
 *
 * Returns the problem rather than throwing it, for the same reason the expense posting does: a run
 * that did not post shows up on the unposted list and can be posted again, whereas a lock rolled
 * back because the chart was mid-edit leaves payslips nobody can issue.
 */
async function postPayrollRunToBooks(runId: string, userId: string): Promise<string | null> {
  if (!(await isModuleEnabled("accounting"))) return null;
  try {
    await ensureChartOfAccounts();
    await db.$transaction((tx) => postPayrollToLedger(tx, runId, userId));
    return null;
  } catch (error) {
    return plainError(error, "Could not post this run to the ledger.");
  }
}

async function postPayrollPaymentToBooks(runId: string, userId: string): Promise<string | null> {
  if (!(await isModuleEnabled("accounting"))) return null;
  try {
    await ensureChartOfAccounts();
    await db.$transaction(async (tx) => {
      // A run that was locked while accounting was switched off has no wage entry yet; without this
      // the payment would settle a liability that was never raised.
      await postPayrollToLedger(tx, runId, userId);
      await postPayrollPaymentToLedger(tx, runId, userId, new Date());
    });
    return null;
  } catch (error) {
    return plainError(error, "Could not post the salary payment to the ledger.");
  }
}

/** Runs the ledger never received — the list that makes the quiet failures above defensible. */
export async function unpostedPayrollRuns() {
  const { allowed } = await requirePayrollAccess();
  if (!allowed) return [];
  return toPlain(
    await db.payrollRun.findMany({
      where: {
        status: { in: ["LOCKED", "PAID"] },
        // A wage entry still standing — one reversed when the run was reopened (R3-04) doesn't count.
        journalEntries: { none: { source: "PAYROLL", reversesId: null, reversedBy: { is: null } } },
      },
      orderBy: [{ year: "desc" }, { month: "desc" }],
      select: { id: true, month: true, year: true, status: true, _count: { select: { payslips: true } } },
    }),
  );
}

/** Posts a run the ledger missed. */
export async function postPayrollRunToLedger(runId: string): Promise<ActionResult<null>> {
  const { user, allowed } = await requirePayrollAccess();
  if (!allowed) return { ok: false, error: "You can't post a payroll run." };
  const problem = await postPayrollRunToBooks(runId, user.id);
  revalidatePath("/people/payroll");
  revalidatePath("/accounting/journal");
  return problem ? { ok: false, error: problem } : { ok: true, data: null };
}

/** Somebody's own payslips — the one payroll read that needs no permission. */
// ─── Income tax declarations ──────────────────────────────────────────────────

const DECLARED = ["hraExemption", "section80C", "section80CCD1B", "section80D", "homeLoanInterest", "otherDeductions", "previousGross", "previousTds", "previousPt", "previousPf", "otherIncome", "otherTds"] as const;
export type TaxDeclarationView = { taxYear: number; regime: "NEW" | "OLD"; note: string | null; updatedAt: string | null } & Record<(typeof DECLARED)[number], number>;

/**
 * Somebody's income tax declarations — this tax year's and last year's, whichever Deskzo works TDS out
 * for — what TDS is worked out from (src/lib/hr/tds.ts). Payroll's to see and set; a person sees their
 * own.
 */
export async function taxDeclarations(userId: string): Promise<{ years: number[]; current: number; declarations: TaxDeclarationView[] } | null> {
  const { user, allowed } = await requirePayrollAccess();
  if (!allowed && user.id !== userId) return null;
  const today = (await workspaceClock()).calendarDate(new Date());
  const current = taxYearOf(today.getUTCFullYear(), today.getUTCMonth() + 1);
  const years = [current, current - 1].filter((y) => TAX_YEARS[y]);
  const rows = await db.taxDeclaration.findMany({ where: { userId, taxYear: { in: years } } });
  const declarations = years.map((taxYear) => {
    const row = rows.find((r) => r.taxYear === taxYear);
    return {
      taxYear,
      regime: row?.regime ?? ("NEW" as const),
      note: row?.note ?? null,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      ...(Object.fromEntries(DECLARED.map((k) => [k, n(row?.[k])])) as Record<(typeof DECLARED)[number], number>),
    };
  });
  return { years, current, declarations };
}

export async function saveTaxDeclaration(input: unknown): Promise<ActionResult<null>> {
  const { user, allowed } = await requirePayrollAccess();
  if (!allowed) return { ok: false, error: "You can't set income tax declarations." };
  const parsed = taxDeclarationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { userId, taxYear, regime, note, ...amounts } = parsed.data;
  // Security audit round three, 14 Nov 2026 (R3-12): a declaration decides how much TDS comes off pay — previous TDS
  // entered lowers it rupee for rupee — so nobody in payroll sets their own, as with salary (SEC-43), and never while
  // viewing as somebody.
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  if (user.id === userId) return { ok: false, error: "Somebody else in payroll has to set your own income tax declaration." };
  if (!TAX_YEARS[taxYear]) return { ok: false, error: "Deskzo doesn't work out TDS for that tax year." };
  const person = await db.user.findUnique({ where: { id: userId }, select: { name: true } });
  if (!person) return { ok: false, error: "That person no longer exists." };

  const data = { regime, note: note || null, updatedById: user.id, ...Object.fromEntries(DECLARED.map((k) => [k, dec(amounts[k])])) };
  await db.taxDeclaration.upsert({ where: { userId_taxYear: { userId, taxYear } }, create: { userId, taxYear, ...data }, update: data });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "TaxDeclaration",
    entityId: `${userId}:${taxYear}`,
    entityLabel: `Income tax declaration for ${person.name}, tax year ${taxYear}-${String((taxYear + 1) % 100).padStart(2, "0")} (${regime === "NEW" ? "new" : "old"} regime)`,
  });
  revalidatePath("/people");
  return { ok: true, data: null };
}

export async function myPayslips() {
  const user = await requireModuleUser("payroll");
  // One an admin has switched off in the file manager is kept from them here too (src/lib/hr/file-visibility.ts).
  const hidden = await hiddenFileIds(user.id, "PAYSLIP");
  return toPlain(
    await db.payslip.findMany({
      where: { userId: user.id, run: { status: { in: ["LOCKED", "PAID"] } }, ...(hidden.size ? { id: { notIn: [...hidden] } } : {}) },
      orderBy: [{ run: { year: "desc" } }, { run: { month: "desc" } }],
      include: { run: { select: { month: true, year: true, status: true, paidAt: true } } },
    }),
  );
}

/** One payslip, for the person it belongs to or for payroll. */
export async function getPayslip(id: string) {
  const user = await requireModuleUser("payroll");
  const slip = await db.payslip.findUnique({
    where: { id },
    omit: { incomeTaxBasis: false, taxWorking: false, customEarnings: false, loanRecovery: false },
    include: {
      run: { select: { month: true, year: true, status: true, paidAt: true } },
      user: {
        select: {
          id: true, name: true, email: true,
          employeeProfile: {
            select: { employeeCode: true, designation: true, panNumber: true, uanNumber: true, bankAccountNumber: true, joinedOn: true },
          },
        },
      },
    },
  });
  if (!slip) return null;
  const payroll = await hasEffectivePermission(user.id, "payroll.manage");
  if (slip.userId !== user.id && !payroll) return null;
  // Drafts are working figures — nobody but payroll should see one and think it is their pay.
  if (slip.run.status === "DRAFT" && slip.userId === user.id) return null;
  // Switched off for them in the file manager: theirs to read only once it's switched back on.
  if (slip.userId === user.id && !payroll && (await isFileHidden("PAYSLIP", slip.id))) return null;
  return toPlain(slip);
}
