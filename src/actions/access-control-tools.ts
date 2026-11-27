"use server";

import type { AccessLevel } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { can, describeSource, type PermissionSource } from "@/lib/authz/resolve";
import { ADMIN_ROLE, listRoles, roleIsActive } from "@/lib/authz/role-registry";
import { PERMISSIONS, getPermissionDefinition, isPermissionKey, sectionPermission, type PermissionKey } from "@/lib/permissions";
import { decideModuleAccess } from "@/lib/navigation";
import { ACCESS_ACTIONS, ACCESS_RECORDS, accessRecordDefinition, explainAccess, isAccessAction, isAccessRecord, type AccessAction, type AccessRecord } from "@/lib/authz/access";
import { LEVEL_WORDS, UNDER } from "@/lib/authz/level-order";
import { ACCESS_MODULES, accessModule, actionRowsOf, isSectionKey, moduleOfPermission, moduleStanding, RECORD_VIEW_KEY, type ModuleIcon, type ModuleStanding } from "@/lib/staff/access-modules";
import { rowAllowed, type AccessFacts } from "@/lib/staff/access-explain";
import { moduleNote, permissionModules, type ModuleState } from "@/lib/staff/permission-modules";
import {
  closedPolicy,
  describePolicy,
  EXPORT_MODE_LABELS,
  exportVisibility,
  FIELD_ENTITIES,
  FIELD_ENTITY_WORDS,
  isFieldEntity,
  maskValue,
  presentValue,
  visibility,
  type FieldEntity,
  type FieldKind,
  type FieldPolicy,
  type FieldVisibility,
} from "@/lib/authz/field-policy";
import { workspaceClock } from "@/lib/time/workspace";
import { acPath } from "@/lib/access-control/nav";
import { accessRoster, effectivePermissionsFor, getPermissionMatrix } from "@/actions/permission";
import { personAccessLevels, roleAccessLevels } from "@/actions/access-levels";
import { fieldMaskingState, personFieldAccess, roleFieldAccess } from "@/actions/field-access";
import { getModuleStates } from "@/actions/module";

/**
 * Settings › Access Control › tools: the Permission Simulator and the Comparison.
 *
 * Both only ever READ. Every answer is the one the real resolvers give — a permission and where it
 * came from (src/lib/authz/resolve.ts), a module's plan, switch, view permission and menu section
 * (`decideModuleAccess`), how far a record type is reached (src/lib/authz/access.ts), what a field
 * policy shows (src/lib/authz/field-policy.ts) and today's unmask count against the daily limit
 * (src/lib/authz/unmask.ts) — laid out in the order the app asks them. Nothing here reveals a value,
 * uses a unit of anybody's limit, or writes a row.
 *
 * These answer about ANOTHER person or a role, so each export starts with "Review who can do what"
 * (`permissions.view`), as the sibling readers do: an ungated simulator is a permission oracle.
 */

// ─── What the screens are handed ──────────────────────────────────────────────────────────────────

export type SimVerdict = "allowed" | "denied" | "info";
export type SimStep = { label: string; verdict: SimVerdict; detail: string; value?: string };
export type SimFix = { label: string; href: string };
export type SimTrace = { verdict: "allowed" | "denied"; title: string; reason: string; steps: SimStep[]; fix: SimFix | null };

export type FieldOp = "view" | "reveal" | "export";

export type SimTry =
  | { id: string; kind: "record"; label: string; record: AccessRecord; action: AccessAction; level: AccessLevel; trace: SimTrace }
  | { id: string; kind: "permission"; label: string; trace: SimTrace }
  | { id: string; kind: "field"; label: string; entity: FieldEntity; field: string; op: FieldOp; trace: SimTrace };

export type SimFieldPreview = {
  key: string;
  label: string;
  custom: boolean;
  /** A sample value as it shows in a list and on the record's own page. */
  list: string;
  detail: string;
  listSeen: FieldVisibility;
  detailSeen: FieldVisibility;
  mayUnmask: boolean;
  why: string;
};

export type SimSubject = {
  kind: "user" | "role";
  id: string;
  name: string;
  /** How a sentence names them: a first name, or "the Sales role". */
  who: string;
  roleKey: string;
  roleName: string;
  active: boolean;
  isSuperAdmin: boolean;
  /** Their own exceptions to their role: permissions, record levels, field policies, a limit of their own. */
  overrides: number;
  /** Today's unmask count against the daily limit; null for a role, which has no count of its own. */
  quota: { used: number; limit: number | null; remaining: number | null } | null;
};

export type SimulatorView = {
  subject: SimSubject;
  people: { id: string; name: string; roleName: string; active: boolean }[];
  roles: { key: string; name: string }[];
  modules: { key: string; label: string; icon: ModuleIcon }[];
  module: { key: string; label: string; description: string; standing: ModuleStanding };
  tries: SimTry[];
  records: { key: AccessRecord; label: string; ownMeans: string }[];
  entities: { entity: FieldEntity; title: string; one: string; fields: SimFieldPreview[] }[];
  summary: { key: string; label: string; icon: ModuleIcon; standing: ModuleStanding; allowed: number; total: number }[];
  maskingOn: boolean;
};

export type CompareTone = "green" | "red" | "amber" | "brand" | "neutral";
export type CompareAnswer = { text: string; on: boolean; tone: CompareTone; src: string; why: string };
export type CompareRow = {
  id: string;
  section: "permission" | "reach" | "field";
  module: string;
  label: string;
  sub: string;
  /** Why the row does nothing here yet: its module is switched off or outside the plan. */
  note: string | null;
  a: CompareAnswer;
  b: CompareAnswer;
  status: "same" | "onlyA" | "onlyB" | "differ";
};
export type CompareSide = { ref: string; kind: "role" | "user"; id: string; name: string; meta: string };
export type Comparison = {
  a: CompareSide;
  b: CompareSide;
  rows: CompareRow[];
  people: { id: string; name: string; roleName: string; active: boolean }[];
  roles: { key: string; name: string }[];
  modules: { key: string; label: string; icon: ModuleIcon }[];
};

// ─── The facts about one subject, read once ───────────────────────────────────────────────────────

