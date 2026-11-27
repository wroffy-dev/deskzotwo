import Link from "next/link";
import { notFound } from "next/navigation";
import { Eye } from "lucide-react";
import { effectivePermissionsFor } from "@/actions/permission";
import { permissionChangeHistory, userPermissionOverrides } from "@/actions/access";
import { accessPreview, personAccessGrid } from "@/actions/person-access";
import { fieldMaskingState, personFieldAccess, type PersonFieldAccess } from "@/actions/field-access";
import { listUnmaskEvents } from "@/actions/unmask-log";
import { currentUser } from "@/lib/session";
import { db } from "@/lib/db";
import { can, permissionsFor } from "@/lib/authz/resolve";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { roleGrants } from "@/lib/authz/role-permission";
import { inactiveRoleKeys, listRoles } from "@/lib/authz/role-registry";
import { unmaskLimitFor, unmaskUsageToday } from "@/lib/authz/unmask";
import { LEVEL_WORDS } from "@/lib/authz/level-order";
import { FIELD_ENTITIES, FIELD_ENTITY_WORDS, SENSITIVE_FIELDS, describePolicy, exportVisibility, visibility, type FieldEntity } from "@/lib/authz/field-policy";
import { getPermissionDefinition, PERMISSIONS } from "@/lib/permissions";
import { ACCESS_MODULES, FOLDED_KEYS, REACH_KEYS, moduleOfPermission, permissionsOfModule, sectionsOfModule } from "@/lib/staff/access-modules";
import { staffStatus } from "@/lib/staff/status";
import { workspaceClock } from "@/lib/time/workspace";
import { acPath } from "@/lib/access-control/nav";
import { employeeFacts, exceptionCountsByUser, type EmployeeFacts } from "@/lib/access-control/employees";
import { AcPage } from "@/components/access-control/ui";
import { ProfileHeader } from "@/components/access-control/employees/profile-header";
import { OverridesTab, type OtherException, type OverrideCatalogue, type OverrideRow } from "@/components/access-control/employees/overrides-tab";
import { PiiQuotaPanel } from "@/components/access-control/employees/pii-quota-panel";
import { personLeadLimit } from "@/actions/lead-limits";
import { PersonLeadLimitPanel } from "@/components/settings/access/lead-limit-editor";
import {
  ActivityTab,
  FieldsTab,
  ModulesTab,
  OverviewTab,
  PROFILE_TABS,
  PiiFieldsPanel,
  ProfileTabs,
  ScopeTab,
  SensitiveTab,
  UnmaskTodayPanel,
  type FieldSummaryRow,
  type ModuleSummary,
  type ProfileTabKey,
  type UnmaskGlance,
} from "@/components/access-control/employees/profile-sections";

export const metadata = { title: "Employee permissions" };

type Effective = NonNullable<Awaited<ReturnType<typeof effectivePermissionsFor>>>;
type Clock = Awaited<ReturnType<typeof workspaceClock>>;
type Edit = { canEdit: boolean; lockedWhy: string | null };

/**
 * Settings › Access Control › Employee Permissions › one person: who they are and their role, then what
 * applies to them once their role and their own exceptions are put together — by module, by field, by
 * record — the exceptions themselves, their sensitive access, their daily unmasking quota, and the
 * history of every change.
 *
 * `permissions.view` opens it; changing anything takes `permissions.manage`, never on yourself and
 * never on the super admin, as on Users. This page edits the permission exceptions and the daily limit;
 * the module matrix, the field manager, data scope and documents each open on this person from their
 * tab. The account itself — profile, password, how they sign in — stays on Users.
 */
