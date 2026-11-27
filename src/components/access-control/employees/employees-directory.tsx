"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Eye, LockOpen, Search, SlidersHorizontal, Timer, UserCog, UserPlus, X } from "lucide-react";
import type { BulkUserResult } from "@/actions/user";
import type { StaffStatus } from "@/lib/staff/status";
import { acPath } from "@/lib/access-control/nav";
import { Ago } from "@/components/ui/ago";
import { AcPage, InitialsAvatar, Panel, acButton, acInput, rowHoverClass, tdClass, thClass } from "@/components/access-control/ui";
import { AssignRoleDialog, ChangeRoleDialog, type RoleChoice } from "@/components/access-control/employees/change-role-dialog";
import { RolePill, StatusDot } from "@/components/access-control/employees/shared";
import { cn } from "@/lib/utils";

/** One person on the list: what the roster says of them, their exceptions by kind, and what sensitive they hold. */
export type EmployeeRow = {
  id: string;
  name: string;
  email: string;
  role: string;
  roleName: string;
  isSuperAdmin: boolean;
  isYou: boolean;
  status: StaffStatus;
  department: string | null;
  departmentId: string | null;
  managerId: string | null;
  jobTitle: string | null;
  /** How many of the catalogue's permissions they hold, from the resolver. */
  holds: number;
  total: number;
  /** Exceptions in force — permissions, record levels, field policies and a daily limit of their own. */
  overrides: number;
  /** Of those, the ones with an end date. */
  temporary: number;
  /** Stored but past their end date. */
  lapsed: number;
  endingSoon: boolean;
  /** The count by kind, in words, for the tooltip. */
  overridesTitle: string;
  /** Sensitive and critical permissions held. */
  sensitive: number;
  /** ISO, or null for never — only when the viewer may see sign-ins. */
  lastActive: string | null;
};

const iconButton = "inline-flex h-7 w-7 items-center justify-center rounded-md text-text/80 transition-colors hover:bg-surface-sunken disabled:pointer-events-none disabled:opacity-40";

/**
 * Employee-Specific Permissions: everybody who can sign in, with their role, how many exceptions are
 * made for them alone and how much sensitive access they hold — searched, filtered, opened, and (for
 * admins) given a role several at a time.
 *
 * The page built every number on the server from the roster and the resolver; this only filters and
 * selects. A role change goes through the actions Users used (`updateUserAssignment`,
 * `bulkUpdateUsers`), which check it again.
 */
