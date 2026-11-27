/**
 * check:lookalikes — Ved finding prospects like your best customers (owner, 22 Nov 2026; src/lib/prospects).
 *
 *   · The profile: industries, places, sizes and buyers' designations of the best customers, and Apollo's ids for them.
 *   · The search: only those filters go to Apollo — never a customer's name or a person's; free, recorded as a search;
 *     companies already in Deskzo marked.
 *   · Adding: a credit each (the person's Apollo allowance honoured), a company, its contact and a lead for whoever
 *     added it — never for a company already here (and no credit spent on it), never a contact twice.
 *
 * Nothing leaves: Apollo is a stand-in. Local workspace, its own records (Zz Look …).
 *
 *   npm run check:lookalikes
 */
import "dotenv/config";
import Module from "node:module";
import { randomUUID } from "node:crypto";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("no actor");
    return actor;
  },
  requireModuleUser: async () => {
    if (!actor) throw new Error("no actor");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
};
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") return { useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }), usePathname: () => "/leads/lookalikes", useSearchParams: () => new URLSearchParams(), notFound: () => { throw new Error("404"); }, redirect: () => { throw new Error("redirect"); } };
  if (request === "@/lib/session" || request.endsWith("/lib/session")) return { ...(originalLoad.call(this, request, parent, isMain) as Record<string, unknown>), ...session };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

