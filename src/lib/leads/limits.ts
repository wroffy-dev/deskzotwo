import type { LeadStatus, Prisma, PrismaClient } from "@prisma/client";
import { db as defaultDb } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { workspaceClock } from "@/lib/time/workspace";
import type { Clock } from "@/lib/time/zone";
import { currentTenantOrNull } from "@/lib/tenancy/resolve";
import { MEANINGS, isClosed } from "@/lib/pipeline/rules";

/**
 * Lead limits: the one place they are decided (owner, 12 Nov 2026 — Phase 4 lead limits, audit H.6).
 *
 * ## What may be limited
 *
 *   · A person's **open leads** (`maxOpen`): leads they own whose stage isn't won, lost or disqualified.
 *   · How many leads may be **given** to a person in one business day (`maxPerDay`) and one month (`maxPerMonth`),
 *     by the workspace's own clock: counted from `lead_assignments`, which a database trigger writes every time a
 *     lead's owner changes, whatever path changed it — so a lead taken away and given back counts twice.
 *   · The workspace's **plan** (`Entitlements.leads`): leads created a month (`monthly`, counted in `lead_usage`)
 *     and open leads at once across everybody (`open`).
 *
 * ## Where a person's limit comes from — the first that answers is final, as for the daily unmask limit
 *
 *   1. The super admin: none.
 *   2. Their own row (`UserLeadLimit`, unexpired): `limited` false is none; true is its three numbers.
 *   3. Their role's row (`RoleLeadLimit`): its three numbers.
 *   4. Nothing stored: none. Limits are opt-in, set by an admin; with none set, nothing here changes anything.
 *
 * A null number is no limit on that count, so "20 open, any number a day" is one row.
 *
 * ## How an intake path uses this
 *
 *   · Inside the transaction that writes `ownerUserId`, call `claimLeadCapacity(tx, [owner], { creating })`. It
 *     takes the locks, counts, compares and throws `LeadCapacityFull` — so two requests at once can't both take
 *     somebody's last place. `creating: true` also counts the lead against the plan. Nothing else may be read
 *     through the global `db` inside that transaction: a workspace's pool is two connections, and a transaction
 *     waiting on these locks holds one (src/lib/tenancy/clients.ts).
 *   · Catch with `leadCapacityError(err)`, which also recognises the database backstop's refusal in "enforce" mode.
 *   · A person chosen by hand who is full is refused with the error's message. A lead from outside — a form, the
 *     capture API, a card, a booking — is never lost to a limit: the assignment rules (`decideOwner`,
 *     src/lib/leads/assign.ts) skip whoever is full and, with nobody left, say so; the caller creates the lead
 *     unassigned and tells the managers. Only the plan's cap refuses such a lead (`scope: "workspace"`).
 *   · `canTakeLeads` / `peopleWithRoom` answer without throwing, for a picker or the rules.
 *
 * ## The backstop
 *
 * A trigger on `leads` (migration 20261213090000_lead_limits, `check_lead_limit`) checks the open and daily limits on
 * every write of `ownerUserId`, whatever wrote it. Shipped warn-only: past a limit it writes a `lead_limit_warnings`
 * row and lets the write through. The setting `leads.limitTrigger` ("warn" | "enforce", `saveLeadLimitTrigger`) makes
 * it refuse instead, with SQLSTATE `LEAD_LIMIT_SQLSTATE`. The checks here stay first either way, for a readable reason.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** The largest number an admin may set — a typo guard, not a business rule (as MAX_DAILY_UNMASK_LIMIT). */
export const MAX_LEAD_LIMIT = 100_000;

/** The statuses that close a lead, from the pipeline's own meanings (src/lib/pipeline/rules.ts): won, lost, disqualified. */
export const CLOSED_LEAD_STATUSES: LeadStatus[] = MEANINGS.filter((m) => isClosed(m.status)).map((m) => m.status);

/** The SQLSTATE the database's backstop raises in "enforce" mode. */
export const LEAD_LIMIT_SQLSTATE = "DZL01";

export type LeadLimitKind = "open" | "perDay" | "perMonth";

export type LeadLimitSource =
  | { via: "superAdmin" }
  | { via: "userLimit"; reason: string | null; expiresAt: Date | null }
  | { via: "roleLimit"; role: string }
  | { via: "none" };

