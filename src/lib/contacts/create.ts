import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { fillWebsitesFromEmail } from "@/lib/companies/website-from-email";
import { designationData } from "@/lib/contacts/designations";
import { customFieldsForCreate } from "@/lib/custom-fields/server";
import { customInput, fieldRuleRefusal } from "@/lib/field-rules/server";
import type { ContactInput } from "@/lib/validation/company";

/**
 * A new person at a company, written one way: the company page, the lead form and the API (`addContact`,
 * src/actions/company.ts) and the New ticket form (`addTicketContact`, src/actions/ticket.ts). Whether the person may
 * add one there is the caller's question; the workspace's own fields and its field rules are asked here.
 */
export async function createContactAt(userId: string, companyId: string, c: ContactInput): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  // The workspace's own fields (src/lib/custom-fields), the required ones answered.
  const custom = await customFieldsForCreate("CONTACT", userId, c.customFields, { checkRequired: true });
  if (!custom.ok) return { ok: false, error: custom.error };
  // The workspace's field rules (src/lib/field-rules).
  const ruled = await fieldRuleRefusal("CONTACT", { ...c, ...customInput(c.customFields).record });
  if (ruled) return { ok: false, error: ruled };

  const contact = await db.contact.create({
    data: {
      companyId,
      name: c.name.trim(),
      designation: c.designation,
      ...((await designationData(db, c)) ?? {}),
      email: c.email || null,
      phone: c.phone || null,
      linkedinUrl: c.linkedinUrl || null,
      isPrimary: c.isPrimary,
      receivesDocuments: c.receivesDocuments,
      createdByUserId: userId,
      ...custom.data,
    },
  });
  await recordAudit({ userId, action: "CREATE", entityType: "Contact", entityId: contact.id, entityLabel: contact.name });
  // A company without a website takes it from its people's work email (owner, 18 Nov 2026).
  await fillWebsitesFromEmail([companyId]);
  return { ok: true, id: contact.id };
}
