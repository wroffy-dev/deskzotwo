/**
 * check:export-masking — Phase 3 masking fixes, wave B, Agent K1 (owner, 5 Nov 2026; DESKZO_PERMISSION_SYSTEM_AUDIT.md
 * H.4.4, M-11, M-13, M-10):
 *
 *   1. The `export` dimension of a field policy (src/lib/authz/field-policy.ts `ExportMode`): what it means, saved through
 *      the role and person paths, held to "nothing wider than your own" — putting a field back to nothing set included.
 *   2. Every export uses the list's answers plus `export`: the leads CSV, the leads, contacts and parties data exports, the
 *      account workbook and the API's lists — left out, masked though the screens show it (blank where the file is read
 *      back and the import couldn't tell), in the clear only where it is seen so somewhere; a "Show" never opens a field
 *      exported masked; the screens and the app's lists unchanged; the master switch followed.
 *   3. API v1 and the app read one lead, company or contact with the list's answers, not its page's — the page's only
 *      after a counted reveal today — and a value sent back exactly as it was shown masked is no change.
 *   4. The office TV's wins wall masked with the workspace's most restrictive policy, not the pairer's.
 *   5. The daily limit: words that say when the workspace default applies; a role put back to the default, or given an
 *      explicit "no limit"; the role editor, the person panel and the role's screens telling the truth — all three in
 *      Settings › Access Control now (Field Permissions, Unmasking Limits, the person's PII & Unmasking). And the
 *      companies' unmask switch back in both editors (wave B's "Show"), saved as sent.
 *
 * On this workspace's database: a ZZ role, an admin, a member and a sales person of its own (`@zz-export-check.invalid`),
 * a ZZ company with a contact and a lead — all removed in a finally, with their policies, usage rows, permission history,
 * audit and activity lines. The unmasking log is never written: a "counted reveal" is its usage row, put in and taken
 * out here. The master switch is flipped in this process only.
 *
 *   npm run check:export-masking
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import Module from "node:module";
import path from "node:path";
import { directClient } from "../src/lib/tenancy/direct-client";

process.env.DESKZO_TENANCY_FALLBACK = process.env.DESKZO_TENANCY_FALLBACK || "legacy";

type Actor = { id: string; role: string; name: string; email: string };
let actor: Actor | null = null;
let maskingOn = true;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = async () => {
      if (!actor) throw new Error("The check called an action without saying who was calling it.");
      return actor;
    };
    return { requireUser: user, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/lib/authz/masking-switch" || request.endsWith("lib/authz/masking-switch")) {
    const real = realLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, fieldMaskingEnabled: async () => maskingOn };
  }
  if (request === "next/navigation") {
    return { useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }), usePathname: () => "/", useSearchParams: () => new URLSearchParams(), notFound: () => { throw new Error("notFound"); }, redirect: (to: string) => { throw new Error(`redirect ${to}`); } };
  }
  return realLoad.call(this, request, parent, isMain);
} as typeof realLoad;

const db = directClient();
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

const MAIL = "@zz-export-check.invalid";
const ROLE = "ZZPROBE_EXPORT";
const REASON = "zz export check";
const TAG = `ZZ Export ${Date.now().toString(36)}`;
const RAW = {
  title: `Zircon ${TAG} renewal`,
  description: `Wants 40 seats — ${TAG} enquiry`,
  company: `${TAG} Quartz Pvt Ltd`,
  contact: `Zara ${TAG}`,
  email: "zara.export@zz-quartz.example",
  phone: "+91 98111 22334",
  website: "https://zz-export-check.example",
  site: "zz-export-check.example",
  pan: "AAZPE1234K",
  address: "17 Feldspar Street",
  city: "Exportabad",
  desk: "https://zz-desk.example/help",
};
const MASKED_TITLE = "Z********";
const RAWS = [RAW.title, RAW.description, RAW.email, RAW.phone, RAW.site, RAW.pan, RAW.address, RAW.desk];
/** The raw values a response carries — none, where they are masked. */
const leaks = (value: unknown, values: string[] = RAWS) => {
  const text = JSON.stringify(value ?? null);
  return values.filter((v) => text.includes(v));
};
const OPEN = { view: true, maskInList: false, maskInDetail: false, unmask: false };
const LIST_ONLY = { view: true, maskInList: true, maskInDetail: false, unmask: false };

