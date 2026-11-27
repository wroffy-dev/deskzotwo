"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { actorContext, assertMayActOnTarget, AuthzError } from "@/lib/authz/guards";
import { roleExists } from "@/lib/authz/role-registry";
import { recordPermissionChange } from "@/lib/authz/audit";
import { recordAudit } from "@/lib/audit";
import { notMigratedYet } from "@/lib/not-migrated";
import { SUPPORT_READONLY_ROLE, type Role } from "@/lib/roles";
import { workspaceClock } from "@/lib/time/workspace";
import { formatCalendarDay } from "@/lib/time/zone";
import { LEAD_LIMIT_SETTINGS_ID, MAX_LEAD_LIMIT, leadLimitFor, leadLimitTrigger, leadUsageFor, saveLeadLimitTrigger, type LeadLimit, type LeadLimitTriggerMode, type LeadUsage } from "@/lib/leads/limits";
import { formatLeadId } from "@/lib/order-id";
import type { ActionResult } from "@/actions/company";

/**
 * Lead limits on a role and on one person, and the database backstop's switch (owner, 12 Nov 2026 — Phase 4 lead
 * limits, audit H.6.5). What the numbers mean, and how they are enforced, is src/lib/leads/limits.ts; this file only
 * reads and saves them.
 *
 * Who may set them is decided exactly as for the daily unmask limit (src/actions/field-access.ts), on purpose — one
 * rule for "limits on people", not two to keep in step:
 *
 *   · "Change roles and permissions" (`permissions.manage`) or the super admin sets them; "Review who can do what"
 *     (`permissions.view`) reads them, and anybody reads their own.
 *   · Only a super admin changes Admin's; platform support's read-only role is fixed.
 *   · For one person: nobody acts on somebody they couldn't otherwise (`assertMayActOnTarget`), nobody changes their own,
 *     and the super admin has no limit to set.
 *
 * One rule of the unmask limit is deliberately not copied: "no higher than your own". There it stops an admin handing
 * out more sight of masked data than they have; a lead limit caps workload, not access, so an admin who carries 20
 * leads may still let a colleague carry 50.
 *
 * Every change is in the permission history (`recordPermissionChange`, `lead:limits`), as the unmask limit's is. The
 * backstop's switch is the super admin's alone, as field masking's master switch is, and goes in the audit log.
 */

type Numbers = { maxOpen: number | null; maxPerDay: number | null; maxPerMonth: number | null };
const NONE: Numbers = { maxOpen: null, maxPerDay: null, maxPerMonth: null };
const KINDS = [
  { key: "maxOpen", label: "Open leads at once" },
  { key: "maxPerDay", label: "Leads a day" },
  { key: "maxPerMonth", label: "Leads a month" },
] as const;

async function mayReview(userId: string): Promise<boolean> {
  return (await can(userId, "permissions.view")) || (await can(userId, "permissions.manage"));
}

async function administrator() {
  const session = await requireUser();
  const actor = await actorContext(session.id);
  const allowed = actor.isSuperAdmin || (await can(actor.id, "permissions.manage"));
  return { actor, allowed };
}

/** The midnight that ends the day chosen, on the workspace's clock — as the unmask limit's expiry. */
async function expiryFromDate(date: string | null | undefined): Promise<Date | null> {
  if (!date) return null;
  return (await workspaceClock()).endOfDay(String(date));
}

/** "20 open, 10 a day, 200 a month", or "no limit" — for the history and the screens. */
function numbersWords(n: Numbers): string {
  const parts = [n.maxOpen !== null && `${n.maxOpen} open`, n.maxPerDay !== null && `${n.maxPerDay} a day`, n.maxPerMonth !== null && `${n.maxPerMonth} a month`].filter(Boolean);
  return parts.length ? parts.join(", ") : "no limit";
}

