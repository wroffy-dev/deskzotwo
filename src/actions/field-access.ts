"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { actorContext, assertMayActOnTarget, AuthzError } from "@/lib/authz/guards";
import { roleExists } from "@/lib/authz/role-registry";
import { recordPermissionChange } from "@/lib/authz/audit";
import { notMigratedYet } from "@/lib/not-migrated";
import { recordAudit } from "@/lib/audit";
import { FIELD_MASKING_SETTINGS_ID, invalidateFieldMaskingCache } from "@/lib/authz/masking-switch";
import { SUPPORT_READONLY_ROLE, type Role } from "@/lib/roles";
import { workspaceClock } from "@/lib/time/workspace";
import { formatCalendarDay } from "@/lib/time/zone";
import { resolveFieldPolicies, resolveStoredFieldPolicies, sensitiveFieldsOf, type FieldSource } from "@/lib/authz/fields";
import { MAX_DAILY_UNMASK_LIMIT, unmaskLimitFor, unmaskUsageToday, workspaceUnmaskDefault, type UnmaskLimit, type UnmaskUsageStatus } from "@/lib/authz/unmask";
import { roleAccessLevels } from "@/actions/access-levels";
import {
  describePolicy,
  FIELD_ENTITIES,
  FIELD_ENTITY_REVEALS,
  FIELD_ENTITY_WORDS,
  formatsFor,
  isExportMode,
  isFieldEntity,
  isCustomFieldKey,
  isMaskFormat,
  normalisePolicy,
  openPolicy,
  withinPolicy,
  type FieldEntity,
  type FieldKind,
  type FieldPolicy,
  type MaskFormat,
} from "@/lib/authz/field-policy";
import type { ActionResult } from "@/actions/company";

/**
 * Field access and the daily unmask limit — the "Field Permissions" of a role and of one person
 * (src/lib/authz/field-policy.ts says what each answer means).
 *
 * The rules are the permission screens' own (src/actions/access.ts, src/actions/access-levels.ts):
 *
 *   · "Change roles and permissions" changes anything here; "Review who can do what" reads it.
 *   · Only a super admin changes what Admin gets, and nobody changes the super admin's — a super admin
 *     sees every field and has no limit, outside field access as outside every other rule.
 *   · Platform support's read-only role is fixed.
 *   · Nobody gives a role or a person a field more open than they have it themselves, nor a daily limit
 *     higher than their own: field access can't be used to see what one may not.
 *   · Every change is checked before the first is written, and every change is in the permission
 *     history.
 */

/** A record type the caller named, or leads — what every screen asked about before contacts joined. */
const entityOf = (value: unknown): FieldEntity => (isFieldEntity(value) ? value : "leads");
/** "Lead email", "Contact phone" — for the permission history. */
const fieldWords = (entity: FieldEntity, label: string) => `${FIELD_ENTITY_WORDS[entity].one.replace(/^./, (c) => c.toUpperCase())} ${label.toLowerCase()}`;

async function mayReview(userId: string): Promise<boolean> {
  return (await can(userId, "permissions.view")) || (await can(userId, "permissions.manage"));
}

async function administrator() {
  const session = await requireUser();
  const actor = await actorContext(session.id);
  const allowed = actor.isSuperAdmin || (await can(actor.id, "permissions.manage"));
  return { actor, allowed };
}

/** The midnight that ends the day chosen, on the workspace's clock — as a personal permission's expiry. */
async function expiryFromDate(date: string | null | undefined): Promise<Date | null> {
  if (!date) return null;
  return (await workspaceClock()).endOfDay(String(date));
}

/**
 * A policy from what a form sent, checked against the field's kind — or why not. Unmasking saved off for a record type
 * nothing can reveal (`FIELD_ENTITY_REVEALS`), so no rule promises a button that isn't there. Companies were one until
 * wave B gave them a "Show" (owner, 5 Nov 2026 — Phase 3 masking fixes): every record type reveals now, and their unmask
 * is saved as sent.
 */
function readPolicy(kind: FieldKind, raw: unknown, entity: FieldEntity): FieldPolicy | string {
  const read = readPolicyOf(kind, raw);
  return typeof read === "string" || FIELD_ENTITY_REVEALS[entity] ? read : { ...read, unmask: false };
}

