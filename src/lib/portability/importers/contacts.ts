import { importRuleRefusal } from "@/lib/field-rules/server";
import { ContactDesignation, type Prisma } from "@prisma/client";
import { contactDetailFieldKeys, seesResellerContactDetails } from "@/lib/authz/contact-access";
import { contactAccess, mayAccessContactsOf } from "@/lib/authz/access";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { can } from "@/lib/authz/resolve";
import { valuesFor } from "@/lib/custom-fields/server";
import { db } from "@/lib/db";
import { isResellerManaged } from "@/lib/reseller";
import { requireCompany } from "./lookups";
import {
  createRow,
  diff,
  errorRow,
  keyOf,
  seqFromKey,
  updateRow,
  RowReader,
  type Importer,
  type ImportContext,
  type Resolved,
} from "./types";

/**
 * People at the companies.
 *
 * Matched on the stable key where the file carries one, otherwise on email within the company. Email
 * alone would be wrong: the same address legitimately appears under two companies when somebody
 * changes employer, and matching across them would move the old contact rather than create the new.
 *
 * A reseller's end customer's contact details — the email, the phone, and the workspace's own contact
 * fields of those kinds — are hidden from somebody without `contacts.viewRestricted`
 * (src/lib/authz/contact-access.ts), and their import neither shows nor changes them on a contact that
 * exists: those cells are read as blank, and the preview says so where they held something. A match
 * on email still finds the contact, as the contacts list's search does — what stays hidden is what is
 * stored. A new contact takes what the row gives it, as the add form does.
 *
 * ## Whose contacts (owner, 3 Nov 2026 — "Phase 2 permission fixes", audit H-6 follow-up)
 *
 * `data.importCrm` says the person may import, not whose contacts they may change — and this matched any contact in
 * the workspace by its Key, or by email at any company named, wrote over it, and showed its stored name and details in
 * the preview. Now it asks what the contact screens ask, of the person importing:
 *
 *   · contacts at all — `contacts.view`, without which the screens open no address book and add nobody;
 *   · the company named is one they may see (`canSeeCompany`); one they can't answers as a name nobody has;
 *   · a contact out of their view scope (`contactAccess(view)`) is no contact here: its Key answers as a made-up one,
 *     and an email doesn't match it — so nothing of it reaches the preview;
 *   · one they may see but not change (`contactAccess(edit)`) refuses the row, saying so;
 *   · a new one needs what adding one on the company's page needs (`addContact`): its contacts open to them for
 *     editing (`mayAccessContactsOf(edit)`). There is no separate "create contacts" permission to ask.
 */

const HIDDEN_NOTICE =
  "A reseller's customer's email, phone and other contact details are hidden from you — those cells were left as they are.";

/** The contact-detail custom fields to leave alone on this contact, or null when this person sees its details. */
async function hiddenDetailKeys(existing: { company: { managedByResellerId: string | null } }, ctx: ImportContext): Promise<string[] | null> {
  if (!isResellerManaged(existing.company) || (await seesResellerContactDetails(ctx.actorUserId))) return null;
  return contactDetailFieldKeys();
}

type ResolvedContact = {
  name: string;
  companyId: string;
  companyName: string;
  email?: string;
  phone?: string;
  designation?: ContactDesignation;
  existingId?: string;
  existingSeq?: number;
};

/** Who is importing, read once per file: whether they work with contacts at all, and which they may see and change. */
type Scope = { contacts: boolean; view: Prisma.ContactWhereInput; edit: Prisma.ContactWhereInput };
const scopes = new WeakMap<ImportContext, Promise<Scope>>();
function scopeFor(ctx: ImportContext): Promise<Scope> {
  let found = scopes.get(ctx);
  if (!found) {
    found = (async () => {
      const [contacts, view, edit] = await Promise.all([can(ctx.actorUserId, "contacts.view"), contactAccess(ctx.actorUserId, "view"), contactAccess(ctx.actorUserId, "edit")]);
      return { contacts, view, edit };
    })();
    scopes.set(ctx, found);
  }
  return found;
}

/**
 * A value exported masked (owner, 3 Nov 2026 — src/lib/contacts/masking.ts): "R********", "s*****@g***.com", "+91 ******4321".
 * Never written back — a file exported by somebody who sees contacts masked must not put the stars over the real
 * name, address or number when it comes back. Read as "leave alone", as a blank detail is.
 */