type PermFact = { label: string; held: boolean; via: PermissionSource["via"]; why: string };
type LevelFact = { level: AccessLevel; why: string; absent: boolean; own: boolean; from: "person" | "role" | "derived" | "fixed" };
type FieldFact = { key: string; label: string; kind: FieldKind; custom: boolean; policy: FieldPolicy; why: string; own: boolean };
type LimitFact = { daily: number | null; why: string; used: number | null; remaining: number | null };

type Facts = {
  kind: "user" | "role";
  id: string;
  name: string;
  who: string;
  roleKey: string;
  roleName: string;
  active: boolean;
  isSuperAdmin: boolean;
  /** Who is asking, before anything else: the account, super admin, the role. */
  gates: SimStep[];
  /** A gate that already answers no to everything. */
  stop: { reason: string; fix: SimFix | null } | null;
  perm: Map<string, PermFact>;
  holds: Set<string>;
  level: Map<string, LevelFact>;
  fields: Record<FieldEntity, FieldFact[]>;
  limit: LimitFact;
  overrides: number;
};

type WorldModule = { key: string; label: string; core?: boolean; viewPermission?: PermissionKey; entitled: boolean; switchedOn: boolean };
type World = { modules: Map<string, WorldModule>; states: Record<string, ModuleState>; maskingOn: boolean };

const NOT_HELD: PermFact = { label: "", held: false, via: "none", why: "Not held." };
const slot = (record: string, action: string) => `${record}:${action}`;
const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const LIMIT_WORDS = (limit: number | null) => (limit === null ? "no limit" : `${limit} a day`);

/** Whoever may review access, or null — the check every export here starts with. */
async function reviewer() {
  const session = await requireUser();
  return (await can(session.id, "permissions.view")) ? session : null;
}

async function loadWorld(): Promise<World> {
  const [states, masking] = await Promise.all([getModuleStates(), fieldMaskingState()]);
  const modules = new Map<string, WorldModule>();
  const byKey: Record<string, ModuleState> = {};
  for (const m of states) {
    modules.set(m.key, { key: m.key, label: m.label, core: m.core, viewPermission: m.viewPermission, entitled: m.entitled, switchedOn: m.switchedOn });
    byKey[m.key] = { key: m.key, label: m.label, entitled: m.entitled, switchedOn: m.switchedOn };
  }
  return { modules, states: byKey, maskingOn: masking.enabled };
}

/** One person: what the resolvers answer for them, with every exception of their own counted in. */
async function userFacts(userId: string, roleNames: Map<string, string>): Promise<Facts | null> {
  const [effective, levels, leads, contacts, companies] = await Promise.all([
    effectivePermissionsFor(userId),
    personAccessLevels(userId),
    personFieldAccess(userId, "leads"),
    personFieldAccess(userId, "contacts"),
    personFieldAccess(userId, "companies"),
  ]);
  if (!effective || !levels || !leads || !contacts || !companies) return null;
  const user = effective.user;
  const roleName = roleNames.get(user.role) ?? user.role;
  const roleOn = await roleIsActive(user.role);
  const who = user.name.trim().split(/\s+/)[0] || user.name;

  const perm = new Map<string, PermFact>(effective.permissions.map((p) => [p.key, { label: p.label, held: p.held, via: p.via, why: p.why }]));

  const level = new Map<string, LevelFact>();
  for (const row of levels) {
    for (const action of ACCESS_ACTIONS) {
      const cell = row.cells[action];
      const via = cell.absent ? null : (await explainAccess(userId, row.key, action)).source.via;
      level.set(slot(row.key, action), {
        level: cell.level,
        why: cell.why,
        absent: cell.absent === true,
        own: via === "userLevel",
        from: via === "userLevel" ? "person" : via === "roleLevel" ? "role" : via === "derived" ? "derived" : "fixed",
      });
    }
  }

  const fieldsOf = (access: NonNullable<Awaited<ReturnType<typeof personFieldAccess>>>): FieldFact[] =>
    access.rows.map((r) => ({ key: r.key, label: r.label, kind: r.kind, custom: r.custom, policy: r.effective, why: r.why, own: r.stored !== null }));
  const fields: Record<FieldEntity, FieldFact[]> = { leads: fieldsOf(leads), contacts: fieldsOf(contacts), companies: fieldsOf(companies) };

  const gates: SimStep[] = [
    user.active
      ? { label: "Account", verdict: "allowed", detail: "Active.", value: "ACTIVE" }
      : { label: "Account", verdict: user.isSuperAdmin ? "info" : "denied", detail: "Deactivated — nobody can sign in as them, and a deactivated account holds nothing.", value: "DEACTIVATED" },
    user.isSuperAdmin
      ? { label: "Super admin", verdict: "allowed", detail: "Holds every permission, reaches every record and sees every field. No rule below can restrict them.", value: "YES" }
      : { label: "Super admin", verdict: "info", detail: "No — their role and their own exceptions decide.", value: "NO" },
  ];
  let stop: Facts["stop"] = null;
  if (!user.isSuperAdmin) {
    gates.push(
      roleOn
        ? { label: `Role · ${roleName}`, verdict: "allowed", detail: "Switched on.", value: "ON" }
        : { label: `Role · ${roleName}`, verdict: "denied", detail: "Switched off, so it grants nothing to anybody who holds it.", value: "OFF" },
    );
    if (!user.active) stop = { reason: `${user.name}'s account is deactivated, so it holds nothing.`, fix: { label: "Open employee", href: acPath.employee(user.id) } };
    else if (!roleOn) stop = { reason: `${user.name}'s role (${roleName}) is switched off, so it grants nothing.`, fix: { label: "Open roles", href: acPath.roles() } };
  }

  const overrides =
    effective.permissions.filter((p) => p.via === "userGrant").length +
    [...level.values()].filter((l) => l.own).length +
    FIELD_ENTITIES.reduce((n, e) => n + fields[e].filter((f) => f.own).length, 0) +
    (leads.limit.own ? 1 : 0);

  return {
    kind: "user",
    id: user.id,
    name: user.name,
    who,
    roleKey: user.role,
    roleName,
    active: user.active,
    isSuperAdmin: user.isSuperAdmin,
    gates,
    stop,
    perm,
    holds: new Set(effective.permissions.filter((p) => p.held).map((p) => p.key)),
    level,
    fields,
    limit: { daily: leads.limit.effective, why: leads.limit.why, used: leads.usage.used, remaining: leads.usage.remaining },
    overrides,
  };
}