function readPolicyOf(kind: FieldKind, raw: unknown): FieldPolicy | string {
  if (!raw || typeof raw !== "object") return "That isn't a field policy.";
  const r = raw as Record<string, unknown>;
  const flags = ["view", "maskInList", "maskInDetail", "unmask"] as const;
  for (const f of flags) if (typeof r[f] !== "boolean") return "That isn't a field policy.";
  if (r.format !== undefined && r.format !== null && (!isMaskFormat(r.format) || !formatsFor(kind).includes(r.format))) {
    return "That mask doesn't suit this field.";
  }
  // How it is exported (owner, 5 Nov 2026 — audit H.4.4): absent or null is as the list, as before the column existed.
  if (r.export !== undefined && r.export !== null && !isExportMode(r.export)) return "That isn't a way to export a field.";
  return normalisePolicy(kind, {
    view: r.view as boolean,
    maskInList: r.maskInList as boolean,
    maskInDetail: r.maskInDetail as boolean,
    unmask: r.unmask as boolean,
    format: (r.format as string | null | undefined) ?? null,
    export: (r.export as string | null | undefined) ?? null,
  });
}

function samePolicy(a: FieldPolicy | null, b: FieldPolicy | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const LIMIT_WORDS = (limit: number | null) => (limit === null ? "no limit" : `${limit} a day`);

/**
 * What a role's people get with no limit row on the role (owner, 5 Nov 2026 — Phase 3 masking fixes: the workspace
 * default, audit M-10): the workspace's default, for each of them who may unmask anything. In words, for the history.
 */
const DEFAULT_WORDS = (limit: number | null) => `the workspace default (${LIMIT_WORDS(limit)})`;

function readLimit(raw: unknown): number | null | string {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1) return "A daily limit is a whole number of leads, at least 1.";
  if (n > MAX_DAILY_UNMASK_LIMIT) return `A daily limit can be at most ${MAX_DAILY_UNMASK_LIMIT.toLocaleString("en-IN")} leads.`;
  return n;
}

/** Nobody sets a limit above their own (none counts as above every number). */
function limitWithin(next: number | null, own: number | null): boolean {
  if (own === null) return true;
  return next !== null && next <= own;
}

// ─── What a role gives ────────────────────────────────────────────────────────────────────────────

export type FieldAccessRow = {
  key: string;
  label: string;
  description: string;
  kind: FieldKind;
  custom: boolean;
  formats: MaskFormat[];
  /** What was saved here (the role's row, or the person's own), or null where it follows the default. */
  stored: FieldPolicy | null;
  /** What it is without a row here: open for a role, the role's for a person. */
  inherited: FieldPolicy;
  effective: FieldPolicy;
  /** Where the effective answer comes from, in words. */
  why: string;
  /** A person's own row: why and until when. */
  override?: { reason: string | null; expiresAt: string | null; grantedBy: string | null } | null;
};

export type RoleFieldAccess = {
  rows: FieldAccessRow[];
  dailyLimit: number | null;
  /** The role has a limit row at all — "no limit" stored is different from nothing stored. */
  limitStored: boolean;
  /**
   * The workspace's default daily limit — what the role's people who may unmask anything get while `limitStored` is false
   * (owner, 5 Nov 2026 — Phase 3 masking fixes; src/lib/authz/unmask.ts `workspaceUnmaskDefault`). Null: no limit.
   */
  workspaceDefault: number | null;
  editable: boolean;
  why: string | null;
  /** Doors masking leaves open for this role, in words — the contacts, companies, calls and visits they still reach. */
  warnings: string[];
};

async function storedRolePolicies(role: string, entity: FieldEntity) {
  try {
    const [rows, limit] = await Promise.all([
      db.roleFieldPolicy.findMany({ where: { role, entity: entity }, select: { field: true, view: true, maskInList: true, maskInDetail: true, unmask: true, format: true, export: true } }),
      db.roleUnmaskLimit.findUnique({ where: { role }, select: { dailyLimit: true } }),
    ]);
    return { rows, limit };
  } catch (err) {
    if (notMigratedYet(err)) return { rows: [], limit: null };
    throw err;
  }
}

export async function roleFieldAccess(role: string, forEntity: FieldEntity = "leads"): Promise<RoleFieldAccess | null> {
  const entity = entityOf(forEntity);
  const session = await requireUser();
  const actor = await actorContext(session.id);
  if (!actor.isSuperAdmin && !(await mayReview(actor.id))) return null;
  if (!(await roleExists(role))) return null;

  const [fields, stored] = await Promise.all([sensitiveFieldsOf(entity), storedRolePolicies(role, entity)]);
  const byField = new Map(stored.rows.map((r) => [r.field, r]));
  const rows: FieldAccessRow[] = fields.map((f) => {
    const row = byField.get(f.key);
    const policy = row ? normalisePolicy(f.kind, row) : null;
    return {
      key: f.key,
      label: f.label,
      description: f.description,
      kind: f.kind,
      custom: isCustomFieldKey(f.key),
      formats: formatsFor(f.kind),
      stored: policy,
      inherited: openPolicy(f.kind),
      effective: policy ?? openPolicy(f.kind),
      why: policy ? `Set on this role: ${describePolicy(policy, entity)}.` : "Nothing set — visible and unmasked, as before field access.",
    };
  });

  const mayManage = actor.isSuperAdmin || (await can(actor.id, "permissions.manage"));
  const why = !mayManage
    ? "You can review roles but not change them."
    : role === "ADMIN" && !actor.isSuperAdmin
      ? "Only a super admin can change what admins can do."
      : role === SUPPORT_READONLY_ROLE
        ? "Platform support's read-only access is fixed."
        : null;

  return {
    rows,
    dailyLimit: stored.limit?.dailyLimit ?? null,
    limitStored: stored.limit !== null,
    workspaceDefault: (await workspaceUnmaskDefault()).dailyLimit,
    editable: why === null,
    why,
    warnings: entity === "leads" ? await roleWarnings(role, rows) : [],
  };
}

