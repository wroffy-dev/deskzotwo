import { requireAccessViewer } from "@/lib/access-control/guard";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { AccessControlShell } from "@/components/access-control/shell";

/**
 * Settings › Access Control: one area for who can do what — roles, the module matrix, field and
 * document permissions, each person's exceptions, record reach, masking and its daily limit, and the
 * log of every change.
 *
 * `permissions.view` opens the area; each screen and every action checks again for what it does.
 * The unmasking log is the super admin's alone (src/actions/unmask-log.ts), so its link is drawn for
 * nobody else — a link whose page will refuse you is worse than no link.
 */
export default async function AccessControlLayout({ children }: { children: React.ReactNode }) {
  const viewer = await requireAccessViewer();
  const superAdmin = await actingAsSuperAdmin(viewer.id);
  return <AccessControlShell hidden={superAdmin ? [] : ["unmasking"]}>{children}</AccessControlShell>;
}
