import { z } from "zod";
import { tooLong, tooMany } from "@/lib/validation/text";
import { ifscSchema } from "@/lib/ifsc";
import { workspacePack } from "@/lib/country-pack";
import type { CompanyRelationshipType } from "@prisma/client";
import { paymentTermsValues } from "@/lib/gst";
import { companyLocationFieldsSchema } from "@/lib/validation/company-location";
import { EMPLOYEE_BAND_KEYS } from "@/lib/company-size";
import { CURRENCY_CODES } from "@/lib/currency";

export const companySourceValues = ["LINKEDIN", "REFERRAL", "INBOUND", "OTHER"] as const;

export const relationshipTypeValues = [
  "CLIENT",
  "RESELLER",
  "VENDOR",
  "OEM",
  "DISTRIBUTOR",
  "PARTNER",
  "COMMISSION_PARTY",
  "OTHER",
] as const;

export const relationshipTypeLabels: Record<(typeof relationshipTypeValues)[number], string> = {
  CLIENT: "Client",
  RESELLER: "Reseller",
  VENDOR: "Vendor",
  OEM: "OEM",
  DISTRIBUTOR: "Distributor",
  PARTNER: "Partner",
  COMMISSION_PARTY: "Commission Party",
  OTHER: "Other",
};

/**
 * The buying side — companies we sell to, so orders, payments, subscriptions and renewals hang off
 * them. Resellers count: we invoice the reseller, not their end customer. Use this wherever the
 * question is "can this company hold an order", rather than testing `relationshipType !== "CLIENT"`.
 */
export const customerRelationshipTypeValues = ["CLIENT", "RESELLER"] as const;

export function isCustomerRelationshipType(type: CompanyRelationshipType) {
  return customerRelationshipTypeValues.some((t) => t === type);
}

/**
 * The supply/partner side — everything that isn't a customer or a commission party, shown in the
 * Vendors module. Commission parties get their own module even though they share the same
 * onboarding lifecycle. This is the single definition of "counts as a vendor": use it for Prisma
 * filters (`relationshipType: { in: vendorRelationshipTypeValues }`) and membership checks too, so
 * the set can't drift between the list queries, the dashboard, and order processing.
 */
export const vendorRelationshipTypeValues = relationshipTypeValues.filter(
  (t) => !isCustomerRelationshipType(t) && t !== "COMMISSION_PARTY",
);

export function isVendorRelationshipType(type: CompanyRelationshipType) {
  return vendorRelationshipTypeValues.some((t) => t === type);
}

/**
 * Whose own fields a company takes (owner, 8 Oct 2026): a vendor's under Settings › Custom fields ›
 * Vendors, every other company's — customers, resellers, commission parties — under Companies.
 */
export function companyFieldEntity(type: CompanyRelationshipType): "COMPANY" | "VENDOR" {
  return isVendorRelationshipType(type) ? "VENDOR" : "COMPANY";
}

/**
 * The companies we pay that keep bank accounts on their record (src/actions/company-bank.ts): the
 * vendor family and resellers. Not a client (we never pay one), nor a commission party, whose payee
 * accounts are their own list (CommissionPartyAccount).
 */
export function holdsBankAccounts(type: CompanyRelationshipType) {
  return type === "RESELLER" || isVendorRelationshipType(type);
}

/** Fixed to a single option — the Commission Parties module's "New" form doesn't let you pick a different relationship type. */
export const commissionPartyRelationshipTypeValues = ["COMMISSION_PARTY"] as const;

/** Fixed to a single option — the plain Companies module's "New" form is CLIENT-track only; Reseller/Vendor/Commission Party companies are created from their own dedicated modules. */
export const clientRelationshipTypeValues = ["CLIENT"] as const;

/** Fixed to a single option — the Resellers module's "New" form. */
export const resellerRelationshipTypeValues = ["RESELLER"] as const;

export const vendorStatusValues = ["ONBOARDING", "ACTIVE", "INACTIVE"] as const;

export const vendorStatusLabels: Record<(typeof vendorStatusValues)[number], string> = {
  ONBOARDING: "Onboarding",
  ACTIVE: "Active",
  INACTIVE: "Inactive",
};

export const contactDesignationValues = [
  "IT_MANAGER",
  "PURCHASE_MANAGER",
  "IT_HEAD",
  "DIRECTOR",
  "CEO",
  "CIO",
  "HR",
  "OTHER",
] as const;

/** As a person's role reads beside their name — "IT manager", not "IT_MANAGER". */
export const contactDesignationLabels: Record<(typeof contactDesignationValues)[number], string> = {
  IT_MANAGER: "IT manager",
  PURCHASE_MANAGER: "Purchase manager",
  IT_HEAD: "IT head",
  DIRECTOR: "Director",
  CEO: "CEO",
  CIO: "CIO",
  HR: "HR",
  OTHER: "Other",
};

