import { cache } from "react";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { resolveUserPermissions } from "@/lib/authz/resolve";
import { roleIsActive } from "@/lib/authz/role-registry";
import { fieldMaskingEnabled } from "@/lib/authz/masking-switch";
import { definitionsFor } from "@/lib/custom-fields/server";
import {
  closedPolicy,
  customFieldKey,
  customFieldKind,
  exportVisibility,
  formatsFor,
  normalisePolicy,
  openPolicy,
  presentValue,
  SENSITIVE_FIELDS,
  visibility,
  type FieldContext,
  type FieldEntity,
  type FieldKind,
  type FieldPolicy,
  type FieldVisibility,
  type MaskFormat,
  type SensitiveField,
} from "@/lib/authz/field-policy";

/**
 * Field access, resolved for one person — the server half of src/lib/authz/field-policy.ts, which
 * says what the four answers mean and the order they are decided in.
 *
 * Read once per request (React `cache`), as permissions and record levels are; outside a request (a
 * script, a check suite) nothing is memoised, so a change is seen by the next question. A workspace
 * whose database hasn't got the policy tables yet reads as having none stored — every field open.
 */

export type FieldSource =
  | { via: "superAdmin" }
  | { via: "inactive" }
  | { via: "userPolicy"; reason: string | null; expiresAt: Date | null }
  | { via: "rolePolicy"; role: string }
  | { via: "default" };

export type ResolvedField = { field: SensitiveField; policy: FieldPolicy; source: FieldSource };

export type ResolvedFieldPolicies = {
  userId: string;
  /** Field key → its policy and where it came from, for every field the entity has. */
  fields: Map<string, ResolvedField>;
  /** Whether anything is masked or restricted anywhere — false is the common case, and the fast path. */
  narrowed: boolean;
  /** Field masking's master switch (src/lib/authz/masking-switch.ts): off, nothing here is masked. */
  maskingOn: boolean;
};

/** The sensitive fields of one record type: the built-in ones, then its live custom fields. */
export async function sensitiveFieldsOf(entity: FieldEntity): Promise<SensitiveField[]> {
  const builtIn = SENSITIVE_FIELDS.filter((f) => f.entity === entity);
  // Companies' own fields too (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.1): the Companies set, not a vendor's.
  const defs = await definitionsFor(entity === "contacts" ? "CONTACT" : entity === "companies" ? "COMPANY" : "LEAD");
  const custom: SensitiveField[] = defs
    .filter((d) => !d.archived)
    .map((d) => ({
      entity,
      key: customFieldKey(d.key),
      label: d.label,
      description: d.restricted ? "A restricted custom field — also needs “See restricted fields”." : `A custom field on ${entity}.`,
      kind: customFieldKind(d.type),
    }));
  return [...builtIn, ...custom];
}

type StoredPolicy = { field: string; view: boolean; maskInList: boolean; maskInDetail: boolean; unmask: boolean; format: string | null; export: string | null };

/** The columns a policy is read with — `export` since 5 Nov 2026 (owner — Phase 3 masking fixes, audit H.4.4). */
const POLICY_COLUMNS = { field: true, view: true, maskInList: true, maskInDetail: true, unmask: true, format: true, export: true } as const;

