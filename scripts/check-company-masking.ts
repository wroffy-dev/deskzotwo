/**
 * check:company-masking — field masking for companies (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.1 and
 * H.4.2; src/lib/companies/masking.ts). A company's addresses, GSTINs, PAN, website and custom fields follow the
 * "companies" field policies wherever the company is read; its name never is masked.
 *
 *   1. Nothing set: companies exactly as before — and the search finds a company by its custom field.
 *   2. Masked, on every read path — the company page (`getCompany`), the lists, the create form's matches, global
 *      search, API v1 (list and one), the app (list and one), the copilot, the parties export and the account
 *      workbook, the list's custom columns: each masked, and none carrying a raw value. A search doesn't match on a
 *      masked custom field.
 *   3. "City only" leaves the city; a restricted address is the word "Restricted".
 *   4. Saving keeps the real values: the company's form, a location's form (blank or masked parts), the custom fields,
 *      the PAN (refused), and the export read back in — masked cells "leave alone".
 *   5. The master switch off: everything in the clear.
 *   6. The editors: companies' fields listed (not the name), and unmasking saved as sent — the companies' "Show" (wave B)
 *      reveals a company, so the editors offer the switch again.
 *   7. A lead's page (wave B, audit H.4.1): its company's website and address follow the companies policy as well as the
 *      lead's own rule — masked if either masks them, "City only" and restricted as the company's page has them — and
 *      the page, the note quoting the address included, carries no raw value.
 *   8. A company revealed today (wave B): its page, list row, custom card and leads' pages in the clear for what the
 *      reveal covered, the GSTIN and PAN still masked, `masked` unchanged for the forms; another company, and the
 *      copilot's list answers, still masked. A usage row stands for the reveal: the reveal itself, and its append-only
 *      log, are check:unmask's, on a scratch database.
 *
 * Creates three ZZ companies, a ZZ lead with a note, personal policies on one sales person and one finance person, and a
 * usage row; removes them, their locations, the audit lines and the permission history rows after. The master switch is
 * flipped in this process only.
 *
 *   npm run check:company-masking
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

type Actor = { id: string; role: string; name: string; email: string };
let actor: Actor | null = null;
// Field masking's master switch, as this process reads it — flipped here without touching the workspace's own setting,
// which other checks running at the same time read.
let maskingOn = true;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/lib/modules-access" || request.endsWith("lib/modules-access")) {
    const real = realLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, requireModuleUser: async () => actor };
  }
  if (request === "@/lib/authz/masking-switch" || request.endsWith("lib/authz/masking-switch")) {
    const real = realLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, fieldMaskingEnabled: async () => maskingOn };
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

const TAG = `ZZ Company Masking ${Date.now().toString(36)}`;
const RAW = {
  website: "https://zz-masking-check.example",
  site: "zz-masking-check.example",
  pan: "AAZPM4321K",
  gstin: "27AAZPM4321K1Z5",
  branchGstin: "29AAZPM4321K1Z1",
  address: "42 Zircon Lane",
  branchAddress: "7 Quartz Road",
  city: "Zedabad",
  branchCity: "Quartzville",
  state: "Maharashtra",
  pincode: "411099",
  branchPincode: "560099",
  audit: "2019-03-17",
};
const MASK = { view: true, maskInList: true, maskInDetail: true, unmask: false };
const AUDIT_FIELD = "last_security_audit";
// Its own marker: check:contact-masking clears "zz check" rows off whichever sales person it picks, which may be ours.
const REASON = "zz company masking check";

async function main() {
  const { getCompany, listCompaniesPaged, listCompanies, findCompanyMatches, updateCompany, updateCompanyCustomFields, setPayoutDetails } = await import("../src/actions/company");
  const { updateCompanyLocation } = await import("../src/actions/company-location");
  const { searchRecords } = await import("../src/actions/search");
  const { listCompaniesApi, getCompanyApi } = await import("../src/lib/api/v1/companies");
  const { appCompanies, appCompany } = await import("../src/lib/app/sales");
  const tools = await import("../src/lib/copilot/tools");
  const { companiesExporter } = await import("../src/lib/portability/exporters/crm");
  const { accountBundle } = await import("../src/lib/portability/export");
  const { plan, apply } = await import("../src/lib/portability/import");
  const { listColumns, unsearchableByPolicy, fieldsFor, displayFields, valuesFor } = await import("../src/lib/custom-fields/server");
  const { companyMasker, pendingCompanyReveal } = await import("../src/lib/companies/masking");
  const { getLead } = await import("../src/actions/lead");
  const { businessDate } = await import("../src/lib/authz/unmask");
  const { roleFieldAccess, personFieldAccess, setPersonFieldAccess } = await import("../src/actions/field-access");
  const { sensitiveFieldsOf } = await import("../src/lib/authz/fields");
  const { canSeeCompany } = await import("../src/lib/authz/company-scope");
  const { can } = await import("../src/lib/authz/resolve");
  const { formatCompanyId } = await import("../src/lib/order-id");
  const { formatCalendarDay } = await import("../src/lib/time/zone");

  const auditDef = await db.customFieldDefinition.findFirst({ where: { entity: "COMPANY", key: AUDIT_FIELD, archivedAt: null, restricted: false, type: "DATE" }, select: { key: true, label: true } });
  if (!auditDef) throw new Error(`The COMPANY custom field "${AUDIT_FIELD}" (a date) isn't in this workspace.`);
  const RAWS = [RAW.site, RAW.pan, RAW.gstin, RAW.branchGstin, RAW.address, RAW.branchAddress, RAW.city, RAW.branchCity, RAW.pincode, RAW.branchPincode, RAW.audit, formatCalendarDay(RAW.audit)];
  /** The raw values found in a response — none is the answer wanted wherever they are masked. */
  const leaks = (value: unknown) => {
    const text = JSON.stringify(value);
    return RAWS.filter((r) => text.includes(r));
  };

  // A sales person (from the end of the list: the other checks start from its top), a finance person who may change a
  // PAN, and a super admin for the editors.
  const sellers = await db.user.findMany({ where: { role: "SALES", active: true, isSuperAdmin: false }, select: { id: true, role: true, name: true, email: true }, orderBy: { name: "desc" }, take: 10 });
  const superAdmin = await db.user.findFirst({ where: { isSuperAdmin: true, active: true }, select: { id: true, role: true, name: true, email: true } });
  if (!sellers.length || !superAdmin) throw new Error("Need an active sales person and a super admin.");
  const seller = sellers[0]!;
  const startedAt = new Date();
  const made: string[] = [];
  const madeLeads: string[] = [];
  const revealedHere: string[] = [];

  const company = await db.company.create({
    data: {
      name: `${TAG} Pvt Ltd`,
      normalizedName: `${TAG} pvt ltd`.toLowerCase(),
      createdById: seller.id,
      ownerUserId: seller.id,
      website: RAW.website,
      panNumber: RAW.pan,
      customFields: { [AUDIT_FIELD]: RAW.audit },
      locations: {
        create: [
          { label: "Head Office", address: RAW.address, city: RAW.city, state: RAW.state, country: "India", pincode: RAW.pincode, gstNumber: RAW.gstin, gstTreatment: "REGISTERED_REGULAR", isPrimary: true, isBilling: true, isShipping: true },
          { label: "Branch", address: RAW.branchAddress, city: RAW.branchCity, state: "Karnataka", country: "India", pincode: RAW.branchPincode, gstNumber: RAW.branchGstin, gstTreatment: "REGISTERED_REGULAR" },
        ],
      },
    },
    select: { id: true, name: true, companySeq: true, ownerUserId: true, relationshipType: true, locations: { select: { id: true, isPrimary: true } } },
  });
  made.push(company.id);
  const head = company.locations.find((l) => l.isPrimary)!;
  // A vendor of the same kind, for the PAN: only a company we pay has one to change, and only finance changes it.
  const vendor = await db.company.create({
    data: { name: `${TAG} Supplies`, normalizedName: `${TAG} supplies`.toLowerCase(), createdById: seller.id, ownerUserId: seller.id, relationshipType: "VENDOR", vendorStatus: "ONBOARDING", panNumber: RAW.pan },
    select: { id: true, ownerUserId: true, relationshipType: true },
  });
  made.push(vendor.id);
  let finance: Actor | null = null;
  for (const u of await db.user.findMany({ where: { active: true, isSuperAdmin: false, role: { not: "SALES" } }, select: { id: true, role: true, name: true, email: true }, take: 60 })) {
    if ((await can(u.id, "payments.manage")) && (await canSeeCompany(u.id, vendor))) {
      finance = u;
      break;
    }
  }

  const personal = (userId: string, field: string, policy: typeof MASK, format: string) =>
    db.userFieldPolicy.upsert({
      where: { user_entity_field: { userId, entity: "companies", field } },
      create: { userId, entity: "companies", field, ...policy, format, reason: REASON },
      update: { ...policy, format, reason: REASON },
    });
  const rowOf = async () => (await listCompaniesPaged({ page: 1, pageSize: 50, search: TAG })).rows.find((r) => r.id === company.id);
  const callFor = (path: string, ref?: string) => ({ actor: { userId: seller.id }, url: new URL(`https://deskzo.test${path}`), params: { ref: ref ?? "" } }) as never;
  const ref = formatCompanyId(company.companySeq);

  try {
    actor = seller;
    if (!(await canSeeCompany(seller.id, company))) throw new Error(`${seller.name} can't open their own ZZ company.`);

    section("1. Nothing set");
    const plain = (await getCompany(company.id))!;
    ok("the company page: its website, PAN, address and GSTIN as they are", plain.website === RAW.website && plain.panNumber === RAW.pan && plain.locations[0]?.address === RAW.address && plain.locations[0]?.gstNumber === RAW.gstin, { website: plain.website });
    ok("  and nothing said to be masked", Object.values(plain.masked ?? {}).every((v) => v === false), plain.masked);
    const plainRow = await rowOf();
    ok("the Companies list: its head office's city and GSTIN as they are", plainRow?.locations?.[0]?.city === RAW.city && plainRow.locations[0]?.gstNumber === RAW.gstin);
    const foundByAudit = await listCompaniesPaged({ page: 1, pageSize: 50, search: RAW.audit });
    ok("a search finds the company by its custom field (so the masked search below means something)", foundByAudit.rows.some((r) => r.id === company.id), foundByAudit.total);

    section("2. Masked, wherever the company is read");
    await personal(seller.id, "address", MASK, "stars");
    await personal(seller.id, "gstin", MASK, "first");
    await personal(seller.id, "pan", MASK, "first");
    await personal(seller.id, "website", MASK, "first");
    await personal(seller.id, `custom:${AUDIT_FIELD}`, MASK, "stars");

    const page = (await getCompany(company.id))!;
    const headOut = page.locations.find((l) => l.isPrimary)!;
    ok("the company page: website, PAN and GSTIN masked", page.website === "h********" && page.panNumber === "A********" && headOut.gstNumber === "2********", { website: page.website, pan: page.panNumber, gstin: headOut.gstNumber });
    ok("  every address part masked — street, city, state, PIN; the country as it is", [headOut.address, headOut.city, headOut.state, headOut.pincode].every((p) => p === "********") && headOut.country === "India", headOut);
    ok("  the name as it is — never masked", page.name === company.name);
    ok("  and it says which, so the forms leave them alone", page.masked?.address && page.masked.gstin && page.masked.pan && page.masked.website, page.masked);
    ok("  the company page carries none of the raw values", leaks(page).length === 0, leaks(page));

    const row = await rowOf();
    ok("the Companies list: the head office's city, state and GSTIN masked, and the row's website and PAN", row?.locations?.[0]?.city === "********" && row.locations[0]?.state === "********" && row.locations[0]?.gstNumber === "2********" && row.website === "h********" && row.panNumber === "A********", row && { place: row.locations?.[0], website: row.website });
    ok("  the list rows carry none of the raw values", !!row && leaks(row).length === 0, row && leaks(row));
    const listed = (await listCompanies({ search: TAG })).find((r) => r.id === company.id);
    ok("the unpaged list too", !!listed && leaks(listed).length === 0 && listed.masked?.gstin === true, listed && leaks(listed));
    const columns = await listColumns("COMPANY", seller.id, [company.id]);
    ok("the list's custom column masked", columns.texts[company.id]?.[AUDIT_FIELD] === "********" && leaks(columns).length === 0, columns.texts[company.id]);
    const matches = await findCompanyMatches(TAG);
    const match = matches.matches.find((m) => m.id === company.id) ?? (matches.duplicate && "match" in matches.duplicate ? matches.duplicate.match : undefined);
    ok("the create form's matches (and the copilot's company search): the city masked", match?.city === "********" && leaks(matches).length === 0, match);

    const searched = await listCompaniesPaged({ page: 1, pageSize: 50, search: RAW.audit });
    ok("a search doesn't match on a masked custom field", !searched.rows.some((r) => r.id === company.id), searched.total);
    ok("  as the field access says it can't be searched", (await unsearchableByPolicy("COMPANY", seller.id)).has(AUDIT_FIELD));
    const global = await searchRecords("companies", RAW.audit);
    ok("global search doesn't find it by the masked value either", global.ok && !global.hits.some((h) => h.id === company.id), global.ok ? global.hits.length : global.error);
    const byName = await searchRecords("companies", TAG);
    ok("  but by its name it does, and the hit carries no raw value", byName.ok && byName.hits.some((h) => h.id === company.id) && leaks(byName).length === 0, byName.ok ? byName.hits.length : byName.error);

    const apiList = (await listCompaniesApi(callFor(`/api/v1/companies?search=${encodeURIComponent(TAG)}`))) as { data: { id: string; website: string | null; address: { line: string | null; city: string | null; gstin: string | null } | null; custom_fields: Record<string, unknown> }[] };
    const apiRow = apiList.data.find((c) => c.id === company.id);
    ok("API v1, the list: website and address masked, the masked custom field left out", apiRow?.website === "h********" && apiRow.address?.line === "********" && apiRow.address.city === "********" && apiRow.address.gstin === "2********" && !(AUDIT_FIELD in apiRow.custom_fields), apiRow);
    ok("  and none of the raw values", leaks(apiList).length === 0, leaks(apiList));
    const apiOne = (await getCompanyApi(callFor(`/api/v1/companies/${ref}`, ref))) as { data: { address: { line: string | null } | null } };
    ok("API v1, one company: masked as its page is, and none of the raw values", apiOne.data.address?.line === "********" && leaks(apiOne).length === 0, leaks(apiOne));
    const appList = (await appCompanies(callFor(`/api/app/companies?search=${encodeURIComponent(TAG)}&view=all`))) as { data: { id: string }[] };
    ok("the app, its companies: none of the raw values", appList.data.some((c) => c.id === company.id) && leaks(appList).length === 0, leaks(appList));
    const appOne = (await appCompany(callFor(`/api/app/companies/${ref}`, ref))) as { data: { address: { line: string | null } | null } };
    ok("the app, one company: masked, and none of the raw values", appOne.data.address?.line === "********" && leaks(appOne).length === 0, leaks(appOne));

    const offered = await tools.toolsFor();
    const copilot = await tools.runTool(offered, { userId: seller.id, conversationId: "" }, "get_company", { ref });
    ok("the copilot's company: website and address masked, none of the raw values sent to the model", !copilot.isError && JSON.stringify(copilot.output).includes("h********") && leaks(copilot.output).length === 0, leaks(copilot.output));
    // The copilot reads a list's answer: a field masked in lists only is masked for the model, though the page shows it.
    await personal(seller.id, "website", { ...MASK, maskInDetail: false }, "first");
    const pageClear = (await getCompany(company.id))!;
    const copilotListed = await tools.runTool(offered, { userId: seller.id, conversationId: "" }, "get_company", { ref });
    ok("  masked in lists only: the page shows the website, the copilot doesn't", pageClear.website === RAW.website && !JSON.stringify(copilotListed.output).includes(RAW.site), (copilotListed.output as { website?: string }).website);
    await personal(seller.id, "website", MASK, "first");

    const exported = (await companiesExporter({ userId: seller.id } as never)) as Record<string, unknown>[];
    const mine = exported.filter((r) => String(r.Name) === company.name);
    ok("the parties export: its rows masked — the company's and its branch's", mine.length === 2 && mine[0]!.Website === "h********" && mine[0]!.PAN === "A********" && mine[0]!.City === "********" && mine[1]!.GSTIN === "2********", mine.map((r) => [r.City, r.GSTIN]));
    ok("  and none of the raw values", leaks(mine).length === 0, leaks(mine));
    const bundle = await accountBundle(seller.id, company.id);
    const sheets = bundle?.sheets.filter((s) => s.name === "Account" || s.name === "Locations") ?? [];
    ok("the account workbook's Account and Locations sheets: masked, none of the raw values", sheets.length === 2 && leaks(sheets).length === 0 && JSON.stringify(sheets).includes("2********"), leaks(sheets));

    // The page's custom card and its Edit dialog, as src/components/companies/company-detail.tsx builds them.
    const detail = await companyMasker(seller.id, "detail");
    const card = await displayFields("COMPANY", seller.id, await valuesFor("COMPANY", company.id), { present: detail.customText });
    ok("the page's custom card: the field masked", JSON.stringify(card).includes("********") && leaks(card).length === 0, leaks(card));
    ok("  and not offered for editing (`hidden`)", detail.hidden.includes(`custom:${AUDIT_FIELD}`), detail.hidden);

    section("3. City only, and restricted");
    await personal(seller.id, "address", MASK, "partial_address");
    const cityOnly = (await getCompany(company.id))!.locations.find((l) => l.isPrimary)!;
    ok("City only: the city as it is, the street, state and PIN masked", cityOnly.city === RAW.city && cityOnly.address === "********" && cityOnly.state === "********" && cityOnly.pincode === "********", cityOnly);
    await personal(seller.id, "address", { view: false, maskInList: false, maskInDetail: false, unmask: false }, "stars");
    const restricted = (await getCompany(company.id))!;
    const restrictedHead = restricted.locations.find((l) => l.isPrimary)!;
    ok("restricted: the word, not a mask — and no raw value", restrictedHead.address === "Restricted" && restrictedHead.city === "Restricted" && leaks(restricted).length === 0, restrictedHead);
    await personal(seller.id, "address", MASK, "stars");

    section("4. Saving keeps the real values");
    const before = await db.company.findUniqueOrThrow({ where: { id: company.id }, select: { website: true, panNumber: true, customFields: true } });
    const saved = await updateCompany({ id: company.id, name: company.name, relationshipType: "CLIENT", website: "h********", linkedinUrl: "", industryId: "", customerCategoryId: "", companyType: "", employeeBand: "", paymentTerms: "ADVANCE", dunsNumber: "", tags: "", source: "OTHER" });
    const afterSave = await db.company.findUniqueOrThrow({ where: { id: company.id }, select: { website: true } });
    ok("the company's form, sent back with the masked website: the real one kept", saved.ok && afterSave.website === RAW.website, saved.ok ? afterSave.website : saved.error);
    await updateCompany({ id: company.id, name: company.name, relationshipType: "CLIENT", website: "https://somewhere-else.example", linkedinUrl: "", industryId: "", customerCategoryId: "", companyType: "", employeeBand: "", paymentTerms: "ADVANCE", dunsNumber: "", tags: "", source: "OTHER" });
    ok("  nor one typed over it", (await db.company.findUniqueOrThrow({ where: { id: company.id }, select: { website: true } })).website === RAW.website);

    const asForm = await updateCompanyLocation({ id: head.id, label: "Head Office (ZZ)", address: "", city: "", state: "", country: "India", pincode: "", gstNumber: "", gstTreatment: "REGISTERED_REGULAR", isBilling: true, isShipping: true });
    const headAfter = await db.companyLocation.findUniqueOrThrow({ where: { id: head.id } });
    ok("a location's form with its masked parts left out: the label saved, the address and GSTIN kept", asForm.ok && headAfter.label === "Head Office (ZZ)" && headAfter.address === RAW.address && headAfter.city === RAW.city && headAfter.state === RAW.state && headAfter.pincode === RAW.pincode && headAfter.gstNumber === RAW.gstin, asForm.ok ? headAfter : asForm.error);
    const asMasked = await updateCompanyLocation({ id: head.id, label: "Head Office", address: "********", city: "********", state: "********", country: "India", pincode: "********", gstNumber: "2********", gstTreatment: "REGISTERED_REGULAR", isBilling: true, isShipping: true });
    const headAgain = await db.companyLocation.findUniqueOrThrow({ where: { id: head.id } });
    ok("  sent back masked: saved — the PIN's check isn't failed by stars — and nothing written over", asMasked.ok && headAgain.address === RAW.address && headAgain.pincode === RAW.pincode && headAgain.gstNumber === RAW.gstin, asMasked.ok ? headAgain : asMasked.error);

    const custom = await updateCompanyCustomFields(company.id, { [AUDIT_FIELD]: "2020-01-01" });
    const customAfter = (await db.company.findUniqueOrThrow({ where: { id: company.id }, select: { customFields: true } })).customFields as Record<string, unknown>;
    ok("the custom fields' save: a masked one keeps what it holds", custom.ok && customAfter[AUDIT_FIELD] === RAW.audit, custom.ok ? customAfter : custom.error);

    if (finance) {
      await personal(finance.id, "pan", MASK, "first");
      actor = finance;
      const pan = await setPayoutDetails(vendor.id, { panNumber: "BBBBB1111B" });
      actor = seller;
      const panAfter = await db.company.findUniqueOrThrow({ where: { id: vendor.id }, select: { panNumber: true } });
      ok("a PAN masked for finance can't be changed by them", !pan.ok && /masked/.test(pan.error) && panAfter.panNumber === RAW.pan, pan.ok ? panAfter : pan.error);
    } else ok("somebody with “Manage finance records” who can open the ZZ vendor", false, "none found");

    const file = mine.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "")])));
    const read = await plan("companies", file, seller.id);
    const touched = read.rows.flatMap((r) => r.changes.map((c) => c.field));
    const MASKED_COLUMNS = ["Website", "PAN", "GSTIN", "Address", "City", "State", "PIN", auditDef.label];
    ok("the export read back in: no row refused (a masked PAN isn't “not a PAN”), no masked cell changes anything", read.errors === 0 && !touched.some((f) => MASKED_COLUMNS.includes(f)), { errors: read.rows.filter((r) => r.error).map((r) => r.error), touched });
    ok("  the preview says the masked cells were left as they are", read.notices.some((n) => /masked for you/.test(n.text)), read.notices.map((n) => n.text));
    ok("  and shows none of the raw values", leaks(read).length === 0, leaks(read));
    const applied = await apply("companies", file, seller.id);
    const stored = await db.company.findUniqueOrThrow({ where: { id: company.id }, select: { website: true, panNumber: true, customFields: true, locations: { orderBy: { createdAt: "asc" }, select: { address: true, city: true, state: true, pincode: true, gstNumber: true } } } });
    ok(
      "  applied: the website, PAN, every address and GSTIN, and the custom field as they were",
      applied.failed.length === 0 &&
        stored.website === RAW.website &&
        stored.panNumber === RAW.pan &&
        stored.locations.length === 2 &&
        stored.locations[0]!.address === RAW.address &&
        stored.locations[0]!.gstNumber === RAW.gstin &&
        stored.locations[1]!.address === RAW.branchAddress &&
        stored.locations[1]!.gstNumber === RAW.branchGstin &&
        (stored.customFields as Record<string, unknown>)[AUDIT_FIELD] === RAW.audit,
      applied.failed.length ? applied.failed : stored,
    );
    ok("  (and the form saves left the rest as it was)", JSON.stringify(before.customFields) === JSON.stringify(stored.customFields) && before.panNumber === stored.panNumber);

    section("5. The master switch");
    maskingOn = false;
    const off = (await getCompany(company.id))!;
    const offRow = await rowOf();
    ok("off: the page and the list in the clear, nothing said to be masked", off.website === RAW.website && off.locations.find((l) => l.isPrimary)?.gstNumber === RAW.gstin && offRow?.locations?.[0]?.city === RAW.city && !off.masked?.address, off.masked);
    maskingOn = true;
    ok("  on again: masked again", (await getCompany(company.id))!.website === "h********");

    section("6. The editors");
    const fields = await sensitiveFieldsOf("companies");
    const keys = fields.map((f) => f.key);
    ok("companies' fields: address, GSTIN, PAN, website and the Companies set's custom fields — not the name", ["address", "gstin", "pan", "website", `custom:${AUDIT_FIELD}`].every((k) => keys.includes(k)) && !keys.includes("name") && !keys.includes("companyName"), keys);
    actor = superAdmin;
    const roleRows = await roleFieldAccess(seller.role, "companies");
    ok("a role's Field Permissions read companies' fields", !!roleRows && roleRows.rows.some((r) => r.key === "gstin"), roleRows?.rows.map((r) => r.key));
    const granted = await setPersonFieldAccess(seller.id, [{ field: "website", policy: { view: true, maskInList: true, maskInDetail: true, unmask: true, format: "first", export: null } }], { reason: REASON }, "companies");
    const storedRule = await db.userFieldPolicy.findUnique({ where: { user_entity_field: { userId: seller.id, entity: "companies", field: "website" } } });
    ok("unmasking a company field is saved as sent — the companies' Show reveals it (wave B)", granted.ok && storedRule?.maskInList === true && storedRule.unmask === true, granted.ok ? storedRule : granted.error);
    const person = await personFieldAccess(seller.id, "companies");
    ok("  their Field Permissions panel reads it so", person?.rows.find((r) => r.key === "website")?.effective.unmask === true);
    ok("fieldsFor still offers the masked field (it's masked, not restricted)", (await fieldsFor("COMPANY", seller.id)).visible.some((d) => d.key === AUDIT_FIELD));
    actor = seller;

    // ── 7 and 8 (owner, 5 Nov 2026 — Phase 3 masking fixes, wave B) ──
    section("7. A lead's page: its company's website and address follow the companies policy too");
    await db.userFieldPolicy.deleteMany({ where: { userId: seller.id, entity: "companies", reason: REASON } });
    // The lead's own "address" rule open, whatever the seller's role says — so what masks below is the companies policy.
    const leadAddress = (policy: typeof MASK, format: string) =>
      db.userFieldPolicy.upsert({
        where: { user_entity_field: { userId: seller.id, entity: "leads", field: "address" } },
        create: { userId: seller.id, entity: "leads", field: "address", ...policy, format, reason: REASON },
        update: { ...policy, format, reason: REASON },
      });
    const OPEN = { view: true, maskInList: false, maskInDetail: false, unmask: false };
    await leadAddress(OPEN, "stars");
    const deal = await db.lead.create({ data: { companyId: company.id, title: `${TAG} deal`, ownerUserId: seller.id }, select: { id: true } });
    madeLeads.push(deal.id);
    // A note that quotes the address, as people write them.
    await db.activity.create({ data: { leadId: deal.id, userId: seller.id, type: "NOTE", notes: `Met them at ${RAW.address} about the renewal` } });
    const clearDeal = (await getLead(deal.id))!;
    ok("nothing set for companies: the lead's page shows its company's website and address as they are", clearDeal.company.website === RAW.website && clearDeal.address.line?.startsWith(RAW.address) === true && clearDeal.address.place === `${RAW.city}, ${RAW.state}, India`, { website: clearDeal.company.website, address: clearDeal.address });
    await personal(seller.id, "address", MASK, "stars");
    await personal(seller.id, "website", MASK, "first");
    const maskedDeal = (await getLead(deal.id))!;
    ok("the companies policy masks them: the website and both address lines masked, though the lead's own rule shows the address", maskedDeal.company.website === "h********" && maskedDeal.address.line === "********, India" && maskedDeal.address.place === "********, India", { website: maskedDeal.company.website, address: maskedDeal.address });
    ok("  the lead's page carries none of the raw values — the note quoting the address included", leaks(maskedDeal).length === 0 && JSON.stringify(maskedDeal.activities).includes("Met them at ********"), leaks(maskedDeal));
    ok("  the company's name as the lead's own rule says — not a companies field", maskedDeal.company.name === company.name);
    await personal(seller.id, "address", MASK, "partial_address");
    const cityDeal = (await getLead(deal.id))!;
    ok("City only for companies: the city in the clear on the lead's page, the street, state and PIN masked", cityDeal.address.place === `${RAW.city}, ********, India` && cityDeal.address.line === `********, ${RAW.city}, ********, India` && !JSON.stringify(cityDeal).includes(RAW.address) && !JSON.stringify(cityDeal).includes(RAW.pincode), cityDeal.address);
    await personal(seller.id, "address", { view: false, maskInList: false, maskInDetail: false, unmask: false }, "stars");
    const restrictedDeal = (await getLead(deal.id))!;
    ok("restricted for companies: the word on the lead's page, and no raw value", restrictedDeal.address.line === "Restricted" && restrictedDeal.address.place === "Restricted" && leaks(restrictedDeal).length === 0, restrictedDeal.address);
    // Either policy: the lead's own rule masks it while the companies policy doesn't — as before — and both together.
    await db.userFieldPolicy.deleteMany({ where: { userId: seller.id, entity: "companies", field: "address", reason: REASON } });
    await leadAddress(MASK, "stars");
    const leadOnly = (await getLead(deal.id))!;
    ok("the lead's own rule alone still masks it, as before", leadOnly.address.line === "********" && leadOnly.address.place === "********" && !JSON.stringify(leadOnly).includes(RAW.address), leadOnly.address);
    await personal(seller.id, "address", MASK, "partial_address");
    await leadAddress(MASK, "partial_address");
    const both = (await getLead(deal.id))!;
    ok("both masking it: neither shows more than it allows — no street, city, state or PIN", ![RAW.address, RAW.city, RAW.pincode].some((r) => JSON.stringify(both).includes(r)) && leaks(both).length === 0, both.address);
    await leadAddress(OPEN, "stars");

    section("8. A company revealed today");
    // What "Show" reveals: the address, website and custom field, masked in lists and on its page and theirs to unmask;
    // the GSTIN and PAN masked and not. The reveal itself — the action, the unit, the append-only log — is check:unmask's
    // (on a scratch database); here a usage row stands for it, so this database's log gets no rows.
    await personal(seller.id, "address", { ...MASK, unmask: true }, "stars");
    await personal(seller.id, "website", { ...MASK, unmask: true }, "first");
    await personal(seller.id, `custom:${AUDIT_FIELD}`, { ...MASK, unmask: true }, "stars");
    await personal(seller.id, "gstin", MASK, "first");
    await personal(seller.id, "pan", MASK, "first");
    const other = await db.company.create({
      data: { name: `${TAG} Other`, normalizedName: `${TAG} other`.toLowerCase(), createdById: seller.id, ownerUserId: seller.id, website: "https://zz-other-masking.example", locations: { create: [{ label: "HQ", address: "9 Onyx Row", city: "Onyxpur", country: "India", isPrimary: true }] } },
      select: { id: true },
    });
    made.push(other.id);
    ok("its page offers Show for the address, website and custom field — not the GSTIN or PAN", (await pendingCompanyReveal(seller.id, company.id)).sort().join() === ["address", `custom:${AUDIT_FIELD}`, "website"].sort().join(), await pendingCompanyReveal(seller.id, company.id));
    const day = await businessDate();
    await db.unmaskUsage.create({ data: { userId: seller.id, businessDate: day, entity: "companies", recordId: company.id, leadId: `company:${company.id}`, fields: ["address", "website", `custom:${AUDIT_FIELD}`] } });
    revealedHere.push(company.id);
    const shownPage = (await getCompany(company.id))!;
    const shownHead = shownPage.locations.find((l) => l.isPrimary)!;
    ok("revealed: its page reads the website and every address part in the clear", shownPage.website === RAW.website && shownHead.address === RAW.address && shownHead.city === RAW.city && shownHead.pincode === RAW.pincode, { website: shownPage.website, head: shownHead });
    ok("  the GSTIN and PAN still masked — not theirs to unmask — nor their raw values anywhere on it", shownHead.gstNumber === "2********" && shownPage.panNumber === "A********" && ![RAW.gstin, RAW.branchGstin, RAW.pan].some((r) => JSON.stringify(shownPage).includes(r)), { gstin: shownHead.gstNumber, pan: shownPage.panNumber });
    ok("  a reveal is for reading: `masked` still says what the forms leave alone (their saves keep what's stored)", shownPage.masked.address && shownPage.masked.website && shownPage.masked.gstin, shownPage.masked);
    const shownRow = await rowOf();
    ok("  its list row too", shownRow?.website === RAW.website && shownRow.locations?.[0]?.city === RAW.city && shownRow.locations[0]?.gstNumber === "2********", shownRow && { website: shownRow.website, place: shownRow.locations?.[0] });
    const shownDetail = await companyMasker(seller.id, "detail", [company.id]);
    const shownCard = await displayFields("COMPANY", seller.id, await valuesFor("COMPANY", company.id), { present: shownDetail.forCompany(company.id).customText });
    ok("  its page's custom card", JSON.stringify(shownCard).includes(formatCalendarDay(RAW.audit)), shownCard);
    const shownDeal = (await getLead(deal.id))!;
    ok("  and its lead's page — the website and address", shownDeal.company.website === RAW.website && shownDeal.address.line?.startsWith(RAW.address) === true, { website: shownDeal.company.website, address: shownDeal.address });
    ok("  and its page offers no Show now", (await pendingCompanyReveal(seller.id, company.id)).length === 0);
    const otherPage = (await getCompany(other.id))!;
    ok("another company stays masked, none of its values", otherPage.website === "h********" && !JSON.stringify(otherPage).includes("zz-other-masking") && !JSON.stringify(otherPage).includes("9 Onyx Row") && !JSON.stringify(otherPage).includes("Onyxpur"), { website: otherPage.website });
    const copilotShown = await tools.runTool(offered, { userId: seller.id, conversationId: "" }, "get_company", { ref });
    ok("the copilot keeps the list answers: still masked, none of the raw values", !copilotShown.isError && !JSON.stringify(copilotShown.output).includes(RAW.site) && leaks(copilotShown.output).length === 0, leaks(copilotShown.output));
    await db.unmaskUsage.deleteMany({ where: { userId: seller.id, entity: "companies", recordId: company.id } });
    ok("a reveal from another day doesn't count: its page masked again", (await getCompany(company.id))!.website === "h********");
  } finally {
    actor = null;
    maskingOn = true;
    const people = [seller.id, ...(finance ? [finance.id] : [])];
    await db.unmaskUsage.deleteMany({ where: { userId: seller.id, entity: "companies", recordId: { in: revealedHere } } });
    await db.activity.deleteMany({ where: { leadId: { in: madeLeads } } });
    await db.lead.deleteMany({ where: { id: { in: madeLeads } } });
    await db.userFieldPolicy.deleteMany({ where: { userId: seller.id, entity: "leads", reason: REASON } });
    await db.userFieldPolicy.deleteMany({ where: { userId: { in: people }, entity: "companies", reason: REASON } });
    await db.permissionChange.deleteMany({ where: { subjectUserId: seller.id, permission: { startsWith: "field:companies:" }, createdAt: { gte: startedAt } } });
    await db.auditLog.deleteMany({ where: { entityId: { in: made }, createdAt: { gte: startedAt } } });
    await db.companyLocation.deleteMany({ where: { companyId: { in: made } } });
    await db.company.deleteMany({ where: { id: { in: made } } });
  }

  console.log(failures === 0 ? `\nAll ${passes} company masking checks passed.\n` : `\n${failures} check(s) failed.\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
