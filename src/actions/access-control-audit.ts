"use server";

import type { PermissionChangeKind, PermissionSubjectType, Prisma, UnmaskResult } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { hasEffectivePermission } from "@/actions/permission";
import { mayReadUnmaskLog } from "@/actions/unmask-log";
import { logActivity } from "@/lib/activity";
import { getSecurityPolicy } from "@/lib/security/store";
import { exportDecision } from "@/lib/security/policy";
import { notMigratedYet } from "@/lib/not-migrated";
import { pageSlice } from "@/lib/pagination";
import { csvRow } from "@/lib/csv";
import { workspaceClock } from "@/lib/time/workspace";
import { getPermissionDefinition, permissionGroup, PERMISSIONS } from "@/lib/permissions";
import type { ActionResult } from "@/actions/company";
import { answerWord, isPermissionChangeKind, PERMISSION_CHANGE_KIND_LABEL } from "@/components/access-control/audit/kinds";

/**
 * Settings › Access Control › Audit Logs: the permission-change log (`PermissionChange`, written by
 * src/lib/authz/audit.ts on every grant, revoke, reset, preset, role and account change), read with the
 * filters and pages an audit needs.
 *
 * `permissionChangeHistory` (src/actions/access.ts) reads the same table for one person or one role, newest
 * hundred; this is that reader with a search, who made the change, the kind, the dates and a page number.
 * Opens on `permissions.view`, exactly as it does — and the log is read-only here as everywhere: nothing in
 * this file writes a row.
 */

export type PermissionChangeFilters = {
  /** Matched against the detail text, the permission's key and label, the role, and both people's names. */
  q?: string;
  /** Who made the change. */
  actorId?: string;
  /** The person it was made on. */
  subjectUserId?: string;
  /** The role it was made on, by key. */
  role?: string;
  kind?: string;
  /** A section of the permission registry ("Finance", "Administration"…): changes to a key filed under it. */
  group?: string;
  /** YYYY-MM-DD, both ends included, on the workspace's clock. */
  from?: string;
  to?: string;
};

export type PermissionChangeRow = {
  id: string;
  changeKind: PermissionChangeKind;
  permission: string | null;
  /** The key's name in the registry, looked up when the page is drawn; null for a key since retired. */
  permissionLabel: string | null;
  fromAllowed: boolean | null;
  toAllowed: boolean | null;
  detail: string | null;
  createdAt: string;
  subjectType: PermissionSubjectType;
  subjectRole: string | null;
  /** The role's name as it is now; null once the role is gone (the log keeps its key). */
  subjectRoleName: string | null;
  actor: { id: string; name: string };
  subjectUser: { id: string; name: string } | null;
  /** Set when the change was made while viewing as `actor`: the person who really made it. */
  impersonatedByUserId: string | null;
  impersonatedByName: string | null;
};

export type PermissionChangeList = {
  rows: PermissionChangeRow[];
  total: number;
  /** Everybody who has made a change, for the "Changed by" filter. */
  actors: { id: string; name: string }[];
  /** Every account, for the "Changed for" filter. */
  people: { id: string; name: string }[];
  /** Every role, and any key the log still names after its role was deleted. */
  roles: { key: string; name: string }[];
};

const EMPTY: PermissionChangeList = { rows: [], total: 0, actors: [], people: [], roles: [] };
const EXPORT_CAP = 10_000;
const text = (value: unknown, max = 64) => String(value ?? "").trim().slice(0, max);