export default async function EmployeeProfilePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const viewer = await currentUser();
  if (!viewer || !(await can(viewer.id, "permissions.view"))) notFound();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const person = await employeeFacts(id);
  if (!person) notFound();
  const tab: ProfileTabKey = PROFILE_TABS.find((t) => t.key === sp.tab)?.key ?? "overview";

  const [mayManage, mayEditUsers, mayAssignRole, mayViewAs, viewerRow, effective, countsBy, usage, roles, switchedOff] = await Promise.all([
    can(viewer.id, "permissions.manage"),
    can(viewer.id, "users.manage"),
    can(viewer.id, "users.assignRole"),
    can(viewer.id, "impersonation.use"),
    db.user.findUnique({ where: { id: viewer.id }, select: { isSuperAdmin: true, role: true } }),
    effectivePermissionsFor(person.id),
    exceptionCountsByUser(person.id),
    unmaskUsageToday(person.id),
    listRoles(),
    inactiveRoleKeys(),
  ]);
  if (!effective) notFound();
  const viewerIsSuperAdmin = viewerRow?.isSuperAdmin ?? false;
  const isYou = person.id === viewer.id;

  // The reasons Users gave for a read-only page, word for word.
  const lockedWhy = !mayManage
    ? "You can review access but not change it."
    : person.isSuperAdmin
      ? "A super admin holds everything and sees every field. There is nothing to set for them."
      : isYou
        ? "Your own access is changed by another admin."
        : null;
  const edit: Edit = { canEdit: lockedWhy === null, lockedWhy };

  const counts = countsBy.get(person.id);
  const live = counts ? counts.permissions + counts.levels + counts.fields + counts.limit : 0;
  const sensitiveHeld = effective.permissions.filter((p) => p.held && (p.tier === "sensitive" || p.tier === "critical"));
  const first = person.name.split(" ")[0] ?? person.name;

  return (
    <AcPage crumb={person.name}>
      <div className="flex flex-col gap-3.5">
        <Link href={acPath.employees()} className="-mt-1 w-fit text-xs text-muted hover:text-text">
          ← All employees
        </Link>
        {!mayManage && (
          <p className="flex items-center gap-2 rounded-lg border border-line bg-surface px-4 py-2.5 text-[13px] text-muted">
            <Eye className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
            You can review access but not change it. Everything here is read-only.
          </p>
        )}
        <ProfileHeader
          person={{
            id: person.id,
            name: person.name,
            email: person.email,
            role: person.role,
            roleName: person.roleName,
            isSuperAdmin: person.isSuperAdmin,
            status: staffStatus({ active: person.active, setupPending: person.setupPending }),
            active: person.active,
            department: person.departmentName,
            departmentId: person.departmentId,
            managerId: person.managerId,
            managerName: person.managerName,
            jobTitle: person.jobTitle,
          }}
          holds={effective.permissions.filter((p) => p.held).length}
          total={effective.permissions.length}
          exceptions={live + (counts?.lapsed ?? 0)}
          roles={roles.filter((r) => !switchedOff.has(r.key)).map((r) => ({ key: r.key, name: r.name }))}
          may={{
            changeRole: mayEditUsers && mayAssignRole && !isYou && (!person.isSuperAdmin || viewerIsSuperAdmin),
            reset: edit.canEdit,
            viewAs: mayViewAs && person.active && !isYou && !person.isSuperAdmin,
            // Never yourself, and never the super admin: the database keeps exactly one.
            switchAccount: mayEditUsers && !isYou && !person.isSuperAdmin,
          }}
        />
        <ProfileTabs id={person.id} active={tab} counts={{ overrides: live, sensitive: sensitiveHeld.length, pii: usage.remaining ?? 0 }} />

        {tab === "overview" && <Overview person={person} first={first} effective={effective} live={live} permissionsLive={counts?.permissions ?? 0} />}
        {tab === "modules" && <Modules person={person} first={first} effective={effective} edit={edit} />}
        {tab === "fields" && <Fields person={person} first={first} edit={edit} />}
        {tab === "overrides" && <Overrides person={person} edit={edit} viewer={{ id: viewer.id, isSuperAdmin: viewerIsSuperAdmin, role: viewerRow?.role ?? null }} />}
        {tab === "sensitive" && <Sensitive first={first} effective={effective} />}
        {tab === "pii" && <Pii person={person} first={first} edit={edit} viewer={{ id: viewer.id, isSuperAdmin: viewerIsSuperAdmin }} />}
        {tab === "scope" && <Scope person={person} first={first} edit={edit} />}
        {tab === "activity" && <Activity person={person} />}
      </div>
    </AcPage>
  );
}