async function cleanup(startedAt: Date) {
  const users = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  const companies = (await db.company.findMany({ where: { name: { contains: "ZZ Export " } }, select: { id: true } })).map((c) => c.id);
  const leads = (await db.lead.findMany({ where: { companyId: { in: companies } }, select: { id: true } })).map((l) => l.id);
  const contacts = (await db.contact.findMany({ where: { companyId: { in: companies } }, select: { id: true } })).map((c) => c.id);
  await db.celebration.deleteMany({ where: { title: { contains: "ZZ Export " } } });
  await db.permissionChange.deleteMany({ where: { OR: [{ subjectRole: ROLE }, { subjectUserId: { in: users } }, { actorUserId: { in: users } }] } });
  await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: users } }, { entityId: { in: [...companies, ...leads, ...contacts] } }], createdAt: { gte: startedAt } } });
  await db.activityLog.deleteMany({ where: { userId: { in: users } } });
  await db.activity.deleteMany({ where: { leadId: { in: leads } } });
  await db.lead.deleteMany({ where: { id: { in: leads } } });
  await db.contact.deleteMany({ where: { id: { in: contacts } } });
  await db.companyLocation.deleteMany({ where: { companyId: { in: companies } } });
  await db.company.deleteMany({ where: { id: { in: companies } } });
  await db.unmaskUsage.deleteMany({ where: { userId: { in: users } } });
  await db.userUnmaskLimit.deleteMany({ where: { userId: { in: users } } });
  await db.userFieldPolicy.deleteMany({ where: { userId: { in: users } } });
  await db.userPermission.deleteMany({ where: { userId: { in: users } } });
  await db.notification.deleteMany({ where: { userId: { in: users } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.roleUnmaskLimit.deleteMany({ where: { role: ROLE } });
  await db.roleFieldPolicy.deleteMany({ where: { role: ROLE } });
  await db.rolePermission.deleteMany({ where: { role: ROLE } });
  await db.role.deleteMany({ where: { key: ROLE } });
}

async function main() {
  const fp = await import("../src/lib/authz/field-policy");
  const access = await import("../src/actions/field-access");
  const fields = await import("../src/lib/authz/fields");
  const leadActions = await import("../src/actions/lead");
  const { getCompany } = await import("../src/actions/company");
  const { listAllContactsPaged } = await import("../src/actions/contact");
  const { leadsExporter } = await import("../src/lib/portability/exporters/leads");
  const { companiesExporter, contactsExporter } = await import("../src/lib/portability/exporters/crm");
  const { accountBundle } = await import("../src/lib/portability/export");
  const apiLeads = await import("../src/lib/api/v1/leads");
  const apiCompanies = await import("../src/lib/api/v1/companies");
  const app = await import("../src/lib/app/sales");
  const { maskDealWins } = await import("../src/lib/leads/masking");
  const { buildWinsWall } = await import("../src/lib/wins/wall");
  const { businessDate, workspaceUnmaskDefault } = await import("../src/lib/authz/unmask");
  const { formatLeadId, formatCompanyId, formatContactId } = await import("../src/lib/order-id");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { cloneElement, isValidElement } = await import("react");
  // The editors are screens of Settings › Access Control now: Field Permissions for a role or a person (the Export
  // column, the unmask switch, the limit in words), Unmasking Limits for a role's daily limit, and the person's
  // profile there (PII & Unmasking) for theirs.
  const FIELDS_PAGE = await import("../src/app/(dashboard)/settings/access/fields/page");
  const LIMITS_PAGE = await import("../src/app/(dashboard)/settings/access/sensitive/limits/page");
  const EMPLOYEE_PAGE = await import("../src/app/(dashboard)/settings/access/employees/[id]/page");
  /** A server component tree with its nested async components awaited, so it can be rendered. */
  const resolveAsync = async (node: unknown): Promise<unknown> => {
    if (Array.isArray(node)) return Promise.all(node.map(resolveAsync));
    if (!isValidElement(node)) return node;
    const el = node as import("react").ReactElement<{ children?: unknown }>;
    if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") return resolveAsync(await (el.type as (props: unknown) => Promise<unknown>)(el.props));
    if (el.props && "children" in el.props) {
      const kids = await resolveAsync(el.props.children);
      return Array.isArray(kids) ? cloneElement(el, undefined, ...(kids as import("react").ReactNode[])) : cloneElement(el, undefined, kids as import("react").ReactNode);
    }
    return el;
  };
  const render = async (page: unknown) => renderToStaticMarkup((await resolveAsync(await page)) as import("react").ReactElement);
  /** What a person reads: the markup without its tags, React's text separators or entities. */
  const words = (markup: string) => markup.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

  const startedAt = new Date();
  await cleanup(new Date(0));
  const superAdmin = await db.user.findFirst({ where: { isSuperAdmin: true, active: true }, select: { id: true, role: true, name: true, email: true } });
  if (!superAdmin) throw new Error("Need an active super admin.");
  const as = (u: Actor) => {
    actor = { id: u.id, role: u.role, name: u.name, email: u.email };
  };
  const person = (key: string, role: string) =>
    db.user.create({ data: { name: `Zz Export ${key}`, email: `${key.toLowerCase()}${MAIL}`, role, passwordHash: "x".repeat(60) }, select: { id: true, role: true, name: true, email: true } });
  /** A personal policy put straight in, as a super admin's save would leave it — with this check's reason. */
  const personal = (userId: string, entity: string, field: string, policy: Record<string, unknown>, format: string, exported: string | null = null) =>
    db.userFieldPolicy.upsert({
      where: { user_entity_field: { userId, entity, field } },
      create: { userId, entity, field, view: true, maskInList: false, maskInDetail: false, unmask: false, ...policy, format, export: exported, reason: REASON },
      update: { view: true, maskInList: false, maskInDetail: false, unmask: false, ...policy, format, export: exported, reason: REASON },
    });
  const noPolicies = (userId: string) => db.userFieldPolicy.deleteMany({ where: { userId } });
  const callFor = (userId: string, p: string, ref = "", body: Record<string, unknown> = {}) =>
    ({ actor: { userId }, url: new URL(`https://deskzo.test${p}`), params: { ref }, req: new Request(`https://deskzo.test${p}`), body: async () => body }) as never;

  try {
    await db.role.create({ data: { key: ROLE, name: "Zz export probe" } });
    const seller = await person("Seller", "SALES");
    const admin = await person("Admin", "ADMIN");
    const member = await person("Member", ROLE);
    // What the sales person's screens need beyond their role's, held for this check only.
    for (const permission of ["data.exportCrm", "contacts.view", "contacts.directory", "leads.view", "leads.edit", "companies.edit", "contacts.edit"]) {
      await db.userPermission.create({ data: { userId: seller.id, permission, allowed: true, reason: REASON } });
    }
    const company = await db.company.create({
      data: {
        name: RAW.company,
        normalizedName: RAW.company.toLowerCase(),
        createdById: seller.id,
        ownerUserId: seller.id,
        stage: "CUSTOMER",
        website: RAW.website,
        panNumber: RAW.pan,
        customFields: { it_service_desk_url: RAW.desk },
        locations: { create: [{ label: "Head Office", address: RAW.address, city: RAW.city, state: "Maharashtra", country: "India", isPrimary: true, isBilling: true, isShipping: true }] },
      },
      select: { id: true, companySeq: true },
    });
    const contact = await db.contact.create({ data: { companyId: company.id, name: RAW.contact, email: RAW.email, phone: RAW.phone }, select: { id: true, contactSeq: true } });
    const lead = await db.lead.create({
      data: { companyId: company.id, contactId: contact.id, ownerUserId: seller.id, createdByUserId: seller.id, title: RAW.title, description: RAW.description, source: "WEBSITE" },
      select: { id: true, leadSeq: true },
    });
    const leadRef = formatLeadId(lead.leadSeq);
    const companyRef = formatCompanyId(company.companySeq);
    const contactRef = formatContactId(contact.contactSeq);

    // ─────────────────────────────────────────────────────────────────────────────────────────────────
    section("1. The export dimension");
    const masked = fp.normalisePolicy("text", { ...OPEN, format: "first", export: "masked" });
    ok("a policy keeps its export mode", masked.export === "masked");
    ok("  a field that can't be read has none (restricted in a file too)", fp.normalisePolicy("text", { ...OPEN, view: false, format: null, export: "clear" }).export === null);
    ok("  an unknown mode is the list's", fp.normalisePolicy("text", { ...OPEN, format: null, export: "sometimes" }).export === null);
    ok("as the list: the list's answer", fp.exportVisibility(fp.normalisePolicy("text", { ...LIST_ONLY, format: "first" })) === "masked" && fp.exportVisibility(fp.openPolicy("text")) === "clear");
    ok("left out: nothing in the cell, not the word Restricted", fp.exportVisibility({ ...fp.openPolicy("text"), export: "none" }) === "none" && fp.presentValue("Acme", { ...fp.openPolicy("text"), export: "none" }, "export") === null);
    ok("masked: masked though every screen shows it", fp.presentValue("Acme", masked, "export") === "A********" && fp.presentValue("Acme", masked, "list") === "Acme");
    ok("in the clear: where it is seen so somewhere — masked in lists, clear on the page", fp.exportVisibility(fp.normalisePolicy("text", { ...LIST_ONLY, format: "first", export: "clear" })) === "clear");
    ok("  masked everywhere, it stays masked", fp.exportVisibility(fp.normalisePolicy("text", { view: true, maskInList: true, maskInDetail: true, unmask: true, format: "first", export: "clear" })) === "masked");
    ok("nothing wider than your own, in an export too", !fp.withinPolicy({ ...fp.openPolicy("text"), export: "clear" }, masked) && fp.withinPolicy(masked, masked));

    as(superAdmin);
    const roleSave = await access.setRoleFieldAccess(ROLE, [{ field: "title", policy: { ...OPEN, format: "first", export: "masked" } as never }]);
    const roleRow = await db.roleFieldPolicy.findUnique({ where: { role_entity_field: { role: ROLE, entity: "leads", field: "title" } } });
    ok("the role's Field Permissions save an export mode", roleSave.ok && roleRow?.export === "masked", roleSave.ok ? roleRow : roleSave.error);
    const roleRead = await access.roleFieldAccess(ROLE);
    ok("  and read it back", roleRead?.rows.find((r) => r.key === "title")?.stored?.export === "masked");
    ok("  its history says so", !!(await db.permissionChange.findFirst({ where: { subjectRole: ROLE, permission: "field:leads:title", detail: { contains: "exported masked" } } })));
    ok("  a mode that isn't one is refused", !(await access.setRoleFieldAccess(ROLE, [{ field: "title", policy: { ...OPEN, format: "first", export: "sometimes" } as never }])).ok);
    const personSave = await access.setPersonFieldAccess(member.id, [{ field: "email", policy: { ...OPEN, format: "email", export: "none" } as never }], { reason: REASON });
    const personRead = await access.personFieldAccess(member.id);
    ok("a person's own: saved and read back", personSave.ok && personRead?.rows.find((r) => r.key === "email")?.effective.export === "none", personSave.ok ? personRead?.rows.find((r) => r.key === "email")?.effective : personSave.error);
    ok("  their resolved policy has it", (await fields.resolveFieldPolicies(member.id)).fields.get("email")?.policy.export === "none");

    // An admin whose own lead name is exported masked can't hand anybody more of it — nor by putting it back to nothing set.
    await personal(admin.id, "leads", "title", OPEN, "first", "masked");
    as(admin);
    const wider = await access.setRoleFieldAccess(ROLE, [{ field: "title", policy: { ...OPEN, format: "first", export: "clear" } as never }]);
    ok("an admin who exports a field masked can't give a role it in the clear", !wider.ok && /more of Lead name/.test(wider.error), wider);
    const reset = await access.setRoleFieldAccess(ROLE, [{ field: "title", policy: null }]);
    ok("  nor by putting the role's back to nothing set (the list's — in the clear)", !reset.ok && (await db.roleFieldPolicy.findUnique({ where: { role_entity_field: { role: ROLE, entity: "leads", field: "title" } } }))?.export === "masked", reset);
    const widerPerson = await access.setPersonFieldAccess(member.id, [{ field: "title", policy: { ...OPEN, format: "first", export: "clear" } as never }]);
    ok("  nor a person", !widerPerson.ok && /more of Lead name/.test(widerPerson.error), widerPerson);
    ok("  while as narrow as their own is fine", (await access.setPersonFieldAccess(member.id, [{ field: "title", policy: { ...OPEN, format: "first", export: "none" } as never }], { reason: REASON })).ok);

    as(superAdmin);
    const companyUnmask = await access.setPersonFieldAccess(member.id, [{ field: "website", policy: { view: true, maskInList: true, maskInDetail: true, unmask: true, format: "first", export: null } }], { reason: REASON }, "companies");
    const companyRule = await db.userFieldPolicy.findUnique({ where: { user_entity_field: { userId: member.id, entity: "companies", field: "website" } } });
    ok("a company field's unmask is saved as sent — the companies' Show reveals it (wave B)", companyUnmask.ok && companyRule?.unmask === true, companyUnmask.ok ? companyRule : companyUnmask.error);
    ok("  every record type reveals now", fp.FIELD_ENTITY_REVEALS.companies === true);
    await noPolicies(member.id);

    // ─────────────────────────────────────────────────────────────────────────────────────────────────
    section("2. Every export: the list's answers plus export");
    await personal(seller.id, "leads", "title", OPEN, "first", "masked");
    await personal(seller.id, "leads", "description", OPEN, "first", "none");
    await personal(seller.id, "leads", "companyName", LIST_ONLY, "first", "clear");
    await personal(seller.id, "contacts", "email", OPEN, "email", "masked");
    await personal(seller.id, "contacts", "phone", OPEN, "phone_last4", "none");
    await personal(seller.id, "companies", "website", OPEN, "first", "masked");
    await personal(seller.id, "companies", "pan", OPEN, "first", "none");
    await personal(seller.id, "companies", "address", { view: true, maskInList: true, maskInDetail: true, unmask: false }, "stars", "clear");
    await personal(seller.id, "companies", "custom:it_service_desk_url", OPEN, "first", "none");
    as(seller);

    const screen = (await leadActions.listLeadsPaged({ page: 1, pageSize: 50, search: TAG })).rows.find((r) => r.id === lead.id);
    ok("the Leads list (a screen) as it was: the title and description in the clear, the company masked", screen?.title === RAW.title && screen.company.name !== RAW.company, screen && { title: screen.title, company: screen.company.name });
    const csv = await leadActions.exportLeadsCsv();
    const csvText = csv.ok ? csv.data.csv : "";
    ok("the leads CSV: the title masked though the list shows it", csv.ok && csvText.includes(MASKED_TITLE) && !csvText.includes(RAW.title), csv.ok ? csvText.split("\n").find((l) => l.includes(TAG.split(" ")[2]!)) : csv.error);
    ok("  the description left out", csv.ok && !csvText.includes(RAW.description));
    ok("  the company in the clear — masked in lists, seen in the clear on the lead", csv.ok && csvText.includes(RAW.company));
    ok("  no raw value it shouldn't have", leaks(csvText).length === 0, leaks(csvText));

    const leadSheet = ((await leadsExporter({ userId: seller.id, ownerUserIds: null })) as Record<string, unknown>[]).find((r) => r.Key === leadRef);
    ok("the leads data export: masked by the export alone goes out blank — the import would read stars as typed", leadSheet?.Title === "" && leadSheet.Description === "", leadSheet && { Title: leadSheet.Title, Description: leadSheet.Description });
    ok("  the company in the clear", leadSheet?.Company === RAW.company, leadSheet?.Company);
    ok("  the contact's email and phone by the contact's export: blank (only the contact's rules conceal them)", leadSheet?.["Contact email"] === "" && leadSheet["Contact phone"] === "", leadSheet && [leadSheet["Contact email"], leadSheet["Contact phone"]]);
    ok("  no raw value", leaks(leadSheet).length === 0, leaks(leadSheet));

    const contactsList = (await listAllContactsPaged({ page: 1, pageSize: 50, search: TAG })).rows.find((r) => r.id === contact.id);
    ok("the Contacts list (a screen) as it was: email and phone in the clear", contactsList?.email === RAW.email && contactsList.phone === RAW.phone, contactsList && { email: contactsList.email });
    const contactSheet = ((await contactsExporter({ userId: seller.id, ownerUserIds: null })) as Record<string, unknown>[]).find((r) => r.Key === contactRef);
    ok("the contacts export: the email masked (the import knows it by its stars), the phone left out", typeof contactSheet?.Email === "string" && /^z\*{5}@z\*{3}\.example$/.test(contactSheet.Email) && contactSheet.Phone === "", contactSheet && { Email: contactSheet.Email, Phone: contactSheet.Phone });
    ok("  its status gone with the email", contactSheet?.["Email status"] === "");

    const partyRows = ((await companiesExporter({ userId: seller.id, ownerUserIds: null })) as Record<string, unknown>[]).filter((r) => r.Name === RAW.company);
    const party = partyRows[0];
    ok("the companies export: the website masked by the export alone — blank; the PAN left out — blank", party?.Website === "" && party.PAN === "", party && { Website: party.Website, PAN: party.PAN });
    ok("  the address \"in the clear\" but masked everywhere: masked", party?.Address === "********" && party.City === "********", party && [party.Address, party.City]);
    const deskHeading = Object.keys(party ?? {}).find((k) => /service desk/i.test(k));
    ok("  a custom field left out: its cell blank", !!deskHeading && party![deskHeading] === "", deskHeading && party?.[deskHeading]);
    ok("  no raw value", leaks(partyRows).length === 0, leaks(partyRows));

    const bundle = await accountBundle(seller.id, company.id);
    const sheet = (name: string) => (bundle?.sheets.find((s) => s.name === name)?.rows ?? []) as Record<string, unknown>[];
    ok("the account workbook (never read back): the website masked, the PAN not there", sheet("Account")[0]?.Website === "h********", sheet("Account")[0]?.Website);
    ok("  its contact's email masked, the phone left out", /\*{5}@/.test(String(sheet("Contacts")[0]?.Email)) && sheet("Contacts")[0]?.Phone === "", sheet("Contacts")[0]);
    ok("  its lead's title masked", sheet("Leads").some((r) => r.Title === MASKED_TITLE), sheet("Leads").map((r) => r.Title));
    ok("  no raw value", leaks(bundle?.sheets).length === 0, leaks(bundle?.sheets));

    const apiLeadList = (await apiLeads.listLeadsApi(callFor(seller.id, `/api/v1/leads?search=${encodeURIComponent(TAG)}`))) as { data: { id: string; title: string; description: string | null; company: { name: string } | null }[] };
    const apiLead = apiLeadList.data.find((l) => l.id === lead.id);
    ok("API v1 leads list: the title masked, the description left out, the company in the clear", apiLead?.title === MASKED_TITLE && !apiLead.description && apiLead.company?.name === RAW.company, apiLead);
    const apiContactList = (await apiCompanies.listContactsApi(callFor(seller.id, `/api/v1/contacts?search=${encodeURIComponent(TAG)}`))) as { data: { id: string; email: string | null; phone: string | null }[] };
    const apiContact = apiContactList.data.find((c) => c.id === contact.id);
    ok("API v1 contacts list: the email masked, the phone left out", !!apiContact?.email && /\*{5}@/.test(apiContact.email) && apiContact.phone === null, apiContact);
    const apiCompanyList = (await apiCompanies.listCompaniesApi(callFor(seller.id, `/api/v1/companies?search=${encodeURIComponent(TAG)}`))) as { data: { id: string; website: string | null; custom_fields: Record<string, unknown> }[] };
    const apiCompany = apiCompanyList.data.find((c) => c.id === company.id);
    ok("API v1 companies list: the website masked, the custom field left out", apiCompany?.website === "h********" && !("it_service_desk_url" in (apiCompany.custom_fields ?? {})), apiCompany);
    ok("  the API's lists carry no raw value", leaks([apiLeadList, apiContactList, apiCompanyList]).length === 0, leaks([apiLeadList, apiContactList, apiCompanyList]));
    const appList = (await app.appLeads(callFor(seller.id, `/api/app/leads?search=${encodeURIComponent(TAG)}`))) as { data: { id: string; title: string }[] };
    ok("the app's leads list is a screen, not an export: the title as the list shows it", appList.data.find((l) => l.id === lead.id)?.title === RAW.title);

    // A "Show" today opens the Contacts list, never a field exported masked.
    await personal(seller.id, "contacts", "email", { view: true, maskInList: true, maskInDetail: true, unmask: true }, "email", "masked");
    await db.unmaskUsage.create({ data: { userId: seller.id, businessDate: await businessDate(), entity: "contacts", recordId: contact.id, leadId: `contact:${contact.id}`, fields: ["email"] } });
    const shownToday = (await listAllContactsPaged({ page: 1, pageSize: 50, search: TAG })).rows.find((r) => r.id === contact.id);
    const revealedSheet = ((await contactsExporter({ userId: seller.id, ownerUserIds: null })) as Record<string, unknown>[]).find((r) => r.Key === contactRef);
    ok("revealed today: the Contacts list shows the email — the export still masks it", shownToday?.email === RAW.email && typeof revealedSheet?.Email === "string" && revealedSheet.Email !== RAW.email && /\*{5}@/.test(revealedSheet.Email), { list: shownToday?.email, file: revealedSheet?.Email });
    await db.unmaskUsage.deleteMany({ where: { userId: seller.id } });

    maskingOn = false;
    const off = await fields.leadMasker(seller.id, "export");
    ok("the master switch off: \"masked\" exports in the clear, \"left out\" stays out", off.present("title", RAW.title) === RAW.title && off.present("description", RAW.description) === null);
    maskingOn = true;
    await noPolicies(seller.id);

    // ─────────────────────────────────────────────────────────────────────────────────────────────────
    section("3. API and app: one record with the list's answers");
    await personal(seller.id, "leads", "title", LIST_ONLY, "first");
    await personal(seller.id, "contacts", "email", LIST_ONLY, "email");
    await personal(seller.id, "companies", "website", LIST_ONLY, "first");
    as(seller);
    const page = await leadActions.getLead(lead.id);
    ok("the lead's own page shows the title (masked in lists only)", page?.title === RAW.title);
    const one = (await apiLeads.getLeadApi(callFor(seller.id, `/api/v1/leads/${leadRef}`, leadRef))) as { data: { title: string } };
    ok("API v1, one lead: the list's answer — masked", one.data.title === MASKED_TITLE && leaks(one, [RAW.title]).length === 0, one.data.title);
    const appOne = (await app.appLead(callFor(seller.id, `/api/app/leads/${leadRef}`, leadRef))) as { data: { title: string } };
    ok("the app, one lead: masked, no raw title", appOne.data.title === MASKED_TITLE && leaks(appOne, [RAW.title]).length === 0, appOne.data.title);
    const companyPage = await getCompany(company.id);
    ok("the company's own page shows its website and its contact's email", companyPage?.website === RAW.website && companyPage.contacts.find((c) => c.id === contact.id)?.email === RAW.email);
    const apiCompanyOne = (await apiCompanies.getCompanyApi(callFor(seller.id, `/api/v1/companies/${companyRef}`, companyRef))) as { data: { website: string | null; contacts: { id: string; email: string | null }[] } };
    ok("API v1, one company: the website and its contact's email masked", apiCompanyOne.data.website === "h********" && /\*{5}@/.test(apiCompanyOne.data.contacts.find((c) => c.id === contact.id)?.email ?? ""), { website: apiCompanyOne.data.website, email: apiCompanyOne.data.contacts.find((c) => c.id === contact.id)?.email });
    const apiContactOne = (await apiCompanies.getContactApi(callFor(seller.id, `/api/v1/contacts/${contactRef}`, contactRef))) as { data: { email: string | null } };
    ok("API v1, one contact: the email masked", /\*{5}@/.test(apiContactOne.data.email ?? ""), apiContactOne.data.email);
    const appCompanyOne = (await app.appCompany(callFor(seller.id, `/api/app/companies/${companyRef}`, companyRef))) as { data: { website: string | null; contacts: { id: string; email: string | null }[] } };
    ok("the app, one company: the website and the contact's email masked", appCompanyOne.data.website === "h********" && /\*{5}@/.test(appCompanyOne.data.contacts.find((c) => c.id === contact.id)?.email ?? ""), appCompanyOne.data.website);
    // (A lead's own contact email follows the leads policy's "email", not the contacts policy — audit H.4.1's alias, not
    // this check's: so the contact's email is looked for in the company and contact reads, the title in all.)
    ok("  none of the single reads carries a raw value", leaks([one, appOne, apiCompanyOne, apiContactOne, appCompanyOne], [RAW.title, RAW.site]).length === 0 && leaks([apiCompanyOne, apiContactOne, appCompanyOne], [RAW.email]).length === 0, leaks([one, appOne, apiCompanyOne, apiContactOne, appCompanyOne], [RAW.title, RAW.email, RAW.site]));

    // Sent back exactly as shown: no change.
    const patched = await apiLeads.patchLeadApi(callFor(seller.id, `/api/v1/leads/${leadRef}`, leadRef, { title: MASKED_TITLE, description: `${RAW.description} (seen)` }));
    const leadAfter = await db.lead.findUniqueOrThrow({ where: { id: lead.id }, select: { title: true, description: true } });
    ok("a lead's title sent back as the API showed it, masked: the real one kept, the rest saved", leadAfter.title === RAW.title && leadAfter.description === `${RAW.description} (seen)`, { patched: (patched as { data?: { title?: string } }).data?.title, stored: leadAfter.title });
    await db.lead.update({ where: { id: lead.id }, data: { description: RAW.description } });
    const maskedEmail = apiContactOne.data.email!;
    await apiCompanies.patchContactApi(callFor(seller.id, `/api/v1/contacts/${contactRef}`, contactRef, { email: maskedEmail, designation_name: "Buyer" }));
    ok("a contact's email sent back masked: the real one kept", (await db.contact.findUniqueOrThrow({ where: { id: contact.id }, select: { email: true } })).email === RAW.email);
    await apiCompanies.patchCompanyApi(callFor(seller.id, `/api/v1/companies/${companyRef}`, companyRef, { website: "h********" }));
    ok("a company's website sent back masked: the real one kept", (await db.company.findUniqueOrThrow({ where: { id: company.id }, select: { website: true } })).website === RAW.website);

    // A counted reveal today: the page's answers.
    const day = await businessDate();
    await db.unmaskUsage.createMany({
      data: [
        { userId: seller.id, businessDate: day, entity: "leads", recordId: lead.id, leadId: lead.id, fields: ["title"] },
        { userId: seller.id, businessDate: day, entity: "companies", recordId: company.id, leadId: `company:${company.id}`, fields: ["website"] },
        { userId: seller.id, businessDate: day, entity: "contacts", recordId: contact.id, leadId: `contact:${contact.id}`, fields: ["email"] },
      ],
    });
    const revealedLead = (await apiLeads.getLeadApi(callFor(seller.id, `/api/v1/leads/${leadRef}`, leadRef))) as { data: { title: string } };
    const revealedCompany = (await apiCompanies.getCompanyApi(callFor(seller.id, `/api/v1/companies/${companyRef}`, companyRef))) as { data: { website: string | null } };
    const revealedContact = (await apiCompanies.getContactApi(callFor(seller.id, `/api/v1/contacts/${contactRef}`, contactRef))) as { data: { email: string | null } };
    ok("revealed today (a counted reveal): one lead, company and contact as their pages show them", revealedLead.data.title === RAW.title && revealedCompany.data.website === RAW.website && revealedContact.data.email === RAW.email, [revealedLead.data.title, revealedCompany.data.website, revealedContact.data.email]);
    await db.unmaskUsage.deleteMany({ where: { userId: seller.id } });
    await noPolicies(seller.id);

    // ─────────────────────────────────────────────────────────────────────────────────────────────────
    section("4. The office TV: the workspace's most restrictive policy");
    await personal(seller.id, "leads", "companyName", LIST_ONLY, "first");
    const won = await db.celebration.create({
      data: { kind: "ACHIEVEMENT", source: "DEAL_WON", occasionKey: `deal:${lead.id}`, title: `₹2 lakh won — ${RAW.company}`, message: `Zz closed “${RAW.title}”.`, details: { leadId: lead.id }, startsOn: new Date(), endsOn: new Date(Date.now() + 86_400_000) },
    });
    const [asPairer] = await maskDealWins(superAdmin.id, [won]);
    ok("as a super admin who paired it, the deal's words are in the clear (what the TV showed)", asPairer!.title === won.title);
    const strictest = await fields.resolveFieldPolicies(fields.SHARED_SCREEN_VIEWER, "leads");
    const companyName = strictest.fields.get("companyName")?.policy;
    ok("the shared screen's policy: a field one person sees masked is masked (or restricted, if somebody may not read it)", !!companyName && (companyName.view ? companyName.maskInList : true), companyName);
    ok("  a field everybody reads in the clear is in the clear — it is the strictest, not \"nothing\"", strictest.fields.get("source")?.policy.view === true && strictest.fields.get("source")?.policy.maskInList === false, strictest.fields.get("source")?.policy);
    const [onTv] = await maskDealWins(fields.SHARED_SCREEN_VIEWER, [won]);
    ok("the TV's deal words: the company masked as the strictest policy says", onTv!.title !== won.title && !onTv!.title.includes(RAW.company) && /\*{8}|Restricted/.test(onTv!.title), onTv!.title);
    const wall = await buildWinsWall({ viewerId: null, maskAs: fields.SHARED_SCREEN_VIEWER, branchId: null });
    const ours = wall.wins.find((w) => w.id === won.id);
    ok("  the wall built for a TV: masked, no raw company", !!ours && !JSON.stringify(ours).includes(RAW.company), ours?.title);
    const tvPage = readFileSync(path.join(process.cwd(), "src/app/(tv)/tv/wins/page.tsx"), "utf8");
    ok("  and the TV page asks for it, not for whoever paired the screen", /maskAs:\s*SHARED_SCREEN_VIEWER/.test(tvPage) && !/maskAs:\s*screen\.pairedById/.test(tvPage));
    await db.celebration.delete({ where: { id: won.id } });
    await noPolicies(seller.id);

    // ─────────────────────────────────────────────────────────────────────────────────────────────────
    section("5. The daily limit, said truthfully; companies' unmask switch back");
    const fallback = (await workspaceUnmaskDefault()).dailyLimit;
    as(superAdmin);
    ok("a role's limit: a number", (await access.setRoleUnmaskLimit(ROLE, 5)).ok && (await db.roleUnmaskLimit.findUnique({ where: { role: ROLE } }))?.dailyLimit === 5);
    ok("  an explicit no limit (a row with none)", (await access.setRoleUnmaskLimit(ROLE, null)).ok && (await db.roleUnmaskLimit.findUnique({ where: { role: ROLE } }))?.dailyLimit === null && (await access.roleFieldAccess(ROLE))?.limitStored === true);
    const backToDefault = await access.setRoleUnmaskLimit(ROLE, "default");
    const afterDefault = await access.roleFieldAccess(ROLE);
    ok("  and back to the workspace default: the row taken away", backToDefault.ok && (await db.roleUnmaskLimit.findUnique({ where: { role: ROLE } })) === null && afterDefault?.limitStored === false && afterDefault.workspaceDefault === fallback, backToDefault);
    ok("  the history says so", !!(await db.permissionChange.findFirst({ where: { subjectRole: ROLE, permission: "unmask:dailyLimit", changeKind: "RESET_TO_DEFAULT", detail: { contains: "workspace default" } } })));

    await personal(member.id, "leads", "email", { view: true, maskInList: true, maskInDetail: true, unmask: true }, "email");
    const memberLimit = await access.personFieldAccess(member.id);
    ok("a person following a role with nothing set: the workspace default, said so", memberLimit?.limit.effective === fallback && memberLimit.limit.inheritedFrom === "workspaceDefault" && /workspace default/.test(memberLimit.limit.why), memberLimit?.limit);
    await access.setPersonUnmaskLimit(member.id, { limited: true, dailyLimit: 7 }, { reason: REASON });
    const withOwn = await access.personFieldAccess(member.id);
    ok("  with one of their own: theirs, and what they'd go back to", withOwn?.limit.effective === 7 && withOwn.limit.inherited === fallback && withOwn.limit.inheritedFrom === "workspaceDefault", withOwn?.limit);
    const back = await access.setPersonUnmaskLimit(member.id, null);
    ok("  put back: the history says the workspace default, not \"no limit\"", back.ok && !!(await db.permissionChange.findFirst({ where: { subjectUserId: member.id, permission: "unmask:dailyLimit", detail: { contains: "back to the workspace default" } } })), back);

    await db.userUnmaskLimit.create({ data: { userId: admin.id, limited: true, dailyLimit: 3, reason: REASON } });
    await access.setRoleUnmaskLimit(ROLE, 2);
    as(admin);
    const adminDefault = await access.setRoleUnmaskLimit(ROLE, "default");
    ok("an admin with a limit of 3 can't put a role back to a default above it", fallback !== null && fallback > 3 ? !adminDefault.ok && /higher daily limit/.test(adminDefault.error) : true, adminDefault);
    as(superAdmin);
    await access.setRoleUnmaskLimit(ROLE, "default");

    // Field Permissions on the role (src/app/(dashboard)/settings/access/fields/page.tsx → fields/field-manager.tsx,
    // field-matrix.tsx): the limit said in words (fields/model.ts `limitWords`), and the columns of each field.
    const fallbackWords = fallback === null ? "Workspace default · no limit" : `${fallback} a day · workspace default`;
    const editorHtml = await render(FIELDS_PAGE.default({ searchParams: Promise.resolve({ role: ROLE, entity: "contacts" }) }));
    ok(
      "the role editor's limit: the workspace default named, with its number — not \"Blank is no limit\"",
      words(editorHtml).includes(fallbackWords) && editorHtml.includes("Nothing set on this role, so the workspace default applies") && !/Blank is no limit/.test(editorHtml),
      words(editorHtml).match(/[^.]{0,40}workspace default[^.]{0,40}/i)?.[0] ?? "no mention of the workspace default",
    );
    // Where a role's limit is set now: Unmasking Limits › Limits by role (sensitive/role-limits.tsx).
    const limitsHtml = await render(LIMITS_PAGE.default({ searchParams: Promise.resolve({}) }));
    const roleLimitRow = limitsHtml.split("<tr").find((chunk) => chunk.includes(`/settings/access/fields?role=${ROLE}"`)) ?? "";
    ok(
      "  and on Unmasking Limits: the role follows the workspace default, shown with its number",
      roleLimitRow.includes(">Workspace default<") && words(roleLimitRow).includes(fallback === null ? "No limit" : ` ${fallback} `) && /aria-label="Edit [^"]*daily limit"/.test(roleLimitRow) && !/disabled=""/.test(roleLimitRow),
      words(roleLimitRow) || "the role has no row under Limits by role",
    );
    ok("  an Export column on every field", /aria-label="Email: in exports"/.test(editorHtml) && (await access.roleFieldAccess(ROLE, "contacts"))!.rows.every((r) => editorHtml.includes(`aria-label="${r.label.replaceAll("&", "&amp;").replaceAll("'", "&#x27;")}: in exports"`)));
    const companiesHtml = await render(FIELDS_PAGE.default({ searchParams: Promise.resolve({ role: ROLE, entity: "companies" }) }));
    ok("  companies' unmask switch back", /aria-label="Website: may unmask"/.test(companiesHtml) && !/be unmasked yet/.test(companiesHtml));
    // The person's own limit: their Access Control profile, PII & Unmasking (employees/pii-quota-panel.tsx).
    const panelHtml = await render(EMPLOYEE_PAGE.default({ params: Promise.resolve({ id: member.id }), searchParams: Promise.resolve({ tab: "pii" }) }));
    const memberFields = (await access.personFieldAccess(member.id))!;
    ok(
      "the person panel's limit: what applies (the default), and theirs to set",
      fallback === null || (words(panelHtml).includes(`${fallback} daily limit`) && panelHtml.includes(">Workspace default<") && /the workspace default/.test(words(panelHtml)) && words(panelHtml).includes(memberFields.limit.why) && panelHtml.includes("Set own daily limit")),
      words(panelHtml).match(/Daily unmasking quota.{0,200}/)?.[0] ?? "no quota panel",
    );
    // Their fields: the same manager, opened on the person.
    const maskingHtml = await render(FIELDS_PAGE.default({ searchParams: Promise.resolve({ user: member.id, entity: "companies" }) }));
    ok("  its companies' unmask switch back, and an Export column", /aria-label="Website: may unmask"/.test(maskingHtml) && /aria-label="Website: in exports"/.test(maskingHtml) && !/be unmasked yet/.test(maskingHtml));
    // The old roles page's sentence about a role with nothing set lives in the manager's words now; the page only redirects.
    const limitSource = readFileSync(path.join(process.cwd(), "src/components/access-control/fields/model.ts"), "utf8") + readFileSync(path.join(process.cwd(), "src/components/access-control/sensitive/role-limits.tsx"), "utf8");
    const rolesPage = readFileSync(path.join(process.cwd(), "src/app/(dashboard)/settings/roles/page.tsx"), "utf8");
    ok(
      "the role's screens no longer say nothing set is no limit",
      !limitSource.includes("No limit set: people in this role may unmask as many leads") && !rolesPage.includes("No limit set: people in this role may unmask as many leads") && limitSource.includes("the workspace default applies") && /redirect\(/.test(rolesPage),
    );
  } finally {
    actor = null;
    maskingOn = true;
    await cleanup(startedAt);
  }
  const left = await db.user.count({ where: { email: { endsWith: MAIL } } });
  ok("nothing of the fixture is left behind", left === 0 && (await db.role.count({ where: { key: ROLE } })) === 0 && (await db.company.count({ where: { name: { contains: "ZZ Export " } } })) === 0);
  await db.$disconnect();

  console.log(failures === 0 ? `\nAll ${passes} export masking checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
