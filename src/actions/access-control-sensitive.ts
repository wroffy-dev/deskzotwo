"use server";

import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can, describeSource } from "@/lib/authz/resolve";
import { holdsFrom, resolveEveryone } from "@/lib/authz/bulk";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { HIDDEN_ROLE_KEYS } from "@/lib/authz/role-registry";
import { fieldMaskingEnabled } from "@/lib/authz/masking-switch";
import { sensitiveFieldsOf } from "@/lib/authz/fields";
import { businessDate, workspaceUnmaskDefault } from "@/lib/authz/unmask";
import {
  closedPolicy,
  describePolicy,
  FIELD_ENTITIES,
  FIELD_ENTITY_WORDS,
  isCustomFieldKey,
  normalisePolicy,
  openPolicy,
  type FieldEntity,
  type FieldPolicy,
} from "@/lib/authz/field-policy";
import { getPermissionDefinition } from "@/lib/permissions";
import { notMigratedYet } from "@/lib/not-migrated";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * Settings › Access Control › Sensitive Data: the two reads its screens need that nothing else gives —
 * everybody's daily unmask limit beside what they used today, and, field by field, who sees a sensitive
 * value in the clear, masked or not at all.
 *
 * ## Who may read it
 *
 * "Review who can do what" (`permissions.view`) — what the field-access readers ask for
 * (src/actions/field-access.ts) and what opens the area. The unmasking log is the super admin's alone
 * (src/actions/unmask-log.ts `mayReadUnmaskLog`), so what comes out of the log — when somebody last
 * unmasked, how many attempts were stopped today — is only filled in for the super admin acting as
 * themselves, and is null for everybody else. The count used today is the limit's own counter
 * (`UnmaskUsage`), which a reviewer already sees on a person's page.
 *
 * ## Why the precedence is written out again
 *
 * `unmaskLimitFor` and `resolveFieldPolicies` answer for one person, each with its own queries; asked of
 * every active person they are several hundred round trips (src/lib/authz/bulk.ts says how that ended).
 * So the same rows are read once — every person, every stored policy and limit, today's counter — and
 * the two orders are applied here per person, step for step as src/lib/authz/unmask.ts `limitOf` and
 * src/lib/authz/fields.ts `resolveEntity` apply them. A read-only reporting path: nothing gates on it,
 * and every change still goes through the actions that check for themselves.
 */

const EXPORT_KEYS = ["data.exportCrm", "data.exportFinance", "data.exportPeople", "data.exportUsers"] as const;

/** From this share of the limit used, a person is "near" it — the design's 80%. */
const NEAR_LIMIT = 0.8;

type StoredPolicy = { entity: string; field: string; view: boolean; maskInList: boolean; maskInDetail: boolean; unmask: boolean; format: string | null; export: string | null };
const POLICY_COLUMNS = { entity: true, field: true, view: true, maskInList: true, maskInDetail: true, unmask: true, format: true, export: true } as const;

/** Masking switched off for the workspace, as src/lib/authz/fields.ts `switchedOff`: masked shows clear, restricted stays restricted. */
function switchedOff(policy: FieldPolicy): FieldPolicy {
  if (!policy.view) return policy;
  return { ...policy, maskInList: false, maskInDetail: false, unmask: false, export: policy.export === "masked" ? null : policy.export };
}