/**
 * What masking a lead's contact or company leaves reachable another way. A lead's email and phone are
 * its contact's, and its company is a company: a role that still opens contacts and companies — or the
 * calls and visits made with them — sees them there, on their own screens, where lead field access
 * doesn't reach. Said, rather than silently widened into rules about other records.
 */
async function roleWarnings(role: string, rows: FieldAccessRow[]): Promise<string[]> {
  const concealed = (key: string) => {
    const p = rows.find((r) => r.key === key)?.effective;
    return p ? !p.view || p.maskInList || p.maskInDetail : false;
  };
  const grid = await roleAccessLevels(role);
  if (!grid) return [];
  const viewOf = (record: string) => {
    const cell = grid.rows.find((r) => r.key === record)?.cells.view;
    return cell ? (cell.stored ?? cell.derived) : "NONE";
  };
  const out: string[] = [];
  if ((concealed("email") || concealed("phone") || concealed("contactName")) && viewOf("contacts") !== "NONE") {
    out.push("This role can still open contacts (Data Scope › Contacts), where a lead's contact, email and phone are shown unmasked. Set Contacts to None to close that.");
  }
  // A company's address has rules of its own since 5 Nov 2026 (owner — Phase 3 masking fixes, the Companies card): said
  // only while this role's leave it open. Its name never is masked — it is the record's identity.
  const companyAddress = (await storedRolePolicies(role, "companies")).rows.find((r) => r.field === "address");
  const companyAddressOpen = !companyAddress || (companyAddress.view && !companyAddress.maskInList && !companyAddress.maskInDetail);
  if ((concealed("companyName") || (concealed("address") && companyAddressOpen)) && viewOf("companies") !== "NONE") {
    out.push(
      companyAddressOpen
        ? "This role can still open customers (Data Scope › Customers & companies), whose name and address are shown there unmasked. Mask the address under Companies here."
        : "This role can still open customers (Data Scope › Customers & companies), whose name is shown there unmasked.",
    );
  }
  // Calls and visits are records of their own, made with an account: they name the account, the person
  // called and the number, and a visit the address it was made at.
  if ((concealed("companyName") || concealed("contactName") || concealed("phone")) && viewOf("activities") !== "NONE") {
    out.push("This role can still see calls, notes & meetings (Data Scope › Calls, notes & meetings), which name the account, the person called and the number dialled.");
  }
  if ((concealed("companyName") || concealed("address")) && viewOf("visits") !== "NONE") {
    out.push("This role can still see field visits (Data Scope › Field visits), which name the account and the address visited.");
  }
  return out;
}

export type FieldPolicyChange = { field: string; policy: FieldPolicy | null };

