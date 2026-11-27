/**
 * check:masking-actions — field masking on the action screens wave A left as known gaps (owner, 5 Nov 2026 — Phase 3
 * masking fixes, wave B; DESKZO_PERMISSION_SYSTEM_AUDIT.md H.4.3; scripts/check-masking-guard.ts KNOWN_GAPS under
 * src/actions/). One person sees a ZZ customer's contacts (name, email, phone), the company's address, GSTIN, PAN and
 * website, and a lead's title masked, in a list and on a page; every screen below must show them masked — and none of
 * its responses may carry a raw value — while the actions behind them keep working on the real ones.
 *
 *    1. calling-activity — the cold-calling queue
 *    2. company-merge — the Duplicates list's reasons and places, and the merge screen
 *    3. consignment — a consignment's destination and recipient
 *    4. domain-check — a ticket's domain panel offers no masked domain
 *    5. domain — the Domain & web panel, the module's list, its search, a lookup's own answer
 *    6. email-builder-tools — the test send's contact picker and the test itself
 *    7. email-verification — the Bad emails worklist, and a check's finding
 *    8. feedback — requests, one request, a company's tab, the request form's contacts
 *    9. forms — the invitee search, the invitations list and the Invite dialog
 *   10. it-asset — the register, an asset, what somebody holds, a company's estate, the site picker
 *   11. lead-reminder — the reminder's task title and audit line
 *   12. portal — portal links and portal requests
 *   13. project — a project's stakeholders
 *   14. renewal — who to ring on the Renewals list
 *   15. reseller — a reseller's onboarding
 *   16. support-mail — a ticket's reply-to
 *   17. ticket — a ticket's page
 *   18. verification — the verifications queue and a company's, and a verdict on a masked number
 *   19. visit — a lead's Visits card, a visit's page, the lists, the form's sites; saving keeps the real address
 *   20. workspace — a saved list's rows and its City and State options
 *
 * Makes ZZ companies and their records, personal field policies (and the permissions the screens ask, where missing)
 * on one management person nobody else's check picks, and removes them all after. The master switch is read as on in
 * this process only, never written.
 *
 *   npm run check:masking-actions            (`-- --only=visit,ticket` runs those sections)
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

// Links in what the forms send are the workspace's own: resolved without a request, as the other checks do.
process.env.DESKZO_TENANCY_FALLBACK = "legacy";

type Actor = { id: string; role: string; name: string; email: string };
let actor: Actor | null = null;
const mailed: { to: string; subject: string; html: string; text?: string }[] = [];
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/lib/modules-access" || request.endsWith("lib/modules-access")) {
    const real = realLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, requireModuleUser: async () => actor, requireModuleAccess: async () => actor, isModuleEntitled: async () => true };
  }
  if (request === "@/actions/module" || request.endsWith("actions/module")) {
    const real = realLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, isModuleEnabled: async () => true };
  }
  if (request === "@/lib/authz/masking-switch" || request.endsWith("lib/authz/masking-switch")) {
    const real = realLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, fieldMaskingEnabled: async () => true };
  }
  // Never a real email: the test send is kept here instead.
  if (request === "@/lib/marketing/pipeline" || request.endsWith("lib/marketing/pipeline")) {
    const real = realLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, deliverNow: async (m: { to: string; subject: string; html: string; text?: string }) => (mailed.push(m), { ok: true, provider: "zz", fromEmail: "zz@zz.invalid" }) };
  }
  return realLoad.call(this, request, parent, isMain);
} as typeof realLoad;

const db = directClient();
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)?.slice(0, 400)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const only = (process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length) ?? "").split(",").filter(Boolean);
const wanted = (key: string) => only.length === 0 || only.includes(key);
const section = (n: number, key: string) => {
  if (!wanted(key)) return false;
  console.log(`\n— ${n}. ${key} —\n`);
  return true;
};

const REASON = "zz masking actions check";
const SFX = Date.now().toString(36);
const TAG = `ZZ Mact ${SFX}`;
const digits = String(Date.now()).slice(-8);
const PAN = `ZZ${SFX.toUpperCase().slice(-6)}Q`;
const RAW = {
  name: `ZZ Mact Asha ${SFX}`,
  email: `asha.${SFX}@zzmact${SFX}.example`,
  phone: `+91 98${digits}`,
  phoneDigits: `98${digits}`,
  badName: `ZZ Mact Ravi ${SFX}`,
  badEmail: `ravi.${SFX}@mailinator.com`,
  domain: `zzmact${SFX}.example`,
  website: `https://www.zzmact${SFX}.example`,
  pan: PAN,
  gstin: `27${PAN}1Z5`,
  address: `17 Zzmact ${SFX} Lane`,
  city: `Zzmactpur${SFX}`,
  state: `Zzmact${SFX} Pradesh`,
  title: `ZZ Mact Lead ${SFX}`,
  corrected: `+91 97${digits}`,
  resellerPan: `ZY${SFX.toUpperCase().slice(-6)}R`,
  resellerGstin: `29ZY${SFX.toUpperCase().slice(-6)}R1Z2`,
};
const MASK = { view: true, maskInList: true, maskInDetail: true, unmask: false };

/** The raw values any of `values` names, in any case — what a response must not carry. */
const leaks = (value: unknown, values: string[]) => {
  const text = JSON.stringify(value ?? null).toLowerCase();
  return values.filter((v) => v && v.length >= 3 && text.includes(v.toLowerCase()));
};
const masked = (shown: string | null | undefined, raw: string) => !!shown && shown !== raw && shown.includes("*");