const MASKED = /[*]{5,}/;

async function resolve(row: Record<string, string>, ctx: ImportContext): Promise<Resolved<ResolvedContact>> {
  const scope = await scopeFor(ctx);
  if (!scope.contacts) return { error: "You don't have access to contacts, so you can't import them." };
  const r = new RowReader(row);
  // A whole name, or another system's two halves of one (`extraColumns`).
  const typedName = r.text("Name") || [r.text("First name"), r.text("Last name")].filter(Boolean).join(" ");
  if (!typedName) return { error: "Name is required." };

  const company = await requireCompany("Company", r.text("Company"));
  if ("error" in company) return { error: company.error };
  // A company out of sight answers as a name nobody has (audit H-6 follow-up).
  const account = await db.company.findUniqueOrThrow({ where: { id: company.value.id }, select: { id: true, ownerUserId: true, relationshipType: true } });
  if (!(await canSeeCompany(ctx.actorUserId, account))) {
    return { error: `No company named "${r.text("Company")}" (Company). Import the company first, or correct the spelling.` };
  }

  const designation = r.enum("Designation", ContactDesignation);
  if (r.error) return { error: r.error };

  // Only among the contacts this person may see: one outside it is no contact here, by Key or by email (audit H-6 follow-up).
  const seen = (where: Prisma.ContactWhereInput): Prisma.ContactWhereInput => ({ AND: [where, scope.view] });
  const typedEmail = r.text("Email").toLowerCase();
  const email = typedEmail && !MASKED.test(typedEmail) ? typedEmail : undefined;
  const seq = seqFromKey("CON", r.text("Key"));
  const existing = seq
    ? await db.contact.findFirst({ where: seen({ contactSeq: seq }) })
    : email
      ? await db.contact.findFirst({ where: seen({ companyId: company.value.id, email }) })
      : null;

  if (seq && !existing) {
    return { error: `No contact with key CON-${seq}. Remove the Key cell to create a new contact.` };
  }
  // Seen is not changeable: a contact this person may only look at is refused, not written over.
  if (existing && (await db.contact.count({ where: { AND: [{ id: existing.id }, scope.edit] } })) === 0) {
    return { error: `CON-${existing.contactSeq} is a contact you may see but not change. Take its row out of the file, or ask whoever looks after the account.` };
  }
  // A new one, as adding one on the company's page asks (`addContact`): its contacts open to them for editing.
  if (!existing && !(await mayAccessContactsOf(ctx.actorUserId, "edit", account))) {
    return { error: `You can't add contacts at ${company.value.name}. Take the row out, or ask whoever looks after the account.` };
  }
  // A masked name keeps the one stored; a new contact needs a real one.
  if (MASKED.test(typedName) && !existing) return { error: "The name is masked — type the contact's real name to add them." };
  const name = MASKED.test(typedName) ? existing!.name : typedName;
  const typedPhone = r.phone("Phone");

  return {
    value: {
      name,
      companyId: company.value.id,
      companyName: company.value.name,
      email,
      phone: typedPhone && !MASKED.test(row.Phone ?? "") ? typedPhone : undefined,
      designation,
      existingId: existing?.id,
      existingSeq: existing?.contactSeq,
    },
  };
}