/** Saves a role's field policies. `policy: null` puts a field back to nothing set. All or nothing. */
export async function setRoleFieldAccess(role: string, changes: FieldPolicyChange[], forEntity: FieldEntity = "leads"): Promise<ActionResult<{ changed: number }>> {
  const entity = entityOf(forEntity);
  const { actor, allowed } = await administrator();
  if (!allowed) return { ok: false, error: "You can't change role permissions." };
  if (role === "ADMIN" && !actor.isSuperAdmin) return { ok: false, error: "Only a super admin can change what admins can do." };
  if (role === SUPPORT_READONLY_ROLE) return { ok: false, error: "Platform support's read-only access can't be changed." };
  if (!(await roleExists(role))) return { ok: false, error: "That role no longer exists." };

  const [fields, stored, own] = await Promise.all([sensitiveFieldsOf(entity), storedRolePolicies(role, entity), resolveStoredFieldPolicies(actor.id, entity)]);
  const fieldOf = new Map(fields.map((f) => [f.key, f]));
  const before = new Map(stored.rows.map((r) => [r.field, normalisePolicy(fieldOf.get(r.field)?.kind ?? "text", r)]));

  type Write = { field: string; label: string; before: FieldPolicy | null; after: FieldPolicy | null };
  const writes: Write[] = [];
  for (const change of Array.isArray(changes) ? changes : []) {
    const field = fieldOf.get(String(change?.field ?? ""));
    if (!field) return { ok: false, error: "That isn't a field field access covers." };
    let after: FieldPolicy | null = null;
    if (change.policy !== null) {
      const read = readPolicy(field.kind, change.policy, entity);
      if (typeof read === "string") return { ok: false, error: `${field.label}: ${read}` };
      after = read;
    }
    /**
     * Measured on what the role is left with, as the person path measures it (`setPersonFieldAccess`):
     * a reset (`policy: null`) leaves the field with nothing set — visible and unmasked — so it is
     * held to the same rule as setting that outright. It skipped the check, and an admin whose own
     * email is masked could open email for any role but Admin (owner, 2 Nov 2026 — Phase 1 security
     * fixes, audit M-7).
     */
    const resulting = after ?? openPolicy(field.kind);
    if (!actor.isSuperAdmin) {
      const mine = own.fields.get(field.key)?.policy ?? openPolicy(field.kind);
      if (!withinPolicy(resulting, mine)) {
        return { ok: false, error: `You can't give a role more of ${field.label} than you have yourself.` };
      }
    }
    const was = before.get(field.key) ?? null;
    if (samePolicy(was, after)) continue;
    writes.push({ field: field.key, label: field.label, before: was, after });
  }
  if (writes.length === 0) return { ok: true, data: { changed: 0 } };

  await db.$transaction(async (tx) => {
    for (const w of writes) {
      if (w.after === null) {
        await tx.roleFieldPolicy.deleteMany({ where: { role, entity: entity, field: w.field } });
      } else {
        const data = { ...w.after, updatedById: actor.id };
        await tx.roleFieldPolicy.upsert({
          where: { role_entity_field: { role, entity: entity, field: w.field } },
          update: data,
          create: { role, entity: entity, field: w.field, ...data },
        });
      }
    }
  });

  for (const w of writes) {
    await recordPermissionChange({
      actorUserId: actor.id,
      subjectType: "ROLE",
      subjectRole: role as Role,
      permission: `field:${entity}:${w.field}`,
      changeKind: w.after === null ? "RESET_TO_DEFAULT" : "GRANT",
      detail: `${fieldWords(entity, w.label)} for ${role}: ${w.before ? describePolicy(w.before, entity) : "visible (nothing set)"} → ${w.after ? describePolicy(w.after, entity) : "visible (nothing set)"}`,
    });
  }
  revalidatePath("/settings", "layout");
  revalidatePath("/", "layout");
  return { ok: true, data: { changed: writes.length } };
}

/**
 * A role's daily unmask limit: a number of records a day, null for an explicit "no limit", or "default" to take the role's
 * row away so its people follow the workspace's default again (owner, 5 Nov 2026 — Phase 3 masking fixes: since the
 * default (audit M-10) nothing set is no longer "no limit", and once a number or "no limit" was saved there was no way
 * back to it). Going back to the default is held to the same rule as setting it outright — no higher than your own.
 */
export async function setRoleUnmaskLimit(role: string, dailyLimit: unknown): Promise<ActionResult<null>> {
  const { actor, allowed } = await administrator();
  if (!allowed) return { ok: false, error: "You can't change role permissions." };
  if (role === "ADMIN" && !actor.isSuperAdmin) return { ok: false, error: "Only a super admin can change what admins can do." };
  if (role === SUPPORT_READONLY_ROLE) return { ok: false, error: "Platform support's read-only access can't be changed." };
  if (!(await roleExists(role))) return { ok: false, error: "That role no longer exists." };
  const toDefault = dailyLimit === "default";
  const limit = toDefault ? null : readLimit(dailyLimit);
  if (typeof limit === "string") return { ok: false, error: limit };
  const fallback = (await workspaceUnmaskDefault()).dailyLimit;
  const resulting = toDefault ? fallback : limit;
  if (!actor.isSuperAdmin && !limitWithin(resulting, (await unmaskLimitFor(actor.id)).dailyLimit)) {
    return { ok: false, error: "You can't give a role a higher daily limit than your own." };
  }
  const before = (await storedRolePolicies(role, "leads")).limit;
  if (toDefault ? !before : before && before.dailyLimit === limit) return { ok: true, data: null };
  if (toDefault) await db.roleUnmaskLimit.deleteMany({ where: { role } });
  else await db.roleUnmaskLimit.upsert({ where: { role }, update: { dailyLimit: limit, updatedById: actor.id }, create: { role, dailyLimit: limit, updatedById: actor.id } });
  await recordPermissionChange({
    actorUserId: actor.id,
    subjectType: "ROLE",
    subjectRole: role as Role,
    permission: "unmask:dailyLimit",
    changeKind: toDefault ? "RESET_TO_DEFAULT" : "GRANT",
    detail: `Daily unmask limit for ${role}: ${before ? LIMIT_WORDS(before.dailyLimit) : DEFAULT_WORDS(fallback)} → ${toDefault ? DEFAULT_WORDS(fallback) : LIMIT_WORDS(limit)}`,
  });
  revalidatePath("/settings", "layout");
  return { ok: true, data: null };
}

