/**
 * check:lusha — Lusha enrichment (owner, 14 Nov 2026 — src/lib/lusha), against a fake Lusha: no credits spent.
 *
 *   1. Reading Lusha's answers: a company, a person (a work email first, a do-not-call phone marked), a prospecting page.
 *   2. On the database (ZZLUSHA, removed in a finally; the workspace's own Lusha key put back): a refused key isn't kept;
 *      an accepted one is, encrypted, with its credits; a company looked up and applied (by the same apply as Apollo's);
 *      a contact's blanks filled and a do-not-call number never written; a typed email kept; people searched; one added.
 *   3. Credits per person (owner, 15 Nov 2026 — src/lib/enrich/credits.ts): what each lookup costs; everybody's limit and
 *      a person's own over it; a lookup past the limit refused before Lusha is asked; "Fill from website" counted too.
 *      Measured against the person's own use this month, whatever the database already holds; limits put back.
 *
 *   npm run check:lusha
 */
import "dotenv/config";
import Module from "node:module";

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && !pass ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};

const TAG = "ZZLUSHA";
const DOMAIN = "zzlusha-acme.example";

function fakeLusha(answers: Record<string, { status?: number; body: unknown }>) {
  const asked: { path: string; body: unknown; key: string | null }[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    asked.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null, key: new Headers(init?.headers).get("api_key") });
    const a = answers[url.pathname] ?? { status: 404, body: { message: "not here" } };
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetcher, asked };
}

const COMPANY = { results: [{ id: "c1", name: "Acme", domain: `www.${DOMAIN}`, description: "Cloud.", yearFounded: 2010, employeeCount: { exact: 88, min: 51, max: 200 }, industry: "Technology", subIndustry: "Software Development", location: { city: "Dubai", country: "United Arab Emirates" }, socialLinks: { linkedin: "https://www.linkedin.com/company/zzacme" }, logoUrl: "https://logo/zz.png", phones: [{ number: "+971 4 555 0101" }] }] };
const PERSON = {
  results: [
    {
      id: "p1", firstName: "Priya", lastName: "Sharma", fullName: "Priya Sharma", jobTitle: { title: "IT Head" },
      emails: [{ email: "priya.home@gmail.com", type: "personal" }, { email: `priya@${DOMAIN}`, type: "work", confidence: "A+" }],
      phones: [{ number: "+971500000001", type: "mobile", doNotCall: true }, { number: "+97142220000", type: "direct", doNotCall: false }],
      socialLinks: { linkedin: "https://linkedin.com/in/zzpriya" },
    },
  ],
};
const DNC_ONLY = { results: [{ id: "p2", fullName: "Ravi Kumar", emails: [{ email: `ravi@${DOMAIN}`, type: "work" }], phones: [{ number: "+971500000002", type: "mobile", doNotCall: true }] }] };

