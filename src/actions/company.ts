"use server";

import { companyRecord, contactRecord, customInput, fieldRuleRefusal, locationRecord } from "@/lib/field-rules/server";
import { revalidatePath } from "next/cache";
import { tooLong } from "@/lib/validation/text";
import { z } from "zod";
import { Prisma, type CompanyStage, type CompanySource, type CompanyRelationshipType, type VendorStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { boughtFromUsWhere } from "@/lib/customers/bought";
import { refuseWhileViewingAs, requireUser } from "@/lib/session";
import { companyChanges, contactChanges } from "@/lib/activity/fields";
import { STILL_THERE } from "@/lib/contacts/left";
import { canSeeCompany, companyScope } from "@/lib/authz/company-scope";
import { accessLevel, leadAccess, mayAccess, mayAccessAccount, mayAccessContactsOf, mayAddTo, orderAccess, timelineAccess } from "@/lib/authz/access";
import { mayChangeAccountManager, mayChangeCaller, mayLeaveUnassigned, reassignRights } from "@/lib/authz/reassign";
import { assignRefusal, assignTeams, takesOf } from "@/lib/companies/assign-teams";
import { renewalManagersHere } from "@/lib/companies/renewal-manager";
import { companyCurrency, saveCompanyCurrency } from "@/lib/companies/default-currency";
import { workspaceClock } from "@/lib/time/workspace";
import type { Clock } from "@/lib/time/zone";
import { UNPAGED_LIST_CEILING, pageSlice } from "@/lib/pagination";
import { COMPANY_SORTS, resolveSort, type CompanySortKey } from "@/lib/tables/sort-options";
import { dayValue, inIdOrder, pageOfRanked, readInChunks } from "@/lib/tables/sorted-page";
import { lastActivityOfCompanies } from "@/lib/tables/list-extras";
import { notMigratedYet } from "@/lib/not-migrated";
import { isModuleEnabled } from "@/actions/module";
import { hasEffectivePermission } from "@/actions/permission";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { recordManagerChange } from "@/lib/quick-messages/notices";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { noteRecordsRead } from "@/lib/security/bulk-read";
import { isResellerManaged, redactContactDetails } from "@/lib/reseller";
import { contactMasker, maskContactRows } from "@/lib/contacts/masking";
import { companyMasker, hiddenCustomKeys, maskCompanyRows, maskCompanyWith } from "@/lib/companies/masking";
import { toPlain } from "@/lib/serialize";
import { formatCompanyId, formatOrderId, seqSearchTerm } from "@/lib/order-id";
import { companyPath } from "@/lib/record-links";
import {
  createCompanySchema,
  updateCompanySchema,
  assignCompaniesSchema,
  bulkUpdateCompaniesSchema,
  contactInputSchema,
  updateContactSchema,
  normalizeCompanyName,
  payoutDetailsSchema,
  vendorRelationshipTypeValues,
  isVendorRelationshipType,
  isCustomerRelationshipType,
  companyFieldEntity,
  type CreateCompanyInput,
} from "@/lib/validation/company";
import { addCompanyProductSchema, termsLocked, updateCompanyProductSchema } from "@/lib/validation/company-product";
import { countForBand } from "@/lib/company-size";
import {
  mayWorkWithContactsOf,
  canViewContacts,
  contactScope,
  NO_CONTACTS,
  contactDetailFieldKeys,
  contactDetailsHiddenAt,
  seesResellerContactDetails,
} from "@/lib/authz/contact-access";
import { checkTerms, recordDecision } from "@/lib/credit/guard";
import { CATEGORY_SELECT } from "@/lib/customers/categories";
import {
  changedLabel,
  customFieldsForCreate,
  customSearchWhere,
  formSetup,
  saveCustomFields,
} from "@/lib/custom-fields/server";
import { customFilterWhere, type CustomFilterInputs } from "@/lib/custom-fields/filters";
import { assignVendorCodes, vendorCodeHolder } from "@/lib/companies/vendor-code";
import { companyNamedLike } from "@/lib/companies/by-name";
import { companyNameMatches, nameSearchText } from "@/lib/company-name";
import { clientSide, customerSide, isVendorSide, rolesOf, setCompanyRole, setSideOwner, twoRolesHere, vendorListSide, vendorSide, type CompanySide } from "@/lib/companies/roles";
import { hasLeft } from "@/lib/contacts/left";
import { createContactAt } from "@/lib/contacts/create";
import { designationData } from "@/lib/contacts/designations";
import { listLeadMasker, maskLeads } from "@/lib/leads/masking";
import { lapsedCustomerWhere } from "@/lib/customers/lapsed";
import { customerStatsHere } from "@/lib/customers/stats";
import { isLoyaltyTier } from "@/lib/customers/loyalty-rules";
import { historyFilterWhere, type HistoryFilterParams } from "@/lib/customers/history-filters";
import { baseLocale, basePrefix } from "@/lib/currency";
import { formerNamesWhere, keepIssuedNames, rememberFormerNames } from "@/lib/companies/former-names";
import { fillWebsitesFromEmail } from "@/lib/companies/website-from-email";
import { refreshResearch } from "@/lib/research/gather";
import { tenantAfter } from "@/lib/tenancy/after";

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** A category a form sent is still there — none at all is fine. */
async function categoryExists(id: string | undefined): Promise<boolean> {
  if (!id) return true;
  return !!(await db.customerCategory.findUnique({ where: { id }, select: { id: true } }));
}

/** Which module owns a company — each is a separate directory, and records don't move between them. */
function relationshipFamily(type: CompanyRelationshipType): "client" | "reseller" | "commission-party" | "vendor" {
  if (type === "CLIENT") return "client";
  if (type === "RESELLER") return "reseller";
  if (type === "COMMISSION_PARTY") return "commission-party";
  return "vendor";
}

/** A company type the workspace has (Settings › Lists) — or none chosen. */
async function knownCompanyType(key: string | undefined): Promise<boolean> {
  if (!key) return true;
  return !!(await db.companyTypeOption.findUnique({ where: { key }, select: { id: true } }));
}
const UNKNOWN_COMPANY_TYPE = "That company type isn't one of this workspace's any more — choose another.";

/**
 * The company's own columns, from a form.
 *
 * `currentEmployeeCount` is what is stored now, if anything — so choosing the band a precise count
 * already falls in keeps that count rather than rounding it down to the band. See `countForBand`.
 */
function companyScalarData(
  input: Omit<CreateCompanyInput, "contacts" | "location">,
  currentEmployeeCount: number | null = null,
) {
  return {
    name: input.name.trim(),
    normalizedName: normalizeCompanyName(input.name),
    industryId: input.industryId || null,
    // The old free-text category, left alone unless something still sends it — see customerCategoryId.
    ...(input.category !== undefined ? { category: input.category || null } : {}),
    ...(input.customerCategoryId !== undefined ? { customerCategoryId: input.customerCategoryId || null } : {}),
    companyType: input.companyType || null,
    relationshipType: input.relationshipType,
    website: input.website || null,
    linkedinUrl: input.linkedinUrl || null,
    employeeCount: countForBand(input.employeeBand, currentEmployeeCount),
    paymentTerms: input.paymentTerms,
    dunsNumber: input.dunsNumber || null,
    tags: input.tags,
    source: input.source,
  };
}

export type CompanyMatch = {
  id: string;
  /** The clean reference, e.g. CMP-000123 — what the link opens. */
  ref: string;
  name: string;
  city: string | null;
  relationshipType: CompanyRelationshipType;
  owner: string | null;
};

export type CompanyMatches = {
  /** Companies this user can open whose name contains what was typed, closest first. */
  matches: CompanyMatch[];
  /**
   * The one that would make saving fail — same name once normalised. `visible: false` when it exists
   * but is assigned to somebody else: saying so is no more than `createCompany` itself says on the
   * way out, and it is said before the rest of the form has been filled in rather than after.
   */
  /** `canChangeRole`: whether this person may give it the other side as a second role (companies.changeRole). */
  duplicate: { visible: true; match: CompanyMatch; customer: boolean; vendor: boolean; canChangeRole: boolean } | { visible: false } | null;
};

/**
 * What is already in the CRM under a name, while it is still being typed.
 *
 * The create form's promise — "if it already exists, open the existing record instead" — used to be
 * kept only at Save, after every other field had been filled in. This keeps it at the first letter,
 * the way the company picker on a lead does.
 *
 * Scoped like every other company read: a rep sees their own accounts. The duplicate check is not,
 * because `normalizedName` is unique across the whole table and the save will be refused whoever
 * owns the other row — so the form says a duplicate exists without saying anything else about it.
 *
 * `adding`: the kind a form is creating (owner, 19 Oct 2026). Similar names are then only of its side —
 * a customer, reseller or commission party isn't offered a vendor, and a vendor only vendors — while the
 * same name is still said whatever its kind, as saving would be refused all the same. Without it (the
 * merge wizard, the copilot) every kind is searched.
 */
export async function findCompanyMatches(query: string, adding?: CompanyRelationshipType): Promise<CompanyMatches> {
  const user = await requireUser();
  const typed = String(query ?? "").trim().slice(0, 120);
  if (!typed) return { matches: [], duplicate: null };
  const normalizedName = normalizeCompanyName(typed);
  const scope = await companyScope(user.id);
  const side: Prisma.CompanyWhereInput = !adding
    ? {}
    : isVendorRelationshipType(adding)
      ? await vendorSide()
      : // Anything but a vendor alone: a vendor that's also a customer is offered.
        { NOT: { AND: [{ relationshipType: { in: [...vendorRelationshipTypeValues] } }, ...((await twoRolesHere()) ? [{ alsoCustomer: false }] : [])] } };
  const select = {
    id: true,
    companySeq: true,
    name: true,
    normalizedName: true,
    relationshipType: true,
    owner: { select: { name: true } },
    locations: { select: { city: true }, take: 1, orderBy: { createdAt: "asc" as const } },
  } satisfies Prisma.CompanySelect;

  const [found, exact] = await Promise.all([
    db.company.findMany({
      // By the normalised name, the one the duplicate rule uses — searching the raw text let "acme   ltd"
      // (extra spaces) miss "Acme Ltd", and the exact match was then reported as somebody else's.
      where: { AND: [scope, { normalizedName: { contains: normalizedName } }, side] },
      select,
      orderBy: { name: "asc" },
      take: 40,
    }),
    // The same name, or the same in another legal form — "Pvt Ltd" for "Private Limited" (src/lib/companies/by-name.ts).
    companyNamedLike(typed),
  ]);
  // That company, of any kind, where this person can see it — what the warning opens.
  const sameNameHere = exact ? await db.company.findFirst({ where: { AND: [scope, { id: exact.id }] }, select }) : null;
  // Its city as a list shows it (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.2): the create form, the merge
  // wizard and the copilot's company search all read these.
  const shown = await companyMasker(user.id, "list");

  // The same name first, then names that start with what was typed, then the rest — which is the
  // order a person scans for "is it this one?".
  const rank = (c: (typeof found)[number]) =>
    c.normalizedName === normalizedName ? 0 : c.normalizedName.startsWith(normalizedName) ? 1 : 2;
  const toMatch = (c: (typeof found)[number]): CompanyMatch => ({
    id: c.id,
    ref: formatCompanyId(c.companySeq),
    name: c.name,
    city: c.locations[0] ? (shown.location({ city: c.locations[0].city }).city ?? null) : null,
    relationshipType: c.relationshipType,
    owner: c.owner?.name ?? null,
  });
  const ranked = [...found].sort((a, b) => rank(a) - rank(b));
  const visibleDuplicate = exact && sameNameHere?.id === exact.id ? sameNameHere : undefined;

  return {
    matches: ranked.filter((c) => c.id !== exact?.id).slice(0, 8).map(toMatch),
    // With its roles (src/lib/companies/roles.ts): a vendor of that name may be made a customer too, rather than refused.
    duplicate: exact
      ? visibleDuplicate
        ? {
            visible: true,
            match: toMatch(visibleDuplicate),
            ...(({ customer, vendor }) => ({ customer, vendor }))(await rolesOf({ id: visibleDuplicate.id, relationshipType: visibleDuplicate.relationshipType })),
            canChangeRole: await hasEffectivePermission(user.id, "companies.changeRole"),
          }
        : { visible: false }
      : null,
  };
}

export async function createCompany(
  input: unknown,
): Promise<ActionResult<{ id: string; companySeq: number; contacts: { id: string; name: string; designation: string }[] }>> {
  const user = await requireUser();
  // Only somebody who may open Companies: the Create menu and the form are hidden otherwise, and this
  // is the same rule for a caller who posts anyway (decideModuleAccess, src/lib/navigation.ts).
  if (!(await isModuleEnabled("companies"))) return { ok: false, error: "You don't have access to Companies." };
  const parsed = createCompanySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { contacts, location, managedByResellerId, customFields, ...companyInput } = parsed.data;
  if (!(await knownCompanyType(companyInput.companyType))) return { ok: false, error: UNKNOWN_COMPANY_TYPE };
  if (!(await categoryExists(companyInput.customerCategoryId))) return { ok: false, error: "That customer category isn't there any more — pick another." };
  // The form leaves the contacts section out for someone without `contacts.view`; this is the same
  // rule for a caller that sends them anyway.
  if (contacts.length > 0 && !(await canViewContacts(user.id))) {
    return { ok: false, error: `${NO_CONTACTS} Create the company without them.` };
  }
  // The same name, or the same in another legal form — "Pvt Ltd" for "Private Limited" (src/lib/companies/by-name.ts).
  const existing = await companyNamedLike(companyInput.name);
  if (existing) {
    return {
      ok: false,
      error: `"${existing.name}" already exists in the system — open the existing record instead of creating a duplicate.`,
    };
  }
  // Longer terms than a new customer's (non-)record supports need an override — see src/lib/credit/guard.ts.
  const termsCheck = await checkTerms({
    userId: user.id,
    companyId: null,
    relationshipType: companyInput.relationshipType,
    terms: companyInput.paymentTerms,
    reason: companyInput.creditOverrideReason,
    subject: "Default terms",
  });
  if (!termsCheck.ok) return { ok: false, error: termsCheck.error };

  if (managedByResellerId) {
    const reseller = await db.company.findUnique({ where: { id: managedByResellerId } });
    if (!reseller || reseller.relationshipType !== "RESELLER") {
      return { ok: false, error: "That's not a reseller." };
    }
  }
  // The workspace's own fields (src/lib/custom-fields), the required ones answered. The contacts
  // created with the company are created without theirs: those are filled in on each contact.
  const custom = await customFieldsForCreate(companyFieldEntity(companyInput.relationshipType), user.id, customFields, { checkRequired: true });
  if (!custom.ok) return { ok: false, error: custom.error };
  // The workspace's field rules (src/lib/field-rules): the company with its address, then each contact made with it.
  const companyRuled = await fieldRuleRefusal("COMPANY", { ...companyInput, ...locationRecord(location), ...customInput(customFields).record });
  if (companyRuled) return { ok: false, error: companyRuled };
  for (const person of contacts) {
    const contactRuled = await fieldRuleRefusal("CONTACT", { ...person });
    if (contactRuled) return { ok: false, error: `${person.name}: ${contactRuled}` };
  }
  // Each contact's designation from the workspace's list, new names added to it (src/lib/contacts/designations.ts).
  const designations = await Promise.all(contacts.map((c) => designationData(db, c)));

  try {
    const company = await db.company.create({
      data: {
        ...companyScalarData(companyInput),
        // New vendor-type companies always start in the onboarding stage — customer-side companies don't use this field.
        vendorStatus: isCustomerRelationshipType(companyInput.relationshipType) ? null : "ONBOARDING",
        managedByResellerId: managedByResellerId ?? null,
        // Every reseller starts with an onboarding profile, so the checklist and the order gate
        // never have to cope with a missing one.
        resellerProfile: companyInput.relationshipType === "RESELLER" ? { create: {} } : undefined,
        createdById: user.id,
        /**
         * Whoever adds an account manages it until somebody says otherwise.
         *
         * This was unset, which did not matter while everybody saw every company and matters a
         * great deal now that they do not: a company with no account manager is nobody's, and the
         * rule in `company-scope.ts` deliberately hides those from anyone without
         * `companies.viewAll`. So a sales executive would add a customer, be returned to the list,
         * and not find it — having created a record only other people could see.
         *
         * Reassigning is one click on the company itself (`setCompanyOwner`), so this is a default
         * rather than a decision.
         */
        ownerUserId: user.id,
        ...custom.data,
        contacts: {
          create: contacts.map((c, i) => ({
            name: c.name.trim(),
            designation: c.designation,
            ...(designations[i] ?? {}),
            email: c.email || null,
            phone: c.phone || null,
            linkedinUrl: c.linkedinUrl || null,
            isPrimary: c.isPrimary,
            receivesDocuments: c.receivesDocuments,
          })),
        },
        locations: {
          create: [
            {
              label: location.label || "Head Office",
              address: location.address || null,
              city: location.city || null,
              state: location.state || null,
              country: location.country || null,
              // Dropped until now: the form collected a PIN and this never wrote it, so every
              // company created from the app had an address with no PIN code at all.
              pincode: location.pincode || null,
              gstNumber: location.gstNumber || null,
              gstTreatment: location.gstTreatment,
              isPrimary: true,
              /**
               * The only address a new company has is its billing and its shipping address.
               *
               * The schema says as much — "both until somebody says otherwise" — but these were never
               * written, so the column default of false won, and a company created from the app had
               * no billing address for its first invoice to default from.
               */
              isBilling: true,
              isShipping: true,
            },
          ],
        },
      },
      // Returned so a form that created a contact alongside the company can select it straight away.
      select: { id: true, companySeq: true, name: true, contacts: { select: { id: true, name: true, designation: true } } },
    });

    if (termsCheck.decision) {
      await recordDecision({ userId: user.id, companyId: company.id, kind: "TERMS", ...termsCheck.decision });
    }
    // Their own currency (owner, 30 Oct 2026), written on its own: a workspace not migrated yet saves the rest.
    if (companyInput.defaultCurrency) await saveCompanyCurrency(company.id, companyInput.defaultCurrency);
    // A vendor is numbered as it is created (owner, 8 Oct 2026) — the workspace's prefix and the next number.
    if (isVendorRelationshipType(companyInput.relationshipType)) await assignVendorCodes([company.id]);
    // No website given: its people's work email may say it (src/lib/companies/website-from-email.ts).
    await fillWebsitesFromEmail([company.id]);
    // Its research from public sources, gathered once after the page has answered (owner, 18 Nov 2026 — src/lib/research).
    const createdBy = user.id;
    await tenantAfter(async () => {
      const made = await db.company.findUnique({ where: { id: company.id }, select: { id: true, name: true, website: true } });
      if (made?.website) await refreshResearch(made, createdBy);
    });
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "Company", entityId: company.id, entityLabel: company.name });

    revalidatePath("/companies");
    revalidatePath("/vendors");
    revalidatePath("/commission-parties");
    return { ok: true, data: { id: company.id, companySeq: company.companySeq, contacts: company.contacts } };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "A company with this name already exists." };
    }
    throw err;
  }
}

