"use server";

import { db, getTenantDb } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { PEOPLE_ONLY } from "@/lib/people";
import { toPlain } from "@/lib/serialize";
import { workspaceClock } from "@/lib/time/workspace";
import { buildScorecard, hasActivity, type ScorecardRow } from "@/lib/scorecard/compute";
import { scorecardWindow } from "@/lib/scorecard/rules";

export type ScorecardView = { rows: ScorecardRow[]; quiet: number; window: { key: string; label: string; fromDate: string; toDate: string } };

/**
 * Performance › Sales scorecard (owner, 31 Oct 2026): each active person's business, leads, renewals and calling over
 * a period, for whoever may see Performance (`performance.view`), as the Performance page is. People with nothing in
 * the period are left off unless asked for (`everyone`).
 */
export async function salesScorecard(params: { period?: string; from?: string; to?: string; everyone?: boolean }): Promise<ScorecardView | null> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "performance.view"))) return null;
  const clock = await workspaceClock();
  const window = scorecardWindow(clock.calendarDate(new Date()), params.period, params.from, params.to);
  const people = await db.user.findMany({ where: { active: true, ...PEOPLE_ONLY }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  const all = await buildScorecard(await getTenantDb(), people, window);
  const busy = all.filter(hasActivity);
  return toPlain({
    rows: params.everyone ? all : busy,
    quiet: all.length - busy.length,
    window: { key: window.key, label: window.label, fromDate: window.fromDate, toDate: window.toDate },
  });
}
