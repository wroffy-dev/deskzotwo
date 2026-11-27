import { addContact, createCompany, getCompany, listCompaniesPaged, updateCompany, updateContact } from "@/actions/company";
import { listAllContactsPaged } from "@/actions/contact";
import { ApiError, notFound, pageOf, paging, refusedBy, type ApiAnswer, type ApiCall } from "@/lib/api/handler";
import { customFieldsOut } from "@/lib/api/custom";
import { companyCreateSchema, companyPatchSchema, contactCreateSchema, contactFields, contactPatchSchema } from "@/lib/api/v1/schemas";
import { needModule } from "@/lib/api/v1/shared";
import { companyRef, contactRef, idOf, iso } from "@/lib/api/refs";
import { API_DEFAULT_PAGE_SIZE, API_MAX_PAGE_SIZE } from "@/lib/api/scopes";
import { bandForCount } from "@/lib/company-size";
import { db } from "@/lib/db";
import { relationshipTypeValues } from "@/lib/validation/company";
import { companyMasker } from "@/lib/companies/masking";
import { maskContactRows } from "@/lib/contacts/masking";
import { exportAnswers, exportOverrides, fieldMasker } from "@/lib/authz/fields";
import { revealedFieldsAmong, revealedFieldsToday } from "@/lib/authz/unmask";
import type { FieldContext } from "@/lib/authz/field-policy";

/**
 * Companies and their contacts in the public API (src/lib/api) — through the app's own company and
 * contact actions as the key's person: the account scope, the contact-detail rules on a reseller's
 * customers, the payment-terms guard and the duplicate-name rule all apply as on the screens.
 */

type Row = Record<string, unknown> & { id: string };
const str = (v: unknown) => (typeof v === "string" ? v : null);
const rec = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);
const person = (v: unknown) => {
  const p = rec(v);
  return p ? { id: p.id, name: p.name } : null;
};

/** Each company's main address — the primary, else the first. */
async function addressesOf(ids: string[]) {
  const rows = await db.companyLocation.findMany({
    where: { companyId: { in: ids } },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    select: { companyId: true, label: true, address: true, city: true, state: true, pincode: true, country: true, gstNumber: true },
  });
  const out = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!out.has(r.companyId)) out.set(r.companyId, r);
  return out;
}

function companyOut(row: Row, address: Awaited<ReturnType<typeof addressesOf>> extends Map<string, infer V> ? V | undefined : never, custom: Record<string, unknown> | undefined) {
  const industry = rec(row.industry);
  return {
    id: row.id,
    ref: companyRef(row.companySeq as number),
    name: row.name,
    relationship_type: row.relationshipType,
    stage: row.stage ?? null,
    website: str(row.website),
    linkedin_url: str(row.linkedinUrl),
    industry: industry ? { id: industry.id, name: industry.name } : null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    source: row.source ?? null,
    payment_terms: row.paymentTerms ?? null,
    employee_count: typeof row.employeeCount === "number" ? row.employeeCount : null,
    owner: person(row.owner),
    account_manager: person(row.assignedTo),
    address: address
      ? { label: address.label, line: address.address, city: address.city, state: address.state, pincode: address.pincode, country: address.country, gstin: address.gstNumber }
      : null,
    custom_fields: custom ?? {},
    created_at: iso(row.createdAt as Date | string),
    updated_at: iso(row.updatedAt as Date | string),
  };
}

/**
 * Custom fields an API list carries (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.4): the list's
 * (`customFieldsOut`, those shown in the clear in a list), less those whose export answer isn't the clear value.
 */
export function exportedCustom(values: Record<string, unknown> | undefined, answers: Awaited<ReturnType<typeof exportAnswers>>) {
  if (!values) return values;
  return Object.fromEntries(Object.entries(values).filter(([key]) => (answers.get(`custom:${key}`)?.export ?? "clear") === "clear"));
}