export async function updateCompany(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  const parsed = updateCompanySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { id, ...companyInput } = parsed.data;
  if (!(await knownCompanyType(companyInput.companyType))) return { ok: false, error: UNKNOWN_COMPANY_TYPE };
  if (!(await categoryExists(companyInput.customerCategoryId))) return { ok: false, error: "That customer category isn't there any more — pick another." };
  const current = await db.company.findUnique({ where: { id } });
  /**
   * Scoped like every other company write. This took any id and saved over it — the profile, the
   * payment terms, the relationship — whoever's account it was.
   *
   * Security audit, Nov 2026: it asked for the view level (canSeeCompany), so a view-only role such
   * as SUPPORT_READONLY could change any company it could open. A change needs the edit level for the
   * account's own record (companies or vendors), as setVendorStatus and the other company writes ask.
   */
  if (!current || !(await mayAccessAccount(user.id, "edit", current))) {
    return { ok: false, error: "Company not found." };
  }
  // Another company of that name, or of it in another legal form (src/lib/companies/by-name.ts).
  // Asked only once the account is known to be the caller's to change, so the refusal can't be used
  // to learn the names of companies outside their reach.
  const existing = await companyNamedLike(companyInput.name, id);
  if (existing) {
    return {
      ok: false,
      error: `"${existing.name}" already exists in the system — company names must be unique.`,
    };
  }
  const termsCheck = await checkTerms({
    userId: user.id,
    companyId: id,
    relationshipType: companyInput.relationshipType,
    terms: companyInput.paymentTerms,
    previousTerms: current.paymentTerms,
    reason: companyInput.creditOverrideReason,
    subject: "Default terms",
  });
  if (!termsCheck.ok) return { ok: false, error: termsCheck.error };
  // Re-typing within a family is fine (Vendor to Distributor); crossing one isn't. A customer moved
  // to a vendor family drops out of Companies/Customer and loses the tabs holding its order history,
  // and a commission party moved out orphans its linked companies and payee accounts.
  if (relationshipFamily(companyInput.relationshipType) !== relationshipFamily(current.relationshipType)) {
    return {
      ok: false,
      error: "A company can't be moved between the client, reseller, vendor, and commission party modules — create the record in the right module instead.",
    };
  }

  // The workspace's field rules (src/lib/field-rules), on what this save sends.
  const companyRuled = await fieldRuleRefusal("COMPANY", { ...(await companyRecord(id)), ...companyInput }, { id, touched: Object.keys(companyInput) });
  if (companyRuled) return { ok: false, error: companyRuled };

  // Flipping to/from CLIENT resets the vendor onboarding status; otherwise leave whatever the
  // dedicated vendor-status control already set (editing the profile shouldn't reset onboarding progress).
  const vendorStatus =
    companyInput.relationshipType === "CLIENT"
      ? null
      : current.relationshipType === "CLIENT"
        ? "ONBOARDING"
        : (current.vendorStatus ?? "ONBOARDING");

  try {
    // A website field access hides from them on the company's page (owner, 5 Nov 2026 — Phase 3 masking fixes, audit
    // H.4.2): kept as stored, whatever the form sent — it shows the masked text, and saving that would write the stars
    // over the real address.
    const { website, ...scalars } = companyScalarData(companyInput, current.employeeCount);
    const hidden = (await companyMasker(user.id, "detail")).flags;
    const next = { ...scalars, ...(hidden.website ? {} : { website }), vendorStatus };
    const renamed = typeof companyInput.name === "string" && companyInput.name.trim() && companyInput.name.trim() !== current.name;
    // Renamed — Pvt Ltd to Ltd, say: what was issued keeps the name it was issued to (owner, 18 Nov 2026), first, so a
    // rename never leaves an issued invoice reading the new name.
    if (renamed) await keepIssuedNames(db, id, current.name);
    await db.company.update({ where: { id }, data: next });
    // And the old name kept, so it still finds them (owner, 14 Nov 2026).
    if (renamed) await rememberFormerNames(db, id, [current.name], companyInput.name!.trim());
    // Their own currency (owner, 30 Oct 2026), only when the form sent it, and on its own: a workspace not migrated yet
    // saves the rest.
    if (companyInput.defaultCurrency !== undefined) await saveCompanyCurrency(id, companyInput.defaultCurrency);

    // What changed, field by field, for the company's Activity (src/lib/activity/fields.ts).
    const changes = await companyChanges(current as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Company", entityId: id, entityLabel: companyInput.name, changes });
    if (termsCheck.decision) {
      await recordDecision({ userId: user.id, companyId: id, kind: "TERMS", ...termsCheck.decision });
    }

    revalidatePath("/companies");
    revalidatePath(`/companies/${id}`);
    revalidatePath("/vendors");
    revalidatePath("/commission-parties");
    return { ok: true, data: { id } };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "A company with this name already exists." };
    }
    throw err;
  }
}

/**
 * The company's own fields (src/lib/custom-fields), from the "More details" card on its page — bound
 * to the company there. Whoever may edit the company may change them, as `updateCompany` decides it.
 */
export async function updateCompanyCustomFields(companyId: string, input: unknown): Promise<ActionResult<null>> {
  const user = await requireUser();
  const company = await db.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, ownerUserId: true, relationshipType: true } });
  // Scoped like `updateCompany`: out of scope and missing answer the same.
  if (!company || !(await canSeeCompany(user.id, company))) {
    return { ok: false, error: "Company not found." };
  }
  // A field masked for them on the company's page keeps what it holds (owner, 5 Nov 2026 — Phase 3 masking fixes, audit
  // H.4.2): the form never had its value. The Companies set only; a vendor's own fields aren't covered yet.
  const entity = companyFieldEntity(company.relationshipType);
  const skip = entity === "COMPANY" ? hiddenCustomKeys(await companyMasker(user.id, "detail")) : [];
  if (entity === "COMPANY") {
    const asked = customInput(input);
    const ruled = await fieldRuleRefusal("COMPANY", { ...(await companyRecord(company.id)), ...asked.record }, { id: company.id, touched: asked.touched.filter((k) => !skip.includes(k.slice(3))) });
    if (ruled) return { ok: false, error: ruled };
  }
  const saved = await saveCustomFields(entity, company.id, user.id, input, { skip });
  if (!saved.ok) return saved;
  if (saved.changed.length > 0) {
    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "Company",
      entityId: company.id,
      entityLabel: `${company.name}${changedLabel(saved.changed)}`,
    });
    revalidatePath("/companies");
    revalidatePath(`/companies/${company.id}`);
    revalidatePath("/vendors");
    revalidatePath("/commission-parties");
  }
  return { ok: true, data: null };
}

/**
 * The workspace's own company fields for the quick-create dialog on the lead form, whose page knows
 * nothing of companies — it asks only the required ones, the rest are filled in on the company's page.
 */
export async function companyFieldSetup(): Promise<Awaited<ReturnType<typeof formSetup>>> {
  const user = await requireUser();
  return formSetup("COMPANY", user.id);
}

/**
 * The workspace's own contact fields for a form that adds somebody from another record's page — the
 * new-contact dialog on the lead form, whose page knows nothing of contacts. None for somebody without
 * `contacts.view`, who can't add one.
 */
export async function contactFieldSetup(): Promise<Awaited<ReturnType<typeof formSetup>>> {
  const user = await requireUser();
  if (!(await canViewContacts(user.id))) return { fields: [], values: {}, people: [] };
  return formSetup("CONTACT", user.id);
}

export async function addContact(
  companyId: string,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  if (!(await canViewContacts(user.id))) return { ok: false, error: NO_CONTACTS };
  const parsed = contactInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const c = parsed.data;

  const company = await db.company.findUnique({ where: { id: companyId } });
  /**
   * Scoped like every other company write. This used to check only that the company existed, so any
   * signed-in user could add a contact to any account by id — including one managed by somebody
   * else. Out of scope and non-existent answer the same, so an id cannot be used to find out which
   * accounts are real. Asked as editing that company's contacts (src/lib/authz/access.ts), so adding
   * one needs what changing one does.
   */
  if (!company || !(await mayAccessContactsOf(user.id, "edit", company))) {
    return { ok: false, error: "Company not found." };
  }
  // Written as everywhere a contact is added by hand (src/lib/contacts/create.ts).
  const made = await createContactAt(user.id, companyId, c);
  if (!made.ok) return made;

  revalidatePath(`/companies/${companyId}`);
  return { ok: true, data: { id: made.id } };
}