export const contactsImporter: Importer = {
  templateColumns: ["Key", "Name", "Company", "Designation", "Email", "Phone"],
  /**
   * Another system's export as it comes (owner, 18 Oct 2026), from each vendor's own field lists:
   *   · Zoho CRM Contacts — https://help.zoho.com/portal/kb/articles/standard-fields-contacts
   *   · Salesforce Contacts — https://help.salesforce.com/s/articleView?id=sales.contacts_fields.htm&type=5
   *   · HubSpot Contacts — https://knowledge.hubspot.com/properties/hubspots-default-contact-properties
   *   · Pipedrive People — the field reference in its sample import sheet, linked from
   *     https://support.pipedrive.com/en/article/importing-sample-import-spreadsheets
   *   · Zoho Books — https://zoho.com/books/help/migration/quickbooks-online.html
   * Left out on purpose: "Title"/"Job title" (Designation is Deskzo's own list, and a free-text title would
   * refuse the row); "Mobile" and the other phones (each export also has "Phone"); "Secondary Email".
   */
  headerAliases: {
    Name: ["Full Name", "Person - Name"],
    Company: ["Account Name", "Company name", "Organization"],
    Email: ["Email ID", "Person - Email"],
    Phone: ["Phone number"],
    "First name": ["Person - First name"],
    "Last name": ["Person - Last name"],
  },
  // Most systems split a person's name; a Deskzo file holds it whole, so these aren't exported.
  extraColumns: ["First name", "Last name"],
  customEntity: "CONTACT",

  async plan(row, line, ctx) {
    const resolved = await resolve(row, ctx);
    if ("error" in resolved) return errorRow(line, row.Name ?? "", resolved.error);
    const c = resolved.value;
    const label = `${c.name} at ${c.companyName}`;
    const existing = c.existingId
      ? await db.contact.findUniqueOrThrow({ where: { id: c.existingId }, include: { company: { select: { managedByResellerId: true } } } })
      : null;
    const hidden = existing ? await hiddenDetailKeys(existing, ctx) : null;
    // The workspace's own fields in this row, checked against what the contact holds (sheets.ts).
    const custom = ctx.custom ? await ctx.custom.merge(existing ? await valuesFor("CONTACT", existing.id) : {}, row, { skip: hidden ?? [] }) : null;
    if (custom && !custom.ok) return errorRow(line, label, custom.error);
    // The workspace's field rules (src/lib/field-rules) — not on details this person sees hidden, which stay as stored.
    {
      const kept = new Set<string>(hidden ?? []);
      const ruled = await importRuleRefusal(
        "CONTACT",
        existing?.id ?? null,
        { name: c.name, email: kept.has("email") ? undefined : c.email, phone: kept.has("phone") ? undefined : c.phone },
        custom?.ok ? custom.values : null,
      );
      if (ruled) return errorRow(line, label, ruled);
    }

    if (!existing) {
      return createRow(line, c.email || `${c.companyName}:${c.name}`, label, {
        Name: c.name,
        Email: c.email,
        Phone: c.phone,
        Designation: c.designation,
        ...(custom?.ok ? Object.fromEntries(custom.changes.map((ch) => [ch.field, ch.to])) : {}),
      });
    }

    const planned = updateRow(line, keyOf("CON", c.existingSeq!), label, [
      diff("Name", existing.name, c.name),
      // Hidden from this person: not compared, so nothing about the stored value shows.
      c.email && !hidden ? diff("Email", existing.email, c.email) : null,
      c.phone && !hidden ? diff("Phone", existing.phone, c.phone) : null,
      c.designation ? diff("Designation", existing.designation, c.designation) : null,
      ...(custom?.ok ? custom.changes : []),
    ]);
    const heldHidden = hidden !== null && (!!c.email || !!c.phone || (custom?.ok === true && custom.ignored.length > 0));
    return heldHidden ? { ...planned, notice: HIDDEN_NOTICE } : planned;
  },

  async apply(row, ctx: ImportContext) {
    const resolved = await resolve(row, ctx);
    if ("error" in resolved) throw new Error(resolved.error);
    const c = resolved.value;
    const existing = c.existingId
      ? await db.contact.findUniqueOrThrow({ where: { id: c.existingId }, select: { company: { select: { managedByResellerId: true } } } })
      : null;
    const hidden = existing ? await hiddenDetailKeys(existing, ctx) : null;

    const custom = ctx.custom ? await ctx.custom.merge(c.existingId ? await valuesFor("CONTACT", c.existingId) : {}, row, { skip: hidden ?? [] }) : null;
    if (custom && !custom.ok) throw new Error(custom.error);

    const data = {
      name: c.name,
      ...(custom?.ok && custom.changes.length > 0 ? { customFields: custom.values as Prisma.InputJsonValue } : {}),
      // Hidden from this person on a reseller's customer: left as stored.
      ...(c.email && !hidden ? { email: c.email } : {}),
      ...(c.phone && !hidden ? { phone: c.phone } : {}),
      ...(c.designation ? { designation: c.designation } : {}),
    };

    if (c.existingId) {
      await db.contact.update({ where: { id: c.existingId }, data });
    } else {
      await db.contact.create({ data: { ...data, companyId: c.companyId, createdByUserId: ctx.actorUserId } });
    }
  },
};