/**
 * Companies as the key's person sees them (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.2): the rows come from
 * the screens' own reads, already masked; the main address is read here, so it is masked here — as a list shows it, as
 * the company's page does for one revealed today ("detail", `oneCompanyOut`), or in the API's own lists with the export
 * answers ("export", audit H.4.4: the website presented again from what is stored where its export is set). A masked
 * custom field is left out (`customFieldsOut`), and in an export one not exported in the clear too.
 */
export async function companiesOut(userId: string, rows: Row[], context: FieldContext = "list") {
  const ids = rows.map((r) => r.id);
  const exported = context === "export";
  const [addresses, custom, shown, answers, websites] = await Promise.all([
    addressesOf(ids),
    customFieldsOut("COMPANY", userId, ids),
    // Today's reveals only for one company read as its page reads it; lists and exports keep to the policy's answers.
    companyMasker(userId, context, context === "detail" ? ids : undefined),
    exported ? exportAnswers(userId, "companies") : null,
    exported && (await exportOverrides(userId, "companies")).has("website") ? db.company.findMany({ where: { id: { in: ids } }, select: { id: true, website: true } }) : null,
  ]);
  const website = new Map((websites ?? []).map((w) => [w.id, w.website]));
  return rows.map((r) => {
    const address = addresses.get(r.id);
    const seen = shown.forCompany(r.id);
    const row = website.has(r.id) ? { ...r, website: seen.present("website", website.get(r.id)) } : r;
    return companyOut(row, address ? seen.location(address) : undefined, answers ? exportedCustom(custom.get(r.id), answers) : custom.get(r.id));
  });
}

/**
 * One company as the API and the app give it (owner, 5 Nov 2026 — Phase 3 masking fixes, audit M-11): the list answers,
 * not its page's — "mask in list" without "mask in detail" handed a script every company's website and address in the
 * clear, with no "Show" and no log. Its page's answers only once the person has revealed it today
 * (`revealedFieldsToday`), counted and logged. The read is the screens' own (`getCompany`); the website, which it
 * masks as the page does, is presented again from what is stored.
 */
export async function oneCompanyOut(userId: string, company: Row) {
  if (await revealedFieldsToday(userId, "companies", company.id)) return (await companiesOut(userId, [company], "detail"))[0]!;
  const [stored, listed] = await Promise.all([db.company.findUnique({ where: { id: company.id }, select: { website: true } }), companyMasker(userId, "list")]);
  return (await companiesOut(userId, [{ ...company, website: listed.present("website", stored?.website) }], "list"))[0]!;
}

/**
 * A company's contacts as the API and the app give them, from its read (`getCompany`, which shows them as the
 * customer's Contacts tab does): with the list answers (audit M-11), except a contact revealed today, which keeps the
 * tab's. Their name, email and phone are presented again from what is stored; one whose details the read left out — a
 * reseller's end customer — stays without them.
 */
export async function contactsAsListed(userId: string, contacts: Row[]): Promise<Row[]> {
  if (contacts.length === 0) return contacts;
  const ids = contacts.map((c) => c.id);
  const [revealed, stored] = await Promise.all([
    revealedFieldsAmong(userId, "contacts", ids),
    db.contact.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true, phone: true, emailCheckedValue: true, emailCheckDetail: true } }),
  ]);
  const listed = new Map(
    (await maskContactRows(
      userId,
      "list",
      stored
        .filter((c) => !revealed.has(c.id))
        .map((c) => {
          const read = contacts.find((r) => r.id === c.id);
          return read?.detailsRedacted === true ? { ...c, email: null, phone: null, emailCheckedValue: null, emailCheckDetail: null } : c;
        }),
    )).map((c) => [c.id, c]),
  );
  return contacts.map((c) => {
    const l = listed.get(c.id);
    if (!l) return c;
    return { ...c, name: l.name, email: c.email == null ? c.email : l.email, phone: c.phone == null ? c.phone : l.phone, ...("emailCheckedValue" in c ? { emailCheckedValue: l.emailCheckedValue, emailCheckDetail: l.emailCheckDetail } : {}) };
  });
}

