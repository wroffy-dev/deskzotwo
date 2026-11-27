"use client";

import { useMemo, useState } from "react";
import {
  ArrowDownUp,
  ChevronDown,
  ChevronRight,
  FolderKanban,
  Landmark,
  Laptop,
  LifeBuoy,
  ListChecks,
  Lock,
  Megaphone,
  Package,
  Search,
  Settings,
  ShoppingCart,
  TrendingUp,
  Truck,
  UserCog,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Pill, acInput } from "@/components/access-control/ui";
import type { WizardModule, WizardModuleIcon } from "@/components/access-control/roles/types";
import { cn } from "@/lib/utils";

export const MODULE_ICON: Record<WizardModuleIcon, LucideIcon> = {
  crm: Users,
  sales: ShoppingCart,
  purchases: Truck,
  products: Package,
  projects: FolderKanban,
  finance: Landmark,
  support: LifeBuoy,
  marketing: Megaphone,
  hr: UserCog,
  performance: TrendingUp,
  assets: Laptop,
  work: ListChecks,
  data: ArrowDownUp,
  settings: Settings,
};

/**
 * The wizard's Module access step: every module with the permissions filed under it, each either
 * allowed or off for the role — the design's per-module presets, drawn over DeskZo's real permission
 * keys (a role's answer to a key is yes or no; there is no View/Edit/Full ladder to pick from).
 *
 * Nothing is saved here: the choices are handed up, and the wizard saves them together through
 * `setRolePermissions` when the step is left with Continue. A key the viewer can't change is locked
 * with the reason the server would give.
 */
export function WizardModulesStep({
  modules,
  holds,
  saved,
  lockOf,
  disabled,
  onSet,
}: {
  modules: WizardModule[];
  /** What the role would hold with the choices made so far. */
  holds: (key: string) => boolean;
  /** What it holds as saved. */
  saved: (key: string) => boolean;
  /** Why a key can't be changed, or null. */
  lockOf: (key: string) => string | null;
  disabled: boolean;
  onSet: (changes: { key: string; allowed: boolean }[]) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();

  const shown = useMemo(
    () =>
      modules
        .map((m) => ({ module: m, rows: needle ? m.permissions.filter((p) => `${p.label} ${p.description} ${p.key}`.toLowerCase().includes(needle)) : m.permissions }))
        .filter((m) => m.rows.length > 0),
    [modules, needle],
  );

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
        <label className="relative">
          <span className="sr-only">Search permissions</span>
          <Search className="pointer-events-none absolute left-2 top-[7px] h-[18px] w-[18px] text-subtle" aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search permissions" className={cn(acInput, "w-60 pl-[30px]")} />
        </label>
        <span>
          <b className="font-semibold text-text">Off</b> the role can&apos;t
        </span>
        <span>
          <b className="font-semibold text-text">Allow</b> everyone in the role can
        </span>
        <span className="ml-auto">Fine-tune any module in the matrix after saving.</span>
      </div>

      {shown.length === 0 && <div className="rounded-lg border border-dashed border-line-strong p-6 text-center text-subtle">No permission matches “{q}”.</div>}

      {shown.map(({ module: m, rows }) => {
        const allowed = m.permissions.filter((p) => holds(p.key)).length;
        const expanded = needle !== "" || open.has(m.key);
        const Icon = MODULE_ICON[m.icon];
        const setAll = (value: boolean) => onSet(m.permissions.filter((p) => lockOf(p.key) === null && holds(p.key) !== value).map((p) => ({ key: p.key, allowed: value })));
        return (
          <div key={m.key} className="overflow-hidden rounded-lg border border-line">
            <div className={cn("flex flex-wrap items-center gap-2 bg-surface-sunken/60 px-3 py-2", expanded && "border-b border-line")}>
              <button type="button" onClick={() => toggle(m.key)} aria-expanded={expanded} className="flex min-w-[200px] flex-1 items-center gap-2 text-left">
                {expanded ? <ChevronDown className="h-4 w-4 shrink-0 text-subtle" aria-hidden /> : <ChevronRight className="h-4 w-4 shrink-0 text-subtle" aria-hidden />}
                <Icon className={cn("h-[18px] w-[18px] shrink-0", allowed ? "text-text/80" : "text-subtle")} aria-hidden />
                <span className="min-w-0">
                  <span className={cn("text-xs font-bold", allowed ? "text-text/80" : "text-subtle")}>{m.label}</span>
                  <span className="ml-2 text-[11px] text-subtle">{m.description}</span>
                </span>
              </button>
              <span className={cn("text-[11px] font-semibold", allowed ? "text-brand" : "text-subtle")}>
                {allowed} of {m.permissions.length} allowed
              </span>
              <span className="text-[11px] text-subtle">Set all:</span>
              {(
                [
                  ["None", false],
                  ["All", true],
                ] as const
              ).map(([label, value]) => (
                <button
                  key={label}
                  type="button"
                  disabled={disabled}
                  onClick={() => setAll(value)}
                  className="h-[22px] rounded border border-line-strong bg-surface px-2 text-[11px] font-semibold text-text transition-colors hover:bg-surface-sunken disabled:opacity-45"
                >
                  {label}
                </button>
              ))}
            </div>
            {expanded &&
              rows.map((p) => {
                const on = holds(p.key);
                const why = lockOf(p.key);
                const edited = on !== saved(p.key);
                return (
                  <div key={p.key} className="flex items-center gap-3 border-b border-line/70 px-3 py-2 last:border-b-0">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={cn("font-medium", on ? "text-text" : "text-subtle")}>{p.label}</span>
                        {p.tier === "critical" && <Pill tone="red">Critical</Pill>}
                        {p.tier === "sensitive" && <Pill tone="amber">Sensitive</Pill>}
                        {p.superAdminOnly && <Pill>Super admin grants</Pill>}
                        {p.selfExcluded && (
                          <span title="Never used on a record the person raised themselves — enforced on the server.">
                            <Pill tone="blue">Not on own records</Pill>
                          </span>
                        )}
                        {edited && <span className="text-[11px] font-semibold text-warning">unsaved</span>}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-muted" title={p.description}>
                        {p.description}
                      </div>
                    </div>
                    {why && (
                      <span title={why} className="inline-flex">
                        <Lock className="h-3.5 w-3.5 text-subtle" aria-label={why} />
                      </span>
                    )}
                    <div className={cn("inline-flex shrink-0 overflow-hidden rounded-md border border-line-strong", why && "opacity-60")} title={why ?? undefined}>
                      {(
                        [
                          ["Off", false],
                          ["Allow", true],
                        ] as const
                      ).map(([label, value]) => (
                        <button
                          key={label}
                          type="button"
                          aria-pressed={on === value}
                          aria-label={`${p.label}: ${label}`}
                          disabled={disabled || why !== null}
                          onClick={() => on !== value && onSet([{ key: p.key, allowed: value }])}
                          className={cn(
                            "h-7 border-r border-line px-3 text-xs font-semibold last:border-r-0 disabled:cursor-not-allowed",
                            // "Off" is not held, not an explicit deny — so it is drawn quiet, not red.
                            on === value ? (value ? "bg-brand-subtle text-brand" : "bg-surface-sunken text-text") : "bg-surface text-muted hover:bg-surface-sunken",
                          )}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}
