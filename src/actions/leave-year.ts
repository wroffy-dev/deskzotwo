"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireModuleAccess } from "@/lib/modules-access";
import { recordAudit } from "@/lib/audit";
import { hasEffectivePermission } from "@/actions/permission";
import { refuseWhileViewingAs } from "@/lib/session";
import { workspaceClock } from "@/lib/time/workspace";
import { accruedTo } from "@/lib/hr/leave-balance";
import { leaveYearRules } from "@/lib/hr/leave-year-server";
import {
  LEAVE_YEAR_STARTS,
  changeLeaveYear,
  leaveYearLabel,
  leaveYearLastDay,
  leaveYearOf,
  leaveYearStartName,
  monthsInLeaveYear,
  startMonthOf,
  type LeaveYearChange,
  type LeaveYearRule,
  type LeaveYearStart,
} from "@/lib/hr/leave-year";
import type { ActionResult } from "@/actions/company";

/**
 * HR's leave year setting (owner, 18 Nov 2026): April to March or January to December. The rules and the changeover
 * are src/lib/hr/leave-year.ts; balances follow them in src/lib/hr/leave-balance.ts. `hr.manage`, like leave types.
 */

const day = (d: Date) => d.toISOString().slice(0, 10);

export type LeaveYearState = {
  start: LeaveYearStart;
  startName: string;
  currentLabel: string;
  /** A change made but not begun: the year on the new start, and when it begins. */
  pending: { start: LeaveYearStart; startName: string; from: string; changeoverLabel: string; changeoverMonths: number } | null;
};

export type LeaveYearPreview = {
  start: LeaveYearStart;
  startName: string;
  cancelsPending: boolean;
  changeoverLabel: string;
  changeoverFrom: string;
  changeoverTo: string;
  changeoverMonths: number;
  firstYearLabel: string;
  firstYearFrom: string;
  /** All-at-once balances in the changeover whose grant comes down to its months — and those that go below nothing. */
  shortened: number;
  belowNothing: { name: string; type: string; balance: number }[];
};

async function manager() {
  const user = await requireModuleAccess("hr");
  return (await hasEffectivePermission(user.id, "hr.manage")) ? user : null;
}

async function today() {
  return (await workspaceClock()).calendarDate(new Date());
}

/** The pending change in `rules`, if the year after the one running now starts differently from it. */
function pendingOf(rules: LeaveYearRule[], on: Date): LeaveYearState["pending"] {
  const current = leaveYearOf(on, rules);
  const next = rules.find((r) => r.fromYear > current);
  if (!next) return null;
  const changeoverYear = next.fromYear - 1;
  return {
    start: next.startMonth,
    startName: leaveYearStartName(next.startMonth),
    from: day(new Date(Date.UTC(next.fromYear, next.startMonth, 1))),
    changeoverLabel: leaveYearLabel(changeoverYear, rules),
    changeoverMonths: monthsInLeaveYear(changeoverYear, rules),
  };
}

export async function leaveYearState(): Promise<LeaveYearState | null> {
  if (!(await manager())) return null;
  const [rules, on] = await Promise.all([leaveYearRules(), today()]);
  const current = leaveYearOf(on, rules);
  const start = startMonthOf(current, rules);
  return { start, startName: leaveYearStartName(start), currentLabel: leaveYearLabel(current, rules), pending: pendingOf(rules, on) };
}

const isStart = (value: unknown): value is LeaveYearStart => (LEAVE_YEAR_STARTS as readonly unknown[]).includes(value);

/** What the change does, before it is saved. Changes nothing. */
async function previewOf(change: LeaveYearChange, start: LeaveYearStart): Promise<LeaveYearPreview> {
  const { rules, changeoverYear } = change;
  let shortened = 0;
  const belowNothing: LeaveYearPreview["belowNothing"] = [];
  if (!change.cancelsPending && change.changeoverMonths < 12) {
    // Only an all-at-once grant can already hold more than the changeover's months: a monthly one never ran ahead.
    const rows = await db.leaveBalance.findMany({
      where: { year: changeoverYear, type: { accrual: "ANNUAL" } },
      select: {
        opening: true,
        credited: true,
        adjustment: true,
        used: true,
        type: { select: { name: true, annualQuota: true, accrual: true } },
        user: { select: { name: true, employeeProfile: { select: { joinedOn: true, exitedOn: true } } } },
      },
    });
    const last = leaveYearLastDay(changeoverYear, rules);
    for (const r of rows) {
      const grant = accruedTo(r.type, changeoverYear, last, r.user.employeeProfile ?? undefined, rules);
      if (grant >= Number(r.credited)) continue;
      shortened += 1;
      const balance = Math.round((Number(r.opening) + grant + Number(r.adjustment) - Number(r.used)) * 100) / 100;
      if (balance < 0) belowNothing.push({ name: r.user.name, type: r.type.name, balance });
    }
  }
  return {
    start,
    startName: leaveYearStartName(start),
    cancelsPending: !!change.cancelsPending,
    changeoverLabel: leaveYearLabel(changeoverYear, rules),
    changeoverFrom: day(change.changeoverFrom),
    changeoverTo: day(change.changeoverTo),
    changeoverMonths: change.changeoverMonths,
    firstYearLabel: leaveYearLabel(change.firstYear, rules),
    firstYearFrom: day(change.firstYearFrom),
    shortened,
    belowNothing: belowNothing.sort((a, b) => a.balance - b.balance).slice(0, 50),
  };
}

export async function previewLeaveYear(start: unknown): Promise<ActionResult<LeaveYearPreview | null>> {
  if (!(await manager())) return { ok: false, error: "You can't change the leave year." };
  if (!isStart(start)) return { ok: false, error: "Pick April to March or January to December." };
  const [rules, on] = await Promise.all([leaveYearRules(), today()]);
  const change = changeLeaveYear(rules, start, on);
  return { ok: true, data: change ? await previewOf(change, start) : null };
}

export async function saveLeaveYear(start: unknown): Promise<ActionResult<LeaveYearPreview | null>> {
  const user = await manager();
  if (!user) return { ok: false, error: "You can't change the leave year." };
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  if (!isStart(start)) return { ok: false, error: "Pick April to March or January to December." };
  const [rules, on] = await Promise.all([leaveYearRules(), today()]);
  const change = changeLeaveYear(rules, start, on);
  if (!change) return { ok: true, data: null };
  const preview = await previewOf(change, start);
  const json = change.rules.map((r) => ({ fromYear: r.fromYear, startMonth: r.startMonth }));
  await db.leaveYearSettings.upsert({ where: { id: "global" }, create: { id: "global", rules: json, updatedById: user.id }, update: { rules: json, updatedById: user.id } });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "LeaveYearSettings",
    entityId: "global",
    entityLabel: change.cancelsPending
      ? `Leave year: the change not begun yet taken back — ${leaveYearStartName(start)} stays`
      : `Leave year: ${leaveYearStartName(start)} from ${preview.firstYearFrom}; ${preview.changeoverLabel} is the changeover (${preview.changeoverMonths} months)`,
  });
  for (const path of ["/people/holidays", "/people/leave", "/people/me"]) revalidatePath(path);
  return { ok: true, data: preview };
}
