"use server";

import { randomUUID } from "node:crypto";
import { refuseWhileViewingAs } from "@/lib/session";
import { requireModuleAccess } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { isModuleEnabled } from "@/actions/module";
import { createCompany, type ActionResult } from "@/actions/company";
import { createLead } from "@/actions/lead";
import { apolloSetup } from "@/lib/apollo/server";
import { companyNamedLike } from "@/lib/companies/by-name";
import { leadPath } from "@/lib/record-links";
import { formatLeadId } from "@/lib/order-id";
import { cleanFilters, designationFromTitle, startingFilters, type LookalikeFilters, type LookalikeProfile } from "@/lib/prospects/profile";
import { lookalikeProfile, revealProspect, searchLookalikes, type ProspectRow } from "@/lib/prospects/server";

/**
 * Ved's lookalikes (owner, 22 Nov 2026 — src/lib/prospects): Leads › Find lookalikes. Takes Leads, "Create leads" and
 * "Enrich from Apollo or Lusha" (it spends the workspace's Apollo credits when somebody adds people), with Apollo
 * connected. Searching is free; each person added is a credit, a company, a contact and a lead — made by the same
 * actions as by hand, so every check those make is made here too. Never while viewing as somebody.
 */

const ADD_AT_ONCE = 10;

async function mayUse(userId: string): Promise<string | null> {
  if (!(await isModuleEnabled("leads"))) return "You don't have access to Leads.";
  if (!(await can(userId, "leads.create"))) return "Finding prospects takes the right to create leads.";
  if (!(await can(userId, "companies.enrich"))) return "Finding prospects takes the “Enrich from Apollo or Lusha” permission — it spends Apollo credits.";
  return null;
}

export type LookalikesPage = { connected: boolean; profile: LookalikeProfile; start: LookalikeFilters };

/** The page's start: what the best customers look like, and the filters offered first. Null when this person can't use it. */
export async function getLookalikes(): Promise<LookalikesPage | null> {
  const user = await requireModuleAccess("leads");
  if (await mayUse(user.id)) return null;
  const [setup, profile] = await Promise.all([apolloSetup(), lookalikeProfile()]);
  return { connected: setup.connected, profile, start: startingFilters(profile) };
}

export async function findLookalikes(input: { filters: unknown; page?: number }): Promise<ActionResult<{ rows: ProspectRow[]; total: number }>> {
  const user = await requireModuleAccess("leads");
  const no = await mayUse(user.id);
  if (no) return { ok: false, error: no };
  // The seeds are read here, never taken from the browser: Apollo ids of this workspace's own customers.
  const profile = await lookalikeProfile();
  const found = await searchLookalikes(user.id, cleanFilters(input?.filters), Number(input?.page) || 1, profile.seeds);
  if (found.error) return { ok: false, error: found.error };
  return { ok: true, data: { rows: found.rows, total: found.total } };
}

export type AddedProspect = { name: string; company: string; href: string };

/**
 * The people picked, added: each revealed by Apollo (a credit), then a company, its contact and a lead for this person —
 * unless the company is in Deskzo already (checked before any credit is spent) or the person is. At most ten at a time.
 */
export async function addLookalikes(picks: { apolloId: string; organizationName?: string | null }[]): Promise<ActionResult<{ added: AddedProspect[]; skipped: { name: string; why: string }[] }>> {
  const user = await requireModuleAccess("leads");
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const no = await mayUse(user.id);
  if (no) return { ok: false, error: no };
  const list = (Array.isArray(picks) ? picks : [])
    .map((p) => ({ apolloId: String(p?.apolloId ?? "").trim(), organizationName: typeof p?.organizationName === "string" ? p.organizationName.trim().slice(0, 200) : null }))
    .filter((p) => /^[A-Za-z0-9]{8,40}$/.test(p.apolloId));
  if (!list.length) return { ok: false, error: "Pick the people to add first." };
  if (list.length > ADD_AT_ONCE) return { ok: false, error: `At most ${ADD_AT_ONCE} at a time.` };

  const added: AddedProspect[] = [];
  const skipped: { name: string; why: string }[] = [];
  for (const pick of list) {
    const label = pick.organizationName ?? "Somebody";
    if (pick.organizationName) {
      const there = await companyNamedLike(pick.organizationName);
      if (there) {
        skipped.push({ name: label, why: `${there.name} is in Deskzo already` });
        continue;
      }
    }
    const revealed = await revealProspect(user.id, pick.apolloId);
    const p = revealed.person;
    if (!p) {
      skipped.push({ name: label, why: revealed.error ?? "Apollo found nothing" });
      // Out of credits or a refused key: the rest would fail the same way.
      if (revealed.error && /credit|key|refused|slow down/i.test(revealed.error)) break;
      continue;
    }
    const name = (p.name ?? [p.firstName, p.lastName].filter(Boolean).join(" ")).trim();
    const orgName = p.organization?.name ?? pick.organizationName;
    if (!name || !orgName) {
      skipped.push({ name: name || label, why: "Apollo didn't give their name or company" });
      continue;
    }
    if (p.email && (await db.contact.findFirst({ where: { email: p.email.toLowerCase() }, select: { id: true } }))) {
      skipped.push({ name, why: "They're a contact in Deskzo already" });
      continue;
    }
    const there = await companyNamedLike(orgName);
    if (there) {
      skipped.push({ name, why: `${there.name} is in Deskzo already` });
      continue;
    }
    const website = p.organization?.website ?? (p.organization?.domain ? `https://${p.organization.domain}` : "");
    const company = await createCompany({
      name: orgName,
      website,
      linkedinUrl: p.organization?.linkedinUrl ?? "",
      contacts: [{ name, designation: designationFromTitle(p.title), designationName: (p.title ?? "").slice(0, 80), email: p.email ?? "", phone: "", linkedinUrl: p.linkedinUrl ?? "", isPrimary: true, receivesDocuments: false }],
    });
    if (!company.ok) {
      skipped.push({ name, why: company.error });
      continue;
    }
    const lead = await createLead({
      companyId: company.data.id,
      contactId: company.data.contacts[0]?.id ?? "",
      title: `${orgName} — like your best customers`.slice(0, 200),
      ownerUserId: user.id,
      source: "OTHER",
      sourceDetail: "Ved's lookalikes — found in Apollo, like your best customers",
      requestId: `lookalike-${pick.apolloId}-${randomUUID().slice(0, 8)}`,
    });
    if (!lead.ok) {
      skipped.push({ name, why: `The company was added, but not the lead: ${lead.error}` });
      continue;
    }
    added.push({ name, company: orgName, href: leadPath(lead.data.leadSeq) });
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "Lead", entityId: lead.data.id, entityLabel: `${formatLeadId(lead.data.leadSeq)} — ${name} at ${orgName}, found by Ved's lookalikes (Apollo)` });
  }
  return { ok: true, data: { added, skipped } };
}
