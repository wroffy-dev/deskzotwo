import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { contactAccess } from "@/lib/authz/access";
import { resolveFieldPolicies } from "@/lib/authz/fields";
import { whatsappHref } from "@/components/ui/outbound-link";

/**
 * WhatsApp for a contact whose number is masked for this person (owner, 3 Nov 2026 — src/lib/contacts/masking.ts):
 * the server knows the number and sends the browser on to WhatsApp with it, so the screen never lists it. WhatsApp
 * itself shows the number it opens, which nothing here can change — masking keeps the number off Deskzo's lists and
 * exports, not out of the conversation being started. Only a contact this person reaches, whose phone they may read
 * (masked is fine; restricted outright isn't), and never a reseller's end customer. Under /api, so outside the proxy's
 * gate; `currentUser` applies it instead.
 */

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return new NextResponse("Not found", { status: 404 });
  const { id } = await params;
  const contact = await db.contact.findFirst({ where: { AND: [{ id: String(id) }, await contactAccess(user.id, "view")] }, select: { phone: true, company: { select: { managedByResellerId: true } } } });
  if (!contact?.phone || contact.company.managedByResellerId) return new NextResponse("Not found", { status: 404 });
  const policy = (await resolveFieldPolicies(user.id, "contacts")).fields.get("phone")?.policy;
  if (!policy?.view) return new NextResponse("Not found", { status: 404 });
  return NextResponse.redirect(whatsappHref(contact.phone), { status: 302, headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer" } });
}