export async function updateContact(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  const parsed = updateContactSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, customFields, ...c } = parsed.data;

  const contact = await db.contact.findUnique({ where: { id } });
  // Scoped like `addContact`: this edited any contact by id, on any account. Out of scope and
  // missing answer the same.
  if (!contact || !(await mayWorkWithContactsOf(user.id, contact.companyId))) {
    return { ok: false, error: (await canViewContacts(user.id)) ? "Contact not found." : NO_CONTACTS };
  }

  // A reseller's end customer, edited by somebody who sees its email and phone hidden: both stay as
  // stored, whatever the form sent — it sends them blank, as it shows them.
  const detailsHidden = await contactDetailsHiddenAt(user.id, contact.companyId);
  // What field access shows them masked on this contact (owner, 3 Nov 2026): kept as stored, whatever the form sent —
  // the form shows the masked text, and saving it would write the stars over the real address.
  const masked = (await contactMasker(user.id, "detail", [id])).hidden(id);
  // Somebody who has left is nobody's primary and is sent nothing — mark them back first.
  if ((c.isPrimary || c.receivesDocuments) && (await hasLeft(id))) {
    return { ok: false, error: `${contact.name} has left the company — mark them back before making them primary or sending them documents.` };
  }
  // The workspace's field rules (src/lib/field-rules), on what this save sends — not on details kept as stored.
  {
    const kept = new Set<string>([...(detailsHidden ? ["email", "phone"] : []), ...masked]);
    const sent = Object.fromEntries(Object.entries(c).filter(([k]) => !kept.has(k)));
    const asked = customInput(customFields);
    const ruled = await fieldRuleRefusal("CONTACT", { ...(await contactRecord(id)), ...sent, ...asked.record }, { id, touched: [...Object.keys(sent), ...asked.touched] });
    if (ruled) return { ok: false, error: ruled };
  }

  // The workspace's own fields (src/lib/custom-fields), when the form had them — saved first, so a
  // refusal leaves the contact exactly as it was.
  let changed: string[] = [];
  if (customFields !== undefined) {
    const skip = [...(detailsHidden ? await contactDetailFieldKeys() : []), ...masked.filter((k) => k.startsWith("custom:")).map((k) => k.slice(7))];
    const saved = await saveCustomFields("CONTACT", id, user.id, customFields, { skip });
    if (!saved.ok) return saved;
    changed = saved.changed;
  }

  const nextContact = {
    ...(masked.includes("name") ? {} : { name: c.name.trim() }),
    designation: c.designation,
    ...((await designationData(db, c)) ?? {}),
    ...(detailsHidden || masked.includes("email") ? {} : { email: c.email || null }),
    ...(detailsHidden || masked.includes("phone") ? {} : { phone: c.phone || null }),
    linkedinUrl: c.linkedinUrl || null,
    isPrimary: c.isPrimary,
    receivesDocuments: c.receivesDocuments,
  };
  await db.contact.update({ where: { id }, data: nextContact });

  // What changed, for the company's Activity — an email or phone said to have changed, never to what.
  const changes = contactChanges(contact as unknown as Record<string, unknown>, nextContact as unknown as Record<string, unknown>);
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Contact", entityId: id, entityLabel: `${masked.includes("name") ? contact.name : c.name.trim()}${changedLabel(changed)}`, changes });

  await fillWebsitesFromEmail([contact.companyId]);
  revalidatePath(`/companies/${contact.companyId}`);
  return { ok: true, data: { id } };
}

/**
 * A contact's own fields (src/lib/custom-fields) by themselves — bound to the contact where they are
 * edited. Whoever may edit the contact may change them, as `updateContact` decides it.
 */
export async function updateContactCustomFields(contactId: string, input: unknown): Promise<ActionResult<null>> {
  const user = await requireUser();
  const contact = await db.contact.findUnique({ where: { id: contactId }, select: { id: true, name: true, companyId: true } });
  // Scoped like `updateContact`: out of scope and missing answer the same.
  if (!contact || !(await mayWorkWithContactsOf(user.id, contact.companyId))) {
    return { ok: false, error: (await canViewContacts(user.id)) ? "Contact not found." : NO_CONTACTS };
  }
  // A reseller's end customer's contact-detail fields, for somebody who sees them hidden: kept as stored.
  const skip = (await contactDetailsHiddenAt(user.id, contact.companyId)) ? await contactDetailFieldKeys() : [];
  {
    const skipped = new Set<string>(skip);
    const asked = customInput(input);
    const ruled = await fieldRuleRefusal("CONTACT", { ...(await contactRecord(contact.id)), ...asked.record }, { id: contact.id, touched: asked.touched.filter((k) => !skipped.has(k.slice(3))) });
    if (ruled) return { ok: false, error: ruled };
  }
  const saved = await saveCustomFields("CONTACT", contact.id, user.id, input, { skip });
  if (!saved.ok) return saved;
  if (saved.changed.length > 0) {
    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "Contact",
      entityId: contact.id,
      entityLabel: `${contact.name}${changedLabel(saved.changed)}`,
    });
    revalidatePath(`/companies/${contact.companyId}`);
  }
  return { ok: true, data: null };
}

export async function deleteContact(id: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  const contact = await db.contact.findUnique({ where: { id } });
  // Scoped like `addContact`: this deleted any contact by id, on any account.
  if (!contact || !(await mayWorkWithContactsOf(user.id, contact.companyId, "delete"))) {
    return { ok: false, error: (await canViewContacts(user.id)) ? "Contact not found." : NO_CONTACTS };
  }

  try {
    await db.contact.delete({ where: { id } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
      return { ok: false, error: "This contact is linked to a lead and can't be deleted." };
    }
    throw err;
  }

  revalidatePath(`/companies/${contact.companyId}`);
  return { ok: true, data: null };
}

/**
 * A contact who has left their company, or is back (owner, 8 Oct 2026) — src/lib/contacts/left.ts says
 * what leaving takes them out of. Whoever may edit the contact may mark it. Leaving also stops them
 * being primary and being sent documents, and revokes their customer-portal logins: a former employee
 * keeps no way into their old employer's invoices.
 */
export async function setContactLeft(contactId: string, left: boolean): Promise<ActionResult<null>> {
  const user = await requireUser();
  const contact = await db.contact.findUnique({ where: { id: contactId }, select: { id: true, name: true, companyId: true, company: { select: { name: true, companySeq: true } } } });
  if (!contact || !(await mayWorkWithContactsOf(user.id, contact.companyId))) {
    return { ok: false, error: (await canViewContacts(user.id)) ? "Contact not found." : NO_CONTACTS };
  }
  const now = new Date();
  const revoked = await db.$transaction(async (tx) => {
    await tx.contact.update({
      where: { id: contactId },
      data: left ? { leftAt: now, isPrimary: false, receivesDocuments: false } : { leftAt: null },
      select: { id: true },
    });
    if (!left) return 0;
    const logins = await tx.portalLogin.updateMany({ where: { contactId, revokedAt: null }, data: { revokedAt: now, revokedById: user.id } });
    return logins.count;
  });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Contact",
    entityId: contactId,
    entityLabel: left
      ? `${contact.name} left ${contact.company.name}${revoked ? ` — ${revoked} portal login${revoked === 1 ? "" : "s"} revoked` : ""}`
      : `${contact.name} is back at ${contact.company.name}`,
  });
  revalidatePath(companyPath(contact.company.companySeq));
  return { ok: true, data: null };
}

const moveSchema = z.object({
  companyId: z.string().max(100, tooLong(100)).min(1, "Pick the company they've joined"),
  email: z.string().trim().max(254, tooLong(254)).toLowerCase().email("Enter their new email, or leave it blank").optional().or(z.literal("")),
  phone: z.string().trim().max(40).optional().or(z.literal("")),
  designationName: z.string().max(80).optional(),
});

/**
 * Somebody who left this company has joined another (owner, 8 Oct 2026): this record is marked as left
 * (as `setContactLeft` does — not primary, not sent documents, out of the portal), and a record of them
 * is made at the new company with their new email, phone and designation, linked back to this one
 * (src/lib/contacts/moves.ts). Their history stays where it happened. Whoever may work with both
 * companies' contacts may record it.
 */
export async function moveContact(contactId: string, input: unknown): Promise<ActionResult<{ id: string; companySeq: number }>> {
  const user = await requireUser();
  const parsed = moveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;
  const [contact, target] = await Promise.all([
    db.contact.findUnique({ where: { id: contactId }, select: { id: true, name: true, linkedinUrl: true, companyId: true, company: { select: { name: true } } } }),
    db.company.findUnique({ where: { id: data.companyId }, select: { id: true, name: true, companySeq: true } }),
  ]);
  if (!contact || !(await mayWorkWithContactsOf(user.id, contact.companyId))) {
    return { ok: false, error: (await canViewContacts(user.id)) ? "Contact not found." : NO_CONTACTS };
  }
  if (!target || !(await mayWorkWithContactsOf(user.id, target.id))) return { ok: false, error: "That company isn't one you can add contacts to." };
  if (target.id === contact.companyId) return { ok: false, error: `They're at ${target.name} already — pick the company they've joined.` };
  const moved = await db.contact.findFirst({ where: { previousContactId: contactId }, select: { company: { select: { name: true } } } });
  if (moved) return { ok: false, error: `${contact.name} is already recorded as having joined ${moved.company.name}.` };

  const designation = await designationData(db, { designationName: data.designationName ?? "" });
  const now = new Date();
  const created = await db.$transaction(async (tx) => {
    await tx.contact.update({ where: { id: contactId }, data: { leftAt: now, isPrimary: false, receivesDocuments: false }, select: { id: true } });
    await tx.portalLogin.updateMany({ where: { contactId, revokedAt: null }, data: { revokedAt: now, revokedById: user.id } });
    return tx.contact.create({
      data: {
        companyId: target.id,
        name: contact.name,
        linkedinUrl: contact.linkedinUrl,
        email: data.email || null,
        phone: data.phone || null,
        ...(designation ?? {}),
        previousContactId: contactId,
        createdByUserId: user.id,
      },
      select: { id: true },
    });
  });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Contact", entityId: contactId, entityLabel: `${contact.name} left ${contact.company.name} for ${target.name}` });
  await recordAudit({ userId: user.id, action: "CREATE", entityType: "Contact", entityId: created.id, entityLabel: `${contact.name} at ${target.name}, previously at ${contact.company.name}` });
  await fillWebsitesFromEmail([target.id]);
  revalidatePath(companyPath(target.companySeq));
  return { ok: true, data: { id: created.id, companySeq: target.companySeq } };
}

/** Companies whose name contains what was typed — where somebody who left may have gone. Any kind, in scope. */
export async function searchCompaniesToJoin(query: string) {
  const user = await requireUser();
  const typed = String(query ?? "").trim().slice(0, 120);
  if (typed.length < 2) return [];
  // Without its legal form, so "pvt ltd" finds "Private Limited"; kept only where it matches (src/lib/company-name.ts).
  const rows = await db.company.findMany({
    where: { ...(await companyOptionsWhere(user.id)), name: { contains: nameSearchText(typed), mode: "insensitive" } },
    orderBy: { name: "asc" },
    take: CUSTOMER_SEARCH_LIMIT,
    select: COMPANY_OPTION_SELECT,
  });
  return rows.filter((c) => companyNameMatches(c.name, typed));
}

export async function assignCompanies(input: unknown): Promise<ActionResult<{ count: number }>> {
  const user = await requireUser();
  const parsed = assignCompaniesSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { companyIds, userId } = parsed.data;

  const assignee = await db.user.findUnique({ where: { id: userId } });
  if (!assignee || !assignee.active) {
    return { ok: false, error: "That person is not a valid, active user." };
  }
  const checked = await checkCallerChange(user.id, companyIds, userId);
  if (!checked.ok) return checked;
  const notCaller = checked.data.some((c) => c.relationshipType === "CLIENT") ? await assignRefusal("caller", userId) : null;
  if (notCaller) return { ok: false, error: notCaller };
  const result = await db.company.updateMany({
    where: { id: { in: companyIds } },
    data: {
      assignedToUserId: userId,
      assignedByUserId: user.id,
      assignedAt: new Date(),
    },
  });
  await auditCallerChange(user.id, checked.data, userId);

  if (userId !== user.id) {
    await notifyUser({
      userId,
      type: "CALLER_ASSIGNED",
      title: "You were assigned as caller",
      message: `${result.count} ${result.count === 1 ? "company" : "companies"} assigned to you for lead generation`,
      link: "/companies",
    });
  }

  revalidatePath("/companies");
  revalidatePath("/customers");
  return { ok: true, data: { count: result.count } };
}

/**
 * The caller is who's working this company for lead generation — distinct from the account
 * manager (`setCompanyOwner`), who services the account once it's a customer. Both can be set on
 * the same company at once; this is the single-record counterpart to the bulk `assignCompanies`
 * (same underlying `assignedToUserId`/`assignedByUserId`/`assignedAt` fields), and the only path
 * that can clear an assignment back to unassigned.
 */
export async function setCompanyCaller(companyId: string, userId: string | null): Promise<ActionResult<null>> {
  const actor = await requireUser();
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { id: true, companySeq: true, name: true, ownerUserId: true, relationshipType: true, assignedToUserId: true },
  });
  if (!company || !(await canSeeCompany(actor.id, company))) {
    return { ok: false, error: "Company not found." };
  }
  const rights = await reassignRights(actor.id);
  if (!mayChangeCaller(rights, actor.id, company)) {
    return { ok: false, error: "You can't change who calls this account." };
  }
  if (!userId && !mayLeaveUnassigned(rights)) {
    return { ok: false, error: "Hand it to a colleague — only someone who can reassign accounts may leave it with no caller." };
  }
  if (userId) {
    const caller = await db.user.findUnique({ where: { id: userId }, select: { active: true } });
    if (!caller?.active) return { ok: false, error: "That person is not a valid, active user." };
    // A vendor's "assigned to" is its onboarding, not calling: the caller rule is a client's.
    const refusal = userId !== company.assignedToUserId && company.relationshipType === "CLIENT" ? await assignRefusal("caller", userId) : null;
    if (refusal) return { ok: false, error: refusal };
  }
  if ((userId ?? null) === company.assignedToUserId) return { ok: true, data: null };

  await db.company.update({
    where: { id: companyId },
    data: userId
      ? { assignedToUserId: userId, assignedByUserId: actor.id, assignedAt: new Date() }
      : { assignedToUserId: null, assignedByUserId: null, assignedAt: null },
  });
  await recordAudit({
    userId: actor.id,
    action: "UPDATE",
    entityType: "Company",
    entityId: companyId,
    entityLabel: `${company.name} — caller: ${await nameOf(company.assignedToUserId)} → ${await nameOf(userId)}`,
  });

  if (userId && userId !== actor.id) {
    await notifyUser({
      userId,
      type: "CALLER_ASSIGNED",
      title: "You were assigned as caller",
      message: company.name,
      link: companyPath(company.companySeq),
    });
  }

  revalidatePath(`/companies/${companyId}`);
  revalidatePath("/companies");
  revalidatePath("/customers");
  return { ok: true, data: null };
}

