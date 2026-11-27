"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowDownUp,
  ArrowLeftRight,
  CirclePause,
  CirclePlay,
  Columns3,
  Copy,
  Eye,
  Filter,
  Grid3x3,
  Lock,
  MoreHorizontal,
  PenLine,
  Pencil,
  Download,
  Plus,
  RotateCcw,
  Search,
  Shield,
  ShieldCheck,
  Trash2,
  Users,
  type LucideIcon,
} from "lucide-react";
import { deleteRole, setRoleActive } from "@/actions/role";
import { ofThemSwitchedOff } from "@/lib/people-count";
import { acPath } from "@/lib/access-control/nav";
import { Ago } from "@/components/ui/ago";
import { confirmAction } from "@/components/ui/confirm";
import { Menu } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { AcPage, InitialsAvatar, Panel, Pill, acButton, acInput, acToneOf, rowHoverClass, tdClass, thClass } from "@/components/access-control/ui";
import { DuplicateRoleDialog, RenameRoleDialog, RolePresetsDialog } from "@/components/access-control/roles/role-dialogs";
import type { RoleListRow } from "@/components/access-control/roles/types";
import { cn } from "@/lib/utils";

type TypeFilter = "all" | "system" | "custom";
type SortKey = "name" | "updated" | "employees" | "perms";

const FILTERS: { key: TypeFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "system", label: "System" },
  { key: "custom", label: "Custom" },
];