/**
 * The API's contacts list with each field's export answer (owner, 5 Nov 2026 — audit H.4.4): the Contacts list's rows,
 * and a name, email or phone whose `export` is set presented again from what is stored. A detail the list left out — a
 * reseller's end customer's — stays out.
 */
async function exportedContacts(userId: string, rows: Row[]): Promise<Row[]> {
  const set = [...(await exportOverrides(userId, "contacts"))].filter((k): k is "name" | "email" | "phone" => k === "name" || k === "email" || k === "phone");
  if (set.length === 0 || rows.length === 0) return rows;
  const [m, stored] = await Promise.all([fieldMasker(userId, "contacts", "export"), db.contact.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true, name: true, email: true, phone: true } })]);
  const byId = new Map(stored.map((c) => [c.id, c]));
  return rows.map((r) => {
    const raw = byId.get(r.id);
    if (!raw) return r;
    const out: Row = { ...r };
    for (const field of set) {
      if (field === "name") out.name = m.present("name", raw.name) ?? "";
      else if (out[field] != null) out[field] = m.present(field, raw[field]);
    }
    return out;
  });
}

export function contactOut(row: Row, company: Record<string, unknown> | null, custom: Record<string, unknown> | undefined) {
  return {
    id: row.id,
    ref: contactRef(row.contactSeq as number),
    name: row.name,
    designation: row.designation ?? null,
    designation_name: str(row.designationName),
    email: str(row.email),
    phone: str(row.phone),
    linkedin_url: str(row.linkedinUrl),
    is_primary: row.isPrimary === true,
    receives_documents: row.receivesDocuments === true,
    left_at: iso(row.leftAt as Date | string | null),
    company: company ? { id: company.id, ref: companyRef(company.companySeq as number), name: company.name } : null,
    custom_fields: custom ?? {},
    created_at: iso(row.createdAt as Date | string),
    updated_at: iso(row.updatedAt as Date | string),
  };
}

/**
 * Security audit, 11 Nov 2026 (SEC-51): whether the key may read contacts — `companies:read` alone is no way to
 * read a company's people. Without `contacts:read` a company comes back with `contacts: []`.
 */
export const mayReadContacts = (scopes: readonly string[] | undefined) => !!scopes?.includes("contacts:read");

/** One company through the screens' own read — or not found — as the API gives one (`oneCompanyOut`, `contactsAsListed`). */
export async function readCompany(userId: string, id: string, opts: { withContacts?: boolean } = {}) {
  const company = (await getCompany(id)) as Row | null;
  if (!company) throw notFound("company");
  const out = await oneCompanyOut(userId, company);
  if (opts.withContacts === false) return { ...out, contacts: [] };
  const contacts = await contactsAsListed(userId, Array.isArray(company.contacts) ? (company.contacts as Row[]) : []);
  const custom = await customFieldsOut("CONTACT", userId, contacts.map((c) => c.id));
  return { ...out, contacts: contacts.map((c) => contactOut(c, company, custom.get(c.id))) };
}

export async function listCompaniesApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("companies", call.actor.userId, "Companies");
  const q = call.url.searchParams;
  const { page, pageSize } = paging(call.url, API_MAX_PAGE_SIZE, API_DEFAULT_PAGE_SIZE);
  const relationship = q.get("relationship_type")?.toUpperCase();
  if (relationship && !(relationshipTypeValues as readonly string[]).includes(relationship)) throw new ApiError(400, "invalid_request", `relationship_type is one of ${relationshipTypeValues.join(", ")}.`);
  const { rows, total } = await listCompaniesPaged({ page, pageSize, search: q.get("search")?.slice(0, 100) || undefined, relationshipType: relationship as (typeof relationshipTypeValues)[number] | undefined });
  return { data: await companiesOut(call.actor.userId, rows as unknown as Row[], "export"), page: pageOf(page, pageSize, total) };
}

export async function getCompanyApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("companies", call.actor.userId, "Companies");
  const id = await idOf("company", call.params.ref);
  if (!id) throw notFound("company");
  return { data: await readCompany(call.actor.userId, id, { withContacts: mayReadContacts(call.actor.scopes) }) };
}

