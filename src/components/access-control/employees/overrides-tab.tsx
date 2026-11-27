"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarClock, History, Infinity as InfinityIcon, Lock, Plus, Timer, Trash2 } from "lucide-react";
import { clearUserPermission, extendUserPermission, setUserPermission } from "@/actions/access";
import { setPersonAccessLevels } from "@/actions/person-access";
import { setPersonFieldAccess, setPersonUnmaskLimit } from "@/actions/field-access";
import type { FieldEntity } from "@/lib/authz/field-policy";
import { confirmAction } from "@/components/ui/confirm";
import { Dialog } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { EmptyNote, HintNote, Panel, PanelHeader, Pill, acButton, acInput, panelLinkClass, rowHoverClass, tdClass, thClass } from "@/components/access-control/ui";
import { Field, addDays } from "@/components/access-control/employees/shared";
import { cn } from "@/lib/utils";

/** One stored permission exception (`UserPermission`), as the table shows it. */
export type OverrideRow = {
  key: string;
  label: string;
  moduleLabel: string;
  allowed: boolean;
  /** What their role gives without this row. */
  roleGives: boolean;
  reason: string | null;
  grantedBy: string | null;
  grantedOnText: string;
  /** The last day it applies (`yyyy-mm-dd`, the workspace's), or null for no end date. */
  endsOn: string | null;
  endsOnText: string | null;
  /** Whole days from today to that day; negative once it has passed. */
  daysLeft: number | null;
  /** Past its end date: stored, but no longer applied. */
  expired: boolean;
};

/** An exception of another kind, set on its own screen: a record level, a field policy, their daily limit. */
export type OtherException =
  | { kind: "level"; id: string; label: string; value: string; detail: string | null; href: string; record: string; action: string }
  | { kind: "field"; id: string; label: string; value: string; detail: string | null; href: string; entity: FieldEntity; field: string; lapsed: boolean }
  | { kind: "limit"; id: string; label: string; value: string; detail: string | null; href: string };

/** What "Add override" offers, by module — and why the viewer can't set one, where they can't. */
export type OverrideChoice = { key: string; label: string; roleGives: boolean; own: "allow" | "deny" | null; blocked: string | null };
export type OverrideCatalogue = { module: string; label: string; options: OverrideChoice[] }[];

const KIND_LABEL = { level: "Record access", field: "Field access", limit: "Daily limit" } as const;
const answer = (allowed: boolean) => (allowed ? "ALLOW" : "DENY");

/**
 * One person's Overrides: every exception stored for them alone, on top of their role.
 *
 * Permission exceptions are added, extended and removed here, each through the action that always did it
 * (`setUserPermission`, `extendUserPermission`, `clearUserPermission`) and so with its rules: "Change
 * roles and permissions" to change anything; nobody writes an exception for themselves; nobody grants,
 * denies or removes a key they don't hold; a super admin has none. Each change is saved at once and
 * written to the permission history with who made it. Record levels, field policies and a daily limit
 * are set on their own screens; they are listed so nothing made for this person is out of sight.
 */