/** A person's limits; each null for no limit on that count. */
export type LeadLimit = { maxOpen: number | null; maxPerDay: number | null; maxPerMonth: number | null; source: LeadLimitSource };

export type LeadUsage = {
  /** Open leads they own now. */
  open: number;
  /** Leads given to them today and this month, by the workspace's clock. */
  today: number;
  thisMonth: number;
  /** The business day and month counted: "YYYY-MM-DD", "YYYY-MM". */
  businessDate: string;
  month: string;
};

const NO_LIMIT: Omit<LeadLimit, "source"> = { maxOpen: null, maxPerDay: null, maxPerMonth: null };
const hasLimit = (l: LeadLimit | undefined): l is LeadLimit => !!l && (l.maxOpen !== null || l.maxPerDay !== null || l.maxPerMonth !== null);

/**
 * Thrown inside the transaction that would give somebody (or the workspace) more leads than allowed — the way
 * `SeatsFull` is. Its message is for whoever tried; the fields say which limit, for a caller that words it its own way.
 */
export class LeadCapacityFull extends Error {
  readonly scope: "person" | "workspace";
  /** The person, for a person's limit. */
  readonly userId: string | null;
  readonly limit: LeadLimitKind | "planMonthly" | "planOpen";
  readonly max: number;
  /** What was counted before these leads. */
  readonly used: number;
  /** How many leads were arriving. */
  readonly adding: number;

  constructor(f: { scope: "person" | "workspace"; userId?: string | null; name?: string | null; limit: LeadCapacityFull["limit"]; max: number; used: number; adding?: number }) {
    super(capacityMessage(f));
    this.name = "LeadCapacityFull";
    this.scope = f.scope;
    this.userId = f.userId ?? null;
    this.limit = f.limit;
    this.max = f.max;
    this.used = f.used;
    this.adding = f.adding ?? 1;
  }
}

const n = (value: number) => value.toLocaleString("en-IN");
const leads = (value: number) => `${n(value)} ${value === 1 ? "lead" : "leads"}`;

function capacityMessage(f: { name?: string | null; limit: LeadCapacityFull["limit"]; max: number; used: number; adding?: number }): string {
  const adding = f.adding ?? 1;
  const who = f.name?.trim() || "That person";
  switch (f.limit) {
    case "planMonthly":
      return `This workspace's plan includes ${leads(f.max)} a month, and this month's are used. Ask the workspace owner about a larger plan.`;
    case "planOpen":
      return `This workspace's plan allows ${leads(f.max)} open at once, and ${f.used >= f.max ? "that many are open" : `${n(f.used)} are`}. Close some, or ask the workspace owner about a larger plan.`;
    case "open":
      return adding > 1
        ? `${who} has ${leads(f.used)} open and a limit of ${n(f.max)}, so they can't take these ${n(adding)}. Choose somebody else, or fewer leads.`
        : `${who} has reached their limit of ${leads(f.max)} open. Close or hand some on first, or choose somebody else.`;
    case "perDay":
      return adding > 1
        ? `${who} has been given ${leads(f.used)} today and may be given ${n(f.max)} a day, so they can't take these ${n(adding)}. Choose somebody else.`
        : `${who} has been given ${leads(f.used)} today, their daily limit. Choose somebody else, or try again tomorrow.`;
    case "perMonth":
      return adding > 1
        ? `${who} has been given ${leads(f.used)} this month and may be given ${n(f.max)} a month, so they can't take these ${n(adding)}. Choose somebody else.`
        : `${who} has been given ${leads(f.used)} this month, their monthly limit. Choose somebody else.`;
  }
}

// ─── Old databases ─────────────────────────────────────────────────────────────────────────────────

/**
 * Whether this workspace has the tables yet (new code meets old databases for a while after a deploy). Outside a
 * transaction a query that fails is caught (`notMigratedYet`); inside one it would abort the caller's transaction, so
 * there the catalogue is asked first, once per transaction.
 */
type Ready = { limits: boolean; usage: boolean; settings: boolean };
const READY: Ready = { limits: true, usage: true, settings: true };
const probes = new WeakMap<object, Promise<Ready>>();