/**
 * A role on its own: what somebody holding it gets with no exception of their own. The same order the
 * resolvers use past the person — the role's stored answer, else its default; a stored level, else the
 * one its permissions give; the role's field policy, else open; its limit, else the workspace default.
 */
async function roleFacts(role: string, roleNames: Map<string, string>, world: World): Promise<Facts | null> {
  const [matrix, grid, leads, contacts, companies, clock, roleOn] = await Promise.all([
    getPermissionMatrix(),
    roleAccessLevels(role),
    roleFieldAccess(role, "leads"),
    roleFieldAccess(role, "contacts"),
    roleFieldAccess(role, "companies"),
    workspaceClock(),
    roleIsActive(role),
  ]);
  if (!grid || !leads || !contacts || !companies) return null;
  const roleName = roleNames.get(role) ?? role;

  const perm = new Map<string, PermFact>();
  for (const row of matrix) {
    const held = roleOn && (row.roles[role] ?? false);
    const source: PermissionSource = !roleOn
      ? { via: "roleInactive", role }
      : row.explicit[role]
        ? { via: "roleOverride", role, allowed: held }
        : held
          ? role === ADMIN_ROLE && !row.superAdminOnly
            ? { via: "adminDefault" }
            : { via: "roleDefault", role }
          : { via: "none" };
    perm.set(row.key, { label: row.label, held, via: source.via, why: describeSource(source, clock) });
  }

  const level = new Map<string, LevelFact>();
  for (const row of grid.rows) {
    for (const action of ACCESS_ACTIONS) {
      const cell = row.cells[action];
      const absent = !row.actions.includes(action);
      level.set(slot(row.key, action), {
        level: absent || !roleOn ? "NONE" : (cell.stored ?? cell.derived),
        why: absent
          ? "Not an action this record has."
          : !roleOn
            ? "The role is switched off."
            : cell.stored
              ? "Set on this role."
              : cell.derivedFrom.held
                ? `From "${cell.derivedFrom.label}", which the role holds.`
                : `The role doesn't hold "${cell.derivedFrom.label}".`,
        absent,
        own: false,
        from: absent || !roleOn ? "fixed" : cell.stored ? "role" : "derived",
      });
    }
  }

  // Masking switched off for the workspace shows a masked field in the clear, with nothing to unmask —
  // as the person resolver applies it (src/lib/authz/fields.ts); restricted stays restricted.
  const seen = (policy: FieldPolicy, kind: FieldKind): FieldPolicy =>
    !roleOn ? closedPolicy(kind) : world.maskingOn || !policy.view ? policy : { ...policy, maskInList: false, maskInDetail: false, unmask: false, export: policy.export === "masked" ? null : policy.export };
  const fieldsOf = (access: NonNullable<Awaited<ReturnType<typeof roleFieldAccess>>>): FieldFact[] =>
    access.rows.map((r) => ({ key: r.key, label: r.label, kind: r.kind, custom: r.custom, policy: seen(r.effective, r.kind), why: !roleOn ? "The role is switched off." : r.why, own: false }));
  const fields: Record<FieldEntity, FieldFact[]> = { leads: fieldsOf(leads), contacts: fieldsOf(contacts), companies: fieldsOf(companies) };

  // The role's own limit, else the workspace default for a role that may unmask anything (as its rules are stored).
  const mayUnmask = [leads, contacts, companies].some((a) => a.rows.some((r) => r.effective.view && r.effective.unmask));
  const limit: LimitFact = leads.limitStored
    ? { daily: leads.dailyLimit, why: "Set on this role.", used: null, remaining: null }
    : mayUnmask
      ? { daily: leads.workspaceDefault, why: `Nothing set on the role: the workspace default applies (${LIMIT_WORDS(leads.workspaceDefault)}).`, used: null, remaining: null }
      : { daily: null, why: "Nothing set on the role, and nothing it may unmask — so nothing to count.", used: null, remaining: null };

  const gates: SimStep[] = [
    roleOn
      ? { label: `Role · ${roleName}`, verdict: "allowed", detail: "Switched on. Simulated as somebody who holds this role with no exceptions of their own.", value: "ON" }
      : { label: `Role · ${roleName}`, verdict: "denied", detail: "Switched off, so it grants nothing to anybody who holds it.", value: "OFF" },
  ];

  return {
    kind: "role",
    id: role,
    name: roleName,
    who: `the ${roleName} role`,
    roleKey: role,
    roleName,
    active: roleOn,
    isSuperAdmin: false,
    gates,
    stop: roleOn ? null : { reason: `The ${roleName} role is switched off, so it grants nothing.`, fix: { label: "Open roles", href: acPath.roles() } },
    perm,
    holds: new Set([...perm].filter(([, p]) => p.held).map(([key]) => key)),
    level,
    fields,
    limit,
    overrides: 0,
  };
}

// ─── The trace ────────────────────────────────────────────────────────────────────────────────────

/**
 * The workspace module (src/lib/modules.ts) whose pages each record type lives on — what has to be in
 * the plan and switched on before any reach matters. Calls, notes and meetings sit on other records'
 * pages, so they have none of their own.
 */
const RECORD_MODULES: Partial<Record<AccessRecord, string[]>> = {
  companies: ["companies"],
  contacts: ["companies"],
  vendors: ["vendors"],
  leads: ["leads"],
  orders: ["orders"],
  documents: ["sales_documents", "purchase_documents"],
  payments: ["payments"],
  tickets: ["helpdesk"],
  projects: ["projects"],
  visits: ["visits"],
  tasks: ["tasks"],
  expenses: ["expenses"],
};

const VERB: Record<AccessAction, string> = { view: "View", edit: "Edit", delete: "Delete", assign: "Assign" };
/** The export permission a record type's fields leave through (src/actions/lead.ts, the CRM export). */
const EXPORT_KEY = "data.exportCrm";
/** Illustrative values, masked with the real masks — the ones the field editors preview with. */
const SAMPLE: Record<FieldKind, string> = { text: "Example Industries Pvt Ltd", email: "priya.sharma@example.com", phone: "+91 98765 43210", address: "12 MG Road, Pune", choice: "Website" };
/** Text fields that are not a company's name read as what they are: a GSTIN looks like a GSTIN. All made up. */
const SAMPLE_BY_FIELD: Record<string, string> = {
  "leads.title": "Website enquiry — CNC lathe",
  "leads.contactName": "Priya Sharma",
  "leads.description": "Please share a quote for two units.",
  "contacts.name": "Priya Sharma",
  "companies.gstin": "27AAECE1234F1Z5",
  "companies.pan": "AAECE1234F",
  "companies.website": "www.example.com",
};
const sampleOf = (field: { entity: string; key: string; kind: FieldKind }) => SAMPLE_BY_FIELD[`${field.entity}.${field.key}`] ?? SAMPLE[field.kind];

