import { db } from "@/lib/db";

/**
 * UAE leave (owner, 15 Nov 2026), as the Labour Law (Federal Decree-Law 33 of 2021, Arts. 29–32) gives it — added to
 * the workspace's leave types at a click, never over one already there. Half-pay types end in _HALF: UAE payroll
 * counts each of their days as half a day unpaid (src/lib/uae/payroll.ts).
 *
 *   Annual 30 days a year (2 a month between six months and a year — the leave screen's own accrual covers it);
 *   sick 90 a year — 15 full pay, 30 half pay, 45 unpaid; maternity 60 — 45 full, 15 half; parental 5;
 *   bereavement 5 (a spouse) or 3 (a parent, child, brother or sister…); study 10 for two years' service.
 */
export const UAE_LEAVE_TYPES = [
  { code: "UAE_ANNUAL", name: "Annual leave", annualQuota: 30, paid: true, carryForward: true, encashable: true, proofAfterDays: null, colour: "#2563eb" },
  { code: "UAE_SICK", name: "Sick leave (full pay)", annualQuota: 15, paid: true, carryForward: false, encashable: false, proofAfterDays: 1, colour: "#dc2626" },
  { code: "UAE_SICK_HALF", name: "Sick leave (half pay)", annualQuota: 30, paid: true, carryForward: false, encashable: false, proofAfterDays: 1, colour: "#f97316" },
  { code: "UAE_SICK_UNPAID", name: "Sick leave (unpaid)", annualQuota: 45, paid: false, carryForward: false, encashable: false, proofAfterDays: 1, colour: "#9ca3af" },
  { code: "UAE_MATERNITY", name: "Maternity leave (full pay)", annualQuota: 45, paid: true, carryForward: false, encashable: false, proofAfterDays: null, colour: "#db2777" },
  { code: "UAE_MATERNITY_HALF", name: "Maternity leave (half pay)", annualQuota: 15, paid: true, carryForward: false, encashable: false, proofAfterDays: null, colour: "#f472b6" },
  { code: "UAE_PARENTAL", name: "Parental leave", annualQuota: 5, paid: true, carryForward: false, encashable: false, proofAfterDays: null, colour: "#7c3aed" },
  { code: "UAE_BEREAVEMENT", name: "Bereavement leave", annualQuota: 5, paid: true, carryForward: false, encashable: false, proofAfterDays: null, colour: "#475569" },
  { code: "UAE_STUDY", name: "Study leave", annualQuota: 10, paid: true, carryForward: false, encashable: false, proofAfterDays: null, colour: "#0d9488" },
] as const;

/** Adds the UAE types that aren't there yet; returns the names added. */
export async function addUaeLeaveTypes(): Promise<string[]> {
  const have = new Set((await db.leaveType.findMany({ where: { code: { in: UAE_LEAVE_TYPES.map((t) => t.code) } }, select: { code: true } })).map((t) => t.code));
  const last = await db.leaveType.aggregate({ _max: { sortOrder: true } });
  let order = (last._max.sortOrder ?? 0) + 1;
  const added: string[] = [];
  for (const t of UAE_LEAVE_TYPES) {
    if (have.has(t.code)) continue;
    await db.leaveType.create({ data: { code: t.code, name: t.name, annualQuota: t.annualQuota, accrual: "ANNUAL", paid: t.paid, carryForward: t.carryForward, encashable: t.encashable, proofAfterDays: t.proofAfterDays, colour: t.colour, sortOrder: order++ } });
    added.push(t.name);
  }
  return added;
}
