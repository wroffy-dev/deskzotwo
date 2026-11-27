"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { requireUser } from "@/lib/session";
import { companyPath } from "@/lib/record-links";
import { canViewContacts, mayWorkWithContactsOf, NO_CONTACTS } from "@/lib/authz/contact-access";
import { confirmContact } from "@/lib/contacts/unconfirmed";
import type { ActionResult } from "@/actions/company";

/**
 * Confirms a contact a visitor added from the website (security audit round two, 13 Nov 2026 — R2-14):
 * from now on they can be picked by a pay link or a reminder like anyone else. Whoever may edit the
 * company's contacts may do it, as `updateContact` decides it; out of scope and missing answer the same.
 */
export async function confirmWebsiteContact(contactId: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  const id = String(contactId ?? "");
  const contact = await db.contact.findUnique({ where: { id }, select: { id: true, name: true, companyId: true, company: { select: { name: true, companySeq: true } } } });
  if (!contact || !(await mayWorkWithContactsOf(user.id, contact.companyId))) {
    return { ok: false, error: (await canViewContacts(user.id)) ? "Contact not found." : NO_CONTACTS };
  }
  const confirmed = await confirmContact(id);
  if (!confirmed) return { ok: true, data: null };
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Contact", entityId: id, entityLabel: `${contact.name} confirmed as a contact of ${contact.company.name}` });
  revalidatePath(companyPath(contact.company.companySeq));
  return { ok: true, data: null };
}