const contactInput = (c: Partial<Record<keyof typeof contactFields, unknown>>) => ({
  name: c.name,
  designation: c.designation ?? "OTHER",
  ...(c.designation_name !== undefined ? { designationName: c.designation_name } : {}),
  email: c.email ?? "",
  phone: c.phone ?? "",
  linkedinUrl: c.linkedin_url ?? "",
  isPrimary: c.is_primary ?? false,
  receivesDocuments: c.receives_documents ?? false,
});

export async function createCompanyApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("companies", call.actor.userId, "Companies");
  const input = companyCreateSchema.parse(await call.body());
  const a = input.address;
  const made = await createCompany({
    name: input.name,
    relationshipType: input.relationship_type ?? "CLIENT",
    website: input.website ?? "",
    linkedinUrl: input.linkedin_url ?? "",
    industryId: input.industry ?? "",
    tags: input.tags ?? [],
    source: input.source ?? "OTHER",
    paymentTerms: input.payment_terms ?? "ADVANCE",
    ...(a
      ? { location: { label: a.label || "Head Office", address: a.line ?? "", city: a.city ?? "", state: a.state ?? "", pincode: a.pincode ?? "", country: a.country ?? "", gstNumber: a.gstin ?? "", isBilling: true, isShipping: true } }
      : {}),
    contacts: (input.contacts ?? []).map(contactInput),
    customFields: input.custom_fields,
  });
  if (!made.ok) throw refusedBy(made);
  return { status: 201, data: await readCompany(call.actor.userId, made.data.id, { withContacts: mayReadContacts(call.actor.scopes) }) };
}

export async function patchCompanyApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("companies", call.actor.userId, "Companies");
  const id = await idOf("company", call.params.ref);
  if (!id) throw notFound("company");
  const input = companyPatchSchema.parse(await call.body());
  /**
   * A website sent back exactly as the API showed it masked is no change (owner, 5 Nov 2026 — Phase 3 masking fixes):
   * a company is read with the list's answers now (`oneCompanyOut`), and "h********" for a website its page shows in the
   * clear would otherwise be saved over it — the company's form keeps only what its page masks.
   */
  const asShown = await getCompany(id).then((c) => (c ? oneCompanyOut(call.actor.userId, c as Row) : null));
  // The screens' edit takes the whole set: what wasn't sent stays as it is. The action checks the account reaches the key's person.
  const now = await db.company.findUnique({
    where: { id },
    select: { name: true, industryId: true, customerCategoryId: true, companyType: true, relationshipType: true, website: true, linkedinUrl: true, employeeCount: true, paymentTerms: true, dunsNumber: true, tags: true, source: true },
  });
  if (!now) throw notFound("company");
  const done = await updateCompany({
    id,
    name: input.name ?? now.name,
    industryId: input.industry ?? now.industryId ?? "",
    customerCategoryId: now.customerCategoryId ?? "",
    companyType: now.companyType ?? "",
    relationshipType: input.relationship_type ?? now.relationshipType,
    website: (input.website !== undefined && asShown && input.website === asShown.website && asShown.website !== now.website ? undefined : input.website) ?? now.website ?? "",
    linkedinUrl: input.linkedin_url ?? now.linkedinUrl ?? "",
    employeeBand: bandForCount(now.employeeCount)?.key ?? "",
    paymentTerms: input.payment_terms ?? now.paymentTerms,
    dunsNumber: now.dunsNumber ?? "",
    tags: input.tags ?? now.tags,
    source: input.source ?? now.source,
  });
  if (!done.ok) throw done.error === "Company not found." ? notFound("company") : refusedBy(done);
  return { data: await readCompany(call.actor.userId, id, { withContacts: mayReadContacts(call.actor.scopes) }) };
}

// ─── Contacts ───────────────────────────────────────────────────────────────────────────────────

