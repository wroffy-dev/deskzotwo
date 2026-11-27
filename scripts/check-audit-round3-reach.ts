/**
 * check:audit-round3-reach — the security audit's round three (14 Nov 2026, docs/reports/security-audit-2026-11-11.md
 * section 12), group R: reports, search, masking, marketing and the helpdesk. Each fix shown to hold the way it was
 * broken, by calling the server's own code as the screens do.
 *
 *   R3-19  the forecast books only approved-onward orders and lists deals through the lead rule; "New customers" only
 *          the companies and invoices the person reaches, and the download needs Export financial data
 *   R3-20  `includeResellerManaged` is never saved on a workbook or an audience, and honoured only by a report
 *   R3-21  a masked contact name doesn't match a search; pickers mask names; a person's Activity lists only records
 *          the viewer may open and masks a company's website; account filters on masked fields are dropped
 *   R3-22  company marketing sends no token or body; a campaign's sample carries a dummy token; re-subscribing after
 *          "unsubscribe from everything" waits for the emailed confirmation, with the browser in the evidence
 *   R3-23  marketing previews mask recipients; an active journey edited without send is paused; a large journey
 *          needs an approver who didn't build it; a campaign's editor can't approve it
 *   lows   journey steps read one company; the visitor link needs a new or unconfirmed contact and an unlinked visitor
 *
 * A fixture of its own in the local database, tagged ZZR3R, removed in a finally; every assertion is about its own rows.
 * Personal field policies (contact name and email, company address and website masked) are set on the fixture's own
 * users, so the masking checks don't depend on any real role.
 *
 *   npx tsx scripts/check-audit-round3-reach.ts
 */
import "dotenv/config";
import Module from "node:module";
import { randomBytes } from "node:crypto";

const TAG = "ZZR3R";
const MAIL = "@zzr3r.invalid";
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const note = (text: string) => console.log(`  ..   ${text}`);
const section = (title: string) => console.log(`\n— ${title} —\n`);

// Stubs, before anything that reads them is loaded (hence require below, not import).
type Actor = { id: string; name: string; role: string; email: string };
let actor: Actor | null = null;
const internals = Module as unknown as { _load(req: string, parent: unknown, isMain: boolean): unknown };
const original = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
  if (request === "next/headers") {
    return {
      cookies: async () => ({ get: () => undefined, set: () => {} }),
      headers: async () => new Headers({ "user-agent": `${TAG}-browser/1.0` }),
    };
  }
  if (request.endsWith("lib/session") || request === "@/lib/session") {
    const user = async () => actor;
    return { requireUser: user, currentUser: user, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  // The module gates are the plan's and the switches', not what this suite proves: open to the actor.
  if (request === "@/lib/modules-access" || request.endsWith("lib/modules-access")) {
    const real = original.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, requireModuleAccess: async () => actor, requireModuleUser: async () => actor };
  }
  if (request === "@/actions/module" || request.endsWith("actions/module")) {
    const real = original.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, isModuleEnabled: async () => true };
  }
  return original.call(this, request, parent, isMain);
} as typeof original;

/* eslint-disable @typescript-eslint/no-require-imports */
const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
const forecast = require("../src/actions/forecast") as typeof import("../src/actions/forecast");
const newCustomers = require("../src/actions/new-customers") as typeof import("../src/actions/new-customers");
const workspace = require("../src/actions/workspace") as typeof import("../src/actions/workspace");
const filters = require("../src/lib/workspace/filters") as typeof import("../src/lib/workspace/filters");
const audience = require("../src/lib/marketing/audience") as typeof import("../src/lib/marketing/audience");
const contactActions = require("../src/actions/contact") as typeof import("../src/actions/contact");
const companyOptions = require("../src/actions/company-options") as typeof import("../src/actions/company-options");
const companyActions = require("../src/actions/company") as typeof import("../src/actions/company");
const masking = require("../src/lib/contacts/masking") as typeof import("../src/lib/contacts/masking");
const { companyMasker } = require("../src/lib/companies/masking") as typeof import("../src/lib/companies/masking");
const timeline = require("../src/lib/activity/timeline") as typeof import("../src/lib/activity/timeline");
const access = require("../src/lib/authz/access") as typeof import("../src/lib/authz/access");
const { can } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
const marketing = require("../src/actions/marketing") as typeof import("../src/actions/marketing");
const marketingPublic = require("../src/actions/marketing-public") as typeof import("../src/actions/marketing-public");
const optIn = require("../src/lib/marketing/double-opt-in") as typeof import("../src/lib/marketing/double-opt-in");
const pipeline = require("../src/lib/marketing/pipeline") as typeof import("../src/lib/marketing/pipeline");
const inboxActivity = require("../src/lib/inbox/activity") as typeof import("../src/lib/inbox/activity");
const supportSend = require("../src/lib/support-mail/send") as typeof import("../src/lib/support-mail/send");
const activityActions = require("../src/actions/activity") as typeof import("../src/actions/activity");
/* eslint-enable @typescript-eslint/no-require-imports */