/** Everything both screens are drawn from, read once. */
async function loadWorkspace() {
  const now = new Date();
  const [clock, today, users, everyone, roles, maskingOn, workspaceDefault, fieldLists] = await Promise.all([
    workspaceClock(),
    businessDate(),
    db.user.findMany({
      where: { active: true, kind: "MEMBER" },
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true, role: true, isSuperAdmin: true, department: { select: { name: true } } },
    }),
    resolveEveryone(),
    db.role.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { key: true, name: true, active: true } }),
    fieldMaskingEnabled(),
    workspaceUnmaskDefault(),
    Promise.all(FIELD_ENTITIES.map((entity) => sensitiveFieldsOf(entity))),
  ]);

  // A workspace whose database hasn't got these tables yet reads as having nothing stored, as the resolvers read it.
  let personal: (StoredPolicy & { userId: string })[] = [];
  let forRole: (StoredPolicy & { role: string })[] = [];
  try {
    [personal, forRole] = await Promise.all([
      db.userFieldPolicy.findMany({ where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, select: { ...POLICY_COLUMNS, userId: true } }),
      db.roleFieldPolicy.findMany({ select: { ...POLICY_COLUMNS, role: true } }),
    ]);
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  let ownLimits: { userId: string; limited: boolean; dailyLimit: number | null; reason: string | null; expiresAt: Date | null }[] = [];
  let roleLimits: { role: string; dailyLimit: number | null }[] = [];
  try {
    [ownLimits, roleLimits] = await Promise.all([
      db.userUnmaskLimit.findMany({ select: { userId: true, limited: true, dailyLimit: true, reason: true, expiresAt: true } }),
      db.roleUnmaskLimit.findMany({ select: { role: true, dailyLimit: true } }),
    ]);
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  // One row per person, record and day; a row that came with another record's reveal used no unit.
  const usedBy = new Map<string, number>();
  try {
    const usage = await db.unmaskUsage.groupBy({ by: ["userId"], where: { businessDate: today, includedWith: null }, _count: { _all: true } });
    for (const row of usage) usedBy.set(row.userId, row._count._all);
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }

  const at = (who: string, entity: string, field: string) => `${who}/${entity}/${field}`;
  const own = new Map(personal.map((r) => [at(r.userId, r.entity, r.field), r]));
  const ofRole = new Map(forRole.map((r) => [at(r.role, r.entity, r.field), r]));
  const ownLimitOf = new Map(ownLimits.map((r) => [r.userId, r]));
  const roleLimitOf = new Map(roleLimits.map((r) => [r.role, r]));
  const roleName = new Map(roles.map((r) => [r.key, r.name]));

  const people = users.map((u) => {
    const facts = everyone.get(u.id);
    // Their account is on (only active people are listed) — but a switched-off role reaches nothing either.
    const live = facts ? facts.active : true;

    // Field access as stored, whether or not masking is switched on (`resolveStoredFieldPolicies`): super admin, then
    // switched off, then their own rule, then their role's, then nothing set. `stored[entity][field]`, in list order.
    const stored = FIELD_ENTITIES.map((entity, e) =>
      fieldLists[e]!.map((field) => {
        if (u.isSuperAdmin) return openPolicy(field.kind);
        if (!live) return closedPolicy(field.kind);
        const row = own.get(at(u.id, entity, field.key)) ?? ofRole.get(at(u.role, entity, field.key));
        return row ? normalisePolicy(field.kind, row) : openPolicy(field.kind);
      }),
    );
    // Whom the workspace default applies to (`mayUnmaskAnything`): any field of any record type they may unmask.
    const mayUnmask = stored.some((list) => list.some((p) => p.view && p.unmask));

    // The daily limit (`limitOf`): super admin, then their own unexpired row, then their role's row, then the
    // workspace default if they may unmask anything, then nothing to count.
    const ownRow = ownLimitOf.get(u.id);
    const ownLive = ownRow && (ownRow.expiresAt === null || ownRow.expiresAt.getTime() > now.getTime()) ? ownRow : null;
    const roleRow = roleLimitOf.get(u.role);
    const inheritedFrom: "role" | "default" | "none" = u.isSuperAdmin ? "none" : roleRow ? "role" : mayUnmask ? "default" : "none";
    const inherited = inheritedFrom === "role" ? roleRow!.dailyLimit : inheritedFrom === "default" ? workspaceDefault.dailyLimit : null;
    const source: "superAdmin" | "own" | "role" | "default" | "none" = u.isSuperAdmin ? "superAdmin" : ownLive ? "own" : inheritedFrom;
    const limit = u.isSuperAdmin ? null : ownLive ? (ownLive.limited ? ownLive.dailyLimit : null) : inherited;
    const used = usedBy.get(u.id) ?? 0;

    return {
      id: u.id,
      name: u.name,
      email: u.email,
      department: u.department?.name ?? null,
      role: u.role,
      roleName: roleName.get(u.role) ?? u.role,
      isSuperAdmin: u.isSuperAdmin,
      stored,
      mayUnmask,
      limit,
      source,
      ownLive,
      inherited,
      inheritedFrom,
      used,
      remaining: limit === null ? null : Math.max(0, limit - used),
    };
  });

  return { now, clock, today, people, everyone, roles, roleName, maskingOn, workspaceDefault, fieldLists, forRole, roleLimitOf };
}

type Workspace = Awaited<ReturnType<typeof loadWorkspace>>;
type Person = Workspace["people"][number];

export type UnmaskStatus = "exempt" | "none" | "unlimited" | "at" | "near" | "active";

/** Where a person stands against their limit today. With masking off nothing is masked, so nothing is unmasked either. */
function statusOf(p: Person): UnmaskStatus {
  if (p.isSuperAdmin) return "exempt";
  if (!p.mayUnmask) return "none";
  if (p.limit === null) return "unlimited";
  if (p.used >= p.limit) return "at";
  return p.used / p.limit >= NEAR_LIMIT ? "near" : "active";
}

export type UnmaskQuotaSummary = {
  /** People who may unmask at least one field, as their rules are stored. */
  canUnmask: number;
  /** Records unmasked today (units used), and by how many people. */
  unmaskedToday: number;
  peopleUnmaskingToday: number;
  atLimit: number;
  nearLimit: number;
  /** People who may unmask with no daily limit at all. */
  unlimited: number;
  /** The workspace default; null is "no limit". */
  defaultLimit: number | null;
};

function quotaSummary(w: Workspace): UnmaskQuotaSummary {
  const statuses = w.people.map(statusOf);
  const count = (s: UnmaskStatus) => statuses.filter((x) => x === s).length;
  return {
    canUnmask: w.people.filter((p) => p.mayUnmask).length,
    unmaskedToday: w.people.reduce((n, p) => n + p.used, 0),
    peopleUnmaskingToday: w.people.filter((p) => p.used > 0).length,
    atLimit: count("at"),
    nearLimit: count("near"),
    unlimited: count("unlimited"),
    defaultLimit: w.workspaceDefault.dailyLimit,
  };
}

// ─── Unmasking Limits ─────────────────────────────────────────────────────────────────────────────

export type UnmaskLimitRow = {
  id: string;
  name: string;
  email: string;
  department: string | null;
  role: string;
  roleName: string;
  isSuperAdmin: boolean;
  /** Whether any field of any record type may be unmasked by them, as their rules are stored. */
  mayUnmask: boolean;
  /** What applies today; null is no limit. */
  limit: number | null;
  source: "superAdmin" | "own" | "role" | "default" | "none";
  /** Their own limit, when one is set and hasn't run out. */
  own: { limited: boolean; dailyLimit: number | null; reason: string | null; expiresAt: string | null; lastDayText: string | null; lastDayKey: string | null } | null;
  /** What they get without a limit of their own, and where from. */
  inherited: number | null;
  inheritedFrom: "role" | "default" | "none";
  used: number;
  remaining: number | null;
  status: UnmaskStatus;
  /** From the unmasking log — the super admin's alone, so null for anybody else. */
  lastActivityAt: string | null;
  /** Why the person looking can't change this person's limit; null when they can. */
  lockedWhy: string | null;
};

export type RoleLimitRow = {
  key: string;
  name: string;
  active: boolean;
  people: number;
  /** The role has a limit row at all — "no limit" stored is different from nothing stored. */
  stored: boolean;
  dailyLimit: number | null;
  lockedWhy: string | null;
};

export type UnmaskLimitsBoard = {
  rows: UnmaskLimitRow[];
  roles: RoleLimitRow[];
  summary: UnmaskQuotaSummary;
  /** Attempts the log holds for today that showed nothing — null unless the super admin is asking. */
  stoppedToday: { limitReached: number; refused: number } | null;
  /** Whether the person asking reads the unmasking log (the super admin, as themselves). */
  logVisible: boolean;
  maskingOn: boolean;
  /** Today on the workspace's clock (YYYY-MM-DD), the zone it turns over in, and when it next does. */
  today: string;
  zone: string;
  nextResetText: string | null;
};

export async function unmaskLimitsBoard(): Promise<UnmaskLimitsBoard | null> {
  const session = await requireUser();
  if (!(await can(session.id, "permissions.view"))) return null;
  const [w, mayManagePermission, logVisible] = await Promise.all([loadWorkspace(), can(session.id, "permissions.manage"), actingAsSuperAdmin(session.id)]);
  const viewerIsSuperAdmin = w.everyone.get(session.id)?.isSuperAdmin === true;
  const mayManage = viewerIsSuperAdmin || mayManagePermission;

  const lastBy = new Map<string, Date>();
  let stoppedToday: UnmaskLimitsBoard["stoppedToday"] = null;
  if (logVisible) {
    stoppedToday = { limitReached: 0, refused: 0 };
    try {
      const [last, results] = await Promise.all([
        db.unmaskEvent.groupBy({ by: ["userId"], _max: { at: true } }),
        db.unmaskEvent.groupBy({ by: ["result"], where: { businessDate: w.today }, _count: { _all: true } }),
      ]);
      for (const row of last) if (row._max.at) lastBy.set(row.userId, row._max.at);
      for (const row of results) {
        if (row.result === "QUOTA_EXHAUSTED") stoppedToday.limitReached = row._count._all;
        if (row.result === "DENIED") stoppedToday.refused = row._count._all;
      }
    } catch (err) {
      if (!notMigratedYet(err)) throw err;
    }
  }

  // The rules `setPersonUnmaskLimit` holds a change to, said before the click rather than after it.
  const personLocked = (p: Person): string | null =>
    !mayManage
      ? "You can review access but not change it."
      : p.isSuperAdmin
        ? "A super admin sees every field and has no limit; there is nothing to set."
        : p.id === session.id
          ? "Your own daily limit is changed by another admin."
          : null;
  // And `setRoleUnmaskLimit`'s.
  const roleLocked = (key: string): string | null =>
    !mayManage ? "You can review roles but not change them." : key === "ADMIN" && !viewerIsSuperAdmin ? "Only a super admin can change what admins can do." : null;

  const headcount = new Map<string, number>();
  for (const p of w.people) if (!p.isSuperAdmin) headcount.set(p.role, (headcount.get(p.role) ?? 0) + 1);
  const endOfToday = w.clock.endOfDay(w.today);

  return {
    rows: w.people.map((p) => ({
      id: p.id,
      name: p.name,
      email: p.email,
      department: p.department,
      role: p.role,
      roleName: p.roleName,
      isSuperAdmin: p.isSuperAdmin,
      mayUnmask: p.mayUnmask,
      limit: p.limit,
      source: p.source,
      own: p.ownLive
        ? {
            limited: p.ownLive.limited,
            dailyLimit: p.ownLive.dailyLimit,
            reason: p.ownLive.reason,
            expiresAt: p.ownLive.expiresAt ? p.ownLive.expiresAt.toISOString() : null,
            // Kept as the midnight that ends its last day, so the day named is the one before it.
            lastDayText: p.ownLive.expiresAt ? w.clock.date(new Date(p.ownLive.expiresAt.getTime() - 1)) : null,
            lastDayKey: p.ownLive.expiresAt ? w.clock.dateKey(new Date(p.ownLive.expiresAt.getTime() - 1)) : null,
          }
        : null,
      inherited: p.inherited,
      inheritedFrom: p.inheritedFrom,
      used: p.used,
      remaining: p.remaining,
      status: statusOf(p),
      lastActivityAt: lastBy.get(p.id)?.toISOString() ?? null,
      lockedWhy: personLocked(p),
    })),
    roles: w.roles
      .filter((r) => !HIDDEN_ROLE_KEYS.has(r.key))
      .map((r) => {
        const row = w.roleLimitOf.get(r.key);
        return { key: r.key, name: r.name, active: r.active, people: headcount.get(r.key) ?? 0, stored: row !== undefined, dailyLimit: row?.dailyLimit ?? null, lockedWhy: roleLocked(r.key) };
      }),
    summary: quotaSummary(w),
    stoppedToday,
    logVisible,
    maskingOn: w.maskingOn,
    today: w.today,
    zone: w.clock.zone,
    nextResetText: endOfToday ? w.clock.dateTimeShort(endOfToday) : null,
  };
}

// ─── Sensitive Data Access ────────────────────────────────────────────────────────────────────────

export type SensitivePerson = { id: string; name: string; roleName: string; isSuperAdmin: boolean };

export type SensitiveFieldRow = {
  key: string;
  label: string;
  description: string;
  custom: boolean;
  /** Indexes into `people`. Everybody is in exactly one of clear, masked and restricted. */
  clear: number[];
  /** Masked in lists, on the record's own page, or both. */
  masked: number[];
  /** Those of `masked` who may unmask it, within their daily limit. */
  unmask: number[];
  restricted: number[];
  /** The roles with a rule of their own for this field, in words. */
  roles: { key: string; name: string; rule: string }[];
};

export type SensitiveExportRow = {
  key: string;
  label: string;
  description: string;
  holders: { person: number; why: string }[];
};

export type SensitiveAccessBoard = {
  maskingOn: boolean;
  people: SensitivePerson[];
  entities: { entity: FieldEntity; title: string; fields: SensitiveFieldRow[] }[];
  exports: SensitiveExportRow[];
  summary: UnmaskQuotaSummary;
  zone: string;
};

/**
 * Field by field, who sees it how right now — with the master switch as it stands, so "masked" here is what
 * people's screens show today — and who holds the rights that take data out in a file.
 */
export async function sensitiveAccessBoard(): Promise<SensitiveAccessBoard | null> {
  const session = await requireUser();
  if (!(await can(session.id, "permissions.view"))) return null;
  const w = await loadWorkspace();

  const entities = FIELD_ENTITIES.map((entity, e) => ({
    entity,
    title: FIELD_ENTITY_WORDS[entity].title,
    fields: w.fieldLists[e]!.map((field, f): SensitiveFieldRow => {
      const row: SensitiveFieldRow = { key: field.key, label: field.label, description: field.description, custom: isCustomFieldKey(field.key), clear: [], masked: [], unmask: [], restricted: [], roles: [] };
      w.people.forEach((p, i) => {
        const stored = p.stored[e]![f]!;
        const policy = w.maskingOn ? stored : switchedOff(stored);
        if (!policy.view) row.restricted.push(i);
        else if (policy.maskInList || policy.maskInDetail) {
          row.masked.push(i);
          if (policy.unmask) row.unmask.push(i);
        } else row.clear.push(i);
      });
      for (const rule of w.forRole) {
        if (rule.entity !== entity || rule.field !== field.key || HIDDEN_ROLE_KEYS.has(rule.role)) continue;
        row.roles.push({ key: rule.role, name: w.roleName.get(rule.role) ?? rule.role, rule: describePolicy(normalisePolicy(field.kind, rule), entity) });
      }
      row.roles.sort((a, b) => a.name.localeCompare(b.name));
      return row;
    }),
  }));

  // The same test "who can do X" makes (src/actions/permission.ts `holdersOf`), over the one resolution already read.
  const exports = EXPORT_KEYS.flatMap((key): SensitiveExportRow[] => {
    const def = getPermissionDefinition(key);
    if (!def) return [];
    const holders: SensitiveExportRow["holders"] = [];
    w.people.forEach((p, i) => {
      const source = w.everyone.get(p.id)?.sources.get(key);
      if (source && holdsFrom(source)) holders.push({ person: i, why: describeSource(source, w.clock) });
    });
    return [{ key, label: def.label, description: def.description, holders }];
  });

  return {
    maskingOn: w.maskingOn,
    people: w.people.map((p) => ({ id: p.id, name: p.name, roleName: p.roleName, isSuperAdmin: p.isSuperAdmin })),
    entities,
    exports,
    summary: quotaSummary(w),
    zone: w.clock.zone,
  };
}