const isEmpty = (n: Numbers) => n.maxOpen === null && n.maxPerDay === null && n.maxPerMonth === null;
const same = (a: Numbers | null, b: Numbers | null) => JSON.stringify(a && pick(a)) === JSON.stringify(b && pick(b));
const pick = (n: Numbers): Numbers => ({ maxOpen: n.maxOpen, maxPerDay: n.maxPerDay, maxPerMonth: n.maxPerMonth });

/**
 * The three numbers a form sent, each blank for no limit on that count — or why not. Zero is allowed: "0 open" is how
 * a person is paused without taking them off every rule.
 */
function readNumbers(raw: unknown): Numbers | string {
  if (raw === null || raw === undefined) return { ...NONE };
  if (typeof raw !== "object") return "Those aren't lead limits.";
  const r = raw as Record<string, unknown>;
  const out: Numbers = { ...NONE };
  for (const kind of KINDS) {
    const value = r[kind.key];
    if (value === null || value === undefined || value === "") continue;
    const n = typeof value === "number" ? value : Number(String(value).trim());
    if (!Number.isInteger(n) || n < 0) return `${kind.label}: a whole number, or blank for no limit.`;
    if (n > MAX_LEAD_LIMIT) return `${kind.label}: at most ${MAX_LEAD_LIMIT.toLocaleString("en-IN")}.`;
    out[kind.key] = n;
  }
  return out;
}

/** Reads that fail only because the workspace isn't migrated yet answer `none`. */
async function orNone<T>(work: () => Promise<T>, none: T): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (notMigratedYet(err)) return none;
    throw err;
  }
}

const NOT_YET = "This workspace is still being updated. Try again in a few minutes.";

// ─── A role ───────────────────────────────────────────────────────────────────────────────────────

export type RoleLeadLimitView = {
  /** The role's row, or null: nothing set, so its people have no lead limit (unless set on them). */
  stored: Numbers | null;
  /** How many people in the role have a limit of their own that overrides it. */
  overridden: number;
  editable: boolean;
  why: string | null;
};

export async function roleLeadLimit(role: string): Promise<RoleLeadLimitView | null> {
  const session = await requireUser();
  const actor = await actorContext(session.id);
  if (!actor.isSuperAdmin && !(await mayReview(actor.id))) return null;
  if (!(await roleExists(role))) return null;
  const [stored, overridden] = await Promise.all([
    orNone(() => db.roleLeadLimit.findUnique({ where: { role }, select: { maxOpen: true, maxPerDay: true, maxPerMonth: true } }), null),
    orNone(() => db.userLeadLimit.count({ where: { user: { role, isSuperAdmin: false }, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } }), 0),
  ]);
  const mayManage = actor.isSuperAdmin || (await can(actor.id, "permissions.manage"));
  const why = !mayManage
    ? "You can review roles but not change them."
    : role === "ADMIN" && !actor.isSuperAdmin
      ? "Only a super admin can change what admins can do."
      : role === SUPPORT_READONLY_ROLE
        ? "Platform support's read-only access is fixed."
        : role === actor.role && !actor.isSuperAdmin
          ? "This is your own role, so its limits are yours too — the super admin changes them."
          : null;
  return { stored, overridden, editable: why === null, why };
}

/**
 * A role's lead limits: the three numbers (each blank for no limit on that count), or null — or all three blank — to
 * take the role's row away, so its people have none again.
 */