// ─── Modules, as the overview and the Modules tab both show them ───────────────────────────────────

async function moduleSummaries(person: EmployeeFacts, effective: Effective): Promise<ModuleSummary[]> {
  const [mine, role] = await Promise.all([accessPreview({ userId: person.id }), accessPreview({ role: person.role })]);
  const held = new Set(effective.permissions.filter((p) => p.held).map((p) => p.key));
  const roleBy = new Map((role ?? []).map((m) => [m.key, m.standing]));
  const mineBy = new Map((mine ?? []).map((m) => [m.key, m.standing]));
  return ACCESS_MODULES.map((m) => {
    // The keys a module's standing counts (src/lib/staff/access-modules.ts `moduleStanding`).
    const keys = permissionsOfModule(m.key).filter((d) => !d.everyone && !FOLDED_KEYS.has(d.key));
    return {
      key: m.key,
      label: m.label,
      description: m.description,
      icon: m.icon,
      standing: mineBy.get(m.key) ?? "none",
      roleStanding: roleBy.get(m.key) ?? "none",
      held: keys.filter((d) => held.has(d.key)).length,
      total: keys.length,
    };
  });
}

async function Overview({ person, first, effective, live, permissionsLive }: { person: EmployeeFacts; first: string; effective: Effective; live: number; permissionsLive: number }) {
  const [modules, overrides, clock] = await Promise.all([moduleSummaries(person, effective), userPermissionOverrides(person.id), workspaceClock()]);
  const glance = overrides
    .filter((o) => !o.expired)
    .slice(0, 4)
    .map((o) => ({
      key: o.permission,
      label: getPermissionDefinition(o.permission)?.label ?? o.permission,
      allowed: o.allowed,
      meta: [o.expiresAt ? `until ${clock.date(new Date(o.expiresAt.getTime() - 1))}` : "permanent", o.grantedBy ? `by ${o.grantedBy.name}` : null, o.reason].filter(Boolean).join(" · "),
    }));
  return (
    <OverviewTab
      id={person.id}
      first={first}
      roleName={person.roleName}
      modules={modules}
      overrides={glance}
      overrideCount={permissionsLive}
      otherExceptions={live - permissionsLive}
      sensitive={effective.permissions.filter((p) => p.held && (p.tier === "sensitive" || p.tier === "critical")).map((p) => ({ key: p.key, label: p.label, critical: p.tier === "critical" }))}
    />
  );
}

async function Modules({ person, first, effective, edit }: { person: EmployeeFacts; first: string; effective: Effective; edit: Edit }) {
  return <ModulesTab id={person.id} first={first} roleName={person.roleName} modules={await moduleSummaries(person, effective)} canEdit={edit.canEdit} />;
}

// ─── Fields ───────────────────────────────────────────────────────────────────────────────────────

const KIND_OF_FIELD = new Map(SENSITIVE_FIELDS.map((f) => [`${f.entity}:${f.key}`, f.kind]));

function fieldRows(entity: FieldEntity, data: PersonFieldAccess): (FieldSummaryRow & { kind: string })[] {
  return data.rows.map((r) => {
    const p = r.effective;
    const masked = p.view && (p.maskInList || p.maskInDetail);
    return {
      entity,
      entityTitle: FIELD_ENTITY_WORDS[entity].title,
      key: r.key,
      label: r.label,
      kind: KIND_OF_FIELD.get(`${entity}:${r.key}`) ?? r.kind,
      list: visibility(p, "list"),
      detail: visibility(p, "detail"),
      exported: exportVisibility(p),
      unmask: masked ? p.unmask : null,
      why: r.why,
      own: r.stored !== null,
    };
  });
}