const linkOf = (f: Facts) => (f.kind === "user" ? { user: f.id } : { role: f.id });
const answer = (held: boolean) => (held ? "ALLOW" : "DENY");

function finish(steps: SimStep[], verdict: "allowed" | "denied", title: string, reason: string, fix: SimFix | null): SimTrace {
  return { verdict, title, reason, fix, steps: [...steps, { label: "Final decision", verdict, detail: "", value: verdict === "allowed" ? "ALLOWED" : "DENIED" }] };
}

type Closed = { reason: string; fix: SimFix | null; byScope?: boolean };

/**
 * Whether the module behind a question is open to them — the plan, the company's switch, its view
 * permission, its menu section — decided by `decideModuleAccess` and shown part by part. Given
 * several modules, it is open when any of them is.
 */
function moduleGate(world: World, f: Facts, keys: string[]): { steps: SimStep[]; closed: Closed | null; asked: Set<string> } {
  const asked = new Set<string>();
  const defs = keys.map((k) => world.modules.get(k)).filter((d): d is WorldModule => Boolean(d));
  if (defs.length === 0) return { steps: [], closed: null, asked };
  const answers = defs.map((d) => ({ d, access: decideModuleAccess(d, { entitled: d.entitled, switchedOn: d.switchedOn }, f.holds) }));
  const { d, access } = answers.find((a) => a.access === "available") ?? answers[0]!;
  const label = `Module · ${d.label}`;
  const steps: SimStep[] = [];
  if (access === "not-entitled") {
    steps.push({ label, verdict: "denied", detail: "Not in this workspace's plan. Nothing crosses that line: its pages and its actions refuse everybody.", value: "NOT IN PLAN" });
    return { steps, closed: { reason: `${d.label} isn't in this workspace's plan.`, fix: { label: "Open workspace modules", href: "/settings/modules" } }, asked };
  }
  if (access === "switched-off") {
    steps.push({ label, verdict: "denied", detail: "In the plan, but switched off for the company: its pages and menu links are closed to everybody.", value: "OFF" });
    return { steps, closed: { reason: `${d.label} is switched off for the company.`, fix: { label: "Open workspace modules", href: "/settings/modules" } }, asked };
  }
  steps.push({ label, verdict: "allowed", detail: d.core ? "A core module: always on." : "In this workspace's plan and switched on.", value: "ON" });
  let closed: Closed | null = null;
  const fix: SimFix = { label: "Open module permissions", href: acPath.modules(linkOf(f)) };
  if (d.viewPermission) {
    const p = f.perm.get(d.viewPermission) ?? NOT_HELD;
    asked.add(d.viewPermission);
    steps.push({ label: `Opens with · ${p.label || d.viewPermission}`, verdict: p.held ? "allowed" : "denied", detail: p.why, value: answer(p.held) });
    if (!p.held) closed = { reason: `${cap(f.who)} doesn't hold "${p.label || d.viewPermission}", which opens ${d.label}.`, fix };
  }
  const section = sectionPermission(d.key);
  if (isPermissionKey(section)) {
    const p = f.perm.get(section) ?? NOT_HELD;
    asked.add(section);
    steps.push({ label: `Menu section · ${p.label || section}`, verdict: p.held ? "allowed" : "denied", detail: p.held ? p.why : `Unticked, so ${d.label} is hidden from the menu and its pages say there is no access. ${p.why}`, value: answer(p.held) });
    if (!p.held && !closed) closed = { reason: `The ${d.label} section is unticked for ${f.who}, so its pages are closed to them.`, fix };
  }
  return { steps, closed, asked };
}

/** (a) May they use this permission. */
function permissionTrace(world: World, f: Facts, key: string): SimTrace {
  const def = getPermissionDefinition(key)!;
  const steps = [...f.gates];
  if (f.stop) return finish(steps, "denied", "Denied", f.stop.reason, f.stop.fix);
  const gate = moduleGate(world, f, permissionModules(key));
  steps.push(...gate.steps);
  const p = f.perm.get(key) ?? NOT_HELD;
  steps.push({ label: `Permission · ${def.label}`, verdict: p.held ? "allowed" : "denied", detail: p.why, value: answer(p.held) });
  if (def.selfExcluded) steps.push({ label: "Not on their own records", verdict: "info", detail: "Separation of duties: whoever holds this may not use it on a record they created or own.", value: "RULE" });
  const fix: SimFix = { label: "Open module permissions", href: acPath.modules(linkOf(f)) };
  if (!p.held) return finish(steps, "denied", "Denied", `${cap(f.who)} doesn't hold "${def.label}". ${p.why}`, fix);
  if (gate.closed) return finish(steps, "denied", "Denied: the module is closed", `${cap(f.who)} holds "${def.label}", but ${gate.closed.reason} It takes effect when the module is open to them.`, gate.closed.fix);
  return finish(steps, "allowed", "Allowed", `${cap(f.who)} holds "${def.label}". ${p.why}`, null);
}

/** How far a level reaches, in a sentence. */
function reachWords(level: AccessLevel, record: AccessRecord, noun: string): string {
  switch (level) {
    case "NONE":
      return `No ${noun} at all.`;
    case "OWN":
      return `Their own ${noun} only — where they are ${accessRecordDefinition(record).ownMeans}.`;
    case "TEAM":
      return `Their own ${noun} and those of anybody who reports to them, at any depth.`;
    case "BRANCH":
      return `The ${noun} of everybody in their branch.`;
    case "ALL":
      return `Every one of the workspace's ${noun}.`;
    case "FOLLOW":
      return `As far as the account: they reach one exactly when they reach its company.`;
  }
}