/** A transaction's client has no `$transaction` of its own. */
export function isTransaction(client: Db): client is Prisma.TransactionClient {
  return typeof (client as { $transaction?: unknown }).$transaction !== "function";
}

function readiness(client: Db): Promise<Ready> {
  if (!isTransaction(client)) return Promise.resolve(READY);
  let probe = probes.get(client);
  if (!probe) {
    probe = client.$queryRaw<{ limits: boolean; usage: boolean; settings: boolean }[]>`
      SELECT to_regclass('public.user_lead_limits') IS NOT NULL AND to_regclass('public.role_lead_limits') IS NOT NULL AS "limits",
             to_regclass('public.lead_usage') IS NOT NULL AS "usage",
             to_regclass('public.lead_limit_settings') IS NOT NULL AS "settings"`.then((rows) => rows[0] ?? { limits: false, usage: false, settings: false });
    probes.set(client, probe);
  }
  return probe;
}

async function orNone<T>(work: () => Promise<T>, none: T): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (notMigratedYet(err)) return none;
    throw err;
  }
}

// ─── Resolution ───────────────────────────────────────────────────────────────────────────────────

type Person = LeadLimit & { name: string };

/** Each person's limits, read in three queries whatever the number of people. */
async function limitsOf(client: Db, userIds: string[]): Promise<Map<string, Person>> {
  const ids = [...new Set(userIds)];
  const out = new Map<string, Person>();
  if (ids.length === 0) return out;
  const people = await client.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, role: true, isSuperAdmin: true } });
  const ready = await readiness(client);
  const rest = people.filter((p) => !p.isSuperAdmin);
  const [own, forRoles] =
    ready.limits && rest.length
      ? await orNone(
          async () => [
            await client.userLeadLimit.findMany({
              where: { userId: { in: rest.map((p) => p.id) }, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
              select: { userId: true, limited: true, maxOpen: true, maxPerDay: true, maxPerMonth: true, reason: true, expiresAt: true },
            }),
            await client.roleLeadLimit.findMany({
              where: { role: { in: [...new Set(rest.map((p) => p.role))] } },
              select: { role: true, maxOpen: true, maxPerDay: true, maxPerMonth: true },
            }),
          ] as const,
          [[], []] as const,
        )
      : ([[], []] as const);
  for (const p of people) {
    if (p.isSuperAdmin) {
      out.set(p.id, { ...NO_LIMIT, name: p.name, source: { via: "superAdmin" } });
      continue;
    }
    const mine = own.find((o) => o.userId === p.id);
    if (mine) {
      const numbers = mine.limited ? { maxOpen: mine.maxOpen, maxPerDay: mine.maxPerDay, maxPerMonth: mine.maxPerMonth } : NO_LIMIT;
      out.set(p.id, { ...numbers, name: p.name, source: { via: "userLimit", reason: mine.reason, expiresAt: mine.expiresAt } });
      continue;
    }
    const role = forRoles.find((r) => r.role === p.role);
    if (role) {
      out.set(p.id, { maxOpen: role.maxOpen, maxPerDay: role.maxPerDay, maxPerMonth: role.maxPerMonth, name: p.name, source: { via: "roleLimit", role: p.role } });
      continue;
    }
    out.set(p.id, { ...NO_LIMIT, name: p.name, source: { via: "none" } });
  }
  return out;
}

/** One person's lead limits, and where they come from. Nobody by that id: none. */
export async function leadLimitFor(userId: string, client: Db = defaultDb): Promise<LeadLimit> {
  const found = (await limitsOf(client, [userId])).get(userId);
  if (!found) return { ...NO_LIMIT, source: { via: "none" } };
  return { maxOpen: found.maxOpen, maxPerDay: found.maxPerDay, maxPerMonth: found.maxPerMonth, source: found.source };
}

// ─── Counting ─────────────────────────────────────────────────────────────────────────────────────

type Windows = { day: { from: Date; to: Date; key: string }; month: { from: Date; to: Date; key: string } };

function windowsOf(clock: Clock, now: Date): Windows {
  const key = clock.dateKey(now);
  const month = clock.monthWindow(now);
  return { day: { from: clock.startOfDay(key)!, to: clock.endOfDay(key)!, key }, month: { from: month.from, to: month.to, key: clock.monthKey(now) } };
}