async function fieldAccessByEntity(userId: string) {
  const all = await Promise.all(FIELD_ENTITIES.map(async (entity) => ({ entity, data: await personFieldAccess(userId, entity) })));
  return all.flatMap((a) => (a.data ? [{ entity: a.entity, data: a.data }] : []));
}

function MaskingOffNote() {
  return (
    <p className="rounded-md bg-warning-bg px-3 py-2 text-xs leading-[1.5] text-warning">
      Field masking is switched off for the workspace under{" "}
      <Link href={acPath.masking()} className="font-semibold underline">
        Global PII Masking
      </Link>
      . The rules below are kept as they are, and apply again when it is switched back on; until then masked fields show in the clear.
    </p>
  );
}

async function Fields({ person, first, edit }: { person: EmployeeFacts; first: string; edit: Edit }) {
  const [byEntity, masking] = await Promise.all([fieldAccessByEntity(person.id), fieldMaskingState()]);
  if (byEntity.length === 0) return <p className="rounded-lg border border-line bg-surface px-4 py-6 text-center text-subtle">Their field access can&apos;t be read.</p>;
  return (
    <div className="flex flex-col gap-3.5">
      {!masking.enabled && <MaskingOffNote />}
      <FieldsTab id={person.id} first={first} canEdit={edit.canEdit} groups={byEntity.map(({ entity, data }) => ({ entity, title: FIELD_ENTITY_WORDS[entity].title, rows: fieldRows(entity, data) }))} />
    </div>
  );
}

// ─── Overrides ────────────────────────────────────────────────────────────────────────────────────

/** The last day an end-of-day expiry names, as a key and in words, and how far off it is. */
function endOf(expiresAt: Date | string | null, clock: Clock, now: Date) {
  if (!expiresAt) return { endsOn: null, endsOnText: null, daysLeft: null, expired: false };
  const end = new Date(expiresAt);
  const lastMoment = new Date(end.getTime() - 1);
  return { endsOn: clock.dateKey(lastMoment), endsOnText: clock.date(lastMoment), daysLeft: clock.daysBetween(now, lastMoment), expired: end.getTime() <= now.getTime() };
}