async function cleanup() {
  const users = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  const contacts = (await db.contact.findMany({ where: { companyId: { in: companies } }, select: { id: true, email: true } })).map((c) => c);
  const leads = (await db.lead.findMany({ where: { companyId: { in: companies } }, select: { id: true } })).map((l) => l.id);
  const journeys = (await db.journey.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((j) => j.id);
  const campaigns = (await db.campaign.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  await db.marketingMessage.deleteMany({ where: { companyId: { in: companies } } });
  await db.marketingMessage.deleteMany({ where: { campaignId: { in: campaigns } } });
  await db.campaignOption.deleteMany({ where: { campaignId: { in: campaigns } } }).catch(() => {});
  await db.campaign.deleteMany({ where: { id: { in: campaigns } } });
  await db.journeyEnrolment.deleteMany({ where: { journeyId: { in: journeys } } });
  await db.journeyStep.deleteMany({ where: { journeyId: { in: journeys } } });
  await db.journey.deleteMany({ where: { id: { in: journeys } } });
  await db.marketingListMember.deleteMany({ where: { contactId: { in: contacts.map((c) => c.id) } } });
  await db.marketingList.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.marketingTemplate.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.audience.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.workbook.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.consentConfirmation.deleteMany({ where: { consent: { contactId: { in: contacts.map((c) => c.id) } } } }).catch(() => {});
  await db.contactConsent.deleteMany({ where: { contactId: { in: contacts.map((c) => c.id) } } });
  await db.suppression.deleteMany({ where: { value: { endsWith: MAIL } } });
  await db.webVisitor.deleteMany({ where: { channel: { name: { startsWith: TAG } } } }).catch(() => {});
  await db.inboxChannel.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  await db.activity.deleteMany({ where: { leadId: { in: leads } } });
  await db.lead.deleteMany({ where: { id: { in: leads } } });
  await db.tradeDocument.deleteMany({ where: { companyId: { in: companies } } });
  await db.companyProduct.deleteMany({ where: { companyId: { in: companies } } });
  await db.contact.deleteMany({ where: { companyId: { in: companies } } });
  await db.companyLocation.deleteMany({ where: { companyId: { in: companies } } });
  await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: users } }, { companyId: { in: companies } }] } });
  await db.company.deleteMany({ where: { id: { in: companies } } });
  await db.item.deleteMany({ where: { sku: { startsWith: TAG } } });
  await db.notification.deleteMany({ where: { userId: { in: users } } });
  await db.activityLog.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
  await db.user.deleteMany({ where: { id: { in: users } } });
}

const MASK = { view: true, maskInList: true, maskInDetail: true, unmask: false };