/**
 * A contact's designation as it reads beside their name: its name from the workspace's list, else its
 * type's label (a record made before the list, or by an import) — and nothing for "Other".
 */
export function contactRoleLabel(name: string | null | undefined, kind: (typeof contactDesignationValues)[number]): string | null {
  if (name) return name;
  return kind === "OTHER" ? null : contactDesignationLabels[kind];
}

export const contactInputSchema = z.object({
  name: z.string().trim().max(200, tooLong(200)).min(1, "Contact name is required"),
  designation: z.enum(contactDesignationValues).default("OTHER"),
  /**
   * The designation's name, from the workspace's list or new to it (src/lib/contacts/designations.ts).
   * Sent by every contact form; blank clears it. Left out, only the type above is set.
   */
  designationName: z.string().max(80, "At most 80 characters").optional(),
  // Lowercased, as the contact importer stores it. Saved as typed, "PRIYA@EXAMPLE.COM" and
  // "priya@example.com" were two different contacts to every comparison and every duplicate check,
  // and an export re-imported as a change to a record nobody had touched.
  email: z.string().trim().max(254, tooLong(254)).toLowerCase().email("Invalid email").optional().or(z.literal("")),
  phone: z.string().trim().max(100, tooLong(100)).optional().or(z.literal("")),
  // "linkedin.com/in/priya" is how a profile is usually copied: taken as https.
  linkedinUrl: z
    .string()
    .trim()
    .max(2000, tooLong(2000))
    .transform((v) => (v && !/^https?:\/\//i.test(v) ? `https://${v}` : v))
    .pipe(z.string().max(2000, tooLong(2000)).url("Enter a LinkedIn address, like linkedin.com/in/name").or(z.literal("")))
    .optional(),
  isPrimary: z.boolean().default(false),
  /** Pre-selected when a document for this company is emailed — see src/actions/document-mail.ts. */
  receivesDocuments: z.boolean().default(false),
  /** The workspace's own fields (src/lib/custom-fields) — checked by the action against its definitions. */
  customFields: z.record(z.string().max(100, tooLong(100)), z.unknown()).optional(),
});

/**
 * The workspace's own contact fields that are contact details in their own right — a second phone,
 * another email. On a reseller's end customer they are hidden as the email and phone are
 * (src/lib/reseller.ts `redactContactDetails`), and a save that couldn't show them keeps them.
 */
export function isContactDetailField(type: string): boolean {
  return type === "EMAIL" || type === "PHONE";
}

/**
 * A company's size, as a band from `EMPLOYEE_BANDS` — or blank.
 *
 * The forms deal in bands; the server turns one into the number stored (`countForBand`), keeping a
 * more precise count it already holds. See src/lib/company-size.ts.
 */
const employeeBandField = z.enum(EMPLOYEE_BAND_KEYS).optional().or(z.literal(""));

const tagsField = z.preprocess((v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}, z.array(z.string().max(200, tooLong(200))).max(200, tooMany(200, "tags")));

/**
 * A company's website and LinkedIn are shown as links, so a `javascript:` or `data:` address is refused where it is
 * typed (security audit, 11 Nov 2026 — SEC-69) — and says so, where the form used to do nothing.
 */
const isWebLink = (v: string) => !/^\s*(javascript|data|vbscript|file|blob)\s*:/i.test(v);
const NOT_A_WEB_LINK = "Enter a web address, like example.com — that kind of link isn't allowed.";

const companyDetailsShape = {
  name: z.string().trim().max(200, tooLong(200)).min(2, "Company name is required"),
  industryId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  category: z.string().trim().max(200, tooLong(200)).optional().or(z.literal("")),
  /** Where the customer sits — see src/lib/customers/categories.ts. "" takes them out. */
  customerCategoryId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  // A key of the workspace's company types (src/lib/companies/company-types.ts); the action checks it's one of theirs.
  companyType: z.string().trim().max(48).regex(/^[A-Z0-9_]*$/, "Choose a company type from the list.").optional().or(z.literal("")),
  relationshipType: z.enum(relationshipTypeValues).default("CLIENT"),
  website: z.string().trim().max(2000, tooLong(2000)).refine(isWebLink, NOT_A_WEB_LINK).optional().or(z.literal("")),
  linkedinUrl: z.string().trim().max(2000, tooLong(2000)).refine(isWebLink, NOT_A_WEB_LINK).optional().or(z.literal("")),
  employeeBand: employeeBandField,
  // Advance unless somebody agrees otherwise — see Company.paymentTerms.
  paymentTerms: z.enum(paymentTermsValues).default("ADVANCE"),
  /** Why longer terms than the customer's credit rating supports — required only then. See src/lib/credit/guard.ts. */
  creditOverrideReason: z.string().trim().max(500).optional().or(z.literal("")),
  dunsNumber: z.string().trim().max(100, tooLong(100)).optional().or(z.literal("")),
  tags: tagsField,
  source: z.enum(companySourceValues).default("OTHER"),
  /**
   * The currency they're quoted and billed in (owner, 30 Oct 2026): a code from CURRENCIES, "" for the workspace's
   * own. Left out, it stays as it is — a form that doesn't show it can't clear it.
   */
  defaultCurrency: z
    .string()
    .trim()
    .max(100, tooLong(100))
    .refine((v) => v === "" || (CURRENCY_CODES as readonly string[]).includes(v), "Choose a currency from the list.")
    .optional(),
};

export const createCompanySchema = z.object({
  ...companyDetailsShape,
  /** Set only when creating a reseller's end customer from that reseller's page — see `Company.managedByResellerId`. */
  managedByResellerId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  // The first address a company gets is both its billing and its shipping address until somebody
  // says otherwise. That is true of nearly every customer, and starting with neither ticked means
  // the first invoice has nothing to default from.
  location: companyLocationFieldsSchema.default({
    label: "Head Office",
    gstTreatment: "UNREGISTERED",
    isBilling: true,
    isShipping: true,
  }),
  // Created without the workspace's own fields: those are filled in on each contact afterwards.
  contacts: z.array(contactInputSchema.omit({ customFields: true })).max(500, tooMany(500, "contacts")).default([]),
  /** The workspace's own fields (src/lib/custom-fields) — checked by the action against its definitions. */
  customFields: z.record(z.string().max(100, tooLong(100)), z.unknown()).optional(),
});

export const updateCompanySchema = z.object({
  id: z.string().max(100, tooLong(100)).min(1),
  ...companyDetailsShape,
});

export const updateContactSchema = z.object({
  id: z.string().max(100, tooLong(100)).min(1),
  ...contactInputSchema.shape,
});

export type CreateCompanyInput = z.infer<typeof createCompanySchema>;
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;
export type ContactInput = z.infer<typeof contactInputSchema>;
export type UpdateContactInput = z.infer<typeof updateContactSchema>;

// Moved to its own module so client components can apply the duplicate rule cheaply; re-exported so
// every existing import keeps working.
export { normalizeCompanyName } from "@/lib/company-name";

export const assignCompaniesSchema = z.object({
  companyIds: z.array(z.string().max(100, tooLong(100)).min(1)).min(1, "Select at least one company").max(1000, tooMany(1000)),
  userId: z.string().max(100, tooLong(100)).min(1, "Choose someone to assign to"),
});

// India's; another country's pack has no PAN to check (src/lib/country-pack.ts).
export const panField = z
  .string()
  .trim()
  .max(100, tooLong(100))
  .toUpperCase()
  .refine((v) => !workspacePack().india || /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v), "PAN must look like ABCDE1234F")
  .optional()
  .or(z.literal(""));

// Cleaned of what a paste carries before it's checked (src/lib/ifsc.ts).
export const ifscField = ifscSchema("IFSC must look like HDFC0001234 — four letters, a zero, then six characters.");

/**
 * Compliance details for a company we pay — set separately from the main company form, same pattern as
 * `vendorCode`. Its bank accounts are a list of their own since 8 Oct 2026 (src/lib/validation/bank-account.ts).
 */
export const payoutDetailsSchema = z.object({
  panNumber: panField,
});

export type PayoutDetailsInput = z.infer<typeof payoutDetailsSchema>;

export type AssignCompaniesInput = z.infer<typeof assignCompaniesSchema>;

export const bulkUpdateCompaniesSchema = z.object({
  companyIds: z.array(z.string().max(100, tooLong(100)).min(1)).min(1, "Select at least one company").max(1000, tooMany(1000)),
  /** "" leaves the field alone; "unassign" clears the caller. */
  assignedToUserId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  /** The account manager (owner, 30 Oct 2026): "" leaves it alone; "unassign" leaves the accounts with nobody. */
  ownerUserId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  vendorStatus: z.enum(vendorStatusValues).optional().or(z.literal("")),
  /** Tags to add to every selected company, on top of what each already has. */
  addTags: z.array(z.string().trim().max(200, tooLong(200)).min(1)).max(100, tooMany(100, "tags")).default([]),
});

export const bulkUpdateContactsSchema = z.object({
  contactIds: z.array(z.string().max(100, tooLong(100)).min(1)).min(1, "Select at least one contact").max(1000, tooMany(1000)),
  designation: z.enum(contactDesignationValues).optional().or(z.literal("")),
  /** A designation from the workspace's list, or new to it (src/lib/contacts/designations.ts). */
  designationName: z.string().max(80).optional(),
  /** Deleting is separate from editing, so a mis-click on a dropdown can't remove records. */
  action: z.enum(["update", "delete"]).default("update"),
});