export async function setRoleLeadLimit(role: string, value: unknown): Promise<ActionResult<null>> {
  const { actor, allowed } = await administrator();
  if (!allowed) return { ok: false, error: "You can't change role permissions." };
  if (role === "ADMIN" && !actor.isSuperAdmin) return { ok: false, error: "Only a super admin can change what admins can do." };
  if (role === SUPPORT_READONLY_ROLE) return { ok: false, error: "Platform support's read-only access can't be changed." };
  // Security audit round three, 14 Nov 2026 (low): a person's own limit is never theirs to change, and their role's
  // limit is theirs too — lifting it lifted their own. Somebody else (or the super admin) changes it.
  if (role === actor.role && !actor.isSuperAdmin) return { ok: false, error: "You can't change the lead limits of your own role — they are your own limits too. Ask the super admin." };
  if (!(await roleExists(role))) return { ok: false, error: "That role no longer exists." };
  const next = readNumbers(value);
  if (typeof next === "string") return { ok: false, error: next };
  const after = isEmpty(next) ? null : next;
  let before: Numbers | null;
  try {
    before = await db.roleLeadLimit.findUnique({ where: { role }, select: { maxOpen: true, maxPerDay: true, maxPerMonth: true } });
    if (same(before, after)) return { ok: true, data: null };
    if (after === null) await db.roleLeadLimit.deleteMany({ where: { role } });
    else await db.roleLeadLimit.upsert({ where: { role }, update: { ...after, updatedById: actor.id }, create: { role, ...after, updatedById: actor.id } });
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: NOT_YET };
    throw err;
  }
  await recordPermissionChange({
    actorUserId: actor.id,
    subjectType: "ROLE",
    subjectRole: role as Role,
    permission: "lead:limits",
    changeKind: after === null ? "RESET_TO_DEFAULT" : "GRANT",
    detail: `Lead limits for ${role}: ${numbersWords(before ?? NONE)} → ${numbersWords(after ?? NONE)}`,
  });
  revalidatePath("/settings", "layout");
  return { ok: true, data: null };
}

// ─── One person ───────────────────────────────────────────────────────────────────────────────────

export type PersonLeadLimitView = {
  /** What applies to them now. */
  effective: Numbers;
  /** Where it comes from, in words. */
  why: string;
  /** Their own row (expired or not), or null where they follow their role. */
  own: (Numbers & { limited: boolean; reason: string | null; expiresAt: string | null; expired: boolean; grantedBy: string | null }) | null;
  /** Their role's row, or null for nothing set on the role. */
  role: Numbers | null;
  roleName: string;
  /** Leads they hold open, and were given today and this month — what the limits count. */
  usage: LeadUsage;
  /** The workspace's zone — the midnight the daily count starts again at. */
  zone: string;
  editable: boolean;
  lockedWhy: string | null;
};

function sourceWords(limit: LeadLimit, day: (d: Date) => string): string {
  switch (limit.source.via) {
    case "superAdmin":
      return "Super admin — no lead limit.";
    case "userLimit":
      return `Set for them personally${limit.source.reason ? ` — ${limit.source.reason}` : ""}${limit.source.expiresAt ? `, until ${day(new Date(limit.source.expiresAt.getTime() - 1))}` : ""}.`;
    case "roleLimit":
      return `From their role (${limit.source.role}).`;
    case "none":
      return "Nothing set on them or their role — no lead limit.";
  }
}

export async function personLeadLimit(userId: string): Promise<PersonLeadLimitView | null> {
  const session = await requireUser();
  if (userId !== session.id && !(await mayReview(session.id))) return null;
  const target = await db.user.findUnique({ where: { id: userId }, select: { id: true, role: true, isSuperAdmin: true, roleRef: { select: { name: true } } } });
  if (!target) return null;
  const [limit, usage, clock, own, role] = await Promise.all([
    leadLimitFor(userId),
    leadUsageFor(userId),
    workspaceClock(),
    orNone(() => db.userLeadLimit.findUnique({ where: { userId }, include: { grantedBy: { select: { name: true } } } }), null),
    orNone(() => db.roleLeadLimit.findUnique({ where: { role: target.role }, select: { maxOpen: true, maxPerDay: true, maxPerMonth: true } }), null),
  ]);
  const day = (d: Date) => formatCalendarDay(clock.calendarDate(d));
  const mayManage = (await can(session.id, "permissions.manage")) || (await actorContext(session.id)).isSuperAdmin;
  const lockedWhy = !mayManage
    ? "You can review access but not change it."
    : target.isSuperAdmin
      ? "A super admin has no lead limit; there is nothing to set."
      : target.id === session.id
        ? "Your own lead limits are changed by another admin."
        : null;
  return {
    effective: pick(limit),
    why: sourceWords(limit, day),
    own: own
      ? {
          limited: own.limited,
          maxOpen: own.maxOpen,
          maxPerDay: own.maxPerDay,
          maxPerMonth: own.maxPerMonth,
          reason: own.reason,
          expiresAt: own.expiresAt ? own.expiresAt.toISOString() : null,
          expired: own.expiresAt !== null && own.expiresAt.getTime() <= Date.now(),
          grantedBy: own.grantedBy?.name ?? null,
        }
      : null,
    role,
    roleName: target.isSuperAdmin ? "Super Admin" : (target.roleRef?.name ?? target.role),
    usage,
    zone: clock.zone,
    editable: lockedWhy === null,
    lockedWhy,
  };
}

