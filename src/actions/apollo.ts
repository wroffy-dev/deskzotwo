"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { mayAccess } from "@/lib/authz/access";
import { mayWorkWithContactsOf } from "@/lib/authz/contact-access";
import { recordAudit } from "@/lib/audit";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { toPlain } from "@/lib/serialize";
import { companyPath } from "@/lib/record-links";
import { addContact, type ActionResult } from "@/actions/company";
import type { ApolloCompany, ApolloPerson, ApolloSearchPerson } from "@/lib/apollo/client";
import {
  COMPANY_FIELDS,
  apolloSetup,
  applyCompanyLookup,
  latestCompanyLookup,
  lookUpCompany,
  lookUpContact,
  removeApolloKey,
  revealSearchPerson,
  saveApolloKey,
  searchCompanyPeople,
  type ApolloSetup,
  type CompanyField,
  type PersonLookup,
} from "@/lib/apollo/server";

/**
 * Apollo.io (owner, 14 Nov 2026 — src/lib/apollo). Companies are core, so no module check — as company-merge.ts. The key is the workspace's own, set by whoever changes settings.
 * Every lookup spends the workspace's Apollo credits, so it needs `companies.enrich` — and, as any change to a record,
 * the right to edit that company or its people.
 */

const NO_RIGHT = "Looking up needs the \"Enrich from Apollo or Lusha\" permission.";

// ─── Settings › Apollo ─────────────────────────────────────────────────────────────────────────────

export async function apolloSettings(): Promise<ActionResult<ApolloSetup>> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: "Only somebody who can change the workspace's settings can connect Apollo." };
  return { ok: true, data: toPlain(await apolloSetup()) };
}

export async function connectApollo(key: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: "Only somebody who can change the workspace's settings can connect Apollo." };
  const saved = await saveApolloKey(String(key ?? ""), user.id);
  if (!saved.ok) return saved;
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ApolloConnection", entityId: "default", entityLabel: "Apollo connected" });
  revalidatePath("/settings/apollo");
  return { ok: true, data: null };
}

export async function disconnectApollo(): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: "Only somebody who can change the workspace's settings can disconnect Apollo." };
  await removeApolloKey();
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "ApolloConnection", entityId: "default", entityLabel: "Apollo disconnected" });
  revalidatePath("/settings/apollo");
  return { ok: true, data: null };
}

// ─── A company's details ───────────────────────────────────────────────────────────────────────────

async function mayEnrichCompany(userId: string, companyId: string): Promise<string | null> {
  if (!(await can(userId, "companies.enrich"))) return NO_RIGHT;
  if (typeof companyId !== "string" || !companyId || !(await mayAccess(userId, "companies", "edit", companyId))) return "Company not found.";
  return null;
}

export type CompanyEnrichView = { lookupId: string; found: ApolloCompany; current: Record<CompanyField, string | null> };

/** Looks the company up in Apollo and shows what it would fill, beside what is on file. */
export async function enrichCompanyFromApollo(companyId: string): Promise<ActionResult<CompanyEnrichView>> {
  const user = await requireUser();
  const refused = await mayEnrichCompany(user.id, companyId);
  if (refused) return { ok: false, error: refused };
  const result = await lookUpCompany(companyId, user.id);
  if (!result.found) return { ok: false, error: result.error ?? "Apollo found nothing." };
  const company = await db.company.findUniqueOrThrow({ where: { id: companyId }, select: { website: true, linkedinUrl: true, employeeCount: true, industry: { select: { name: true } } } });
  return {
    ok: true,
    data: toPlain({
      lookupId: result.lookupId,
      found: result.found,
      current: { website: company.website, linkedinUrl: company.linkedinUrl, employeeCount: company.employeeCount === null ? null : String(company.employeeCount), industry: company.industry?.name ?? null },
    }),
  };
}

export async function applyApolloCompany(lookupId: string, fields: string[]): Promise<ActionResult<{ changed: string[] }>> {
  const user = await requireUser();
  const lookup = await db.enrichmentLookup.findUnique({ where: { id: String(lookupId ?? "") }, select: { companyId: true } });
  if (!lookup?.companyId) return { ok: false, error: "That lookup can't be applied." };
  const refused = await mayEnrichCompany(user.id, lookup.companyId);
  if (refused) return { ok: false, error: refused };
  const picked = (Array.isArray(fields) ? fields : []).filter((f): f is CompanyField => (COMPANY_FIELDS as readonly string[]).includes(f));
  const applied = await applyCompanyLookup(lookupId, picked, user.id);
  if (!applied.ok) return applied;
  if (applied.changed.length) {
    const company = await db.company.findUnique({ where: { id: lookup.companyId }, select: { name: true, companySeq: true } });
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Company", entityId: lookup.companyId, entityLabel: `${company?.name ?? "Company"} — ${applied.changed.join(", ")} filled from Apollo` });
    if (company) revalidatePath(companyPath(company.companySeq));
  }
  return { ok: true, data: { changed: applied.changed } };
}