/** A contact through its company's read on the screens — every contact-detail rule applied — or not found: as its company's Contacts tab shows it. */
async function contactOnTab(id: string) {
  const at = await db.contact.findUnique({ where: { id }, select: { companyId: true } });
  if (!at) throw notFound("contact");
  const company = (await getCompany(at.companyId)) as Row | null;
  const contact = company && Array.isArray(company.contacts) ? (company.contacts as Row[]).find((c) => c.id === id) : undefined;
  if (!company || !contact) throw notFound("contact");
  return { company, contact };
}

/** One contact as the API gives it: the list answers unless revealed today (`contactsAsListed`, audit M-11). */
async function readContact(userId: string, id: string) {
  const { company, contact } = await contactOnTab(id);
  const [listed] = await contactsAsListed(userId, [contact]);
  const custom = await customFieldsOut("CONTACT", userId, [id]);
  return contactOut(listed!, company, custom.get(id));
}

export async function listContactsApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("contacts_library", call.actor.userId, "Contacts");
  const { page, pageSize } = paging(call.url, API_MAX_PAGE_SIZE, API_DEFAULT_PAGE_SIZE);
  const { rows, total } = await listAllContactsPaged({ page, pageSize, search: call.url.searchParams.get("search")?.slice(0, 100) || undefined });
  const typed = await exportedContacts(call.actor.userId, rows as unknown as Row[]);
  const [custom, answers] = await Promise.all([customFieldsOut("CONTACT", call.actor.userId, typed.map((r) => r.id)), exportAnswers(call.actor.userId, "contacts")]);
  return { data: typed.map((r) => contactOut(r, rec(r.company), exportedCustom(custom.get(r.id), answers))), page: pageOf(page, pageSize, total) };
}

export async function getContactApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("contacts_library", call.actor.userId, "Contacts");
  const id = await idOf("contact", call.params.ref);
  if (!id) throw notFound("contact");
  return { data: await readContact(call.actor.userId, id) };
}

export async function createContactApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("contacts_library", call.actor.userId, "Contacts");
  const input = contactCreateSchema.parse(await call.body());
  const companyId = await idOf("company", input.company);
  if (!companyId) throw new ApiError(422, "refused", "No company by that reference reaches this key.", { company: "Not found." });
  const made = await addContact(companyId, contactInput(input));
  if (!made.ok) throw refusedBy(made);
  return { status: 201, data: await readContact(call.actor.userId, made.data.id) };
}

export async function patchContactApi(call: ApiCall): Promise<ApiAnswer> {
  await needModule("contacts_library", call.actor.userId, "Contacts");
  const id = await idOf("contact", call.params.ref);
  if (!id) throw notFound("contact");
  const input = contactPatchSchema.parse(await call.body());
  // What the key's person sees of it on its company's Contacts tab — a detail hidden from them there is kept by the
  // action, never cleared. Not the API's own read (`readContact`, the list's answers since 5 Nov 2026): a detail that
  // tab shows in the clear but a list masks would be sent back masked, and saved.
  const { company, contact } = await contactOnTab(id);
  const now = contactOut(contact, company, undefined);
  // And a value sent back exactly as the API showed it masked is no change ("saving keeps the real values").
  const shown = contactOut((await contactsAsListed(call.actor.userId, [contact]))[0]!, company, undefined);
  const unlessShown = (sent: string | undefined, field: "name" | "email" | "phone") => (sent !== undefined && sent === shown[field] && shown[field] !== now[field] ? undefined : sent);
  const done = await updateContact({
    id,
    ...contactInput({
      name: unlessShown(input.name, "name") ?? now.name,
      designation: input.designation ?? now.designation ?? "OTHER",
      designation_name: input.designation_name ?? now.designation_name ?? undefined,
      email: unlessShown(input.email, "email") ?? now.email ?? "",
      phone: unlessShown(input.phone, "phone") ?? now.phone ?? "",
      linkedin_url: input.linkedin_url ?? now.linkedin_url ?? "",
      is_primary: input.is_primary ?? now.is_primary,
      receives_documents: input.receives_documents ?? now.receives_documents,
    }),
  });
  if (!done.ok) throw refusedBy(done);
  return { data: await readContact(call.actor.userId, id) };
}