type Counts = { open: number; today: number; thisMonth: number };

/** Open leads, and leads given today and this month, for each person — only the counts somebody's limit needs. */
async function countsOf(client: Db, ids: string[], w: Windows, need: { open: boolean; day: boolean; month: boolean }): Promise<Map<string, Counts>> {
  const out = new Map(ids.map((id) => [id, { open: 0, today: 0, thisMonth: 0 }]));
  if (ids.length === 0) return out;
  if (need.open) {
    const rows = await client.lead.groupBy({ by: ["ownerUserId"], where: { ownerUserId: { in: ids }, status: { notIn: CLOSED_LEAD_STATUSES } }, _count: { _all: true } });
    for (const r of rows) if (r.ownerUserId) out.get(r.ownerUserId)!.open = r._count._all;
  }
  const given = async (from: Date, to: Date) =>
    client.leadAssignment.groupBy({ by: ["userId"], where: { userId: { in: ids }, assignedAt: { gte: from, lt: to } }, _count: { _all: true } });
  if (need.day) for (const r of await given(w.day.from, w.day.to)) if (r.userId) out.get(r.userId)!.today = r._count._all;
  if (need.month) for (const r of await given(w.month.from, w.month.to)) if (r.userId) out.get(r.userId)!.thisMonth = r._count._all;
  return out;
}

/** One person's open leads now, and the leads given to them today and this month — what the screens show beside the limit. */
export async function leadUsageFor(userId: string, client: Db = defaultDb): Promise<LeadUsage> {
  const w = windowsOf(await workspaceClock(), new Date());
  const counts = (await countsOf(client, [userId], w, { open: true, day: true, month: true })).get(userId)!;
  return { ...counts, businessDate: w.day.key, month: w.month.key };
}

/** The first of a person's limits these leads would pass, or null — with the counts it was judged on. */
function firstPassed(limit: LeadLimit, c: Counts, adding: number, addingOpen: number): { limit: LeadLimitKind; max: number; used: number; adding: number } | null {
  if (limit.maxOpen !== null && addingOpen > 0 && c.open + addingOpen > limit.maxOpen) return { limit: "open", max: limit.maxOpen, used: c.open, adding: addingOpen };
  if (limit.maxPerDay !== null && adding > 0 && c.today + adding > limit.maxPerDay) return { limit: "perDay", max: limit.maxPerDay, used: c.today, adding };
  if (limit.maxPerMonth !== null && adding > 0 && c.thisMonth + adding > limit.maxPerMonth) return { limit: "perMonth", max: limit.maxPerMonth, used: c.thisMonth, adding };
  return null;
}

const needOf = (limits: LeadLimit[]) => ({
  open: limits.some((l) => l.maxOpen !== null),
  day: limits.some((l) => l.maxPerDay !== null),
  month: limits.some((l) => l.maxPerMonth !== null),
});

// ─── Asking without taking ────────────────────────────────────────────────────────────────────────

/**
 * Of these people, those who could be given `count` more leads now (default one), in the order given. Doesn't lock and
 * doesn't throw — for the assignment rules and pickers; `claimLeadCapacity` is the answer that counts. Inside a
 * transaction pass it as `db`: nothing here then reads through the global client.
 */
export async function peopleWithRoom(userIds: string[], options: { db?: Db; count?: number } = {}): Promise<string[]> {
  const client = options.db ?? defaultDb;
  const count = Math.max(1, Math.floor(options.count ?? 1));
  const limits = await limitsOf(client, userIds);
  const limited = [...limits.entries()].filter(([, l]) => hasLimit(l)).map(([id]) => id);
  if (limited.length === 0) return userIds;
  const counts = await countsOf(client, limited, windowsOf(await workspaceClock(), new Date()), needOf(limited.map((id) => limits.get(id)!)));
  const full = new Set(limited.filter((id) => firstPassed(limits.get(id)!, counts.get(id)!, count, count) !== null));
  return userIds.filter((id) => !full.has(id));
}

/** Whether this person could be given `count` more leads now (default one). Non-throwing; see `peopleWithRoom`. */
export async function canTakeLeads(userId: string, options: { db?: Db; count?: number } = {}): Promise<boolean> {
  return (await peopleWithRoom([userId], options)).length === 1;
}

