"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Building2, Columns3, DatabaseBackup, Download, Landmark, Lock, Package, ScrollText, Upload, UserCog, UserRound } from "lucide-react";
import { resetRolePermission, setRolePermission, setRolePermissions } from "@/actions/permission";
import { acPath } from "@/lib/access-control/nav";
import { peopleCount } from "@/lib/people-count";
import { toast } from "@/components/ui/toast";
import { confirmAction } from "@/components/ui/confirm";
import { AcPage, EmptyNote, HintNote, InitialsAvatar, Panel, PanelHeader, Pill, StateTag, acButton, acInput, panelLinkClass, rowHoverClass, tdClass, thClass } from "@/components/access-control/ui";
import { cn } from "@/lib/utils";

/** What a role says about one permission: nothing of its own (its default), or a stored yes or no. */
export type IoAnswer = "default" | "allow" | "deny";

export type IoKey = {
  key: string;
  label: string;
  description: string;
  tier: "standard" | "sensitive" | "critical";
  superAdminOnly: boolean;
  /** What the role answers now. */
  allowed: boolean;
  /** Whether that answer is stored on the role, rather than its default. */
  explicit: boolean;
  /** What the role answers with nothing stored, and why, in words. */
  defaultAllowed: boolean;
  defaultWhy: string;
  /** Why the person looking may not change it — the role editor's own rules — or null. */
  lock: string | null;
};

export type IoIcon = "crm" | "finance" | "catalog" | "people" | "users" | "activity" | "backups";

export type IoRow = {
  id: string;
  label: string;
  icon: IoIcon;
  /** What the permissions cover, by name. */
  areas: string[];
  /** Covered areas that only ever leave, and why each can't be imported. */
  exportOnly: { label: string; why: string }[];
  /** Areas the import permission covers whose importer is not built yet. */
  importNotBuilt: string[];
  note: string | null;
  export: IoKey | null;
  import: IoKey | null;
  /** Why there is nothing to import here, where there isn't. */
  importWhy: string | null;
};

export type IoHolders = {
  key: string;
  label: string;
  holders: { id: string; name: string; roleName: string; why: string }[];
  /** People it was deliberately taken away from. */
  denied: number;
};

export type IoFieldMode = "clear" | "masked" | "none" | "restricted";

export type IoFieldEntity = {
  entity: string;
  title: string;
  /** False where the role's field access can't be read. */
  readable: boolean;
  fields: { key: string; label: string; mode: IoFieldMode; asList: boolean }[];
};

type RoleOption = { key: string; name: string; active: boolean; headcount: number; switchedOff: number };

const ICONS: Record<IoIcon, typeof Building2> = {
  crm: Building2,
  finance: Landmark,
  catalog: Package,
  people: UserRound,
  users: UserCog,
  activity: ScrollText,
  backups: DatabaseBackup,
};

const NEXT: Record<IoAnswer, IoAnswer> = { default: "allow", allow: "deny", deny: "default" };
const WORD: Record<IoAnswer, string> = { default: "Default", allow: "Allow", deny: "Deny" };

const FIELD_MODE: Record<IoFieldMode, { word: string; tone: "green" | "amber" | "neutral" | "red" }> = {
  clear: { word: "Clear", tone: "green" },
  masked: { word: "Masked", tone: "amber" },
  none: { word: "Left out", tone: "neutral" },
  restricted: { word: "Restricted", tone: "red" },
};

const storedOf = (k: IoKey): IoAnswer => (!k.explicit ? "default" : k.allowed ? "allow" : "deny");
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Import & Export Permissions: for one role, each data area and whether its people may bring it in
 * from a file and take it out as one.
 *
 * The answers are the role's own for the named permissions the importer and exporter check
 * (`data.import*`, `data.export*`, the activity log's export, a backup's download) — Default, Allow or
 * Deny, as the permission matrix stores them. Edits are staged and saved together through the actions
 * the matrix always used, so every guard and every history row is theirs. How a sensitive field goes
 * out is Field Permissions' to set; it is summarised here, read-only.
 */