// ─── One person ───────────────────────────────────────────────────────────────────────────────────

export type PersonFieldAccess = {
  rows: FieldAccessRow[];
  limit: {
    /** What applies to them now. */
    effective: number | null;
    /** Their own limit, or null where they follow their role. */
    own: { limited: boolean; dailyLimit: number | null; reason: string | null; expiresAt: string | null } | null;
    /** Their role's row: a number, or null for its "no limit" — or for no row at all (`roleStored`). */
    role: number | null;
    /** Whether their role has a limit row; without one the workspace default applies (owner, 5 Nov 2026 — audit M-10). */
    roleStored: boolean;
    /** The workspace's default daily limit (null: no limit). */
    workspaceDefault: number | null;
    /** What they get without a limit of their own: their role's row, else the workspace default if they may unmask anything, else none. */
    inherited: number | null;
    /** Where `inherited` comes from: their role's row, the workspace default, or nothing to count. */
    inheritedFrom: "role" | "workspaceDefault" | "none";
    why: string;
  };
  usage: UnmaskUsageStatus;
  /** The workspace's zone — the midnight the limit resets at. */
  zone: string;
  editable: boolean;
  why: string | null;
};

function sourceWords(source: FieldSource, day: (d: Date) => string): string {
  switch (source.via) {
    case "superAdmin":
      return "Super admin — sees every field.";
    case "inactive":
      return "Their account or role is switched off.";
    case "userPolicy":
      return `Set for them personally${source.reason ? ` — ${source.reason}` : ""}${source.expiresAt ? `, until ${day(new Date(source.expiresAt.getTime() - 1))}` : ""}.`;
    case "rolePolicy":
      return `From their role (${source.role}).`;
    case "default":
      return "Nothing set — visible and unmasked.";
  }
}

/**
 * Where a person's daily limit comes from, in words. Nothing set on them or their role is the workspace's default for
 * somebody who may unmask anything (owner, 5 Nov 2026 — Phase 3 masking fixes, audit M-10) — saying "no limit set" there
 * told an admin the opposite of what applies.
 */
function limitWords(limit: UnmaskLimit): string {
  switch (limit.source.via) {
    case "superAdmin":
      return "Super admin — no limit.";
    case "userLimit":
      return `Set for them personally${limit.source.reason ? ` — ${limit.source.reason}` : ""}.`;
    case "roleLimit":
      return `From their role (${limit.source.role}).`;
    case "none":
      return limit.source.workspaceDefault
        ? `Nothing set on them or their role: the workspace default applies (${LIMIT_WORDS(limit.dailyLimit)}).`
        : "Nothing set on them or their role, and nothing they may unmask — so nothing to count.";
  }
}

/**
 * Whether this person may unmask any field of any record type, as their rules are stored — whom the workspace default
 * applies to. The same question src/lib/authz/unmask.ts asks (`mayUnmaskAnything`), asked here for somebody with a limit
 * of their own, whose resolved limit doesn't say what they would get without it.
 */
async function mayUnmaskSomething(userId: string): Promise<boolean> {
  for (const entity of FIELD_ENTITIES) {
    const resolved = await resolveStoredFieldPolicies(userId, entity);
    for (const f of resolved.fields.values()) if (f.policy.view && f.policy.unmask) return true;
  }
  return false;
}

