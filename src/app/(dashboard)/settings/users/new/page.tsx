import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ADMIN_ROLE } from "@/lib/roles";
import { listRoles } from "@/lib/authz/role-registry";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { listDepartments } from "@/actions/department";
import { listUsers } from "@/actions/user";
import { isMultiBranch, listBranchChoices } from "@/lib/branches/identity";
import { linkedSignInEnabled } from "@/lib/platform/linked/groups";
import { currentTenant } from "@/lib/tenancy/resolve";
import { AddStaffForm } from "@/components/settings/staff/add-staff-form";
import { actorContext, rightsBeyond, startsEmployeesOnly } from "@/lib/authz/guards";

export const metadata = { title: "Add staff" };

/**
 * Add staff — the "+" on Users, as a page (the reference's "Add a staff account"), with room for its
 * two-column form.
 *
 * Open to whoever may create accounts (`users.manage`, the key `createUser` checks) — owner, 4 Nov 2026: an HR head
 * held "Create and edit users" with no way here, for this asked for `permissions.view` too, which is about reviewing
 * access, not about making an account. Without it, Users isn't theirs to open, so they come back to People, and are
 * offered only the roles `createUser` would let them give. The reporting manager is offered only
 * to somebody who may set one (`permissions.manage` — a reporting line decides whose records count as
 * the manager's team), and "Works at" only where there is more than one branch.
 *
 * Admin is never offered as a starting role, as before: making an admin is `users.assignRole`'s
 * business, done afterwards from the person's page by a super admin.
 */
export default async function AddStaffPage() {
  const sessionUser = await currentUser();
  const allowed = sessionUser !== null && (await can(sessionUser.id, "users.manage"));
  const seesUsers = sessionUser !== null && (await can(sessionUser.id, "permissions.view"));

  if (!sessionUser || !allowed) {
    return (
      <div className="max-w-md">
        <BackLink seesUsers={seesUsers} />
        <h1 className="mt-1 text-xl font-semibold text-text">Add a staff account</h1>
        <p className="mt-2 text-sm text-muted">You can&apos;t add staff. Somebody who can create accounts can do it for you.</p>
      </div>
    );
  }

  const [roles, departments, users, mayManage, multiBranch] = await Promise.all([
    listRoles(),
    listDepartments(),
    listUsers(),
    can(sessionUser.id, "permissions.manage"),
    isMultiBranch(),
  ]);
  const branches = multiBranch ? await listBranchChoices() : null;
  // The roles they may start somebody in: all they hold themselves (`createUser` refuses any other), so nobody picks one
  // to be told no. Never Admin here.
  const actor = await actorContext(sessionUser.id);
  const employeesOnly = await startsEmployeesOnly(actor);
  const checked = await Promise.all(
    roles.filter((r) => r.key !== ADMIN_ROLE && (!employeesOnly || r.key === "EMPLOYEE")).map(async (r) => ({ ...r, beyond: await rightsBeyond(actor, r.key) })),
  );
  const offered = checked.filter((r) => r.beyond.length === 0);
  const heldBack = checked.filter((r) => r.beyond.length > 0).map((r) => ({ name: r.name, rights: r.beyond }));
  // The one-step invite (set up here, and link it to the workspace they already use) only where linking
  // can happen: a workspace in the control plane, with linked sign-in not paused.
  const offerLinking = (await currentTenant()).source === "control" && (await linkedSignInEnabled());

  return (
    <div className="max-w-4xl animate-fade-rise">
      <BackLink seesUsers={seesUsers} />
      <h1 className="mt-1 text-xl font-semibold text-text">Add a staff account</h1>
      <p className="mt-1 text-sm text-muted">
        They&apos;ll get an email with a link to choose their own password, and can sign in as soon as they have.
      </p>

      <div className="mt-5">
        <AddStaffForm
          roles={offered.map((r) => ({ key: r.key, name: r.name }))}
          heldBack={heldBack}
          employeesOnly={employeesOnly}
          backTo={seesUsers ? null : "/people"}
          departments={departments.map((d) => ({ id: d.id, name: d.name }))}
          managers={mayManage ? users.filter((u) => u.active).map((u) => ({ id: u.id, name: u.name })) : null}
          branches={
            branches?.map((b) => ({ id: b.id, name: b.name, code: b.code, isHeadOffice: b.isHeadOffice, active: b.active })) ??
            null
          }
          offerLinking={offerLinking}
        />
      </div>
    </div>
  );
}

function BackLink({ seesUsers }: { seesUsers: boolean }) {
  return (
    <Link href={seesUsers ? "/settings/users" : "/people"} className="inline-flex items-center gap-1 text-sm text-muted hover:text-text">
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
      {seesUsers ? "Users" : "People"}
    </Link>
  );
}