/** The steps every question about a record type shares: its module, the permission that opens it, and what the action sits under. */
function recordSteps(world: World, f: Facts, record: AccessRecord, action: AccessAction, noun: string) {
  const steps: SimStep[] = [];
  let failed: Closed | null = null;
  const gate = moduleGate(world, f, RECORD_MODULES[record] ?? []);
  steps.push(...gate.steps);
  if (gate.closed) failed = gate.closed;
  const viewKey = RECORD_VIEW_KEY[record];
  if (viewKey && !gate.asked.has(viewKey)) {
    const p = f.perm.get(viewKey) ?? NOT_HELD;
    steps.push({ label: `Permission · ${p.label || viewKey}`, verdict: p.held ? "allowed" : "denied", detail: p.held ? p.why : `Opens ${noun} at all. ${p.why}`, value: answer(p.held) });
    if (!p.held && !failed) failed = { reason: `${cap(f.who)} doesn't hold "${p.label || viewKey}", which opens ${noun} at all.`, fix: { label: "Open module permissions", href: acPath.modules(linkOf(f)) } };
  }
  const scopeFix: SimFix = { label: "Adjust data scope", href: acPath.scope(linkOf(f)) };
  // View first, then edit: nobody edits what they can't see, nor deletes what they can't edit.
  for (const under of [...UNDER[action]].reverse()) {
    const l = f.level.get(slot(record, under));
    if (!l || l.absent) continue;
    steps.push({
      label: `Sits under ${VERB[under]} · ${LEVEL_WORDS[l.level]}`,
      verdict: l.level === "NONE" ? "denied" : "allowed",
      detail: `Nobody ${VERB[action].toLowerCase()}s what they can't ${under}: the two are combined. ${l.why}`,
      value: LEVEL_WORDS[l.level].toUpperCase(),
    });
    if (l.level === "NONE" && !failed) failed = { reason: `${cap(f.who)} can't ${under} ${noun}, and nobody ${VERB[action].toLowerCase()}s what they can't ${under}. ${l.why}`, fix: scopeFix, byScope: true };
  }
  const own = f.level.get(slot(record, action)) ?? { level: "NONE" as AccessLevel, why: "", absent: true, own: false, from: "fixed" as const };
  steps.push({
    label: `Data scope · ${VERB[action]} ${noun}`,
    verdict: own.level === "NONE" ? "denied" : "allowed",
    detail: `${reachWords(own.level, record, noun)} ${own.why}`.trim(),
    value: LEVEL_WORDS[own.level].toUpperCase(),
  });
  if (own.level === "NONE" && !failed) failed = { reason: `${cap(f.who)} reaches no ${noun} to ${VERB[action].toLowerCase()}. ${own.why}`.trim(), fix: scopeFix, byScope: true };
  return { steps, failed, level: own.level };
}

/** (b) How far they reach a record type for an action. */
function reachTrace(world: World, f: Facts, record: AccessRecord, action: AccessAction, label: string): SimTrace {
  const noun = label.split(" ").slice(1).join(" ") || accessRecordDefinition(record).label.toLowerCase();
  const steps = [...f.gates];
  if (f.stop) return finish(steps, "denied", "Denied", f.stop.reason, f.stop.fix);
  const r = recordSteps(world, f, record, action, noun);
  steps.push(...r.steps);
  if (r.failed) return finish(steps, "denied", r.failed.byScope ? "Denied by data scope" : "Denied", r.failed.reason, r.failed.fix);
  return finish(steps, "allowed", `Allowed · ${LEVEL_WORDS[r.level]}`, `${cap(f.who)} can ${VERB[action].toLowerCase()} ${noun}. ${reachWords(r.level, record, noun)}`, null);
}

const SEEN_WORDS: Record<FieldVisibility, string> = { clear: "in the clear", masked: "masked", restricted: "restricted" };