/** The latest Apollo details of a company — social links, founded, revenue, description — for its page. */
export async function apolloCompanyCard(companyId: string): Promise<{ at: Date; found: ApolloCompany } | null> {
  const user = await requireUser();
  if (typeof companyId !== "string" || !(await mayAccess(user.id, "companies", "view", companyId))) return null;
  const latest = await latestCompanyLookup(companyId);
  return latest ? toPlain({ at: latest.at, found: latest.found }) : null;
}

// ─── A contact's email and mobile ──────────────────────────────────────────────────────────────────

export async function enrichContactFromApollo(contactId: string, mobile: boolean): Promise<ActionResult<PersonLookup>> {
  const user = await requireUser();
  if (!(await can(user.id, "companies.enrich"))) return { ok: false, error: NO_RIGHT };
  const contact = typeof contactId === "string" ? await db.contact.findUnique({ where: { id: contactId }, select: { companyId: true, name: true } }) : null;
  if (!contact || !(await mayWorkWithContactsOf(user.id, contact.companyId))) return { ok: false, error: "Contact not found." };
  const result = await lookUpContact(contactId, user.id, { mobile: mobile === true, origin: await tenantOrigin() });
  if (result.error && !result.found) return { ok: false, error: result.error };
  if (result.filled.length) {
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Contact", entityId: contactId, entityLabel: `${contact.name} — ${result.filled.join(", ")} filled from Apollo` });
  }
  const company = await db.company.findUnique({ where: { id: contact.companyId }, select: { companySeq: true } });
  if (company) revalidatePath(companyPath(company.companySeq));
  return { ok: true, data: toPlain(result) };
}

// ─── People at a company ───────────────────────────────────────────────────────────────────────────

export async function findPeopleInApollo(companyId: string, titles: string[]): Promise<ActionResult<{ people: ApolloSearchPerson[]; total: number }>> {
  const user = await requireUser();
  const refused = await mayEnrichCompany(user.id, companyId);
  if (refused) return { ok: false, error: refused };
  const result = await searchCompanyPeople(companyId, Array.isArray(titles) ? titles.map(String) : [], user.id);
  if (result.error) return { ok: false, error: result.error };
  return { ok: true, data: { people: result.people, total: result.total } };
}

/**
 * Adds a person the search found as a contact: Apollo is asked for them in full (a credit), and they are added through
 * `addContact` — its field rules, custom fields and access as for anyone typed in. Their mobile, asked for, follows.
 */
export async function addPersonFromApollo(companyId: string, apolloId: string, mobile: boolean): Promise<ActionResult<{ contactId: string; person: ApolloPerson; mobile: PersonLookup["mobile"] }>> {
  const user = await requireUser();
  const refused = await mayEnrichCompany(user.id, companyId);
  if (refused) return { ok: false, error: refused };
  if (typeof apolloId !== "string" || !/^[A-Za-z0-9]{6,64}$/.test(apolloId)) return { ok: false, error: "Pick somebody from the search." };
  const revealed = await revealSearchPerson(companyId, apolloId, user.id);
  if (!revealed.found) return { ok: false, error: revealed.error ?? "Apollo found nothing." };
  const p = revealed.found;
  const name = (p.name ?? [p.firstName, p.lastName].filter(Boolean).join(" ")).trim();
  if (!name) return { ok: false, error: "Apollo didn't give this person's name." };
  const added = await addContact(companyId, { name, designationName: (p.title ?? "").slice(0, 80), email: p.email ?? "", phone: "", linkedinUrl: p.linkedinUrl ?? "", isPrimary: false, receivesDocuments: false });
  if (!added.ok) return added;
  let mobileState: PersonLookup["mobile"] = "NONE";
  if (mobile) {
    const followed = await lookUpContact(added.data.id, user.id, { mobile: true, origin: await tenantOrigin() });
    mobileState = followed.mobile;
  }
  return { ok: true, data: toPlain({ contactId: added.data.id, person: p, mobile: mobileState }) };
}
