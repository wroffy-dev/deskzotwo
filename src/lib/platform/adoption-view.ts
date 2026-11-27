import { getModuleDefinition } from "@/lib/modules";
import { areaLabel, modulesOfArea, moduleIsCounted, SETUP_AREA } from "@/lib/platform/adoption-areas";
import { controlDb } from "@/lib/platform/control-db";
import { ConsoleRefused } from "@/lib/platform/refused";
import { clockFor } from "@/lib/time/zone";

/**
 * The console's Adoption tab and the Workspaces list's activity columns: what src/lib/platform/adoption.ts counted,
 * read from the control plane only. Counts only — people are numbered, never named.
 */

const DAY = 86_400_000;
const keyOf = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (key: string, n: number) => keyOf(new Date(new Date(`${key}T00:00:00Z`).getTime() + n * DAY));

export type AdoptionDay = { day: string; activeUsers: number; signIns: number; activeMinutes: number; changes: number };
export type AdoptionTrend = "rising" | "steady" | "dropping" | "quiet";
export type ModuleUse = {
  key: string;
  label: string;
  /** Changes in its areas over the last 30 days; null where none of its records are counted. */
  changes: number | null;
  people: number;
  state: "used" | "light" | "unused" | "uncounted";
};
export type AreaUse = { area: string; label: string; created: number; changed: number; removed: number; people: number };
export type PersonUse = {
  number: number;
  lastSignInAt: Date | null;
  lastActiveOn: string | null;
  daysActive30: number;
  minutes30: number;
  changes30: number;
  /** Their busiest areas over the 30 days, most first. */
  top: { label: string; changes: number }[];
};
export type AdoptionPanel = {
  days: AdoptionDay[];
  /** The workspace's own today, on its clock. */
  today: string;
  countedAt: Date | null;
  seats: number;
  active7: number;
  active30: number;
  neverActive: number;
  trend: AdoptionTrend;
  /** Average active people a day: the last 7 closed days, and the 7 before. */
  lastWeek: number;
  weekBefore: number;
  modules: ModuleUse[];
  areas: AreaUse[];
  people: PersonUse[];
};

/** Rising or dropping when the week moved by a fifth or more; quiet when nobody was active in either. */
export function trendOf(lastWeek: number, weekBefore: number): AdoptionTrend {
  if (lastWeek === 0 && weekBefore === 0) return "quiet";
  if (weekBefore === 0) return "rising";
  const change = (lastWeek - weekBefore) / weekBefore;
  return change >= 0.2 ? "rising" : change <= -0.2 ? "dropping" : "steady";
}

const averageOf = (days: AdoptionDay[], from: string, to: string) => {
  const inside = days.filter((d) => d.day >= from && d.day <= to);
  return inside.length ? inside.reduce((t, d) => t + d.activeUsers, 0) / 7 : 0;
};