/** (c) What they see of one field, whether they may reveal it, and how it leaves in an export. */
function fieldTrace(world: World, f: Facts, entity: FieldEntity, field: FieldFact, op: FieldOp): SimTrace {
  const words = FIELD_ENTITY_WORDS[entity];
  const name = `${words.one} ${field.label.toLowerCase()}`;
  const steps = [...f.gates];
  if (f.stop) return finish(steps, "denied", "Denied", f.stop.reason, f.stop.fix);
  const r = recordSteps(world, f, entity, "view", words.many);
  steps.push(...r.steps);
  if (r.failed) return finish(steps, "denied", r.failed.byScope ? "Denied by data scope" : "Denied", `${r.failed.reason} A field is only ever seen on a record they reach.`, r.failed.fix);

  if (!world.maskingOn) {
    steps.push({ label: "Field masking · switched off", verdict: "info", detail: "Masking is switched off for the workspace: masked fields show in the clear and there is nothing to unmask. Restricted fields stay restricted.", value: "OFF" });
  }
  const policy = field.policy;
  const list = visibility(policy, "list");
  const detail = visibility(policy, "detail");
  const masked = list === "masked" || detail === "masked";
  const fieldsFix: SimFix = { label: "Open Field Permissions", href: acPath.fields({ ...linkOf(f), entity }) };
  steps.push({
    label: `Field policy · ${field.label}`,
    verdict: policy.view ? "allowed" : "denied",
    detail: !policy.view
      ? `Restricted: the value never leaves the server, only the word "Restricted" does. ${field.why}`
      : masked
        ? `${cap(SEEN_WORDS[list])} in lists, ${SEEN_WORDS[detail]} on the ${words.one}'s own page — masked as ${maskValue(sampleOf({ entity, key: field.key, kind: field.kind }), policy.format)}. ${field.why}`
        : `In the clear in lists and on the ${words.one}'s own page. ${field.why}`,
    value: !policy.view ? "RESTRICTED" : masked ? "MASKED" : "CLEAR",
  });
  if (!policy.view) return finish(steps, "denied", "Denied: restricted", `${cap(f.who)} may not read the ${name} at all. ${field.why}`, fieldsFix);

  if (op === "view") {
    return finish(
      steps,
      "allowed",
      masked ? "Allowed · masked" : "Allowed · in the clear",
      masked
        ? `${cap(f.who)} sees the ${name} ${SEEN_WORDS[list]} in lists and ${SEEN_WORDS[detail]} on the ${words.one}'s own page.`
        : `${cap(f.who)} sees the ${name} in the clear everywhere they reach the ${words.one}.`,
      null,
    );
  }

  if (op === "reveal") {
    if (!masked) {
      steps.push({ label: "Unmask", verdict: "info", detail: "Nothing is masked, so there is nothing to reveal and no unit to use.", value: "NOT NEEDED" });
      return finish(steps, "allowed", "Allowed · already in the clear", `${cap(f.who)} sees the ${name} in the clear, so no reveal is needed and nothing counts against the daily limit.`, null);
    }
    steps.push({
      label: "Unmask permission",
      verdict: policy.unmask ? "allowed" : "denied",
      detail: policy.unmask ? `May reveal the masked value on the ${words.one}'s own page. ${field.why}` : `May not unmask this field: it stays masked. ${field.why}`,
      value: answer(policy.unmask),
    });
    if (!policy.unmask) return finish(steps, "denied", "Denied: may not unmask", `${cap(f.who)} sees the ${name} masked and may not reveal it. ${field.why}`, fieldsFix);
    const { daily, used, remaining, why } = f.limit;
    if (daily === null) {
      steps.push({ label: "Daily unmask limit", verdict: "allowed", detail: `No limit. ${why}`, value: "NO LIMIT" });
    } else if (used === null || remaining === null) {
      steps.push({ label: "Daily unmask limit", verdict: "info", detail: `${daily} records a day for each person with this role; the count is each person's own. ${why}`, value: `${daily} A DAY` });
    } else {
      steps.push({
        label: "Daily unmask limit",
        verdict: remaining > 0 ? "allowed" : "denied",
        detail:
          remaining > 0
            ? `${used} of ${daily} used today; a reveal would use 1 — a record already unmasked today uses none. ${why}`
            : `${used} of ${daily} used today: a record not yet unmasked today stays masked until the workspace's midnight. ${why}`,
        value: remaining > 0 ? `${remaining} LEFT` : "EXHAUSTED",
      });
      if (remaining <= 0) {
        return finish(steps, "denied", "Denied: daily limit reached", `${cap(f.who)} may unmask the ${name}, but has used all ${daily} of today's reveals. Records already unmasked today still show.`, { label: "Edit unmasking limits", href: acPath.limits() });
      }
    }
    steps.push({ label: "Simulated", verdict: "info", detail: "Nothing was revealed and no unit of the daily limit was used.", value: "NO UNIT USED" });
    return finish(steps, "allowed", "Allowed", `${cap(f.who)} may reveal the ${name} on a ${words.one} they reach. Every reveal is logged; this simulation revealed nothing.`, null);
  }

  // Export: the permission that lets data leave, then the field's own export answer.
  const p = f.perm.get(EXPORT_KEY) ?? NOT_HELD;
  steps.push({ label: `Permission · ${p.label || EXPORT_KEY}`, verdict: p.held ? "allowed" : "denied", detail: p.why, value: answer(p.held) });
  const out = exportVisibility(policy);
  const mode = EXPORT_MODE_LABELS[policy.export ?? "list"];
  steps.push({
    label: `Export · ${field.label}`,
    verdict: out === "none" ? "denied" : "allowed",
    detail: out === "none" ? `Left out of exports: the cell goes out blank. Export is set to "${mode}".` : `Goes out ${SEEN_WORDS[out]}. Export is set to "${mode}". ${field.why}`,
    value: out === "none" ? "LEFT OUT" : out.toUpperCase(),
  });
  if (!p.held) return finish(steps, "denied", "Denied", `${cap(f.who)} doesn't hold "${p.label || EXPORT_KEY}", so nothing of a ${words.one} leaves in a file. ${p.why}`, { label: "Open Import & Export", href: acPath.importExport(f.roleKey) });
  if (out === "none") return finish(steps, "denied", "Denied: left out of exports", `The ${name} is left out of ${f.who}'s exports: the cell goes out blank.`, fieldsFix);
  return finish(steps, "allowed", out === "masked" ? "Allowed · exported masked" : "Allowed · exported in the clear", `${cap(f.who)}'s exports carry the ${name} ${SEEN_WORDS[out]} — never more than the screens show.`, null);
}

const FIELD_OPS: readonly FieldOp[] = ["view", "reveal", "export"];
const OP_VERB: Record<FieldOp, string> = { view: "View", reveal: "Reveal", export: "Export" };
const RECORD_ROWS = ACCESS_RECORDS.map((r) => ({ key: r.key, label: r.label, actions: [...r.actions] }));

/** Every question one module offers, each already answered. */
function triesOf(world: World, f: Facts, moduleKey: string): SimTry[] {
  const tries: SimTry[] = [];
  for (const row of actionRowsOf(moduleKey, RECORD_ROWS)) {
    if (row.kind === "record") {
      tries.push({ id: `reach:${row.record}:${row.action}`, kind: "record", label: row.label, record: row.record, action: row.action, level: f.level.get(slot(row.record, row.action))?.level ?? "NONE", trace: reachTrace(world, f, row.record, row.action, row.label) });
    } else {
      tries.push({ id: `perm:${row.key}`, kind: "permission", label: row.label, trace: permissionTrace(world, f, row.key) });
    }
  }
  const records = accessModule(moduleKey)?.records ?? [];
  for (const entity of FIELD_ENTITIES) {
    if (!records.includes(entity)) continue;
    for (const field of f.fields[entity]) {
      for (const op of FIELD_OPS) {
        tries.push({ id: `field:${entity}:${field.key}:${op}`, kind: "field", label: `${OP_VERB[op]} ${field.label.toLowerCase()}`, entity, field: field.key, op, trace: fieldTrace(world, f, entity, field, op) });
      }
    }
  }
  return tries;
}

const accessFactsOf = (f: Facts): AccessFacts => ({ holds: (key) => f.holds.has(key), level: (record, action) => f.level.get(slot(record, action))?.level ?? "NONE" });

async function directory() {
  const [roster, roles] = await Promise.all([accessRoster(), listRoles()]);
  const roleNames = new Map(roles.map((r) => [r.key, r.name]));
  return {
    roster,
    roles,
    roleNames,
    people: roster.map((u) => ({ id: u.id, name: u.name, roleName: roleNames.get(u.role) ?? u.role, active: u.active })),
    roleOptions: roles.map((r) => ({ key: r.key, name: r.name })),
    modules: ACCESS_MODULES.map((m) => ({ key: m.key, label: m.label, icon: m.icon })),
  };
}

