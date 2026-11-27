/**
 * check:apollo — Apollo.io enrichment (owner, 14 Nov 2026 — src/lib/apollo), against a fake Apollo: no credits spent.
 *
 *   1. Reading Apollo's answers: a company, a person, a search, the mobiles webhook, the phone kept, a domain.
 *   2. On the database (ZZAPOLLO, removed in a finally; the workspace's own Apollo key put back):
 *      a key Apollo refuses isn't kept; one it accepts is, encrypted; a company looked up and applied field by field;
 *      a contact's blank email filled and a typed one kept; a mobile waiting, filled by the webhook once, and a stranger's
 *      number ignored; people at a company searched; the webhook's address refused without the secret.
 *
 *   npm run check:apollo
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

const TAG = "ZZAPOLLO";
const DOMAIN = "zzapollo-acme.example";

/** A fake Apollo: answers by path, and remembers what it was asked. */
function fakeApollo(answers: Record<string, { status?: number; body: unknown }>) {
  const asked: { path: string; params: URLSearchParams }[] = [];
  const fetcher = (async (input: string | URL) => {
    const url = new URL(String(input));
    asked.push({ path: url.pathname, params: url.searchParams });
    const a = answers[url.pathname] ?? { status: 404, body: { error: "not here" } };
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetcher, asked };
}

const COMPANY = {
  organization: {
    id: "org1", name: "Acme Infotech", website_url: `https://www.${DOMAIN}`, primary_domain: DOMAIN, linkedin_url: "https://www.linkedin.com/company/zzacme",
    twitter_url: "https://x.com/zzacme", facebook_url: "https://facebook.com/zzacme", estimated_num_employees: 140, industry: "information technology & services",
    founded_year: 2009, annual_revenue_printed: "12M", short_description: "Cloud and security.", logo_url: "https://logo.example/zz.png", primary_phone: { sanitized_number: "+971 4 555 0100" },
  },
};
const PERSON = { person: { id: "per1", name: "Priya Sharma", first_name: "Priya", last_name: "Sharma", title: "IT Head", email: `priya@${DOMAIN}`, email_status: "verified", linkedin_url: "https://linkedin.com/in/zzpriya" }, phone_enrichment: { status: "pending" } };

async function main() {
  console.log("\n— 1. Reading Apollo —\n");
  const c = await import("../src/lib/apollo/client");
  const company = c.readCompany(COMPANY);
  ok("a company: industry, employees, social links, phone, founded, revenue", company?.industry === "information technology & services" && company.employees === 140 && company.twitterUrl === "https://x.com/zzacme" && company.phone === "+971 4 555 0100" && company.foundedYear === 2009 && company.revenue === "12M", company);
  ok("  nothing back is null, not a crash", c.readCompany({}) === null && c.readCompany(null) === null);
  const person = c.readPerson(PERSON);
  ok("a person: name, title, email, LinkedIn, and a mobile still to come", person?.name === "Priya Sharma" && person.title === "IT Head" && person.email === `priya@${DOMAIN}` && person.phoneStatus === "pending", person);
  ok("  an email Apollo hasn't unlocked reads as none", c.readPerson({ person: { id: "x", email: "email_not_unlocked@domain.com" } })?.email === null);
  const search = c.readSearch({ total_entries: 2, people: [{ id: "s1", first_name: "Ravi", last_name_obfuscated: "K***r", title: "CFO", has_email: true, has_direct_phone: "Yes" }, { first_name: "no id" }] });
  ok("a search: first name, a hint of the last, title; one without an id dropped", search.people.length === 1 && search.people[0]!.lastNameHint === "K***r" && search.people[0]!.hasPhone && search.total === 2, search);
  const hook = c.readPhoneWebhook({ people: [{ id: "per1", phone_numbers: [{ sanitized_number: "+97150", type_cd: "work_direct" }, { sanitized_number: "+97155", type_cd: "mobile" }] }] });
  ok("the mobiles webhook, and the mobile kept over a direct line", hook.length === 1 && c.bestPhone(hook[0]!.phones)?.number === "+97155", hook);
  ok("a domain as Apollo wants it", c.apolloDomain("https://www.Acme.co.in/about") === "acme.co.in" && c.apolloDomain("priya@acme.co.in") === "acme.co.in" && c.apolloDomain("nonsense") === null);

  console.log("\n— 2. On the database —\n");
  const { db } = await import("../src/lib/db");
  const s = await import("../src/lib/apollo/server");
  const admin = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: { id: true } });
  const before = await db.apolloConnection.findUnique({ where: { id: "default" } });
  const made: { companies: string[] } = { companies: [] };
  try {
    const refused = fakeApollo({ "/v1/auth/health": { status: 401, body: { error: "Invalid access credentials." } } });
    const bad = await s.saveApolloKey("zz-bad-key-123456", admin.id, refused.fetcher);
    ok("a key Apollo refuses isn't kept, and says why", !bad.ok && /didn't accept/.test(bad.ok ? "" : bad.error), bad);
    const good = fakeApollo({ "/v1/auth/health": { body: { healthy: true, is_logged_in: true } } });
    ok("one it accepts is kept", (await s.saveApolloKey("zz-good-key-123456", admin.id, good.fetcher)).ok);
    const row = await db.apolloConnection.findUniqueOrThrow({ where: { id: "default" } });
    ok("  encrypted, never as typed", !row.apiKeyEnc.includes("zz-good-key") && (await s.apolloKey()) === "zz-good-key-123456");

    const acme = await db.company.create({ data: { name: `${TAG} Acme`, normalizedName: `${TAG.toLowerCase()} acme`, website: `https://${DOMAIN}`, createdById: admin.id } as never, select: { id: true } });
    made.companies.push(acme.id);
    const priya = await db.contact.create({ data: { companyId: acme.id, name: "Priya Sharma" }, select: { id: true } });
    const ravi = await db.contact.create({ data: { companyId: acme.id, name: "Ravi Kumar", email: `ravi.typed@${DOMAIN}` }, select: { id: true } });

    const api = fakeApollo({ "/api/v1/organizations/enrich": { body: COMPANY }, "/api/v1/people/match": { body: PERSON }, "/api/v1/mixed_people/api_search": { body: { total_entries: 1, people: [{ id: "s1", first_name: "Ravi", title: "CFO" }] } } });
    const looked = await s.lookUpCompany(acme.id, admin.id, api.fetcher);
    ok("a company looked up by its website's domain", looked.found?.employees === 140 && api.asked.some((a) => a.path === "/api/v1/organizations/enrich" && a.params.get("domain") === DOMAIN), looked);
    const applied = await s.applyCompanyLookup(looked.lookupId, ["employeeCount", "linkedinUrl", "industry"], admin.id);
    const after = await db.company.findUniqueOrThrow({ where: { id: acme.id }, select: { employeeCount: true, linkedinUrl: true, website: true, industry: { select: { name: true } } } });
    ok("  applied field by field: only what was ticked", applied.ok && after.employeeCount === 140 && after.linkedinUrl === "https://www.linkedin.com/company/zzacme" && after.industry?.name === "Information technology & services" && after.website === `https://${DOMAIN}`, after);
    ok("  the latest lookup is there for the page", (await s.latestCompanyLookup(acme.id))?.found.foundedYear === 2009);

    const filled = await s.lookUpContact(priya.id, admin.id, { mobile: true, origin: "https://zz.example" }, api.fetcher);
    const priyaNow = await db.contact.findUniqueOrThrow({ where: { id: priya.id }, select: { email: true, linkedinUrl: true, phone: true } });
    ok("a contact's blank email and LinkedIn filled", priyaNow.email === `priya@${DOMAIN}` && priyaNow.linkedinUrl === "https://linkedin.com/in/zzpriya" && filled.filled.includes("email"), filled);
    ok("  the mobile asked for with the workspace's webhook address", filled.mobile === "WAITING" && api.asked.some((a) => a.path === "/api/v1/people/match" && a.params.get("reveal_phone_number") === "true" && (a.params.get("webhook_url") ?? "").startsWith("https://zz.example/api/apollo/webhook/")));
    const kept = await s.lookUpContact(ravi.id, admin.id, { mobile: false, origin: "https://zz.example" }, api.fetcher);
    const raviNow = await db.contact.findUniqueOrThrow({ where: { id: ravi.id }, select: { email: true } });
    ok("a typed email is kept, Apollo's noted beside it", raviNow.email === `ravi.typed@${DOMAIN}` && kept.kept.email === `priya@${DOMAIN}`, kept);

    const got = await s.receiveMobiles([{ apolloId: "per1", phones: [{ number: "+971501234567", type: "mobile", status: "valid" }] }, { apolloId: "stranger", phones: [{ number: "+1", type: "mobile", status: null }] }]);
    const priyaPhone = (await db.contact.findUniqueOrThrow({ where: { id: priya.id }, select: { phone: true } })).phone;
    ok("the webhook's mobile fills the blank phone; a stranger's is ignored", priyaPhone === "+971501234567" && got.length === 1 && got[0]!.filled, got);
    ok("  delivered again, nothing changes", (await s.receiveMobiles([{ apolloId: "per1", phones: [{ number: "+971509999999", type: "mobile", status: null }] }])).length === 0 && (await db.contact.findUniqueOrThrow({ where: { id: priya.id }, select: { phone: true } })).phone === "+971501234567");

    const people = await s.searchCompanyPeople(acme.id, ["CFO", " "], admin.id, api.fetcher);
    ok("people at the company searched by title, for free", people.people.length === 1 && api.asked.some((a) => a.path === "/api/v1/mixed_people/api_search" && a.params.getAll("person_titles[]").join() === "CFO"), people);
    ok("every lookup is on record", (await db.enrichmentLookup.count({ where: { companyId: acme.id } })) >= 5);

    const { POST } = await import("../src/app/api/apollo/webhook/[token]/route");
    const wrong = await POST(new Request("http://x/api/apollo/webhook/zzzzzzzzzzzzzzzzzzzzzzzzzzzz", { method: "POST", body: "{}" }), { params: Promise.resolve({ token: "zzzzzzzzzzzzzzzzzzzzzzzzzzzz" }) });
    ok("the webhook refuses an address without the secret", wrong.status === 404);
  } finally {
    await db.enrichmentLookup.deleteMany({ where: { companyId: { in: made.companies } } });
    await db.contact.deleteMany({ where: { companyId: { in: made.companies } } });
    await db.company.deleteMany({ where: { id: { in: made.companies } } }).catch(() => undefined);
    await db.apolloConnection.deleteMany({ where: { id: "default" } });
    if (before) await db.apolloConnection.create({ data: before });
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