async function main() {
  console.log("\n— 1. Reading Lusha —\n");
  const c = await import("../src/lib/lusha/client");
  const company = c.readLushaCompany(COMPANY);
  ok("a company: its sub-industry, employees, founded, LinkedIn, website from its domain, phone", company?.industry === "Software Development" && company.employees === 88 && company.foundedYear === 2010 && company.website === `https://${DOMAIN}` && company.phone === "+971 4 555 0101", company);
  const person = c.readLushaPerson(PERSON.results[0]);
  ok("a person: the work email first, title, LinkedIn", person?.email === `priya@${DOMAIN}` && person.title === "IT Head" && person.linkedinUrl === "https://linkedin.com/in/zzpriya", person);
  ok("  a do-not-call phone is left out of the usable ones, still marked", person?.phones.length === 1 && person.phones[0]!.number === "+97142220000" && person.phonesWithDnc.some((p) => p.doNotCall));
  const prospects = c.readLushaProspects({ pagination: { total: 3 }, results: [{ id: "x1", firstName: "Ravi", lastName: "Kumar", jobTitle: { title: "CFO" } }, { firstName: "no id" }] });
  ok("a prospecting page: id, name, title; one without an id dropped", prospects.people.length === 1 && prospects.people[0]!.title === "CFO" && prospects.total === 3, prospects);

  console.log("\n— 2. On the database —\n");
  const { db } = await import("../src/lib/db");
  const s = await import("../src/lib/lusha/server");
  const apollo = await import("../src/lib/apollo/server");
  const admin = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: { id: true } });
  const before = await db.enrichmentConnection.findUnique({ where: { provider: "LUSHA" } });
  const allowancesBefore = await db.enrichmentAllowance.findMany({ where: { provider: "LUSHA", userId: { in: [admin.id, "*"] } } });
  const startedAt = new Date();
  const made: string[] = [];
  try {
    const refused = fakeLusha({ "/v3/account/usage": { status: 401, body: { message: "Unauthorized" } } });
    const bad = await s.saveLushaKey("zz-bad-lusha-key-1", admin.id, refused.fetcher);
    ok("a key Lusha refuses isn't kept", !bad.ok && /didn't accept/.test(bad.ok ? "" : bad.error), bad);
    const good = fakeLusha({ "/v3/account/usage": { body: { credits: { remaining: 8500 } } } });
    const saved = await s.saveLushaKey("zz-good-lusha-key-1", admin.id, good.fetcher);
    ok("one it accepts is kept, with the credits left, tried in the api_key header", saved.ok && saved.creditsLeft === 8500 && good.asked[0]?.key === "zz-good-lusha-key-1", saved);
    const row = await db.enrichmentConnection.findUniqueOrThrow({ where: { provider: "LUSHA" } });
    ok("  encrypted, never as typed", !row.apiKeyEnc.includes("zz-good-lusha") && (await s.lushaKey()) === "zz-good-lusha-key-1");

    const acme = await db.company.create({ data: { name: `${TAG} Acme`, normalizedName: `${TAG.toLowerCase()} acme`, website: `https://${DOMAIN}`, createdById: admin.id } as never, select: { id: true } });
    made.push(acme.id);
    const priya = await db.contact.create({ data: { companyId: acme.id, name: "Priya Sharma" }, select: { id: true } });
    const ravi = await db.contact.create({ data: { companyId: acme.id, name: "Ravi Kumar", email: `ravi.typed@${DOMAIN}` }, select: { id: true } });

    const api = fakeLusha({ "/v3/companies/search-and-enrich": { body: COMPANY }, "/v3/contacts/search-and-enrich": { body: PERSON }, "/v3/contacts/prospecting": { body: { results: [{ id: "x1", firstName: "Ravi", lastName: "Kumar", jobTitle: { title: "CFO" } }] } }, "/v3/contacts/enrich": { body: DNC_ONLY } });
    const looked = await s.lushaLookUpCompany(acme.id, admin.id, api.fetcher);
    ok("a company looked up by its domain", looked.found?.employees === 88 && JSON.stringify(api.asked.find((a) => a.path === "/v3/companies/search-and-enrich")?.body).includes(DOMAIN), looked);
    const applied = await apollo.applyCompanyLookup(looked.lookupId, ["employeeCount", "industry"], admin.id);
    const after = await db.company.findUniqueOrThrow({ where: { id: acme.id }, select: { employeeCount: true, industry: { select: { name: true } } } });
    ok("  applied by the same apply as Apollo's", applied.ok && after.employeeCount === 88 && after.industry?.name === "Software Development", after);
    ok("  the latest lookup says it was Lusha's", (await apollo.latestCompanyLookup(acme.id))?.provider === "LUSHA");

    const filled = await s.lushaLookUpContact(priya.id, admin.id, { mobile: true }, api.fetcher);
    const priyaNow = await db.contact.findUniqueOrThrow({ where: { id: priya.id }, select: { email: true, phone: true, linkedinUrl: true } });
    ok("a contact's blanks filled: work email, LinkedIn, and the number not on a do-not-call list", priyaNow.email === `priya@${DOMAIN}` && priyaNow.linkedinUrl === "https://linkedin.com/in/zzpriya" && priyaNow.phone === "+97142220000" && filled.doNotCall, { priyaNow, filled });
    ok("  phones asked for by name and company domain", JSON.stringify(api.asked.find((a) => a.path === "/v3/contacts/search-and-enrich")?.body).includes('"reveal":["emails","phones"]'));
    const kept = await s.lushaLookUpContact(ravi.id, admin.id, { mobile: false }, api.fetcher);
    ok("a typed email is kept, Lusha's noted beside it", (await db.contact.findUniqueOrThrow({ where: { id: ravi.id }, select: { email: true } })).email === `ravi.typed@${DOMAIN}` && kept.kept.email === `priya@${DOMAIN}`, kept);

    const people = await s.lushaSearchPeople(acme.id, ["CFO"], admin.id, api.fetcher);
    ok("people at the company by title", people.people.length === 1 && JSON.stringify(api.asked.find((a) => a.path === "/v3/contacts/prospecting")?.body).includes('"jobTitles":["CFO"]'), people);
    const revealed = await s.lushaRevealPerson(acme.id, "p2", admin.id, { mobile: true }, api.fetcher);
    const someone = await db.contact.create({ data: { companyId: acme.id, name: "Ravi Kumar 2" }, select: { id: true } });
    const done = await s.fillContactFromLusha(someone.id, revealed.found, true);
    const someoneNow = await db.contact.findUniqueOrThrow({ where: { id: someone.id }, select: { phone: true, email: true } });
    ok("one found by id: email filled, its only number on do-not-call never written", someoneNow.email === `ravi@${DOMAIN}` && someoneNow.phone === null && done.doNotCall && done.mobile === "NONE", { someoneNow, done });
    ok("every lookup is on record as Lusha's", (await db.enrichmentLookup.count({ where: { companyId: acme.id, provider: "LUSHA" } })) >= 5);

    console.log("\n— 3. Credits per person —\n");
    const cr = await import("../src/lib/enrich/credits");
    const row3 = (provider: string, kind: string, status: string, result: unknown = {}) => ({ provider, kind, status, result });
    ok(
      "what a lookup costs: a company 1, a Lusha person 1 or 6 with phones, an Apollo mobile 8, an Apollo search 0, nothing found 0",
      cr.costOf(row3("LUSHA", "COMPANY", "DONE")) === 1 &&
        cr.costOf(row3("LUSHA", "PERSON", "DONE", { phonesWithDnc: [{ number: "1" }] })) === 6 &&
        cr.costOf(row3("LUSHA", "PERSON", "DONE", { phonesWithDnc: [] })) === 1 &&
        cr.costOf(row3("APOLLO", "MOBILE", "WAITING")) === 8 &&
        cr.costOf(row3("APOLLO", "SEARCH", "DONE")) === 0 &&
        cr.costOf(row3("LUSHA", "PERSON", "NOT_FOUND")) === 0,
    );
    await db.enrichmentAllowance.deleteMany({ where: { provider: "LUSHA", userId: { in: [admin.id, "*"] } } });
    ok("no limit set: no limit", (await cr.limitFor(admin.id, "LUSHA")) === null && (await cr.creditRefusal(admin.id, "LUSHA", 1000)) === null);
    const used = await cr.usedThisMonth(admin.id, "LUSHA");
    ok("this check's own lookups are counted (a company, two people with phones, a search)", used >= 1 + 6 + 6 + 1, used);
    await cr.setLimit("LUSHA", "*", used + 2, admin.id);
    ok("everybody's limit: 2 left lets a 1-credit lookup through", (await cr.creditRefusal(admin.id, "LUSHA", 1)) === null);
    const tooMuch = await cr.creditRefusal(admin.id, "LUSHA", 6);
    ok("  and refuses a 6-credit one, saying what's used and what's allowed", !!tooMuch && tooMuch.includes(`${used} of your ${used + 2}`), tooMuch);
    await cr.setLimit("LUSHA", admin.id, 0, admin.id);
    ok("a person's own limit wins over everybody's", (await cr.limitFor(admin.id, "LUSHA")) === 0 && /no Lusha credits/.test((await cr.creditRefusal(admin.id, "LUSHA", 1)) ?? ""));
    const asked = api.asked.length;
    const refusedLookup = await s.lushaLookUpCompany(acme.id, admin.id, api.fetcher);
    ok("  a lookup past it is refused before Lusha is asked", !refusedLookup.found && /credits/.test(refusedLookup.error ?? "") && api.asked.length === asked, refusedLookup);
    const view = await cr.creditsView("LUSHA", [{ id: admin.id, name: "Admin" }]);
    ok("Settings' table: everybody's limit, the person's own, their use", view.everybody === used + 2 && view.people[0]?.own === 0 && view.people[0]?.used === used, view);
    await cr.setLimit("LUSHA", admin.id, null, admin.id);
    ok("their own cleared: everybody's again", (await cr.limitFor(admin.id, "LUSHA")) === used + 2);
    const pv = await import("../src/lib/enrich/preview");
    const fromSite = await pv.previewByWebsite("LUSHA", `www.${DOMAIN}/about`, admin.id, api.fetcher);
    ok("Fill from website: found by the domain, before any company exists", fromSite.found?.employees === 88, fromSite);
    ok("  and counted against the person's credits", (await cr.usedThisMonth(admin.id, "LUSHA")) === used + 1);
    const past = await pv.previewByWebsite("LUSHA", DOMAIN, admin.id, api.fetcher);
    const third = await pv.previewByWebsite("LUSHA", DOMAIN, admin.id, api.fetcher);
    ok("  the next one fits exactly; the one after is refused", past.found !== null && /needs 1 Lusha credit, and you've used/.test(third.error ?? ""), { past: past.error, third: third.error, used: await cr.usedThisMonth(admin.id, "LUSHA") });
  } finally {
    await db.enrichmentLookup.deleteMany({ where: { provider: "LUSHA", companyId: null, requestedById: admin.id, createdAt: { gte: startedAt } } });
    await db.enrichmentAllowance.deleteMany({ where: { provider: "LUSHA", userId: { in: [admin.id, "*"] } } });
    for (const a of allowancesBefore) await db.enrichmentAllowance.create({ data: a });
    await db.enrichmentLookup.deleteMany({ where: { companyId: { in: made } } });
    await db.contact.deleteMany({ where: { companyId: { in: made } } });
    await db.company.deleteMany({ where: { id: { in: made } } }).catch(() => undefined);
    await db.enrichmentConnection.deleteMany({ where: { provider: "LUSHA" } });
    if (before) await db.enrichmentConnection.create({ data: before });
  }
}

main()
  .then(() => {
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