export function OverridesTab({
  userId,
  name,
  roleName,
  rows,
  others,
  catalogue,
  today,
  canEdit,
  lockedWhy,
}: {
  userId: string;
  name: string;
  roleName: string;
  rows: OverrideRow[];
  others: OtherException[];
  catalogue: OverrideCatalogue;
  /** Today in the workspace, `yyyy-mm-dd`. */
  today: string;
  canEdit: boolean;
  lockedWhy: string | null;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [dating, setDating] = useState<OverrideRow | null>(null);
  const [busy, start] = useTransition();
  const first = name.split(" ")[0] ?? name;

  const run = (work: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string) =>
    start(async () => {
      const r = await work();
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(done);
      router.refresh();
    });

  const extend = (o: OverrideRow) => {
    // A week on from its last day — or from today, for one that has already lapsed.
    const from = o.endsOn && !o.expired ? o.endsOn : today;
    run(() => extendUserPermission({ userId, permission: o.key, expiresAt: addDays(from, 7) }), "Extended by 7 days.");
  };

  const remove = async (o: OverrideRow) => {
    const yes = await confirmAction({
      title: "Remove this override?",
      message: `${o.label} falls back to what the ${roleName} role gives (${answer(o.roleGives)}).`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (yes) run(() => clearUserPermission(userId, o.key), "Override removed.");
  };

  const removeOther = async (o: OtherException) => {
    const yes = await confirmAction({
      title: "Remove this exception?",
      message: `${o.label} goes back to what the ${roleName} role gives.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!yes) return;
    run(async () => {
      if (o.kind === "level") return setPersonAccessLevels(userId, [{ record: o.record, action: o.action, level: null }]);
      if (o.kind === "field") return setPersonFieldAccess(userId, [{ field: o.field, policy: null }], {}, o.entity);
      return setPersonUnmaskLimit(userId, null);
    }, "Exception removed.");
  };

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-[240px] flex-1 text-[12.5px] leading-[1.5] text-muted">
          Overrides are exceptions layered on top of the role. Each one records who granted it, why, and when it expires. An explicit DENY outranks the role; removing an override puts {first} back on
          what the role gives.
        </p>
        {canEdit && (
          <button type="button" className={acButton.primary} onClick={() => setAdding(true)} disabled={busy}>
            <Plus className="h-[18px] w-[18px]" aria-hidden />
            Add override
          </button>
        )}
      </div>
      {lockedWhy && (
        <p className="flex items-center gap-1.5 text-xs text-subtle">
          <Lock className="h-3.5 w-3.5" aria-hidden />
          {lockedWhy}
        </p>
      )}

      <Panel className="overflow-auto">
        <table className="w-full min-w-[860px] border-collapse">
          <thead>
            <tr>
              <th className={thClass}>Permission</th>
              <th className={thClass}>Override</th>
              <th className={thClass}>Role would give</th>
              <th className={thClass}>Reason</th>
              <th className={thClass}>Granted</th>
              <th className={thClass}>Expires</th>
              <th className={cn(thClass, "w-[150px]")}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => {
              const soon = !o.expired && o.daysLeft !== null && o.daysLeft <= 3;
              return (
                <tr key={o.key} className={cn(rowHoverClass, o.expired && "opacity-55")}>
                  <td className={tdClass}>
                    <div className="font-medium text-text">{o.label}</div>
                    <div className="font-mono text-[11px] text-subtle">
                      {o.key} · {o.moduleLabel}
                    </div>
                  </td>
                  <td className={tdClass}>
                    <Pill tone={o.allowed ? "green" : "red"} className="font-bold tracking-[0.04em]">
                      {answer(o.allowed)}
                    </Pill>
                  </td>
                  <td className={cn(tdClass, "text-xs text-muted")}>
                    {answer(o.roleGives)}
                    {o.roleGives === o.allowed && " (redundant)"}
                  </td>
                  <td className={cn(tdClass, "max-w-[280px] text-text/80")}>{o.reason ?? <span className="text-subtle">—</span>}</td>
                  <td className={cn(tdClass, "whitespace-nowrap text-xs text-muted")}>
                    {o.grantedBy ?? "—"}
                    <div className="text-[11px] text-subtle">{o.grantedOnText}</div>
                  </td>
                  <td className={cn(tdClass, "whitespace-nowrap")}>
                    <span className={cn("inline-flex items-center gap-1 text-xs font-medium", o.expired ? "text-subtle" : soon ? "text-warning" : o.endsOn ? "text-text/80" : "text-muted")}>
                      {o.expired ? <History className="h-[15px] w-[15px]" aria-hidden /> : o.endsOn ? <Timer className="h-[15px] w-[15px]" aria-hidden /> : <InfinityIcon className="h-[15px] w-[15px]" aria-hidden />}
                      {o.expired ? `Lapsed ${o.endsOnText}` : o.endsOn ? `Until ${o.endsOnText}` : "Never"}
                    </span>
                    {!o.expired && o.daysLeft !== null && <div className="text-[11px] text-subtle">{o.daysLeft === 0 ? "ends today" : o.daysLeft === 1 ? "1 day left" : `${o.daysLeft} days left`}</div>}
                    {o.expired && <div className="text-[11px] text-subtle">no longer applied</div>}
                  </td>
                  <td className={cn(tdClass, "whitespace-nowrap text-right")}>
                    {canEdit && (
                      <span className="inline-flex items-center gap-1">
                        {o.endsOn && (
                          <button type="button" onClick={() => extend(o)} disabled={busy} className="inline-flex h-[26px] items-center rounded-md border border-line-strong bg-surface px-2 text-xs font-semibold text-text hover:bg-surface-sunken disabled:opacity-45">
                            +7 days
                          </button>
                        )}
                        <button
                          type="button"
                          title="Change the end date"
                          aria-label={`Change the end date of ${o.label}`}
                          onClick={() => setDating(o)}
                          disabled={busy}
                          className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-md text-text/80 hover:bg-surface-sunken disabled:opacity-45"
                        >
                          <CalendarClock className="h-4 w-4" aria-hidden />
                        </button>
                        <button
                          type="button"
                          title="Remove override"
                          aria-label={`Remove the override on ${o.label}`}
                          onClick={() => remove(o)}
                          disabled={busy}
                          className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-md text-danger hover:bg-danger-bg disabled:opacity-45"
                        >
                          <Trash2 className="h-4 w-4" aria-hidden />
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-subtle">
                  No permission overrides for {name}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>

      <Panel>
        <PanelHeader title="Other exceptions for this person" meta={<span className="text-xs text-subtle">record access, field access and the daily unmasking limit — each is set on its own screen</span>} />
        {others.length === 0 ? (
          <EmptyNote>None. {first}&apos;s record access, field access and daily limit are the role&apos;s.</EmptyNote>
        ) : (
          <div className="flex flex-col">
            {others.map((o) => (
              <div key={o.id} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line/70 px-4 py-2.5 last:border-0", o.kind === "field" && o.lapsed && "opacity-55")}>
                <Pill tone="brand">{KIND_LABEL[o.kind]}</Pill>
                <div className="min-w-[200px] flex-1">
                  <div className="text-[12.5px] font-medium text-text">
                    {o.label}: <span className="font-normal text-text/80">{o.value}</span>
                  </div>
                  {o.detail && <div className="text-[11.5px] text-muted">{o.detail}</div>}
                </div>
                <Link href={o.href} className={panelLinkClass}>
                  {canEdit ? "Edit" : "Open"}
                </Link>
                {canEdit && !(o.kind === "field" && o.lapsed) && (
                  <button
                    type="button"
                    title="Remove this exception"
                    aria-label={`Remove the exception on ${o.label}`}
                    onClick={() => removeOther(o)}
                    disabled={busy}
                    className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-md text-danger hover:bg-danger-bg disabled:opacity-45"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>

      {adding && <AddOverrideDialog userId={userId} name={name} roleName={roleName} catalogue={catalogue} today={today} onClose={() => setAdding(false)} />}
      {dating && <EndDateDialog userId={userId} row={dating} today={today} onClose={() => setDating(null)} />}
    </div>
  );
}

const EXPIRY_CHOICES = [
  { value: "0", label: "Never" },
  { value: "1", label: "In 1 day" },
  { value: "7", label: "In 7 days" },
  { value: "30", label: "In 30 days" },
  { value: "date", label: "On a date…" },
] as const;

/** "Add override": one permission, ALLOW or DENY, why, and until when — saved at once by `setUserPermission`. */
function AddOverrideDialog({ userId, name, roleName, catalogue, today, onClose }: { userId: string; name: string; roleName: string; catalogue: OverrideCatalogue; today: string; onClose: () => void }) {
  const router = useRouter();
  const modules = catalogue.filter((m) => m.options.length > 0);
  const [moduleKey, setModuleKey] = useState(modules[0]?.module ?? "");
  const options = modules.find((m) => m.module === moduleKey)?.options ?? [];
  const firstOpen = (list: OverrideChoice[]) => (list.find((o) => !o.blocked) ?? list[0])?.key ?? "";
  const [key, setKey] = useState(() => firstOpen(options));
  const [value, setValue] = useState<"allow" | "deny">("allow");
  const [reason, setReason] = useState("");
  const [expiry, setExpiry] = useState<(typeof EXPIRY_CHOICES)[number]["value"]>("0");
  const [date, setDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const choice = options.find((o) => o.key === key) ?? null;
  const redundant = choice ? choice.roleGives === (value === "allow") : false;
  const expiresAt = expiry === "0" ? null : expiry === "date" ? date || null : addDays(today, Number(expiry));

  const save = () => {
    if (!choice) return;
    if (!reason.trim()) {
      setError("Reason is required.");
      return;
    }
    if (expiry === "date" && !date) {
      setError("Choose the last day it applies.");
      return;
    }
    setError(null);
    start(async () => {
      const r = await setUserPermission({ userId, permission: choice.key, allowed: value === "allow", reason: reason.trim(), expiresAt });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(choice.own ? "Override updated." : "Override added.");
      router.refresh();
      onClose();
    });
  };

  return (
    <Dialog open onClose={() => !pending && onClose()} title={`Add override for ${name}`}>
      <div className="flex flex-col gap-3.5 text-[13px]">
        <p className="leading-[1.5] text-muted">One permission, for this person alone. For which records they reach, or which fields are masked for them, use Data Scope and Field Permissions.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Module" htmlFor="ov-module">
            <select
              id="ov-module"
              value={moduleKey}
              onChange={(e) => {
                setModuleKey(e.target.value);
                setKey(firstOpen(modules.find((m) => m.module === e.target.value)?.options ?? []));
              }}
              className={cn(acInput, "w-full")}
            >
              {modules.map((m) => (
                <option key={m.module} value={m.module}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Permission" htmlFor="ov-key">
            <select id="ov-key" value={key} onChange={(e) => setKey(e.target.value)} className={cn(acInput, "w-full")}>
              {options.map((o) => (
                <option key={o.key} value={o.key} disabled={o.blocked !== null}>
                  {o.label}
                  {o.blocked ? " — not yours to set" : ""}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {choice && (
          <p className="text-[11.5px] leading-[1.45] text-subtle">
            {choice.blocked ?? (
              <>
                The {roleName} role gives this: {answer(choice.roleGives)}.{choice.own ? ` ${name} already has an override here (${choice.own.toUpperCase()}); saving replaces it, with its reason and end date.` : ""}
              </>
            )}
          </p>
        )}
        <Field label="Override" htmlFor="ov-value">
          <select id="ov-value" value={value} onChange={(e) => setValue(e.target.value as "allow" | "deny")} className={cn(acInput, "w-full")}>
            <option value="allow">ALLOW</option>
            <option value="deny">DENY (explicit)</option>
          </select>
        </Field>
        {redundant && <HintNote>The role already answers {answer(value === "allow")} here. The override changes nothing today, but it holds if the role changes later.</HintNote>}
        <Field label="Reason" htmlFor="ov-reason">
          <textarea id="ov-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Recorded in the permission history" className={cn(acInput, "h-auto w-full resize-y py-1.5")} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Expires" htmlFor="ov-expiry" hint="It applies through the end of that day in the workspace's time zone, then the role's answer applies again.">
            <select id="ov-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value as typeof expiry)} className={cn(acInput, "w-full")}>
              {EXPIRY_CHOICES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          {expiry === "date" && (
            <Field label="Last day" htmlFor="ov-date">
              <input id="ov-date" type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} className={cn(acInput, "w-full")} />
            </Field>
          )}
        </div>
        {error && <p className="text-xs font-medium text-danger">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <button type="button" className={acButton.secondary} onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button type="button" className={acButton.primary} onClick={save} disabled={pending || !choice || choice.blocked !== null}>
            {pending ? "Saving…" : "Add override"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** A new end date for an exception, or none — `extendUserPermission`, which keeps its answer and its reason. */
function EndDateDialog({ userId, row, today, onClose }: { userId: string; row: OverrideRow; today: string; onClose: () => void }) {
  const router = useRouter();
  const [permanent, setPermanent] = useState(row.endsOn === null);
  const [date, setDate] = useState(row.endsOn && !row.expired ? row.endsOn : addDays(today, 7));
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      const r = await extendUserPermission({ userId, permission: row.key, expiresAt: permanent ? null : date });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(permanent ? "Made permanent." : "End date changed.");
      router.refresh();
      onClose();
    });

  return (
    <Dialog open onClose={() => !pending && onClose()} title={`End date · ${row.label}`}>
      <div className="flex flex-col gap-3.5 text-[13px]">
        <p className="leading-[1.5] text-muted">
          The override stays {answer(row.allowed)} with the reason it was given. {row.expired ? "It has lapsed; a new end date puts it back in force." : "Only when it stops applying changes."}
        </p>
        <label className="flex items-center gap-2 text-text">
          <input type="radio" name="end-kind" checked={!permanent} onChange={() => setPermanent(false)} className="h-4 w-4 accent-[var(--color-brand)]" />
          Until a day
        </label>
        {!permanent && (
          <Field label="Last day" htmlFor="end-date">
            <input id="end-date" type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} className={cn(acInput, "w-48")} />
          </Field>
        )}
        <label className="flex items-center gap-2 text-text">
          <input type="radio" name="end-kind" checked={permanent} onChange={() => setPermanent(true)} className="h-4 w-4 accent-[var(--color-brand)]" />
          No end date (permanent)
        </label>
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <button type="button" className={acButton.secondary} onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button type="button" className={acButton.primary} onClick={save} disabled={pending || (!permanent && !date)}>
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
