import Link from "next/link";
import { Ban, Check, ExternalLink, Eye, History, KeyRound, Pencil, RotateCcw, ShieldAlert, SlidersHorizontal, UserCog, X } from "lucide-react";
import type { AccessLevel } from "@prisma/client";
import type { ModuleIcon, ModuleStanding } from "@/lib/staff/access-modules";
import type { FieldEntity } from "@/lib/authz/field-policy";
import { acPath } from "@/lib/access-control/nav";
import { Ago } from "@/components/ui/ago";
import { EmptyNote, Panel, PanelHeader, Pill, StateTag, acButton, panelLinkClass, rowHoverClass, tdClass, thClass, type PillTone } from "@/components/access-control/ui";
import { ModuleGlyph, StandingPill } from "@/components/access-control/employees/shared";
import { cn } from "@/lib/utils";

/**
 * The read-only parts of one person's Access Control page: the tab strip, the overview, and the compact
 * summaries of their modules, fields, record reach, sensitive access and history. Each summary says what
 * applies to them once their role and their own exceptions are put together, and links to the screen
 * that edits it. Nothing here fetches or changes anything — the page hands every value in.
 */

// ─── Tabs ─────────────────────────────────────────────────────────────────────────────────────────

export const PROFILE_TABS = [
  { key: "overview", label: "Overview" },
  { key: "modules", label: "Module permissions" },
  { key: "fields", label: "Field permissions" },
  { key: "overrides", label: "Overrides" },
  { key: "sensitive", label: "Sensitive access" },
  { key: "pii", label: "PII & Unmasking" },
  { key: "scope", label: "Data scope" },
  { key: "activity", label: "Activity" },
] as const;
export type ProfileTabKey = (typeof PROFILE_TABS)[number]["key"];

