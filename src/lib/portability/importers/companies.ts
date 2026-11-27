import { importRuleRefusal } from "@/lib/field-rules/server";
import { companyIdByName } from "@/lib/companies/by-name";
import { CompanyStage, CompanySource, type PaymentTerms, type Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { valuesFor } from "@/lib/custom-fields/server";
import { isVendorRelationshipType, normalizeCompanyName } from "@/lib/validation/company";
import { assignVendorCodes } from "@/lib/companies/vendor-code";
import { GST_STATE_CODES, isValidGstin, stateCodeFromName } from "@/lib/gst-engine";
import { paymentTermsLabels, paymentTermsValues } from "@/lib/gst";
import { DEFAULT_COUNTRY, isIndia } from "@/lib/geo/countries";
import { optionalUserRef } from "./lookups";
import { mayAccessAccount, mayAccessContactsOf } from "@/lib/authz/access";
import { can } from "@/lib/authz/resolve";
import { moduleAccessFor } from "@/lib/modules-access";
import { designationFromTitle } from "@/lib/lead-capture/intake";
import { companyMasker, hiddenCustomKeys, type CompanyMasker } from "@/lib/companies/masking";
import {
  createRow,
  diff,
  errorRow,
  updateRow,
  parseEnum,
  RowReader,
  type FieldChange,
  type PlannedRow,
  type Importer,
  type ImportContext,
  type Resolved,
} from "./types";

/**
 * Companies, and the three other kinds of party that live in the same table.
 *
 * `relationshipType` separates clients, vendors, resellers and commission agents, and it is taken
 * from the area being imported into rather than from a column. Importing a vendor list should
 * produce vendors whatever the file says, and a mistyped Type cell that quietly filed a supplier in
 * the customer pool would be found much later, by somebody wondering why they are being marketed to.
 *
 * Offices (owner, 28 Oct 2026): GSTIN, address, city, state, PIN and country are an address of the company — a GSTIN
 * belongs to an address, one per state — with PAN, and for a vendor its payment terms and vendor code. A company with
 * offices in several states is several rows under one name, an office each (`officeFor`): a row's GSTIN finds the
 * address that has it, fills the main one while that has none, or adds a branch; a row without one is the main
 * address. The export writes the same, the main office on the company's row and each other registered one on a row
 * of its own (src/lib/portability/exporters/crm.ts), so the file goes round. Bank details stay out of a spreadsheet.
 *
 * Whose companies (owner, 3 Nov 2026 — "Phase 2 permission fixes", audit H-6 follow-up). `data.importCrm` says the
 * person may import, not which accounts they may change — and this matched any company in the workspace by name, wrote
 * over it, and showed its stored name, account manager and details in the preview. Now it asks what the company
 * screens ask, of the person importing:
 *   · a company by that name they can't see (`mayAccessAccount(view)`) is refused, saying only that the name is taken —
 *     nothing of it is shown, not even its stored spelling — and never written to: the name is unique, so "create"
 *     would land on it;
 *   · one they may see but not change (`mayAccessAccount(edit)`) refuses the row, saying so;
 *   · a new one needs what New company needs (`createCompany`): the Companies section open to them
 *     (`moduleAccessFor`) — there is no separate "create companies" permission to ask;
 *   · the row's person is added only as the screens add one — with `contacts.view`, and on a company already here
 *     with its contacts open to them for editing (`addContact`); otherwise left out, and the preview says so.
 */

type Office = { address?: string; city?: string; state?: string; pincode?: string; country?: string; gstNumber?: string };

type ResolvedCompany = {
  name: string;
  normalizedName: string;
  stage?: CompanyStage;
  source?: CompanySource;
  industryName?: string;
  website?: string;
  ownerUserId?: string;
  ownerName?: string;
  panNumber?: string;
  paymentTerms?: PaymentTerms;
  vendorCode?: string;
  office: Office;
  /** What the row holds that doesn't agree with itself but is brought anyway — said on the preview. */
  notice?: string;
  /** The person the row names — Zoho's Contacts carries the primary contact on each customer's row. */
  person?: Person;
};

type Person = { name: string; email: string | null; phone: string | null; title: string | null };

const RELATIONSHIP = {
  vendors: "VENDOR",
  resellers: "RESELLER",
  "commission-parties": "COMMISSION_PARTY",
} as const;

/** Whose own fields an area's rows carry: a vendor's on the vendors import, a company's on the rest. */
function areaFields(area: string): "COMPANY" | "VENDOR" {
  return area === "vendors" ? "VENDOR" : "COMPANY";
}

const LOCATION_SELECT = { id: true, address: true, city: true, state: true, pincode: true, country: true, gstNumber: true, gstTreatment: true } as const;

/** A company's main address: primary, then billing, then the first. */
export async function mainLocation(companyId: string) {
  return db.companyLocation.findFirst({ where: { companyId }, orderBy: [{ isPrimary: "desc" }, { isBilling: "desc" }, { createdAt: "asc" }], select: LOCATION_SELECT });
}

/**
 * The address a row's office goes to: the one with its GSTIN; else the main one, unless the row's GSTIN is new and the
 * main one already has another — then null, a branch to add.
 */
async function officeFor(companyId: string, office: Office) {
  if (office.gstNumber) {
    const same = await db.companyLocation.findFirst({ where: { companyId, gstNumber: { equals: office.gstNumber, mode: "insensitive" } }, select: LOCATION_SELECT });
    if (same) return same;
  }
  const main = await mainLocation(companyId);
  return main && (!office.gstNumber || !main.gstNumber) ? main : null;
}

const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** Days as Zoho Books gives them ("30", "0") — the terms of that many days, where Deskzo has them. */
const TERMS_BY_DAYS: Record<string, PaymentTerms> = { "0": "DUE_ON_RECEIPT", "15": "NET_15", "30": "NET_30", "45": "NET_45", "60": "NET_60" };

/** "Net 30", "NET_30", "net 30", "30" → NET_30. */
function termsOf(text: string): PaymentTerms | null {
  const key = text.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (TERMS_BY_DAYS[text.trim()]) return TERMS_BY_DAYS[text.trim()]!;
  if ((paymentTermsValues as readonly string[]).includes(key)) return key as PaymentTerms;
  const byLabel = Object.entries(paymentTermsLabels).find(([, label]) => label.toLowerCase() === text.trim().toLowerCase());
  return (byLabel?.[0] as PaymentTerms | undefined) ?? null;
}

/** Who is importing, read once per file: may they make a company, and do they work with contacts at all. */
const actorFacts = new WeakMap<ImportContext, Promise<{ mayCreate: boolean; contacts: boolean }>>();
function actorFor(ctx: ImportContext) {
  let found = actorFacts.get(ctx);
  if (!found) {
    found = (async () => {
      const [section, contacts] = await Promise.all([moduleAccessFor(ctx.actorUserId, "companies"), can(ctx.actorUserId, "contacts.view")]);
      return { mayCreate: section === "available", contacts };
    })();
    actorFacts.set(ctx, found);
  }
  return found;
}

/**
 * What field access hides from the person importing, as a list shows a company (owner, 5 Nov 2026 — Phase 3 masking
 * fixes, audit H.4.2, src/lib/companies/masking.ts) — read once per file. On a company already here those cells are
 * read as blank, "leave alone", as the contacts and leads imports read theirs: a file exported masked must not put the
 * stars over the real address, GSTIN, PAN or website when it comes back, nor a value typed over one they can't read.
 */
const maskers = new WeakMap<ImportContext, Promise<CompanyMasker>>();
function maskerFor(ctx: ImportContext): Promise<CompanyMasker> {
  let found = maskers.get(ctx);
  if (!found) {
    found = companyMasker(ctx.actorUserId, "list");
    maskers.set(ctx, found);
  }
  return found;
}

/** The custom fields to leave alone on a company already here: the Companies set's masked ones (a vendor's aren't covered). */
async function hiddenCustomFor(ctx: ImportContext, existing: unknown): Promise<string[]> {
  return existing && areaFields(ctx.area) === "COMPANY" ? hiddenCustomKeys(await maskerFor(ctx)) : [];
}

async function resolve(row: Record<string, string>, ctx: ImportContext): Promise<Resolved<ResolvedCompany>> {
  const area = ctx.area;
  const r = new RowReader(row);
  // Zoho Books' Contacts: a person with no Company Name is known by their Display Name.
  const name = r.text("Name") || r.text("name") || r.text("Display Name");
  if (!name) return { error: "Name is required." };

  // A company Deskzo has under this name in another legal form ("Pvt Ltd" for "Private Limited" — src/lib/companies/by-name.ts)
  // is that company: the row updates it, keyed by its own name, which the file's spelling doesn't replace.
  const matchedId = await companyIdByName(name);
  // Its cells field access hides from this person, read as blank (`maskerFor`). A GSTIN they can't read can't say which
  // office the row is either, so then the row's address is left alone too — it might be a branch's.
  const masker = await maskerFor(ctx);
  const hidden = matchedId ? masker.flags : { address: false, gstin: false, pan: false, website: false };
  const officeUnknown = hidden.gstin && r.text("GSTIN") !== "";
  const heldBack: string[] = [];
  let officeHeld = false;
  /** A cell, or blank where it is masked for them (`isHidden`) or is an office's part the row can't place (`unplaced`). */
  const cell = (column: string, isHidden: boolean, unplaced = false) => {
    const value = r.text(column);
    if (value && isHidden) heldBack.push(column);
    else if (value && unplaced) officeHeld = true;
    else return value;
    return "";
  };

  const stage = r.enum("Stage", CompanyStage);
  if (r.error) return { error: r.error };

  // What the row holds that is brought anyway, or left out of an otherwise good row — said on the preview. A state or
  // PAN at odds with the GSTIN comes as written (Deskzo may already hold it so, and its own export must read back); a
  // GSTIN or PIN that can't be one is left out, the company still brought (owner, 28 Oct 2026 — a Zoho Contacts file
  // of thousands shouldn't lose a customer to one mistyped character).
  const notices: string[] = [];
  // A Source Deskzo hasn't is left out, said so, the company still brought (owner, 28 Oct 2026): Zoho Books' Contacts
  // has a Source column that says how the contact was made — "user", "csv" — not where it came from. A Stage stays
  // strict: a wrong one in Deskzo's own column is a typo worth stopping for.
  const readSource = parseEnum("Source", r.text("Source"), CompanySource);
  if (readSource.error) notices.push(`Source "${r.text("Source")}" isn't one of ${Object.keys(CompanySource).join(", ")} — left out`);
  const source = readSource.value;
  const typedGstin = cell("GSTIN", hidden.gstin).toUpperCase().replace(/\s+/g, "");
  const gstin = typedGstin && isValidGstin(typedGstin) ? typedGstin : "";
  if (typedGstin && !gstin) notices.push(`GSTIN "${typedGstin}" isn't a valid GSTIN — brought without it`);
  const country = cell("Country", false, officeUnknown);
  const typedState = cell("State", hidden.address, officeUnknown);
  const gstState = gstin ? (GST_STATE_CODES[gstin.slice(0, 2)] ?? null) : null;
  if (gstin && typedState && stateCodeFromName(typedState) && stateCodeFromName(typedState) !== gstin.slice(0, 2)) {
    notices.push(`State isn't the GSTIN's state (${gstState ?? gstin.slice(0, 2)}) — check it`);
  }
  const typedPin = cell("PIN", hidden.address, officeUnknown);
  const pinDigits = typedPin.replace(/\s+/g, "");
  const pincode = !typedPin || !isIndia(country) ? typedPin : /^\d{6}$/.test(pinDigits) ? pinDigits : "";
  if (typedPin && !pincode) notices.push(`PIN "${typedPin}" isn't six digits — brought without it`);
  const typedPan = cell("PAN", hidden.pan).toUpperCase().replace(/\s+/g, "");
  if (typedPan && !PAN_PATTERN.test(typedPan)) return { error: `PAN "${typedPan}" isn't a valid PAN.` };
  if (typedPan && gstin && gstin.slice(2, 12) !== typedPan) notices.push("PAN isn't the one in the GSTIN — check it");
  // A vendor's terms are ours to pay, and come in; a customer's go through its credit check on its page
  // (src/lib/credit/guard.ts), so a file's are passed over — Zoho's Contacts carries them on every row. Terms Deskzo
  // hasn't ("Net 90", "Due end of month") are passed over too, said so.
  const termsText = r.text("Payment terms");
  const known = termsText ? termsOf(termsText) : null;
  if (termsText && !known && area === "vendors") notices.push(`Payment terms "${termsText}" aren't one of ${Object.values(paymentTermsLabels).join(", ")} — left as they were`);
  const paymentTerms = area === "vendors" ? known : null;
  const vendorCode = area === "vendors" ? r.text("Vendor code") : "";

  const matched = matchedId ? await db.company.findUnique({ where: { id: matchedId }, select: { id: true, name: true, normalizedName: true, ownerUserId: true, relationshipType: true } }) : null;
  // Whose it is, before anything of it is read into the row (audit H-6 follow-up): one out of sight is named only as
  // the file names it; one in sight but not theirs to change is refused; a new one needs what New company needs.
  const actor = await actorFor(ctx);
  if (matched && !(await mayAccessAccount(ctx.actorUserId, "view", matched))) {
    return { error: `There's already a company called "${name}" that you can't open, so this row can neither change it nor make another. Take the row out, or ask whoever looks after the account.` };
  }
  if (matched && !(await mayAccessAccount(ctx.actorUserId, "edit", matched))) {
    return { error: `${matched.name} is a company you may see but not change. Take its row out of the file, or ask whoever looks after the account.` };
  }
  if (!matched && !actor.mayCreate) {
    return { error: `This row would create the company "${name}", and you can't create companies. Take the row out, or ask somebody who can.` };
  }
  const keepName = matched && matched.normalizedName !== normalizeCompanyName(name) ? matched.name : name;
  // The account manager it has today reads back even if they have since left (`optionalUserRef`).
  const normalizedName = matched?.normalizedName ?? normalizeCompanyName(name);
  const held = await db.company.findUnique({
    where: { normalizedName },
    select: { id: true, panNumber: true, owner: { select: { id: true, name: true, email: true, active: true } } },
  });
  const owner = await optionalUserRef("Account manager", r.text("Account manager"), false, held?.owner);
  if ("error" in owner) return { error: owner.error };
  if (vendorCode) {
    const holder = await db.company.findFirst({ where: { vendorCode: { equals: vendorCode, mode: "insensitive" }, ...(held ? { id: { not: held.id } } : {}) }, select: { id: true, name: true, ownerUserId: true, relationshipType: true } });
    // Named only to whoever may open it (audit H-6 follow-up).
    if (holder) return { error: `Vendor code ${vendorCode} is ${(await mayAccessAccount(ctx.actorUserId, "view", holder)) ? `${holder.name}'s` : "another company's"}.` };
  }

  // The row's person, as the screens add one: `contacts.view`, and on a company already here its contacts open to edit.
  const typedPerson = personOf(r, notices);
  const mayAddPerson = actor.contacts && (!matched || (await mayAccessContactsOf(ctx.actorUserId, "edit", matched)));
  if (typedPerson && !mayAddPerson) notices.push("The person on this row was left out — you can't add contacts here");

  const typedAddress = cell("Address", hidden.address, officeUnknown);
  const typedCity = cell("City", hidden.address, officeUnknown);
  const typedWebsite = cell("Website", hidden.website);
  if (heldBack.length) notices.push(`${heldBack.join(", ")} ${heldBack.length === 1 ? "is" : "are"} masked for you — left as ${heldBack.length === 1 ? "it is" : "they are"}`);
  if (officeHeld) notices.push("The address was left as it is — the GSTIN that says which office it is is masked for you");
  const office: Office = {
    ...(typedAddress ? { address: typedAddress } : {}),
    ...(typedCity ? { city: typedCity } : {}),
    // Not the GSTIN's state either where the address is hidden from them: that is the address's to say.
    ...(!hidden.address && (typedState || gstState) ? { state: typedState || gstState! } : {}),
    ...(pincode ? { pincode } : {}),
    ...(country ? { country } : {}),
    ...(gstin ? { gstNumber: gstin } : {}),
  };

  return {
    value: {
      name: keepName,
      normalizedName,
      stage,
      source,
      industryName: r.text("Industry") || undefined,
      website: typedWebsite || undefined,
      ownerUserId: owner.value?.id,
      ownerName: owner.value?.name,
      // From the GSTIN only for a company with no PAN yet: a branch's row leaves the company's own alone.
      // Never one field access hides from them, filled in from the GSTIN or otherwise.
      panNumber: hidden.pan ? undefined : typedPan || (gstin && !held?.panNumber ? gstin.slice(2, 12) : undefined),
      paymentTerms: paymentTerms ?? undefined,
      vendorCode: vendorCode || undefined,
      office,
      person: mayAddPerson ? typedPerson : undefined,
      ...(notices.length ? { notice: notices.join("; ") } : {}),
    },
  };
}

/**
 * The person a row names (owner, 28 Oct 2026): First and Last Name, the email, the mobile else the phone, and the job
 * title — Zoho's primary contact on each customer's or vendor's row. None of them, no person. An email that isn't one
 * is left out, said so.
 */
function personOf(r: RowReader, notices: string[]): Person | undefined {
  const name = [r.text("First Name"), r.text("Last Name")].filter(Boolean).join(" ").trim();
  const typedEmail = r.text("Email").trim().toLowerCase();
  const email = typedEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typedEmail) ? typedEmail : null;
  if (typedEmail && !email) notices.push(`Email "${typedEmail}" isn't an email — the contact brought without it`);
  const phone = (r.phone("Mobile") || r.phone("Phone")).trim() || null;
  if (!name && !email && !phone) return undefined;
  return { name: (name || email || phone)!.slice(0, 120), email, phone: phone?.slice(0, 30) ?? null, title: r.text("Designation").trim() || null };
}

/** The contact a company already has for this person: by email, else phone, else the same name. */
async function contactFor(companyId: string, p: Person) {
  const or = [
    ...(p.email ? [{ email: { equals: p.email, mode: "insensitive" as const } }] : []),
    ...(p.phone ? [{ phone: p.phone }] : []),
    { name: { equals: p.name, mode: "insensitive" as const } },
  ];
  return db.contact.findFirst({ where: { companyId, OR: or }, select: { id: true } });
}

const personWords = (p: Person) => [p.name, p.email && p.email !== p.name ? p.email : null, p.phone && p.phone !== p.name ? p.phone : null].filter(Boolean).join(" · ");

/** The head office's columns as the file has them, beside what the company holds. */
function officeChanges(office: Office, held: Awaited<ReturnType<typeof mainLocation>> | null): (FieldChange | null)[] {
  return [
    office.gstNumber ? diff("GSTIN", held?.gstNumber, office.gstNumber) : null,
    office.address ? diff("Address", held?.address, office.address) : null,
    office.city ? diff("City", held?.city, office.city) : null,
    office.state ? diff("State", held?.state, office.state) : null,
    office.pincode ? diff("PIN", held?.pincode, office.pincode) : null,
    office.country ? diff("Country", held?.country, office.country) : null,
  ];
}

export const companiesImporter: Importer = {
  templateColumns: ["Name", "Stage", "Source", "Industry", "Website", "Account manager", "GSTIN", "PAN", "Address", "City", "State", "PIN", "Country", "Payment terms", "Vendor code"],
  // Zoho Books' name for a person with no Company Name — read when Name is empty, not offered in the template.
  extraColumns: ["Display Name", "First Name", "Last Name", "Email", "Mobile", "Phone", "Designation"],
  /**
   * Another system's export as it comes (owner, 18 Oct 2026), from each vendor's own field lists:
   *   · Zoho CRM Accounts and Vendors — https://help.zoho.com/portal/kb/articles/standard-fields-accounts,
   *     https://help.zoho.com/portal/en/kb/crm-nextgen/manage-inventory/vendors/articles/nextgen-standard-fields-vendors
   *   · Salesforce Accounts — https://help.salesforce.com/s/articleView?id=sales.account_fields.htm&type=5
   *   · HubSpot Companies — https://knowledge.hubspot.com/properties/hubspot-crm-default-company-properties
   *   · Pipedrive Organizations — the field reference in its sample import sheet, linked from
   *     https://support.pipedrive.com/en/article/importing-sample-import-spreadsheets
   *   · Zoho Books Customers — https://zoho.com/books/help/migration/quickbooks-online.html
   * Left out on purpose: Zoho Books' "Display Name" and "Vendor Display Name" (each export also has
   * "Company Name", and two headings can't fill one column); HubSpot's "Company domain name" (its export
   * also has "Website URL"); a bare "Owner" or "Type" (they mean different things across systems); and
   * Stage and Source, whose other systems' values aren't Deskzo's and would refuse the row rather than
   * be ignored.
   */
  headerAliases: {
    Name: ["Account Name", "Company name", "Company Name", "Vendor Name", "Organization - Name"],
    Website: ["Website URL"],
    "Account manager": ["Account Owner", "Company owner", "Vendor Owner", "Organization - Owner", "Owner Name"],
    // Zoho Books' Contacts and Vendors give the billing address as the company's own (owner, 28 Oct 2026).
    Address: ["Billing Address"],
    City: ["Billing City"],
    State: ["Billing State"],
    Country: ["Billing Country"],
    GSTIN: ["GST Identification Number (GSTIN)", "GST Number", "GST No", "GSTIN/UIN"],
    PAN: ["PAN Number", "PAN No"],
    PIN: ["PIN code", "Pincode", "Billing Code", "Billing Zip"],
    // The person the company is dealt through (owner, 28 Oct 2026) — Zoho Books' Contacts and Vendors give theirs.
    Email: ["EmailID", "Email ID", "Email Address"],
    Mobile: ["MobilePhone", "Mobile Phone"],
  },
  customEntity: "COMPANY",

  async plan(row, line, ctx) {
    const resolved = await resolve(row, ctx);
    if ("error" in resolved) return errorRow(line, row.Name ?? "", resolved.error);
    const c = resolved.value;

    const existing = await db.company.findUnique({
      where: { normalizedName: c.normalizedName },
      include: { owner: { select: { name: true } }, industry: { select: { name: true } } },
    });
    // The workspace's own fields in this row, checked against what the company holds (sheets.ts) — a masked one's cell
    // left alone (`hiddenCustomFor`).
    const custom = ctx.custom ? await ctx.custom.merge(existing ? await valuesFor(areaFields(ctx.area), existing.id) : {}, row, { skip: await hiddenCustomFor(ctx, existing) }) : null;
    if (custom && !custom.ok) return errorRow(line, c.name, custom.error);
    // The workspace's field rules (src/lib/field-rules) — a company's; a vendor's rows aren't held to them.
    if (areaFields(ctx.area) === "COMPANY") {
      const ruled = await importRuleRefusal(
        "COMPANY",
        existing?.id ?? null,
        {
          name: c.name,
          source: c.source,
          industryId: c.industryName,
          website: c.website,
          "location.gstNumber": c.office.gstNumber,
          "location.address": c.office.address,
          "location.city": c.office.city,
          "location.state": c.office.state,
          "location.pincode": c.office.pincode,
          "location.country": c.office.country,
        },
        custom?.ok ? custom.values : null,
      );
      if (ruled) return errorRow(line, c.name, ruled);
    }

    const ignored = custom?.ok && custom.ignored.length ? `${custom.ignored.join(", ")} ${custom.ignored.length === 1 ? "is" : "are"} masked for you — left as ${custom.ignored.length === 1 ? "it is" : "they are"}` : null;
    const notice = [c.notice, ignored].filter(Boolean).join("; ");
    const said = (planned: PlannedRow): PlannedRow => (notice && planned.action !== "error" ? { ...planned, notice } : planned);
    // A second row for a company an earlier row makes: another office of it.
    if (!existing && ctx.pendingKeys.has(c.normalizedName)) {
      return said(updateRow(line, c.normalizedName, c.name, officeChanges(c.office, null)));
    }
    if (!existing) {
      return said(createRow(line, c.normalizedName, c.name, {
        Name: c.name,
        Stage: c.stage,
        Source: c.source,
        Industry: c.industryName,
        Website: c.website,
        "Account manager": c.ownerName,
        GSTIN: c.office.gstNumber,
        PAN: c.panNumber,
        City: c.office.city,
        State: c.office.state,
        "Payment terms": c.paymentTerms ? paymentTermsLabels[c.paymentTerms] : undefined,
        "Vendor code": c.vendorCode,
        Contact: c.person ? personWords(c.person) : undefined,
        ...(custom?.ok ? Object.fromEntries(custom.changes.map((ch) => [ch.field, ch.to])) : {}),
      }));
    }

    return said(updateRow(line, c.normalizedName, c.name, [
      diff("Name", existing.name, c.name),
      c.stage ? diff("Stage", existing.stage, c.stage) : null,
      c.source ? diff("Source", existing.source, c.source) : null,
      c.industryName ? diff("Industry", existing.industry?.name, c.industryName) : null,
      c.website ? diff("Website", existing.website, c.website) : null,
      c.ownerName ? diff("Account manager", existing.owner?.name, c.ownerName) : null,
      c.panNumber ? diff("PAN", existing.panNumber, c.panNumber) : null,
      c.paymentTerms ? diff("Payment terms", paymentTermsLabels[existing.paymentTerms], paymentTermsLabels[c.paymentTerms]) : null,
      c.vendorCode ? diff("Vendor code", existing.vendorCode, c.vendorCode) : null,
      ...officeChanges(c.office, await officeFor(existing.id, c.office)),
      c.person && !(await contactFor(existing.id, c.person)) ? diff("Contact", null, personWords(c.person)) : null,
      ...(custom?.ok ? custom.changes : []),
    ]));
  },

  async apply(row, ctx: ImportContext) {
    const resolved = await resolve(row, ctx);
    if ("error" in resolved) throw new Error(resolved.error);
    const c = resolved.value;

    // The one write the planner could not do for itself: an industry the file names but the system
    // has never seen. Created here rather than in resolve() so that planning stays read-only.
    const industry = c.industryName
      ? await db.industry.upsert({ where: { name: c.industryName }, update: {}, create: { name: c.industryName } })
      : null;

    const existing = await db.company.findUnique({ where: { normalizedName: c.normalizedName }, select: { id: true } });
    const custom = ctx.custom ? await ctx.custom.merge(existing ? await valuesFor(areaFields(ctx.area), existing.id) : {}, row, { skip: await hiddenCustomFor(ctx, existing) }) : null;
    if (custom && !custom.ok) throw new Error(custom.error);

    const data = {
      name: c.name,
      ...(custom?.ok && custom.changes.length > 0 ? { customFields: custom.values as Prisma.InputJsonValue } : {}),
      ...(c.stage ? { stage: c.stage } : {}),
      ...(c.source ? { source: c.source } : {}),
      ...(c.website ? { website: c.website } : {}),
      ...(industry ? { industryId: industry.id } : {}),
      ...(c.ownerUserId ? { ownerUserId: c.ownerUserId } : {}),
      ...(c.panNumber ? { panNumber: c.panNumber } : {}),
      ...(c.paymentTerms ? { paymentTerms: c.paymentTerms } : {}),
      ...(c.vendorCode ? { vendorCode: c.vendorCode } : {}),
    };

    const relationshipType = RELATIONSHIP[ctx.area as keyof typeof RELATIONSHIP] ?? "CLIENT";
    const saved = await db.company.upsert({
      where: { normalizedName: c.normalizedName },
      update: data,
      select: { id: true },
      create: {
        ...data,
        normalizedName: c.normalizedName,
        relationshipType,
        createdById: ctx.actorUserId,
        // Falling back to the importer when the file names nobody. Better than null: an unowned
        // account is invisible to everybody under the scoping rules.
        ownerUserId: c.ownerUserId ?? ctx.actorUserId,
      },
    });
    // A vendor new to the system is numbered as one created by hand is (src/lib/companies/vendor-code.ts) — unless the file gave its code.
    if (!existing && !c.vendorCode && isVendorRelationshipType(relationshipType)) await assignVendorCodes([saved.id]);

    // The row's person, once (owner, 28 Oct 2026): a contact the company hasn't by that email, phone or name, its primary
    // contact when it has none.
    if (c.person && !(await contactFor(saved.id, c.person))) {
      const hasPrimary = !!(await db.contact.findFirst({ where: { companyId: saved.id, isPrimary: true }, select: { id: true } }));
      await db.contact.create({
        data: {
          companyId: saved.id,
          name: c.person.name,
          email: c.person.email,
          phone: c.person.phone,
          isPrimary: !hasPrimary,
          designation: designationFromTitle(c.person.title ?? undefined),
          createdByUserId: ctx.actorUserId,
        },
      });
    }

    // The row's office: the address it is (`officeFor`) updated, or a new one — the company's first as its head
    // office, a later one as a branch named by its city or state.
    if (Object.keys(c.office).length > 0) {
      // A GSTIN makes an unregistered address a regular registered one; composition, SEZ and the rest are left as set.
      const registered = c.office.gstNumber ? { gstTreatment: "REGISTERED_REGULAR" as const } : {};
      const held = await officeFor(saved.id, c.office);
      if (held) await db.companyLocation.update({ where: { id: held.id }, data: { ...c.office, ...(["UNREGISTERED", "CONSUMER"].includes(held.gstTreatment) ? registered : {}) } });
      else {
        const first = !(await db.companyLocation.findFirst({ where: { companyId: saved.id }, select: { id: true } }));
        await db.companyLocation.create({
          data: {
            companyId: saved.id,
            label: first ? "Head Office" : c.office.city || c.office.state || "Branch",
            isPrimary: first,
            isBilling: first,
            isShipping: first,
            country: c.office.country ?? DEFAULT_COUNTRY,
            ...c.office,
            ...registered,
          },
        });
      }
    }
  },
};
