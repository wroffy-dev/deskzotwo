"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { mayAccess } from "@/lib/authz/access";
import { mayWorkWithContactsOf } from "@/lib/authz/contact-access";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { companyPath } from "@/lib/record-links";
import { addContact, type ActionResult } from "@/actions/company";
import type { ApolloPerson, ApolloSearchPerson } from "@/lib/apollo/client";
import type { CompanyEnrichView } from "@/actions/apollo";
import type { PersonLookup } from "@/lib/apollo/server";
import { fillContactFromLusha, lushaLookUpCompany, lushaLookUpContact, lushaRevealPerson, lushaSearchPeople, lushaSetup, removeLushaKey, saveLushaKey, type LushaSetup } from "@/lib/lusha/server";

/**
 * Lusha (owner, 14 Nov 2026 — src/lib/lusha), beside Apollo (src/actions/apollo.ts) and under the same rules: the key is
 * the workspace's own, set by whoever changes settings; every lookup spends its credits, so it needs `companies.enrich`
 * and the right to edit that company or its people. Companies are core, so there's no module check.
 */

const NO_RIGHT = "Looking up needs the \"Enrich from Apollo or Lusha\" permission.";
const SETTINGS_ONLY = "Only somebody who can change the workspace's settings can connect Lusha.";

export async function lushaSettings(): Promise<ActionResult<LushaSetup>> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: SETTINGS_ONLY };
  return { ok: true, data: toPlain(await lushaSetup()) };
}

export async function connectLusha(key: string): Promise<ActionResult<{ creditsLeft: number | null }>> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: SETTINGS_ONLY };
  const saved = await saveLushaKey(String(key ?? ""), user.id);
  if (!saved.ok) return saved;
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "EnrichmentConnection", entityId: "LUSHA", entityLabel: "Lusha connected" });
  revalidatePath("/settings/lusha");
  return { ok: true, data: { creditsLeft: saved.creditsLeft } };
}

export async function disconnectLusha(): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: SETTINGS_ONLY };
  await removeLushaKey();
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "EnrichmentConnection", entityId: "LUSHA", entityLabel: "Lusha disconnected" });
  revalidatePath("/settings/lusha");
  return { ok: true, data: null };
}

async function mayEnrichCompany(userId: string, companyId: string): Promise<string | null> {
  if (!(await can(userId, "companies.enrich"))) return NO_RIGHT;
  if (typeof companyId !== "string" || !companyId || !(await mayAccess(userId, "companies", "edit", companyId))) return "Company not found.";
  return null;
}

/** The company in Lusha, as a preview beside what is on file — applied with applyApolloCompany, which reads either's. */
export async function enrichCompanyFromLusha(companyId: string): Promise<ActionResult<CompanyEnrichView>> {
  const user = await requireUser();
  const refused = await mayEnrichCompany(user.id, companyId);
  if (refused) return { ok: false, error: refused };
  const result = await lushaLookUpCompany(companyId, user.id);
  if (!result.found) return { ok: false, error: result.error ?? "Lusha found nothing." };
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

export async function enrichContactFromLusha(contactId: string, mobile: boolean): Promise<ActionResult<PersonLookup & { doNotCall: boolean }>> {
  const user = await requireUser();
  if (!(await can(user.id, "companies.enrich"))) return { ok: false, error: NO_RIGHT };
  const contact = typeof contactId === "string" ? await db.contact.findUnique({ where: { id: contactId }, select: { companyId: true, name: true } }) : null;
  if (!contact || !(await mayWorkWithContactsOf(user.id, contact.companyId))) return { ok: false, error: "Contact not found." };
  const result = await lushaLookUpContact(contactId, user.id, { mobile: mobile === true });
  if (result.error && !result.found) return { ok: false, error: result.error };
  if (result.filled.length) await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Contact", entityId: contactId, entityLabel: `${contact.name} — ${result.filled.join(", ")} filled from Lusha` });
  const company = await db.company.findUnique({ where: { id: contact.companyId }, select: { companySeq: true } });
  if (company) revalidatePath(companyPath(company.companySeq));
  return { ok: true, data: toPlain(result) };
}

export async function findPeopleInLusha(companyId: string, titles: string[]): Promise<ActionResult<{ people: ApolloSearchPerson[]; total: number }>> {
  const user = await requireUser();
  const refused = await mayEnrichCompany(user.id, companyId);
  if (refused) return { ok: false, error: refused };
  const result = await lushaSearchPeople(companyId, Array.isArray(titles) ? titles.map(String) : [], user.id);
  if (result.error) return { ok: false, error: result.error };
  return { ok: true, data: { people: result.people, total: result.total } };
}

/** Adds somebody Lusha's search found: revealed by id (credits), added through addContact, their phone too if asked. */
export async function addPersonFromLusha(companyId: string, lushaId: string, mobile: boolean): Promise<ActionResult<{ contactId: string; person: ApolloPerson; mobile: PersonLookup["mobile"] }>> {
  const user = await requireUser();
  const refused = await mayEnrichCompany(user.id, companyId);
  if (refused) return { ok: false, error: refused };
  if (typeof lushaId !== "string" || !/^[A-Za-z0-9_-]{3,64}$/.test(lushaId)) return { ok: false, error: "Pick somebody from the search." };
  const revealed = await lushaRevealPerson(companyId, lushaId, user.id, { mobile: mobile === true });
  if (!revealed.found) return { ok: false, error: revealed.error ?? "Lusha found nothing." };
  const p = revealed.found;
  const name = (p.name ?? [p.firstName, p.lastName].filter(Boolean).join(" ")).trim();
  if (!name) return { ok: false, error: "Lusha didn't give this person's name." };
  const added = await addContact(companyId, { name, designationName: (p.title ?? "").slice(0, 80), email: p.email ?? "", phone: "", linkedinUrl: p.linkedinUrl ?? "", isPrimary: false, receivesDocuments: false });
  if (!added.ok) return added;
  const done = await fillContactFromLusha(added.data.id, p, mobile === true);
  const { phonesWithDnc: _dnc, ...person } = p;
  void _dnc;
  return { ok: true, data: toPlain({ contactId: added.data.id, person, mobile: done.mobile }) };
}