// ─── The simulator ────────────────────────────────────────────────────────────────────────────────

/**
 * Everything the simulator draws for one subject and one module: every question the module offers with
 * its trace, the module as they see it, and a line per module. With nobody named it opens on the first
 * active person who isn't a super admin — the commonest question is about an ordinary account.
 */
export async function simulatorView(input: { user?: string; role?: string; module?: string }): Promise<SimulatorView | null> {
  if (!(await reviewer())) return null;
  const dir = await directory();
  const world = await loadWorld();

  let facts: Facts | null = null;
  const userId = typeof input?.user === "string" ? input.user : "";
  const role = typeof input?.role === "string" ? input.role : "";
  if (userId && dir.roster.some((u) => u.id === userId)) facts = await userFacts(userId, dir.roleNames);
  else if (role && dir.roleNames.has(role)) facts = await roleFacts(role, dir.roleNames, world);
  if (!facts) {
    const first = dir.roster.find((u) => u.active && !u.isSuperAdmin) ?? dir.roster[0];
    if (first) facts = await userFacts(first.id, dir.roleNames);
  }
  if (!facts) return null;

  const m = accessModule(String(input?.module ?? "")) ?? ACCESS_MODULES[0]!;
  const af = accessFactsOf(facts);
  const standingOf = (key: string) => {
    const mod = accessModule(key)!;
    return moduleStanding(mod, af.holds, (record) => af.level(record, "view") !== "NONE");
  };

  return {
    subject: {
      kind: facts.kind,
      id: facts.id,
      name: facts.name,
      who: facts.who,
      roleKey: facts.roleKey,
      roleName: facts.roleName,
      active: facts.active,
      isSuperAdmin: facts.isSuperAdmin,
      overrides: facts.overrides,
      quota: facts.limit.used === null ? null : { used: facts.limit.used, limit: facts.limit.daily, remaining: facts.limit.remaining },
    },
    people: dir.people,
    roles: dir.roleOptions,
    modules: dir.modules,
    module: { key: m.key, label: m.label, description: m.description, standing: standingOf(m.key) },
    tries: triesOf(world, facts, m.key),
    records: m.records.map((key) => {
      const def = accessRecordDefinition(key);
      return { key, label: def.label, ownMeans: def.ownMeans };
    }),
    entities: FIELD_ENTITIES.filter((e) => m.records.includes(e)).map((entity) => ({
      entity,
      title: FIELD_ENTITY_WORDS[entity].title,
      one: FIELD_ENTITY_WORDS[entity].one,
      fields: facts.fields[entity].map((field) => ({
        key: field.key,
        label: field.label,
        custom: field.custom,
        list: presentValue(sampleOf({ entity, key: field.key, kind: field.kind }), field.policy, "list") ?? "",
        detail: presentValue(sampleOf({ entity, key: field.key, kind: field.kind }), field.policy, "detail") ?? "",
        listSeen: visibility(field.policy, "list"),
        detailSeen: visibility(field.policy, "detail"),
        mayUnmask: field.policy.view && field.policy.unmask,
        why: field.why,
      })),
    })),
    summary: ACCESS_MODULES.map((mod) => {
      const rows = actionRowsOf(mod.key, RECORD_ROWS);
      return { key: mod.key, label: mod.label, icon: mod.icon, standing: standingOf(mod.key), allowed: rows.filter((row) => rowAllowed(row, af)).length, total: rows.length };
    }),
    maskingOn: world.maskingOn,
  };
}

/**
 * One question, answered with its trace: may they use a permission (`permission`), how far they reach a
 * record type for an action (`recordType` + `action`), or what they see of a field (`entity` + `field`
 * + `op`: view, reveal or export). About a person (`userId`) or a role on its own (`role`). Read-only:
 * a "reveal" reads today's count against the limit and reveals nothing.
 */
export async function simulate(input: {
  userId?: string;
  role?: string;
  permission?: string;
  recordType?: string;
  action?: string;
  entity?: string;
  field?: string;
  op?: string;
}): Promise<SimTrace | null> {
  if (!(await reviewer())) return null;
  const roles = await listRoles();
  const roleNames = new Map(roles.map((r) => [r.key, r.name]));
  const world = await loadWorld();
  const facts =
    typeof input?.userId === "string" && input.userId
      ? await userFacts(input.userId, roleNames)
      : typeof input?.role === "string" && roleNames.has(input.role)
        ? await roleFacts(input.role, roleNames, world)
        : null;
  if (!facts) return null;

  if (typeof input.permission === "string") {
    return getPermissionDefinition(input.permission) ? permissionTrace(world, facts, input.permission) : null;
  }
  if (typeof input.recordType === "string" && typeof input.action === "string") {
    if (!isAccessRecord(input.recordType) || !isAccessAction(input.action)) return null;
    const def = accessRecordDefinition(input.recordType);
    if (!def.actions.includes(input.action)) return null;
    return reachTrace(world, facts, input.recordType, input.action, `${VERB[input.action]} ${def.label.toLowerCase()}`);
  }
  if (isFieldEntity(input.entity) && typeof input.field === "string") {
    const field = facts.fields[input.entity].find((x) => x.key === input.field);
    const op = FIELD_OPS.find((o) => o === input.op);
    return field && op ? fieldTrace(world, facts, input.entity, field, op) : null;
  }
  return null;
}

// ─── The comparison ───────────────────────────────────────────────────────────────────────────────

const SRC_WORDS: Record<PermissionSource["via"], (held: boolean) => string> = {
  superAdmin: () => "super admin",
  inactive: () => "account off",
  roleInactive: () => "role off",
  userGrant: (held) => (held ? "personal grant" : "personal deny"),
  roleOverride: () => "set on role",
  roleDefault: () => "role default",
  adminDefault: () => "admin default",
  supportReadOnly: () => "support, read-only",
  none: () => "",
};

const LEVEL_SRC: Record<LevelFact["from"], string> = { person: "personal", role: "set on role", derived: "from permissions", fixed: "" };

function statusOf(a: CompareAnswer, b: CompareAnswer, same: boolean): CompareRow["status"] {
  if (same) return "same";
  if (a.on && !b.on) return "onlyA";
  if (b.on && !a.on) return "onlyB";
  return "differ";
}