async function Overrides({
  person,
  edit,
  viewer,
}: {
  person: EmployeeFacts;
  edit: Edit;
  viewer: { id: string; isSuperAdmin: boolean; role: string | null };
}) {
  const [overrides, grants, grid, byEntity, clock, viewerHeld] = await Promise.all([
    userPermissionOverrides(person.id),
    roleGrants(person.role),
    personAccessGrid(person.id),
    fieldAccessByEntity(person.id),
    workspaceClock(),
    permissionsFor(viewer.id),
  ]);
  const now = new Date();
  const moduleLabel = (key: string) => {
    const def = getPermissionDefinition(key);
    const moduleKey = ACCESS_MODULES.find((m) => m.sections.includes(key))?.key ?? (def ? moduleOfPermission(def) : "admin");
    return ACCESS_MODULES.find((m) => m.key === moduleKey)?.label ?? "Settings";
  };

  const rows: OverrideRow[] = overrides
    .map((o) => {
      const def = getPermissionDefinition(o.permission);
      return {
        key: o.permission,
        // A key removed from the registry leaves its rows behind; say so rather than showing blank.
        label: def?.label ?? `${o.permission} (no longer a permission)`,
        moduleLabel: moduleLabel(o.permission),
        allowed: o.allowed,
        roleGives: grants(o.permission),
        reason: o.reason,
        grantedBy: o.grantedBy?.name ?? null,
        grantedOnText: clock.date(o.createdAt),
        ...endOf(o.expiresAt, clock, now),
      };
    })
    // In force first, lapsed after.
    .sort((a, b) => Number(a.expired) - Number(b.expired));

  const others: OtherException[] = [];
  for (const r of grid ?? []) {
    for (const action of r.actions) {
      const cell = r.cells[action];
      if (!cell.own) continue;
      const end = endOf(cell.own.expiresAt, clock, now);
      others.push({
        kind: "level",
        id: `level:${r.key}:${action}`,
        label: `${r.label} — ${action}`,
        value: `${LEVEL_WORDS[cell.own.level]} (the role gives ${LEVEL_WORDS[cell.role]})`,
        detail: [cell.own.reason, end.endsOnText ? `until ${end.endsOnText}` : "no end date"].filter(Boolean).join(" · "),
        href: acPath.scope({ user: person.id }),
        record: r.key,
        action,
      });
    }
  }
  for (const { entity, data } of byEntity) {
    for (const r of data.rows) {
      if (!r.override) continue;
      const end = endOf(r.override.expiresAt, clock, now);
      const lapsed = r.stored === null;
      others.push({
        kind: "field",
        id: `field:${entity}:${r.key}`,
        label: `${FIELD_ENTITY_WORDS[entity].title} › ${r.label}`,
        value: r.stored ? describePolicy(r.stored, entity) : `lapsed ${end.endsOnText ?? ""} — no longer applied`,
        detail: [r.override.reason, !lapsed ? (end.endsOnText ? `until ${end.endsOnText}` : "no end date") : null, r.override.grantedBy ? `by ${r.override.grantedBy}` : null].filter(Boolean).join(" · "),
        href: acPath.fields({ user: person.id, entity }),
        entity,
        field: r.key,
        lapsed,
      });
    }
  }
  const ownLimit = byEntity[0]?.data.limit.own ?? null;
  if (ownLimit) {
    const end = endOf(ownLimit.expiresAt, clock, now);
    others.push({
      kind: "limit",
      id: "limit",
      label: "Daily unmasking limit",
      value: `${ownLimit.limited ? `${ownLimit.dailyLimit ?? 0} records a day` : "no limit"}${end.expired ? ` — lapsed ${end.endsOnText}, no longer applied` : ""}`,
      detail: [ownLimit.reason, !end.expired ? (end.endsOnText ? `until ${end.endsOnText}` : "no end date") : null].filter(Boolean).join(" · "),
      href: acPath.employee(person.id, "pii"),
    });
  }

  // What "Add override" offers: every permission by module, and its place in the menu — the keys the
  // person editor on Users offered — with the ones this viewer can't hand out marked, as the server
  // will refuse them (src/lib/authz/guards.ts `assertGrantWithinOwnAuthority`).
  const viewerHolds = new Set<string>(viewerHeld.map(String));
  const own = new Map(overrides.filter((o) => !o.expired).map((o) => [o.permission, o.allowed]));
  const blockedWhy = (key: string): string | null => {
    if (viewer.isSuperAdmin) return null;
    const def = getPermissionDefinition(key);
    if (!def) return "Unknown permission.";
    if (def.superAdminOnly) return `"${def.label}" can only be granted by a super admin.`;
    if (def.adminOnly && viewer.role !== "ADMIN") return `"${def.label}" can only be given by an admin or the super admin.`;
    if (!viewerHolds.has(key)) return `You can't grant or deny "${def.label}" because you don't hold it yourself.`;
    return null;
  };
  const choice = (key: string, label: string) => {
    const mine = own.get(key);
    return { key, label, roleGives: grants(key), own: mine === undefined ? null : mine ? ("allow" as const) : ("deny" as const), blocked: blockedWhy(key) };
  };
  const catalogue: OverrideCatalogue = ACCESS_MODULES.map((m) => ({
    module: m.key,
    label: m.label,
    options: [
      ...permissionsOfModule(m.key)
        .filter((d) => !REACH_KEYS.has(d.key) && !FOLDED_KEYS.has(d.key))
        .map((d) => choice(d.key, d.label)),
      ...sectionsOfModule(m.key).map((d) => choice(d.key, `Menu: ${d.label}`)),
    ],
  }));

  return (
    <OverridesTab
      // Remounted when the stored exceptions change, so a dialog never opens on a row that has gone.
      key={rows.map((r) => `${r.key}:${r.allowed}:${r.endsOn}`).join("|")}
      userId={person.id}
      name={person.name}
      roleName={person.roleName}
      rows={rows}
      others={others}
      catalogue={catalogue}
      today={clock.today()}
      canEdit={edit.canEdit}
      lockedWhy={edit.lockedWhy}
    />
  );
}

