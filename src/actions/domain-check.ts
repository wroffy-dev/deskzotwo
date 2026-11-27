"use server";

import { requireModuleUser } from "@/lib/modules-access";
import { mayAccess } from "@/lib/authz/access";
import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
import { hasEffectivePermission } from "@/actions/permission";
import { cleanDomain, domainsFrom, liveDomainReport, type LiveDomainReport } from "@/lib/domain-intel/live-check";
import { companyMasker } from "@/lib/companies/masking";
import { contactMasker } from "@/lib/contacts/masking";
import type { ActionResult } from "@/actions/company";

/**
 * Domain intel on a ticket (owner, 2 Nov 2026 — src/lib/domain-intel/live-check.ts): for whoever may open the ticket,
 * any domain looked up live — the customer's, or one written in the ticket. Nothing is stored. Twenty a person in ten
 * minutes, so a button held down doesn't hammer RDAP and the customer's site.
 */

const WINDOW_MS = 10 * 60_000;
const PER_WINDOW = 20;
const recent = new Map<string, number[]>();

async function mayOpen(ticketId: string) {
  const user = await requireModuleUser("helpdesk");
  if (!(await hasEffectivePermission(user.id, "tickets.view"))) return null;
  if (!(await mayAccess(user.id, "tickets", "view", String(ticketId ?? "")))) return null;
  return user;
}

/**
 * The domains the ticket points at, likeliest first — what the panel offers before anything is typed.
 *
 * The company's website and the contact's address only where this person sees them in the clear (owner, 5 Nov 2026 —
 * Phase 3 masking fixes, audit H.4.3): a domain offered here is the website or the address's own domain, so a masked
 * one (src/lib/companies/masking.ts, src/lib/contacts/masking.ts — a list's answers, as a ticket is neither's page) is
 * left out rather than spelt out. What the ticket's own words say is offered as before; they are on the ticket.
 */
export async function ticketDomains(ticketId: string): Promise<string[]> {
  const user = await mayOpen(ticketId);
  if (!user) return [];
  const t = await db.ticket.findUnique({
    where: { id: ticketId },
    select: { title: true, description: true, company: { select: { website: true } }, contact: { select: { id: true, email: true } }, comments: { select: { body: true }, orderBy: { createdAt: "desc" }, take: 30 } },
  });
  if (!t) return [];
  const [companies, people] = await Promise.all([companyMasker(user.id, "list"), contactMasker(user.id, "list", t.contact ? [t.contact.id] : [])]);
  const website = t.company.website && companies.present("website", t.company.website) === t.company.website ? t.company.website : null;
  const email = t.contact?.email && people.present(t.contact.id, "email", t.contact.email) === t.contact.email ? t.contact.email : null;
  return domainsFrom({ website, emails: [email], text: [t.title, t.description ?? "", ...t.comments.map((c) => c.body)] });
}

export async function checkTicketDomain(input: { ticketId: string; domain: string }): Promise<ActionResult<LiveDomainReport>> {
  const user = await mayOpen(input?.ticketId);
  if (!user) return { ok: false, error: "That ticket isn't there any more." };
  const domain = cleanDomain(input?.domain);
  if (!domain) return { ok: false, error: "Type a domain — goignis.com — or an email address on it." };
  const now = Date.now();
  const mine = (recent.get(user.id) ?? []).filter((t) => now - t < WINDOW_MS);
  if (mine.length >= PER_WINDOW) return { ok: false, error: "That's a lot of lookups in ten minutes — wait a few minutes and try again." };
  recent.set(user.id, [...mine, now]);
  return { ok: true, data: toPlain(await liveDomainReport(domain)) as unknown as LiveDomainReport };
}
