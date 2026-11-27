import type { Prisma } from "@deskzo/control-client";
import { db } from "@/lib/db";
import { entitledModuleKeys } from "@/lib/entitlements";
import { getModuleDefinition } from "@/lib/modules";
import { PEOPLE_ONLY } from "@/lib/people";
import { areaOf } from "@/lib/platform/adoption-areas";
import { controlDb } from "@/lib/platform/control-db";
import type { Tenant } from "@/lib/tenancy/state";
import { clockFor } from "@/lib/time/zone";

/**
 * What a workspace's people do, for the console's Adoption tab (owner, 23 Nov 2026: "can deskzo console admin see
 * performance of every workspace? user wise? module wise" — then "Counts only").
 *
 * Counted nightly by the platform tick, inside the workspace (src/lib/billing/reconcile.ts, `snapshotUsage`), from
 * what it already keeps: time on the app (the heartbeat's `UserDailyActivity`), sign-ins (`ActivityLog` LOGIN) and
 * records changed (`AuditLog`, by kind → area, src/lib/platform/adoption-areas.ts). Only numbers leave it: people are
 * numbered in the order their accounts were made, never named, and nothing of what a record says is read.
 *
 * Opening a page isn't logged, so "used" is time on the app, a sign-in or a change. The Automation and support
 * accounts aren't people (`PEOPLE_ONLY`), so neither counts.
 */

const DAY = 86_400_000;
/** How far back the first count reaches, and the most a missed stretch is filled in. */
export const ADOPTION_DAYS = 90;
const PERSON_DAYS = 30;

type AreaCount = { created: number; changed: number; removed: number; people: number };

const keyOf = (d: Date) => d.toISOString().slice(0, 10);
const dateOf = (key: string) => new Date(`${key}T00:00:00Z`);
const addDays = (key: string, n: number) => keyOf(new Date(dateOf(key).getTime() + n * DAY));

/** The modules in its plan and not switched off by the company. */
async function modulesOn(tenant: Tenant): Promise<string[]> {
  const off = new Set((await db.systemModule.findMany({ where: { enabled: false }, select: { key: true } })).map((r) => r.key));
  return entitledModuleKeys(tenant.entitlements, tenant.country).filter((key) => getModuleDefinition(key)?.core || !off.has(key));
}

