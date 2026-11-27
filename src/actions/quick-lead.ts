"use server";

import { z } from "zod";
import { tooLong } from "@/lib/validation/text";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { STILL_THERE } from "@/lib/contacts/left";
import { companyNamedLike } from "@/lib/companies/by-name";
import { LEAD_SOURCE_VALUES } from "@/lib/leads/source";
import { leadRequirementInputSchema } from "@/lib/validation/lead";
import { addContact, createCompany } from "@/actions/company";
import { createLead } from "@/actions/lead";
import type { ActionResult } from "@/actions/company";

/**
 * Create › Quick lead (owner, 27 Oct 2026): a lead from five fields, for while the customer is on the phone. The
 * company is picked, or typed — an existing customer of that name is used, otherwise it is made as a new one; the
 * person is found at it by mobile or email, otherwise added; then the lead, through `createLead` and its rules
 * (who may, who it goes to, the workspace's required fields, one lead per request). Value, close date and the rest
 * are filled in on the lead afterwards.
 *
 * Sent twice — a retry after an answer that never arrived — it finds the company and the person it made the first
 * time, and `createLead` hands back the lead it made, by the request's token.
 */

const quickLeadSchema = z.object({
  companyId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  companyName: z.string().trim().max(200).optional().or(z.literal("")),
  contactName: z.string().trim().max(120).optional().or(z.literal("")),
  phone: z.string().trim().max(30).optional().or(z.literal("")),
  email: z.string().trim().max(200).email("That email doesn't look right.").optional().or(z.literal("")),
  title: z.string().trim().min(2, "Say what they need — a few words.").max(200),
  source: z.enum(LEAD_SOURCE_VALUES).default("OTHER"),
  requirements: z.array(leadRequirementInputSchema.pick({ itemId: true, quantity: true })).max(30).default([]),
  requestId: z.string().max(100).optional(),
});

export type QuickLeadInput = z.input<typeof quickLeadSchema>;

const digits = (text: string) => text.replace(/\D/g, "");

export async function quickCreateLead(input: unknown): Promise<ActionResult<{ id: string; leadSeq: number; companyName: string }>> {
  const user = await requireModuleUser("leads");
  const parsed = quickLeadSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;
  const name = data.contactName ?? "";
  const phone = data.phone ?? "";
  const email = (data.email ?? "").toLowerCase();
  if (!name && (phone || email)) return { ok: false, error: "Add the person's name, or clear their mobile and email." };

  // The company: the one picked, a customer of the typed name, or a new one with the person on it.
  let companyId = data.companyId || "";
  let companyName = "";
  let contactId: string | null = null;
  /**
   * Security audit, 11 Nov 2026 (SEC-66): a company this person can't open answers as one that isn't there — picked by
   * an id, it says nothing of whether the id exists; typed, its stored name never comes back and no lead goes on it.
   */
  const seen = async (id: string) => {
    const row = await db.company.findUnique({ where: { id }, select: { name: true, ownerUserId: true, relationshipType: true } });
    return row && (await canSeeCompany(user.id, { id, ownerUserId: row.ownerUserId, relationshipType: row.relationshipType })) ? row : null;
  };
  if (companyId) {
    const picked = await seen(companyId);
    if (!picked) return { ok: false, error: "That company isn't there any more — pick it again." };
    companyName = picked.name;
  } else {
    const typed = data.companyName ?? "";
    if (typed.length < 2) return { ok: false, error: "Pick the company, or type its name." };
    // The same name, or the same in another legal form — "Pvt Ltd" for "Private Limited" (src/lib/companies/by-name.ts).
    const same = await companyNamedLike(typed);
    // Company names are unique, so a name taken is a name taken; but whose it is, and its exact name, stay its own.
    if (same && !(await seen(same.id))) return { ok: false, error: "A company by that name is already on file, and it isn't one you can open — ask whoever looks after it to add the lead." };
    if (same) {
      companyId = same.id;
      companyName = same.name;
    } else {
      const made = await createCompany({ name: typed, contacts: name ? [{ name, phone, email, isPrimary: true }] : [] });
      if (!made.ok) return made;
      companyId = made.data.id;
      companyName = typed;
      contactId = made.data.contacts[0]?.id ?? null;
    }
  }

  // The person at it: the one with that mobile or email, or added.
  if (name && !contactId) {
    // Numbers are kept as typed ("+91 98765 43210"), so compared by their last ten digits here; one company's people are few.
    const last10 = digits(phone).slice(-10);
    const people = await db.contact.findMany({ where: { companyId, ...STILL_THERE }, select: { id: true, name: true, phone: true, email: true } });
    const match =
      last10.length >= 6 || email
        ? people.find((p) => (last10.length >= 6 && digits(p.phone ?? "").slice(-10) === last10) || (!!email && (p.email ?? "").toLowerCase() === email))
        : people.find((p) => p.name.trim().toLowerCase() === name.toLowerCase());
    if (match) contactId = match.id;
    else {
      const added = await addContact(companyId, { name, phone, email });
      if (!added.ok) return added;
      contactId = added.data.id;
    }
  }

  const lead = await createLead({
    companyId,
    contactId: contactId ?? "",
    title: data.title,
    source: data.source,
    requirements: data.requirements,
    requestId: data.requestId,
  });
  if (!lead.ok) return lead;
  return { ok: true, data: { ...lead.data, companyName } };
}
