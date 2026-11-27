import { notFound } from "next/navigation";
import { currentUser, viewAsContext } from "@/lib/session";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { viewerOf, type Viewer } from "@/lib/desks/server";

/**
 * Who a help desk page (src/lib/desks) is drawn for, once it has asked after the module: the person signed in, as
 * themselves — or what to show instead.
 * Viewing as somebody shows none of it: their requests are theirs and the desk's, and an admin isn't either by looking.
 */
export async function helpDeskViewer(): Promise<{ viewer: Viewer } | { instead: React.ReactNode }> {
  if (await viewAsContext()) {
    return {
      instead: (
        <div className="max-w-md">
          <h1 className="text-xl font-semibold text-text">Help desk</h1>
          <p className="mt-2 text-sm text-muted">Help desk requests aren&apos;t shown while you&apos;re viewing as somebody. Go back to your own account to see yours.</p>
        </div>
      ),
    };
  }
  try {
    await db.deskRequestType.findFirst({ select: { approval: true } });
  } catch (err) {
    // This workspace hasn't the tables yet.
    if (!notMigratedYet(err)) throw err;
    notFound();
  }
  const user = await currentUser();
  const viewer = user ? await viewerOf(user.id) : null;
  if (!viewer) notFound();
  return { viewer };
}