// ─── Sensitive access ─────────────────────────────────────────────────────────────────────────────

function Sensitive({ first, effective }: { first: string; effective: Effective }) {
  const rows = effective.permissions
    .filter((p) => p.tier === "sensitive" || p.tier === "critical")
    .map((p) => ({ key: p.key, label: p.label, group: p.group, critical: p.tier === "critical", held: p.held, why: p.why, selfExcluded: getPermissionDefinition(p.key)?.selfExcluded === true }))
    // What they hold first, the critical ones ahead.
    .sort((a, b) => Number(b.held) - Number(a.held) || Number(b.critical) - Number(a.critical));
  const held = new Set(effective.permissions.filter((p) => p.held).map((p) => p.key));
  const separated = PERMISSIONS.filter((d) => d.selfExcluded && held.has(d.key)).map((d) => ({ key: d.key, label: d.label }));
  return <SensitiveTab first={first} rows={rows} separated={separated} />;
}

// ─── PII & Unmasking ──────────────────────────────────────────────────────────────────────────────

const FIELD_LABELS = new Map(SENSITIVE_FIELDS.map((f) => [`${f.entity}:${f.key}`, f.label]));
const fieldLabel = (entity: string, key: string) => FIELD_LABELS.get(`${entity}:${key}`) ?? (key.startsWith("custom:") ? key.slice("custom:".length) : key);

