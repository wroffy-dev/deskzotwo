"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { bulkUpdateUsers, updateUserAssignment, type BulkUserResult } from "@/actions/user";
import { Dialog } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { acButton, acInput } from "@/components/access-control/ui";
import { Field } from "@/components/access-control/employees/shared";
import { cn } from "@/lib/utils";

export type RoleChoice = { key: string; name: string };

/** Who a role change is for: their current role, and the department and manager the action is sent unchanged. */
export type RoleSubject = { id: string; name: string; role: string; roleName: string; departmentId: string | null; managerId: string | null };

/**
 * "Change role" for one person, through `updateUserAssignment` — the action Users always used, so its
 * rules hold: `users.assignRole`, never your own, never into a switched-off role, and never into a role
 * that holds more than the person choosing does. Their department and manager go back as they stand.
 *
 * The design asks for a reason here; a role change stores none (the permission history records who
 * moved whom, from what to what), so no field is drawn for one.
 */
export function ChangeRoleDialog({ person, roles, onClose }: { person: RoleSubject; roles: RoleChoice[]; onClose: () => void }) {
  const router = useRouter();
  const [role, setRole] = useState(person.role);
  const [pending, start] = useTransition();
  const listed = roles.some((r) => r.key === person.role);

  const save = () =>
    start(async () => {
      const result = await updateUserAssignment({ id: person.id, role, departmentId: person.departmentId, managerId: person.managerId });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(`${person.name} is now ${roles.find((r) => r.key === role)?.name ?? role}.`);
      router.refresh();
      onClose();
    });

  return (
    <Dialog open onClose={() => !pending && onClose()} title={`Change role · ${person.name}`}>
      <div className="flex flex-col gap-3.5 text-[13px]">
        <p className="leading-[1.5] text-muted">Current role: {person.roleName}. Exceptions made for {person.name} alone are kept.</p>
        <Field label="New role" htmlFor="change-role" hint="A role decides what they can do. Nobody can be moved into a role that holds more than you hold yourself.">
          <select id="change-role" value={role} onChange={(e) => setRole(e.target.value)} className={cn(acInput, "w-full")}>
            {!listed && (
              <option value={person.role} disabled>
                {person.roleName} (current)
              </option>
            )}
            {roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <button type="button" className={acButton.secondary} onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button type="button" className={acButton.primary} onClick={save} disabled={pending || role === person.role}>
            {pending ? "Changing…" : "Change role"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * "Assign role to N": the Users bulk bar's role change, through `bulkUpdateUsers`. Admins only, and each
 * person still goes through the single change's rules one by one — whoever it refuses is handed back to
 * the list with the reason, and the rest go ahead.
 */
export function AssignRoleDialog({
  ids,
  roles,
  onClose,
  onDone,
}: {
  ids: string[];
  roles: RoleChoice[];
  onClose: () => void;
  onDone: (result: BulkUserResult, roleName: string) => void;
}) {
  const router = useRouter();
  const [role, setRole] = useState("");
  const [pending, start] = useTransition();
  const people = ids.length === 1 ? "1 employee" : `${ids.length} employees`;

  const save = () =>
    start(async () => {
      const result = await bulkUpdateUsers({ ids, op: "role", value: role });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const { done, refused, unchanged } = result.data;
      const roleName = roles.find((r) => r.key === role)?.name ?? role;
      const parts = [`${done.length} assigned to ${roleName}`];
      if (unchanged.length) parts.push(`${unchanged.length} already so`);
      if (refused.length) parts.push(`${refused.length} refused`);
      (refused.length && !done.length ? toast.error : toast.success)(parts.join(" · "));
      onDone(result.data, roleName);
      if (done.length) router.refresh();
      onClose();
    });

  return (
    <Dialog open onClose={() => !pending && onClose()} title={`Assign role to ${people}`}>
      <div className="flex flex-col gap-3.5 text-[13px]">
        <Field label="Role" htmlFor="assign-role" hint="Each person is checked as a single change would be. Anybody refused is listed with the reason; the rest go ahead. Their own exceptions are kept.">
          <select id="assign-role" value={role} onChange={(e) => setRole(e.target.value)} className={cn(acInput, "w-full")}>
            <option value="">Choose a role…</option>
            {roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <button type="button" className={acButton.secondary} onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button type="button" className={acButton.primary} onClick={save} disabled={pending || role === ""}>
            {pending ? "Assigning…" : "Assign"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