// ─── Taking ───────────────────────────────────────────────────────────────────────────────────────

/** The plan's caps on leads (Entitlements.leads, src/lib/entitlements.ts); each absent for no cap. */
async function planCaps(): Promise<{ monthly?: number; open?: number }> {
  return (await currentTenantOrNull())?.entitlements.leads ?? {};
}

/**
 * The workspace's queue for new leads: every creation, and every choice of owner by the rules inside one, waits here
 * while it counts and writes — the seats pattern (src/lib/seats.ts). Postgres's advisory locks belong to one
 * database, so each workspace queues only behind its own. Taken first, before a rule's row and any person's lock, so
 * that every transaction takes them in the same order.
 */
export async function lockLeadIntake(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('deskzo:leads'))`;
}

/**
 * Names the path writing leads in this transaction, for the backstop's warning rows ("createLead", "import"…).
 * Transaction-local: it ends with the transaction.
 */
export async function markLeadWrite(tx: Prisma.TransactionClient, path: string): Promise<void> {
  await tx.$executeRaw`SELECT set_config('deskzo.lead_path', ${path.slice(0, 60)}, true)`;
}

/**
 * Takes room for leads inside the transaction that writes them, or throws `LeadCapacityFull` — the one check that
 * counts. Each of `ownerIds` (null for "nobody", skipped) receives `count` leads (default one), `open` of them open
 * (default all — a bulk move of closed leads passes 0 there). A person named twice receives twice.
 *
 *   · `creating`: these are new leads. The workspace's queue is taken (`lockLeadIntake`), the plan's open cap is
 *     checked, and this month's `lead_usage` row is counted up — rolled back with the transaction if anything refuses.
 *   · Then one lock per person who has a limit, in id order so two transactions never wait on each other, and their
 *     counts, read under those locks.
 *
 * Nobody with a limit and no plan cap: no lock but the workspace's, and no counting.
 */
export async function claimLeadCapacity(tx: Prisma.TransactionClient, ownerIds: (string | null | undefined)[], options: { creating: boolean; count?: number; open?: number }): Promise<void> {
  const count = Math.max(0, Math.floor(options.count ?? 1));
  const open = Math.min(count, Math.max(0, Math.floor(options.open ?? count)));
  if (count === 0) return;
  const now = new Date();
  const clock = await workspaceClock();
  const w = windowsOf(clock, now);
  const ready = await readiness(tx);

  if (options.creating) {
    await lockLeadIntake(tx);
    const caps = await planCaps();
    if (caps.open !== undefined) {
      const held = await tx.lead.count({ where: { status: { notIn: CLOSED_LEAD_STATUSES } } });
      if (held + count > caps.open) throw new LeadCapacityFull({ scope: "workspace", limit: "planOpen", max: caps.open, used: held, adding: count });
    }
    if (ready.usage) {
      const rows = await tx.$queryRaw<{ created: number }[]>`
        INSERT INTO "lead_usage" ("month", "created", "updatedAt") VALUES (${w.month.key}, ${count}, now())
        ON CONFLICT ("month") DO UPDATE SET "created" = "lead_usage"."created" + ${count}, "updatedAt" = now()
        RETURNING "created"`;
      const created = Number(rows[0]?.created ?? count);
      if (caps.monthly !== undefined && created > caps.monthly) throw new LeadCapacityFull({ scope: "workspace", limit: "planMonthly", max: caps.monthly, used: created - count, adding: count });
    }
  }

  const arriving = new Map<string, number>();
  for (const id of ownerIds) if (id) arriving.set(id, (arriving.get(id) ?? 0) + 1);
  if (arriving.size === 0 || !ready.limits) return;
  const limits = await limitsOf(tx, [...arriving.keys()]);
  const limited = [...arriving.keys()].filter((id) => hasLimit(limits.get(id))).sort();
  if (limited.length === 0) return;
  for (const id of limited) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`deskzo:lead-owner:${id}`}))`;
  const need = needOf(limited.map((id) => limits.get(id)!));
  if (need.day && ready.settings) await keepZone(tx, clock);
  const counts = await countsOf(tx, limited, w, need);
  for (const id of limited) {
    const times = arriving.get(id)!;
    const passed = firstPassed(limits.get(id)!, counts.get(id)!, count * times, open * times);
    if (passed) throw new LeadCapacityFull({ scope: "person", userId: id, name: limits.get(id)!.name, ...passed });
  }
}

