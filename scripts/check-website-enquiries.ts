/**
 * check:website-enquiries — a website's enquiry and the company it lands on (owner, 9 Nov 2026 —
 * src/lib/lead-capture/review.ts, domain-match.ts).
 *
 *   1. The rules: a work email's domain, a website's host.
 *   2. On the database, with a company, a key and enquiries of its own (ZZPROBE_ENQ, removed in a finally):
 *      held, nothing is made, the sender's work email suggests the company, the same one sent twice is one; accepted
 *      onto that company, as a new company named properly, or as an individual; dismissed, nothing; decided twice,
 *      refused; switched to "at once", the lead lands on the email's company, not the junk typed; the website's
 *      answer says which.
 *
 *   npm run check:website-enquiries
 */
import "dotenv/config";
import Module from "node:module";
import { hostOf, workDomain } from "../src/lib/lead-capture/domain-match";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && !pass ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};

const internals = Module as unknown as { _load(req: string, parent: unknown, isMain: boolean): unknown };
const original = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn };
  return original.call(this, request, parent, isMain);
} as typeof original;

const TAG = "ZZPROBE_ENQ";
const DOMAIN = "zzprobe-enq-acme.example";

async function main() {
  console.log("\n— 1. The rules —\n");
  ok("a work email's domain", workDomain("Priya@ZZ-Acme.co.in") === "zz-acme.co.in");
  ok("  free mail and nonsense point nowhere", [workDomain("a@gmail.com"), workDomain("a@yahoo.co.in"), workDomain("nonsense"), workDomain(null)].every((d) => d === null));
  ok("a website's host, however it's written", hostOf("https://www.Acme.co.in/about") === "acme.co.in" && hostOf("acme.co.in") === "acme.co.in" && hostOf("") === null);

  console.log("\n— 2. On the database —\n");
  const { db } = await import("../src/lib/db");
  const review = await import("../src/lib/lead-capture/review");
  const { intakeLead } = await import("../src/lib/lead-capture/intake");
  const admin = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: { id: true } });
  const before = await db.leadReviewSettings.findUnique({ where: { id: "default" } });
  const made = { companies: [] as string[], leads: [] as string[] };
  const key = await db.leadCaptureKey.create({ data: { name: `${TAG} site`, keyId: `lck_${TAG}_${Date.now()}`, secretDigest: "x", createdById: admin.id }, select: { id: true, name: true, createdById: true, sourceLabel: true } });
  try {
    const acme = await db.company.create({ data: { name: `${TAG} Acme Infotech`, normalizedName: `${TAG.toLowerCase()} acme infotech`, relationshipType: "CLIENT", website: `https://www.${DOMAIN}`, createdById: admin.id } as never, select: { id: true, name: true } });
    made.companies.push(acme.id);
    const junk = { name: "Priya Sharma", email: `priya@${DOMAIN}`, company: "Twentytwelve", phone: "+919811100001", message: "Need 20 laptops", external_id: `${TAG}-1` };

    await db.leadReviewSettings.upsert({ where: { id: "default" }, create: { id: "default", holdWebsite: true }, update: { holdWebsite: true } });
    ok("held once an admin chooses it", await review.holdsWebsiteEnquiries());
    const companiesBefore = await db.company.count();
    const held = await review.holdEnquiry(key, junk as never);
    ok("held: nothing made — no company, no lead", (await db.company.count()) === companiesBefore && (await db.lead.count({ where: { captureKeyId: key.id } })) === 0);
    const row = await db.websiteEnquiry.findUniqueOrThrow({ where: { id: held.id } });
    ok("  the sender's work email suggests the company on file", row.suggestedCompanyId === acme.id);
    const again = await review.holdEnquiry(key, junk as never);
    ok("  the same one sent twice is one", again.again && again.id === held.id);
    const listed = await review.listEnquiries("pending");
    ok("  listed waiting, with the suggestion", listed.some((r) => r.id === held.id && r.suggested?.id === acme.id));

    const accepted = await review.acceptEnquiry(held.id, { kind: "existing", companyId: acme.id }, admin.id);
    const lead = accepted.status === "created" ? await db.lead.findUniqueOrThrow({ where: { id: accepted.leadId }, select: { id: true, companyId: true } }) : null;
    if (lead) made.leads.push(lead.id);
    ok("accepted onto the company on file: a lead there, no 'Twentytwelve'", !!lead && lead.companyId === acme.id && !(await db.company.findFirst({ where: { name: "Twentytwelve" } })));
    const twice = await review.acceptEnquiry(held.id, { kind: "existing", companyId: acme.id }, admin.id).catch((e) => e);
    ok("  decided twice: refused", twice instanceof review.EnquiryRefused);

    const second = await review.holdEnquiry(key, { name: "Ravi Kumar", email: "ravi@gmail.com", company: "asdf", phone: "+919811100002", external_id: `${TAG}-2` } as never);
    const named = await review.acceptEnquiry(second.id, { kind: "new", name: `${TAG} Ravi Traders` }, admin.id);
    const ravi = named.status === "created" ? await db.lead.findUniqueOrThrow({ where: { id: named.leadId }, select: { id: true, company: { select: { id: true, name: true } } } }) : null;
    if (ravi) {
      made.leads.push(ravi.id);
      made.companies.push(ravi.company.id);
    }
    ok("accepted as a new company: named as given, not as typed", ravi?.company.name === `${TAG} Ravi Traders` && !(await db.company.findFirst({ where: { name: "asdf" } })));

    const third = await review.holdEnquiry(key, { name: `${TAG} Meena`, email: "meena@gmail.com", company: "Home", external_id: `${TAG}-3` } as never);
    const alone = await review.acceptEnquiry(third.id, { kind: "individual" }, admin.id);
    const meena = alone.status === "created" ? await db.lead.findUniqueOrThrow({ where: { id: alone.leadId }, select: { id: true, company: { select: { id: true, name: true } } } }) : null;
    if (meena) {
      made.leads.push(meena.id);
      made.companies.push(meena.company.id);
    }
    ok("accepted as an individual", meena?.company.name === `${TAG} Meena (individual)`);

    const fourth = await review.holdEnquiry(key, { name: "Bot", email: "bot@gmail.com", company: "xyz", external_id: `${TAG}-4` } as never);
    const companiesNow = await db.company.count();
    await review.dismissEnquiry(fourth.id, admin.id, "spam");
    ok("dismissed: nothing made", (await db.company.count()) === companiesNow && (await db.websiteEnquiry.findUniqueOrThrow({ where: { id: fourth.id } })).status === "DISMISSED");

    // Switched to "at once": the lead is made now, on the company the work email points at.
    await db.leadReviewSettings.update({ where: { id: "default" }, data: { holdWebsite: false } });
    const direct = await intakeLead(key, { name: "Arjun Mehta", email: `arjun@${DOMAIN}`, company: "Twentytwelve", phone: "+919811100005", external_id: `${TAG}-5` } as never);
    const arjun = direct.status === "created" ? await db.lead.findUniqueOrThrow({ where: { id: direct.leadId }, select: { id: true, companyId: true } }) : null;
    if (arjun) made.leads.push(arjun.id);
    ok("at once: the lead lands on the email's company, not on what was typed", arjun?.companyId === acme.id && !(await db.company.findFirst({ where: { name: "Twentytwelve" } })));

    // The website's answer, through the receiving code.
    const { receiveLead, readApiBody } = await import("../src/lib/lead-capture/receive");
    await db.leadReviewSettings.update({ where: { id: "default" }, data: { holdWebsite: true } });
    const fullKey = await db.leadCaptureKey.findUniqueOrThrow({ where: { id: key.id } });
    const answer = await receiveLead(new Request("http://x/api/v1/leads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Web Visitor", email: "v@gmail.com", company: "Twentytwelve", external_id: `${TAG}-6` }) }), fullKey, readApiBody);
    const body = (await answer.json()) as { held?: boolean; enquiry?: { reference?: string } };
    ok("the website is told it's received and held, with a reference", answer.status === 202 && body.held === true && /^ENQ-\d{6}$/.test(body.enquiry?.reference ?? ""));
  } finally {
    await db.websiteEnquiry.deleteMany({ where: { captureKeyId: key.id } });
    await db.lead.deleteMany({ where: { id: { in: made.leads } } });
    await db.lead.deleteMany({ where: { captureKeyId: key.id } });
    await db.contact.deleteMany({ where: { companyId: { in: made.companies } } });
    await db.company.deleteMany({ where: { id: { in: made.companies } } }).catch(() => undefined);
    await db.leadCaptureKey.delete({ where: { id: key.id } }).catch(() => undefined);
    if (before) await db.leadReviewSettings.update({ where: { id: "default" }, data: { holdWebsite: before.holdWebsite } });
    else await db.leadReviewSettings.deleteMany({ where: { id: "default" } });
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