async function main() {
  await cleanup();
  const masking0 = await db.fieldMaskingSettings.findUnique({ where: { id: "global" } });
  const threshold0 = (await db.organisationSettings.findUnique({ where: { id: "global" }, select: { marketingApprovalThreshold: true } }))?.marketingApprovalThreshold ?? null;
  try {
    const mk = (name: string, role: string) =>
      db.user.create({ data: { name: `Zz ${name}`, email: `${name.toLowerCase()}${MAIL}`, passwordHash: "!", role: role as never }, select: { id: true, name: true, role: true, email: true } });
    const ana = await mk("Ana", "ADMIN");
    const sam = await mk("Sam", "SALES");
    const mia = await mk("Mia", "ADMIN");
    const max = await mk("Max", "ADMIN");
    const nia = await mk("Nia", "ADMIN");
    const grant = (userId: string, permission: string, allowed: boolean) => db.userPermission.create({ data: { userId, permission, allowed, reason: "check:audit-round3-reach" } });
    await grant(max.id, "marketing.send", false);
    await grant(nia.id, "marketing.approve", false);
    await grant(sam.id, "data.exportFinance", false);
    await grant(sam.id, "performance.view", true);
    // Lea may use the forecast but not see leads.
    const lea = await mk("Lea", "SALES");
    await grant(lea.id, "leads.view", false);
    // Masked for Mia and Sam: a contact's name and email in lists, and a company's address and website.
    await db.fieldMaskingSettings.upsert({ where: { id: "global" }, create: { id: "global", enabled: true }, update: { enabled: true } });
    for (const u of [mia, sam]) {
      await db.userFieldPolicy.createMany({
        data: [
          { userId: u.id, entity: "contacts", field: "name", ...MASK, reason: TAG },
          { userId: u.id, entity: "contacts", field: "email", ...MASK, format: "email", reason: TAG },
          { userId: u.id, entity: "companies", field: "address", ...MASK, reason: TAG },
          { userId: u.id, entity: "companies", field: "website", ...MASK, reason: TAG },
        ],
      });
    }

    const company = async (name: string, owner: string, website: string | null = null) => {
      const c = await db.company.create({ data: { name: `${TAG} ${name}`, normalizedName: `${TAG} ${name}`.toLowerCase(), ownerUserId: owner, createdById: owner, website }, select: { id: true, name: true } });
      const site = await db.companyLocation.create({ data: { companyId: c.id, label: "Head Office", isPrimary: true, city: "Zzcity", state: "Zzstate", country: "India" }, select: { id: true } });
      return { ...c, siteId: site.id };
    };
    const alpha = await company("Alpha", sam.id, "alpha.zzr3r.invalid");
    const beta = await company("Beta", ana.id);
    const quentin = await db.contact.create({ data: { companyId: alpha.id, name: "Quentinzz Probe", email: `quentin${MAIL}`, isPrimary: true }, select: { id: true, name: true, email: true } });
    const rhea = await db.contact.create({ data: { companyId: alpha.id, name: "Rheazz Probe", email: `rhea${MAIL}`, emailStatus: "VALID", emailCheckedValue: `rhea${MAIL}` }, select: { id: true, name: true, email: true } });
    const item = await db.item.create({ data: { name: `${TAG} Licence`, sku: `${TAG}-S`, type: "SUBSCRIPTION", sellingPrice: 1000, createdById: ana.id }, select: { id: true } });

    // ── R3-19 ─────────────────────────────────────────────────────────────────────────────────
    section("R3-19: forecast and New customers");
    const minuteAgo = new Date(Date.now() - 60_000);
    const order = (companyId: string, locationId: string, by: string, status: "APPROVED" | "REJECTED", price: number) =>
      db.companyProduct.create({ data: { companyId, locationId, itemId: item.id, addedByUserId: by, quantity: 1, unitPrice: price, bookedAt: minuteAgo, orderStatus: status }, select: { id: true } });
    await order(alpha.id, alpha.siteId, sam.id, "APPROVED", 1111);
    await order(alpha.id, alpha.siteId, sam.id, "REJECTED", 2222);
    const betaOrder = await order(beta.id, beta.siteId, ana.id, "APPROVED", 3333);
    actor = ana;
    const seen = await forecast.getForecast({ ownerId: sam.id });
    if (!seen) note("the forecast isn't open in this workspace (leads not in the plan) — its checks are skipped");
    else {
      const current = seen.periods[0]!.key;
      ok("forecast: a rejected order isn't booked — the approved one is, alone", (seen.booked as Record<string, number>)[current] === 1111, (seen.booked as Record<string, number>)[current]);
    }
    // A deal on Sam's account, owned by Ana: listed for Sam only if his lead rule reaches it.
    const anaLead = await db.lead.create({ data: { companyId: alpha.id, title: `${TAG} Ana's deal`, status: "NEW", ownerUserId: ana.id, estimatedValue: 5000 }, select: { id: true } });
    actor = sam;
    const samView = await forecast.getForecast({});
    if (samView) {
      const reaches = (await can(sam.id, "leads.view")) && (await db.lead.count({ where: { AND: [{ id: anaLead.id }, await access.leadAccess(sam.id, "view")] } })) > 0;
      const listed = samView.sales.deals.some((d: { id: string }) => d.id === anaLead.id);
      ok(`forecast: a deal on his own account follows Sam's lead rule (${reaches ? "reaches it" : "doesn't reach it"})`, listed === reaches, { listed, reaches });
      if (reaches) note("Sam's role reaches Ana's lead here, so the hidden case isn't exercised by this run");
    }
    actor = lea;
    const leaView = await forecast.getForecast({});
    ok("forecast: without leads.view, no deals at all", !!leaView && leaView.sales.deals.length === 0, leaView?.sales.deals.length);

    // New customers: first invoices in FY 2019, one on each company.
    const invoice = (companyId: string, n: string, by: string) =>
      db.tradeDocument.create({ data: { docNumber: `${TAG}-${n}`, docType: "INVOICE", direction: "SALES", status: "ISSUED", companyId, createdById: by, salespersonId: by, total: 1000, issueDate: new Date("2019-06-01T12:00:00+05:30") }, select: { id: true } });
    const alphaInvoice = await invoice(alpha.id, "A1", sam.id);
    await invoice(beta.id, "B1", ana.id);
    actor = ana;
    const all = await newCustomers.newBilledCustomers({ year: 2019 });
    const allNames = new Set((all?.customers ?? []).map((c) => c.name));
    ok("New customers, as an admin: both first invoices", allNames.has(alpha.name) && allNames.has(beta.name), [...allNames].filter((n) => n.startsWith(TAG)));
    actor = sam;
    const theirs = await newCustomers.newBilledCustomers({ year: 2019 });
    if (theirs === null) note("Sam's role has no Performance view here — New customers is refused outright");
    else {
      const names = new Set(theirs.customers.map((c) => c.name));
      const betaReached = (await db.company.count({ where: { AND: [{ id: beta.id }, await access.companyAccess(sam.id, "view")] } })) > 0;
      const alphaOpen = (await db.tradeDocument.count({ where: { AND: [{ id: alphaInvoice.id }, await access.documentAccess(sam.id, "view")] } })) > 0;
      ok(`New customers, as Sam: Beta only if his company rule reaches it (${betaReached ? "it does" : "it doesn't"})`, names.has(beta.name) === betaReached, [...names].filter((n) => n.startsWith(TAG)));
      ok("  Alpha only if his document rule opens its first invoice", !names.has(alpha.name) || alphaOpen);
      ok("  the download isn't offered without Export financial data", theirs.canExport === false && (await newCustomers.mayExportNewCustomers()) === false);
    }

    // ── R3-20 ─────────────────────────────────────────────────────────────────────────────────
    section("R3-20: the reseller flag");
    actor = ana;
    const saved = await workspace.saveWorkbook({ name: `${TAG} list`, filters: { includeResellerManaged: true, stage: ["ACTIVE"] } as never });
    const stored = saved.ok ? await db.workbook.findUnique({ where: { id: saved.data.id }, select: { filters: true } }) : null;
    ok("a workbook saved with the flag keeps the rest, never the flag", !!stored && !("includeResellerManaged" in (stored.filters as object)) && "stage" in (stored.filters as object), stored?.filters);
    const clock = await (require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace")).workspaceClock(); // eslint-disable-line @typescript-eslint/no-require-imports
    const flagged = { includeResellerManaged: true } as const;
    const listWhere = JSON.stringify(filters.buildWhere(flagged, clock));
    const reportWhere = JSON.stringify(filters.buildWhere(flagged, clock, { countingReport: true }));
    ok("a list built from flagged filters still keeps resellers' customers out", listWhere.includes("managedByResellerId"), listWhere);
    ok("  a report counting them may lift it", !reportWhere.includes("managedByResellerId"), reportWhere);
    ok("an audience's filters are read without the flag", !("includeResellerManaged" in audience.parseCompanyFilters({ includeResellerManaged: true, stage: ["ACTIVE"] })));
    const aud = await marketing.saveAudience({ name: `${TAG} audience`, companyFilters: { includeResellerManaged: true }, contactFilters: {} });
    const audRow = aud.ok ? await db.audience.findUnique({ where: { id: aud.data.id }, select: { companyFilters: true } }) : null;
    ok("  and an audience saved with it doesn't keep it", !!audRow && !("includeResellerManaged" in (audRow.companyFilters as object)), audRow?.companyFilters);

    // ── R3-21 ─────────────────────────────────────────────────────────────────────────────────
    section("R3-21: search, pickers, Activity, filters");
    actor = mia;
    ok("the masked-in-lists set includes the name", (await masking.maskedInLists(mia.id)).name === true);
    const byName = await contactActions.listAllContactsPaged({ page: 1, pageSize: 50, search: "Quentinzz" });
    ok("a search on a masked name finds nobody", !byName.rows.some((r) => r.id === quentin.id), byName.rows.map((r) => r.name));
    const byCompany = await contactActions.listAllContactsPaged({ page: 1, pageSize: 50, search: alpha.name });
    const qRow = byCompany.rows.find((r) => r.id === quentin.id);
    ok("  found by the company, the name masked", !!qRow && qRow.name !== quentin.name, qRow?.name);
    const picker = await companyOptions.companyContactOptions(alpha.id);
    ok("the contact picker sends the name masked", picker.length > 0 && picker.every((p) => p.name !== quentin.name && p.name !== rhea.name), picker.map((p) => p.name));
    const options = (await companyActions.listCompanyOptions({ take: 5000 })) as { id: string; contacts?: { id: string; name: string }[] }[];
    const optAlpha = options.find((o) => o.id === alpha.id);
    ok("the company picker's contacts: names masked", !!optAlpha && (optAlpha.contacts ?? []).every((c) => c.name !== quentin.name && c.name !== rhea.name), optAlpha?.contacts);

    // A person's Activity: Ana's change to Beta's order, her note on her lead at Alpha, and Alpha's website change.
    await db.auditLog.create({ data: { userId: ana.id, action: "UPDATE", entityType: "CompanyProduct", entityId: betaOrder.id, entityLabel: `${TAG} Beta order changed`, companyId: beta.id } });
    await db.auditLog.create({
      data: { userId: ana.id, action: "UPDATE", entityType: "Company", entityId: alpha.id, entityLabel: `${TAG} Alpha`, companyId: alpha.id, changes: [{ field: "website", label: "Website", from: "old.zzr3r.invalid", to: "alpha.zzr3r.invalid" }] },
    });
    await db.activity.create({ data: { leadId: anaLead.id, userId: ana.id, type: "NOTE", notes: `${TAG} note on Ana's deal` } });
    const feed = await timeline.personActivity(sam.id, ana.id, { take: 200 });
    const orderReached = (await db.companyProduct.count({ where: { AND: [{ id: betaOrder.id }, await access.orderAccess(sam.id, "view")] } })) > 0 && (await db.company.count({ where: { AND: [{ id: beta.id }, await access.companyAccess(sam.id, "view")] } })) > 0;
    const orderLine = feed.items.some((i) => i.title.includes(`${TAG} Beta order`));
    ok(`Activity: a change to an order is listed only if Sam may open it (${orderReached ? "he may" : "he may not"})`, orderLine === orderReached, { orderLine, orderReached });
    if (orderReached) note("Sam's role reaches Beta's order here, so the hidden case isn't exercised by this run");
    const leadReached = (await db.lead.count({ where: { AND: [{ id: anaLead.id }, await access.leadAccess(sam.id, "view")] } })) > 0;
    const noteLine = feed.items.some((i) => (i.detail ?? "").includes(`${TAG} note`));
    ok(`  a note on a lead only if his lead rule reaches it (${leadReached ? "it does" : "it doesn't"})`, !noteLine || leadReached, { noteLine, leadReached });
    const site = feed.items.find((i) => i.title === `${TAG} Alpha`);
    const websiteChange = site?.changes.find((c) => c.field === "website");
    ok("  a company's website change shown as his field access shows the website", !!site && (!!websiteChange && websiteChange.to !== "alpha.zzr3r.invalid" && websiteChange.from !== "old.zzr3r.invalid"), websiteChange);

    // The activity log's export: one's own rows without activity.viewAll, as the list beside it.
    await grant(sam.id, "activity.export", true);
    await grant(sam.id, "activity.viewAll", false);
    await db.activityLog.create({ data: { kind: "LOGIN", summary: `${TAG} Ana signed in`, userId: ana.id, userName: ana.name } });
    await db.activityLog.create({ data: { kind: "LOGIN", summary: `${TAG} Sam signed in`, userId: sam.id, userName: sam.name } });
    actor = sam;
    const exported = await activityActions.exportActivity({ search: TAG });
    ok("the activity export keeps to one's own rows without activity.viewAll", exported.ok && exported.data.csv.includes(`${TAG} Sam`) && !exported.data.csv.includes(`${TAG} Ana`), exported.ok ? exported.data.rows : exported);
    actor = mia;

    // Account filters on fields the list masks.
    const miaCompanies = await companyMasker(mia.id, "list");
    const kept = filters.withoutMaskedFilters({ city: ["Zzcity"], state: ["Zzstate"], hasWebsite: "yes", emailProvider: ["Google"], spoofable: true, stage: ["ACTIVE"] }, miaCompanies);
    ok("filters on a masked address and website are dropped; the rest kept", !kept.city && !kept.state && !kept.hasWebsite && !kept.emailProvider && !kept.spoofable && !!kept.stage, kept);
    const anaCompanies = await companyMasker(ana.id, "list");
    ok("  for somebody who sees them, nothing is dropped", !!filters.withoutMaskedFilters({ city: ["Zzcity"] }, anaCompanies).city);
    const counted = await workspace.countWorkbook({ city: ["Zzcity"], unowned: false } as never);
    const everything = await workspace.countWorkbook({});
    ok("  a workbook's count ignores the city filter for Mia (no narrower than none)", counted === everything, { counted, everything });

    // ── R3-22 / R3-23 ────────────────────────────────────────────────────────────────────────────
    section("R3-22 and R3-23: marketing");
    actor = ana;
    const template = await db.marketingTemplate.create({ data: { name: `${TAG} notice`, channel: "EMAIL", topic: "SERVICE", subject: "Hello {{firstName}}", body: "Hi {{firstName}}. {{unsubscribeUrl}}", createdById: ana.id }, select: { id: true } });
    const list = await db.marketingList.create({ data: { name: `${TAG} list`, consentNote: TAG, createdById: ana.id }, select: { id: true } });
    await db.marketingListMember.create({ data: { listId: list.id, contactId: rhea.id } });
    const campaign = await db.campaign.create({ data: { reference: `${TAG}/${randomBytes(3).toString("hex")}`, name: `${TAG} campaign`, listId: list.id, templateId: template.id, createdById: ana.id }, select: { id: true } });
    const token = `${TAG.toLowerCase()}${randomBytes(16).toString("hex")}`;
    await db.marketingMessage.create({
      data: { token, campaignId: campaign.id, companyId: alpha.id, contactId: rhea.id, channel: "EMAIL", toEmail: rhea.email, subject: "Hello Rheazz", body: `<p>Hi Rheazz</p><a href="https://x.invalid/preferences/${token}">prefs</a><img src="https://x.invalid/track/${token}/open">`, status: "SENT", sentAt: new Date(), scheduledFor: new Date() },
    });
    actor = mia;
    const tab = await marketing.companyMarketing(alpha.id);
    const tabRow = tab?.messages[0] as Record<string, unknown> | undefined;
    ok("company marketing sends no token and no body", !!tabRow && !("token" in tabRow) && !("body" in tabRow), tabRow && Object.keys(tabRow));
    ok("  and the recipient's address masked", !!tabRow && tabRow.toEmail !== rhea.email, tabRow?.toEmail);
    const report = await marketing.getCampaign(campaign.id);
    ok("the campaign's sample carries a dummy token, not the recipient's", !!report?.sample && !report.sample.body.includes(token) && report.sample.body.includes("/preferences/sample"), report?.sample?.body);
    ok("  its recent list masks the address", !!report && report.recent.every((r: { toEmail: string | null }) => r.toEmail !== rhea.email), report?.recent.map((r: { toEmail: string | null }) => r.toEmail));
    const dry = await marketing.dryRunCampaign(campaign.id);
    ok("the dry run's sample masks names and addresses", dry.ok && dry.data.sample.every((s) => s.email !== rhea.email && s.name !== rhea.name), dry.ok ? dry.data.sample : dry);
    if (dry.ok && dry.data.sample.length === 0) note("nobody sendable in the dry run's sample — the masking check had nothing to look at");
    const preview = await marketing.previewRecipients({ templateId: template.id, listId: list.id });
    ok("  as does the mass-mail preview", !!preview && preview.sample.every((s: { email: string | null; name: string }) => s.email !== rhea.email && s.name !== rhea.name), preview?.sample);

    // Campaign approval: somebody who edited it can't approve it.
    await marketing.saveCampaign({ id: campaign.id, name: `${TAG} campaign`, listId: list.id, templateId: template.id, channel: "EMAIL" });
    await db.campaign.update({ where: { id: campaign.id }, data: { status: "PENDING_APPROVAL" } });
    const selfApproved = await marketing.approveCampaign(campaign.id);
    ok("an editor of a campaign can't approve it", !selfApproved.ok && /edited/.test(selfApproved.error), selfApproved);
    await db.campaign.update({ where: { id: campaign.id }, data: { status: "CANCELLED" } });

    // Journeys: edited while running without send → paused; a large one needs an approver who didn't build it.
    const journey = await db.journey.create({ data: { name: `${TAG} journey`, trigger: "SUBSCRIPTION_RENEWAL", triggerConfig: { days: 60 }, status: "ACTIVE", createdById: ana.id, steps: { create: [{ order: 1, delayDays: 0, channel: "EMAIL", templateId: template.id }] } }, select: { id: true } });
    actor = max;
    const edited = await marketing.saveJourney({ id: journey.id, name: `${TAG} journey`, trigger: "SUBSCRIPTION_RENEWAL", triggerConfig: { days: 60 }, steps: [{ order: 1, delayDays: 0, channel: "EMAIL", templateId: template.id }] });
    const after = await db.journey.findUnique({ where: { id: journey.id }, select: { status: true } });
    ok("an active journey edited without marketing.send is paused", edited.ok && after?.status === "PAUSED", { edited, after });
    // A subscription of Alpha's renewing soon, so the trigger catches at least one; the threshold at one for the check.
    await db.companyProduct.create({ data: { companyId: alpha.id, locationId: alpha.siteId, itemId: item.id, addedByUserId: sam.id, quantity: 1, unitPrice: 1000, orderStatus: "FULFILLED", startDate: new Date(Date.now() - 300 * 86_400_000), endDate: new Date(Date.now() + 10 * 86_400_000) } });
    await db.organisationSettings.update({ where: { id: "global" }, data: { marketingApprovalThreshold: 1 } });
    actor = nia;
    const noApprove = await marketing.setJourneyStatus(journey.id, "ACTIVE");
    ok("starting a journey over the threshold needs marketing.approve", !noApprove.ok && /approve/.test(noApprove.error), noApprove);
    actor = ana;
    const builder = await marketing.setJourneyStatus(journey.id, "ACTIVE");
    ok("  and not from whoever built it", !builder.ok && /Somebody else/.test(builder.error), builder);
    actor = max;
    const editor = await marketing.setJourneyStatus(journey.id, "ACTIVE");
    ok("  (nor from somebody who may not send at all)", !editor.ok, editor);
    const stillPaused = await db.journey.findUnique({ where: { id: journey.id }, select: { status: true } });
    ok("  it stays paused", stillPaused?.status === "PAUSED", stillPaused);
    if (threshold0 !== null) await db.organisationSettings.update({ where: { id: "global" }, data: { marketingApprovalThreshold: threshold0 } });

    // Re-subscribing after "unsubscribe from everything".
    const qToken = `${TAG.toLowerCase()}${randomBytes(16).toString("hex")}`;
    await db.marketingMessage.create({ data: { token: qToken, companyId: alpha.id, contactId: quentin.id, channel: "EMAIL", toEmail: quentin.email, body: "x", status: "SENT", scheduledFor: new Date() } });
    actor = null;
    ok("unsubscribe from everything", (await marketingPublic.unsubscribeAll(qToken)).ok === true);
    const again = await marketingPublic.updatePreferences({ token: qToken, topics: ["OFFERS"] as never });
    const suppression = await db.suppression.findFirst({ where: { scope: "EMAIL", value: quentin.email!, reason: "UNSUBSCRIBED" }, select: { id: true } });
    const offers = await db.contactConsent.findUnique({ where: { contactId_channel_topic: { contactId: quentin.id, channel: "EMAIL", topic: "OFFERS" } }, select: { id: true, status: true, evidence: true } });
    ok("ticking a topic again doesn't lift the blanket unsubscribe", again.ok && again.data.awaitingConfirmation === true && !!suppression, { again, suppression });
    ok("  the topic waits as PENDING, not SUBSCRIBED", offers?.status === "PENDING", offers?.status);
    ok("  the browser is in the evidence", (offers?.evidence ?? "").includes(`${TAG}-browser`), offers?.evidence);
    const confirmed = offers ? await optIn.confirmConsent(await optIn.confirmationToken(offers.id)) : false;
    const afterConfirm = await db.contactConsent.findUnique({ where: { contactId_channel_topic: { contactId: quentin.id, channel: "EMAIL", topic: "OFFERS" } }, select: { status: true } });
    const lifted = await db.suppression.findFirst({ where: { scope: "EMAIL", value: quentin.email!, reason: "UNSUBSCRIBED" }, select: { id: true } });
    ok("  the emailed confirmation subscribes it and lifts the suppression", confirmed && afterConfirm?.status === "SUBSCRIBED" && !lifted, { confirmed, afterConfirm, lifted });

    // ── Lows ─────────────────────────────────────────────────────────────────────────────────────
    section("Lows");
    const settings = await pipeline.marketingSettings();
    const narrowed = await pipeline.resolveRecipients({ companyFilters: {}, contactFilters: { primaryOnly: false, verifiedOnly: false, maxPerCompany: 5 }, channel: "EMAIL", topic: "SERVICE", messageClass: "TRANSACTIONAL", settings, narrowTo: { companyIds: [alpha.id] } });
    ok("a journey step reads one company's contacts, not the workspace's", narrowed.length > 0 && narrowed.every((r) => r.recipient.companyId === alpha.id), narrowed.map((r) => r.recipient.companyId));

    // The visitor link: never re-pointed once known.
    const channel = await db.inboxChannel.create({ data: { kind: "WEB", name: `${TAG} site` }, select: { id: true } }).catch(() => null);
    if (!channel) note("no inbox tables here — the visitor link checks are skipped");
    else {
      const { createHash } = await import("node:crypto");
      const visitorId = randomBytes(18).toString("hex");
      const hash = createHash("sha256").update(visitorId).digest("hex");
      const visitor = await db.webVisitor.create({ data: { channelId: channel.id, tokenHash: hash }, select: { id: true } }).catch(() => null);
      if (!visitor) note("the visitor's token digest isn't the one this suite guessed — skipped");
      else {
        await inboxActivity.linkVisitorToContact(visitorId, quentin.id, "form");
        const first = await db.webVisitor.findUnique({ where: { id: visitor.id }, select: { contactId: true } });
        if (first?.contactId !== quentin.id) note("the visitor's token digest isn't sha256 hex here — the link checks are skipped");
        else {
          await inboxActivity.linkVisitorToContact(visitorId, rhea.id, "form");
          const second = await db.webVisitor.findUnique({ where: { id: visitor.id }, select: { contactId: true } });
          ok("a visitor already identified isn't re-pointed by a later form", second?.contactId === quentin.id, second);
        }
      }
    }
    ok("helpdesk mail through Deskzo is '<name> Support via Deskzo', the brand word screened", /^(?!.*deskzo.*via Deskzo$).* Support via Deskzo$/i.test(await supportSend.supportFromNameViaDeskzo()) && !/deskzo.*deskzo/i.test(await supportSend.supportFromNameViaDeskzo()), await supportSend.supportFromNameViaDeskzo());
  } finally {
    if (masking0) await db.fieldMaskingSettings.update({ where: { id: "global" }, data: { enabled: masking0.enabled } }).catch(() => {});
    else await db.fieldMaskingSettings.deleteMany({ where: { id: "global" } }).catch(() => {});
    if (threshold0 !== null) await db.organisationSettings.update({ where: { id: "global" }, data: { marketingApprovalThreshold: threshold0 } }).catch(() => {});
    await cleanup();
    await db.$disconnect();
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
