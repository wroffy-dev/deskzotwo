import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { exportFile } from "@/lib/tally/server";

/**
 * An export's file for Tally (src/lib/tally): `masters` (import first) or `vouchers`. Whoever may export finance data, in a
 * workspace with Books; anybody else is told there's nothing here. Under /api, so outside the proxy's gate — `currentUser`
 * applies it instead.
 */

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
  const user = await currentUser();
  const { id, file } = await params;
  if (!user || (file !== "masters" && file !== "vouchers") || !(await moduleAvailableForTenant("accounting")) || !(await can(user.id, "data.exportFinance"))) return new Response("Not found", { status: 404 });
  const got = await exportFile(id, file);
  if (!got) return new Response("Not found", { status: 404 });
  return new Response(got.xml, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "content-disposition": `attachment; filename="${got.name}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