/** A person's name for the activity log — or "nobody". */
async function nameOf(userId: string | null | undefined): Promise<string> {
  if (!userId) return "nobody";
  return (await db.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ?? "a removed user";
}

/**
 * Whether this person may set the caller on every one of these companies — see src/lib/authz/reassign.ts.
 * All or nothing: a bulk change that silently skipped the rows it was not allowed would leave
 * somebody believing a list was reassigned when half of it was not.
 */
async function checkCallerChange(
  actorId: string,
  companyIds: string[],
  nextId: string | null,
): Promise<ActionResult<{ id: string; name: string; assignedToUserId: string | null; relationshipType: string }[]>> {
  const rights = await reassignRights(actorId);
  const companies = await db.company.findMany({
    where: { AND: [{ id: { in: companyIds } }, await companyScope(actorId)] },
    select: { id: true, name: true, ownerUserId: true, assignedToUserId: true, relationshipType: true },
  });
  if (companies.length !== new Set(companyIds).size) {
    return { ok: false, error: "Some of the selected companies are not yours to change." };
  }
  const refused = companies.filter((c) => !mayChangeCaller(rights, actorId, c));
  if (refused.length) {
    return {
      ok: false,
      error: `You can't change the caller on ${refused.length === 1 ? refused[0]!.name : `${refused.length} of these companies`} — only on accounts you manage or call.`,
    };
  }
  if (!nextId && !mayLeaveUnassigned(rights)) {
    return { ok: false, error: "Hand them to a colleague — only someone who can reassign accounts may leave them with no caller." };
  }
  return { ok: true, data: companies };
}

/** One activity-log line per company whose caller actually changes. */
async function auditCallerChange(actorId: string, companies: { id: string; name: string; assignedToUserId: string | null }[], nextId: string | null) {
  const to = await nameOf(nextId);
  for (const c of companies) {
    if (c.assignedToUserId === nextId) continue;
    await recordAudit({
      userId: actorId,
      action: "UPDATE",
      entityType: "Company",
      entityId: c.id,
      entityLabel: `${c.name} — caller: ${await nameOf(c.assignedToUserId)} → ${to}`,
    });
  }
}

export async function setCompanyOwner(companyId: string, userId: string | null): Promise<ActionResult<null>> {
  const actor = await requireUser();
  const company = await db.company.findUnique({ where: { id: companyId }, select: { id: true, companySeq: true, name: true, ownerUserId: true, relationshipType: true } });
  // Outside the account scope is answered as missing — and this check comes first because the
  // account manager *is* the scope: without it, naming yourself was a way to see any company.
  if (!company || !(await canSeeCompany(actor.id, company))) {
    return { ok: false, error: "Company not found." };
  }
  const rights = await reassignRights(actor.id);
  if (!mayChangeAccountManager(rights, actor.id, company)) {
    return { ok: false, error: "You can't change who manages this account." };
  }
  if (!userId && !mayLeaveUnassigned(rights)) {
    return { ok: false, error: "Hand it to a colleague — only someone who can reassign accounts may leave one with nobody." };
  }
  if (userId) {
    const owner = await db.user.findUnique({ where: { id: userId }, select: { active: true } });
    if (!owner?.active) return { ok: false, error: "That person is not a valid, active user." };
  }
  if ((userId ?? null) === company.ownerUserId) return { ok: true, data: null };
  const notManager = userId ? await assignRefusal("accountManager", userId) : null;
  if (notManager) return { ok: false, error: notManager };

  await db.company.update({ where: { id: companyId }, data: { ownerUserId: userId } });
  // Kept until the customer is told, by hand, of their new account manager (src/lib/quick-messages).
  await recordManagerChange([{ companyId, fromUserId: company.ownerUserId }], userId, actor.id);
  await recordAudit({
    userId: actor.id,
    action: "UPDATE",
    entityType: "Company",
    entityId: companyId,
    entityLabel: `${company.name} — account manager: ${await nameOf(company.ownerUserId)} → ${await nameOf(userId)}`,
  });

  if (userId && userId !== actor.id) {
    await notifyUser({
      userId,
      type: "ACCOUNT_MANAGER_ASSIGNED",
      title: "You were made account manager",
      message: company.name,
      link: companyPath(company.companySeq),
    });
  }

  revalidatePath(`/companies/${companyId}`);
  revalidatePath("/companies");
  return { ok: true, data: null };
}

/**
 * Who looks after a customer's renewals (owner, 30 Oct 2026): somebody, or nobody of its own (null) — then they are its
 * account manager's. Whoever may change the account manager may change this; back to the account manager is never
 * leaving it with nobody.
 */
export async function setCompanyRenewalManager(companyId: string, userId: string | null): Promise<ActionResult<null>> {
  const actor = await requireUser();
  if (!(await renewalManagersHere())) return { ok: false, error: "Renewal managers aren't set up in this workspace yet." };
  const company = await db.company.findUnique({ where: { id: companyId }, select: { id: true, companySeq: true, name: true, ownerUserId: true, relationshipType: true, renewalManagerId: true } });
  if (!company || !(await canSeeCompany(actor.id, company))) return { ok: false, error: "Company not found." };
  if (!mayChangeAccountManager(await reassignRights(actor.id), actor.id, company)) {
    return { ok: false, error: "You can't change who looks after this customer's renewals." };
  }
  const next = userId || null;
  if (next) {
    const person = await db.user.findUnique({ where: { id: next }, select: { active: true } });
    if (!person?.active) return { ok: false, error: "That person is not a valid, active user." };
  }
  if (next === company.renewalManagerId) return { ok: true, data: null };
  const notRenewals = next ? await assignRefusal("renewalManager", next) : null;
  if (notRenewals) return { ok: false, error: notRenewals };
  await db.company.update({ where: { id: companyId }, data: { renewalManagerId: next }, select: { id: true } });
  await recordAudit({
    userId: actor.id,
    action: "UPDATE",
    entityType: "Company",
    entityId: companyId,
    entityLabel: `${company.name} — renewal manager: ${company.renewalManagerId ? await nameOf(company.renewalManagerId) : "the account manager"} → ${next ? await nameOf(next) : "the account manager"}`,
  });
  if (next && next !== actor.id) {
    await notifyUser({ userId: next, type: "ACCOUNT_MANAGER_ASSIGNED", title: "You were made renewal manager", message: company.name, link: companyPath(company.companySeq) });
  }
  revalidatePath("/renewals");
  return { ok: true, data: null };
}

export async function setVendorStatus(companyId: string, status: VendorStatus): Promise<ActionResult<null>> {
  // Anybody who can open the vendor sees the control, so no permission of its own — but it has to be a
  // vendor they reach to edit. It asked only for a session: any signed-in person could blacklist any
  // vendor by its id.
  const user = await requireUser();
  const company = await db.company.findUnique({ where: { id: companyId } });
  if (!company || !(await mayAccess(user.id, "vendors", "edit", companyId))) {
    return { ok: false, error: "Company not found." };
  }
  if (company.relationshipType === "CLIENT") {
    return { ok: false, error: "Only vendor-type companies have a vendor status." };
  }

  await db.company.update({ where: { id: companyId }, data: { vendorStatus: status } });

  revalidatePath(`/companies/${companyId}`);
  revalidatePath("/vendors");
  revalidatePath("/commission-parties");
  return { ok: true, data: null };
}

/**
 * A code typed by hand, replacing the one given automatically. Not a client's — a client is never a
 * vendor — and never another company's: a code is how purchase and accounts tell vendors apart.
 */
export async function setVendorCode(companyId: string, code: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  const company = await db.company.findUnique({ where: { id: companyId }, select: { ownerUserId: true, relationshipType: true } });
  if (!company || !(await canSeeCompany(user.id, company))) {
    return { ok: false, error: "Company not found." };
  }
  // A customer that's also a vendor has one too (src/lib/companies/roles.ts).
  if (isCustomerRelationshipType(company.relationshipType) && !(await isVendorSide({ id: companyId, relationshipType: company.relationshipType }))) {
    return { ok: false, error: "Only vendors and commission parties have a vendor code." };
  }
  const value = code.trim().toUpperCase();
  if (value.length > 30) return { ok: false, error: "A vendor code is at most 30 characters." };
  if (value) {
    const holder = await vendorCodeHolder(db, value, companyId);
    if (holder) return { ok: false, error: `${value} is already ${holder.name}'s vendor code.` };
  }

  await db.company.update({ where: { id: companyId }, data: { vendorCode: value || null } });

  revalidatePath(`/companies/${companyId}`);
  revalidatePath("/vendors");
  revalidatePath("/commission-parties");
  return { ok: true, data: null };
}

/**
 * Compliance details (PAN) — edited separately from the main profile, same pattern as `setVendorCode`.
 * Its bank accounts are their own list (src/actions/company-bank.ts). Finance's to change, as they are:
 * the PAN decides the TDS deducted from every payment.
 */
export async function setPayoutDetails(companyId: string, input: unknown): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "payments.manage"))) {
    return { ok: false, error: "Changing a company's PAN needs the “Manage finance records” permission." };
  }
  const parsed = payoutDetailsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const company = await db.company.findUnique({ where: { id: companyId }, select: { ownerUserId: true, relationshipType: true } });
  if (!company || !(await canSeeCompany(user.id, company))) {
    return { ok: false, error: "Company not found." };
  }
  if (company.relationshipType === "CLIENT") {
    return { ok: false, error: "A client has no payout details — we never pay one." };
  }
  // A PAN field access hides from them can't be changed by them (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.2):
  // the dialog would start from the masked text, and a new one typed over what they can't read is no edit of theirs.
  if ((await companyMasker(user.id, "detail")).flags.pan) {
    return { ok: false, error: "The PAN is masked for you, so it can't be changed here." };
  }

  await db.company.update({ where: { id: companyId }, data: { panNumber: parsed.data.panNumber || null } });

  revalidatePath(`/companies/${companyId}`);
  revalidatePath("/vendors");
  revalidatePath("/commission-parties");
  return { ok: true, data: null };
}

export async function listAssignableUsers() {
  await requireUser();
  const [people, teams] = await Promise.all([
    db.user.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      // Email and work phone travel with the name because a quote names the person who sent it
      // and the customer has to be able to reach them. Neither is a secret from a colleague —
      // both are already on the user's own screen and on every document they raise.
      select: { id: true, name: true, role: true, email: true, phone: true, departmentId: true },
    }),
    assignTeams(),
  ]);
  // What each may be given of a company — caller, account manager, renewal manager (src/lib/companies/assign-teams.ts).
  return people.map(({ departmentId, ...person }) => ({ ...person, takes: takesOf(teams, departmentId) }));
}

/**
 * The Companies module's list — the raw CLIENT-track sourcing pool (prospects/leads/won-deals).
 * Vendors, OEMs, distributors, partners, and commission parties live in their own dedicated
 * modules (`/vendors`, `/commission-parties`) and are deliberately excluded here by default, same
 * as `listCustomers`. `relationshipType` can still override this (kept for flexibility), but the
 * `/companies` page itself never passes anything other than the default.
 */
type CompanyListParams = {
  stage?: CompanyStage;
  /** Only meaningful alongside `stage: "CUSTOMER"` — true = has at least one order on file (even an expired one), false = a won deal with no order recorded yet ("Awaiting Order"). Undefined = don't filter on it. */
  hasOrders?: boolean;
  search?: string;
  assignedToUserId?: string;
  /** The account manager; "unassigned" for none. */
  ownerUserId?: string;
  source?: CompanySource;
  industryId?: string;
  /** A category — which takes in its sub-categories — or one sub-category. */
  categoryId?: string;
  relationshipType?: CompanyRelationshipType;
  createdFrom?: string;
  createdTo?: string;
  /** The workspace's own fields filtered on, as the page read them from its URL (src/lib/custom-fields/filters.ts). */
  customFilters?: CustomFilterInputs;
};

/** What the workspace's own fields add to a company list: the search box's branches, and the field filters. */
type CompanyCustom = { search: Prisma.CompanyWhereInput[]; filters: Prisma.CompanyWhereInput[] };
const NO_CUSTOM: CompanyCustom = { search: [], filters: [] };

/**
 * The search box on the company lists: the name, or one of the workspace's own fields this person may
 * see (src/lib/custom-fields/server.ts `customSearchWhere`, passed in by the list action).
 */
function companySearch(search: string, custom: Prisma.CompanyWhereInput[]): Prisma.CompanyWhereInput {
  const byName = { normalizedName: { contains: normalizeCompanyName(search) } };
  // Or its number, as the list shows it — "COM-001128", "1128" (owner, 1 Nov 2026).
  const terms = [byName, ...seqSearchTerm(search, "companySeq"), ...custom];
  return terms.length > 1 ? { OR: terms } : byName;
}

/**
 * The search and the field filters, as one `AND` of clauses — never spread side by side: the search is
 * an `OR`, `categoryFilter` writes an `OR` of its own, and so does a field filter now and then ("No" on
 * a yes-or-no field); two in one object keep only whichever came last.
 */
function companyNarrowing(search: string | undefined, custom: CompanyCustom): Prisma.CompanyWhereInput {
  const clauses = [...(search ? [companySearch(search, custom.search)] : []), ...custom.filters];
  return clauses.length > 0 ? { AND: clauses } : {};
}

/** `customSearchWhere` and `customFilterWhere` for companies, typed for the list builders. */
async function companyCustom(
  userId: string,
  params?: { search?: string; customFilters?: CustomFilterInputs },
  entity: "COMPANY" | "VENDOR" = "COMPANY",
): Promise<CompanyCustom> {
  const [search, filters, former] = await Promise.all([
    customSearchWhere(entity, userId, params?.search),
    customFilterWhere(entity, userId, params?.customFilters),
    // A name it went by before finds it too (src/lib/companies/former-names.ts).
    params?.search ? formerNamesWhere(params.search) : Promise.resolve([]),
  ]);
  return { search: [...(search as Prisma.CompanyWhereInput[]), ...former], filters: filters as Prisma.CompanyWhereInput[] };
}

/**
 * The lists' Created From and To are the workspace's days, half-open, on its clock. They were the
 * server's: on a server in UTC a company added at 1 am in India was filed under the day before, and
 * one added late on the To day fell outside it.
 */
/**
 * Which companies a list is of (src/lib/companies/roles.ts): a kind asked for, or the Companies module's
 * own — clients, and a vendor that's also a customer.
 */
/**
 * The Companies list's "has orders" buckets, as the Customers list counts a customer (src/lib/customers/bought.ts —
 * owner, 16 Nov 2026): bought from us — an order, an issued invoice, or one in the old system's archive — or not yet.
 */