/**
 * One person's own lead limits: `{ limited: true, maxOpen, maxPerDay, maxPerMonth }` sets them (at least one number),
 * `{ limited: false }` is "no limit" for them whatever their role says, and null puts them back on their role's. A
 * reason and an end date go with their own, as with the unmask limit; once it ends they follow their role again.
 */
export async function setPersonLeadLimit(
  userId: string,
  value: ({ limited: boolean } & Partial<Record<keyof Numbers, unknown>>) | null,
  options: { reason?: string; expiresAt?: string | null } = {},
): Promise<ActionResult<null>> {
  const { actor, allowed } = await administrator();
  if (!allowed) return { ok: false, error: "You can't change permissions." };
  const target = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, role: true, isSuperAdmin: true } });
  if (!target) return { ok: false, error: "That user no longer exists." };
  try {
    assertMayActOnTarget(actor, target);
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: err.message };
    throw err;
  }
  if (target.isSuperAdmin) return { ok: false, error: `${target.name} is a super admin and has no lead limit.` };
  // As with field access and the unmask limit: lifting your own limit is the thing a limit exists to stop.
  if (target.id === actor.id) return { ok: false, error: "You can't change your own lead limits. Ask another admin." };

  let next: (Numbers & { limited: boolean }) | null = null;
  if (value !== null) {
    if (!value || typeof value.limited !== "boolean") return { ok: false, error: "Choose whether lead limits apply." };
    if (value.limited) {
      const numbers = readNumbers(value);
      if (typeof numbers === "string") return { ok: false, error: numbers };
      if (isEmpty(numbers)) return { ok: false, error: "Enter at least one limit — open leads, a day or a month — or choose no limit." };
      next = { limited: true, ...numbers };
    } else {
      next = { limited: false, ...NONE };
    }
  }

  const reason = options.reason?.trim().slice(0, 500) || null;
  const expiresAt = next ? await expiryFromDate(options.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) return { ok: false, error: "Choose an end date that hasn't passed." };
  let roleRow: Numbers | null = null;
  try {
    roleRow = await db.roleLeadLimit.findUnique({ where: { role: target.role }, select: { maxOpen: true, maxPerDay: true, maxPerMonth: true } });
    if (next === null) {
      await db.userLeadLimit.deleteMany({ where: { userId } });
    } else {
      const data = { ...next, reason, grantedById: actor.id, expiresAt };
      await db.userLeadLimit.upsert({ where: { userId }, update: data, create: { userId, ...data } });
    }
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: NOT_YET };
    throw err;
  }
  const clock = await workspaceClock();
  await recordPermissionChange({
    actorUserId: actor.id,
    subjectType: "USER",
    subjectUserId: userId,
    permission: "lead:limits",
    changeKind: next === null ? "RESET_TO_DEFAULT" : "GRANT",
    detail:
      next === null
        ? `Lead limits for ${target.name}: back to their role (${numbersWords(roleRow ?? NONE)})`
        : `Lead limits for ${target.name}: ${next.limited ? numbersWords(next) : "no limit"}${expiresAt ? `, until ${formatCalendarDay(clock.calendarDate(new Date(expiresAt.getTime() - 1)))}` : ""}${reason ? ` — ${reason}` : ""}`,
  });
  revalidatePath("/settings", "layout");
  return { ok: true, data: null };
}

