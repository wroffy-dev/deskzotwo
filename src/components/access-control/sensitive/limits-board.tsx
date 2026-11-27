"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { History, Info, Pencil, Search, Undo2 } from "lucide-react";
import type { UnmaskLimitRow, UnmaskLimitsBoard, UnmaskStatus } from "@/actions/access-control-sensitive";
import { setPersonUnmaskLimit } from "@/actions/field-access";
import { acPath } from "@/lib/access-control/nav";
import { Ago } from "@/components/ui/ago";
import { Dialog } from "@/components/ui/dialog";
import { confirmAction } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { InitialsAvatar, Panel, Pill, acButton, acInput, rowHoverClass, tdClass, thClass, type PillTone } from "@/components/access-control/ui";
import { LIMIT_PRESETS } from "@/components/access-control/sensitive/default-limit";
import { cn } from "@/lib/utils";

/**
 * Unmasking Limits: everybody's daily limit beside what they have used of it today — the tiles that
 * count them, the filters, and the table, where a person's own limit is set or taken away.
 *
 * The limit counts records, once each a day, for leads, contacts and companies together; it comes from
 * the person's own limit, else their role's, else the workspace default (src/lib/authz/unmask.ts). What
 * can be changed here is the first of those; the other two are changed beside this table. Nothing here
 * hands back used units or resets a day early — the app has no such thing, so the screen doesn't either.
 */

type Filter = "all" | "access" | "own" | UnmaskStatus;

const STATUS: Record<UnmaskStatus, { label: string; tone: PillTone; title: string }> = {
  active: { label: "Active", tone: "green", title: "May unmask, with records left today." },
  near: { label: "Near limit", tone: "amber", title: "80% or more of today's limit used." },
  at: { label: "At limit", tone: "red", title: "Today's limit is used up: a record not yet unmasked today stays masked." },
  unlimited: { label: "No limit", tone: "brand", title: "May unmask as many records a day as their field access allows." },
  none: { label: "No unmask access", tone: "neutral", title: "No field is theirs to unmask, so there is nothing to count." },
  exempt: { label: "Sees every field", tone: "neutral", title: "Super admin — sees every field in the clear and has no limit." },
};

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "Any usage status" },
  { value: "access", label: "Has unmask access" },
  { value: "active", label: "Active" },
  { value: "near", label: "Near limit (≥80%)" },
  { value: "at", label: "At limit" },
  { value: "unlimited", label: "No limit" },
  { value: "own", label: "Own limit set" },
  { value: "none", label: "No unmask access" },
];

function isFilter(value: string | undefined): value is Filter {
  return FILTERS.some((f) => f.value === value);
}

const first = (name: string) => name.trim().split(/\s+/)[0] || name;
const limitWords = (limit: number | null) => (limit === null ? "no limit" : `${limit} a day`);

function pctOf(row: UnmaskLimitRow): number {
  return row.limit ? Math.min(100, Math.round((row.used / row.limit) * 100)) : 0;
}

/** What a person goes back to without a limit of their own, in words. */
function inheritedWords(row: UnmaskLimitRow): string {
  if (row.inheritedFrom === "role") return `their role's limit (${limitWords(row.inherited)})`;
  if (row.inheritedFrom === "default") return `the workspace default (${limitWords(row.inherited)})`;
  return "having nothing to count — no field is theirs to unmask";
}

function sourceWords(row: UnmaskLimitRow): string {
  switch (row.source) {
    case "superAdmin":
      return "Super admin";
    case "own":
      return row.own?.lastDayText ? `Own · until ${row.own.lastDayText}` : "Own";
    case "role":
      return "Role";
    case "default":
      return "Default";
    case "none":
      return "Nothing to unmask";
  }
}

const iconButton = "inline-flex h-7 w-7 items-center justify-center rounded-md text-text/80 transition-colors hover:bg-surface-sunken disabled:pointer-events-none disabled:opacity-35";