async function hasOrdersTerm(params?: CompanyListParams): Promise<Prisma.CompanyWhereInput[]> {
  if (params?.hasOrders === undefined) return [];
  const bought = await boughtFromUsWhere();
  return [params.hasOrders ? bought : { NOT: bought }];
}

async function companyListSide(params?: CompanyListParams): Promise<Prisma.CompanyWhereInput> {
  return params?.relationshipType ? { relationshipType: params.relationshipType } : clientSide();
}

function companyListWhere(clock: Clock, params?: CompanyListParams, custom: CompanyCustom = NO_CUSTOM): Prisma.CompanyWhereInput {
  const createdAt = clock.dayRange(params?.createdFrom, params?.createdTo);
  return {
    // A reseller's end customer is theirs to call, not ours — keep them out of the sourcing pool.
    managedByResellerId: null,
    ...(params?.stage ? { stage: params.stage } : {}),
    ...companyNarrowing(params?.search, custom),
    ...(params?.assignedToUserId
      ? params.assignedToUserId === "unassigned"
        ? { assignedToUserId: null }
        : { assignedToUserId: params.assignedToUserId }
      : {}),
    // The account manager (owner, 30 Oct 2026) — not the caller above, who is `assignedTo`.
    ...(params?.ownerUserId ? (params.ownerUserId === "unassigned" ? { ownerUserId: null } : { ownerUserId: params.ownerUserId }) : {}),
    ...(params?.source ? { source: params.source } : {}),
    ...(params?.industryId ? { industryId: params.industryId } : {}),
    ...categoryFilter(params?.categoryId),
    ...(createdAt ? { createdAt } : {}),
  };
}

/** A category takes in its sub-categories: "Strategic" lists the key accounts too. */
function categoryFilter(categoryId?: string): Prisma.CompanyWhereInput {
  if (!categoryId) return {};
  if (categoryId === "none") return { customerCategoryId: null };
  return { OR: [{ customerCategoryId: categoryId }, { customerCategory: { parentId: categoryId } }] };
}

const companyListInclude = {
  _count: { select: { contacts: true, leads: true, products: true } },
  owner: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  assignedTo: { select: { id: true, name: true } },
  industry: { select: { id: true, name: true } },
  customerCategory: { select: CATEGORY_SELECT },
  // The head office, for the City / State and GSTIN columns (owner, 30 Oct 2026).
  locations: { where: { isPrimary: true }, take: 1, select: { city: true, state: true, gstNumber: true } },
} as const;

/**
 * Every company list below reaches its company by the shortest possible route — these rows *are*
 * companies, so the scope lands on `ownerUserId` directly and there is no relation to hop through.
 * The fragment is spread rather than written out because `accountScopeIds` returns `null` for a
 * viewer holding `companies.viewAll`, and only the fragment turns that into "no clause at all"
 * instead of an `IN ()` that would empty the accounts team's screens. See
 * src/lib/authz/company-scope.ts.
 */
export async function listCompanies(params?: CompanyListParams) {
  const user = await requireUser();
  const rows = await db.company.findMany({
    where: { AND: [await companyListSide(params), companyListWhere(await workspaceClock(), params, await companyCustom(user.id, params)), await companyScope(user.id), ...(await hasOrdersTerm(params)) ] },
    orderBy: { createdAt: "desc" },
    include: companyListInclude,
    // Security audit, 13 Nov 2026 (SEC-29): no screen reads this unpaged list (they use listCompaniesPaged), so it
    // stops at the ceiling rather than handing every company in scope to one call.
    take: UNPAGED_LIST_CEILING,
  });
  // Field access, as every company list shows a company (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.2).
  return maskCompanyRows(user.id, "list", rows);
}

/** The Sort control's choice, as the URL carries it (src/lib/tables/sort-options.ts). */
type ListSortParams = { sort?: string; dir?: string };

/**
 * A page of companies in the order asked for (owner, 31 Oct 2026). Added on and name are the database's to sort; last
 * activity and a customer's stored history are ranked across every company the filters match, then cut — and a
 * company with nothing to rank by (no history yet, never contacted) comes last either way round.
 */
async function companyPage(userId: string, where: Prisma.CompanyWhereInput, params: ListSortParams & { page: number; pageSize: number }) {
  const canSeeOrders = await hasEffectivePermission(userId, "orders.view");
  const s = resolveSort(COMPANY_SORTS, params.sort, params.dir, { canSeeOrders });
  if (s.key === "added" || s.key === "name") {
    return db.company.findMany({
      where,
      orderBy: [s.key === "name" ? { name: s.dir } : { createdAt: s.dir }, { id: "asc" }],
      include: companyListInclude,
      ...pageSlice(params.page, params.pageSize),
    });
  }
  const ids = (await db.company.findMany({ where, select: { id: true }, orderBy: [{ createdAt: "desc" }, { id: "asc" }] })).map((c) => c.id);
  const values = await companySortValues(s.key, where, ids);
  const pageIds = pageOfRanked(ids, values, s.dir, params.page, params.pageSize);
  return inIdOrder(await db.company.findMany({ where: { id: { in: pageIds } }, include: companyListInclude }), pageIds);
}

/** Each company's value for a sort its own columns don't hold — none where the history table isn't there yet. */
async function companySortValues(key: Exclude<CompanySortKey, "added" | "name">, where: Prisma.CompanyWhereInput, ids: string[]): Promise<Map<string, number | null>> {
  if (key === "lastActivity") {
    const last = await readInChunks(ids, lastActivityOfCompanies);
    return new Map([...last].map(([id, at]) => [id, at.getTime()]));
  }
  let stats;
  try {
    stats = await db.customerStats.findMany({ where: { company: { is: where } } });
  } catch (err) {
    if (notMigratedYet(err)) return new Map();
    throw err;
  }
  const valueOf = (r: (typeof stats)[number]): number | null => {
    switch (key) {
      case "lifetime": return Number(r.lifetimeValue);
      case "last12": return Number(r.last12Value);
      case "lastPurchase": return dayValue(r.lastPurchaseAt);
      case "live": return r.liveSubscriptions;
      case "orders": return r.orders;
      case "renewalRate": return r.renewalsDue > 0 ? r.renewalsRenewed / r.renewalsDue : null;
      case "paysIn": return r.avgDaysToPay;
      case "overdue": return Number(r.overdue);
      case "products": return r.productCount;
      case "customerSince": return dayValue(r.firstOrderAt);
    }
  };
  return new Map(stats.map((r) => [r.companyId, valueOf(r)]));
}

/** One page of the Companies / Customer lists, plus the unpaginated total for the pager. */
export async function listCompaniesPaged(params: CompanyListParams & ListSortParams & { page: number; pageSize: number }) {
  const user = await requireUser();
  // One `where` for both queries below: a pager whose count outran its rows would offer page 9 of
  // a list that ends at page 2.
  const where = { AND: [await companyListSide(params), companyListWhere(await workspaceClock(), params, await companyCustom(user.id, params)), await companyScope(user.id), ...(await hasOrdersTerm(params))] };
  const [rows, total] = await Promise.all([companyPage(user.id, where, params), db.company.count({ where })]);
  // Counted towards the read-volume check. Deliberately not awaited — see the contacts list for
  // why the alerting path must never be on the critical path of a page load.
  void noteRecordsRead({ userId: user.id, userName: user.name, count: rows.length, what: "the company list" });
  // A client component draws these rows: a credit limit is a Decimal, which it cannot be handed (toPlain). Each with
  // field access applied (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.2, src/lib/companies/masking.ts): the
  // rows carry every column of a company, PAN and website among them, and each head office's city, state and GSTIN.
  return { rows: toPlain(await maskCompanyRows(user.id, "list", rows)), total };
}

/**
 * The Customer module's list — every Client-type company that has actually bought something from
 * us: an order on file in Products & Subscriptions, active or expired, or an invoice — issued here, or
 * in the old system's archive (src/lib/customers/bought.ts, owner 16 Nov 2026). A won deal with neither
 * doesn't qualify, see `listCompanies`'s `hasOrders: false` "Awaiting Order" bucket.
 * Same shape as `listCompanies` so it's plug-compatible with `CompaniesTable`.
 */
type CustomerListParams = {
  search?: string;
  assignedToUserId?: string;
  /** The account manager; "unassigned" for none. */
  ownerUserId?: string;
  source?: CompanySource;
  industryId?: string;
  categoryId?: string;
  createdFrom?: string;
  createdTo?: string;
  /** The workspace's own fields filtered on (src/lib/custom-fields/filters.ts). */
  customFilters?: CustomFilterInputs;
  /** "lapsed": every subscription ended, none renewed (owner, 26 Oct 2026 — src/lib/customers/lapsed.ts). */
  standing?: string;
  /** A loyalty tier, from the stored stats (owner, 31 Oct 2026 — src/lib/customers/stats.ts). */
  loyalty?: string;
  /** Uses something bought elsewhere: "any", or a category's key (owner, 6 Nov 2026 — src/lib/customers/elsewhere.ts). */
  elsewhere?: string;
  /** Something bought elsewhere renews within this many days. */
  elsewhereRenewal?: string;
  /** Its history with us — lifetime value, last 12 months, live orders… (owner, 17 Nov 2026 — src/lib/customers/history-filters.ts). */
  history?: HistoryFilterParams;
};

/**
 * The standing filter, its own AND term: the list's own `products` condition must not be replaced. The loyalty tier
 * rides with it — a filter on the stored row, left off where the table isn't there yet rather than failing the list.
 */
async function standingFilter(params?: CustomerListParams): Promise<Prisma.CompanyWhereInput[]> {
  const out: Prisma.CompanyWhereInput[] = [];
  if (isLoyaltyTier(params?.loyalty) && (await customerStatsHere())) out.push({ customerStats: { is: { tier: params.loyalty } } });
  if (params?.elsewhere) out.push({ installedElsewhere: { some: params.elsewhere === "any" ? {} : { category: params.elsewhere } } });
  const within = Number(params?.elsewhereRenewal);
  if (Number.isFinite(within) && within > 0) {
    // A @db.Date column: the workspace's today, and the window's last day included.
    const today = (await workspaceClock()).calendarDate(new Date());
    out.push({ installedElsewhere: { some: { renewsOn: { gte: today, lte: new Date(today.getTime() + within * 86_400_000) } } } });
  }
  if (params?.history) out.push(...(await historyFilterWhere(params.history, await workspaceClock(), await customerStatsHere())));
  if (params?.standing !== "lapsed") return out;
  return [...out, lapsedCustomerWhere((await workspaceClock()).calendarDate(new Date()))];
}

function customerListWhere(clock: Clock, params?: CustomerListParams, custom: CompanyCustom = NO_CUSTOM): Prisma.CompanyWhereInput {
  const createdAt = clock.dayRange(params?.createdFrom, params?.createdTo);
  // Clients, and a vendor that's also a customer — `clientSide()`, ANDed in by the callers.
  return {
    // Resellers have their own module, and their end customers are never our customer — the
    // reseller is who bought from us.
    managedByResellerId: null,
    // Bought from us — an order, an issued invoice or an archived one — is the callers' own AND term (boughtFromUsWhere).
    ...companyNarrowing(params?.search, custom),
    ...(params?.assignedToUserId
      ? params.assignedToUserId === "unassigned"
        ? { assignedToUserId: null }
        : { assignedToUserId: params.assignedToUserId }
      : {}),
    // The account manager (owner, 30 Oct 2026) — not the caller above, who is `assignedTo`.
    ...(params?.ownerUserId ? (params.ownerUserId === "unassigned" ? { ownerUserId: null } : { ownerUserId: params.ownerUserId }) : {}),
    ...(params?.source ? { source: params.source } : {}),
    ...(params?.industryId ? { industryId: params.industryId } : {}),
    ...categoryFilter(params?.categoryId),
    ...(createdAt ? { createdAt } : {}),
  };
}

export async function listCustomers(params?: CustomerListParams) {
  const user = await requireUser();
  const rows = await db.company.findMany({
    where: { AND: [await clientSide(), await boughtFromUsWhere(), customerListWhere(await workspaceClock(), params, await companyCustom(user.id, params)), await companyScope(user.id), ...(await standingFilter(params))] },
    orderBy: { createdAt: "desc" },
    include: companyListInclude,
    // Security audit, 13 Nov 2026 (SEC-29): as listCompanies — the screen reads listCustomersPaged.
    take: UNPAGED_LIST_CEILING,
  });
  // Field access, as every company list shows a company (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.2).
  return maskCompanyRows(user.id, "list", rows);
}

export async function listCustomersPaged(params: CustomerListParams & ListSortParams & { page: number; pageSize: number }) {
  const user = await requireUser();
  const where = { AND: [await clientSide(), await boughtFromUsWhere(), customerListWhere(await workspaceClock(), params, await companyCustom(user.id, params)), await companyScope(user.id), ...(await standingFilter(params))] };
  const [rows, total] = await Promise.all([companyPage(user.id, where, params), db.company.count({ where })]);
  // A client component draws these rows: a credit limit is a Decimal, which it cannot be handed (toPlain). Field access
  // applied, as on the Companies list (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.2).
  return { rows: toPlain(await maskCompanyRows(user.id, "list", rows)), total };
}

/**
 * The Vendors module's list — every company that isn't a Client or a Commission Party
 * (Vendor/OEM/Distributor/Partner/Other), same shape as `listCompanies` so it's plug-compatible
 * with `CompaniesTable`. Also reused by the Commission Parties page, which passes an explicit
 * `relationshipType: "COMMISSION_PARTY"` to override the default exclusion.
 */
type VendorListParams = {
  search?: string;
  assignedToUserId?: string;
  /** The account manager; "unassigned" for none. */
  ownerUserId?: string;
  source?: CompanySource;
  industryId?: string;
  relationshipType?: CompanyRelationshipType;
  vendorStatus?: VendorStatus;
  createdFrom?: string;
  createdTo?: string;
  /** The workspace's own fields filtered on (src/lib/custom-fields/filters.ts). */
  customFilters?: CustomFilterInputs;
};

/** The vendors list's own fields: a vendor's, except on the commission parties' list that shares it. */
function vendorListFields(params?: VendorListParams): "COMPANY" | "VENDOR" {
  return params?.relationshipType === "COMMISSION_PARTY" ? "COMPANY" : "VENDOR";
}