async function Pii({ person, first, edit, viewer }: { person: EmployeeFacts; first: string; edit: Edit; viewer: { id: string; isSuperAdmin: boolean } }) {
  const [byEntity, masking, clock, maySeeLog, viewerLimit, leadLimit] = await Promise.all([
    fieldAccessByEntity(person.id),
    fieldMaskingState(),
    workspaceClock(),
    // The unmasking log is the super admin's alone, as themselves (src/actions/unmask-log.ts).
    actingAsSuperAdmin(viewer.id),
    viewer.isSuperAdmin ? Promise.resolve(null) : unmaskLimitFor(viewer.id),
    // Their lead limits (Phase 4, audit H.6.5), beside the unmasking limit as the old Business Rules tab had them.
    personLeadLimit(person.id),
  ]);
  const leads = byEntity.find((e) => e.entity === "leads")?.data ?? byEntity[0]?.data;
  if (!leads) return <p className="rounded-lg border border-line bg-surface px-4 py-6 text-center text-subtle">Their field access can&apos;t be read.</p>;

  const today = clock.today();
  const [todays, lastCounted] = maySeeLog
    ? await Promise.all([listUnmaskEvents({ userId: person.id, from: today, to: today }, { page: 1, pageSize: 12 }), listUnmaskEvents({ userId: person.id, result: "ALLOWED" }, { page: 1, pageSize: 1 })])
    : [null, null];
  const todayRows = todays?.ok ? todays.data.rows : [];
  // The latest time a record opened in the clear for them: counted, or opened again the same day.
  const lastReveal = [todayRows.find((r) => r.result === "ALLOWED" || r.result === "REPEAT")?.at, lastCounted?.ok ? lastCounted.data.rows[0]?.at : undefined].filter((at): at is string => Boolean(at)).sort().pop() ?? null;
  const events: UnmaskGlance[] = todayRows.map((r) => ({
    id: r.id,
    at: r.at,
    result: r.result,
    consumed: r.consumed,
    fields: r.fields.map((f) => fieldLabel(r.entity, f)).join(", ") || "—",
    record: r.entity === "leads" ? (r.lead ? `${r.leadRef ?? ""} ${r.lead.title}`.trim() : (r.leadRef ?? "Lead removed")) : r.entity === "contacts" ? (r.contact?.name ?? "Contact removed") : (r.leadRef ?? r.recordId),
    meta: [FIELD_ENTITY_WORDS[r.entity as FieldEntity]?.title ?? r.entity, r.statedReason ? `“${r.statedReason}”` : null, r.reason, r.impersonatedBy ? `by ${r.impersonatedBy}, viewing as them` : null].filter(Boolean).join(" · "),
    usedToday: r.usedToday,
    dailyLimit: r.dailyLimit,
  }));

  const own = leads.limit.own;
  const ownEnd = endOf(own?.expiresAt ?? null, clock, new Date());
  const piiRows = byEntity.flatMap(({ entity, data }) => fieldRows(entity, data).filter((r) => r.kind === "email" || r.kind === "phone"));

  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(300px,1fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <PiiQuotaPanel
          key={`${own?.limited}:${own?.dailyLimit}:${own?.expiresAt}:${leads.limit.effective}`}
          userId={person.id}
          name={person.name}
          limit={leads.limit}
          usage={leads.usage}
          zone={leads.zone}
          ownEndsOn={ownEnd.endsOn}
          ownEndsOnText={ownEnd.endsOnText}
          ownLapsed={ownEnd.expired}
          lastReveal={lastReveal}
          maySeeLog={maySeeLog}
          maskingOn={masking.enabled}
          viewerLimit={viewer.isSuperAdmin ? "any" : (viewerLimit?.dailyLimit ?? null)}
          today={today}
          canEdit={edit.canEdit && leads.editable}
          lockedWhy={edit.lockedWhy ?? leads.why}
        />
        <PiiFieldsPanel id={person.id} first={first} rows={piiRows} />
        {leadLimit && (
          <PersonLeadLimitPanel
            key={`lead-limit:${person.id}:${JSON.stringify(leadLimit.own)}`}
            userId={person.id}
            name={person.name}
            data={leadLimit}
            canEdit={edit.canEdit && leadLimit.editable}
          />
        )}
        {leadLimit && edit.canEdit && !leadLimit.editable && leadLimit.lockedWhy && <p className="text-xs text-subtle">{leadLimit.lockedWhy}</p>}
      </div>
      <UnmaskTodayPanel id={person.id} events={events} maySeeLog={maySeeLog} total={todays?.ok ? todays.data.total : 0} />
    </div>
  );
}

// ─── Data scope ───────────────────────────────────────────────────────────────────────────────────

async function Scope({ person, first, edit }: { person: EmployeeFacts; first: string; edit: Edit }) {
  const grid = await personAccessGrid(person.id);
  return (
    <ScopeTab
      id={person.id}
      first={first}
      canEdit={edit.canEdit}
      records={(grid ?? []).map((r) => ({
        key: r.key,
        label: r.label,
        ownMeans: r.ownMeans,
        actions: r.actions.map((action) => ({ action, level: r.cells[action].effective, role: r.cells[action].role, own: r.cells[action].own !== null, why: r.cells[action].why })),
      }))}
    />
  );
}

// ─── Activity ─────────────────────────────────────────────────────────────────────────────────────

const HISTORY_PAGE = 50;

async function Activity({ person }: { person: EmployeeFacts }) {
  const history = await permissionChangeHistory({ userId: person.id, limit: HISTORY_PAGE + 1 });
  return (
    <ActivityTab
      id={person.id}
      name={person.name}
      capped={history.length > HISTORY_PAGE}
      rows={history.slice(0, HISTORY_PAGE).map((h) => ({
        id: h.id,
        kind: h.changeKind,
        text: h.detail ?? (h.permission ? (getPermissionDefinition(h.permission)?.label ?? h.permission) : h.changeKind.toLowerCase().replaceAll("_", " ")),
        actor: h.actor?.name ?? null,
        whileViewingAs: Boolean(h.impersonatedByUserId),
        at: h.createdAt.toISOString(),
      }))}
    />
  );
}
