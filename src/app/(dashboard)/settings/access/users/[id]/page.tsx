import { redirect } from "next/navigation";
import { userPath } from "@/lib/staff/staff-paths";

/**
 * One person's access page is retired. It opened on their permissions, so a saved link — a
 * notification, a bookmark — with no tab, or one of the access tabs, lands on their Access Control
 * profile; a link to their sign-in or activity lands on Users, where the account lives. Each of those
 * checks `permissions.view` itself, as this page did.
 */
export default async function RetiredPersonAccessPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  redirect(userPath(id, sp.tab ?? "permissions"));
}