function vendorListWhere(clock: Clock, params?: VendorListParams, custom: CompanyCustom = NO_CUSTOM): Prisma.CompanyWhereInput {
  const createdAt = clock.dayRange(params?.createdFrom, params?.createdTo);
  // The kind, or the vendor side with a customer that's also a vendor — `vendorListSide()`, ANDed in by the callers.
  return {
    ...(params?.vendorStatus ? { vendorStatus: params.vendorStatus } : {}),
    ...companyNarrowing(params?.search, custom),
    ...(params?.assignedToUserId
      ? params.assignedToUserId === "unassigned"
        ? { assignedToUserId: null }
        : { assignedToUserId: params.assignedToUserId }
      : {}),
    // The account manager (owner, 30 Oct 2026) — not the caller above, who is `assignedTo`.
    ...(params?.ownerUserId ? (params.ownerUserId === "unassigned" ? { ownerUserId: null } : { ownerUserId: params.ownerUserId }) : {}),
    ...(params?.source ? { source: params.source } : {}),
    ...(params?.industryId ? { industryId: params.industryId } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}

const vendorListInclude = {
  _count: { select: { contacts: true, leads: true } },
  owner: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  assignedTo: { select: { id: true, name: true } },
  industry: { select: { id: true, name: true } },
} as const;

/**
 * ## Why a vendor list is account-scoped too, when a vendor is somebody we buy *from*
 *
 * The obvious reading is that this isn't a customer list at all and should be left alone. It was
 * worth checking rather than assuming, and what the records say is that `Company.ownerUserId` means
 * the same thing here as it does on a client: every vendor-type company in the database carries one,
 * they are set by the same `setCompanyOwner` action that tells the person "you were made account
 * manager", and they are the same sales people who own the client records. There is no separate
 * "who buys from this supplier" field that would mean something different — it is one column on one
 * table, and `companies.viewAll` is documented as "somebody sees only the companies they are account
 * manager for", not only the customers.
 *
 * The thing that makes this safe rather than merely consistent is that the people who must never
 * lose sight of a supplier are not restricted in the first place: `companies.viewAll` is granted by
 * default to PURCHASE, ACCOUNTS, SUPPORT and MANAGEMENT, so purchasing's own view of this list is
 * untouched. And a sales executive raising an order still picks any vendor they like — that picker
 * is `listVendorOptions`, which is deliberately unscoped for exactly this reason. What narrows here
 * is only *browsing* the supplier book, which also carries PAN and bank-account details.
 */
export async function listVendors(params?: VendorListParams) {
  const user = await requireUser();
  const rows = await db.company.findMany({
    where: { AND: [await vendorListSide(params?.relationshipType), vendorListWhere(await workspaceClock(), params, await companyCustom(user.id, params, vendorListFields(params))), await companyScope(user.id)] },
    orderBy: { createdAt: "desc" },
    include: vendorListInclude,
    // Security audit, 13 Nov 2026 (SEC-29): as listCompanies — the screens read listVendorsPaged.
    take: UNPAGED_LIST_CEILING,
  });
  // Field access, as every company list shows a company (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.2).
  return maskCompanyRows(user.id, "list", rows);
}

/** One page of the Vendors / Commission Parties lists. */
export async function listVendorsPaged(params: VendorListParams & { page: number; pageSize: number }) {
  const user = await requireUser();
  const where = { AND: [await vendorListSide(params?.relationshipType), vendorListWhere(await workspaceClock(), params, await companyCustom(user.id, params, vendorListFields(params))), await companyScope(user.id)] };
  const [rows, total] = await Promise.all([
    db.company.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: vendorListInclude,
      ...pageSlice(params.page, params.pageSize),
    }),
    db.company.count({ where }),
  ]);
  // A client component draws these rows: a credit limit is a Decimal, which it cannot be handed (toPlain). Field access
  // applied (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.2): a vendor's row carries its PAN and website too.
  return { rows: toPlain(await maskCompanyRows(user.id, "list", rows)), total };
}

/**
 * The companies a picker may offer this person — the `where` behind both `listCompanyOptions` and
 * `searchCustomerOptions`, written once so that searching can never reach further than the list does.
 */
async function companyOptionsWhere(
  userId: string,
  relationshipTypes?: readonly CompanyRelationshipType[],
  /** A side rather than kinds (src/lib/companies/roles.ts): a company with that side as a second role is offered too. */
  side?: CompanySide,
): Promise<Prisma.CompanyWhereInput> {
  const sideWhere = side === "customer" ? await customerSide() : side === "vendor" ? await vendorSide() : null;
  return {
    /**
     * Scoped to the accounts this person manages, or their team's.
     *
     * This list feeds every company picker in the app, and it was returning the whole book to
     * anybody signed in — which is the failure `company-scope.ts` describes as the dangerous one,
     * because a filter that is too wide is never reported. `companies.viewAll` lifts it, and the
     * presets already grant that to the functions that genuinely serve every account: support,
     * purchasing and accounts.
     */
    AND: [await companyScope(userId), ...(sideWhere ? [sideWhere] : [])],
    stage: { not: "DISQUALIFIED" },
    // A reseller's end customer can never be the party we deal with directly — the reseller is.
    managedByResellerId: null,
    ...(relationshipTypes ? { relationshipType: { in: [...relationshipTypes] } } : {}),
  };
}

/** A company as a picker shows it: the name, what kind of account, and the category chip. */
const COMPANY_OPTION_SELECT = {
  id: true,
  name: true,
  relationshipType: true,
  customerCategory: { select: CATEGORY_SELECT },
} as const;

/** A positive whole number of rows to stop at, or no limit — whatever else a caller sends is ignored, not queried with. */
function rowLimit(take: unknown): { take?: number } {
  return typeof take === "number" && Number.isInteger(take) && take > 0 ? { take } : {};
}

/**
 * The company pickers' list. By default every company in reach, each with its contacts — the lead
 * and ticket forms read those.
 *
 * `withContacts: false` leaves the contacts join off for a picker that only shows names; it is most
 * of the payload, and the order form sends this list to the browser. `take` stops at that many rows,
 * for a caller that searches the server for the rest (`searchCustomerOptions`) — ask for one more
 * than you show, and the extra row says the list is incomplete.
 */
export async function listCompanyOptions(params?: {
  relationshipTypes?: CompanyRelationshipType[];
  /** Customers or vendors — by kind or as a second role (src/lib/companies/roles.ts). */
  side?: CompanySide;
  withContacts?: boolean;
  take?: number;
}) {
  const user = await requireUser();
  const where = await companyOptionsWhere(user.id, params?.relationshipTypes, params?.side);
  if (params?.withContacts === false) {
    return db.company.findMany({ where, orderBy: { name: "asc" }, ...rowLimit(params.take), select: COMPANY_OPTION_SELECT });
  }
  // Security audit round three, 14 Nov 2026 (R3-21): each company's contacts came with their names in full, every one of
  // them, whatever the person's contact rule and field access. Now only contacts their contact rule reaches
  // (`contactScope`), each name as the contacts policy shows it in a list.
  const rows = await db.company.findMany({
    where,
    orderBy: { name: "asc" },
    ...rowLimit(params?.take),
    select: {
      ...COMPANY_OPTION_SELECT,
      contacts: { where: await contactScope(user.id), select: { id: true, name: true, designation: true }, orderBy: { isPrimary: "desc" } },
    },
  });
  const people = await contactMasker(user.id, "list", rows.flatMap((r) => r.contacts.map((c) => c.id)));
  if (!people.active) return rows;
  return rows.map((r) => ({ ...r, contacts: r.contacts.map((c) => ({ ...c, name: people.present(c.id, "name", c.name) ?? "" })) }));
}

/** How many customers one search answers with — the picker says so when the cap bites. */
const CUSTOMER_SEARCH_LIMIT = 20;

/**
 * Customers whose name contains what was typed, for the order form's picker once the customer book is
 * too long to send to the browser whole.
 *
 * The same accounts `listCompanyOptions` offers for customers — the scope, nothing disqualified, no
 * reseller's end customer — searched rather than listed: two characters at least (one matches most of
 * the book, and says nothing about which customer is meant), the first twenty by name, and no contacts.
 */
export async function searchCustomerOptions(query: string) {
  const user = await requireUser();
  const typed = String(query ?? "").trim().slice(0, 120);
  if (typed.length < 2) return [];
  // Without its legal form, so "pvt ltd" finds "Private Limited"; kept only where it matches (src/lib/company-name.ts).
  // Or by a name it went by before (src/lib/companies/former-names.ts) — those kept whatever their name now.
  const former = await formerNamesWhere(typed);
  const rows = await db.company.findMany({
    where: {
      ...(await companyOptionsWhere(user.id, undefined, "customer")),
      OR: [{ name: { contains: nameSearchText(typed), mode: "insensitive" } }, ...former],
    },
    orderBy: { name: "asc" },
    take: CUSTOMER_SEARCH_LIMIT,
    select: COMPANY_OPTION_SELECT,
  });
  const byFormer = former.length
    ? new Set((await db.company.findMany({ where: { id: { in: rows.map((r) => r.id) }, AND: former }, select: { id: true } })).map((r) => r.id))
    : new Set<string>();
  return rows.filter((c) => byFormer.has(c.id) || companyNameMatches(c.name, typed));
}

/**
 * The Resellers module's list — channel partners who buy from us for their own customers. Same
 * shape as `listCompanies` so it's plug-compatible with `CompaniesTable`.
 */
type ResellerListParams = {
  search?: string;
  assignedToUserId?: string;
  /** The account manager; "unassigned" for none. */
  ownerUserId?: string;
  source?: CompanySource;
  industryId?: string;
  createdFrom?: string;
  createdTo?: string;
  /** The workspace's own fields filtered on (src/lib/custom-fields/filters.ts). */
  customFilters?: CustomFilterInputs;
};

function resellerListWhere(clock: Clock, params?: ResellerListParams, custom: CompanyCustom = NO_CUSTOM): Prisma.CompanyWhereInput {
  const createdAt = clock.dayRange(params?.createdFrom, params?.createdTo);
  return {
    relationshipType: "RESELLER",
    ...companyNarrowing(params?.search, custom),
    ...(params?.assignedToUserId
      ? params.assignedToUserId === "unassigned"
        ? { assignedToUserId: null }
        : { assignedToUserId: params.assignedToUserId }
      : {}),
    // The account manager (owner, 30 Oct 2026) — not the caller above, who is `assignedTo`.
    ...(params?.ownerUserId ? (params.ownerUserId === "unassigned" ? { ownerUserId: null } : { ownerUserId: params.ownerUserId }) : {}),
    ...(params?.source ? { source: params.source } : {}),
    ...(params?.industryId ? { industryId: params.industryId } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}

const resellerListInclude = {
  _count: { select: { contacts: true, leads: true, products: true, endCustomers: true } },
  resellerProfile: { select: { status: true, tier: true } },
  owner: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  assignedTo: { select: { id: true, name: true } },
  industry: { select: { id: true, name: true } },
  locations: { where: { isPrimary: true }, take: 1, select: { city: true, state: true, gstNumber: true } },
} as const;

/**
 * A reseller is on the buying side — `customerRelationshipTypeValues` counts them as a customer
 * because we invoice the reseller, not their end customer — so this is an account list like any
 * other and scopes the same way.
 */
export async function listResellers(params?: ResellerListParams) {
  const user = await requireUser();
  const rows = await db.company.findMany({
    where: { AND: [resellerListWhere(await workspaceClock(), params, await companyCustom(user.id, params)), await companyScope(user.id)] },
    orderBy: { createdAt: "desc" },
    include: resellerListInclude,
  });
  // Field access, as every company list shows a company (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.2).
  return maskCompanyRows(user.id, "list", rows);
}

export async function listResellersPaged(params: ResellerListParams & { page: number; pageSize: number }) {
  const user = await requireUser();
  // The end-customer tally below is built from this same `where`, so the scope reaches it for free —
  // it counts end customers of the resellers on screen rather than of every reseller in the business.
  const where = { AND: [resellerListWhere(await workspaceClock(), params, await companyCustom(user.id, params)), await companyScope(user.id)] };
  const [rows, total, endCustomerTotal] = await Promise.all([
    db.company.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: resellerListInclude,
      ...pageSlice(params.page, params.pageSize),
    }),
    db.company.count({ where }),
    // Counted across every matching reseller, not just this page, so the header doesn't shrink as you page.
    db.company.count({ where: { managedByReseller: { is: where } } }),
  ]);
  // Field access applied, as on the Companies list (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.2).
  return { rows: toPlain(await maskCompanyRows(user.id, "list", rows)), total, endCustomerTotal };
}

/**
 * The end customers a reseller has bought for — shown on the reseller's page, and the "who is this
 * order for" picker.
 *
 * A guard rather than a filter. The caller names the reseller, so narrowing the rows that come back
 * would protect nothing; the question is whether this viewer may see *that reseller* at all. An end
 * customer is deliberately unreachable except through the reseller who manages it — it is kept out
 * of every other list in this file — so the reseller's account manager is the only line that makes
 * sense to draw. Refusing reads as "this reseller has no end customers", which is a shape every
 * caller already renders.
 */
export async function listEndCustomers(resellerId: string) {
  const user = await requireUser();
  const reseller = await db.company.findUnique({ where: { id: resellerId }, select: { ownerUserId: true, relationshipType: true } });
  const visible = reseller !== null && (await canSeeCompany(user.id, reseller));
  return db.company.findMany({
    where: { managedByResellerId: resellerId, ...(visible ? {} : { id: { in: [] } }) },
    orderBy: { name: "asc" },
    select: { id: true, name: true, companySeq: true, _count: { select: { ordersAsEndCustomer: true } } },
  });
}

/**
 * Every reseller, for the "is this order via a reseller" pickers.
 *
 * Deliberately unscoped, like `listVendorOptions` and `listCommissionPartyOptions`. The line these
 * three sit on: the *account* a document is raised against is scoped, but the counterparties on that
 * document — who we sourced it from, who gets the commission, which channel it went through — are
 * not, because a rep's own customer can perfectly well buy through a reseller somebody else manages,
 * and blocking that would break punching a legitimate order rather than hide anything. Only a name
 * and an id leave here.
 */