type Areas = Record<string, { created?: number; changed?: number; removed?: number; people?: number }>;
const numberIn = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export async function workspaceAdoption(tenantId: string, now = new Date()): Promise<AdoptionPanel> {
  const control = controlDb();
  const tenant = await control.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
  if (!tenant) throw new ConsoleRefused("That workspace is gone.");
  const today = clockFor(tenant.timezone).today(now);
  const from = addDays(today, -90);
  const [rows, persons] = await Promise.all([
    control.tenantActivityDay.findMany({ where: { tenantId, day: { gte: new Date(`${from}T00:00:00Z`) } }, orderBy: { day: "asc" } }),
    control.tenantPersonActivity.findMany({ where: { tenantId }, orderBy: { number: "asc" } }),
  ]);
  const days: AdoptionDay[] = rows.map((r) => ({ day: keyOf(r.day), activeUsers: r.activeUsers, signIns: r.signIns, activeMinutes: r.activeMinutes, changes: r.changes }));

  const since = (n: number) => addDays(today, -(n - 1));
  const activeSince = (n: number) => persons.filter((p) => p.lastActiveOn && keyOf(p.lastActiveOn) >= since(n)).length;
  const yesterday = addDays(today, -1);
  const lastWeek = averageOf(days, addDays(yesterday, -6), yesterday);
  const weekBefore = averageOf(days, addDays(yesterday, -13), addDays(yesterday, -7));

  // Areas over the last 30 days: the days' counts added up; people from each person's own 30 days.
  const thirty = since(30);
  const areaTotals = new Map<string, { created: number; changed: number; removed: number }>();
  for (const r of rows) {
    if (keyOf(r.day) < thirty) continue;
    for (const [area, c] of Object.entries((r.areas ?? {}) as Areas)) {
      const t = areaTotals.get(area) ?? { created: 0, changed: 0, removed: 0 };
      t.created += numberIn(c?.created);
      t.changed += numberIn(c?.changed);
      t.removed += numberIn(c?.removed);
      areaTotals.set(area, t);
    }
  }
  const areaPeople = new Map<string, number>();
  for (const p of persons) for (const [area, n] of Object.entries((p.areas30 ?? {}) as Record<string, unknown>)) if (numberIn(n) > 0) areaPeople.set(area, (areaPeople.get(area) ?? 0) + 1);
  const areas: AreaUse[] = [...areaTotals]
    .map(([area, t]) => ({ area, label: areaLabel(area), ...t, people: areaPeople.get(area) ?? 0 }))
    .sort((a, b) => b.created + b.changed + b.removed - (a.created + a.changed + a.removed));

  // Each module switched on: its areas' changes. Setup isn't a module.
  const latest = rows.at(-1);
  const byModule = new Map<string, { changes: number; people: number }>();
  for (const a of areas) {
    if (a.area === SETUP_AREA) continue;
    for (const key of modulesOfArea(a.area)) {
      const m = byModule.get(key) ?? { changes: 0, people: 0 };
      m.changes += a.created + a.changed + a.removed;
      m.people = Math.max(m.people, a.people);
      byModule.set(key, m);
    }
  }
  const modules: ModuleUse[] = (latest?.modulesOn ?? [])
    .map((key): ModuleUse => {
      const label = getModuleDefinition(key)?.label ?? key;
      if (!moduleIsCounted(key)) return { key, label, changes: null, people: 0, state: "uncounted" };
      const m = byModule.get(key) ?? { changes: 0, people: 0 };
      return { key, label, changes: m.changes, people: m.people, state: m.changes === 0 ? "unused" : m.changes < 10 || m.people < 2 ? "light" : "used" };
    })
    .sort((a, b) => (b.changes ?? -1) - (a.changes ?? -1) || a.label.localeCompare(b.label));

  const people: PersonUse[] = persons.map((p) => ({
    number: p.number,
    lastSignInAt: p.lastSignInAt,
    lastActiveOn: p.lastActiveOn ? keyOf(p.lastActiveOn) : null,
    daysActive30: p.daysActive30,
    minutes30: p.minutes30,
    changes30: p.changes30,
    top: Object.entries((p.areas30 ?? {}) as Record<string, unknown>)
      .map(([area, n]) => ({ label: areaLabel(area), changes: numberIn(n) }))
      .filter((a) => a.changes > 0)
      .sort((a, b) => b.changes - a.changes)
      .slice(0, 3),
  }));

  return {
    days,
    today,
    countedAt: latest?.recordedAt ?? null,
    seats: persons.length,
    active7: activeSince(7),
    active30: activeSince(30),
    neverActive: persons.filter((p) => !p.lastActiveOn && !p.lastSignInAt).length,
    trend: trendOf(lastWeek, weekBefore),
    lastWeek,
    weekBefore,
    modules,
    areas,
    people,
  };
}

/** For the Workspaces list: each workspace's people active in the last 7 days, out of those with a seat. */
export async function activeThisWeek(tenantIds: string[], now = new Date()): Promise<Map<string, { active7: number; seats: number }>> {
  if (tenantIds.length === 0) return new Map();
  // Seven days on UTC's calendar is near enough for a list; the tab counts on the workspace's own clock.
  const cutoff = new Date(`${addDays(keyOf(now), -6)}T00:00:00Z`);
  const control = controlDb();
  const [seats, active] = await Promise.all([
    control.tenantPersonActivity.groupBy({ by: ["tenantId"], where: { tenantId: { in: tenantIds } }, _count: { _all: true } }),
    control.tenantPersonActivity.groupBy({ by: ["tenantId"], where: { tenantId: { in: tenantIds }, lastActiveOn: { gte: cutoff } }, _count: { _all: true } }),
  ]);
  const activeOf = new Map(active.map((a) => [a.tenantId, a._count._all]));
  return new Map(seats.map((s) => [s.tenantId, { active7: activeOf.get(s.tenantId) ?? 0, seats: s._count._all }]));
}