const SORTERS: Record<SortKey, (a: RoleListRow, b: RoleListRow) => number> = {
  name: (a, b) => a.name.localeCompare(b.name),
  updated: (a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.name.localeCompare(b.name),
  employees: (a, b) => b.people - a.people || a.name.localeCompare(b.name),
  perms: (a, b) => b.permissions - a.permissions || a.name.localeCompare(b.name),
};

/** Where a link to the people who hold a role goes: Employee Permissions, narrowed to the role. */
function employeesOf(role: string) {
  return `${acPath.employees()}?role=${encodeURIComponent(role)}`;
}

/**
 * Settings › Access Control › Roles & Permissions: every role with who holds it, how much it grants
 * and when it last changed; search, filter and sort; tick two to compare them; and a row menu for
 * what can be done to a role.
 *
 * The rules are the old Roles screen's, enforced again by each action: the roles the application was
 * built around can be renamed and changed but never deleted or disabled; a role somebody holds can't
 * be deleted, nor disabled while anybody who can sign in holds it; only a super admin changes what
 * Admin grants. The super admin is listed apart — outside the permission system, not an Admin.
 */
export function RolesScreen({
  roles,
  superAdmins,
  totals,
  mayManage,
  viewerIsSuperAdmin,
  labels,
}: {
  roles: RoleListRow[];
  /** Accounts that are the super admin and can sign in. */
  superAdmins: number;
  /** How many permissions and modules there are, for the super admin's row. */
  totals: { permissions: number; modules: number };
  mayManage: boolean;
  viewerIsSuperAdmin: boolean;
  /** Permission key → label, for a preset's preview. */
  labels: Record<string, string>;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<TypeFilter>("all");
  const [sort, setSort] = useState<SortKey>("name");
  const [selected, setSelected] = useState<string[]>([]);
  const [dialog, setDialog] = useState<{ kind: "rename" | "duplicate" | "presets"; role: RoleListRow } | null>(null);
  const [pending, start] = useTransition();

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return roles
      .filter((r) => (filter === "all" || (filter === "system") === r.isSystem) && (!needle || `${r.name} ${r.description ?? ""} ${r.key}`.toLowerCase().includes(needle)))
      .sort(SORTERS[sort]);
  }, [roles, q, filter, sort]);
  const showSuperAdmin = superAdmins > 0 && filter !== "custom" && (!q.trim() || "super admin".includes(q.trim().toLowerCase()));

  // Only roles still on the list count towards the two being compared.
  const picked = selected.filter((k) => roles.some((r) => r.key === k));
  const toggle = (key: string) => setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  const setActive = (role: RoleListRow, active: boolean) =>
    start(async () => {
      if (!active) {
        // Refused before asking: a role is only disabled once nobody who can sign in holds it.
        if (role.people > 0) {
          toast.error(`Can't disable "${role.name}": ${role.people} ${role.people === 1 ? "person who can sign in holds" : "people who can sign in hold"} it. Move them to another role first.`);
          return;
        }
        const yes = await confirmAction({
          title: `Disable ${role.name}?`,
          message: "The role is kept — its settings, its history, its name on old records — and offered to nobody: no new account, role change or import may give it until it is enabled again.",
          confirmLabel: "Disable role",
          danger: true,
        });
        if (!yes) return;
      }
      const r = await setRoleActive(role.key, active);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(`${role.name} ${active ? "enabled" : "disabled"}`);
      router.refresh();
    });

  const remove = (role: RoleListRow) =>
    start(async () => {
      if (role.headcount > 0) {
        toast.error(`Cannot delete "${role.name}": ${role.headcount} ${role.headcount === 1 ? "person" : "people"}${ofThemSwitchedOff(role.headcount, role.switchedOff)} ${role.headcount === 1 ? "holds" : "hold"} it. Move them to another role first.`);
        return;
      }
      const yes = await confirmAction({
        title: `Delete ${role.name}?`,
        message: "Its permissions, reach and field access go with it. Its history stays. This cannot be undone.",
        confirmLabel: "Delete role",
        danger: true,
      });
      if (!yes) return;
      const r = await deleteRole(role.key);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(`${role.name} deleted`);
      setSelected((prev) => prev.filter((k) => k !== role.key));
      router.refresh();
    });

  return (
    <AcPage
      crumb="Roles & Permissions"
      title="Roles & Permissions"
      description="System and custom roles. Open a role to edit its module, field and data-scope permissions."
      actions={
        <>
          {picked.length === 2 ? (
            <Link href={acPath.compare(`role:${picked[0]}`, `role:${picked[1]}`)} className={acButton.secondary}>
              <ArrowLeftRight className="h-[18px] w-[18px]" aria-hidden />
              Compare (2/2)
            </Link>
          ) : (
            <button type="button" disabled title="Tick two roles to compare them" className={acButton.secondary}>
              <ArrowLeftRight className="h-[18px] w-[18px]" aria-hidden />
              Compare{picked.length ? ` (${picked.length}/2)` : ""}
            </button>
          )}
          {/* Every assigned permission as a workbook — the super admin's only (owner, 2 Nov 2026). */}
          {viewerIsSuperAdmin && (
            <a href="/api/access/permissions-export" className={acButton.secondary}>
              <Download className="h-[18px] w-[18px]" aria-hidden />
              Export to Excel
            </a>
          )}
          {mayManage && (
            <Link href={acPath.wizard()} className={acButton.primary}>
              <Plus className="h-[18px] w-[18px]" aria-hidden />
              Create new role
            </Link>
          )}
        </>
      }
    >
      {!mayManage && (
        <p className="mb-3 flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-[13px] text-muted">
          <Eye className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
          You can review roles but not change them. Everything here is read-only.
        </p>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="relative">
          <span className="sr-only">Search roles</span>
          <Search className="pointer-events-none absolute left-2 top-[7px] h-[18px] w-[18px] text-subtle" aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search roles" className={cn(acInput, "w-60 pl-[30px]")} />
        </label>
        <div className="inline-flex overflow-hidden rounded-md border border-line-strong bg-surface">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={cn("h-[30px] border-r border-line px-3 text-xs font-semibold last:border-r-0", filter === f.key ? "bg-brand-subtle text-brand" : "bg-surface text-text/80 hover:bg-surface-sunken")}
            >
              {f.label}
            </button>
          ))}
        </div>
        <select aria-label="Sort roles" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className={cn(acInput, "px-2 text-xs")}>
          <option value="name">Sort: Name</option>
          <option value="updated">Sort: Last modified</option>
          <option value="employees">Sort: Employees</option>
          <option value="perms">Sort: Permissions</option>
        </select>
        <span className="ml-auto text-xs text-muted">
          {shown.length} of {roles.length} roles
        </span>
      </div>

      <Panel className="overflow-auto">
        <table className="w-full min-w-[900px] border-collapse">
          <thead>
            <tr>
              <th className={cn(thClass, "w-9")}>
                <span className="sr-only">Compare</span>
              </th>
              {["Role", "Type", "Employees", "Permissions", "Last modified", "Status"].map((h) => (
                <th key={h} className={thClass}>
                  {h}
                </th>
              ))}
              <th className={cn(thClass, "w-[140px]")}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {showSuperAdmin && (
              <tr className={rowHoverClass}>
                <td className={tdClass} />
                <td className={tdClass}>
                  <div className="flex items-center gap-2.5">
                    <RoleTile seed="SUPER_ADMIN" icon={ShieldCheck} />
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 font-semibold text-text">
                        Super Admin
                        <span title="Outside the permission system · cannot be edited" className="inline-flex">
                          <Lock className="h-3.5 w-3.5 text-subtle" aria-label="Cannot be edited" />
                        </span>
                      </span>
                      <span className="block max-w-[360px] truncate text-xs text-muted">Holds everything, always. No permission is read for this account, and there is exactly one.</span>
                    </span>
                  </div>
                </td>
                <td className={tdClass}>
                  <Pill>System</Pill>
                </td>
                <td className={cn(tdClass, "text-xs text-text/80")}>
                  {superAdmins} {superAdmins === 1 ? "person" : "people"}
                </td>
                <td className={cn(tdClass, "whitespace-nowrap")}>
                  <span className="font-semibold">{totals.permissions}</span>
                  <span className="text-xs text-subtle"> · {totals.modules} modules</span>
                </td>
                <td className={cn(tdClass, "text-subtle")}>—</td>
                <td className={tdClass}>
                  <StatusDot active />
                </td>
                <td className={tdClass} />
              </tr>
            )}
            {shown.map((r) => {
              // Admin's permissions are the super admin's to change; its name is anybody's who may change roles.
              const adminLocked = r.key === "ADMIN" && !viewerIsSuperAdmin;
              return (
                <tr key={r.key} className={rowHoverClass}>
                  <td className={tdClass}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.name} to compare`}
                      checked={picked.includes(r.key)}
                      disabled={!picked.includes(r.key) && picked.length >= 2}
                      onChange={() => toggle(r.key)}
                      className="h-[15px] w-[15px] cursor-pointer accent-brand disabled:cursor-not-allowed"
                    />
                  </td>
                  <td className={tdClass}>
                    <Link href={acPath.modules({ role: r.key })} className="group flex items-center gap-2.5 text-left">
                      <RoleTile seed={r.key} icon={Shield} />
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5 font-semibold text-text group-hover:text-brand">
                          {r.name}
                          {adminLocked && (
                            <span title="Only a super admin can change what admins can do" className="inline-flex">
                              <Lock className="h-3.5 w-3.5 text-subtle" aria-label="Locked" />
                            </span>
                          )}
                        </span>
                        <span className="block max-w-[360px] truncate text-xs text-muted">{r.description || "No description yet."}</span>
                      </span>
                    </Link>
                  </td>
                  <td className={tdClass}>
                    <Pill tone={r.isSystem ? "neutral" : "brand"}>{r.isSystem ? "System" : "Custom"}</Pill>
                  </td>
                  <td className={tdClass}>
                    <Link href={employeesOf(r.key)} className="flex items-center gap-1.5 transition-opacity hover:opacity-80">
                      {r.avatars.length > 0 && (
                        <span className="flex pl-1.5">
                          {r.avatars.map((p) => (
                            <InitialsAvatar key={p.id} name={p.name} seed={p.id} size={22} className="-ml-1.5 border-2 border-surface" />
                          ))}
                        </span>
                      )}
                      <span className="text-xs text-text/80">{r.people === 0 ? "No one" : `${r.people} ${r.people === 1 ? "person" : "people"}`}</span>
                    </Link>
                  </td>
                  <td className={cn(tdClass, "whitespace-nowrap")}>
                    <span className="font-semibold">{r.permissions}</span>
                    <span className="text-xs text-subtle">
                      {" "}
                      · {r.modules} {r.modules === 1 ? "module" : "modules"}
                    </span>
                  </td>
                  <td className={cn(tdClass, "whitespace-nowrap")}>
                    {r.updatedAt ? (
                      <>
                        <div className="text-text/80">
                          <Ago at={r.updatedAt} />
                        </div>
                        <div className="text-[11px] text-subtle">by {r.updatedBy ?? "someone"}</div>
                      </>
                    ) : (
                      <span className="text-subtle">—</span>
                    )}
                  </td>
                  <td className={tdClass}>
                    <StatusDot active={r.active} />
                  </td>
                  <td className={cn(tdClass, "whitespace-nowrap text-right")}>
                    <span className="inline-flex items-center justify-end">
                      <RowLink href={acPath.fields({ role: r.key })} label="Field permissions" icon={Columns3} />
                      <RowLink href={acPath.modules({ role: r.key })} label="Module permissions" icon={Grid3x3} />
                      <Menu icon={MoreHorizontal} label={`More actions for ${r.name}`} width={236}>
                        {(close) => {
                          const run = (fn: () => void) => () => {
                            close();
                            fn();
                          };
                          const go = (href: string) => run(() => router.push(href));
                          return (
                            <>
                              {mayManage && (
                                <>
                                  <Item icon={Pencil} onClick={go(acPath.wizard(r.key))}>
                                    Edit role
                                  </Item>
                                  <Item icon={PenLine} onClick={run(() => setDialog({ kind: "rename", role: r }))}>
                                    Rename
                                  </Item>
                                  <Item icon={Copy} onClick={run(() => setDialog({ kind: "duplicate", role: r }))}>
                                    Duplicate
                                  </Item>
                                  <Divider />
                                </>
                              )}
                              <Item icon={Grid3x3} onClick={go(acPath.modules({ role: r.key }))}>
                                Module permissions
                              </Item>
                              <Item icon={Columns3} onClick={go(acPath.fields({ role: r.key }))}>
                                Field permissions
                              </Item>
                              <Item icon={Filter} onClick={go(acPath.scope({ role: r.key }))}>
                                Data scope
                              </Item>
                              <Item icon={ArrowDownUp} onClick={go(acPath.importExport(r.key))}>
                                Import &amp; export
                              </Item>
                              <Item icon={Users} onClick={go(employeesOf(r.key))}>
                                View employees ({r.people})
                              </Item>
                              {mayManage && (
                                <>
                                  <Divider />
                                  {r.presets.length > 0 && (
                                    <Item
                                      icon={RotateCcw}
                                      disabled={adminLocked}
                                      title={adminLocked ? "Only a super admin can change what admins can do." : undefined}
                                      onClick={run(() => setDialog({ kind: "presets", role: r }))}
                                    >
                                      Apply a preset
                                    </Item>
                                  )}
                                  {r.active ? (
                                    <Item
                                      icon={CirclePause}
                                      disabled={pending || r.isSystem}
                                      title={r.isSystem ? "One of the roles this application was built around — it stays on." : undefined}
                                      onClick={run(() => setActive(r, false))}
                                    >
                                      Disable role
                                    </Item>
                                  ) : (
                                    <Item icon={CirclePlay} disabled={pending} onClick={run(() => setActive(r, true))}>
                                      Enable role
                                    </Item>
                                  )}
                                  <Item
                                    icon={Trash2}
                                    danger
                                    disabled={pending || r.isSystem}
                                    title={r.isSystem ? "One of the roles this application was built around — it can't be deleted." : undefined}
                                    onClick={run(() => remove(r))}
                                  >
                                    Delete role
                                  </Item>
                                </>
                              )}
                            </>
                          );
                        }}
                      </Menu>
                    </span>
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && !showSuperAdmin && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-[13px] text-subtle">
                  {roles.length === 0 ? "There are no roles yet." : "No role matches."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>

      {dialog?.kind === "rename" && <RenameRoleDialog role={dialog.role} onClose={() => setDialog(null)} />}
      {dialog?.kind === "duplicate" && <DuplicateRoleDialog role={dialog.role} onClose={() => setDialog(null)} />}
      {dialog?.kind === "presets" && <RolePresetsDialog role={dialog.role} presets={dialog.role.presets} labels={labels} onClose={() => setDialog(null)} />}
    </AcPage>
  );
}

/** The role's square: DeskZo's roles carry no colour or icon of their own, so the colour is picked from the key. */
function RoleTile({ seed, icon: Icon }: { seed: string; icon: LucideIcon }) {
  return (
    <span className={cn("inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[7px] text-white", acToneOf(seed))}>
      <Icon className="h-[17px] w-[17px]" aria-hidden />
    </span>
  );
}

function StatusDot({ active }: { active: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium", active ? "text-success" : "text-muted")}>
      <span className={cn("h-[7px] w-[7px] rounded-full", active ? "bg-success" : "bg-line-strong")} />
      {active ? "Active" : "Disabled"}
    </span>
  );
}

function RowLink({ href, label, icon: Icon }: { href: string; label: string; icon: LucideIcon }) {
  return (
    <Link href={href} title={label} aria-label={label} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text/80 transition-colors hover:bg-surface-sunken">
      <Icon className="h-[18px] w-[18px]" aria-hidden />
    </Link>
  );
}

function Item({ icon: Icon, danger, disabled, title, onClick, children }: { icon: LucideIcon; danger?: boolean; disabled?: boolean; title?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        "mx-1 flex w-[calc(100%-8px)] items-center gap-2.5 rounded-md px-2.5 py-[7px] text-left text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        danger ? "text-danger hover:bg-danger-bg" : "text-text hover:bg-surface-sunken",
      )}
    >
      <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden />
      {children}
    </button>
  );
}

function Divider() {
  return <div className="my-1 h-px bg-line/70" />;
}