export function ProfileTabs({ id, active, counts }: { id: string; active: ProfileTabKey; counts: Partial<Record<ProfileTabKey, number>> }) {
  return (
    <nav aria-label="Sections" className="flex gap-0.5 overflow-x-auto border-b border-line">
      {PROFILE_TABS.map((t) => {
        const on = t.key === active;
        const count = counts[t.key] ?? 0;
        return (
          <Link
            key={t.key}
            href={acPath.employee(id, t.key === "overview" ? undefined : t.key)}
            aria-current={on ? "page" : undefined}
            className={cn("-mb-px inline-flex h-9 items-center gap-1.5 whitespace-nowrap border-b-2 px-3.5 text-[13px] font-semibold transition-colors", on ? "border-brand text-brand" : "border-transparent text-muted hover:text-text")}
          >
            {t.label}
            {count > 0 && <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-surface-sunken px-[5px] text-[11px] font-bold text-muted">{count}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

/** The "Edit" a read-only summary ends with: the screen that owns it, opened on this person. */
function EditLink({ href, canEdit, label }: { href: string; canEdit: boolean; label: string }) {
  return (
    <Link href={href} className={cn(acButton.secondary, "h-7 px-2.5 text-xs font-semibold")}>
      {canEdit ? <Pencil className="h-3.5 w-3.5" aria-hidden /> : <ExternalLink className="h-3.5 w-3.5" aria-hidden />}
      {canEdit ? `Edit in ${label}` : `Open ${label}`}
    </Link>
  );
}

const yesNo = (yes: boolean) => (
  <span
    className={cn("inline-flex h-[22px] w-[22px] items-center justify-center rounded-full", yes ? "bg-success-bg text-success" : "bg-surface-sunken text-subtle")}
    title={yes ? "Allowed" : "Not allowed"}
  >
    {yes ? <Check className="h-[15px] w-[15px]" aria-hidden /> : <X className="h-[15px] w-[15px]" aria-hidden />}
    <span className="sr-only">{yes ? "Allowed" : "Not allowed"}</span>
  </span>
);

// ─── Overview ─────────────────────────────────────────────────────────────────────────────────────

export type ModuleSummary = {
  key: string;
  label: string;
  description: string;
  icon: ModuleIcon;
  /** What applies to them: their role and their own exceptions together. */
  standing: ModuleStanding;
  /** What their role gives on its own. */
  roleStanding: ModuleStanding;
  /** The module's permissions they hold, of how many it has (its menu sections apart). */
  held: number;
  total: number;
};

export type OverrideGlance = { key: string; label: string; allowed: boolean; meta: string };

export function OverviewTab({
  id,
  first,
  roleName,
  modules,
  overrides,
  overrideCount,
  otherExceptions,
  sensitive,
}: {
  id: string;
  first: string;
  roleName: string;
  modules: ModuleSummary[];
  /** The first few permission exceptions in force. */
  overrides: OverrideGlance[];
  overrideCount: number;
  /** Record levels, field policies and a daily limit of their own, in force. */
  otherExceptions: number;
  /** The sensitive and critical permissions they hold. */
  sensitive: { key: string; label: string; critical: boolean }[];
}) {
  const SHOWN = 14;
  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(300px,1fr)]">
      <Panel>
        <PanelHeader
          title="Effective module access"
          meta={<span className="text-xs text-subtle">role + their own exceptions</span>}
          action={
            <Link href={acPath.modules({ user: id })} className={panelLinkClass}>
              Full matrix
            </Link>
          }
        />
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-px bg-line/70">
          {modules.map((m) => (
            <Link key={m.key} href={acPath.modules({ user: id })} className="flex items-center gap-2.5 bg-surface px-3.5 py-2.5 text-left transition-colors hover:bg-surface-sunken">
              <ModuleGlyph icon={m.icon} className={m.standing === "none" ? "text-subtle" : "text-text/80"} />
              <span className="min-w-0 flex-1">
                <span className={cn("block font-semibold", m.standing === "none" ? "text-subtle" : "text-text")}>{m.label}</span>
                <span className="block text-[11.5px] text-subtle">{m.standing === "none" ? "No access" : `${m.held} of ${m.total} permissions`}</span>
              </span>
              <span
                title={m.standing === "full" ? "Full access" : m.standing === "limited" ? "Limited access" : "No access"}
                className={cn("h-2 w-2 shrink-0 rounded-full", m.standing === "full" ? "bg-success" : m.standing === "limited" ? "bg-warning" : "bg-line-strong")}
              />
            </Link>
          ))}
        </div>
      </Panel>

      <div className="flex min-w-0 flex-col gap-4">
        <Panel>
          <PanelHeader
            title="Active overrides"
            meta={overrideCount > 0 ? <span className="text-xs text-subtle">{overrideCount}</span> : undefined}
            action={
              <Link href={acPath.employee(id, "overrides")} className={panelLinkClass}>
                All overrides
              </Link>
            }
          />
          {overrideCount === 0 && otherExceptions === 0 && (
            <p className="px-4 py-4 text-xs text-subtle">
              No overrides. {first} gets exactly what the {roleName} role grants.
            </p>
          )}
          {overrides.map((o) => (
            <div key={o.key} className="flex items-start gap-2.5 border-b border-line/70 px-4 py-2.5 last:border-0">
              <Pill tone={o.allowed ? "green" : "red"} className="mt-px h-[18px] px-[7px] text-[10px] font-bold tracking-[0.04em]">
                {o.allowed ? "ALLOW" : "DENY"}
              </Pill>
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-medium text-text">{o.label}</div>
                <div className="text-[11.5px] text-muted">{o.meta}</div>
              </div>
            </div>
          ))}
          {overrideCount > overrides.length && <p className="border-b border-line/70 px-4 py-2 text-[11.5px] text-subtle last:border-0">and {overrideCount - overrides.length} more</p>}
          {otherExceptions > 0 && (
            <p className="px-4 py-2.5 text-[11.5px] text-muted">
              Plus {otherExceptions} other {otherExceptions === 1 ? "exception" : "exceptions"}: record access, field access or a daily unmasking limit of their own.
            </p>
          )}
        </Panel>

        <Panel>
          <PanelHeader
            title="Sensitive access this person holds"
            action={
              <Link href={acPath.employee(id, "sensitive")} className={panelLinkClass}>
                Details
              </Link>
            }
          />
          <div className="flex flex-wrap gap-1 px-4 py-2.5">
            {sensitive.slice(0, SHOWN).map((c) => (
              <span key={c.key} className={cn("inline-flex h-[22px] items-center gap-1 rounded-[5px] px-2 text-[11.5px] font-semibold", c.critical ? "bg-danger-bg text-danger" : "bg-warning-bg text-warning")}>
                {c.critical ? <ShieldAlert className="h-[13px] w-[13px]" aria-hidden /> : <KeyRound className="h-[13px] w-[13px]" aria-hidden />}
                {c.label}
              </span>
            ))}
            {sensitive.length > SHOWN && <span className="inline-flex h-[22px] items-center px-1 text-[11.5px] text-muted">+{sensitive.length - SHOWN} more</span>}
            {sensitive.length === 0 && <span className="text-xs text-subtle">None.</span>}
          </div>
        </Panel>
      </div>
    </div>
  );
}

// ─── Modules ──────────────────────────────────────────────────────────────────────────────────────

export function ModulesTab({ id, first, roleName, modules, canEdit }: { id: string; first: string; roleName: string; modules: ModuleSummary[]; canEdit: boolean }) {
  return (
    <Panel>
      <PanelHeader
        title="Module access"
        meta={<span className="text-xs text-subtle">what the role gives, and what applies to {first}</span>}
        action={
          <span className="flex flex-wrap items-center gap-2">
            <EditLink href={acPath.documents({ user: id })} canEdit={canEdit} label="Document Permissions" />
            <EditLink href={acPath.modules({ user: id })} canEdit={canEdit} label="Module Matrix" />
          </span>
        }
      />
      <div className="overflow-auto">
        <table className="w-full min-w-[720px] border-collapse">
          <thead>
            <tr>
              <th className={thClass}>Module</th>
              <th className={thClass}>Role · {roleName}</th>
              <th className={thClass}>Effective for {first}</th>
              <th className={thClass}>Permissions held</th>
            </tr>
          </thead>
          <tbody>
            {modules.map((m) => (
              <tr key={m.key} className={rowHoverClass}>
                <td className={tdClass}>
                  <div className="flex items-center gap-2.5">
                    <ModuleGlyph icon={m.icon} className={m.standing === "none" ? "text-subtle" : "text-text/80"} />
                    <div className="min-w-0">
                      <div className="font-semibold text-text">{m.label}</div>
                      <div className="text-[11.5px] text-subtle">{m.description}</div>
                    </div>
                  </div>
                </td>
                <td className={tdClass}>
                  <StandingPill standing={m.roleStanding} />
                </td>
                <td className={tdClass}>
                  <span className="inline-flex items-center gap-1.5">
                    <StandingPill standing={m.standing} />
                    {m.standing !== m.roleStanding && <Pill tone="brand">Differs from role</Pill>}
                  </span>
                </td>
                <td className={cn(tdClass, "whitespace-nowrap text-text/80")}>
                  {m.total === 0 ? <span className="text-subtle">—</span> : `${m.held} of ${m.total}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// ─── Fields ───────────────────────────────────────────────────────────────────────────────────────

type Seen = "clear" | "masked" | "restricted" | "none";
const SEEN: Record<Seen, { text: string; tone: PillTone }> = {
  clear: { text: "Clear", tone: "green" },
  masked: { text: "Masked", tone: "amber" },
  restricted: { text: "Hidden", tone: "red" },
  none: { text: "Left out", tone: "neutral" },
};

export type FieldSummaryRow = {
  entity: FieldEntity;
  entityTitle: string;
  key: string;
  label: string;
  /** How the value shows in a list, on the record, and in an export or an API list. */
  list: Seen;
  detail: Seen;
  exported: Seen;
  /** Whether they may unmask it; null where it is never masked for them, so there is nothing to unmask. */
  unmask: boolean | null;
  /** Where the answer comes from, in words. */
  why: string;
  /** A policy of their own is in force on it. */
  own: boolean;
};

function FieldRows({ rows, showEntity, id }: { rows: FieldSummaryRow[]; showEntity: boolean; id: string }) {
  return (
    <div className="overflow-auto">
      <table className="w-full min-w-[680px] border-collapse">
        <thead>
          <tr>
            <th className={thClass}>Field</th>
            <th className={cn(thClass, "w-[90px] text-center")}>In lists</th>
            <th className={cn(thClass, "w-[100px] text-center")}>On the record</th>
            <th className={cn(thClass, "w-[90px] text-center")}>Unmask</th>
            <th className={cn(thClass, "w-[90px] text-center")}>Export</th>
            <th className={thClass}>Source</th>
            {showEntity && <th className={cn(thClass, "w-10")} />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.entity}:${r.key}`} className={rowHoverClass}>
              <td className={tdClass}>
                <span className="font-medium text-text">{showEntity ? `${r.entityTitle} › ${r.label}` : r.label}</span>
                {r.own && (
                  <Pill tone="brand" className="ml-1.5">
                    Own
                  </Pill>
                )}
              </td>
              <td className={cn(tdClass, "text-center")}>
                <StateTag tone={SEEN[r.list].tone}>{SEEN[r.list].text}</StateTag>
              </td>
              <td className={cn(tdClass, "text-center")}>
                <StateTag tone={SEEN[r.detail].tone}>{SEEN[r.detail].text}</StateTag>
              </td>
              <td className={cn(tdClass, "text-center")}>
                {r.unmask === null ? <span className="text-subtle" title="Never masked for them, so there is nothing to unmask.">—</span> : <StateTag tone={r.unmask ? "green" : "red"}>{r.unmask ? "Allow" : "Deny"}</StateTag>}
              </td>
              <td className={cn(tdClass, "text-center")}>
                <StateTag tone={SEEN[r.exported].tone}>{SEEN[r.exported].text}</StateTag>
              </td>
              <td className={cn(tdClass, "text-xs text-muted")}>{r.why}</td>
              {showEntity && (
                <td className={cn(tdClass, "text-right")}>
                  <Link
                    href={acPath.fields({ user: id, entity: r.entity })}
                    title="Open in Field Permissions"
                    aria-label={`Open ${r.entityTitle} › ${r.label} in Field Permissions`}
                    className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-md text-muted hover:bg-surface-sunken"
                  >
                    <ExternalLink className="h-4 w-4" aria-hidden />
                  </Link>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FieldsTab({ id, first, groups, canEdit }: { id: string; first: string; groups: { entity: FieldEntity; title: string; rows: FieldSummaryRow[] }[]; canEdit: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[12.5px] leading-[1.5] text-muted">
        How each sensitive field of a lead, a contact and a company shows for {first}: in the clear, masked, or hidden — and whether they may unmask it. A field with nothing set is visible and unmasked.
      </p>
      {groups.map((g) => {
        const masked = g.rows.filter((r) => r.list !== "clear" || r.detail !== "clear").length;
        return (
          <Panel key={g.entity}>
            <PanelHeader
              title={g.title}
              meta={
                <span className="text-xs text-subtle">
                  {masked} of {g.rows.length} fields masked or hidden
                </span>
              }
              action={<EditLink href={acPath.fields({ user: id, entity: g.entity })} canEdit={canEdit} label="Field Permissions" />}
            />
            {g.rows.length === 0 ? <EmptyNote>No sensitive fields here.</EmptyNote> : <FieldRows rows={g.rows} showEntity={false} id={id} />}
          </Panel>
        );
      })}
    </div>
  );
}

/** The PII tab's table: the email and phone fields alone, across leads, contacts and companies. */
export function PiiFieldsPanel({ id, first, rows }: { id: string; first: string; rows: FieldSummaryRow[] }) {
  return (
    <Panel>
      <PanelHeader title="PII field permissions (effective)" meta={<span className="text-xs text-subtle">email and phone fields, as they show for {first}</span>} />
      {rows.length === 0 ? <EmptyNote>No email or phone field is covered by field access.</EmptyNote> : <FieldRows rows={rows} showEntity id={id} />}
    </Panel>
  );
}

// ─── Data scope ───────────────────────────────────────────────────────────────────────────────────

const LEVEL_TEXT: Record<AccessLevel, string> = { NONE: "None", OWN: "Own", TEAM: "Team", BRANCH: "Branch", ALL: "All", FOLLOW: "Account" };
const LEVEL_TONE: Record<AccessLevel, PillTone> = { NONE: "neutral", OWN: "neutral", TEAM: "blue", BRANCH: "amber", ALL: "red", FOLLOW: "brand" };
const LEVEL_SENTENCE: Record<AccessLevel, string> = {
  NONE: "sees none of them",
  OWN: "sees their own",
  TEAM: "sees their own and their team's",
  BRANCH: "sees their branch's",
  ALL: "sees all of them",
  FOLLOW: "sees those of the accounts they reach",
};

export type ScopeSummary = {
  key: string;
  label: string;
  ownMeans: string;
  actions: { action: string; level: AccessLevel; role: AccessLevel; own: boolean; why: string }[];
};

export function ScopeTab({ id, first, records, canEdit }: { id: string; first: string; records: ScopeSummary[]; canEdit: boolean }) {
  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-[240px] flex-1 text-[12.5px] leading-[1.5] text-muted">
          Which records of each kind {first} reaches, for each action: none, their own, their team&apos;s (theirs and their reports&apos;), their branch&apos;s, or all. Edit, delete and assign never reach wider than view.
        </p>
        <EditLink href={acPath.scope({ user: id })} canEdit={canEdit} label="Data Scope" />
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
        {records.map((r) => {
          const view = r.actions.find((a) => a.action === "view");
          const none = !view || view.level === "NONE";
          return (
            <div key={r.key} className={cn("flex flex-col gap-2 rounded-lg border border-line bg-surface px-4 py-3.5", none && "opacity-70")}>
              <div className="flex items-center gap-2">
                <span className="flex-1 font-semibold text-text">{r.label}</span>
                {view && <Pill tone={LEVEL_TONE[view.level]}>{LEVEL_TEXT[view.level]}</Pill>}
              </div>
              <p className="text-[12.5px] leading-[1.5] text-text/80">
                {first} {view ? LEVEL_SENTENCE[view.level] : "has no view here"}.
              </p>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {r.actions.map((a) => (
                  <span key={a.action} className="inline-flex items-center gap-1 text-[11.5px] capitalize text-muted" title={a.why || undefined}>
                    {a.action}
                    <StateTag tone={LEVEL_TONE[a.level]}>{LEVEL_TEXT[a.level]}</StateTag>
                    {a.own && <span className="h-1.5 w-1.5 rounded-full bg-brand" title={`Set for them personally — their role gives ${LEVEL_TEXT[a.role]}.`} />}
                  </span>
                ))}
              </div>
              <p className="text-[11.5px] text-subtle">
                {view?.own ? "Set for them personally" : (view?.why ?? "")} {view?.level === "OWN" || view?.level === "TEAM" ? `· Own: ${r.ownMeans}` : ""}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Sensitive access ─────────────────────────────────────────────────────────────────────────────

export type SensitiveRow = { key: string; label: string; group: string; critical: boolean; held: boolean; why: string; selfExcluded: boolean };

export function SensitiveTab({ first, rows, separated }: { first: string; rows: SensitiveRow[]; separated: { key: string; label: string }[] }) {
  const held = rows.filter((r) => r.held).length;
  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader
          title="Sensitive permissions"
          meta={
            <span className="text-xs text-subtle">
              {first} holds {held} of {rows.length} marked sensitive or critical
            </span>
          }
        />
        <div className="overflow-auto">
          <table className="w-full min-w-[760px] border-collapse">
            <thead>
              <tr>
                <th className={thClass}>Sensitive item</th>
                <th className={cn(thClass, "w-[90px]")}>Tier</th>
                <th className={cn(thClass, "w-[80px] text-center")}>Access</th>
                <th className={thClass}>Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className={rowHoverClass}>
                  <td className={tdClass}>
                    <div className="font-medium text-text">{r.label}</div>
                    <div className="text-[11px] text-subtle">
                      {r.group} · <span className="font-mono">{r.key}</span>
                    </div>
                  </td>
                  <td className={tdClass}>
                    <Pill tone={r.critical ? "red" : "amber"}>{r.critical ? "Critical" : "Sensitive"}</Pill>
                  </td>
                  <td className={cn(tdClass, "text-center")}>{yesNo(r.held)}</td>
                  <td className={cn(tdClass, "text-xs text-muted")}>
                    {r.why}
                    {r.held && r.selfExcluded && <span className="block text-[11px] text-subtle">Never on a record they raised themselves.</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Separation of duties" />
        <div className="flex flex-col gap-2 px-4 py-3">
          <p className="text-[12.5px] leading-[1.5] text-muted">These are held, and never on a record {first} raised themselves — enforced by the server for every request.</p>
          {separated.length === 0 ? (
            <p className="text-xs text-subtle">They hold none of them.</p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {separated.map((d) => (
                <Pill key={d.key} tone="blue">
                  {d.label}
                </Pill>
              ))}
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}

// ─── Unmasking today ──────────────────────────────────────────────────────────────────────────────

export type UnmaskGlance = {
  id: string;
  at: string;
  /** ALLOWED, REPEAT, QUOTA_EXHAUSTED or DENIED. */
  result: string;
  consumed: boolean;
  fields: string;
  record: string;
  meta: string;
  usedToday: number | null;
  dailyLimit: number | null;
};

export function UnmaskTodayPanel({ id, events, maySeeLog, total }: { id: string; events: UnmaskGlance[]; maySeeLog: boolean; total: number }) {
  return (
    <Panel>
      <PanelHeader
        title="Unmasking today"
        meta={maySeeLog && total > 0 ? <span className="text-xs text-subtle">{total}</span> : undefined}
        action={
          <Link href={acPath.audit({ category: "pii", user: id })} className={panelLinkClass}>
            Full history
          </Link>
        }
      />
      {!maySeeLog ? (
        <p className="px-4 py-5 text-xs leading-[1.5] text-subtle">Only the super admin can read the unmasking log. The count above is today&apos;s total.</p>
      ) : events.length === 0 ? (
        <p className="px-4 py-5 text-xs text-subtle">No reveals today.</p>
      ) : (
        <>
          {events.map((a) => {
            const refused = a.result === "DENIED" || a.result === "QUOTA_EXHAUSTED";
            const credit = a.result === "DENIED" ? "refused" : a.result === "QUOTA_EXHAUSTED" ? "limit reached" : a.consumed ? `counted${a.usedToday !== null ? ` · ${a.usedToday}${a.dailyLimit !== null ? ` of ${a.dailyLimit}` : ""}` : ""}` : "opened again · free";
            return (
              <div key={a.id} className="flex items-start gap-2.5 border-b border-line/70 px-4 py-[9px] last:border-0">
                {refused ? <Ban className="mt-px h-[17px] w-[17px] shrink-0 text-danger" aria-hidden /> : <Eye className="mt-px h-[17px] w-[17px] shrink-0 text-warning" aria-hidden />}
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] font-medium text-text">
                    {a.fields} · <span className="font-mono text-[11.5px] font-normal text-muted">{a.record}</span>
                  </div>
                  {a.meta && <div className="text-[11.5px] leading-[1.45] text-muted">{a.meta}</div>}
                </div>
                <div className="whitespace-nowrap text-right">
                  <div className={cn("text-[11.5px] font-semibold", refused ? "text-danger" : a.consumed ? "text-warning" : "text-muted")}>{credit}</div>
                  <div className="text-[11px] text-subtle">
                    <Ago at={a.at} />
                  </div>
                </div>
              </div>
            );
          })}
          {total > events.length && <p className="px-4 py-2 text-[11.5px] text-subtle">and {total - events.length} more today</p>}
        </>
      )}
    </Panel>
  );
}

// ─── Activity ─────────────────────────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<string, string> = {
  GRANT: "Granted",
  REVOKE: "Revoked",
  RESET_TO_DEFAULT: "Reset to default",
  PRESET_APPLIED: "Preset applied",
  ROLE_ASSIGNED: "Role changed",
  MANAGER_CHANGED: "Reporting line changed",
  DEPARTMENT_CHANGED: "Department changed",
  USER_CREATED: "User created",
  USER_ACTIVATED: "Account reactivated",
  USER_DEACTIVATED: "Account deactivated",
  TWO_FACTOR_RESET: "Two-factor reset",
  SUPER_ADMIN_GRANTED: "Made super admin",
  SUPER_ADMIN_REVOKED: "Super admin removed",
};

export type ActivityRow = { id: string; kind: string; text: string; actor: string | null; whileViewingAs: boolean; at: string };

function ActivityIcon({ kind }: { kind: string }) {
  const className = "mt-px h-[18px] w-[18px] shrink-0";
  if (kind === "GRANT" || kind === "USER_ACTIVATED") return <Check className={cn(className, "text-success")} aria-hidden />;
  if (kind === "REVOKE" || kind === "USER_DEACTIVATED" || kind === "SUPER_ADMIN_REVOKED") return <Ban className={cn(className, "text-danger")} aria-hidden />;
  if (kind === "RESET_TO_DEFAULT") return <RotateCcw className={cn(className, "text-muted")} aria-hidden />;
  if (kind === "ROLE_ASSIGNED" || kind === "MANAGER_CHANGED" || kind === "DEPARTMENT_CHANGED") return <UserCog className={cn(className, "text-warning")} aria-hidden />;
  if (kind === "PRESET_APPLIED") return <SlidersHorizontal className={cn(className, "text-warning")} aria-hidden />;
  return <History className={cn(className, "text-muted")} aria-hidden />;
}

export function ActivityTab({ id, name, rows, capped }: { id: string; name: string; rows: ActivityRow[]; capped: boolean }) {
  return (
    <div className="flex flex-col gap-3.5">
      <Panel>
        <PanelHeader
          title={`Changes to ${name}'s access`}
          action={
            <Link href={acPath.audit({ user: id })} className={panelLinkClass}>
              Open in Audit Logs
            </Link>
          }
        />
        {rows.length === 0 ? (
          <EmptyNote className="py-8">No activity recorded</EmptyNote>
        ) : (
          rows.map((a) => (
            <div key={a.id} className="flex items-start gap-3 border-b border-line/70 px-4 py-2.5 last:border-0">
              <ActivityIcon kind={a.kind} />
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] leading-[1.45] text-text">{a.text}</div>
                <div className="mt-0.5 text-[11.5px] text-subtle">
                  {KIND_LABEL[a.kind] ?? a.kind}
                  {a.actor ? ` · by ${a.actor}` : ""}
                  {/* Attributed to the real person, not the borrowed account. */}
                  {a.whileViewingAs ? " · while viewing as somebody" : ""}
                </div>
              </div>
              <span className="whitespace-nowrap text-xs text-muted">
                <Ago at={a.at} />
              </span>
            </div>
          ))
        )}
      </Panel>
      {capped && <p className="text-xs text-subtle">The latest {rows.length} changes. The rest are in Audit Logs.</p>}
      <p className="rounded-md bg-surface-sunken px-3 py-2 text-xs leading-[1.5] text-muted">
        This is the history of {name}&apos;s access. Their work — records added and changed, calls, notes, emails — is in{" "}
        <Link href={`/activity/work?person=${id}`} className="font-semibold text-brand hover:underline">
          work activity
        </Link>
        ; sign-ins, exports and refusals are in the{" "}
        <Link href={`/activity?userId=${id}`} className="font-semibold text-brand hover:underline">
          activity log
        </Link>
        .
      </p>
    </div>
  );
}