/**
 * The `LeadCapacityFull` an error is, or stands for: thrown by `claimLeadCapacity`, or the database's backstop refusing
 * a write in "enforce" mode (`lead_limit_exceeded:<limit>:<person>:<counted>:<max>`, SQLSTATE `LEAD_LIMIT_SQLSTATE`).
 * Null for anything else.
 */
export function leadCapacityError(err: unknown): LeadCapacityFull | null {
  if (err instanceof LeadCapacityFull) return err;
  if (!err || typeof err !== "object") return null;
  const e = err as { message?: unknown; meta?: unknown; code?: unknown };
  let text = typeof e.message === "string" ? e.message : "";
  try {
    text += ` ${JSON.stringify(e.meta ?? "")} ${String(e.code ?? "")}`;
  } catch {
    // A meta that can't be written out says nothing more.
  }
  const found = /lead_limit_exceeded:(open|perDay):([^:\s"]+):(\d+):(\d+)/.exec(text);
  if (found) return new LeadCapacityFull({ scope: "person", userId: found[2], limit: found[1] as LeadLimitKind, used: Number(found[3]), max: Number(found[4]) });
  if (text.includes(LEAD_LIMIT_SQLSTATE)) return new LeadCapacityFull({ scope: "person", limit: "open", used: 0, max: 0 });
  return null;
}

// ─── The setting `leads.limitTrigger` ─────────────────────────────────────────────────────────────

export type LeadLimitTriggerMode = "warn" | "enforce";
export const LEAD_LIMIT_SETTINGS_ID = "global";

/** What the database's backstop does past a limit: "warn" (the default, and where the table isn't there yet) or "enforce". */
export async function leadLimitTrigger(client: Db = defaultDb): Promise<{ mode: LeadLimitTriggerMode; updatedAt: Date | null; updatedById: string | null }> {
  const row = await orNone(() => client.leadLimitSettings.findUnique({ where: { id: LEAD_LIMIT_SETTINGS_ID }, select: { limitTrigger: true, updatedAt: true, updatedById: true } }), null);
  return { mode: row?.limitTrigger === "enforce" ? "enforce" : "warn", updatedAt: row?.updatedAt ?? null, updatedById: row?.updatedById ?? null };
}

/**
 * Sets `leads.limitTrigger`. The caller has checked who may (whoever sets limits: `permissions.manage`, as for the
 * unmask limit). Writes the workspace's time zone with it, so the trigger's business day is the app's.
 */
export async function saveLeadLimitTrigger(mode: LeadLimitTriggerMode, byUserId: string | null, client: Db = defaultDb): Promise<void> {
  if (mode !== "warn" && mode !== "enforce") throw new Error(`leads.limitTrigger is "warn" or "enforce", not "${String(mode)}".`);
  const timeZone = (await workspaceClock()).zone;
  await client.leadLimitSettings.upsert({
    where: { id: LEAD_LIMIT_SETTINGS_ID },
    update: { limitTrigger: mode, timeZone, updatedById: byUserId },
    create: { id: LEAD_LIMIT_SETTINGS_ID, limitTrigger: mode, timeZone, updatedById: byUserId },
  });
}

/** Keeps the trigger's copy of the workspace's time zone (the zone lives in the control plane) — written only when it changed. */
async function keepZone(tx: Prisma.TransactionClient, clock: Clock): Promise<void> {
  const row = await tx.leadLimitSettings.findUnique({ where: { id: LEAD_LIMIT_SETTINGS_ID }, select: { timeZone: true } });
  if (row?.timeZone === clock.zone || (!row && clock.zone === "Asia/Kolkata")) return;
  await tx.leadLimitSettings.upsert({ where: { id: LEAD_LIMIT_SETTINGS_ID }, update: { timeZone: clock.zone }, create: { id: LEAD_LIMIT_SETTINGS_ID, timeZone: clock.zone } });
}
