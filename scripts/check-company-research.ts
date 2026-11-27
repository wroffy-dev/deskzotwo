/**
 * check:company-research — research on a company from free public sources (owner, 18 Nov 2026; src/lib/research).
 *
 *   · Reading its website: About, Careers and Contact found on its own site only; the About page's prose; the year it was
 *     founded; phones; role addresses at its own domain and never a person's; its social pages.
 *   · GST: what a GSTIN's PAN says the holder is, and its state.
 *   · The news: the name without its legal form, the feed's items within a year, newest first, the source kept once.
 *   · The brief: what is sent is the public facts with their sources, nothing else; nothing to write from is said so.
 *   · Deskzo AI: the brief runs on the chat model until the console gives it one of its own, charged as itself.
 *   · Gathering through a stand-in network, and keeping it on a company made and removed here.
 *   · Where it runs: the company page's card, and once after a company is made.
 *
 *   npm run check:company-research
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  aboutFrom,
  foundedFrom,
  gstStateOf,
  headOf,
  newsFromRss,
  newsQueryFor,
  panHolderOf,
  phonesFrom,
  roleEmailsFrom,
  sitePagesFrom,
  websiteFactsFrom,
} from "../src/lib/research/parse";

// The card is rendered below with nobody signed in: its router does nothing, and nothing is revalidated.
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") return { useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }), usePathname: () => "/companies/x", useSearchParams: () => new URLSearchParams() };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

const HOME = `<html><head><title>Zz Acme Pipes | Line pipes</title><meta name="description" content="Zz Acme makes welded line pipes &amp; coatings."></head>
<body><nav><a href="/">Home</a></nav>
<a href="/about-us">About</a> <a href="https://zzacme.in/careers/">Join our team</a> <a href="/contact">Get in touch</a>
<a href="https://other.example/about">Their about</a>
<a href="https://www.linkedin.com/company/zz-acme">in</a> <a href="https://www.linkedin.com/shareArticle?x=1">share</a>
<p>Call <a href="tel:+91 22 6613 6000">+91 22 6613 6000</a></p>
<p>Write to sales@zzacme.in or ravi.kumar@zzacme.in or info@gmail.com</p></body></html>`;
const ABOUT = `<html><body><nav>Menu</nav><p>Cookie notice: we use cookies and JavaScript.</p>
<p>Zz Acme Pipes is one of India's leading makers of large-diameter welded line pipes for oil and gas. Established in 1995, it serves customers in 50 countries.</p>
<p>Short.</p><footer><p>All rights reserved 2026.</p></footer></body></html>`;
const RSS = `<rss><channel>
<item><title>Zz Acme wins pipe order - Business Standard</title><link>https://news.example/a</link><pubDate>Mon, 10 Nov 2026 08:00:00 GMT</pubDate><source url="x">Business Standard</source></item>
<item><title><![CDATA[Zz Acme plans a new plant - Mint]]></title><link>https://news.example/b</link><pubDate>Tue, 01 Sep 2026 08:00:00 GMT</pubDate><source url="y">Mint</source></item>
<item><title>Old story</title><link>https://news.example/c</link><pubDate>Tue, 01 Sep 2020 08:00:00 GMT</pubDate></item>
<item><title>Not https</title><link>http://news.example/d</link><pubDate>Tue, 01 Nov 2026 08:00:00 GMT</pubDate></item>
</channel></rss>`;

async function main() {
  const now = new Date("2026-11-18T10:00:00Z");

  section("Reading its website");
  const links = sitePagesFrom(HOME, "https://zzacme.in/");
  ok("About, Careers and Contact found on its own site, by the address or the link's words", links.about === "https://zzacme.in/about-us" && links.careers === "https://zzacme.in/careers/" && links.contact === "https://zzacme.in/contact", links);
  ok("  never another site's", !Object.values(links).some((u) => u?.includes("other.example")));
  const about = aboutFrom(ABOUT);
  ok("the About page's prose, without cookie notices, scraps or footers", !!about && about.startsWith("Zz Acme Pipes is one of India's leading") && !/cookie|rights reserved|Short\./i.test(about), about);
  ok("the year it was founded, when plausible", foundedFrom("Established in 1995, it serves") === 1995 && foundedFrom("incorporated in 2011") === 2011 && foundedFrom("founded in 2099", now) === null && foundedFrom("Call 1995 now") === null);
  ok("  never from \"since\" — when something else began (welspuncorp.com read as 2016)", foundedFrom("Since 2016 we have grown") === null);
  ok("  the earliest year said: a plant established later isn't the company's founding", foundedFrom("Our Saudi plant was established in 2016. Welspun Corp was incorporated in 1995.") === 1995);
  ok("About: paragraphs about the company before a product's promotion", aboutFrom("<p>Migrate from legacy mail to a powerful suite. Buy for ₹ 45000 + gst /year/licence today.</p><p>We are an IT reseller founded in 2017, serving businesses across India.</p>")?.startsWith("We are an IT reseller") === true);
  ok("phones it links or writes with a country code", phonesFrom(HOME).includes("+912266136000"), phonesFrom(HOME));
  ok("  a piece of an Indian number is none (+91 and ten digits, or nothing)", phonesFrom("<p>Call +91 6613 6000 or +91 98200 12345</p>").join() === "+919820012345", phonesFrom("<p>Call +91 6613 6000 or +91 98200 12345</p>"));
  ok("a description with an apostrophe is read whole", headOf(`<meta name="description" content="We're India's pipe maker.">`).description === "We're India's pipe maker.", headOf(`<meta name="description" content="We're India's pipe maker.">`));
  ok("role addresses at its own domain only — never a person's, never free mail", JSON.stringify(roleEmailsFrom(HOME, "zzacme.in")) === JSON.stringify(["sales@zzacme.in"]), roleEmailsFrom(HOME, "zzacme.in"));
  const site = websiteFactsFrom({ url: "https://zzacme.in/", home: HOME, pages: { about: ABOUT }, links, domain: "zzacme.in" });
  ok("all of it together: title, description (entities read), founded, its LinkedIn page and not a share button", site.title === "Zz Acme Pipes | Line pipes" && site.description === "Zz Acme makes welded line pipes & coatings." && site.founded === 1995 && site.social.linkedin === "https://www.linkedin.com/company/zz-acme", site);

  section("GST");
  ok("the PAN inside a GSTIN says what the holder is", panHolderOf("27AAACZ1234F1Z5") === "A company" && panHolderOf("07AAAFZ1234F1Z5") === "A firm or LLP" && panHolderOf("07AAAPZ1234F1Z5") === "An individual (proprietor)" && panHolderOf("bad") === null);
  ok("  and its first two digits the state", gstStateOf("27AAACZ1234F1Z5") === "Maharashtra" && gstStateOf("07AAACZ1234F1Z5") === "Delhi");

  section("The news");
  ok("searched by its name without the legal form, in quotes", newsQueryFor("Welspun Corp Limited") === '"Welspun Corp"' && newsQueryFor("Zz Acme Pvt. Ltd.") === '"Zz Acme"' && newsQueryFor("ABC (India) Private Limited") === '"ABC"', [newsQueryFor("Welspun Corp Limited"), newsQueryFor("Zz Acme Pvt. Ltd."), newsQueryFor("ABC (India) Private Limited")]);
  const items = newsFromRss(RSS, { now });
  ok("the last year's items, https only, newest first", items.length === 2 && items[0]!.url === "https://news.example/a" && items[1]!.url === "https://news.example/b", items);
  ok("  the source kept once, not in the title too (CDATA read)", items[0]!.title === "Zz Acme wins pipe order" && items[0]!.source === "Business Standard" && items[1]!.title === "Zz Acme plans a new plant");

  section("The brief");
  const brief = await import("../src/lib/research/brief");
  const input = {
    name: "Zz Acme Pipes Pvt Ltd",
    website: "https://zzacme.in",
    city: "Mumbai",
    facts: { website: site, gst: [{ gstin: "27AAACZ1234F1Z5", legalName: "ZZ ACME PIPES PRIVATE LIMITED", tradeName: null, status: "Active", taxpayerType: "Regular", state: "Maharashtra", panHolder: "A company", checkedAt: now.toISOString() }], news: items },
    domain: { emailProvider: "Microsoft 365", emailSecurityProvider: null, platform: "WordPress", hostProvider: "AWS", registeredOn: "2001-05-01T00:00:00.000Z" },
    apollo: { description: "Makes pipes.", industry: "industrial engineering", employees: 5300, founded: 1995, revenue: "1.8B" },
  };
  const prompt = brief.briefPrompt(input);
  ok("what is sent: the name, website and city, and each fact with its source", prompt.startsWith("Company: Zz Acme Pipes Pvt Ltd\nWebsite: https://zzacme.in\nCity on file: Mumbai") && ["[Website] About page:", "[GST] 27AAACZ1234F1Z5: legal name ZZ ACME PIPES PRIVATE LIMITED", "[Domain] Email runs on: Microsoft 365", "[Apollo] Employees: 5300", "[News] 2026-11-10 — Zz Acme wins pipe order (Business Standard)"].every((l) => prompt.includes(l)), prompt);
  ok("  role addresses and phones aren't sent — the brief has no use for them", !prompt.includes("sales@zzacme.in") && !prompt.includes("+912266136000"));
  ok("  the model is told: these facts only, every line its source, leave out what isn't there", /Use ONLY the facts given/.test(brief.BRIEF_SYSTEM) && /\[Website\], \[GST\], \[Domain\], \[Apollo\] or \[News\]/.test(brief.BRIEF_SYSTEM));
  ok("nothing beyond the name: nothing to write from", !brief.briefHasFacts({ name: "Zz Empty", website: null, city: null, facts: {} }) && brief.briefHasFacts(input));

  section("Deskzo AI");
  const catalogue = await import("../src/lib/ai/catalogue");
  const accounts = await import("../src/lib/ai/accounts");
  const feature = catalogue.AI_FEATURES.find((f) => f.key === "research.brief");
  ok("a feature of its own, saying what it sends — nothing of the dealings", !!feature && feature.fallback === "copilot.chat" && /Nothing of your dealings/.test(feature.sends));
  const chat = { feature: "copilot.chat" as const, model: { key: "zz-chat", label: "Zz Chat", providerModel: "zz", inputRate: 1, outputRate: 1, inputCost: null, outputCost: null }, account: { id: "a", name: "Zz", kind: "ANTHROPIC" as const, residency: "Zzland", noTraining: true }, connection: () => ({}) as never };
  accounts.setTestRoute((f) => (f === "copilot.chat" ? chat : null));
  const borrowed = await accounts.routeFor("research.brief");
  ok("  with no model of its own, it runs on the chat's — charged as itself", borrowed?.model.key === "zz-chat" && borrowed.feature === "research.brief", borrowed?.feature);
  const ownModel = { ...chat, feature: "research.brief" as const, model: { ...chat.model, key: "zz-own" } };
  accounts.setTestRoute((f) => (f === "research.brief" ? ownModel : f === "copilot.chat" ? chat : null));
  ok("  given one, its own", (await accounts.routeFor("research.brief"))?.model.key === "zz-own");
  accounts.setTestRoute(() => null);
  ok("  neither set up: not available", (await accounts.routeFor("research.brief")) === null);
  accounts.setTestRoute(null);

  section("Gathering, and keeping it");
  const gather = await import("../src/lib/research/gather");
  const pages: Record<string, string> = { "https://zzacme.in/": HOME, "https://zzacme.in/about-us": ABOUT, "https://zzacme.in/contact": "<p>Mail info@zzacme.in</p>" };
  const asked: string[] = [];
  gather.researchFetch.get = async (url: string) => {
    asked.push(url);
    if (url.startsWith("https://news.google.com/rss/search?q=")) return { url, status: 200, headers: new Headers({ "content-type": "application/rss+xml" }), body: RSS, bytes: Buffer.from(""), truncated: false };
    const body = pages[url];
    if (!body) throw new Error("no such page");
    return { url, status: 200, headers: new Headers({ "content-type": "text/html" }), body, bytes: Buffer.from(""), truncated: false };
  };
  const web = await gather.websiteResearch("https://www.zzacme.in/about");
  ok("its homepage, then its About and Contact pages — the contact page's address too", web.facts?.about?.startsWith("Zz Acme Pipes is one of") === true && web.facts?.emails.includes("info@zzacme.in") === true && web.error === null, web);
  ok("  a site that doesn't answer says so", (await gather.websiteResearch("https://zz-nowhere.example")).error === "zz-nowhere.example didn't answer, or doesn't let tools read it.");
  ok("  no website: says so, fetches nothing", (await gather.websiteResearch(null)).error === "No website on file.");
  const news = await gather.newsResearch("Zz Acme Pipes Pvt Ltd");
  ok("the news feed, asked for the name without its legal form", news.items.length === 2 && asked.some((u) => u.includes(encodeURIComponent('"Zz Acme Pipes"'))));

  const { db } = await import("../src/lib/db");
  const owner = await db.user.findFirst({ where: { active: true }, select: { id: true } });
  if (!owner) throw new Error("No user in the local database.");
  const run = Date.now().toString(36);
  const company = await db.company.create({ data: { name: `Zz Research ${run} Pvt Ltd`, normalizedName: `zz research ${run} pvt ltd`, website: "https://zzacme.in", createdById: owner.id }, select: { id: true, name: true, website: true } });
  try {
    await gather.refreshResearch(company, owner.id);
    const kept = await gather.researchOf(company.id);
    ok("refreshed and kept on the company: the website, a note that it has no GSTIN, the news", kept?.facts.website?.founded === 1995 && kept.facts.gstNote === "No GSTIN on its addresses." && kept.facts.news?.length === 2 && !!kept.refreshedAt, kept?.facts.gstNote);
    await db.companyResearch.update({ where: { companyId: company.id }, data: { brief: "Zz brief", briefAt: new Date() } });
    await gather.refreshResearch(company, owner.id);
    ok("  a later refresh keeps the brief already written", (await gather.researchOf(company.id))?.brief === "Zz brief");
  } finally {
    await db.company.delete({ where: { id: company.id } });
  }
  ok("  and goes with the company", (await gather.researchOf(company.id)) === null);

  section("Where it runs");
  const detail = readFileSync("src/components/companies/company-detail.tsx", "utf8");
  ok("the company page's Details: the card, null where the website is masked", detail.includes("researchCardData(company.id, userId)") && detail.includes("{research && <ResearchCard companyId={company.id} data={research} />}"));
  ok("  gathered once after a company is made with a website", /tenantAfter\(async \(\) => \{[\s\S]{0,200}refreshResearch\(made, createdBy\)/.test(readFileSync("src/actions/company.ts", "utf8")));
  const actions = readFileSync("src/actions/research.ts", "utf8");
  ok("  the brief takes “Use Deskzo AI” and Deskzo AI switched on; refreshing, only seeing the company", actions.includes('can(user.id, "copilot.use")') && actions.includes("(await copilotConfig()).enabled") && actions.includes("canSeeCompany(userId, company)"));
  ok("  a masked website: no research", actions.includes('visibility("website") !== "clear"') && readFileSync("src/lib/research/view.ts", "utf8").includes('masker.visibility("website") !== "clear"'));

  section("The card");
  const { ResearchCard } = await import("../src/components/companies/research-card");
  const cardData = {
    facts: { website: site, gst: input.facts.gst, news: items, newsError: null, websiteError: null, gstNote: null },
    refreshedAt: now.toISOString(),
    brief: "Who they are\n- Makes welded line pipes. [Website]",
    briefAt: now.toISOString(),
    domain: { ...input.domain, fetchedAt: now.toISOString() },
    apollo: { ...input.apollo, at: now.toISOString() },
    mayBrief: true,
  };
  const html = renderToStaticMarkup(createElement(ResearchCard, { companyId: "c1", data: cardData }));
  ok(
    "it shows the brief, then each source's findings with where they came from",
    ["Research", "Refresh", "Write again", "Makes welded line pipes. [Website]", "Written by Deskzo AI", "Zz Acme makes welded line pipes &amp; coatings.", "Has a careers page", "27AAACZ1234F1Z5", "A company", "Microsoft 365", "From Domain Intel", "5,300", "From Apollo", "Zz Acme wins pipe order", "Business Standard"].every((t) => html.includes(t)),
    ["Research", "Refresh", "Write again", "Written by Deskzo AI", "Has a careers page", "From Domain Intel", "From Apollo"].filter((t) => !html.includes(t)),
  );
  const plain = renderToStaticMarkup(createElement(ResearchCard, { companyId: "c1", data: { facts: {}, refreshedAt: null, brief: null, briefAt: null, domain: null, apollo: null, mayBrief: false } }));
  ok("  before anything is gathered: Gather, a word on what it reads, and no brief button without “Use Deskzo AI”", plain.includes(">Gather<") && plain.includes("Nothing gathered yet") && !plain.includes("Write a brief"));

  console.log(failures === 0 ? `\nAll ${passes} company research checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
