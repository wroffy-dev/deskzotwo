"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, ExternalLink, Eye, MoreHorizontal, UserCog } from "lucide-react";
import { resetPersonToRole } from "@/actions/person-access";
import { startViewingAs } from "@/actions/impersonation";
import { setUserActive } from "@/actions/user";
import type { StaffStatus } from "@/lib/staff/status";
import { acPath } from "@/lib/access-control/nav";
import { userPath } from "@/lib/staff/staff-paths";
import { confirmAction } from "@/components/ui/confirm";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { InitialsAvatar, Panel, acButton } from "@/components/access-control/ui";
import { ChangeRoleDialog, type RoleChoice } from "@/components/access-control/employees/change-role-dialog";
import { RolePill, StatusPill } from "@/components/access-control/employees/shared";

export type ProfilePerson = {
  id: string;
  name: string;
  email: string;
  role: string;
  roleName: string;
  isSuperAdmin: boolean;
  status: StaffStatus;
  active: boolean;
  department: string | null;
  departmentId: string | null;
  managerId: string | null;
  managerName: string | null;
  jobTitle: string | null;
};

/**
 * The top of one person's Access Control page: who they are and their role, then Simulate, Compare and
 * Change role, with the rest behind "More" — View as user, Reset to role defaults, Switch off or on.
 *
 * Each goes through the action Users used, with its rules: a role change needs `users.assignRole` and
 * is never your own; a reset removes every exception and is refused where it would hand back more than
 * the person resetting could grant; switching off is never yourself or the super admin. The account
 * itself — profile, password, two-factor, how they sign in — stays on Users, one link away.
 */
export function ProfileHeader({
  person,
  holds,
  total,
  exceptions,
  roles,
  may,
}: {
  person: ProfilePerson;
  holds: number;
  total: number;
  /** Everything stored for them alone: permissions, record levels, field policies, their daily limit. */
  exceptions: number;
  roles: RoleChoice[];
  may: { changeRole: boolean; reset: boolean; viewAs: boolean; switchAccount: boolean };
}) {
  const router = useRouter();
  const [changing, setChanging] = useState(false);
  const [busy, start] = useTransition();
  const meta = [person.jobTitle, person.department, person.managerName ? `Reports to ${person.managerName}` : null, person.email].filter(Boolean).join(" · ");

  const reset = () =>
    start(async () => {
      const yes = await confirmAction({
        title: `Reset ${person.name} to their role?`,
        message: exceptions
          ? `Their ${exceptions} exception${exceptions === 1 ? "" : "s"} — permissions, record access, field access and their daily limit — will be removed. Their role, and everybody else, stay as they are.`
          : "They have no exceptions; nothing will change.",
        confirmLabel: "Reset to role defaults",
        danger: true,
      });
      if (!yes) return;
      const r = await resetPersonToRole(person.id);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(r.data.removed ? `Removed ${r.data.removed} exception${r.data.removed === 1 ? "" : "s"}. ${person.name} now has what their role gives.` : "Nothing to reset — they already follow their role.");
      router.refresh();
    });

  const viewAs = () =>
    start(async () => {
      const r = await startViewingAs(person.id);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      router.push("/dashboard");
      router.refresh();
    });

  const switchAccount = (active: boolean) =>
    start(async () => {
      if (!active) {
        const yes = await confirmAction({
          title: `Switch off ${person.name}?`,
          message:
            "They're signed out straight away and can't sign in until somebody switches them back on, and their seat is freed.\n\nNothing is deleted. People own records, so accounts are never removed: their customers, leads, orders and history stay as they are, under their name. Their role and exceptions are kept.",
          confirmLabel: `Switch off ${person.name}`,
          danger: true,
        });
        if (!yes) return;
      }
      const r = await setUserActive(person.id, active);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      const gaps = r.data?.approvalGaps ?? [];
      if (gaps.length) toast.error(`${person.name} is switched off. ${gaps.join(" ")}`);
      else toast.success(active ? `${person.name} is switched on again.` : `${person.name} is switched off. Everything they own stays as it is.`);
      router.refresh();
    });

  const hasMore = may.viewAs || may.reset || may.switchAccount;

  return (
    <Panel className="flex flex-wrap items-center gap-4 px-5 py-4">
      <InitialsAvatar name={person.name} seed={person.id} size={52} />
      <div className="min-w-[220px] flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-bold tracking-[-0.015em] text-text">{person.name}</h1>
          <StatusPill status={person.status} />
        </div>
        <p className="mt-0.5 text-[12.5px] text-muted">{meta}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-subtle">Role</span>
          <RolePill roleKey={person.role} name={person.roleName} superAdmin={person.isSuperAdmin} className="h-6" />
          <span className="text-xs text-muted">
            holds {holds} of {total} permissions · {exceptions ? `${exceptions} exception${exceptions === 1 ? "" : "s"} to their role` : "follows their role exactly"}
          </span>
          <Link href={userPath(person.id, "profile")} className="inline-flex items-center gap-1 text-xs font-semibold text-brand hover:underline">
            Account &amp; sign-in settings
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Link href={acPath.simulator(person.id)} className={acButton.secondary}>
          <Eye className="h-[18px] w-[18px]" aria-hidden />
          Simulate
        </Link>
        {!person.isSuperAdmin && (
          <Link href={acPath.compare(`user:${person.id}`, `role:${person.role}`)} className={acButton.secondary} title={`Compare ${person.name} with the ${person.roleName} role`}>
            <ArrowLeftRight className="h-[18px] w-[18px]" aria-hidden />
            Compare
          </Link>
        )}
        {may.changeRole && (
          <button type="button" className={acButton.secondary} onClick={() => setChanging(true)} disabled={busy}>
            <UserCog className="h-[18px] w-[18px]" aria-hidden />
            Change role
          </button>
        )}
        {hasMore && (
          <Menu icon={MoreHorizontal} label={`More actions for ${person.name}`}>
            {(close) => (
              <>
                {may.viewAs && (
                  <MenuItem
                    disabled={busy}
                    onClick={() => {
                      close();
                      viewAs();
                    }}
                  >
                    View as user
                  </MenuItem>
                )}
                {may.reset && (
                  <MenuItem
                    disabled={busy}
                    onClick={() => {
                      close();
                      reset();
                    }}
                  >
                    Reset to role defaults
                  </MenuItem>
                )}
                {may.switchAccount && (may.viewAs || may.reset) && <MenuSeparator />}
                {may.switchAccount && (
                  <MenuItem
                    danger={person.active}
                    disabled={busy}
                    onClick={() => {
                      close();
                      switchAccount(!person.active);
                    }}
                  >
                    {person.active ? "Switch off account" : "Switch account on"}
                  </MenuItem>
                )}
              </>
            )}
          </Menu>
        )}
      </div>

      {changing && (
        <ChangeRoleDialog
          person={{ id: person.id, name: person.name, role: person.role, roleName: person.roleName, departmentId: person.departmentId, managerId: person.managerId }}
          roles={roles}
          onClose={() => setChanging(false)}
        />
      )}
    </Panel>
  );
}
