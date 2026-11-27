import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { mayAccess } from "@/lib/authz/access";
import { isModuleEnabled } from "@/actions/module";
import { fieldsFor, valuesFor } from "@/lib/custom-fields/server";
import { fileRef } from "@/lib/custom-fields/rules";
import { attachmentHeader, readFieldFile } from "@/lib/custom-fields/secure";

/**
 * A custom field's file, from the order that holds it (owner, 29 Oct 2026): `?order=<id>`. For whoever may see that
 * order and that field; a file the order doesn't name, or an order on an account they can't see, answers as a
 * made-up id does.
 *
 * "May see that order" is the order's own level as well as its account (owner, 2 Nov 2026 — "Phase 1 security
 * fixes", audit M-6): `mayAccess("orders", "view")`, the question the order's page asks. The account alone used to
 * decide, so a role whose Orders level is narrower than its Companies level downloaded the certificates of orders
 * its order page answers as not found.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const orderId = new URL(request.url).searchParams.get("order") ?? "";
  const missing = () => new Response("Not found", { status: 404 });
  const user = await currentUser();
  if (!user || !orderId || !(await isModuleEnabled("orders"))) return missing();
  const order = await db.companyProduct.findUnique({ where: { id: orderId }, select: { id: true, company: { select: { id: true, ownerUserId: true, relationshipType: true } } } });
  if (!order || !(await canSeeCompany(user.id, order.company))) return missing();
  if (!(await mayAccess(user.id, "orders", "view", order.id))) return missing();
  const [values, { visible }] = await Promise.all([valuesFor("ORDER", order.id), fieldsFor("ORDER", user.id)]);
  const named = visible.some((d) => d.type === "FILE" && fileRef(values[d.key])?.id === id);
  if (!named) return missing();
  const file = await readFieldFile(id);
  if (!file) return missing();
  return new Response(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": attachmentHeader(file.name, file.contentType === "application/pdf"),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