// Apollo, as a stand-in: what each call asked, and an answer set by the case.
const calls: { path: string; query: string }[] = [];
let searchAnswer: unknown = { people: [], total_entries: 0 };
let matchAnswer: unknown = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== "api.apollo.io") return realFetch(input, init);
  calls.push({ path: url.pathname, query: decodeURIComponent(url.search.replaceAll("+", " ")) });
  const body = url.pathname.endsWith("/auth/health") ? { is_logged_in: true } : url.pathname.endsWith("/mixed_people/api_search") ? searchAnswer : url.pathname.endsWith("/people/match") ? matchAnswer : {};
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const profile = require("../src/lib/prospects/profile") as typeof import("../src/lib/prospects/profile");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("1. The profile, worked out");
  ok("sizes as Apollo takes them", profile.sizeRange(8) === "1,10" && profile.sizeRange(120) === "51,200" && profile.sizeRange(50_000) === "10001,1000000" && profile.sizeRange(null) === null && profile.sizeRange(0) === null);
  ok("a place is the state and country — the city where there's no state", profile.placeOf({ city: "Pune", state: "Maharashtra", country: null }, "India") === "Maharashtra, India" && profile.placeOf({ city: "Dubai", state: null, country: "United Arab Emirates" }, "India") === "Dubai, United Arab Emirates");
  const built = profile.buildProfile(
    [
      { id: "a", industry: "Banking", city: null, state: "Maharashtra", country: "India", employees: 120, buyers: ["IT manager", "IT manager", "CIO"], apolloId: "s1" },
      { id: "b", industry: "banking", city: null, state: "Maharashtra", country: "India", employees: 150, buyers: ["IT manager"], apolloId: null },
      { id: "c", industry: "Retail", city: "Delhi", state: null, country: null, employees: 3000, buyers: ["Other"], apolloId: "s2" },
    ],
    "India",
  );
  ok("industries and places counted, the same word in any case once", built.industries[0]?.value === "Banking" && built.industries[0]?.count === 2 && built.places[0]?.value === "Maharashtra, India" && built.places[0]?.count === 2 && built.places.some((p) => p.value === "Delhi, India"));
  ok("  a buyer once per company, and 'Other' left out", built.titles[0]?.value === "IT manager" && built.titles[0]?.count === 2 && !built.titles.some((t) => /other/i.test(t.value)));
  ok("  Apollo's ids for the customers it knows, as seeds", built.seeds.join() === "s1,s2" && built.basedOn === 3);
  const cleaned = profile.cleanFilters({ titles: [" CIO ", "CIO", 7], sizes: ["51,200", "1,99999"], places: "nope", useSeeds: "yes" });
  ok("filters from a browser: trimmed, once each, only Apollo's sizes, seeds only when true", cleaned.titles.join() === "CIO" && cleaned.sizes.join() === "51,200" && cleaned.places.length === 0 && cleaned.useSeeds === false);
  ok("  nothing to search by: no search", profile.searchQuery({ titles: [], places: [], sizes: [], industries: [], useSeeds: true }, [], 1) === null);
  ok("a title's designation type", profile.designationFromTitle("Chief Information Officer") === "CIO" && profile.designationFromTitle("Head of IT Infrastructure") === "IT_HEAD" && profile.designationFromTitle("Procurement Lead") === "PURCHASE_MANAGER" && profile.designationFromTitle("Founder & CEO") === "CEO" && profile.designationFromTitle("Chef") === "OTHER");

  process.env.DESKZO_TENANCY_FALLBACK ??= "legacy";
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const actions = require("../src/actions/prospects") as typeof import("../src/actions/prospects");
  const apollo = require("../src/lib/apollo/server") as typeof import("../src/lib/apollo/server");
  const prospectsServer = require("../src/lib/prospects/server") as typeof import("../src/lib/prospects/server");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const admin = await db.user.findFirst({ where: { active: true, isSuperAdmin: true }, select: { id: true, name: true, email: true, role: true } });
  if (!admin) throw new Error("no super admin");
  actor = { id: admin.id, name: admin.name, email: admin.email, role: admin.role };
  const t0 = new Date();
  const tag = randomUUID().slice(0, 6);
  const connectionBefore = await db.apolloConnection.findUnique({ where: { id: "default" } });
  const allowanceBefore = await db.enrichmentAllowance.findMany({ where: { provider: "APOLLO", userId: admin.id } });
  const industry = await db.industry.create({ data: { name: `Zz Look ${tag} Banking` }, select: { id: true, name: true } });
  const companyIds: string[] = [];
  const contactIds: string[] = [];

  try {
    section("2. The best customers, read");
    for (let i = 0; i < 3; i++) {
      const name = `Zz Look ${tag} Customer ${i} Pvt Ltd`;
      const c = await db.company.create({ data: { name, normalizedName: name.toLowerCase(), createdById: admin.id, ownerUserId: admin.id, industryId: industry.id, employeeCount: 120 + i }, select: { id: true } });
      companyIds.push(c.id);
      await db.companyLocation.create({ data: { companyId: c.id, label: "HO", isPrimary: true, state: `Zzstate ${tag}`, country: "India" } });
      const person = await db.contact.create({ data: { companyId: c.id, name: `Zz Buyer ${i}`, email: `buyer${i}.${tag}@zzlook.example.com`, designation: "IT_MANAGER", isPrimary: true, createdByUserId: admin.id }, select: { id: true } });
      contactIds.push(person.id);
      await db.lead.create({ data: { companyId: c.id, contactId: person.id, title: `Zz ${tag} won`, ownerUserId: admin.id, createdByUserId: admin.id, status: "WON", stageChangedAt: new Date() } });
      await db.customerStats.create({ data: { companyId: c.id, lifetimeValue: 900_000_000_000 - i, orders: 3 } });
    }
    await db.enrichmentLookup.create({ data: { kind: "COMPANY", provider: "APOLLO", companyId: companyIds[0]!, requestedById: admin.id, status: "DONE", externalId: `zzseed${tag}`, result: {}, completedAt: new Date() } });

    await apollo.removeApolloKey();
    const notConnected = await actions.getLookalikes();
    ok("Apollo not connected: the page says to connect it", notConnected?.connected === false);
    const saved = await apollo.saveApolloKey(`zzkey${tag}abcdef`, admin.id);
    ok("(Apollo connected with a stand-in key)", saved.ok);
    const page = await actions.getLookalikes();
    const p = page!.profile;
    // The local database has its own customers too: the top lists are checked for the industry, the rest on the rows read.
    const rows = (await prospectsServer.bestCustomers()).filter((r) => companyIds.includes(r.id));
    ok("the profile: their industry, place, size and buyers' designation", p.industries.some((x) => x.value === industry.name && x.count === 3) && rows.length === 3 && rows.every((r) => profile.placeOf(r, "India") === `Zzstate ${tag}, India` && profile.sizeRange(r.employees) === "51,200" && r.buyers.includes("IT manager")), rows);
    ok("  Apollo's id for the customer it looked up, as a seed — offered first", p.seeds.includes(`zzseed${tag}`) && page!.start.useSeeds);

    section("3. The search");
    const existingName = `Zz Look ${tag} Customer 1 Pvt Ltd`;
    searchAnswer = {
      total_entries: 2,
      people: [
        { id: `zzp1${tag}`, first_name: "Asha", last_name_obfuscated: "Ra***l", title: "IT Manager", has_email: true, has_direct_phone: "Yes", organization: { name: `Zz Look ${tag} Prospect Pvt Ltd` } },
        { id: `zzp2${tag}`, first_name: "Vikram", last_name_obfuscated: "Sh***a", title: "CIO", has_email: true, organization: { name: existingName } },
      ],
    };
    calls.length = 0;
    const filters = { titles: ["IT Manager"], places: [`Zzstate ${tag}, India`], sizes: ["51,200"], industries: [industry.name], useSeeds: true };
    const found = await actions.findLookalikes({ filters, page: 1 });
    const q = calls.find((c) => c.path.endsWith("/mixed_people/api_search"))?.query ?? "";
    ok("found: Apollo's people with their company's name", found.ok && found.data.rows.length === 2 && found.data.rows[0]!.organizationName === `Zz Look ${tag} Prospect Pvt Ltd`, found);
    ok("  a company already in Deskzo marked, not offered", found.ok && found.data.rows.find((r) => r.apolloId === `zzp2${tag}`)?.alreadyHere === true && found.data.rows.find((r) => r.apolloId === `zzp1${tag}`)?.alreadyHere === false);
    ok("  asked by the filters and the seed — industries in Apollo's lowercase", q.includes("person_titles[]=IT Manager") && q.includes(`organization_locations[]=Zzstate ${tag}, India`) && q.includes("organization_num_employees_ranges[]=51,200") && q.includes(`organization_industries[]=${industry.name.toLowerCase()}`) && q.includes(`lookalike_organization_ids[]=zzseed${tag}`), q);
    ok("  nothing of the customers or their people sent", !q.includes("Customer 0") && !q.includes("Zz Buyer") && !q.includes("zzlook.example.com"));
    ok("  free, and recorded as a search", (await db.enrichmentLookup.count({ where: { kind: "SEARCH", requestedById: admin.id, createdAt: { gte: t0 } } })) >= 1);

    section("4. Adding");
    matchAnswer = { person: { id: `zzp1${tag}`, first_name: "Asha", last_name: "Rawal", name: "Asha Rawal", title: "IT Manager", email: `asha.${tag}@zzprospect.example.com`, email_status: "verified", linkedin_url: "https://www.linkedin.com/in/zz-asha", organization: { id: "zzorg", name: `Zz Look ${tag} Prospect Pvt Ltd`, primary_domain: "zzprospect.example.com", website_url: "https://zzprospect.example.com" } } };
    calls.length = 0;
    const added = await actions.addLookalikes([
      { apolloId: `zzp1${tag}`, organizationName: `Zz Look ${tag} Prospect Pvt Ltd` },
      { apolloId: `zzp2${tag}`, organizationName: existingName },
    ]);
    const made = await db.company.findFirst({ where: { name: `Zz Look ${tag} Prospect Pvt Ltd` }, select: { id: true, website: true, contacts: { select: { id: true, email: true, designation: true, isPrimary: true } }, leads: { select: { ownerUserId: true, source: true, sourceDetail: true, contactId: true } } } });
    if (made) {
      companyIds.push(made.id);
      contactIds.push(...made.contacts.map((c) => c.id));
    }
    ok("added: a company with its website, the person as its primary contact", added.ok && added.data.added.length === 1 && made?.website === "https://zzprospect.example.com" && made.contacts[0]?.email === `asha.${tag}@zzprospect.example.com` && made.contacts[0]?.isPrimary === true && made.contacts[0]?.designation === "IT_MANAGER", added);
    ok("  and a lead for whoever added it, saying where it came from", made?.leads.length === 1 && made.leads[0]!.ownerUserId === admin.id && /lookalikes/.test(made.leads[0]!.sourceDetail ?? "") && made.leads[0]!.contactId === made.contacts[0]?.id);
    ok("  the company already here: skipped, and no credit spent on it", added.ok && added.data.skipped.some((s) => /in Deskzo already/.test(s.why)) && calls.filter((c) => c.path.endsWith("/people/match")).length === 1, added.ok ? added.data.skipped : added);
    ok("  the person revealed counted as an Apollo credit", (await db.enrichmentLookup.count({ where: { kind: "PERSON", requestedById: admin.id, externalId: `zzp1${tag}`, status: "DONE" } })) === 1);
    // The same person under a new company name: they're a contact already.
    matchAnswer = { person: { ...(matchAnswer as { person: Record<string, unknown> }).person, organization: { name: `Zz Look ${tag} Renamed Pvt Ltd` } } };
    const again = await actions.addLookalikes([{ apolloId: `zzp1${tag}`, organizationName: `Zz Look ${tag} Renamed Pvt Ltd` }]);
    ok("the same person again: skipped — a contact already", again.ok && again.data.added.length === 0 && /contact in Deskzo already/.test(again.data.skipped[0]?.why ?? ""), again);
    ok("eleven at once: refused", !(await actions.addLookalikes(Array.from({ length: 11 }, (_, i) => ({ apolloId: `zzmany${i}${tag}` })))).ok);

    section("5. The allowance");
    await db.enrichmentAllowance.upsert({ where: { provider_userId: { provider: "APOLLO", userId: admin.id } }, create: { provider: "APOLLO", userId: admin.id, monthlyCredits: 0, updatedById: admin.id }, update: { monthlyCredits: 0 } });
    calls.length = 0;
    const broke = await actions.addLookalikes([{ apolloId: `zzp3${tag}`, organizationName: `Zz Look ${tag} Third Pvt Ltd` }]);
    ok("no Apollo credits left for them: nothing revealed, saying why", broke.ok && broke.data.added.length === 0 && /no Apollo credits/.test(broke.data.skipped[0]?.why ?? "") && !calls.some((c) => c.path.endsWith("/people/match")), broke);

    section("6. The page");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { createElement } = require("react") as typeof import("react");
    const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
    const { Lookalikes } = require("../src/components/leads/lookalikes") as typeof import("../src/components/leads/lookalikes");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const html = renderToStaticMarkup(createElement(Lookalikes, { data: page! }));
    ok("the profile as chips to keep or drop, and the search button", html.includes("best customer") && html.includes(industry.name) && html.includes("Find people like them") && html.includes("Companies like your top"));
  } finally {
    const leadIds = (await db.lead.findMany({ where: { companyId: { in: companyIds } }, select: { id: true } })).map((l) => l.id);
    await db.auditLog.deleteMany({ where: { entityId: { in: [...leadIds, ...companyIds] } } }).catch(() => undefined);
    await db.activity.deleteMany({ where: { leadId: { in: leadIds } } }).catch(() => undefined);
    await db.lead.deleteMany({ where: { id: { in: leadIds } } }).catch(() => undefined);
    await db.enrichmentLookup.deleteMany({ where: { requestedById: admin.id, createdAt: { gte: t0 } } }).catch(() => undefined);
    await db.enrichmentAllowance.deleteMany({ where: { provider: "APOLLO", userId: admin.id } });
    for (const a of allowanceBefore) await db.enrichmentAllowance.create({ data: a });
    await db.notification.deleteMany({ where: { message: { contains: `Zz Look ${tag}` } } }).catch(() => undefined);
    await db.contact.deleteMany({ where: { companyId: { in: companyIds } } }).catch(() => undefined);
    await db.company.deleteMany({ where: { id: { in: companyIds } } }).catch(() => undefined);
    await db.industry.deleteMany({ where: { id: industry.id } }).catch(() => undefined);
    await db.apolloConnection.deleteMany({ where: { id: "default" } });
    if (connectionBefore) await db.apolloConnection.create({ data: connectionBefore });
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
