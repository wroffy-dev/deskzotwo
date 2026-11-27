import { redirect } from "next/navigation";
import { acPath } from "@/lib/access-control/nav";

/** The permission matrix moved into Settings › Access Control, where it opens one role (or person) at a time. */
export default function RetiredPermissionMatrixPage() {
  redirect(acPath.modules());
}