// ─── The database's backstop: warn or enforce ─────────────────────────────────────────────────────

export type LeadLimitWarningRow = {
  id: string;
  atText: string;
  lead: { id: string; label: string } | null;
  person: string;
  limit: string;
  counted: number;
  maxAllowed: number;
  path: string | null;
};

export type LeadLimitTriggerView = {
  mode: LeadLimitTriggerMode;
  changedAtText: string | null;
  changedBy: string | null;
  /** The latest warnings, newest first — what "enforce" would have refused. */
  warnings: LeadLimitWarningRow[];
  /** All warnings in the last 30 days. */
  lastMonth: number;
};

const WARNINGS_SHOWN = 15;

/** The switch and its latest warnings — for the super admin only; null for anybody else. */
export async function leadLimitTriggerState(): Promise<LeadLimitTriggerView | null> {
  const session = await requireUser();
  const actor = await actorContext(session.id);
  if (!actor.isSuperAdmin) return null;
  const [setting, clock, rows, lastMonth] = await Promise.all([
    leadLimitTrigger(),
    workspaceClock(),
    orNone(() => db.leadLimitWarning.findMany({ orderBy: { at: "desc" }, take: WARNINGS_SHOWN }), []),
    orNone(() => db.leadLimitWarning.count({ where: { at: { gte: new Date(Date.now() - 30 * 86_400_000) } } }), 0),
  ]);
  const [leads, people, by] = await Promise.all([
    db.lead.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.leadId))] } }, select: { id: true, leadSeq: true, title: true } }),
    db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId))] } }, select: { id: true, name: true } }),
    setting.updatedById ? db.user.findUnique({ where: { id: setting.updatedById }, select: { name: true } }) : null,
  ]);
  const leadOf = new Map(leads.map((l) => [l.id, l]));
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  return {
    mode: setting.mode,
    changedAtText: setting.updatedAt ? clock.dateTime(setting.updatedAt) : null,
    changedBy: by?.name ?? null,
    warnings: rows.map((r) => {
      const lead = leadOf.get(r.leadId);
      return {
        id: r.id,
        atText: clock.dateTime(r.at),
        lead: lead ? { id: formatLeadId(lead.leadSeq), label: `${formatLeadId(lead.leadSeq)} · ${lead.title}` } : null,
        person: nameOf.get(r.userId) ?? "Somebody since removed",
        limit: r.limitKind === "open" ? "open leads" : r.limitKind === "perDay" ? "leads a day" : r.limitKind,
        counted: r.counted,
        maxAllowed: r.maxAllowed,
        path: r.path,
      };
    }),
    lastMonth,
  };
}

/**
 * "Hold lead limits on every write path": "warn" lets a write past a limit through and records it; "enforce" refuses
 * it in the database, whatever path wrote it. The super admin's alone, as field masking's master switch is — it changes
 * what every path, importers and workflows included, may do at once.
 */
export async function setLeadLimitTrigger(mode: unknown): Promise<ActionResult<null>> {
  const session = await requireUser();
  const actor = await actorContext(session.id);
  if (!actor.isSuperAdmin) return { ok: false, error: "Only a super admin can change how lead limits are held." };
  if (mode !== "warn" && mode !== "enforce") return { ok: false, error: "Warn or enforce?" };
  const before = (await leadLimitTrigger()).mode;
  if (before === mode) return { ok: true, data: null };
  try {
    await saveLeadLimitTrigger(mode, actor.id);
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: NOT_YET };
    throw err;
  }
  await recordAudit({
    userId: actor.id,
    action: "UPDATE",
    entityType: "LeadLimitSettings",
    entityId: LEAD_LIMIT_SETTINGS_ID,
    entityLabel:
      mode === "enforce"
        ? "Lead limits held on every write path — the database refuses a lead past somebody's limit"
        : "Lead limits warned on other write paths — the database records a lead past somebody's limit and lets it through",
  });
  revalidatePath("/settings/lead-assignment");
  return { ok: true, data: null };
}