export function EmployeesDirectory({
  rows,
  initialRole = "all",
  roles,
  assignableRoles,
  showLastActive,
  canBulk,
  canChangeRole,
  viewerIsSuperAdmin,
  mayAddUsers,
}: {
  rows: EmployeeRow[];
  /** The role filter to open on — a link from a role's "View employees". */
  initialRole?: string;
  /** Every role, for the filter. */
  roles: RoleChoice[];
  /** The roles that can be given: switched on, and not the platform's own. */
  assignableRoles: RoleChoice[];
  /** The viewer may read the sign-in or activity log. */
  showLastActive: boolean;
  /** Bulk changes are for admins only (`bulkUpdateUsers`). */
  canBulk: boolean;
  /** `users.manage` and `users.assignRole`. */
  canChangeRole: boolean;
  viewerIsSuperAdmin: boolean;
  mayAddUsers: boolean;
}) {
  const [query, setQuery] = useState("");
  const [role, setRole] = useState(initialRole);
  const [department, setDepartment] = useState("all");
  const [onlyOverrides, setOnlyOverrides] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [changing, setChanging] = useState<EmployeeRow | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [outcome, setOutcome] = useState<{ result: BulkUserResult; roleName: string } | null>(null);

  const departments = useMemo(() => [...new Set(rows.flatMap((r) => (r.department ? [r.department] : [])))].sort((a, b) => a.localeCompare(b)), [rows]);
  const q = query.trim().toLowerCase();
  const shown = rows.filter(
    (r) =>
      (role === "all" || (role === "__super" ? r.isSuperAdmin : r.role === role && !r.isSuperAdmin)) &&
      (department === "all" || r.department === department) &&
      (!onlyOverrides || r.overrides > 0) &&
      (!q || `${r.name} ${r.email} ${r.jobTitle ?? ""}`.toLowerCase().includes(q)),
  );

  // Your own role is changed by another admin, and the super admin's by nobody here.
  const selectable = (r: EmployeeRow) => !r.isYou && !r.isSuperAdmin;
  const pickable = shown.filter(selectable);
  const picked = rows.filter((r) => selected.has(r.id));
  const allPicked = pickable.length > 0 && pickable.every((r) => selected.has(r.id));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const mayChange = (r: EmployeeRow) => canChangeRole && !r.isYou && (!r.isSuperAdmin || viewerIsSuperAdmin);
  const columns = 6 + (canBulk ? 1 : 0) + (showLastActive ? 1 : 0) + 1;

  return (
    <AcPage
      crumb="Employee Permissions"
      title="Employee-Specific Permissions"
      description="Effective access per person: roles and individual overrides."
      actions={
        <>
          {canBulk && picked.length > 0 && (
            <button type="button" className={acButton.secondary} onClick={() => setAssigning(true)}>
              <UserCog className="h-[18px] w-[18px]" aria-hidden />
              Assign role to {picked.length}
            </button>
          )}
          {mayAddUsers && (
            <Link href="/settings/users/new" className={acButton.primary}>
              <UserPlus className="h-[18px] w-[18px]" aria-hidden />
              Add employee
            </Link>
          )}
        </>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="relative block">
          <span className="sr-only">Search employees</span>
          <Search className="pointer-events-none absolute left-2 top-[7px] h-[18px] w-[18px] text-subtle" aria-hidden />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search employees" className={cn(acInput, "w-60 pl-[30px]")} />
        </label>
        <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role" className={cn(acInput, "px-2 text-xs")}>
          <option value="all">All roles</option>
          {roles.map((r) => (
            <option key={r.key} value={r.key}>
              {r.name}
            </option>
          ))}
          {rows.some((r) => r.isSuperAdmin) && <option value="__super">Super Admin</option>}
        </select>
        <select value={department} onChange={(e) => setDepartment(e.target.value)} aria-label="Department" className={cn(acInput, "px-2 text-xs")}>
          <option value="all">All departments</option>
          {departments.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-text/80">
          <input type="checkbox" checked={onlyOverrides} onChange={(e) => setOnlyOverrides(e.target.checked)} className="accent-[var(--color-brand)]" />
          Only with overrides
        </label>
        <span className="ml-auto text-xs text-muted">
          {shown.length} of {rows.length} employees
        </span>
      </div>

      {outcome && (outcome.result.refused.length > 0 || outcome.result.unchanged.length > 0) && (
        <div role="status" className="mb-3 rounded-lg border border-line bg-surface px-4 py-3 text-xs">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              {outcome.result.refused.length > 0 && (
                <>
                  <p className="font-semibold text-text">Not assigned to {outcome.roleName}</p>
                  <ul className="mt-1 space-y-0.5 text-muted">
                    {outcome.result.refused.map((r) => (
                      <li key={r.id}>
                        <span className="text-text">{r.name}</span> — {r.reason}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {outcome.result.unchanged.length > 0 && (
                <p className={cn("text-muted", outcome.result.refused.length > 0 && "mt-1.5")}>
                  Already {outcome.roleName}: {outcome.result.unchanged.map((u) => u.name).join(", ")}.
                </p>
              )}
            </div>
            <button type="button" onClick={() => setOutcome(null)} aria-label="Dismiss" className={iconButton}>
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>
      )}

      <Panel className="overflow-auto">
        <table className="w-full min-w-[960px] border-collapse">
          <thead>
            <tr>
              {canBulk && (
                <th className={cn(thClass, "w-9")}>
                  <input
                    type="checkbox"
                    aria-label="Select everybody shown"
                    checked={allPicked}
                    disabled={pickable.length === 0}
                    onChange={() => setSelected(allPicked ? new Set() : new Set(pickable.map((r) => r.id)))}
                    className="h-[15px] w-[15px] cursor-pointer accent-[var(--color-brand)]"
                  />
                </th>
              )}
              <th className={thClass}>Employee</th>
              <th className={thClass}>Department</th>
              <th className={thClass}>Role</th>
              <th className={thClass}>Overrides</th>
              <th className={thClass}>Sensitive access</th>
              <th className={thClass}>Status</th>
              {showLastActive && <th className={thClass}>Last active</th>}
              <th className={cn(thClass, "w-[120px]")}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e) => (
              <tr key={e.id} className={rowHoverClass}>
                {canBulk && (
                  <td className={tdClass}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${e.name}`}
                      checked={selected.has(e.id)}
                      disabled={!selectable(e)}
                      title={e.isYou ? "Your own role is changed by another admin." : e.isSuperAdmin ? "The super admin's role isn't changed in bulk." : undefined}
                      onChange={() => toggle(e.id)}
                      className="h-[15px] w-[15px] cursor-pointer accent-[var(--color-brand)] disabled:cursor-not-allowed disabled:opacity-40"
                    />
                  </td>
                )}
                <td className={tdClass}>
                  <Link href={acPath.employee(e.id)} className="flex items-center gap-2.5 text-left">
                    <InitialsAvatar name={e.name} seed={e.id} size={30} />
                    <span className="min-w-0">
                      <span className="block font-semibold text-text">
                        {e.name}
                        {e.isYou && <span className="ml-1.5 text-[11px] font-medium text-subtle">you</span>}
                      </span>
                      <span className="block text-xs text-muted">{e.email}</span>
                    </span>
                  </Link>
                </td>
                <td className={tdClass}>
                  <div className="text-text/80">{e.department ?? <span className="text-subtle">—</span>}</div>
                  {e.jobTitle && <div className="text-[11px] text-subtle">{e.jobTitle}</div>}
                </td>
                <td className={tdClass}>
                  <RolePill roleKey={e.role} name={e.roleName} superAdmin={e.isSuperAdmin} />
                  <div className="mt-0.5 text-[11px] text-subtle" title="How many of the catalogue's permissions they hold, with their role and their own exceptions put together.">
                    holds {e.holds} of {e.total}
                  </div>
                </td>
                <td className={tdClass}>
                  {e.overrides > 0 ? (
                    <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-semibold text-brand" title={e.overridesTitle}>
                      <SlidersHorizontal className="h-4 w-4" aria-hidden />
                      {e.overrides}
                      {e.temporary > 0 && <span className="font-medium text-warning">· {e.temporary} temporary</span>}
                      {e.endingSoon && <Timer className="h-3.5 w-3.5 text-warning" aria-label="One ends within a week" />}
                    </span>
                  ) : e.lapsed > 0 ? (
                    <span className="whitespace-nowrap text-xs text-subtle" title="Their end date has passed, so they no longer apply. They stay listed on the person's page until removed.">
                      {e.lapsed} lapsed
                    </span>
                  ) : (
                    <span className="text-subtle">—</span>
                  )}
                </td>
                <td className={tdClass}>
                  {e.sensitive > 0 ? (
                    <span
                      className={cn("inline-flex items-center gap-1 whitespace-nowrap text-xs font-semibold", e.sensitive > 8 ? "text-danger" : e.sensitive > 3 ? "text-warning" : "text-text/80")}
                      title="Permissions marked sensitive or critical that they hold."
                    >
                      <LockOpen className="h-4 w-4" aria-hidden />
                      {e.sensitive} {e.sensitive === 1 ? "item" : "items"}
                    </span>
                  ) : (
                    <span className="text-subtle">—</span>
                  )}
                </td>
                <td className={tdClass}>
                  <StatusDot status={e.status} />
                </td>
                {showLastActive && (
                  <td className={cn(tdClass, "whitespace-nowrap text-muted")}>
                    <Ago at={e.lastActive} empty="Never" />
                  </td>
                )}
                <td className={cn(tdClass, "whitespace-nowrap text-right")}>
                  <Link href={acPath.simulator(e.id)} title="Simulate as this employee" aria-label={`Simulate as ${e.name}`} className={iconButton}>
                    <Eye className="h-[18px] w-[18px]" aria-hidden />
                  </Link>
                  {mayChange(e) && (
                    <button type="button" title="Change role" aria-label={`Change ${e.name}'s role`} className={iconButton} onClick={() => setChanging(e)}>
                      <UserCog className="h-[18px] w-[18px]" aria-hidden />
                    </button>
                  )}
                  <Link href={acPath.employee(e.id)} title="Open profile" aria-label={`Open ${e.name}'s profile`} className={iconButton}>
                    <ArrowRight className="h-[18px] w-[18px]" aria-hidden />
                  </Link>
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={columns} className="px-4 py-8 text-center text-subtle">
                  {rows.length === 0 ? "Nobody can sign in yet." : "No employee matches."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>

      {changing && (
        <ChangeRoleDialog
          person={{ id: changing.id, name: changing.name, role: changing.role, roleName: changing.roleName, departmentId: changing.departmentId, managerId: changing.managerId }}
          roles={assignableRoles}
          onClose={() => setChanging(null)}
        />
      )}
      {assigning && (
        <AssignRoleDialog
          ids={picked.map((p) => p.id)}
          roles={assignableRoles}
          onClose={() => setAssigning(false)}
          onDone={(result, roleName) => {
            setOutcome({ result, roleName });
            if (result.done.length) setSelected(new Set());
          }}
        />
      )}
    </AcPage>
  );
}