function sideOf(f: Facts, roles: Awaited<ReturnType<typeof listRoles>>): CompareSide {
  if (f.kind === "role") {
    const row = roles.find((r) => r.key === f.id);
    const meta = [row?.description?.trim() || (row?.isSystem ? "Built-in role" : "Custom role"), f.active ? null : "switched off"].filter(Boolean).join(" · ");
    return { ref: `role:${f.id}`, kind: "role", id: f.id, name: f.name, meta };
  }
  const meta = [f.roleName, f.isSuperAdmin ? "super admin" : null, f.active ? null : "deactivated", f.overrides ? `${f.overrides} ${f.overrides === 1 ? "override" : "overrides"}` : null].filter(Boolean).join(" · ");
  return { ref: `user:${f.id}`, kind: "user", id: f.id, name: f.name, meta };
}

/**
 * Two subjects side by side — a role (`role:KEY`) or a person (`user:ID`) on each side: every
 * permission, every record type's reach, and every field policy with the daily unmask limit, each with
 * both answers and where each came from. With nothing named it opens on the first two roles.
 */
export async function compareSubjects(aRef?: string, bRef?: string): Promise<Comparison | null> {
  if (!(await reviewer())) return null;
  const dir = await directory();
  const world = await loadWorld();

  const load = async (ref: unknown, fallback: string | undefined): Promise<Facts | null> => {
    const text = typeof ref === "string" ? ref : "";
    const cut = text.indexOf(":");
    const kind = cut > 0 ? text.slice(0, cut) : "";
    const id = cut > 0 ? text.slice(cut + 1) : "";
    if (kind === "user" && dir.roster.some((u) => u.id === id)) return userFacts(id, dir.roleNames);
    if (kind === "role" && dir.roleNames.has(id)) return roleFacts(id, dir.roleNames, world);
    return fallback ? roleFacts(fallback, dir.roleNames, world) : null;
  };
  const [a, b] = await Promise.all([load(aRef, dir.roles[0]?.key), load(bRef, dir.roles[1]?.key ?? dir.roles[0]?.key)]);
  if (!a || !b) return null;

  const rows: CompareRow[] = [];

  for (const def of PERMISSIONS) {
    const pa = a.perm.get(def.key) ?? NOT_HELD;
    const pb = b.perm.get(def.key) ?? NOT_HELD;
    const say = (p: PermFact): CompareAnswer => ({ text: answer(p.held), on: p.held, tone: p.held ? "green" : "red", src: SRC_WORDS[p.via](p.held), why: p.why });
    const sa = say(pa);
    const sb = say(pb);
    rows.push({
      id: `perm:${def.key}`,
      section: "permission",
      module: moduleOfPermission(def),
      label: def.label,
      sub: isSectionKey(def.key) ? "menu section" : "",
      note: moduleNote(permissionModules(def.key), world.states),
      a: sa,
      b: sb,
      status: statusOf(sa, sb, pa.held === pb.held),
    });
  }

  for (const def of ACCESS_RECORDS) {
    const moduleKey = ACCESS_MODULES.find((m) => m.records.includes(def.key))?.key ?? "admin";
    for (const action of def.actions) {
      const la = a.level.get(slot(def.key, action));
      const lb = b.level.get(slot(def.key, action));
      const say = (l: LevelFact | undefined): CompareAnswer => {
        const level = l?.level ?? "NONE";
        return { text: LEVEL_WORDS[level].toUpperCase(), on: level !== "NONE", tone: level === "NONE" ? "red" : level === "ALL" ? "green" : "brand", src: l ? LEVEL_SRC[l.from] : "", why: l?.why ?? "" };
      };
      const sa = say(la);
      const sb = say(lb);
      rows.push({
        id: `reach:${def.key}:${action}`,
        section: "reach",
        module: moduleKey,
        label: `${def.label} › ${VERB[action]}`,
        sub: `"Own" means ${def.ownMeans}`,
        note: moduleNote(RECORD_MODULES[def.key] ?? [], world.states),
        a: sa,
        b: sb,
        status: statusOf(sa, sb, (la?.level ?? "NONE") === (lb?.level ?? "NONE")),
      });
    }
  }

  // Field policies are CRM's: leads, contacts and companies are its records.
  const fieldModule = ACCESS_MODULES.find((m) => m.records.includes("leads"))?.key ?? "crm";
  for (const entity of FIELD_ENTITIES) {
    const bByKey = new Map(b.fields[entity].map((x) => [x.key, x]));
    for (const fa of a.fields[entity]) {
      const fb = bByKey.get(fa.key);
      if (!fb) continue;
      const say = (x: FieldFact): CompareAnswer => {
        const masked = x.policy.view && (x.policy.maskInList || x.policy.maskInDetail);
        return {
          text: !x.policy.view ? "RESTRICTED" : masked ? "MASKED" : "VISIBLE",
          on: x.policy.view,
          tone: !x.policy.view ? "red" : masked ? "amber" : "green",
          src: x.policy.view ? describePolicy(x.policy, entity).replace(/^(visible|masked)(, )?/, "").trim() : "",
          why: x.why,
        };
      };
      const sa = say(fa);
      const sb = say(fb);
      rows.push({
        id: `field:${entity}:${fa.key}`,
        section: "field",
        module: fieldModule,
        label: `${FIELD_ENTITY_WORDS[entity].title} › ${fa.label}`,
        sub: fa.custom ? "field permission · custom field" : "field permission",
        note: null,
        a: sa,
        b: sb,
        status: statusOf(sa, sb, describePolicy(fa.policy, entity) === describePolicy(fb.policy, entity)),
      });
    }
  }
  {
    const say = (f: Facts): CompareAnswer => ({ text: f.limit.daily === null ? "NO LIMIT" : `${f.limit.daily} A DAY`, on: true, tone: "neutral", src: "", why: f.limit.why });
    const sa = say(a);
    const sb = say(b);
    rows.push({
      id: "field:unmask:dailyLimit",
      section: "field",
      module: fieldModule,
      label: "Daily unmask limit",
      sub: "records a person may unmask in one day",
      note: null,
      a: sa,
      b: sb,
      status: statusOf(sa, sb, a.limit.daily === b.limit.daily),
    });
  }

  return { a: sideOf(a, dir.roles), b: sideOf(b, dir.roles), rows, people: dir.people, roles: dir.roleOptions, modules: dir.modules };
}