export function LimitsBoard({ data, initialStatus }: { data: UnmaskLimitsBoard; initialStatus?: string }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [dept, setDept] = useState("all");
  const [role, setRole] = useState("all");
  const [status, setStatus] = useState<Filter>(isFilter(initialStatus) ? initialStatus : "all");
  const [editing, setEditing] = useState<UnmaskLimitRow | null>(null);
  const [, start] = useTransition();
  const { summary } = data;

  const depts = useMemo(() => [...new Set(data.rows.map((r) => r.department).filter((d): d is string => Boolean(d)))].sort((a, b) => a.localeCompare(b)), [data.rows]);
  const roles = useMemo(() => {
    const held = new Map(data.rows.map((r) => [r.role, r.roleName]));
    return [...held.entries()].map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [data.rows]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.rows
      .filter(
        (r) =>
          (!needle || r.name.toLowerCase().includes(needle) || r.email.toLowerCase().includes(needle)) &&
          (dept === "all" || r.department === dept) &&
          (role === "all" || r.role === role) &&
          (status === "all" || (status === "access" ? r.mayUnmask : status === "own" ? r.source === "own" : r.status === status)),
      )
      .sort((a, b) => pctOf(b) - pctOf(a) || b.used - a.used || Number(b.mayUnmask) - Number(a.mayUnmask) || a.name.localeCompare(b.name));
  }, [data.rows, q, dept, role, status]);

  const stopped = data.stoppedToday;
  const kpis: { label: string; value: number; hint: string; tone?: "warn" | "danger"; filter: Filter }[] = [
    { label: "Employees with unmask access", value: summary.canUnmask, hint: "may unmask at least one field", filter: "access" },
    {
      label: "Records unmasked today",
      value: summary.unmaskedToday,
      hint: stopped
        ? `${stopped.limitReached} stopped by the limit · ${stopped.refused} refused`
        : `by ${summary.peopleUnmaskingToday} ${summary.peopleUnmaskingToday === 1 ? "person" : "people"}`,
      tone: summary.unmaskedToday ? "warn" : undefined,
      filter: "all",
    },
    { label: "Employees at limit", value: summary.atLimit, hint: "0 remaining today, access intact", tone: summary.atLimit ? "danger" : undefined, filter: "at" },
    { label: "Near limit", value: summary.nearLimit, hint: "80% or more used", tone: summary.nearLimit ? "warn" : undefined, filter: "near" },
    { label: "No daily limit", value: summary.unlimited, hint: "may unmask without a cap", tone: summary.unlimited ? "warn" : undefined, filter: "unlimited" },
  ];

  async function removeOwn(row: UnmaskLimitRow) {
    if (
      !(await confirmAction({
        title: `Remove ${first(row.name)}’s own limit?`,
        message: `${first(row.name)} goes back to ${inheritedWords(row)}. What they have already unmasked today still counts.`,
        confirmLabel: "Remove limit",
        danger: false,
      }))
    )
      return;
    start(async () => {
      const result = await setPersonUnmaskLimit(row.id, null);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(`${first(row.name)} is back on ${inheritedWords(row)}`);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3.5">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">
        {kpis.map((k) => {
          const on = k.filter !== "all" && status === k.filter;
          return (
            <button
              key={k.label}
              type="button"
              aria-pressed={k.filter === "all" ? undefined : on}
              onClick={() => setStatus(on ? "all" : k.filter)}
              className={cn("rounded-lg border bg-surface px-4 py-3 text-left transition-colors", on ? "border-brand" : "border-line hover:border-line-strong")}
            >
              <div className="text-xs font-medium text-muted">{k.label}</div>
              <div className={cn("mt-0.5 text-2xl font-bold tracking-[-0.02em]", k.tone === "danger" ? "text-danger" : k.tone === "warn" ? "text-warning" : "text-text")}>{k.value}</div>
              <div className="text-[11.5px] text-subtle">{k.hint}</div>
            </button>
          );
        })}
      </div>

      <Panel className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <label className="relative block">
          <span className="sr-only">Search employees</span>
          <Search className="pointer-events-none absolute left-2 top-[7px] h-[18px] w-[18px] text-subtle" aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Employee" className={cn(acInput, "w-[200px] pl-[30px]")} />
        </label>
        <select aria-label="Department" value={dept} onChange={(e) => setDept(e.target.value)} className={cn(acInput, "px-2 text-xs")}>
          <option value="all">All departments</option>
          {depts.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)} className={cn(acInput, "px-2 text-xs")}>
          <option value="all">All roles</option>
          {roles.map((r) => (
            <option key={r.key} value={r.key}>
              {r.name}
            </option>
          ))}
        </select>
        <select aria-label="Usage status" value={status} onChange={(e) => setStatus(e.target.value as Filter)} className={cn(acInput, "px-2 text-xs")}>
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <span className="ml-auto text-xs text-muted">
          {shown.length} of {data.rows.length} employees
        </span>
      </Panel>

      <Panel className="overflow-auto">
        <table className="w-full min-w-[1000px] border-collapse">
          <thead>
            <tr>
              <th className={thClass}>Employee</th>
              <th className={thClass}>Department</th>
              <th className={thClass}>Role</th>
              <th className={cn(thClass, "text-right")}>Daily limit</th>
              <th className={cn(thClass, "text-right")}>Used</th>
              <th className={cn(thClass, "text-right")}>Remaining</th>
              <th className={cn(thClass, "min-w-[150px]")}>Usage</th>
              <th className={thClass}>Last activity</th>
              <th className={thClass}>Status</th>
              <th className={cn(thClass, "w-[120px]")} />
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const pct = pctOf(r);
              const st = STATUS[r.status];
              const counted = r.limit !== null;
              const nothing = r.source === "none";
              return (
                <tr key={r.id} className={rowHoverClass}>
                  <td className={tdClass}>
                    <Link href={acPath.employee(r.id, "pii")} className="flex items-center gap-2.5 text-left">
                      <InitialsAvatar name={r.name} seed={r.id} size={28} />
                      <span className="min-w-0">
                        <span className="block font-semibold text-text">{r.name}</span>
                        <span className="block text-[11px] text-subtle">{r.email}</span>
                      </span>
                    </Link>
                  </td>
                  <td className={cn(tdClass, "text-text/80")}>{r.department ?? <span className="text-subtle">—</span>}</td>
                  <td className={cn(tdClass, "text-text/80")}>{r.roleName}</td>
                  <td className={cn(tdClass, "text-right")}>
                    <span className="block whitespace-nowrap font-semibold tabular-nums text-text">{nothing ? <span className="text-subtle">—</span> : counted ? r.limit : "No limit"}</span>
                    <span className="block whitespace-nowrap text-[11px] text-subtle" title={r.source === "own" && r.own?.reason ? r.own.reason : undefined}>
                      {sourceWords(r)}
                    </span>
                  </td>
                  <td className={cn(tdClass, "text-right tabular-nums text-text/80")}>{r.used}</td>
                  <td className={cn(tdClass, "text-right font-bold tabular-nums", r.remaining === null ? "text-subtle" : r.remaining === 0 ? "text-danger" : r.remaining <= 2 ? "text-warning" : "text-text")}>
                    {r.remaining ?? "—"}
                  </td>
                  <td className={tdClass}>
                    {counted ? (
                      <div className="flex items-center gap-2">
                        <span className="block h-1.5 flex-1 overflow-hidden rounded-[3px] bg-surface-sunken">
                          <span className={cn("block h-full rounded-[3px]", pct >= 100 ? "bg-danger" : pct >= 80 ? "bg-warning" : "bg-brand")} style={{ width: `${pct}%` }} />
                        </span>
                        <span className="w-[34px] text-right text-[11.5px] tabular-nums text-muted">{pct}%</span>
                      </div>
                    ) : (
                      <span className="text-[11.5px] text-subtle">{nothing ? "—" : "Not counted against a limit"}</span>
                    )}
                  </td>
                  <td className={cn(tdClass, "whitespace-nowrap text-xs text-muted")}>
                    {data.logVisible ? (
                      <Ago at={r.lastActivityAt} empty="No reveals yet" />
                    ) : (
                      <span className="text-subtle" title="Only the super admin reads the unmasking log.">
                        —
                      </span>
                    )}
                  </td>
                  <td className={tdClass}>
                    <Pill tone={st.tone} title={st.title}>
                      {st.label}
                    </Pill>
                  </td>
                  <td className={cn(tdClass, "whitespace-nowrap text-right")}>
                    <button type="button" title={r.lockedWhy ?? "Edit limit"} aria-label={`Edit ${r.name}'s daily limit`} disabled={r.lockedWhy !== null} onClick={() => setEditing(r)} className={iconButton}>
                      <Pencil className="h-4 w-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      title={r.lockedWhy ?? (r.own ? "Remove own limit" : "No limit of their own to remove")}
                      aria-label={`Remove ${r.name}'s own limit`}
                      disabled={r.lockedWhy !== null || !r.own}
                      onClick={() => removeOwn(r)}
                      className={iconButton}
                    >
                      <Undo2 className="h-4 w-4" aria-hidden />
                    </button>
                    {data.logVisible ? (
                      <Link href={acPath.audit({ category: "pii", user: r.id })} title="View history" aria-label={`${r.name}'s unmasking history`} className={iconButton}>
                        <History className="h-4 w-4" aria-hidden />
                      </Link>
                    ) : (
                      <span title="Only the super admin reads the unmasking log." className={cn(iconButton, "opacity-35 hover:bg-transparent")}>
                        <History className="h-4 w-4" aria-hidden />
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={10} className="p-8 text-center text-subtle">
                  No employees match
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>

      <div className="flex items-start gap-2 rounded-lg border border-dashed border-line-strong bg-surface px-3.5 py-2.5 text-xs leading-[1.5] text-muted">
        <Info className="mt-px h-4 w-4 shrink-0" aria-hidden />
        <span>
          A unit is used per record, not per field or per look: unmasking a lead&apos;s email, phone and company together counts once, and opening it again the same day counts nothing. A
          lead&apos;s contact revealed with it uses no unit of its own. Leads, contacts and companies share one limit. Unused units do not roll over; the day turns at midnight on the
          workspace&apos;s clock ({data.zone}).
        </span>
      </div>

      {editing && (
        <EditLimitDialog
          key={editing.id}
          row={editing}
          today={data.today}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

/**
 * One person's own daily limit: a number a day or no limit, why, and optionally until when — after which
 * they are back on their role's limit or the workspace default. The server holds it to the rules
 * (nobody sets a limit above their own, or their own at all) and its answer is shown as it comes.
 */
function EditLimitDialog({ row, today, onClose, onSaved }: { row: UnmaskLimitRow; today: string; onClose: () => void; onSaved: () => void }) {
  const [limited, setLimited] = useState(row.own ? row.own.limited : true);
  const [value, setValue] = useState(() => {
    const n = row.own?.dailyLimit ?? row.limit ?? row.inherited;
    return n === null ? "" : String(n);
  });
  const [reason, setReason] = useState(row.own?.reason ?? "");
  const [until, setUntil] = useState(row.own?.lastDayKey ?? "");
  const [pending, start] = useTransition();
  const name = first(row.name);

  const save = () => {
    if (limited && value.trim() === "") {
      toast.error("Enter how many a day, or choose no limit.");
      return;
    }
    start(async () => {
      const result = await setPersonUnmaskLimit(row.id, limited ? { limited: true, dailyLimit: value } : { limited: false }, { reason, expiresAt: until || null });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(limited ? `${name}’s daily limit is now ${value}` : `${name} now has no daily limit`);
      onSaved();
    });
  };

  return (
    <Dialog open onClose={onClose} title={`Edit daily limit · ${row.name}`}>
      <div className="space-y-4 text-[13px] text-text">
        <p className="leading-[1.5] text-muted">
          How many different leads, contacts and companies {name} may unmask in one day, together. Now: {limitWords(row.limit)}
          {row.source === "own" ? ", set for them personally" : row.source === "role" ? ", from their role" : row.source === "default" ? ", the workspace default" : ""}. Without a limit of their own{" "}
          {name} is on {inheritedWords(row)}.
        </p>

        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-semibold text-text/80">Daily limit</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="ac-limit-kind" checked={limited} disabled={pending} onChange={() => setLimited(true)} className="h-4 w-4 accent-[var(--color-brand)]" />
            A number a day
          </label>
          {limited && (
            <div className="flex flex-wrap items-center gap-2 pl-6">
              <label htmlFor="ac-person-limit" className="sr-only">
                Leads, contacts and companies a day
              </label>
              <input
                id="ac-person-limit"
                inputMode="numeric"
                value={value}
                disabled={pending}
                onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))}
                placeholder="How many"
                className={cn(acInput, "w-24 text-right")}
              />
              {LIMIT_PRESETS.map((n) => (
                <button key={n} type="button" onClick={() => setValue(String(n))} className="h-8 rounded-md border border-line px-2.5 text-xs text-muted transition-colors hover:bg-surface-sunken">
                  {n}
                </button>
              ))}
            </div>
          )}
          <label className="flex items-center gap-2">
            <input type="radio" name="ac-limit-kind" checked={!limited} disabled={pending} onChange={() => setLimited(false)} className="h-4 w-4 accent-[var(--color-brand)]" />
            No limit
            <span className="text-xs text-subtle">— as many as their field access allows</span>
          </label>
        </fieldset>

        <div className="space-y-1">
          <label htmlFor="ac-limit-reason" className="text-xs font-semibold text-text/80">
            Reason
          </label>
          <textarea
            id="ac-limit-reason"
            value={reason}
            disabled={pending}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            placeholder="Why this person's limit differs — kept in the permission history"
            className={cn(acInput, "h-auto w-full resize-y py-1.5 leading-[1.45]")}
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="ac-limit-until" className="text-xs font-semibold text-text/80">
            Until <span className="font-normal text-subtle">(optional)</span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input id="ac-limit-until" type="date" value={until} min={today} disabled={pending} onChange={(e) => setUntil(e.target.value)} className={cn(acInput, "w-[160px]")} />
            {until && (
              <button type="button" onClick={() => setUntil("")} className="text-xs font-semibold text-brand hover:underline">
                No end date
              </button>
            )}
          </div>
          <p className="text-xs text-subtle">
            {until ? `Through the end of that day; after it ${name} is back on ${inheritedWords(row)}.` : "Kept until it is removed."}
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className={acButton.secondary}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={pending} className={acButton.primary}>
            {pending ? "Saving…" : "Save limit"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