async function storedPolicies(userId: string, role: string, entity: FieldEntity) {
  try {
    const [personal, forRole] = await Promise.all([
      db.userFieldPolicy.findMany({
        where: { userId, entity, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        select: { ...POLICY_COLUMNS, reason: true, expiresAt: true },
      }),
      db.roleFieldPolicy.findMany({
        where: { role, entity },
        select: POLICY_COLUMNS,
      }),
    ]);
    return { personal, forRole };
  } catch (err) {
    if (notMigratedYet(err)) return { personal: [], forRole: [] };
    throw err;
  }
}

/** Whether a policy narrows anything anywhere — read, a list, the record's page, or an export (`export` none or masked). */
function narrows(policy: FieldPolicy): boolean {
  return !policy.view || policy.maskInList || policy.maskInDetail || policy.export === "none" || policy.export === "masked";
}

/**
 * Masking switched off for the workspace: a masked field shows in the clear, with nothing left to unmask — in an export
 * too ("masked" goes back to the list's answer, which is now clear). Whether it can be seen at all is a different
 * question, and stays the rule's: restricted is restricted, and "left out of exports" is left out.
 */
function switchedOff(policy: FieldPolicy): FieldPolicy {
  if (!policy.view) return policy;
  return { ...policy, maskInList: false, maskInDetail: false, unmask: false, export: policy.export === "masked" ? null : policy.export };
}

/**
 * Whom a screen everybody looks at is masked as (owner, 5 Nov 2026 — Phase 3 masking fixes, audit M-13 and H.5): not a
 * person. The office TV's wins wall is read by whoever walks past it, so masking it as the person who paired it — an
 * admin, as often as not — showed every won deal's words in the clear. Asked of the resolver in place of a user id, it
 * is the most restrictive answer, field by field, of everybody who uses the workspace (`strictestEntity`).
 */
export const SHARED_SCREEN_VIEWER = "shared-screen:most-restrictive";

/** The stricter of two answers for one field: restricted over masked over clear; masked two ways, fully hidden. */
function stricter(kind: FieldKind, a: FieldPolicy, b: FieldPolicy): FieldPolicy {
  if (!a.view || !b.view) return closedPolicy(kind);
  const maskInList = a.maskInList || b.maskInList;
  const maskInDetail = a.maskInDetail || b.maskInDetail;
  const formatOf = (p: FieldPolicy) => (p.maskInList || p.maskInDetail ? p.format : null);
  const formats = [formatOf(a), formatOf(b)].filter((f): f is MaskFormat => f !== null);
  const format = formats.length === 0 ? a.format : formats.every((f) => f === formats[0]) ? formats[0]! : formatsFor(kind).includes("stars") ? "stars" : formats[0]!;
  // A shared screen has nobody to reveal for, and is not an export.
  return { view: true, maskInList, maskInDetail, unmask: false, format, export: null };
}

/**
 * The most restrictive policy in the workspace for each field of one record type (`SHARED_SCREEN_VIEWER`): of every
 * active person — not a super admin, not the Automation account, in a role that is switched on — their own policy for
 * the field, else their role's, else nothing set (open). Nobody's view is widened by it; it is only ever shown on a
 * screen that isn't anybody's.
 */
async function strictestEntity(entity: FieldEntity, list: SensitiveField[], maskingOn: boolean): Promise<ResolvedFieldPolicies> {
  const fields = new Map<string, ResolvedField>();
  const people = await db.user.findMany({ where: { active: true, isSuperAdmin: false, kind: "MEMBER" }, select: { id: true, role: true } });
  const roles = [...new Set(people.map((p) => p.role))];
  const live = new Set((await Promise.all(roles.map(async (r) => ((await roleIsActive(r)) ? r : null)))).filter((r): r is string => r !== null));
  const members = people.filter((p) => live.has(p.role));
  let personal: (StoredPolicy & { userId: string })[] = [];
  let forRole: (StoredPolicy & { role: string })[] = [];
  try {
    [personal, forRole] = await Promise.all([
      db.userFieldPolicy.findMany({ where: { userId: { in: members.map((m) => m.id) }, entity, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, select: { ...POLICY_COLUMNS, userId: true } }),
      db.roleFieldPolicy.findMany({ where: { role: { in: [...live] }, entity }, select: { ...POLICY_COLUMNS, role: true } }),
    ]);
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  const at = (who: string, field: string) => `${who}/${field}`;
  const own = new Map<string, StoredPolicy>(personal.map((r) => [at(r.userId, r.field), r]));
  const ofRole = new Map<string, StoredPolicy>(forRole.map((r) => [at(r.role, r.field), r]));
  let narrowed = false;
  for (const field of list) {
    let policy: FieldPolicy | null = null;
    for (const m of members) {
      const row = own.get(at(m.id, field.key)) ?? ofRole.get(at(m.role, field.key));
      const theirs = row ? normalisePolicy(field.kind, row) : openPolicy(field.kind);
      policy = policy ? stricter(field.kind, policy, theirs) : stricter(field.kind, theirs, theirs);
    }
    let shown = policy ?? openPolicy(field.kind);
    if (!maskingOn) shown = switchedOff(shown);
    if (narrows(shown)) narrowed = true;
    fields.set(field.key, { field, policy: shown, source: { via: "default" } });
  }
  return { userId: SHARED_SCREEN_VIEWER, fields, narrowed, maskingOn };
}

const resolveEntity = cache(async (userId: string, entity: FieldEntity, followSwitch: boolean = true): Promise<ResolvedFieldPolicies> => {
  const fields = new Map<string, ResolvedField>();
  if (userId === SHARED_SCREEN_VIEWER) {
    const [list, switchOn] = await Promise.all([sensitiveFieldsOf(entity), fieldMaskingEnabled()]);
    return strictestEntity(entity, list, switchOn || !followSwitch);
  }
  const [list, resolved, switchOn] = await Promise.all([sensitiveFieldsOf(entity), resolveUserPermissions(userId), fieldMaskingEnabled()]);
  const maskingOn = switchOn || !followSwitch;

  const everything = (policy: (kind: FieldKind) => FieldPolicy, source: FieldSource) => {
    for (const field of list) fields.set(field.key, { field, policy: policy(field.kind), source });
  };

  // Rules 1 and 2, from the same facts the permission resolver used — including that the Automation
  // account and a switched-off role reach nothing.
  if (resolved.isSuperAdmin) {
    everything(openPolicy, { via: "superAdmin" });
    return { userId, fields, narrowed: false, maskingOn };
  }
  if (!resolved.active || !resolved.role) {
    everything(closedPolicy, { via: "inactive" });
    return { userId, fields, narrowed: true, maskingOn };
  }

  const { personal, forRole } = await storedPolicies(userId, resolved.role, entity);
  const mine = new Map(personal.map((r) => [r.field, r]));
  const roles = new Map<string, StoredPolicy>(forRole.map((r) => [r.field, r]));
  let narrowed = false;
  for (const field of list) {
    const own = mine.get(field.key);
    const fromRole = roles.get(field.key);
    const entry: ResolvedField = own
      ? { field, policy: normalisePolicy(field.kind, own), source: { via: "userPolicy", reason: own.reason, expiresAt: own.expiresAt } }
      : fromRole
        ? { field, policy: normalisePolicy(field.kind, fromRole), source: { via: "rolePolicy", role: resolved.role } }
        : { field, policy: openPolicy(field.kind), source: { via: "default" } };
    // Masking switched off for the workspace: a masked field shows in the clear, with nothing left to unmask.
    // Whether it can be seen at all is a different question, and stays the rule's (`switchedOff`).
    if (!maskingOn) entry.policy = switchedOff(entry.policy);
    if (narrows(entry.policy)) narrowed = true;
    fields.set(field.key, entry);
  }
  return { userId, fields, narrowed, maskingOn };
});

/** Every field of one record type for one person, with where each answer came from. */
export async function resolveFieldPolicies(userId: string, entity: FieldEntity = "leads"): Promise<ResolvedFieldPolicies> {
  return resolveEntity(userId, entity);
}

/**
 * The same, as the rules stand whether or not masking is switched on — what somebody granting access is held
 * to. With masking off everybody's own answer reads "in the clear", and measuring a grant against that would
 * let an admin hand out rules wider than their own, which would outlast the switch going back on.
 */
export async function resolveStoredFieldPolicies(userId: string, entity: FieldEntity = "leads"): Promise<ResolvedFieldPolicies> {
  return resolveEntity(userId, entity, false);
}

/**
 * The fields of a record type this person's `export` answers set (not "as the list") — what an API list re-presents from
 * the stored values in the "export" context, the list's own read having masked the rest already (owner, 5 Nov 2026 —
 * Phase 3 masking fixes, audit H.4.4). Empty for nearly everybody, and then nothing is read twice.
 */
export async function exportOverrides(userId: string, entity: FieldEntity): Promise<Set<string>> {
  const resolved = await resolveEntity(userId, entity);
  return new Set([...resolved.fields.values()].filter((f) => f.policy.view && f.policy.export !== null).map((f) => f.field.key));
}

/**
 * Each field's answer in a list and in an export, for one person (owner, 5 Nov 2026 — audit H.4.4) — for the callers
 * that can't hand the "export" context to a presenter: a file's custom columns (src/lib/custom-fields/sheets.ts masks
 * them as the list does) and the API's custom fields. Field key → { list, export }.
 */
export async function exportAnswers(userId: string, entity: FieldEntity): Promise<Map<string, { list: FieldVisibility; export: FieldVisibility | "none" }>> {
  const resolved = await resolveEntity(userId, entity);
  return new Map([...resolved.fields.values()].map((f) => [f.field.key, { list: visibility(f.policy, "list"), export: exportVisibility(f.policy) }]));
}

/** One field's policy for one person — open for a field the entity doesn't have. */
export async function fieldPolicy(userId: string, entity: FieldEntity, field: string): Promise<FieldPolicy> {
  const resolved = await resolveEntity(userId, entity);
  return resolved.fields.get(field)?.policy ?? openPolicy("text");
}

/**
 * What one person may see of a lead's fields, in one context — the masker every lead read path runs
 * its values through before they leave the server.
 *
 * `present(field, value)` returns the value as this person sees it there: as it is, masked, or the
 * word "Restricted". A field the registry doesn't know is passed through, so a read path can't fail
 * open by asking about a field that was renamed — every known field is listed in SENSITIVE_FIELDS.
 */
export type FieldMasker = {
  /** False when nothing is masked or restricted for this person here — the values go out as they are. */
  active: boolean;
  context: FieldContext;
  present(field: string, value: string | null | undefined): string | null;
  visibility(field: string): FieldVisibility;
  policy(field: string): FieldPolicy | null;
};

export async function leadMasker(userId: string, context: FieldContext): Promise<FieldMasker> {
  return fieldMasker(userId, "leads", context);
}

/**
 * The same for any record type field access covers — contacts' through src/lib/contacts/masking.ts, companies' through
 * src/lib/companies/masking.ts. In the "export" context (owner, 5 Nov 2026 — audit H.4.4) a field left out of exports
 * presents as nothing (null), so its cell goes out blank.
 */
export async function fieldMasker(userId: string, entity: FieldEntity, context: FieldContext): Promise<FieldMasker> {
  const resolved = await resolveEntity(userId, entity);
  const policy = (field: string) => resolved.fields.get(field)?.policy ?? null;
  const active = resolved.narrowed && [...resolved.fields.values()].some((f) => visibility(f.policy, context) !== "clear");
  return {
    active,
    context,
    policy,
    visibility: (field) => {
      const p = policy(field);
      return p ? visibility(p, context) : "clear";
    },
    present: (field, value) => {
      if (!active) return value ?? null;
      const p = policy(field);
      return p ? presentValue(value, p, context) : (value ?? null);
    },
  };
}

/**
 * A lead's custom field values with the person's field access applied: a restricted field is left out
 * altogether, a masked one masked. `values` is already trimmed to the fields they may see at all
 * (`fields.seeRestricted`); this narrows it further, never widens it.
 */
export function maskCustomValues<V extends Record<string, unknown>>(masker: FieldMasker, values: V): V {
  if (!masker.active) return values;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const field = customFieldKey(key);
    const seen = masker.visibility(field);
    if (seen === "restricted") continue;
    if (seen === "masked") {
      if (Array.isArray(value)) out[key] = value.map((v) => masker.present(field, typeof v === "string" ? v : String(v)));
      else if (value === null || value === undefined || value === "") out[key] = value;
      else out[key] = masker.present(field, typeof value === "string" ? value : String(value));
      continue;
    }
    out[key] = value;
  }
  return out as V;
}