async function whereFor(filters: PermissionChangeFilters): Promise<Prisma.PermissionChangeWhereInput> {
  const clock = await workspaceClock();
  const range = clock.dayRange(filters.from || null, filters.to || null);
  const and: Prisma.PermissionChangeWhereInput[] = [];
  if (range) and.push({ createdAt: range });
  if (filters.actorId) and.push({ actorUserId: text(filters.actorId) });
  if (filters.subjectUserId) and.push({ subjectUserId: text(filters.subjectUserId) });
  if (filters.role) and.push({ subjectRole: text(filters.role) });
  if (isPermissionChangeKind(filters.kind)) and.push({ changeKind: filters.kind });
  if (filters.group) {
    const group = text(filters.group);
    and.push({ permission: { in: PERMISSIONS.filter((def) => permissionGroup(def) === group).map((def) => def.key) } });
  }
  const q = text(filters.q, 100);
  if (q) {
    // The log stores keys; people search by the words on the screen. So the label and the role's name are
    // turned into keys here, and the rest is matched where it is written.
    const needle = q.toLowerCase();
    const labelled = PERMISSIONS.filter((def) => def.label.toLowerCase().includes(needle)).map((def) => def.key);
    const named = await db.role.findMany({ where: { name: { contains: q, mode: "insensitive" } }, select: { key: true }, take: 50 });
    and.push({
      OR: [
        { detail: { contains: q, mode: "insensitive" } },
        { permission: { contains: q, mode: "insensitive" } },
        { subjectRole: { contains: q, mode: "insensitive" } },
        { actor: { name: { contains: q, mode: "insensitive" } } },
        { subjectUser: { name: { contains: q, mode: "insensitive" } } },
        ...(labelled.length ? [{ permission: { in: labelled } }] : []),
        ...(named.length ? [{ subjectRole: { in: named.map((r) => r.key) } }] : []),
      ],
    });
  }
  return and.length ? { AND: and } : {};
}

// The select `permissionChangeHistory` uses, so the two readers show the same facts.
const SELECT = {
  id: true,
  changeKind: true,
  permission: true,
  fromAllowed: true,
  toAllowed: true,
  detail: true,
  createdAt: true,
  subjectType: true,
  subjectRole: true,
  actor: { select: { id: true, name: true } },
  subjectUser: { select: { id: true, name: true } },
  impersonatedByUserId: true,
} satisfies Prisma.PermissionChangeSelect;

/** One page of the permission-change log, newest first, with what the filters need to offer. */
export async function listPermissionChanges(params: PermissionChangeFilters & { page?: number; pageSize?: number } = {}): Promise<PermissionChangeList> {
  const session = await requireUser();
  if (!(await can(session.id, "permissions.view"))) return EMPTY;

  const page = Math.max(1, Math.floor(Number(params.page) || 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(Number(params.pageSize) || 50)));
  try {
    const where = await whereFor(params ?? {});
    const [rows, total, actorRows, people, roles, loggedRoles] = await Promise.all([
      db.permissionChange.findMany({ where, select: SELECT, orderBy: { createdAt: "desc" }, ...pageSlice(page, pageSize) }),
      db.permissionChange.count({ where }),
      db.permissionChange.findMany({ distinct: ["actorUserId"], select: { actor: { select: { id: true, name: true } } }, take: 500 }),
      db.user.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" }, take: 2000 }),
      db.role.findMany({ select: { key: true, name: true }, orderBy: { name: "asc" } }),
      db.permissionChange.findMany({ distinct: ["subjectRole"], where: { subjectRole: { not: null } }, select: { subjectRole: true }, take: 500 }),
    ]);
    const roleName = new Map(roles.map((r) => [r.key, r.name]));
    const personName = new Map(people.map((p) => [p.id, p.name]));
    // A role deleted since still has a history; it is offered by the key the log kept.
    const gone = loggedRoles.map((r) => r.subjectRole).filter((key): key is string => !!key && !roleName.has(key));
    return {
      rows: rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        permissionLabel: r.permission ? (getPermissionDefinition(r.permission)?.label ?? null) : null,
        subjectRoleName: r.subjectRole ? (roleName.get(r.subjectRole) ?? null) : null,
        impersonatedByName: r.impersonatedByUserId ? (personName.get(r.impersonatedByUserId) ?? null) : null,
      })),
      total,
      actors: actorRows.map((r) => r.actor).sort((a, b) => a.name.localeCompare(b.name)),
      people,
      roles: [...roles, ...gone.sort().map((key) => ({ key, name: `${key} (deleted)` }))],
    };
  } catch (err) {
    if (notMigratedYet(err)) return EMPTY;
    throw err;
  }
}

/**
 * How much each log holds in a span of days — the figures on the page's cards. The unmasking log's are the
 * super admin's alone (`mayReadUnmaskLog`, the check its own reader makes); anybody else gets null for it.
 */
export type AuditLogCounts = { permissionChanges: number; unmask: Record<UnmaskResult, number> | null };