export function ImportExportScreen({
  roles,
  role,
  rows,
  holders,
  fieldEntities,
  maskingOn,
  exportRowLimit,
  mayManage,
}: {
  roles: RoleOption[];
  role: RoleOption;
  rows: IoRow[];
  holders: IoHolders[];
  fieldEntities: IoFieldEntity[];
  maskingOn: boolean;
  /** The workspace's cap on one export's rows; 0 is no cap. */
  exportRowLimit: number;
  mayManage: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Record<string, IoAnswer>>({});
  const [saving, start] = useTransition();

  const keys = useMemo(() => rows.flatMap((r) => [r.import, r.export]).filter((k): k is IoKey => k !== null), [rows]);
  const answerOf = (k: IoKey): IoAnswer => draft[k.key] ?? storedOf(k);
  const isChanged = (k: IoKey) => draft[k.key] !== undefined && draft[k.key] !== storedOf(k);
  const pending = keys.filter(isChanged);
  const clean = pending.length === 0;

  // Where every cell is locked for the same reason, it is said once above the table.
  const locks = new Set(keys.map((k) => k.lock));
  const sharedLock = locks.size === 1 ? (keys[0]?.lock ?? null) : null;

  const cycle = (k: IoKey) => {
    if (k.lock) return;
    setDraft((d) => {
      const next = NEXT[d[k.key] ?? storedOf(k)];
      const out = { ...d };
      if (next === storedOf(k)) delete out[k.key];
      else out[k.key] = next;
      return out;
    });
  };

  const switchRole = async (next: string) => {
    if (next === role.key) return;
    if (!clean && !(await confirmAction({ title: "Discard unsaved changes?", message: `${plural(pending.length, "change", "changes")} to ${role.name} will be lost.`, confirmLabel: "Discard", danger: true }))) return;
    router.push(acPath.importExport(next));
  };

  /**
   * One Save, three kinds of write, each through the action that owns it: an answer that flips goes
   * with the others in `setRolePermissions` (all or nothing); "Default" removes the role's stored row
   * (`resetRolePermission`); and pinning the answer a role already gives by default stores it
   * (`setRolePermission`), which the bulk action deliberately skips.
   */
  const save = () => {
    if (clean || saving) return;
    start(async () => {
      const flips: { key: string; allowed: boolean }[] = [];
      const pins: IoKey[] = [];
      const resets: IoKey[] = [];
      for (const k of pending) {
        const a = draft[k.key]!;
        if (a === "default") resets.push(k);
        else if ((a === "allow") !== k.allowed) flips.push({ key: k.key, allowed: a === "allow" });
        else pins.push(k);
      }
      const errors: string[] = [];
      if (flips.length) {
        const r = await setRolePermissions(role.key, flips);
        if (!r.ok) errors.push(r.error);
      }
      for (const k of resets) {
        const r = await resetRolePermission(role.key, k.key);
        if (!r.ok) errors.push(`${k.label}: ${r.error}`);
      }
      for (const k of pins) {
        const r = await setRolePermission(role.key, k.key, draft[k.key] === "allow");
        if (!r.ok) errors.push(`${k.label}: ${r.error}`);
      }
      if (errors.length) {
        toast.error(errors.length > 1 ? `${errors[0]} (and ${errors.length - 1} more)` : errors[0]!);
        // What did save stops counting as unsaved once the page has re-read the role.
        router.refresh();
        return;
      }
      toast.success("Import & export permissions saved");
      // Together, so the cells go from the staged answers straight to the saved ones.
      start(() => {
        router.refresh();
        setDraft({});
      });
    });
  };

  return (
    <AcPage
      crumb="Import & Export"
      title="Import & Export Permissions"
      description="Who may bring each kind of data in from a file, and who may take it out as one. Export never widens what somebody sees — it decides whether what they can see may leave. Field Permissions still decide how each sensitive column goes out."
      actions={
        <>
          <label htmlFor="io-role" className="text-xs text-muted">
            Role
          </label>
          <select id="io-role" value={role.key} disabled={saving} onChange={(e) => void switchRole(e.target.value)} className={cn(acInput, "min-w-[190px] px-2 font-semibold")}>
            {roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.name}
              </option>
            ))}
          </select>
          {mayManage && (
            <>
              <button type="button" className={acButton.secondary} disabled={clean || saving} onClick={() => setDraft({})}>
                Reset
              </button>
              <button type="button" className={acButton.primary} disabled={clean || saving} onClick={save}>
                {saving ? "Saving…" : "Save changes"}
              </button>
            </>
          )}
        </>
      }
    >
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          {!role.active && <HintNote>{role.name} is switched off, so it grants nothing until it is switched back on. Its answers below are kept and apply again then.</HintNote>}

          <Panel>
            <PanelHeader
              title="Data areas"
              meta={
                <>
                  <Pill tone="brand">{role.name}</Pill>
                  <span className="text-xs text-subtle">{peopleCount(role.headcount - role.switchedOff, role.switchedOff, "person", "people")}</span>
                </>
              }
              action={
                <Link href={acPath.modules({ role: role.key })} className={panelLinkClass}>
                  Module Matrix
                </Link>
              }
            />
            {sharedLock && (
              <p className="flex items-center gap-1.5 border-b border-line/70 px-4 py-2 text-xs text-muted">
                <Lock className="h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden />
                {sharedLock}
              </p>
            )}
            <div className="overflow-auto">
              <table className="w-full min-w-[820px] border-collapse">
                <thead>
                  <tr>
                    <th className={thClass}>Data area</th>
                    <th className={cn(thClass, "w-[29%]")}>
                      <span className="inline-flex items-center gap-1.5">
                        <Upload className="h-3.5 w-3.5" aria-hidden />
                        Import
                      </span>
                    </th>
                    <th className={cn(thClass, "w-[29%]")}>
                      <span className="inline-flex items-center gap-1.5">
                        <Download className="h-3.5 w-3.5" aria-hidden />
                        Export
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const Icon = ICONS[row.icon];
                    const dirty = [row.import, row.export].some((k) => k !== null && isChanged(k));
                    return (
                      <tr key={row.id} className={rowHoverClass}>
                        <td className={cn(tdClass, "align-top")}>
                          <div className="flex items-start gap-2.5">
                            <Icon className="mt-0.5 h-[18px] w-[18px] shrink-0 text-muted" aria-hidden />
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 font-semibold text-text">
                                {row.label}
                                {dirty && <span className="h-2 w-2 rounded-full bg-brand" title="Unsaved changes" />}
                              </div>
                              <p className="mt-0.5 text-xs leading-[1.45] text-muted">{row.areas.join(", ")}</p>
                              {row.exportOnly.length > 0 && (
                                <p className="mt-0.5 text-xs leading-[1.45] text-subtle">
                                  Export only:{" "}
                                  {row.exportOnly.map((a, i) => (
                                    <span key={a.label} title={a.why} className="cursor-help underline decoration-dotted underline-offset-2">
                                      {a.label}
                                      {i < row.exportOnly.length - 1 ? ", " : ""}
                                    </span>
                                  ))}
                                </p>
                              )}
                              {row.importNotBuilt.length > 0 && <p className="mt-0.5 text-xs leading-[1.45] text-subtle">Import not built yet: {row.importNotBuilt.join(", ")}</p>}
                              {row.note && <p className="mt-0.5 text-xs leading-[1.45] text-subtle">{row.note}</p>}
                            </div>
                          </div>
                        </td>
                        <td className={cn(tdClass, "align-top")}>
                          <TriCell k={row.import} roleName={role.name} answer={row.import ? answerOf(row.import) : "default"} changed={row.import ? isChanged(row.import) : false} saving={saving} emptyWhy={row.importWhy} onCycle={cycle} />
                        </td>
                        <td className={cn(tdClass, "align-top")}>
                          <TriCell k={row.export} roleName={role.name} answer={row.export ? answerOf(row.export) : "default"} changed={row.export ? isChanged(row.export) : false} saving={saving} emptyWhy={null} onCycle={cycle} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 bg-surface-sunken/60 px-4 py-2.5 text-xs text-muted">
              <span>Files are CSV or XLSX.</span>
              <span>An import is previewed before anything is written, and takes a file of up to 25 MB.</span>
              <span>
                {exportRowLimit > 0 ? `One export is capped at ${exportRowLimit.toLocaleString("en-IN")} rows for everybody` : "There is no cap on one export's rows"} —{" "}
                <Link href={acPath.security()} className="font-semibold text-brand hover:underline">
                  Security Settings
                </Link>
                .
              </span>
              <span>Every export, import and refusal is in the activity log.</span>
            </div>
          </Panel>

          <Panel>
            <PanelHeader
              title={`Field-level export · ${role.name}`}
              action={
                <Link href={acPath.fields({ role: role.key })} className={panelLinkClass}>
                  Field Permissions
                </Link>
              }
            />
            {!maskingOn && (
              <div className="border-b border-line/70 p-3">
                <HintNote>Field masking is switched off for the workspace, so masked fields show in the clear until it is switched back on. The rules below are kept.</HintNote>
              </div>
            )}
            <div className="grid grid-cols-1 gap-px bg-line/70 md:grid-cols-3">
              {fieldEntities.map((e) => {
                const narrowed = e.fields.filter((f) => f.mode !== "clear").length;
                return (
                  <div key={e.entity} className="flex min-w-0 flex-col bg-surface px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="flex-1 font-semibold text-text">{e.title}</span>
                      <Link href={acPath.fields({ role: role.key, entity: e.entity })} className={panelLinkClass}>
                        Choose fields
                      </Link>
                    </div>
                    {!e.readable ? (
                      <p className="mt-1 text-xs text-subtle">This role&apos;s field access can&apos;t be read.</p>
                    ) : e.fields.length === 0 ? (
                      <p className="mt-1 text-xs text-subtle">No sensitive fields.</p>
                    ) : (
                      <>
                        <p className="mt-0.5 text-xs text-muted">
                          {narrowed === 0 ? `All ${e.fields.length} sensitive fields go out in the clear` : `${narrowed} of ${plural(e.fields.length, "sensitive field", "sensitive fields")} masked, left out or restricted`}
                        </p>
                        <ul className="mt-2 flex flex-col">
                          {e.fields.map((f) => (
                            <li key={f.key} className="flex items-center gap-2 border-t border-line/70 py-1.5 text-xs">
                              <span className="min-w-0 flex-1 truncate text-text/80" title={f.label}>
                                {f.label}
                              </span>
                              <StateTag tone={FIELD_MODE[f.mode].tone} title={f.asList ? "As the list shows it — no export rule of its own" : "Its own export rule"}>
                                {FIELD_MODE[f.mode].word}
                              </StateTag>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="flex items-start gap-2 bg-surface-sunken/60 px-4 py-2.5 text-xs text-muted">
              <Columns3 className="mt-px h-4 w-4 shrink-0" aria-hidden />
              <span>How a sensitive field leaves in a file — an export, an account&apos;s workbook, the leads CSV and the API&apos;s lists — is set per field under Field Permissions. A file never says more than the screens do.</span>
            </div>
          </Panel>
        </div>

        <Panel>
          <PanelHeader
            title="Who can export"
            action={
              <Link href={acPath.employees()} className={panelLinkClass}>
                Employees
              </Link>
            }
          />
          {holders.length === 0 ? (
            <EmptyNote>Nothing to show.</EmptyNote>
          ) : (
            <div className="flex flex-col">
              {holders.map((h) => (
                <div key={h.key} className="border-b border-line/70 px-4 py-3">
                  <div className="flex items-baseline gap-2">
                    <span className="flex-1 text-xs font-semibold text-text/80">{h.label}</span>
                    <span className="whitespace-nowrap text-xs text-muted">{h.holders.length === 0 ? "Nobody" : plural(h.holders.length, "person", "people")}</span>
                  </div>
                  {h.holders.length > 0 && (
                    <ul className="mt-2 flex flex-col gap-1.5">
                      {h.holders.slice(0, 5).map((p) => (
                        <li key={p.id}>
                          <Link href={acPath.employee(p.id)} title={p.why} className="flex items-center gap-2 text-xs text-text/80 hover:text-brand">
                            <InitialsAvatar name={p.name} seed={p.id} size={20} />
                            <span className="min-w-0 flex-1 truncate">{p.name}</span>
                            <span className="shrink-0 text-subtle">{p.roleName}</span>
                          </Link>
                        </li>
                      ))}
                      {h.holders.length > 5 && (
                        <li className="text-xs text-subtle" title={h.holders.slice(5).map((p) => p.name).join(", ")}>
                          and {h.holders.length - 5} more
                        </li>
                      )}
                    </ul>
                  )}
                  {h.denied > 0 && <p className="mt-1.5 text-xs text-subtle">Deliberately switched off for {plural(h.denied, "person", "people")}.</p>}
                </div>
              ))}
              <p className="px-4 py-2.5 text-xs leading-[1.5] text-subtle">Active accounts across every role, with each person&apos;s own exceptions counted. A super admin holds all of them.</p>
            </div>
          )}
        </Panel>
      </div>

      {!clean && (
        <div className="sticky bottom-3 z-10 mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-line-strong bg-surface px-4 py-2.5 shadow-lg">
          <span className="h-2 w-2 shrink-0 rounded-full bg-brand" aria-hidden />
          <span className="min-w-0 flex-1 text-[13px] text-text">
            {plural(pending.length, "unsaved change", "unsaved changes")} to {role.name}
          </span>
          <button type="button" className={acButton.secondary} disabled={saving} onClick={() => setDraft({})}>
            Discard
          </button>
          <button type="button" className={acButton.primary} disabled={saving} onClick={save}>
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      )}
    </AcPage>
  );
}

/**
 * One permission's answer for the role, as the design draws a tri-state: a switch whose knob is the
 * effective answer and whose border says where it comes from — dashed while the role follows its
 * default, solid once the answer is stored on it. A click moves Default → Allow → Deny → Default.
 */
function TriCell({
  k,
  roleName,
  answer,
  changed,
  saving,
  emptyWhy,
  onCycle,
}: {
  k: IoKey | null;
  roleName: string;
  answer: IoAnswer;
  changed: boolean;
  saving: boolean;
  emptyWhy: string | null;
  onCycle: (k: IoKey) => void;
}) {
  if (!k) {
    return (
      <div className="text-xs leading-[1.45] text-subtle">
        <span className="font-mono text-[11px]">—</span>
        {emptyWhy && <span className="mt-0.5 block">{emptyWhy}</span>}
      </div>
    );
  }
  const on = answer === "default" ? k.defaultAllowed : answer === "allow";
  const explicit = answer !== "default";
  const stored = storedOf(k);
  const source = changed
    ? `Unsaved · was ${stored === "default" ? `default (${k.allowed ? "allow" : "deny"})` : stored}`
    : explicit
      ? `Set on this role${on === k.defaultAllowed ? " · same as its default" : ""}`
      : `Default · ${k.defaultWhy}`;
  return (
    <div className="flex items-start gap-2.5">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`${k.label} for ${roleName}: ${WORD[answer]}${explicit ? "" : ` (${on ? "allow" : "deny"})`}. Activate for ${WORD[NEXT[answer]]}.`}
        title={k.lock ?? `${WORD[answer]}${explicit ? "" : ` → ${on ? "Allow" : "Deny"}`} · click for ${WORD[NEXT[answer]]}`}
        disabled={saving || k.lock !== null}
        onClick={() => onCycle(k)}
        className={cn(
          "relative mt-0.5 h-[22px] w-10 shrink-0 rounded-full border-[1.5px] p-0 transition-colors disabled:cursor-not-allowed disabled:opacity-60",
          explicit ? "border-solid" : "border-dashed",
          on ? (explicit ? "border-success bg-success" : "border-success/60 bg-success/50") : explicit ? "border-danger bg-danger/50" : "border-line-strong bg-line",
          changed && "ring-2 ring-brand/40",
        )}
      >
        <span aria-hidden className={cn("absolute top-[1.5px] h-4 w-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-[left] duration-150", on ? "left-5" : "left-[1.5px]")} />
      </button>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <StateTag tone={on ? "green" : explicit ? "red" : "neutral"}>{on ? "Allow" : "Deny"}</StateTag>
          {k.tier === "critical" ? <Pill tone="red">Critical</Pill> : k.tier === "sensitive" ? <Pill tone="amber">Sensitive</Pill> : null}
          {k.lock && (
            <span title={k.lock} className="inline-flex text-subtle">
              <Lock className="h-3.5 w-3.5" aria-label="Locked" />
            </span>
          )}
        </div>
        <div className="mt-1 text-xs font-medium text-text/80" title={k.description}>
          {k.label}
        </div>
        <div className={cn("text-xs leading-[1.45]", changed ? "font-medium text-brand" : "text-subtle")}>{source}</div>
      </div>
    </div>
  );
}