export async function listResellerOptions() {
  await requireUser();
  return db.company.findMany({
    where: { relationshipType: "RESELLER" },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}

/**
 * Customer companies as plain name options — for pickers that render only the name, skipping
 * `listCompanyOptions`'s contacts join.
 *
 * Scoped for the same reason and on the same terms as `listCompanyOptions`: this is the same set of
 * client accounts with one join left off, so leaving it open would be a way round that function's
 * scope rather than a different question.
 */
export async function listClientCompanyNameOptions() {
  const user = await requireUser();
  return db.company.findMany({
    where: {
      AND: [await companyScope(user.id), await clientSide()],
      stage: { not: "DISQUALIFIED" },
      managedByResellerId: null,
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}

/** Every vendor-type company, for the "which vendor was this order purchased from" picker on a customer order — excludes Commission Parties, since they're paid a commission, not sourced from. Unscoped on purpose: see `listResellerOptions`. */
export async function listVendorOptions() {
  await requireUser();
  return db.company.findMany({
    // And a customer that's also a vendor (src/lib/companies/roles.ts).
    where: await vendorSide(),
    orderBy: { name: "asc" },
    select: { id: true, name: true, relationshipType: true, paymentTerms: true },
  });
}

/**
 * Every commission-party company, for the "who is this commission paid to" picker on an order's
 * Commission expense line. When `forCompanyId` is given (the order's customer), parties explicitly
 * linked to that customer are flagged and sorted first — but every commission party is still
 * returned, so punching an order never gets blocked on a link nobody set up yet.
 *
 * Unscoped on purpose, for the same reason: see `listResellerOptions`.
 */
export async function listCommissionPartyOptions(forCompanyId?: string) {
  await requireUser();
  const [parties, linkedIds] = await Promise.all([
    db.company.findMany({
      where: { relationshipType: "COMMISSION_PARTY" },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    forCompanyId
      ? db.commissionPartyLink.findMany({ where: { companyId: forCompanyId }, select: { commissionPartyId: true } })
      : Promise.resolve([]),
  ]);
  const linkedSet = new Set(linkedIds.map((l) => l.commissionPartyId));
  return parties
    .map((p) => ({ ...p, linked: linkedSet.has(p.id) }))
    .sort((a, b) => (a.linked === b.linked ? 0 : a.linked ? -1 : 1));
}

export async function getCompany(id: string) {
  const user = await requireUser();
  /**
   * Whose activity on the account this person sees (owner, 8 Oct 2026): their own and their team's,
   * or everybody's with "See everyone's calls, notes & meetings". Filtered in the query, so what
   * they may not read never leaves the database — the Activity pane and the copilot both read this.
   */
  const activityWhere = await timelineAccess(user.id, "view");
  // The leads and orders tabs, each at the viewer's own level for it — the access engine answers both.
  const leadWhere = await leadAccess(user.id, "view");
  const orderWhere = await orderAccess(user.id, "view");
  /**
   * The contacts the same way (owner, 3 Nov 2026 — Phase 2 permission fixes, audit H-4): `contacts.view` and the
   * Contacts record level (`contactScope`), not the permission alone — so "Contacts = None" in the role editor empties
   * the Contacts tab, and the public API's and the app's company and contact reads, which are this one.
   */
  const contactWhere = await contactScope(user.id);
  // An order bought *for* this company belongs to its reseller, which following the account would ask
  // about; it follows this account instead (reached, or null below), as the tab always has.
  const endCustomerOrderWhere = (await accessLevel(user.id, "orders", "view")) === "FOLLOW" ? undefined : orderWhere;
  const company = await db.company.findUnique({
    where: { id },
    include: {
      managedByReseller: { select: { id: true, name: true, companySeq: true } },
      customerCategory: { select: CATEGORY_SELECT },
      contacts: { where: contactWhere, orderBy: { isPrimary: "desc" } },
      leads: {
        where: leadWhere,
        orderBy: { createdAt: "desc" },
        include: {
          owner: { select: { id: true, name: true } },
          contact: { select: { id: true, name: true } },
          activities: {
            where: activityWhere,
            orderBy: { occurredAt: "desc" },
            include: { user: { select: { id: true, name: true } } },
          },
          requirements: {
            orderBy: { createdAt: "desc" },
            include: { item: { select: { id: true, name: true, sku: true, type: true, unit: true, sellingPrice: true } } },
          },
        },
      },
      locations: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
      products: {
        where: orderWhere,
        orderBy: { createdAt: "desc" },
        include: {
          item: {
            select: { id: true, name: true, sku: true, type: true, unit: true, sellingPrice: true, taxRatePercent: true },
          },
          location: { select: { id: true, label: true, gstNumber: true, state: true } },
          vendor: { select: { id: true, companySeq: true, name: true, paymentTerms: true } },
          // On a reseller's own orders, who it was bought for.
          endCustomer: { select: { id: true, companySeq: true, name: true } },
          addedBy: { select: { id: true, name: true } },
          // Seats added part-way through the term, so the list can show the running total rather
          // than only what was bought on day one.
          addons: {
            where: { orderStatus: { not: "CANCELLED" } },
            orderBy: { startDate: "asc" },
            select: { id: true, quantity: true, startDate: true, unitPrice: true },
          },
          // Set once a renewal has been punched, so the renewals tab says so rather than
          // offering to punch a second one.
          renewedBy: { select: { id: true, orderSeq: true, orderStatus: true } },
          allocations: {
            orderBy: { createdAt: "desc" },
            include: {
              allocatedBy: { select: { id: true, name: true } },
              payment: { select: { id: true, paidOn: true, method: true, reference: true } },
            },
          },
        },
      },
      // What a reseller bought *for* this company. The order belongs to the reseller (they're who we
      // invoice), but the product/subscription is this company's — it's their seats, their expiry,
      // their support — so it belongs in their Products & Subscriptions, not the reseller's.
      ordersAsEndCustomer: {
        where: endCustomerOrderWhere,
        orderBy: { createdAt: "desc" },
        include: {
          renewedBy: { select: { id: true, orderSeq: true, orderStatus: true } },
          addons: {
            where: { orderStatus: { not: "CANCELLED" } },
            orderBy: { startDate: "asc" },
            select: { id: true, quantity: true, startDate: true, unitPrice: true },
          },
          item: {
            select: { id: true, name: true, sku: true, type: true, unit: true, sellingPrice: true, taxRatePercent: true },
          },
          location: { select: { id: true, label: true, gstNumber: true, state: true } },
          vendor: { select: { id: true, companySeq: true, name: true, paymentTerms: true } },
          company: { select: { id: true, companySeq: true, name: true } },
          addedBy: { select: { id: true, name: true } },
          allocations: {
            orderBy: { createdAt: "desc" },
            include: {
              allocatedBy: { select: { id: true, name: true } },
              payment: { select: { id: true, paidOn: true, method: true, reference: true } },
            },
          },
        },
      },
      createdBy: { select: { id: true, name: true } },
      owner: { select: { id: true, name: true } },
      assignedTo: { select: { id: true, name: true } },
      assignedBy: { select: { id: true, name: true } },
      industry: { select: { id: true, name: true } },
    },
  });
  if (!company) return null;

  /**
   * The detail view refuses, where a list filters.
   *
   * This is the function that actually matters: the lists above decide what somebody is *offered*,
   * and an id typed into the address bar walks straight past all of them. What comes back here is
   * the whole account — every contact's email and phone, the order book, the payment history, the
   * bank and PAN details on a vendor — so an unscoped `getCompany` would make the rest of this file
   * decorative.
   *
   * `null` rather than an error, deliberately: it is the same answer as "no such company", so a
   * refusal does not confirm that the id exists, and every caller already routes it to `notFound()`.
   */
  if (!(await canSeeCompany(user.id, company))) return null;

  // Redact here rather than in the page: masking in the component would still ship the real email
  // and phone to the browser for anyone who opens devtools.
  const restricted = isResellerManaged(company);
  const canViewRestricted = restricted ? await seesResellerContactDetails(user.id) : true;
  /**
   * The same rule for the view permissions: a part of the account this person may not see is left
   * out here, not hidden by the page. `getCompany` is an endpoint in its own right, and the customer
   * page is only one of the things that can call it. Leads also need to be in the plan (owner, 14 Oct
   * 2026): a workspace that had them keeps them, out of sight, until it has them again.
   */
  const [seesContacts, seesLeads, seesOrders, leadMasker, shown] = await Promise.all([
    canViewContacts(user.id),
    isModuleEnabled("leads"),
    // Any of the three views of its orders (owner, 26 Nov 2026): the page decides which tab shows them.
    Promise.all((["orders.view", "subscriptions.view", "renewals.view"] as const).map((k) => hasEffectivePermission(user.id, k))).then((held) => held.some(Boolean)),
    listLeadMasker(user.id),
    companyMasker(user.id, "detail"),
  ]);
  // The company's own fields as its page shows them (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.2,
  // src/lib/companies/masking.ts): website, PAN, every location's address and GSTIN — and the same location again where
  // an order names it — with `masked` saying which, so the forms on the page leave them alone.
  return toPlain({
    ...maskCompanyWith(shown, company),
    // Then field access, as the customer's own page shows them (owner, 3 Nov 2026 — src/lib/contacts/masking.ts).
    contacts: seesContacts ? await maskContactRows(user.id, "detail", company.contacts.map((c) => redactContactDetails(c, { restricted, canViewRestricted }))) : [],
    // The account's leads as this person's field access shows a lead in a list.
    leads: seesLeads ? await maskLeads(leadMasker, company.leads) : [],
    // This company's own locations, so today's "Show" of it applies as on the rest of its page (Phase 3 wave B).
    products: seesOrders ? company.products.map((o) => ({ ...o, location: shown.forCompany(company.id).location(o.location) })) : [],
    ordersAsEndCustomer: seesOrders ? company.ordersAsEndCustomer.map((o) => ({ ...o, location: shown.forCompany(company.id).location(o.location) })) : [],
    // Read on its own (src/lib/companies/default-currency.ts): null is the workspace's own currency.
    defaultCurrency: await companyCurrency(company.id),
  });
}

export async function addCompanyProduct(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  // Nothing calls this from a screen any more, and it asked for nothing but a session: any signed-in
  // person could add an order to any account. Now the same permission editing one takes, on an
  // account the order would be theirs to edit on.
  if (!(await hasEffectivePermission(user.id, "products.edit"))) {
    return { ok: false, error: "You don't have permission to edit products." };
  }
  const itemsEnabled = await isModuleEnabled("items");
  if (!itemsEnabled) {
    return { ok: false, error: "The Items & Inventory module is disabled." };
  }
  const parsed = addCompanyProductSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { companyId, locationId, itemId, vendorId, quantity, notes, poNumber, startDate, endDate } = parsed.data;

  const company = await db.company.findUnique({ where: { id: companyId } });
  if (!company || !(await mayAddTo(user.id, "orders", company))) {
    return { ok: false, error: "Company not found." };
  }
  const location = await db.companyLocation.findUnique({ where: { id: locationId } });
  if (!location || location.companyId !== companyId) {
    return { ok: false, error: "That location does not belong to this company." };
  }
  const vendor = await db.company.findUnique({ where: { id: vendorId } });
  if (!vendor || !(await isVendorSide(vendor))) {
    return { ok: false, error: "That's not a valid vendor." };
  }

  const product = await db.companyProduct.create({
    data: {
      companyId,
      locationId,
      itemId,
      vendorId,
      quantity,
      notes: notes || null,
      poNumber: poNumber || null,
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
      addedByUserId: user.id,
    },
  });

  await recordAudit({ userId: user.id, action: "CREATE", entityType: "Order", entityId: product.id, entityLabel: `Order for ${company.name}` });

  revalidatePath(`/companies/${companyId}`);
  revalidatePath("/renewals");
  return { ok: true, data: { id: product.id } };
}

export async function updateCompanyProduct(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "products.edit"))) {
    return { ok: false, error: "You don't have permission to edit products." };
  }
  const parsed = updateCompanyProductSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, locationId, quantity, notes, poNumber, startDate, endDate } = parsed.data;

  const product = await db.companyProduct.findUnique({ where: { id } });
  if (!product || !(await mayAccess(user.id, "orders", "edit", id))) {
    return { ok: false, error: "Product not found." };
  }
  const location = await db.companyLocation.findUnique({ where: { id: locationId } });
  if (!location || location.companyId !== product.companyId) {
    return { ok: false, error: "That location does not belong to this company." };
  }
  // Past approval, quantity and term are what was approved and billed (src/lib/validation/company-product.ts) — the
  // super admin's alone to correct.
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");
  if (
    termsLocked(product.orderStatus) &&
    !(await actingAsSuperAdmin(user.id)) &&
    (quantity !== product.quantity || (startDate || "") !== day(product.startDate) || (endDate || "") !== day(product.endDate))
  ) {
    return {
      ok: false,
      error: "This order is already approved, so its quantity and dates can't be changed here. Add seats or renew it instead.",
    };
  }

  await db.companyProduct.update({
    where: { id },
    data: {
      locationId,
      quantity,
      notes: notes || null,
      poNumber: poNumber || null,
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
    },
  });

  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Order", entityId: id, entityLabel: formatOrderId(product.orderSeq) });

  revalidatePath(`/companies/${product.companyId}`);
  revalidatePath("/renewals");
  return { ok: true, data: { id } };
}

export async function removeCompanyProduct(id: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  // Deleting an order is the workspace's super admin's alone (owner, 27 Oct 2026), like tickets and companies.
  if (!(await actingAsSuperAdmin(user.id))) return { ok: false, error: "Only the workspace's super admin can delete orders." };
  const product = await db.companyProduct.findUnique({
    where: { id },
    include: {
      item: { select: { name: true } },
      // Both of these follow the row out through `onDelete: Cascade` and neither was being looked
      // at first.
      addons: { select: { id: true } },
      allocations: { select: { id: true, amount: true, paymentId: true } },
    },
  });
  if (!product || !(await mayAccess(user.id, "orders", "delete", id))) {
    return { ok: false, error: "Product not found." };
  }

  /**
   * What a one-click delete used to take with it, silently.
   *
   * `CompanyProduct.parentId` and `PaymentAllocation.companyProductId` both cascade, so removing a
   * ten-seat subscription also removed the mid-term addons co-termed to it — their pro-rata
   * snapshots and all — and detached the customer's payment from the thing it paid for, while the
   * company's "received" total went on counting it. There was no audit row to reconstruct any of it
   * from.
   *
   * Refused rather than cascaded. A deletion that quietly destroys a sale and unbalances a customer
   * ledger is not a deletion anybody meant to make, and the two things blocking it are both things
   * the person can undo deliberately if they really meant it.
   */
  if (product.addons.length > 0) {
    return {
      ok: false,
      error:
        product.addons.length === 1
          ? "This order has an addon co-termed to it, which would be deleted with it. Remove the addon first."
          : `This order has ${product.addons.length} addons co-termed to it, which would be deleted with it. Remove them first.`,
    };
  }

  if (product.allocations.length > 0) {
    const total = product.allocations.reduce((sum, a) => sum + Number(a.amount), 0);
    return {
      ok: false,
      error: `${basePrefix()}${total.toLocaleString(baseLocale(), { minimumFractionDigits: 2 })} of payment is applied to this order. Un-apply it first, or the money would be left unallocated with nothing recording why.`,
    };
  }

  // An invoice line would quietly lose the order it billed, and the order's Invoicing card its count.
  const invoiced = await db.tradeDocumentLine.count({ where: { companyProductId: id } });
  if (invoiced > 0) return { ok: false, error: "This order is on an invoice or another document. Cancel or delete that document first." };

  try {
    await db.companyProduct.delete({ where: { id } });
  } catch {
    return { ok: false, error: "This order is still used somewhere in Deskzo, so it can't be deleted." };
  }

  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "CompanyProduct",
    entityId: id,
    entityLabel: `Deleted order for ${product.item?.name ?? "an item"} (qty ${product.quantity})`,
  });

  revalidatePath(`/companies/${product.companyId}`);
  revalidatePath("/renewals");
  revalidatePath("/orders");
  return { ok: true, data: null };
}

/**
 * Bulk edits from a company list's selection bar. Vendor status is checked per company rather than
 * applied blindly: only vendor-type companies have one, and letting a mixed selection set it on a
 * client would put a status on a record that has no concept of it.
 */
export async function bulkUpdateCompanies(input: unknown): Promise<ActionResult<{ count: number }>> {
  const user = await requireUser();
  const parsed = bulkUpdateCompaniesSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { companyIds, assignedToUserId, ownerUserId, vendorStatus, addTags } = parsed.data;
  if (!assignedToUserId && !ownerUserId && !vendorStatus && addTags.length === 0) {
    return { ok: false, error: "Pick something to apply to the selection." };
  }

  /**
   * Only companies this person can see — for every part of this action, not just the caller.
   *
   * It took any ids, so vendor status, tags and the caller could all be changed on accounts the
   * person could not open. A selection comes from a list that is already scoped, so a mismatch
   * means a crafted request, and it is refused whole rather than applied to the part that fits.
   */
  const companies = await db.company.findMany({
    where: { AND: [{ id: { in: companyIds } }, await companyScope(user.id)] },
    select: { id: true, name: true, relationshipType: true, tags: true, ownerUserId: true },
  });
  if (companies.length === 0) return { ok: false, error: "Those companies no longer exist." };
  if (companies.length !== new Set(companyIds).size) {
    return { ok: false, error: "Some of the selected companies are not yours to change." };
  }

  // The account manager, for every one ticked (owner, 30 Oct 2026): `setCompanyOwner`'s rule for each — all of them
  // or none, as with the caller — then a line on each whose manager moves, and one bell for the new manager.
  if (ownerUserId) {
    const nextOwner = ownerUserId === "unassign" ? null : ownerUserId;
    const rights = await reassignRights(user.id);
    const refused = companies.filter((c) => !mayChangeAccountManager(rights, user.id, c));
    if (refused.length) {
      return { ok: false, error: `You can't change who manages ${refused.length === 1 ? refused[0]!.name : `${refused.length} of these accounts`}.` };
    }
    if (!nextOwner && !mayLeaveUnassigned(rights)) {
      return { ok: false, error: "Hand them to a colleague — only someone who can reassign accounts may leave them with nobody." };
    }
    if (nextOwner) {
      const owner = await db.user.findUnique({ where: { id: nextOwner }, select: { active: true } });
      if (!owner?.active) return { ok: false, error: "That person is not a valid, active user." };
      const notManager = await assignRefusal("accountManager", nextOwner);
      if (notManager) return { ok: false, error: notManager };
    }
    await db.company.updateMany({ where: { id: { in: companyIds } }, data: { ownerUserId: nextOwner } });
    const to = await nameOf(nextOwner);
    const moved = companies.filter((c) => c.ownerUserId !== nextOwner);
    await recordManagerChange(moved.map((c) => ({ companyId: c.id, fromUserId: c.ownerUserId })), nextOwner, user.id);
    for (const c of moved) {
      await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Company", entityId: c.id, entityLabel: `${c.name} — account manager: ${await nameOf(c.ownerUserId)} → ${to}` });
    }
    if (nextOwner && nextOwner !== user.id && moved.length) {
      await notifyUser({
        userId: nextOwner,
        type: "ACCOUNT_MANAGER_ASSIGNED",
        title: "You were made account manager",
        message: `${moved.length} ${moved.length === 1 ? "account" : "accounts"} handed to you`,
        link: "/customers",
      });
    }
  }

  if (vendorStatus) {
    const clients = companies.filter((c) => c.relationshipType === "CLIENT");
    if (clients.length > 0) {
      return { ok: false, error: `${clients.length} of the selected companies are clients, which don't have a vendor status.` };
    }
    await db.company.updateMany({ where: { id: { in: companyIds } }, data: { vendorStatus } });
  }

  if (assignedToUserId) {
    const nextId = assignedToUserId === "unassign" ? null : assignedToUserId;
    if (nextId) {
      const assignee = await db.user.findUnique({ where: { id: nextId }, select: { id: true, active: true } });
      if (!assignee || !assignee.active) return { ok: false, error: "That person is not a valid, active user." };
      const notCaller = companies.some((c) => c.relationshipType === "CLIENT") ? await assignRefusal("caller", nextId) : null;
      if (notCaller) return { ok: false, error: notCaller };
    }
    const checked = await checkCallerChange(user.id, companyIds, nextId);
    if (!checked.ok) return checked;
    await db.company.updateMany({
      where: { id: { in: companyIds } },
      data: {
        assignedToUserId: nextId,
        assignedByUserId: nextId ? user.id : null,
        assignedAt: nextId ? new Date() : null,
      },
    });
    // After the write, from the values read before it — a log line for a change that failed is a lie.
    await auditCallerChange(user.id, checked.data, nextId);
    if (nextId && nextId !== user.id) {
      await notifyUser({
        userId: nextId,
        type: "CALLER_ASSIGNED",
        title: "You were assigned as caller",
        message: `${companyIds.length} ${companyIds.length === 1 ? "company" : "companies"} assigned to you`,
        link: "/companies",
      });
    }
  }

  // Tags are added rather than replaced — a bulk action that silently wiped every existing tag
  // would be a data-loss button wearing a helpful label.
  if (addTags.length > 0) {
    for (const company of companies) {
      const merged = Array.from(new Set([...company.tags, ...addTags]));
      if (merged.length !== company.tags.length) {
        await db.company.update({ where: { id: company.id }, data: { tags: merged } });
      }
    }
  }

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Company",
    entityId: companyIds[0],
    entityLabel: `Bulk updated ${companyIds.length} company/companies`,
  });
  for (const path of ["/companies", "/customers", "/vendors", "/commission-parties", "/resellers"]) {
    revalidatePath(path);
  }
  return { ok: true, data: { count: companyIds.length } };
}