export async function auditLogCounts(span: { from?: string; to?: string } = {}): Promise<AuditLogCounts> {
  const session = await requireUser();
  if (!(await can(session.id, "permissions.view"))) return { permissionChanges: 0, unmask: null };
  const clock = await workspaceClock();
  const range = clock.dayRange(span?.from || null, span?.to || null);
  const mayReadUnmasks = await mayReadUnmaskLog();
  try {
    const [permissionChanges, byResult] = await Promise.all([
      db.permissionChange.count({ where: range ? { createdAt: range } : {} }),
      mayReadUnmasks ? db.unmaskEvent.groupBy({ by: ["result"], where: range ? { at: range } : {}, _count: { _all: true } }) : null,
    ]);
    const unmask: Record<UnmaskResult, number> | null = byResult ? { ALLOWED: 0, REPEAT: 0, QUOTA_EXHAUSTED: 0, DENIED: 0 } : null;
    if (unmask && byResult) for (const row of byResult) unmask[row.result] = row._count._all;
    return { permissionChanges, unmask };
  } catch (err) {
    if (notMigratedYet(err)) return { permissionChanges: 0, unmask: mayReadUnmasks ? { ALLOWED: 0, REPEAT: 0, QUOTA_EXHAUSTED: 0, DENIED: 0 } : null };
    throw err;
  }
}

/**
 * The filtered permission-change log as CSV, newest first.
 *
 * Reading the log is `permissions.view`; taking it out as a file is also `activity.export` — the same door
 * the activity log's export is behind (src/actions/activity.ts), since every row here is in that log too. The
 * workspace's export row limit applies, and the export is itself written to the activity log.
 */
export async function exportPermissionChangesCsv(filters: PermissionChangeFilters): Promise<ActionResult<{ csv: string; rows: number; capped: boolean }>> {
  const user = await requireUser();
  if (!(await can(user.id, "permissions.view")) || !(await hasEffectivePermission(user.id, "activity.export"))) {
    await logActivity({ kind: "PERMISSION_DENIED", summary: `${user.name} tried to export the access audit log without permission` });
    return { ok: false, error: "You can't export the access audit log." };
  }

  const where = await whereFor(filters ?? {});
  const [policy, total] = await Promise.all([getSecurityPolicy(), db.permissionChange.count({ where })]);
  const verdict = exportDecision(total, policy);
  if (!verdict.allowed) return { ok: false, error: verdict.reason };

  const [rows, roles, clock] = await Promise.all([
    db.permissionChange.findMany({ where, select: SELECT, orderBy: { createdAt: "desc" }, take: EXPORT_CAP }),
    db.role.findMany({ select: { key: true, name: true } }),
    workspaceClock(),
  ]);
  const roleName = new Map(roles.map((r) => [r.key, r.name]));
  const header = [
    "When", "Action", "Changed by", "Changed by id", "Viewing as (by)", "Changed on", "Role", "Role key", "Person", "Person id", "Permission", "Permission key", "Previous",
    "New", "Detail", "Entry id",
  ];
  const lines = rows.map((r) =>
    csvRow([
      clock.dateTime(r.createdAt),
      PERMISSION_CHANGE_KIND_LABEL[r.changeKind] ?? r.changeKind,
      r.actor.name,
      r.actor.id,
      r.impersonatedByUserId ?? "",
      r.subjectType === "USER" ? "Person" : "Role",
      r.subjectRole ? (roleName.get(r.subjectRole) ?? "") : "",
      r.subjectRole ?? "",
      r.subjectUser?.name ?? "",
      r.subjectUser?.id ?? "",
      r.permission ? (getPermissionDefinition(r.permission)?.label ?? "") : "",
      r.permission ?? "",
      r.permission ? answerWord(r.fromAllowed) : "",
      r.permission ? answerWord(r.toAllowed) : "",
      r.detail ?? "",
      r.id,
    ]),
  );
  await logActivity({
    kind: "EXPORT",
    severity: "WARNING",
    summary: `${user.name} exported ${rows.length.toLocaleString("en-IN")} access audit log rows`,
    metadata: { rows: rows.length, filters: JSON.parse(JSON.stringify(filters ?? {})) as Prisma.InputJsonValue },
  });
  return { ok: true, data: { csv: [csvRow(header), ...lines].join("\n"), rows: rows.length, capped: total > rows.length } };
}