/** Runs with the workspace's database current (inside `forEachTenant`). */
export async function snapshotAdoption(tenant: Tenant, now = new Date()): Promise<{ days: number; people: number }> {
  const control = controlDb();
  const clock = clockFor(tenant.timezone);
  const zone = clock.zone;
  const today = clock.today(now);
  const yesterday = addDays(today, -1);
  const earliest = addDays(today, -ADOPTION_DAYS);
  // From the last day counted (counted again — it may have been counted before it was over), or 90 days back.
  const last = await control.tenantActivityDay.findFirst({ where: { tenantId: tenant.id }, orderBy: { day: "desc" }, select: { day: true } });
  const lastKey = last ? keyOf(last.day) : null;
  const from = lastKey && lastKey > earliest ? lastKey : earliest;
  const personFrom = addDays(today, -(PERSON_DAYS - 1));
  const since = from < personFrom ? from : personFrom;
  // A day on the workspace's clock starts up to 14 hours before UTC's; the SQL keeps to its own days.
  const sinceInstant = new Date(dateOf(since).getTime() - 14 * 3_600_000);

  const [people, beats, lastBeats, logins, lastLogins, audits, on] = await Promise.all([
    db.user.findMany({ where: PEOPLE_ONLY, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, active: true } }),
    db.userDailyActivity.findMany({ where: { date: { gte: dateOf(since) } }, select: { userId: true, date: true, activeSeconds: true } }),
    db.userDailyActivity.groupBy({ by: ["userId"], _max: { date: true } }),
    db.$queryRaw<{ userId: string; day: string; n: number }[]>`
      SELECT "userId", (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${zone})::date::text AS day, count(*)::int AS n
      FROM "activity_logs" WHERE "kind" = 'LOGIN' AND "userId" IS NOT NULL AND "createdAt" >= ${sinceInstant}
      GROUP BY 1, 2`,
    db.$queryRaw<{ userId: string; at: Date }[]>`
      SELECT "userId", max("createdAt") AS at FROM "activity_logs" WHERE "kind" = 'LOGIN' AND "userId" IS NOT NULL GROUP BY 1`,
    db.$queryRaw<{ userId: string; day: string; kind: string; action: string; n: number }[]>`
      SELECT "userId", (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${zone})::date::text AS day, "entityType"::text AS kind, "action"::text AS action, count(*)::int AS n
      FROM "audit_logs" WHERE "createdAt" >= ${sinceInstant}
      GROUP BY 1, 2, 3, 4`,
    modulesOn(tenant),
  ]);
  const isPerson = new Set(people.map((p) => p.id));

  // ── Each day, from `from` to yesterday ──
  type Day = { active: Set<string>; signIns: number; seconds: number; changes: number; areas: Map<string, { created: number; changed: number; removed: number; people: Set<string> }> };
  const days = new Map<string, Day>();
  const dayOf = (key: string) => {
    let d = days.get(key);
    if (!d) days.set(key, (d = { active: new Set(), signIns: 0, seconds: 0, changes: 0, areas: new Map() }));
    return d;
  };
  for (const b of beats) {
    if (!isPerson.has(b.userId)) continue;
    const d = dayOf(keyOf(b.date));
    if (b.activeSeconds > 0) d.active.add(b.userId);
    d.seconds += b.activeSeconds;
  }
  for (const l of logins) {
    if (!isPerson.has(l.userId)) continue;
    const d = dayOf(l.day);
    d.active.add(l.userId);
    d.signIns += Number(l.n);
  }
  for (const a of audits) {
    if (!isPerson.has(a.userId)) continue;
    const d = dayOf(a.day);
    const n = Number(a.n);
    d.active.add(a.userId);
    d.changes += n;
    const area = areaOf(a.kind);
    let c = d.areas.get(area);
    if (!c) d.areas.set(area, (c = { created: 0, changed: 0, removed: 0, people: new Set() }));
    if (a.action === "CREATE") c.created += n;
    else if (a.action === "DELETE") c.removed += n;
    else c.changed += n;
    c.people.add(a.userId);
  }

  let written = 0;
  for (let key = from; key <= yesterday; key = addDays(key, 1)) {
    const d = days.get(key);
    const areas: Record<string, AreaCount> = {};
    for (const [area, c] of d?.areas ?? []) areas[area] = { created: c.created, changed: c.changed, removed: c.removed, people: c.people.size };
    const row = {
      activeUsers: d?.active.size ?? 0,
      signIns: d?.signIns ?? 0,
      activeMinutes: Math.round((d?.seconds ?? 0) / 60),
      changes: d?.changes ?? 0,
      areas: areas as Prisma.InputJsonObject,
      modulesOn: on,
      recordedAt: now,
    };
    await control.tenantActivityDay.upsert({ where: { tenantId_day: { tenantId: tenant.id, day: dateOf(key) } }, create: { tenantId: tenant.id, day: dateOf(key), ...row }, update: row });
    written++;
  }

  // ── Each person with a seat: the last 30 days, today so far included ──
  const lastSignIn = new Map(lastLogins.map((l) => [l.userId, l.at]));
  const lastBeat = new Map(lastBeats.map((b) => [b.userId, b._max.date ? keyOf(b._max.date) : null]));
  type Person = { days: Set<string>; seconds: number; changes: number; areas: Record<string, number>; lastDay: string | null };
  const recent = new Map<string, Person>();
  const personOf = (id: string) => {
    let p = recent.get(id);
    if (!p) recent.set(id, (p = { days: new Set(), seconds: 0, changes: 0, areas: {}, lastDay: null }));
    return p;
  };
  const seen = (p: Person, key: string) => {
    p.days.add(key);
    if (!p.lastDay || key > p.lastDay) p.lastDay = key;
  };
  for (const b of beats) {
    const key = keyOf(b.date);
    if (key < personFrom || b.activeSeconds <= 0) continue;
    const p = personOf(b.userId);
    seen(p, key);
    p.seconds += b.activeSeconds;
  }
  for (const l of logins) if (l.day >= personFrom) seen(personOf(l.userId), l.day);
  for (const a of audits) {
    if (a.day < personFrom) continue;
    const p = personOf(a.userId);
    seen(p, a.day);
    const n = Number(a.n);
    p.changes += n;
    const area = areaOf(a.kind);
    p.areas[area] = (p.areas[area] ?? 0) + n;
  }

  const rows = people.flatMap((person, i) => {
    if (!person.active) return [];
    const p = recent.get(person.id);
    const beat = lastBeat.get(person.id) ?? null;
    const lastDay = [p?.lastDay ?? null, beat].filter((k): k is string => !!k).sort().at(-1) ?? null;
    return [
      {
        tenantId: tenant.id,
        number: i + 1,
        lastSignInAt: lastSignIn.get(person.id) ?? null,
        lastActiveOn: lastDay ? dateOf(lastDay) : null,
        daysActive30: p?.days.size ?? 0,
        minutes30: Math.round((p?.seconds ?? 0) / 60),
        changes30: p?.changes ?? 0,
        areas30: (p?.areas ?? {}) as Prisma.InputJsonObject,
        recordedAt: now,
      },
    ];
  });
  await control.$transaction(async (tx) => {
    await tx.tenantPersonActivity.deleteMany({ where: { tenantId: tenant.id } });
    await tx.tenantPersonActivity.createMany({ data: rows });
  });
  return { days: written, people: rows.length };
}