/**
 * How many vendor-type companies are still onboarding, across the whole filtered set rather than
 * the current page — a header badge that only counted the visible rows would drop as you paged.
 */
export async function countVendorsOnboarding(params?: VendorListParams) {
  const user = await requireUser();
  // Scoped to match `listVendorsPaged`, or the badge would advertise a number of vendors larger
  // than the list underneath it can account for.
  return db.company.count({
    where: { AND: [await vendorListSide(params?.relationshipType), vendorListWhere(await workspaceClock(), params, await companyCustom(user.id, params, vendorListFields(params))), await companyScope(user.id), { vendorStatus: "ONBOARDING" }] },
  });
}

/**
 * One company, two roles (src/lib/companies/roles.ts — owner, 19 Oct 2026): adds or takes off the side a
 * company has besides its main kind — a vendor that also buys from us, a customer we also buy from. Whoever
 * may change the company may, while that side's module is on; never while viewing as somebody else.
 */
export async function setCompanySecondRole(input: {
  companyId: string;
  side: string;
  on: boolean;
}): Promise<ActionResult<{ added: CompanySide | null; company: { id: string; name: string; contacts: { id: string; name: string; designation: string }[] } }>> {
  const user = await requireUser();
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const side: CompanySide | null = input?.side === "customer" || input?.side === "vendor" ? input.side : null;
  if (!side) return { ok: false, error: "Choose customer or vendor." };
  if (!(await hasEffectivePermission(user.id, "companies.changeRole"))) return { ok: false, error: "Changing a company's role needs the right to — ask an admin." };
  const company = await db.company.findUnique({ where: { id: String(input.companyId ?? "") }, select: { id: true, name: true } });
  if (!company || !(await mayAccess(user.id, "companies", "edit", company.id))) return { ok: false, error: "Company not found." };
  const on = input.on === true;
  if (on && !(await isModuleEnabled(side === "vendor" ? "vendors" : "companies"))) {
    return { ok: false, error: side === "vendor" ? "Vendors aren't on in this workspace." : "Companies aren't on in this workspace." };
  }
  const changed = await setCompanyRole(company.id, side, on);
  if (!changed.ok) return changed;
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Company", entityId: company.id, entityLabel: `${company.name} — ${on ? "also" : "no longer"} a ${side}` });
  revalidatePath("/companies");
  revalidatePath("/vendors");
  // What a form that wanted a new company of this name needs to use this one instead — the lead form's picker.
  const contacts = await db.contact.findMany({ where: { companyId: company.id, ...STILL_THERE }, orderBy: { isPrimary: "desc" }, select: { id: true, name: true, designation: true } });
  return { ok: true, data: { added: on ? side : null, company: { id: company.id, name: company.name, contacts } } };
}

/**
 * A customer made a reseller, or a reseller a customer (owner, 29 Oct 2026): the one move allowed between the client
 * and reseller lists. Both buy from us, so the orders, invoices, payments and the tabs that show them are the same
 * either way — unlike customer to vendor, which `updateCompany` refuses for hiding that history. A reseller's end
 * customer can't become a reseller itself, and a reseller with end customers of its own can't stop being one: they'd
 * be left without theirs. Its reseller profile is opened on the way in and kept on the way out, for coming back.
 */
export async function changeCustomerKind(input: { companyId: string; to: string }): Promise<ActionResult<{ kind: "CLIENT" | "RESELLER" }>> {
  const user = await requireUser();
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const to = input?.to === "RESELLER" || input?.to === "CLIENT" ? input.to : null;
  if (!to) return { ok: false, error: "Choose customer or reseller." };
  if (!(await hasEffectivePermission(user.id, "companies.changeRole"))) return { ok: false, error: "Changing a company's role needs the right to — ask an admin." };
  const company = await db.company.findUnique({
    where: { id: String(input?.companyId ?? "") },
    select: { id: true, name: true, relationshipType: true, managedByResellerId: true },
  });
  if (!company || !(await mayAccess(user.id, "companies", "edit", company.id))) return { ok: false, error: "Company not found." };
  const from = company.relationshipType;
  if (from === to) return { ok: true, data: { kind: to } };
  if (from !== "CLIENT" && from !== "RESELLER") return { ok: false, error: "Only a customer can become a reseller, and a reseller a customer." };
  if (!(await isModuleEnabled("resellers"))) return { ok: false, error: "Resellers aren't on in this workspace." };
  if (to === "RESELLER" && company.managedByResellerId) {
    return { ok: false, error: `${company.name} is a reseller's end customer — it can't be a reseller itself. Take it off that reseller first.` };
  }
  if (to === "CLIENT") {
    const ends = await db.company.count({ where: { managedByResellerId: company.id } });
    if (ends > 0) {
      return { ok: false, error: `${company.name} has ${ends} end customer${ends === 1 ? "" : "s"} of its own — move ${ends === 1 ? "it" : "them"} to another reseller, or off, first.` };
    }
  }
  await db.$transaction(async (tx) => {
    await tx.company.update({ where: { id: company.id }, data: { relationshipType: to }, select: { id: true } });
    if (to === "RESELLER") await tx.resellerProfile.upsert({ where: { companyId: company.id }, create: { companyId: company.id }, update: {}, select: { id: true } });
  });
  const label = (k: string) => (k === "RESELLER" ? "Reseller" : "Customer");
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Company",
    entityId: company.id,
    entityLabel: `${company.name} — made a ${to === "RESELLER" ? "reseller" : "customer"}`,
    changes: [{ field: "relationshipType", label: "Relationship", from: label(from), to: label(to) }],
  });
  revalidatePath("/companies");
  revalidatePath("/customers");
  revalidatePath("/resellers");
  return { ok: true, data: { kind: to } };
}

/** Who looks after a company's second role's side — a vendor manager, or an account manager — or nobody (null). */
export async function setCompanySideOwner(input: { companyId: string; userId: string | null }): Promise<ActionResult<null>> {
  const user = await requireUser();
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const company = await db.company.findUnique({ where: { id: String(input?.companyId ?? "") }, select: { id: true, name: true, relationshipType: true } });
  if (!company || !(await mayAccess(user.id, "companies", "edit", company.id))) return { ok: false, error: "Company not found." };
  const roles = await rolesOf(company);
  if (!roles.added) return { ok: false, error: "It has one role only — add the other first." };
  const userId = input?.userId ? String(input.userId) : null;
  if (userId) {
    const person = await db.user.findFirst({ where: { id: userId, active: true, kind: "MEMBER" }, select: { id: true } });
    if (!person) return { ok: false, error: "Choose somebody active in the workspace." };
  }
  await setSideOwner(company.id, userId);
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Company", entityId: company.id, entityLabel: `${company.name} — ${roles.added === "vendor" ? "vendor manager" : "account manager"} changed` });
  revalidatePath("/companies");
  revalidatePath("/vendors");
  return { ok: true, data: null };
}
