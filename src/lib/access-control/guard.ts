import { notFound } from "next/navigation";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";

/**
 * Who is looking at an Access Control screen — or a 404 for anybody without `permissions.view`.
 *
 * The area's layout asks the same question, but a layout isn't drawn again when somebody moves from
 * one of its pages to the next, and a page that leaned on it would answer whoever reached it another
 * way. So every page asks for itself, first, as the screens these replaced did.
 */
export async function requireAccessViewer() {
  const viewer = await currentUser();
  if (!viewer || !(await can(viewer.id, "permissions.view"))) notFound();
  return viewer;
}