export async function personFieldAccess(userId: string, forEntity: FieldEntity = "leads"): Promise<PersonFieldAccess | null> {
  const entity = entityOf(forEntity);
  const session = await requireUser();
  if (userId !== session.id && !(await mayReview(session.id))) return null;
  const target = await db.user.findUnique({ where: { id: userId }, select: { id: true, role: true, isSuperAdmin: true } });
  if (!target) return null;

  const [fields, resolved, clock, limit, usage] = await Promise.all([
    sensitiveFieldsOf(entity),
    resolveFieldPolicies(userId, entity),
    workspaceClock(),
    unmaskLimitFor(userId),
    unmaskUsageToday(userId),
  ]);
  const day = (d: Date) => formatCalendarDay(clock.calendarDate(d));
  let own: Awaited<ReturnType<typeof db.userFieldPolicy.findMany>> = [];
  let ownLimit: Awaited<ReturnType<typeof db.userUnmaskLimit.findUnique>> = null;
  let roleRows: { field: string; view: boolean; maskInList: boolean; maskInDetail: boolean; unmask: boolean; format: string | null; export: string | null }[] = [];
  let roleLimitRow: { dailyLimit: number | null } | null = null;
  try {
    [own, ownLimit, roleRows, roleLimitRow] = await Promise.all([
      db.userFieldPolicy.findMany({ where: { userId, entity: entity } }),
      db.userUnmaskLimit.findUnique({ where: { userId } }),
      db.roleFieldPolicy.findMany({ where: { role: target.role, entity: entity }, select: { field: true, view: true, maskInList: true, maskInDetail: true, unmask: true, format: true, export: true } }),
      db.roleUnmaskLimit.findUnique({ where: { role: target.role }, select: { dailyLimit: true } }),
    ]);
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  const roleLimit = roleLimitRow?.dailyLimit ?? null;
  // What they would get without a limit of their own (owner, 5 Nov 2026 — Phase 3 masking fixes): their role's row, else
  // the workspace default if they may unmask anything — the resolved limit already says so when they follow their role.
  const workspaceDefault = (await workspaceUnmaskDefault()).dailyLimit;
  const followsRole = limit.source.via !== "userLimit";
  const inheritedFrom: "role" | "workspaceDefault" | "none" = target.isSuperAdmin
    ? "none"
    : roleLimitRow
      ? "role"
      : (followsRole ? limit.source.via === "none" && limit.source.workspaceDefault === true : await mayUnmaskSomething(userId))
        ? "workspaceDefault"
        : "none";
  const inherited = inheritedFrom === "role" ? roleLimit : inheritedFrom === "workspaceDefault" ? workspaceDefault : null;
  const grantedByIds = [...new Set(own.map((r) => r.grantedById).filter((id): id is string => Boolean(id)))];
  const granters = new Map((await db.user.findMany({ where: { id: { in: grantedByIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const ownBy = new Map(own.map((r) => [r.field, r]));
  const roleBy = new Map(roleRows.map((r) => [r.field, r]));
  const now = Date.now();

  const rows: FieldAccessRow[] = fields.map((f) => {
    const mine = ownBy.get(f.key);
    const live = mine && (mine.expiresAt === null || mine.expiresAt.getTime() > now) ? mine : null;
    const fromRole = roleBy.get(f.key);
    const resolvedField = resolved.fields.get(f.key);
    return {
      key: f.key,
      label: f.label,
      description: f.description,
      kind: f.kind,
      custom: isCustomFieldKey(f.key),
      formats: formatsFor(f.kind),
      stored: live ? normalisePolicy(f.kind, live) : null,
      inherited: fromRole ? normalisePolicy(f.kind, fromRole) : openPolicy(f.kind),
      effective: resolvedField?.policy ?? openPolicy(f.kind),
      why: resolvedField ? sourceWords(resolvedField.source, day) : "Nothing set — visible and unmasked.",
      override: mine
        ? { reason: mine.reason, expiresAt: mine.expiresAt ? mine.expiresAt.toISOString() : null, grantedBy: mine.grantedById ? (granters.get(mine.grantedById) ?? null) : null }
        : null,
    };
  });

  const mayManage = (await can(session.id, "permissions.manage")) || (await actorContext(session.id)).isSuperAdmin;
  const why = !mayManage
    ? "You can review access but not change it."
    : target.isSuperAdmin
      ? "A super admin sees every field and has no limit; there is nothing to set."
      : target.id === session.id
        ? "Your own field access is changed by another admin."
        : null;

  return {
    rows,
    limit: {
      effective: limit.dailyLimit,
      own: ownLimit ? { limited: ownLimit.limited, dailyLimit: ownLimit.dailyLimit, reason: ownLimit.reason, expiresAt: ownLimit.expiresAt ? ownLimit.expiresAt.toISOString() : null } : null,
      role: roleLimit,
      roleStored: roleLimitRow !== null,
      workspaceDefault,
      inherited,
      inheritedFrom,
      why: limitWords(limit),
    },
    usage,
    zone: clock.zone,
    editable: why === null,
    why,
  };
}

/** The checks every change to one person's field access or limit makes, before anything is written. */
type Checked = { error: string } | { actor: Awaited<ReturnType<typeof actorContext>>; target: { id: string; name: string; isSuperAdmin: boolean } };

async function personTarget(userId: string): Promise<Checked> {
  const { actor, allowed } = await administrator();
  if (!allowed) return { error: "You can't change permissions." };
  const target = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, isSuperAdmin: true } });
  if (!target) return { error: "That user no longer exists." };
  try {
    assertMayActOnTarget(actor, target);
  } catch (err) {
    if (err instanceof AuthzError) return { error: err.message };
    throw err;
  }
  if (target.isSuperAdmin) return { error: `${target.name} is a super admin and sees every field already.` };
  // Nobody changes their own: narrowing yourself is harmless, but widening yourself is the thing this
  // whole screen exists to stop, and telling the two apart per click is how a rule grows a hole.
  if (target.id === actor.id) return { error: "You can't change your own field access. Ask another admin." };
  return { actor, target };
}

/**
 * Sets or clears one person's own policies. `policy: null` puts a field back to their role's. Each
 * resulting answer must be no more open than the admin's own for that field.
 */
export async function setPersonFieldAccess(
  userId: string,
  changes: FieldPolicyChange[],
  options: { reason?: string; expiresAt?: string | null } = {},
  forEntity: FieldEntity = "leads",
): Promise<ActionResult<{ changed: number }>> {
  const entity = entityOf(forEntity);
  const checked = await personTarget(userId);
  if ("error" in checked) return { ok: false, error: checked.error };
  const { actor, target } = checked;

  const [fields, own, current] = await Promise.all([sensitiveFieldsOf(entity), resolveStoredFieldPolicies(actor.id, entity), personFieldAccess(userId, entity)]);
  if (!current) return { ok: false, error: "That user no longer exists." };
  const fieldOf = new Map(fields.map((f) => [f.key, f]));
  const rowOf = new Map(current.rows.map((r) => [r.key, r]));
  const expiresAt = await expiryFromDate(options.expiresAt);
  const reason = options.reason?.trim().slice(0, 500) || null;

  type Write = { field: string; label: string; before: FieldPolicy | null; after: FieldPolicy | null; resulting: FieldPolicy };
  const writes: Write[] = [];
  for (const change of Array.isArray(changes) ? changes : []) {
    const field = fieldOf.get(String(change?.field ?? ""));
    const row = field ? rowOf.get(field.key) : undefined;
    if (!field || !row) return { ok: false, error: "That isn't a field field access covers." };
    let after: FieldPolicy | null = null;
    if (change.policy !== null) {
      const read = readPolicy(field.kind, change.policy, entity);
      if (typeof read === "string") return { ok: false, error: `${field.label}: ${read}` };
      after = read;
    }
    const resulting = after ?? row.inherited;
    const mine = own.fields.get(field.key)?.policy ?? openPolicy(field.kind);
    if (!actor.isSuperAdmin && !withinPolicy(resulting, mine)) {
      return { ok: false, error: `You can't give ${target.name} more of ${field.label} than you have yourself.` };
    }
    if (samePolicy(row.stored, after) && (after === null || options.expiresAt === undefined)) continue;
    writes.push({ field: field.key, label: field.label, before: row.stored, after, resulting });
  }
  if (writes.length === 0) return { ok: true, data: { changed: 0 } };

  await db.$transaction(async (tx) => {
    for (const w of writes) {
      if (w.after === null) {
        await tx.userFieldPolicy.deleteMany({ where: { userId, entity: entity, field: w.field } });
      } else {
        const data = { ...w.after, reason, grantedById: actor.id, expiresAt };
        await tx.userFieldPolicy.upsert({
          where: { user_entity_field: { userId, entity: entity, field: w.field } },
          update: data,
          create: { userId, entity: entity, field: w.field, ...data },
        });
      }
    }
  });

  for (const w of writes) {
    await recordPermissionChange({
      actorUserId: actor.id,
      subjectType: "USER",
      subjectUserId: userId,
      permission: `field:${entity}:${w.field}`,
      changeKind: w.after === null ? "RESET_TO_DEFAULT" : "GRANT",
      detail: `${fieldWords(entity, w.label)} for ${target.name}: ${describePolicy(w.after ?? w.resulting, entity)}${w.after === null ? " (back to their role)" : ""}${reason ? ` — ${reason}` : ""}`,
    });
  }
  revalidatePath("/settings", "layout");
  revalidatePath("/", "layout");
  return { ok: true, data: { changed: writes.length } };
}

/**
 * One person's own daily limit: `{ limited: false }` lifts it, `{ limited: true, dailyLimit }` sets it,
 * null puts them back on their role's.
 */
export async function setPersonUnmaskLimit(
  userId: string,
  value: { limited: boolean; dailyLimit?: unknown } | null,
  options: { reason?: string; expiresAt?: string | null } = {},
): Promise<ActionResult<null>> {
  const checked = await personTarget(userId);
  if ("error" in checked) return { ok: false, error: checked.error };
  const { actor, target } = checked;

  let next: { limited: boolean; dailyLimit: number | null } | null = null;
  if (value !== null) {
    if (!value || typeof value.limited !== "boolean") return { ok: false, error: "Choose whether a daily limit applies." };
    if (value.limited) {
      const limit = readLimit(value.dailyLimit);
      if (typeof limit === "string") return { ok: false, error: limit };
      if (limit === null) return { ok: false, error: "Enter how many leads a day." };
      next = { limited: true, dailyLimit: limit };
    } else {
      next = { limited: false, dailyLimit: null };
    }
  }

  const current = await personFieldAccess(userId);
  if (!current) return { ok: false, error: "That user no longer exists." };
  // Back to their role's is what their role's row gives — or, with none, the workspace default (owner, 5 Nov 2026): it was
  // measured as "no limit" there, and an admin with a limit of their own couldn't put anybody back.
  const resulting = next ? (next.limited ? next.dailyLimit : null) : current.limit.inherited;
  if (!actor.isSuperAdmin && !limitWithin(resulting, (await unmaskLimitFor(actor.id)).dailyLimit)) {
    return { ok: false, error: `You can't give ${target.name} a higher daily limit than your own.` };
  }

  const reason = options.reason?.trim().slice(0, 500) || null;
  if (next === null) {
    await db.userUnmaskLimit.deleteMany({ where: { userId } });
  } else {
    const data = { ...next, reason, grantedById: actor.id, expiresAt: await expiryFromDate(options.expiresAt) };
    await db.userUnmaskLimit.upsert({ where: { userId }, update: data, create: { userId, ...data } });
  }
  await recordPermissionChange({
    actorUserId: actor.id,
    subjectType: "USER",
    subjectUserId: userId,
    permission: "unmask:dailyLimit",
    changeKind: next === null ? "RESET_TO_DEFAULT" : "GRANT",
    detail: `Daily unmask limit for ${target.name}: ${LIMIT_WORDS(resulting)}${next === null ? (current.limit.inheritedFrom === "workspaceDefault" ? " (back to the workspace default)" : " (back to their role)") : ""}${reason ? ` — ${reason}` : ""}`,
  });
  revalidatePath("/settings", "layout");
  return { ok: true, data: null };
}

/** Field masking's master switch, as the Roles & Permissions page draws it. */
export type FieldMaskingState = { enabled: boolean; mayChange: boolean; changedAtText: string | null; changedBy: string | null };

export async function fieldMaskingState(): Promise<FieldMaskingState> {
  const session = await requireUser();
  const actor = await actorContext(session.id);
  let row: { enabled: boolean; updatedAt: Date; updatedById: string | null } | null = null;
  try {
    row = await db.fieldMaskingSettings.findUnique({ where: { id: FIELD_MASKING_SETTINGS_ID }, select: { enabled: true, updatedAt: true, updatedById: true } });
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  const [by, clock] = await Promise.all([row?.updatedById ? db.user.findUnique({ where: { id: row.updatedById }, select: { name: true } }) : null, workspaceClock()]);
  return { enabled: row?.enabled ?? true, mayChange: actor.isSuperAdmin, changedAtText: row ? clock.dateTime(row.updatedAt) : null, changedBy: by?.name ?? null };
}

/**
 * Switches field masking on or off for the whole workspace (owner, 30 Oct 2026). A super admin's alone: off
 * widens what every role and person sees at once, past anything a role editor could grant, and a super admin
 * already sees everything in the clear. The rules themselves are left exactly as they are.
 */
export async function setFieldMasking(enabled: boolean): Promise<ActionResult<null>> {
  const session = await requireUser();
  const actor = await actorContext(session.id);
  if (!actor.isSuperAdmin) return { ok: false, error: "Only a super admin can switch field masking on or off." };
  if (typeof enabled !== "boolean") return { ok: false, error: "On or off?" };
  try {
    await db.fieldMaskingSettings.upsert({
      where: { id: FIELD_MASKING_SETTINGS_ID },
      create: { id: FIELD_MASKING_SETTINGS_ID, enabled, updatedById: actor.id },
      update: { enabled, updatedById: actor.id },
    });
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: "This workspace is still being updated. Try again in a few minutes." };
    throw err;
  }
  invalidateFieldMaskingCache();
  await recordAudit({
    userId: actor.id,
    action: "UPDATE",
    entityType: "FieldMaskingSettings",
    entityId: FIELD_MASKING_SETTINGS_ID,
    entityLabel: enabled ? "Field masking switched on — the masking rules apply" : "Field masking switched off — masked fields show in the clear",
  });
  revalidatePath("/settings/access", "layout");
  revalidatePath("/settings/users");
  return { ok: true, data: null };
}
