import { notFound } from "next/navigation";
import { listAssignableUsers, listCompanyOptions } from "@/actions/company";
import { hasEffectivePermission } from "@/actions/permission";
import { requireUser } from "@/lib/session";
import { listItemOptions } from "@/actions/item";
import { listIndustries } from "@/actions/industry";
import { isModuleEnabled } from "@/actions/module";
import { NewLeadForm } from "@/components/leads/new-lead-form";
import { formSetup } from "@/lib/custom-fields/server";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { activePipelines } from "@/lib/pipeline/server";
import { getWording } from "@/lib/terms/server";
import { slot } from "@/lib/terms/dictionary";
import { db } from "@/lib/db";
import { leadPrefillFromElsewhere } from "@/lib/customers/elsewhere";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { CATEGORY_SELECT } from "@/lib/customers/categories";
import { isCustomerSide } from "@/lib/companies/roles";

/**
 * How many customers the page sends with the form (owner, 30 Oct 2026: the New lead form opened slowly — it sent
 * every customer, about twelve thousand, with every contact). Asked for one row more: when that row comes back the
 * list is incomplete, and the picker searches the server instead of filtering what it was given. The contacts come
 * for the company picked, not for all of them (src/actions/company-options.ts).
 */
const COMPANIES_SENT = 300;

/**
 * The company the URL names (`?companyId=`, from a company's page), as the picker shows it — or null. Kept in the
 * list wherever it falls in the alphabet, so the picker can name it. Only a company the picker itself would offer is
 * taken — in scope, a customer, not disqualified, not a reseller's end customer — as on the order form
 * (src/app/(dashboard)/orders/new/page.tsx); any other id opens the form with nothing chosen.
 */
async function prefillFor(userId: string, companyId: unknown) {
  // A repeated query parameter arrives as an array; that is no id.
  if (typeof companyId !== "string" || !companyId) return null;
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: {
      id: true,
      name: true,
      relationshipType: true,
      customerCategory: { select: CATEGORY_SELECT },
      ownerUserId: true,
      stage: true,
      managedByResellerId: true,
    },
  });
  if (!company || !(await isCustomerSide(company))) return null;
  if (company.stage === "DISQUALIFIED" || company.managedByResellerId !== null) return null;
  if (!(await canSeeCompany(userId, company))) return null;
  const { id, name, relationshipType, customerCategory } = company;
  return { id, name, relationshipType, customerCategory };
}

export default async function NewLeadPage({
  searchParams,
}: {
  /** `phone`: made from a call by a number on nobody, from Calls › Business line (src/lib/telephony). */
  /** `elsewhere`: a customer's "Installed elsewhere" entry, to win at its renewal (src/lib/customers/elsewhere.ts). */
  searchParams: Promise<{ companyId?: string; pipeline?: string; phone?: string; elsewhere?: string }>;
}) {
  if (!(await isModuleEnabled("leads"))) return <ModuleDisabledNotice moduleKey="leads" />;
  const [itemsEnabled, user] = await Promise.all([isModuleEnabled("items"), requireUser()]);
  const [canViewLeads, canAddContact] = await Promise.all([
    hasEffectivePermission(user.id, "leads.view"),
    hasEffectivePermission(user.id, "contacts.view"),
  ]);
  if (!canViewLeads) notFound();
  // Seeing leads isn't opening one (owner, 1 Nov 2026): refused like any page this person can't use.
  if (!(await hasEffectivePermission(user.id, "leads.create"))) notFound();
  const { companyId, pipeline, phone, elsewhere } = await searchParams;
  const [companyRows, prefill, fromElsewhere, items, industries, canAssign, people, customFields, pipelines] = await Promise.all([
    // A lead is with a customer: a client or a reseller, or a vendor that's also a customer — never a vendor alone (owner, 19 Oct 2026).
    listCompanyOptions({ side: "customer", withContacts: false, take: COMPANIES_SENT + 1 }),
    prefillFor(user.id, companyId),
    leadPrefillFromElsewhere(user.id, companyId, elsewhere),
    itemsEnabled ? listItemOptions() : Promise.resolve([]),
    listIndustries(),
    // Either permission that assigns may choose the owner — matching `resolveOwner` in actions/lead.ts.
    Promise.all([hasEffectivePermission(user.id, "leads.assign"), hasEffectivePermission(user.id, "accounts.reassign")]).then(
      ([assign, reassign]) => assign || reassign,
    ),
    listAssignableUsers(),
    // The workspace's own lead fields (src/lib/custom-fields).
    formSetup("LEAD", user.id),
    // The team pipelines a lead may start in (src/lib/pipeline) — the board's, when it came from one.
    activePipelines(),
  ]);
  const companySearch = companyRows.length > COMPANIES_SENT;
  const sentCompanies = companyRows.slice(0, COMPANIES_SENT);
  const companies = prefill && !sentCompanies.some((c) => c.id === prefill.id) ? [prefill, ...sentCompanies] : sentCompanies;
  const startIn = pipelines.find((p) => p.key === pipeline) ?? pipelines[0];
  // The workspace's own words (Settings → Wording, src/lib/terms).
  const w = await getWording();
  // Only a number goes in the address — digits, spaces and a plus, nothing that could be anything else.
  const caller = phone && /^\+?[\d\s-]{6,20}$/.test(phone.trim()) ? phone.trim() : null;

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">{slot(w, "New lead", "lead", "New {one:lower}")}</h1>
      <p className="mt-1 text-sm text-muted">
        {slot(w, "Log a confirmed requirement against a company — this starts the sales pipeline.", "company", "Log a confirmed requirement against {a} — this starts the sales pipeline.")}
      </p>
      <div className="mt-6">
        <NewLeadForm
          companies={companies}
          companySearch={companySearch}
          initialCompanyId={prefill?.id}
          items={items}
          itemsEnabled={itemsEnabled}
          industries={industries}
          currentUser={{ id: user.id, role: user.role }}
          canAssign={canAssign}
          canAddContact={canAddContact}
          people={people.filter((p) => p.takes.leadOwner || p.id === user.id).map((p) => ({ id: p.id, name: p.name, email: p.email, hint: p.role }))}
          customFields={customFields}
          pipelines={pipelines.map((p) => ({ id: p.id, name: p.name }))}
          initialPipelineId={startIn?.id}
          fromCall={caller ? { phone: caller, detail: `Rang the business line from ${caller}` } : undefined}
          prefill={fromElsewhere ?? undefined}
        />
      </div>
    </div>
  );
}
