import { db } from "@/lib/db";
import { mayAddTo } from "@/lib/authz/access";
import { companyScope } from "@/lib/authz/company-scope";
import { contactScope } from "@/lib/authz/contact-access";
import { can } from "@/lib/authz/resolve";
import { contactMasker } from "@/lib/contacts/masking";
import { createContactAt } from "@/lib/contacts/create";
import { STILL_THERE } from "@/lib/contacts/left";
import type { ContactInput } from "@/lib/validation/company";

/**
 * A company's people on New ticket (owner, 25 Nov 2026: "support person can now search company but can't see the
 * contacts person added on that company? also to if no contact person added option to add one there only").
 *
 * Whoever may log a ticket on a company they see may say who it is for: names and designations only, whatever the
 * Contacts rule says — as a record that names a contact already does (src/lib/authz/contact-access.ts). Emails, phones
 * and the Contacts tab stay that rule's, and a name the field access masks stays masked. The same people may add
 * somebody who isn't there yet. Anybody else gets what the Contacts rule gives them, as before.
 */

export type TicketContact = { id: string; name: string; designation: string };
export type TicketContacts = { contacts: TicketContact[]; mayAdd: boolean };

/** Whether this person may log a ticket on this company — and sees it, which Support tickets at All alone doesn't ask. */
async function logsTicketsOn(userId: string, companyId: string): Promise<"yes" | "sees" | "no"> {
  const company = await db.company.findFirst({
    where: { id: companyId, AND: [await companyScope(userId)] },
    select: { ownerUserId: true, relationshipType: true },
  });
  if (!company) return "no";
  return (await can(userId, "tickets.create")) && (await mayAddTo(userId, "tickets", company)) ? "yes" : "sees";
}

export async function ticketContacts(userId: string, companyId: string): Promise<TicketContacts> {
  if (typeof companyId !== "string" || !companyId) return { contacts: [], mayAdd: false };
  const reach = await logsTicketsOn(userId, companyId);
  if (reach === "no") return { contacts: [], mayAdd: false };
  const rows = await db.contact.findMany({
    where: { AND: [{ companyId, ...STILL_THERE }, reach === "yes" ? {} : await contactScope(userId)] },
    orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
    select: { id: true, name: true, designation: true },
  });
  const people = await contactMasker(userId, "list", rows.map((r) => r.id));
  const contacts = people.active ? rows.map((r) => ({ ...r, name: people.present(r.id, "name", r.name) ?? "" })) : rows;
  return { contacts, mayAdd: reach === "yes" };
}

/**
 * Adds somebody to the company from New ticket. Never its primary, nor sent its documents: those are the account's
 * people to decide. Somebody of the same name or email is picked from the list instead of added twice.
 */
export async function addTicketContactAt(userId: string, companyId: string, input: ContactInput): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const reach = typeof companyId === "string" && companyId ? await logsTicketsOn(userId, companyId) : "no";
  if (reach === "no") return { ok: false, error: "Company not found." };
  if (reach === "sees") return { ok: false, error: "You can see this company, but your role can't add tickets to it, so it can't add a contact from here." };
  const name = input.name.trim();
  const already = await db.contact.findFirst({
    where: {
      companyId,
      ...STILL_THERE,
      OR: [{ name: { equals: name, mode: "insensitive" } }, ...(input.email ? [{ email: { equals: input.email, mode: "insensitive" as const } }] : [])],
    },
    select: { name: true },
  });
  if (already) {
    return {
      ok: false,
      error:
        already.name.trim().toLowerCase() === name.toLowerCase()
          ? "Somebody of that name is already in the list — pick them there."
          : "Somebody in the list already has that email — pick them there.",
    };
  }
  return createContactAt(userId, companyId, { ...input, isPrimary: false, receivesDocuments: false });
}