async function main() {
  const callingActivity = await import("../src/actions/calling-activity");
  const companyMerge = await import("../src/actions/company-merge");
  const consignment = await import("../src/actions/consignment");
  const domainCheck = await import("../src/actions/domain-check");
  const domain = await import("../src/actions/domain");
  const emailBuilder = await import("../src/actions/email-builder-tools");
  const emailVerification = await import("../src/actions/email-verification");
  const feedback = await import("../src/actions/feedback");
  const forms = await import("../src/actions/forms");
  const itAsset = await import("../src/actions/it-asset");
  const leadReminder = await import("../src/actions/lead-reminder");
  const portal = await import("../src/actions/portal");
  const project = await import("../src/actions/project");
  const renewal = await import("../src/actions/renewal");
  const reseller = await import("../src/actions/reseller");
  const supportMail = await import("../src/actions/support-mail");
  const ticket = await import("../src/actions/ticket");
  const verification = await import("../src/actions/verification");
  const visit = await import("../src/actions/visit");
  const workspace = await import("../src/actions/workspace");
  const { can } = await import("../src/lib/authz/resolve");
  const { contactMasker } = await import("../src/lib/contacts/masking");
  const { companyMasker } = await import("../src/lib/companies/masking");

  // A management person nobody else's check picks: the last, with no field policies of their own.
  const candidates = await db.user.findMany({ where: { role: "MANAGEMENT", active: true, isSuperAdmin: false, kind: "MEMBER" }, select: { id: true, role: true, name: true, email: true }, orderBy: { userSeq: "desc" } });
  let person: Actor | null = null;
  for (const c of candidates) {
    await db.userFieldPolicy.deleteMany({ where: { userId: c.id, reason: REASON } });
    if ((await db.userFieldPolicy.count({ where: { userId: c.id } })) === 0) {
      person = c;
      break;
    }
  }
  if (!person) throw new Error("No management person without field policies to act as.");
  const me = person;
  const startedAt = new Date();
  const made: { companies: string[]; leads: string[]; tickets: string[]; visits: string[]; workbooks: string[]; consignments: string[]; assets: string[]; feedback: string[]; projects: string[]; portalLogins: string[]; orders: string[]; forms: string[]; templates: string[] } = {
    companies: [], leads: [], tickets: [], visits: [], workbooks: [], consignments: [], assets: [], feedback: [], projects: [], portalLogins: [], orders: [], forms: [], templates: [],
  };

  try {
    // ─── The ZZ records ──────────────────────────────────────────────────────────────────────────
    const company = await db.company.create({
      data: {
        name: `${TAG} Pvt Ltd`,
        normalizedName: `${TAG} pvt ltd`.toLowerCase(),
        createdById: me.id,
        ownerUserId: me.id,
        relationshipType: "CLIENT",
        website: RAW.website,
        panNumber: RAW.pan,
        locations: { create: [{ label: "ZZ Head Office", address: RAW.address, city: RAW.city, state: RAW.state, country: "India", pincode: "411777", gstNumber: RAW.gstin, isPrimary: true, isBilling: true, isShipping: true }] },
        contacts: {
          create: [
            { name: RAW.name, email: RAW.email, phone: RAW.phone, isPrimary: true },
            { name: RAW.badName, email: RAW.badEmail, phone: RAW.corrected, emailStatus: "INVALID", emailCheckedValue: RAW.badEmail, emailCheckedAt: new Date(), emailCheckMethod: "AUTOMATIC", emailCheckDetail: "mailinator.com is a throwaway address service. Nobody reads it." },
          ],
        },
      },
      select: { id: true, name: true, locations: { select: { id: true } }, contacts: { select: { id: true, name: true } } },
    });
    made.companies.push(company.id);
    const site = company.locations[0]!.id;
    const asha = company.contacts.find((c) => c.name === RAW.name)!.id;
    const ravi = company.contacts.find((c) => c.name === RAW.badName)!.id;
    // A duplicate of it: the same GSTIN (so PAN), website and a contact's number.
    const twin = await db.company.create({
      data: {
        name: `${TAG} Twin Traders`,
        normalizedName: `${TAG} twin traders`.toLowerCase(),
        createdById: me.id,
        ownerUserId: me.id,
        relationshipType: "CLIENT",
        website: RAW.website,
        locations: { create: [{ label: "ZZ Twin Office", address: RAW.address, city: RAW.city, state: RAW.state, country: "India", gstNumber: RAW.gstin, isPrimary: true }] },
        contacts: { create: [{ name: `ZZ Mact Twin ${SFX}`, email: `twin.${SFX}@zzmact${SFX}.example`, phone: RAW.phone }] },
      },
      select: { id: true },
    });
    made.companies.push(twin.id);
    // One whose website isn't one, for a lookup's refusal.
    const nosite = await db.company.create({
      data: { name: `${TAG} No Site`, normalizedName: `${TAG} no site`.toLowerCase(), createdById: me.id, ownerUserId: me.id, relationshipType: "CLIENT", website: `zzmact${SFX}-not-a-site` },
      select: { id: true },
    });
    made.companies.push(nosite.id);
    const resellerCo = await db.company.create({
      data: {
        name: `${TAG} Partners`,
        normalizedName: `${TAG} partners`.toLowerCase(),
        createdById: me.id,
        ownerUserId: me.id,
        relationshipType: "RESELLER",
        panNumber: RAW.resellerPan,
        locations: { create: [{ label: "ZZ Partner Office", city: RAW.city, country: "India", gstNumber: RAW.resellerGstin, isPrimary: true }] },
        resellerProfile: { create: {} },
      },
      select: { id: true },
    });
    made.companies.push(resellerCo.id);
    const lead = await db.lead.create({ data: { companyId: company.id, contactId: asha, ownerUserId: me.id, title: RAW.title }, select: { id: true } });
    made.leads.push(lead.id);

    // ─── The person: masked everywhere, with what each screen asks ───────────────────────────────
    await db.userFieldPolicy.createMany({
      data: [
        { userId: me.id, entity: "contacts", field: "name", ...MASK, format: "first", reason: REASON },
        { userId: me.id, entity: "contacts", field: "email", ...MASK, format: "email", reason: REASON },
        { userId: me.id, entity: "contacts", field: "phone", ...MASK, format: "phone_last4", reason: REASON },
        { userId: me.id, entity: "companies", field: "address", ...MASK, format: "stars", reason: REASON },
        { userId: me.id, entity: "companies", field: "gstin", ...MASK, format: "first", reason: REASON },
        { userId: me.id, entity: "companies", field: "pan", ...MASK, format: "first", reason: REASON },
        { userId: me.id, entity: "companies", field: "website", ...MASK, format: "first", reason: REASON },
        { userId: me.id, entity: "leads", field: "title", ...MASK, format: "first", reason: REASON },
      ],
    });
    for (const key of ["contacts.view", "companies.merge", "assets.manage", "assets.viewAll", "tickets.view", "tickets.create", "feedback.request", "feedback.viewAll", "portal.manage", "projects.view", "orders.view", "marketing.manage", "visits.view", "leads.view", "calls.view"]) {
      if (!(await can(me.id, key))) await db.userPermission.create({ data: { userId: me.id, permission: key, allowed: true, reason: REASON } });
    }
    actor = me;

    const people = [RAW.name, RAW.email, RAW.phone, RAW.phoneDigits];
    const places = [RAW.address, RAW.city, RAW.state, RAW.gstin, RAW.pan, RAW.domain, RAW.website];

    // ─── 1 ───────────────────────────────────────────────────────────────────────────────────────
    if (section(1, "calling-activity")) {
      const workbook = await db.workbook.create({ data: { name: `${TAG} calling`, filters: {}, ownerUserId: me.id, mode: "COLD_CALLING" }, select: { id: true } });
      made.workbooks.push(workbook.id);
      await db.workbookRecord.create({ data: { workbookId: workbook.id, companyId: company.id, assignedToUserId: me.id } });
      const queue = await callingActivity.myCallingQueue(workbook.id);
      const record = queue?.records.find((r) => r.company.id === company.id);
      const contact = record?.company.contacts.find((c) => c.id === asha);
      ok("the queue: a contact's email and phone masked, and said to be", !!contact && masked(contact.email, RAW.email) && masked(contact.phone, RAW.phone) && contact.masked.email && contact.masked.phone, contact && { email: contact.email, phone: contact.phone });
      ok("  the account's website and city masked", !!record && masked(record.company.website, RAW.website) && record.company.locations[0]?.city !== RAW.city, record && { website: record.company.website, place: record.company.locations[0] });
      ok("  the queue carries no raw value", !!queue && leaks(queue, [...people, ...places]).length === 0, leaks(queue, [...people, ...places]));
    }

    // ─── 2 ───────────────────────────────────────────────────────────────────────────────────────
    if (section(2, "company-merge")) {
      const found = await companyMerge.listDuplicates();
      const row = found.ok ? found.data.rows.find((r) => r.companies.some((c) => c.id === company.id) && r.companies.some((c) => c.id === twin.id)) : undefined;
      ok("Duplicates: the pair is found, on the real GSTIN, website and number", !!row && row.strength === "strong" && row.reasons.some((r) => r.startsWith("Same GSTIN")), row?.reasons);
      ok("  its reasons and places name no GSTIN, PAN, domain or city in the clear", !!row && leaks(row, places).length === 0, row && { reasons: row.reasons, places: row.companies.map((c) => c.place), leaks: leaks(row, places) });
      ok("  nor the shared number's last four, the number being masked", !!row && !row.reasons.some((r) => r.includes(RAW.phoneDigits.slice(-4))), row?.reasons);
      // The merge screen for the pair (src/lib/companies/merge.ts `planMerge`, asked for this person).
      const screen = await companyMerge.getMergeScreen(company.id, twin.id);
      const shownPerson = screen.ok ? screen.data.plan.keep.contacts.find((c) => c.id === asha) : undefined;
      ok("the merge screen: both companies' people masked", !!shownPerson && masked(shownPerson.email, RAW.email) && masked(shownPerson.phone, RAW.phone), screen.ok ? shownPerson : screen.error);
      ok("  the preview carries no raw value", screen.ok && leaks(screen.data.plan, [...people, ...places]).length === 0, screen.ok ? leaks(screen.data.plan, [...people, ...places]) : screen.error);
    }

    // ─── 3 ───────────────────────────────────────────────────────────────────────────────────────
    let consignmentId = "";
    if (section(3, "consignment") || wanted("it-asset")) {
      consignmentId = (await db.consignment.create({ data: { consignmentNumber: `ZZM/${SFX}`, createdById: me.id, reason: "DEPLOYMENT", toCompanyId: company.id, toLocationId: site, toContactId: asha }, select: { id: true } })).id;
      made.consignments.push(consignmentId);
    }
    if (wanted("consignment")) {
      const listed = (await consignment.listConsignments({ companyId: company.id })).find((c) => c.id === consignmentId);
      ok("consignments: the destination's city and state, and the recipient's name and phone, masked", !!listed && listed.toLocation?.city !== RAW.city && listed.toLocation?.state !== RAW.state && masked(listed.toContact?.phone, RAW.phone) && masked(listed.toContact?.name, RAW.name), listed && { to: listed.toLocation, contact: listed.toContact });
      ok("  the list carries no raw value", !!listed && leaks(listed, [...people, ...places]).length === 0, leaks(listed, [...people, ...places]));
      const one = await consignment.getConsignment(consignmentId);
      ok("  a consignment's page neither", !!one && leaks(one, [...people, ...places]).length === 0 && masked(one.toContact?.phone, RAW.phone), one ? leaks(one, [...people, ...places]) : "not found");
    }

    // ─── 4, 16, 17 ───────────────────────────────────────────────────────────────────────────────
    let ticketId = "";
    if (wanted("domain-check") || wanted("support-mail") || wanted("ticket")) {
      ticketId = (await db.ticket.create({ data: { companyId: company.id, contactId: asha, title: `${TAG} printer down`, description: `They also mentioned zzmact${SFX}-text.com in passing.`, createdByUserId: me.id }, select: { id: true } })).id;
      made.tickets.push(ticketId);
    }
    if (section(4, "domain-check")) {
      const offered = await domainCheck.ticketDomains(ticketId);
      ok("a ticket's domain panel offers no masked domain — not the website's, not the contact's address's", !offered.includes(RAW.domain) && leaks(offered, [RAW.domain]).length === 0, offered);
      ok("  what the ticket itself says is still offered", offered.includes(`zzmact${SFX}-text.com`), offered);
    }

    // ─── 5 ───────────────────────────────────────────────────────────────────────────────────────
    if (section(5, "domain")) {
      await db.domainProfile.create({
        data: { companyId: company.id, domain: RAW.domain, finalUrl: `https://www.${RAW.domain}/`, siteTitle: "ZZ Mact home", screenshotUrl: `https://shots.example/?url=https://${RAW.domain}`, mxHosts: [`mx1.${RAW.domain}`], nsHosts: [`ns1.${RAW.domain}`], dmarcRecord: `v=DMARC1; p=none; rua=mailto:dmarc@${RAW.domain}`, emailProvider: "Self-hosted or other", fetchedAt: new Date() },
      });
      const briefing = await domain.getDomainBriefing(company.id);
      ok("the Domain & web panel: the website, the domain and the URL it ended at masked, no screenshot, no link", !!briefing && masked(briefing.domain, RAW.domain) && masked(briefing.company.website, RAW.website) && masked(briefing.profile?.domain, RAW.domain) && briefing.profile?.screenshotUrl === null && briefing.websiteMasked === true, briefing && { domain: briefing.domain, website: briefing.company.website, profile: briefing.profile?.domain, finalUrl: briefing.profile?.finalUrl });
      ok("  what it found about mail stays", briefing?.profile?.emailProvider === "Self-hosted or other");
      ok("  the panel carries the domain nowhere — DMARC, MX and name servers included", !!briefing && leaks(briefing, [RAW.domain]).length === 0, briefing && leaks(briefing, [RAW.domain]));
      const own = await domain.getDomainProfile(company.id);
      ok("  the profile on its own neither", !!own && leaks(own, [RAW.domain]).length === 0, own ? leaks(own, [RAW.domain]) : "not found");
      const listed = await domain.listDomainProfiles({ page: 1, pageSize: 50, search: TAG });
      const row = listed.rows.find((r) => r.id === company.id);
      ok("the module's list: the website masked, its profile with no domain in it", !!row && masked(row.website, RAW.website) && leaks(row, [RAW.domain]).length === 0, row && { website: row.website, leaks: leaks(row, [RAW.domain]) });
      const searched = await domain.listDomainProfiles({ page: 1, pageSize: 50, search: RAW.domain });
      ok("  a search on the masked website doesn't find it", !searched.rows.some((r) => r.id === company.id), searched.rows.length);
      const refused = await domain.refreshDomainProfile(nosite.id);
      ok("a lookup refused for a website that isn't one names it masked", !refused.ok && refused.error.includes("doesn't look like a website") && !refused.error.includes(`zzmact${SFX}-not-a-site`), refused.ok ? "looked up" : refused.error);
    }

    // ─── 6 ───────────────────────────────────────────────────────────────────────────────────────
    if (section(6, "email-builder-tools")) {
      // A name masked in lists isn't searchable (security audit round three, R3-21) — the picker finds them by company.
      const found = await emailBuilder.searchTestContacts(`${TAG} Pvt Ltd`);
      const mine = found.find((c) => c.id === asha);
      ok("the test send's contact picker: name and email masked", !!mine && masked(mine.email, RAW.email) && masked(mine.name, RAW.name) && leaks(found.filter((c) => c.id === asha), people).length === 0, mine);
      const byName = await emailBuilder.searchTestContacts(RAW.name);
      ok("  a search on the masked name doesn't find them", !byName.some((c) => c.id === asha), byName.length);
      const byAddress = await emailBuilder.searchTestContacts(RAW.email);
      ok("  a search on the masked address doesn't find them", !byAddress.some((c) => c.id === asha), byAddress.length);
      const template = await db.marketingTemplate.create({ data: { name: `${TAG} test`, channel: "EMAIL", topic: "OFFERS", subject: "Hello {{fullName|there}}", body: "<p>Dear {{fullName|there}} ({{firstName|you}}), {{companyName}}</p>", format: "HTML", createdById: me.id }, select: { id: true } });
      made.templates.push(template.id);
      const sent = await emailBuilder.sendTemplateTest({ templateId: template.id, contactId: asha });
      const mail = mailed[mailed.length - 1];
      ok("a test filled from that contact: sent to the tester, as the tester sees the contact", sent.ok && !!mail && mail.to === me.email && mail.subject.includes(`${RAW.name[0]}********`), sent.ok ? mail?.subject : sent.error);
      ok("  the mail and the answer carry no raw name, email or phone", sent.ok && leaks({ mail, sent }, people).length === 0, leaks({ mail, sent }, people));
    }

    // ─── 7 ───────────────────────────────────────────────────────────────────────────────────────
    if (section(7, "email-verification")) {
      const page = await emailVerification.badEmailContacts({ page: 1, pageSize: 500 });
      const row = page.rows.find((r) => r.id === ravi);
      ok("Bad emails: the address and number masked, the last check's finding gone with it", !!row && masked(row.email, RAW.badEmail) && masked(row.phone, RAW.corrected) && row.emailCheckDetail === null && row.emailCheckedValue === null && row.masked.email, row && { email: row.email, phone: row.phone, detail: row.emailCheckDetail });
      ok("  the row carries no raw value", !!row && leaks(row, [RAW.badName, RAW.badEmail, RAW.corrected]).length === 0, row && leaks(row, [RAW.badName, RAW.badEmail, RAW.corrected]));
      const checked = await emailVerification.verifyContactEmail(ravi);
      ok("a check's finding, which quotes the address, isn't sent for a masked one — the verdict is", checked.ok && checked.data.status === "INVALID" && checked.data.detail === "", checked.ok ? checked.data : checked.error);
      const batch = await emailVerification.verifyContactEmails([ravi]);
      ok("  nor in a batch", batch.ok && batch.data.results.every((r) => r.detail === ""), batch.ok ? batch.data.results : batch.error);
    }

    // ─── 8 ───────────────────────────────────────────────────────────────────────────────────────
    if (section(8, "feedback")) {
      const request = await db.feedbackRequest.create({ data: { token: `zz-mact-${SFX}-${Math.random().toString(36).slice(2)}`, reference: `ZZM/${SFX}`, companyId: company.id, contactId: asha, sentToName: RAW.name, sentToEmail: RAW.email, sentToPhone: RAW.phone, requestedById: me.id, sentAt: new Date() }, select: { id: true } });
      made.feedback.push(request.id);
      const listed = await feedback.listFeedback({ companyId: company.id });
      const row = listed.rows.find((r) => r.id === request.id);
      ok("feedback requests: who it went to — the contact and the snapshot — masked", !!row && masked(row.sentToEmail, RAW.email) && masked(row.sentToPhone, RAW.phone) && masked(row.contact?.email, RAW.email), row && { sentTo: [row.sentToName, row.sentToEmail, row.sentToPhone], contact: row.contact });
      ok("  the list carries no raw value", leaks(listed, people).length === 0, leaks(listed, people));
      const one = await feedback.getFeedbackRequest(request.id);
      const tab = await feedback.companyFeedback(company.id);
      ok("  one request, and the company's tab, neither", !!one && leaks(one, people).length === 0 && leaks(tab, people).length === 0, { one: leaks(one, people), tab: leaks(tab, people) });
      const targets = await feedback.feedbackTargets(company.id);
      const pick = targets.contacts.find((c) => c.id === asha);
      ok("the request form's contacts: masked, and carrying no raw value", !!pick && masked(pick.email, RAW.email) && leaks(targets.contacts, people).length === 0, pick && { email: pick.email, phone: pick.phone });
    }

    // ─── 9 ───────────────────────────────────────────────────────────────────────────────────────
    if (section(9, "forms")) {
      const form = await db.inboundForm.create({ data: { slug: `zz-mact-${SFX}`, name: `${TAG} event`, fields: [], ownerUserId: me.id, createdById: me.id, fillMode: "BOTH" }, select: { id: true } });
      made.forms.push(form.id);
      await db.formInvite.create({ data: { formId: form.id, token: `zz-mact-${SFX}-${Math.random().toString(36).slice(2)}`, contactId: asha, companyId: company.id, email: RAW.email } });
      // A name masked in lists isn't searchable (security audit round three, R3-21) — the search finds them by company.
      const found = (await forms.searchInvitees(form.id, `${TAG} Pvt Ltd`)) ?? [];
      const mine = found.find((c) => c.id === asha);
      ok("a form's invitee search: name and email masked", !!mine && masked(mine.email, RAW.email) && masked(mine.name, RAW.name) && leaks(found.filter((c) => c.company.id === company.id), people).length === 0, mine);
      const byName = (await forms.searchInvitees(form.id, RAW.name)) ?? [];
      ok("  a search on the masked name doesn't find them", !byName.some((c) => c.id === asha), byName.length);
      const byAddress = (await forms.searchInvitees(form.id, RAW.email)) ?? [];
      ok("  a search on the masked address doesn't find them", !byAddress.some((c) => c.id === asha), byAddress.length);
      const invites = await forms.listFormInvites(form.id);
      const invite = invites?.rows.find((r) => r.contact.id === asha);
      ok("its invitations: the address each went to masked, as the contact's", !!invite && masked(invite.email, RAW.email) && masked(invite.contact.name, RAW.name) && leaks(invites, people).length === 0, invite && { email: invite.email, name: invite.contact.name });
      const searched = await forms.listFormInvites(form.id, { q: RAW.email });
      ok("  a search on the masked address doesn't find it", !!searched && searched.rows.length === 0, searched?.rows.length);
      // The Invite dialog's preview (src/lib/forms/send-invites.ts `inviteCandidates`, asked for this person).
      const preview = await forms.previewInvites(form.id, [asha]);
      const candidate = preview.ok ? preview.people.find((p) => p.id === asha) : undefined;
      ok("the Invite dialog: each person's name and address masked", !!candidate && masked(candidate.email, RAW.email) && masked(candidate.name, RAW.name), preview.ok ? candidate : preview.error);
      ok("  the preview carries no raw value", preview.ok && leaks(preview.people, people).length === 0, preview.ok ? leaks(preview.people, people) : preview.error);
    }

    // ─── 10 ──────────────────────────────────────────────────────────────────────────────────────
    if (section(10, "it-asset")) {
      const asset = await db.asset.create({ data: { assetTag: `ZZM-${SFX}`.toUpperCase(), name: `${TAG} laptop`, createdById: me.id, ownership: "CLIENT_OWNED", ownerCompanyId: company.id, siteCompanyId: company.id, locationId: site, custodianUserId: me.id, status: "INSTALLED" }, select: { id: true } });
      made.assets.push(asset.id);
      const listed = (await itAsset.listAssets({ search: `ZZM-${SFX}`.toUpperCase() })).find((a) => a.id === asset.id);
      ok("the register: the site's city masked, its label kept", !!listed && listed.location?.city !== RAW.city && listed.location?.label === "ZZ Head Office", listed?.location);
      const one = await itAsset.getAsset(asset.id);
      const held = (await itAsset.assetsHeldBy(me.id)).find((a) => a.id === asset.id);
      ok("  an asset's page, and what somebody holds, neither", !!one && !!held && leaks({ one, held }, places).length === 0, leaks({ one, held }, places));
      const estate = await itAsset.companyEstate(company.id);
      ok("a company's estate: its machines' and consignments' sites masked", !!estate && estate.theirs.some((a) => a.id === asset.id) && leaks(estate, places).length === 0, estate ? leaks(estate, places) : "none");
      const sites = await itAsset.locationsFor(company.id);
      ok("the site picker: each site's city and state masked, picked by label", sites.length === 1 && sites[0]!.label === "ZZ Head Office" && leaks(sites, places).length === 0, sites);
    }

    // ─── 11 ──────────────────────────────────────────────────────────────────────────────────────
    if (section(11, "lead-reminder")) {
      const set = await leadReminder.setLeadReminder({ leadId: lead.id, remindOn: "2026-12-01" });
      const tasks = await db.task.findMany({ where: { leadId: lead.id, assignedToUserId: me.id }, select: { title: true } });
      const logged = await db.auditLog.findMany({ where: { userId: me.id, entityType: "Task", entityId: lead.id, createdAt: { gte: startedAt } }, select: { entityLabel: true } });
      ok("a lead reminder: its task names the lead as its author sees it", set.ok && tasks.length === 1 && tasks[0]!.title.includes(`${RAW.title[0]}********`), set.ok ? tasks : set.error);
      ok("  neither the task nor the audit line copies the masked title", leaks({ tasks, logged }, [RAW.title]).length === 0 && logged.length > 0, { tasks, logged });
    }

    // ─── 12 ──────────────────────────────────────────────────────────────────────────────────────
    if (section(12, "portal")) {
      const login = await db.portalLogin.create({ data: { token: `zz-mact-${SFX}-${Math.random().toString(36).slice(2)}`, companyId: company.id, contactId: asha, personName: RAW.name, personEmail: RAW.email }, select: { id: true } });
      made.portalLogins.push(login.id);
      await db.portalRequest.create({ data: { companyId: company.id, loginId: login.id, personName: RAW.name, personEmail: RAW.email, kind: "QUESTION", message: "ZZ mact question" } });
      const logins = await portal.portalLogins(company.id);
      const row = logins.ok ? logins.data.find((l) => l.id === login.id) : undefined;
      ok("portal links: who each is for, masked as the contact", !!row && masked(row.personEmail, RAW.email) && masked(row.personName, RAW.name) && leaks(logins, people).length === 0, row && { name: row.personName, email: row.personEmail });
      const requests = await portal.listPortalRequests("all");
      const asked = requests.ok ? requests.data.find((r) => r.companyId === company.id) : undefined;
      ok("portal requests: who asked, masked the same way", !!asked && masked(asked.personEmail, RAW.email) && leaks(requests.ok ? requests.data.filter((r) => r.companyId === company.id) : [], people).length === 0, asked && { name: asked.personName, email: asked.personEmail });
    }

    // ─── 13 ──────────────────────────────────────────────────────────────────────────────────────
    if (section(13, "project")) {
      const made1 = await db.project.create({ data: { code: `ZZM-${SFX}`, companyId: company.id, name: `${TAG} rollout`, createdById: me.id, managerId: me.id, stakeholders: { create: [{ contactId: asha }] } }, select: { id: true } });
      made.projects.push(made1.id);
      const one = await project.getProject(made1.id);
      const contact = one?.stakeholders.find((s) => s.contact?.id === asha)?.contact;
      ok("a project's stakeholders: the customer's person masked", !!contact && masked(contact.email, RAW.email) && masked(contact.phone, RAW.phone), contact);
      ok("  the project carries no raw value of theirs", !!one && leaks(one, people).length === 0, one ? leaks(one, people) : "not found");
    }

    // ─── 14 ──────────────────────────────────────────────────────────────────────────────────────
    if (section(14, "renewal")) {
      const item = await db.item.findFirst({ where: { type: "SUBSCRIPTION" }, select: { id: true } });
      if (item) {
        const order = await db.companyProduct.create({ data: { companyId: company.id, locationId: site, itemId: item.id, addedByUserId: me.id, endDate: new Date(Date.now() + 20 * 86_400_000), startDate: new Date(Date.now() - 345 * 86_400_000) }, select: { id: true } });
        made.orders.push(order.id);
        const paged = await renewal.listRenewalsPaged({ search: TAG, page: 1, pageSize: 25 });
        const row = paged.rows.find((r) => r.id === order.id);
        ok("Renewals: who to ring, masked", !!row && masked(row.company.contacts[0]?.phone, RAW.phone) && masked(row.company.contacts[0]?.name, RAW.name), row?.company.contacts);
        ok("  the page carries no raw value", leaks(paged, people).length === 0, leaks(paged, people));
        const whole = await renewal.listRenewals({ search: TAG });
        ok("  nor the whole book", whole.some((r) => r.id === order.id) && leaks(whole, people).length === 0, leaks(whole, people));
      } else ok("Renewals — not tried: no subscription item here", true);
    }

    // ─── 15 ──────────────────────────────────────────────────────────────────────────────────────
    if (section(15, "reseller")) {
      const onboarding = await reseller.getResellerOnboarding(resellerCo.id);
      ok("a reseller's onboarding: PAN and GSTIN masked, still counted as on file", !!onboarding && masked(onboarding.inputs.panNumber, RAW.resellerPan) && masked(onboarding.inputs.gstNumber, RAW.resellerGstin), onboarding?.inputs);
      ok("  it carries neither in the clear", !!onboarding && leaks(onboarding, [RAW.resellerPan, RAW.resellerGstin]).length === 0, onboarding && leaks(onboarding, [RAW.resellerPan, RAW.resellerGstin]));
    }

    // ─── 16 ──────────────────────────────────────────────────────────────────────────────────────
    if (section(16, "support-mail")) {
      const thread = await supportMail.ticketEmails(ticketId);
      ok("a ticket's emails: the reply goes to its contact, whose address is shown masked", !!thread && masked(thread.replyTo, RAW.email), thread?.replyTo);
      ok("  the thread carries no raw value", !!thread && leaks(thread, people).length === 0, thread ? leaks(thread, people) : "none");
    }

    // ─── 17 ──────────────────────────────────────────────────────────────────────────────────────
    if (section(17, "ticket")) {
      const one = await ticket.getTicket(ticketId);
      ok("a ticket's page: its contact's email and phone masked, and said to be", !!one?.contact && masked(one.contact.email, RAW.email) && masked(one.contact.phone, RAW.phone) && one.contact.masked.phone, one?.contact);
      ok("  the ticket carries no raw value", !!one && leaks(one, people).length === 0, one ? leaks(one, people) : "none");
    }

    // ─── 18 ──────────────────────────────────────────────────────────────────────────────────────
    if (section(18, "verification")) {
      const filed = await db.contactVerification.create({ data: { companyId: company.id, contactId: asha, field: "PHONE", originalValue: RAW.phone, status: "CORRECTED", correctedValue: RAW.corrected, verifiedByUserId: me.id }, select: { id: true } });
      const queue = await verification.pendingVerifications({ page: 1, pageSize: 500 });
      const row = queue.rows.find((r) => r.id === filed.id);
      ok("verifications: the number checked and the one given, and the contact, masked", !!row && masked(row.originalValue, RAW.phone) && masked(row.correctedValue, RAW.corrected) && masked(row.contact?.email, RAW.email), row && { was: row.originalValue, now: row.correctedValue, contact: row.contact });
      ok("  the queue carries no raw value", !!row && leaks(row, [...people, RAW.corrected]).length === 0, row && leaks(row, [...people, RAW.corrected]));
      const theirs = await verification.companyVerifications(company.id);
      ok("  nor the company's own list", theirs.length > 0 && leaks(theirs, [...people, RAW.corrected]).length === 0, leaks(theirs, [...people, RAW.corrected]));
      // A "Right" pressed on the number as the calling station shows it (the presenter's own answer): filed against the real one.
      const shown = (await contactMasker(me.id, "list", [asha])).present(asha, "phone", RAW.phone) ?? "";
      const verdict = await verification.verifyContactDetail({ companyId: company.id, contactId: asha, field: "PHONE", originalValue: shown, status: "CORRECT" });
      const stored = verdict.ok ? await db.contactVerification.findUnique({ where: { id: verdict.data.id }, select: { originalValue: true } }) : null;
      ok("a verdict on a masked number is filed against the number on file, not the stars", masked(shown, RAW.phone) && verdict.ok && stored?.originalValue === RAW.phone, verdict.ok ? stored : verdict.error);
    }

    // ─── 19 ──────────────────────────────────────────────────────────────────────────────────────
    if (section(19, "visit")) {
      const line = [RAW.address, RAW.city, RAW.state, "411777"].join(", ");
      const planned = await db.visit.create({ data: { companyId: company.id, contactId: asha, leadId: lead.id, locationId: site, scheduledFor: new Date(Date.now() + 86_400_000), userId: me.id, address: line }, select: { id: true } });
      made.visits.push(planned.id);
      const onLead = await visit.listLeadVisits(lead.id);
      const card = onLead.find((v) => v.id === planned.id);
      ok("a lead's Visits card: the lead named as its page names it, the address masked", !!card && masked(card.lead?.title, RAW.title) && card.address !== line, card && { title: card.lead?.title, address: card.address });
      const one = await visit.getVisit(planned.id);
      ok("a visit's page: its contact, the site and the visit's address masked", !!one && masked(one.contact?.email, RAW.email) && masked(one.contact?.phone, RAW.phone) && one.location?.address !== RAW.address && one.address !== line, one && { contact: one.contact, address: one.address, site: one.location?.city });
      ok("  the page carries no raw value", !!one && leaks(one, [...people, ...places, RAW.title]).length === 0, one ? leaks(one, [...people, ...places, RAW.title]) : "none");
      const listed = await visit.listVisitsPaged({ companyId: company.id, page: 1, pageSize: 50 });
      const tab = await visit.listCompanyVisits(company.id);
      ok("  the visits list and the company's tab carry the address masked", leaks({ listed, tab }, places).length === 0 && listed.rows.some((v) => v.id === planned.id), leaks({ listed, tab }, places));
      const options = await visit.visitFormOptions(company.id);
      ok("the visit form's sites: their address masked, picked by label", options.locations.length === 1 && options.locations[0]!.label === "ZZ Head Office" && leaks(options.locations, places).length === 0, options.locations);
      // Saving keeps the real address: an edit sent back as the presenter shows it, and a new visit with the site's address
      // filled in as the form fills it from the site's masked parts.
      const sites = await companyMasker(me.id, "list");
      const kept = await visit.updateVisit({ id: planned.id, companyId: company.id, contactId: asha, leadId: lead.id, locationId: site, purpose: "INTRO_MEETING", scheduledFor: "2026-12-02T10:00", address: sites.present("address", line) ?? "" });
      const after = await db.visit.findUnique({ where: { id: planned.id }, select: { address: true } });
      ok("saving the visit as shown keeps the real address", kept.ok && after?.address === line && sites.present("address", line) !== line, kept.ok ? after?.address : kept.error);
      const parts = sites.location({ address: RAW.address, city: RAW.city, state: RAW.state, pincode: "411777" });
      const filled = [parts.address, parts.city, parts.state, parts.pincode].filter(Boolean).join(", ");
      const createdVisit = await visit.createVisit({ companyId: company.id, locationId: site, purpose: "INTRO_MEETING", scheduledFor: "2026-12-03T10:00", address: filled });
      const fresh = createdVisit.ok ? await db.visit.findUnique({ where: { id: createdVisit.data.id }, select: { address: true } }) : null;
      if (createdVisit.ok) made.visits.push(createdVisit.data.id);
      ok("a new visit at the site, its address filled in masked, stores the real one", createdVisit.ok && fresh?.address === line && filled !== line, createdVisit.ok ? fresh?.address : createdVisit.error);
    }

    // ─── 20 ──────────────────────────────────────────────────────────────────────────────────────
    if (section(20, "workspace")) {
      const run = await workspace.runWorkbook({ filters: {}, page: 1, pageSize: 50, search: TAG });
      const row = run.rows.find((r) => r.id === company.id);
      ok("a saved list: each company's website, city and state masked", !!row && masked(row.website, RAW.website) && row.locations.every((l) => l.city !== RAW.city && l.state !== RAW.state), row && { website: row.website, places: row.locations });
      ok("  the list carries no raw value", leaks(run, places).length === 0, leaks(run, places));
      const options = await workspace.workbookFilterOptions();
      ok("its City and State filters offer no masked value", !options.cities.includes(RAW.city) && !options.states.includes(RAW.state) && leaks({ c: options.cities, s: options.states }, [RAW.city, RAW.state]).length === 0, { cities: options.cities.length, states: options.states.length });
    }
  } finally {
    actor = null;
    const companies = made.companies;
    await db.task.deleteMany({ where: { leadId: { in: made.leads } } });
    await db.visit.deleteMany({ where: { OR: [{ id: { in: made.visits } }, { companyId: { in: companies } }] } });
    await db.contactVerification.deleteMany({ where: { companyId: { in: companies } } });
    await db.portalRequest.deleteMany({ where: { companyId: { in: companies } } });
    await db.portalLogin.deleteMany({ where: { companyId: { in: companies } } });
    await db.formInvite.deleteMany({ where: { formId: { in: made.forms } } });
    await db.inboundForm.deleteMany({ where: { id: { in: made.forms } } });
    await db.marketingTemplate.deleteMany({ where: { id: { in: made.templates } } });
    await db.feedbackRequest.deleteMany({ where: { companyId: { in: companies } } });
    await db.project.deleteMany({ where: { id: { in: made.projects } } });
    await db.asset.deleteMany({ where: { id: { in: made.assets } } });
    await db.consignment.deleteMany({ where: { id: { in: made.consignments } } });
    await db.companyProduct.deleteMany({ where: { id: { in: made.orders } } });
    await db.workbookRecord.deleteMany({ where: { workbookId: { in: made.workbooks } } });
    await db.workbook.deleteMany({ where: { id: { in: made.workbooks } } });
    await db.domainProfile.deleteMany({ where: { companyId: { in: companies } } });
    await db.ticket.deleteMany({ where: { id: { in: made.tickets } } });
    await db.lead.deleteMany({ where: { id: { in: made.leads } } });
    await db.resellerProfile.deleteMany({ where: { companyId: { in: companies } } });
    await db.contact.deleteMany({ where: { companyId: { in: companies } } });
    await db.companyLocation.deleteMany({ where: { companyId: { in: companies } } });
    await db.company.deleteMany({ where: { id: { in: companies } } });
    await db.userFieldPolicy.deleteMany({ where: { userId: me.id, reason: REASON } });
    await db.userPermission.deleteMany({ where: { userId: me.id, reason: REASON } });
    await db.auditLog.deleteMany({ where: { userId: me.id, createdAt: { gte: startedAt } } });
    await db.notification.deleteMany({ where: { userId: me.id, createdAt: { gte: startedAt } } });
  }

  console.log(failures === 0 ? `\nAll ${passes} action masking checks passed.\n` : `\n${failures} check(s) failed (${passes} passed).\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
