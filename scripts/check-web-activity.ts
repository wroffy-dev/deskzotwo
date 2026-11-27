/**
 * check:web-activity — website activity, part of the Customer inbox's website chat (owner, 6 Nov 2026;
 * src/lib/inbox/activity.ts, activity-rules.ts): what's kept of a page, the kind of device and network, how a visitor
 * becomes known (a chat, a form, a campaign email), the journey, the alert on a key page, and the clean-up.
 * Also that the bubble's script stays quiet without agreement, by reading it; the browser test is by hand.
 *
 * The rules by hand-worked cases, then a fixture of its own in the local database, named ZZPROBE_WA and removed in
 * a finally.
 *
 *   npm run check:web-activity
 */
import "dotenv/config";
import Module from "node:module";
import { createHash } from "node:crypto";
import { db } from "../src/lib/db";
import { channelSettings, DEFAULT_ACTIVITY_NOTICE } from "../src/lib/inbox/settings";
import { WIDGET_SCRIPT } from "../src/lib/inbox/widget-script";
import { cleanPage, deviceKind, durationText, isBot, isKeyPage, journeyOf, keyPagePath, networkKind, onSiteNow, pageSeconds, referrerHost, screenSize, validVisitorId } from "../src/lib/inbox/activity-rules";

const TAG = "ZZPROBE_WA";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};

const internals = Module as unknown as { _load(req: string, parent: unknown, isMain: boolean): unknown };
const original = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn };
  return original.call(this, request, parent, isMain);
} as typeof original;

const CHROME_ANDROID = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";
const CHROME_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";
const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605 Version/17 Safari/605";

async function cleanup() {
  const channels = (await db.inboxChannel.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  await db.webVisitor.deleteMany({ where: { channelId: { in: channels } } });
  await db.conversation.deleteMany({ where: { channelId: { in: channels } } });
  await db.inboxChannel.deleteMany({ where: { id: { in: channels } } });
  await db.notification.deleteMany({ where: { type: "WEBSITE_VISIT", title: { contains: TAG } } });
  const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  await db.marketingMessage.deleteMany({ where: { companyId: { in: companies } } });
  await db.lead.deleteMany({ where: { companyId: { in: companies } } });
  await db.contact.deleteMany({ where: { companyId: { in: companies } } });
  await db.company.deleteMany({ where: { id: { in: companies } } });
  await db.user.deleteMany({ where: { email: { endsWith: "@zzprobe-wa.invalid" } } });
}

async function main() {
  console.log("\n— What's kept of a page —\n");
  const page = cleanPage("https://www.acme.com/pricing/?utm_source=google&utm_campaign=diwali&email=a@b.com&token=secret#top");
  ok("the site and path", page?.host === "www.acme.com" && page.path === "/pricing/");
  ok("the campaign tags", page?.utmSource === "google" && page.utmCampaign === "diwali");
  ok("the rest of the query string is gone", !JSON.stringify(page).includes("secret") && !JSON.stringify(page).includes("a@b.com"));
  ok("an address in the path is hidden", cleanPage("https://acme.com/users/a@b.com/edit")?.path === "/users/…/edit");
  ok("only web addresses", cleanPage("javascript:alert(1)") === null && cleanPage("nonsense") === null);
  ok("the site that sent them; not itself", referrerHost("https://www.google.com/search?q=x", "acme.com") === "google.com" && referrerHost("https://www.acme.com/a", "acme.com") === null);

  console.log("\n— Device, network, ids —\n");
  ok("a phone, a tablet, a computer", deviceKind(CHROME_ANDROID, 5) === "phone" && deviceKind("Mozilla/5.0 (Linux; Android 14) Chrome/120 Safari/537.36", 5) === "tablet" && deviceKind(CHROME_WINDOWS, 0) === "computer");
  ok("an iPad calling itself a Mac is a tablet; a Mac isn't", deviceKind(IPAD, 5) === "tablet" && deviceKind(IPAD, 0) === "computer");
  ok("the browser's word for mobile data wins", networkKind("Some Company Ltd", "cellular") === "mobile");
  ok("a carrier can't be told apart", networkKind("Reliance Jio Infocomm Limited", "wifi") === "carrier" && networkKind("Bharti Airtel Limited", null) === "carrier");
  ok("home broadband", networkKind("Atria Convergence Technologies Ltd.", null) === "broadband");
  ok("a server or VPN", networkKind("Amazon.com, Inc.", null) === "hosting" && networkKind("Microsoft Corporation", null) === "hosting");
  ok("an owner who is no telecom: a company's own line", networkKind("Infosys Limited", null) === "company");
  ok("nothing known, nothing said", networkKind(null, null) === null);
  ok("crawlers aren't visitors", isBot("Googlebot/2.1") && isBot("WhatsApp/2.23") && !isBot(CHROME_WINDOWS));
  ok("a browser's id: long and plain", validVisitorId("a".repeat(36)) === "a".repeat(36) && validVisitorId("short") === null && validVisitorId("x'; drop table--aaaaaaaaaaaa") === null && validVisitorId(5) === null);
  ok("a screen", screenSize("1920x1080") === "1920×1080" && screenSize("<b>") === null);
  ok("seconds on a page: whole, within reason", pageSeconds(12.4) === 12 && pageSeconds(999999) === 7200 && pageSeconds(-1) === null && pageSeconds("x") === null);
  ok("durations in words", durationText(45) === "45 s" && durationText(180) === "3 min" && durationText(4800) === "1 h 20 min" && durationText(null) === null);
  ok("key pages: that page and under it, any case", isKeyPage("/Pricing/", ["/pricing"]) && isKeyPage("/pricing/teams", ["/pricing"]) && !isKeyPage("/pricing-old", ["/pricing"]));
  ok("a key page as written", keyPagePath("/demo/") === "/demo" && keyPagePath("demo") === null && keyPagePath("/a b") === null);
  const journey = journeyOf([
    { visitNo: 1, at: "2026-11-01T10:00:00Z", path: "/" },
    { visitNo: 2, at: "2026-11-02T10:05:00Z", path: "/b" },
    { visitNo: 2, at: "2026-11-02T10:00:00Z", path: "/a" },
  ]);
  ok("the journey: newest visit first, its pages in order", journey[0]!.visitNo === 2 && journey[0]!.views[0]!.path === "/a" && journey[1]!.visitNo === 1);

  console.log("\n— Settings and the script —\n");
  const off = channelSettings({}, "WEB");
  ok("off until switched on, asking in the bubble", off.activity.on === false && off.activity.consent === "notice" && off.activity.notice === DEFAULT_ACTIVITY_NOTICE);
  const on = channelSettings({ activity: { on: true, consent: "site", keyPages: ["/demo/", "bad", "/demo"], notice: "  " } }, "WEB");
  ok("saved settings are read safely", on.activity.on && on.activity.consent === "site" && JSON.stringify(on.activity.keyPages) === JSON.stringify(["/demo"]) && on.activity.notice === DEFAULT_ACTIVITY_NOTICE);
  ok("the notice names what's kept", /IP address/.test(DEFAULT_ACTIVITY_NOTICE) && /location/.test(DEFAULT_ACTIVITY_NOTICE));
  let parsed = true;
  try {
    new Function(WIDGET_SCRIPT);
  } catch {
    parsed = false;
  }
  ok("the script parses", parsed);
  ok("nothing reports until agreed: only startReporting makes an id", (WIDGET_SCRIPT.match(/newVisitorId\(\)/g) ?? []).length === 2 && /answered === "yes"\) startReporting\(\)/.test(WIDGET_SCRIPT));
  ok("the script uses no cookie", !/document\.cookie/.test(WIDGET_SCRIPT));

  const { recordView, recordLeave, linkVisitorToConversation, linkVisitorToContact, activityOfLead, recentVisitors, sweepWebActivity, ispOf, siteReportsActivity, visitLinkParam, forgetVisitor, pingVisitor, visitorDetail, activityOfConversation } = await import("../src/lib/inbox/activity");
  const { refreshLeadScore } = await import("../src/lib/leads/score-store");
  const { mayReadWebReport, webActivityReport, attribute, sourceLabel } = await import("../src/lib/inbox/activity-report");
  const { triggerPaths } = await import("../src/lib/automate/triggers");
  const { can } = await import("../src/lib/authz/resolve");

  console.log("\n— Counting wins —\n");
  const day = (n: number) => new Date(Date.UTC(2026, 9, n));
  const counted = attribute({
    sources: [{ label: "diwali", visitors: 10, known: 2 }, { label: "Direct", visitors: 5, known: 1 }],
    pages: [{ label: "a.zz/pricing", visitors: 8, known: 2 }, { label: "a.zz/blog", visitors: 9, known: 2 }],
    visitors: [
      { contactId: "c1", source: "diwali", firstSeenAt: day(1) },
      { contactId: "c1", source: "diwali", firstSeenAt: day(2) },
      { contactId: "c2", source: "Direct", firstSeenAt: day(20) },
    ],
    views: [
      { host: "a.zz", path: "/pricing", contactId: "c1", at: day(5) },
      { host: "a.zz", path: "/pricing", contactId: "c1", at: day(6) },
      { host: "a.zz", path: "/blog", contactId: "c1", at: day(25) },
      { host: "a.zz", path: "/pricing", contactId: "c2", at: day(21) },
    ],
    newLeads: [{ id: "n1", contactId: "c1", createdAt: day(3) }, { id: "n2", contactId: "c2", createdAt: day(10) }],
    won: [{ id: "w1", contactId: "c1", value: 1000, wonAt: day(10) }, { id: "w2", contactId: "c2", value: 500, wonAt: day(15) }],
  });
  const line = (rows: { label: string }[], label: string) => rows.find((r) => r.label === label) as { leads: number; won: number; wonValue: number } | undefined;
  ok("a win counts once for its campaign, however many browsers", line(counted.sources, "diwali")?.won === 1 && line(counted.sources, "diwali")?.wonValue === 1000);
  ok("a win counts once for a page, however many views", line(counted.pages, "a.zz/pricing")?.won === 1);
  ok("a page opened after the win doesn't get it", line(counted.pages, "a.zz/blog")?.won === 0);
  ok("a campaign that came after the win doesn't get it", line(counted.sources, "Direct")?.won === 0 && line(counted.sources, "Direct")?.wonValue === 0);
  ok("nor after the lead was made", line(counted.sources, "Direct")?.leads === 0 && line(counted.sources, "diwali")?.leads === 1);
  ok("the most valuable first", counted.pages[0]!.label === "a.zz/pricing");
  ok("a campaign's name, its source, or Direct", sourceLabel("diwali", "google") === "diwali" && sourceLabel(null, "google") === "google" && sourceLabel(" ", null) === "Direct");

  const { runAsTenant } = await import("../src/lib/tenancy/resolve");
  const { legacyTenant } = await import("../src/lib/tenancy/registry");

  console.log("\n— The network file, on this server —\n");
  ok("a public address has an owner", /google/i.test(ispOf("8.8.8.8") ?? ""), ispOf("8.8.8.8") ?? "");
  ok("nothing for a private address, or none", ispOf("10.0.0.1") === null && ispOf(null) === null && ispOf("not an ip") === null);

  await cleanup();
  try {
    const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
    if (!admin) throw new Error("no super admin");
    const owner = await db.user.create({ data: { name: "Zz Owner", email: "owner@zzprobe-wa.invalid", role: "SALES", passwordHash: "!" }, select: { id: true } });
    const channel = await db.inboxChannel.create({ data: { kind: "WEB", name: `${TAG} site` }, select: { id: true } });
    const other = await db.inboxChannel.create({ data: { kind: "WEB", name: `${TAG} other` }, select: { id: true } });
    const company = await db.company.create({ data: { name: `${TAG} Jasper`, normalizedName: `${TAG.toLowerCase()} jasper`, createdById: admin.id, ownerUserId: owner.id }, select: { id: true } });
    const contact = await db.contact.create({ data: { companyId: company.id, name: `${TAG} Asha`, email: "asha@zzprobe-wa.invalid" }, select: { id: true } });
    const lead = await db.lead.create({ data: { title: `${TAG} deal`, companyId: company.id, contactId: contact.id, ownerUserId: owner.id }, select: { id: true } });

    const headers = (ua: string, extra: Record<string, string> = {}) => new Headers({ "user-agent": ua, "cf-ipcountry": "IN", "cf-ipcity": "Gurugram", "cf-region": "Haryana", ...extra });
    const vid = "v".repeat(20) + TAG.toLowerCase().replace(/[^a-z]/g, "");
    const base = { visitorId: vid, title: "Pricing", referrer: "https://www.google.com/", fromEmail: null, screen: "390x844", touchPoints: 5, connection: "cellular", language: "en-IN", timezone: "Asia/Kolkata", ip: "8.8.8.8", headers: headers(CHROME_ANDROID) };

    console.log("\n— Recording —\n");
    ok("a crawler isn't recorded", (await recordView(channel.id, { ...base, headers: headers("Googlebot/2.1") , page: "https://acme.zz/" }, [])) === false);
    ok("a made-up id isn't", (await recordView(channel.id, { ...base, visitorId: "x", page: "https://acme.zz/" }, [])) === false);
    ok("the first page is", (await recordView(channel.id, { ...base, page: "https://acme.zz/?utm_source=google&utm_campaign=diwali" }, ["/pricing"])) === true);
    const hash = createHash("sha256").update(vid).digest("hex");
    const v1 = await db.webVisitor.findUnique({ where: { tokenHash: hash } });
    ok("the browser's id itself isn't stored", !!v1 && v1.tokenHash !== vid);
    ok("where and how they were seen", v1?.city === "Gurugram" && v1.region === "Haryana" && v1.country === "IN" && v1.ipAddress === "8.8.8.8" && /google/i.test(v1.isp ?? "") && v1.networkKind === "mobile", v1);
    ok("the device", v1?.deviceKind === "phone" && v1.browser === "Chrome on Android" && v1.screen === "390×844" && v1.language === "en-IN" && v1.timezone === "Asia/Kolkata", v1);
    ok("where they first came from", v1?.firstSource === "google" && v1.firstCampaign === "diwali");
    ok("another channel can't add to this visitor", (await recordView(other.id, { ...base, page: "https://acme.zz/x" }, [])) === false);
    await recordLeave(channel.id, { visitorId: vid, page: "https://acme.zz/", seconds: 42 });
    ok("how long they stayed", (await db.webPageView.findFirst({ where: { visitorId: v1!.id, path: "/" } }))?.durationSec === 42);

    // Half an hour on, from the office.
    await db.webVisitor.update({ where: { id: v1!.id }, data: { lastSeenAt: new Date(Date.now() - 31 * 60_000) } });
    await recordView(channel.id, { ...base, page: "https://acme.zz/about", connection: "wifi", ip: "1.1.1.1", headers: headers(CHROME_ANDROID, { "cf-ipcity": "Delhi" }) }, ["/pricing"]);
    const v2 = await db.webVisitor.findUnique({ where: { id: v1!.id } });
    ok("half an hour later is a new visit", v2?.visits === 2 && v2.pageCount === 2);
    ok("each page keeps where it was opened from", (await db.webPageView.findFirst({ where: { visitorId: v1!.id, path: "/about" } }))?.city === "Delhi" && (await db.webPageView.findFirst({ where: { visitorId: v1!.id, path: "/" } }))?.city === "Gurugram");
    ok("a site reporting activity is known; another isn't", (await siteReportsActivity("acme.zz")) && !(await siteReportsActivity("somebody-else.zz")));

    console.log("\n— Becoming known —\n");
    ok("anonymous so far: no alert on a key page", (await recordView(channel.id, { ...base, page: "https://acme.zz/pricing" }, ["/pricing"])) && (await db.notification.count({ where: { userId: owner.id, type: "WEBSITE_VISIT" } })) === 0);
    ok("…and not on a lead", (await activityOfLead({ id: lead.id, contactId: contact.id })) === null);
    await linkVisitorToContact(vid, contact.id, "form");
    const named = await activityOfLead({ id: lead.id, contactId: contact.id });
    ok("a form sends the id: their earlier visits are on the lead", named?.visits === 2 && named.journey.length === 2 && named.journey[0]!.views.some((x) => x.path === "/pricing"), named?.journey.length);
    ok("known, on a key page: whoever has the lead is told", (await recordView(channel.id, { ...base, page: "https://acme.zz/pricing/teams" }, ["/pricing"])) && (await db.notification.count({ where: { userId: owner.id, type: "WEBSITE_VISIT" } })) === 1);
    await recordView(channel.id, { ...base, page: "https://acme.zz/pricing" }, ["/pricing"]);
    ok("…once in half a day, however many pages", (await db.notification.count({ where: { userId: owner.id, type: "WEBSITE_VISIT" } })) === 1);
    await recordView(channel.id, { ...base, page: "https://acme.zz/careers" }, ["/pricing"]);

    // A chat in another browser: the conversation says who it is, whenever it's linked.
    const vid2 = "w".repeat(24);
    await recordView(channel.id, { ...base, visitorId: vid2, page: "https://acme.zz/" }, []);
    const token = "chat-token-" + TAG;
    await db.conversation.create({ data: { channelId: channel.id, kind: "WEB", visitorTokenHash: createHash("sha256").update(token).digest("hex") } });
    await linkVisitorToConversation(vid2, token);
    ok("a chat before anybody knows who it is: still anonymous", (await activityOfLead({ id: lead.id, contactId: contact.id }))?.visitors.length === 1);
    await db.conversation.updateMany({ where: { channelId: channel.id }, data: { contactId: contact.id, companyId: company.id } });
    ok("the conversation linked to the contact: that browser is theirs too, with nothing else to do", (await activityOfLead({ id: lead.id, contactId: contact.id }))?.visitors.length === 2);

    console.log("\n— A campaign email's link —\n");
    const home = await legacyTenant();
    if (!home) throw new Error("no workspace to act as");
    await runAsTenant(home, async () => {
      const message = await db.marketingMessage.create({ data: { token: `${TAG}-token`, companyId: company.id, contactId: contact.id, channel: "EMAIL", messageClass: "MARKETING", body: "x", scheduledFor: new Date() }, select: { id: true } });
      const param = await visitLinkParam(message.id);
      ok("the link carries the message and a signature, never its token", param.startsWith(`${message.id}.`) && !param.includes(`${TAG}-token`));
      const clicked = "c".repeat(24);
      await recordView(channel.id, { ...base, visitorId: clicked, fromEmail: param, page: "https://acme.zz/offer" }, []);
      const fromClick = await db.webVisitor.findUnique({ where: { tokenHash: createHash("sha256").update(clicked).digest("hex") } });
      ok("clicking it says who this is", fromClick?.contactId === contact.id && fromClick.identifiedBy === "email", fromClick?.contactId ?? "");
      const forged = "d".repeat(24);
      await recordView(channel.id, { ...base, visitorId: forged, fromEmail: `${message.id}.${"0".repeat(32)}`, page: "https://acme.zz/offer" }, []);
      ok("a forged one says nothing", (await db.webVisitor.findUnique({ where: { tokenHash: createHash("sha256").update(forged).digest("hex") } }))?.contactId === null);
    });

    console.log("\n— Changing their mind —\n");
    const leaving = "e".repeat(24);
    await recordView(channel.id, { ...base, visitorId: leaving, page: "https://acme.zz/" }, []);
    const leavingHash = createHash("sha256").update(leaving).digest("hex");
    await forgetVisitor(other.id, leaving);
    ok("another channel can't erase them", (await db.webVisitor.count({ where: { tokenHash: leavingHash } })) === 1);
    await forgetVisitor(channel.id, leaving);
    ok("saying no afterwards takes back everything kept", (await db.webVisitor.count({ where: { tokenHash: leavingHash } })) === 0);

    console.log("\n— Phase 2: the score, the trigger, who sees whom —\n");
    const scoreOf = async () => {
      const s = await refreshLeadScore(lead.id);
      return { score: s?.score ?? 0, labels: (s?.factors ?? []).map((x) => x.label) };
    };
    const warmed = await scoreOf();
    ok("visits and a key page count on the lead's score, and say so", warmed.labels.some((l) => /Opened \/pricing.* on the website/.test(l)) && warmed.labels.some((l) => /visits? to the website/.test(l)), warmed.labels);
    await db.webVisitor.updateMany({ where: { OR: [{ contactId: contact.id }, { conversation: { contactId: contact.id } }] }, data: { contactId: null, conversationId: null } });
    const cold = await scoreOf();
    ok("…and an anonymous visit doesn't", cold.score < warmed.score && !cold.labels.some((l) => /website/.test(l) && !/Came in/.test(l)), cold.labels);
    await linkVisitorToContact(vid, contact.id, "form");
    const events = () => db.automationEvent.findMany({ where: { type: "website.key_page", recordId: lead.id }, select: { payload: true, recordType: true } });
    const firedBefore = (await events()).length;
    await db.webVisitor.updateMany({ where: { contactId: contact.id }, data: { lastAlertAt: null } });
    await recordView(channel.id, { ...base, page: "https://acme.zz/pricing", title: "Pricing" }, ["/pricing"]);
    const fired = await events();
    ok("a known visitor on a key page starts workflows", fired.length === firedBefore + 1 && fired.at(-1)?.recordType === "lead", fired.length);
    const said = JSON.stringify(fired.at(-1)?.payload ?? {});
    ok("…with the page, the lead and the contact", said.includes('"path":"/pricing"') && said.includes(lead.id));
    ok("…never the IP address or ISP: a workflow can pass on what it reads", !said.includes("1.1.1.1") && !said.includes("8.8.8.8") && !/isp|ipAddress/i.test(said));
    await recordView(channel.id, { ...base, page: "https://acme.zz/pricing" }, ["/pricing"]);
    ok("…at most twice a day for one visitor", (await events()).length === firedBefore + 1);
    ok("the trigger offers the visit's fields", triggerPaths("website.key_page").some((p) => p.ref === "trigger.visit.path") && !triggerPaths("website.key_page").some((p) => /^(ip|isp|ipAddress)$/i.test(p.ref.split(".").pop() ?? "")));

    // Somebody with their own accounts only: not another account's visitor.
    const stranger = await db.user.create({ data: { name: "Zz Rep", email: "rep@zzprobe-wa.invalid", role: "SALES", passwordHash: "!" }, select: { id: true } });
    await db.userAccessLevel.create({ data: { userId: stranger.id, record: "contacts", action: "view", level: "OWN" } }).catch(() => null);
    await db.userPermission.create({ data: { userId: stranger.id, permission: "companies.viewAll", allowed: false, reason: "check:web-activity" } }).catch(() => null);
    const theirs = await recentVisitors({ viewerId: stranger.id, seesEveryChat: false, knownOnly: true, take: 500 });
    ok("a rep doesn't see a known visitor from an account that isn't theirs", !theirs.visitors.some((x) => x.contact?.id === contact.id), theirs.visitors.length);
    const mine = await recentVisitors({ viewerId: owner.id, seesEveryChat: false, knownOnly: true, take: 500 });
    ok("the account's owner does", mine.visitors.some((x) => x.contact?.id === contact.id), mine.visitors.length);
    await db.userPermission.deleteMany({ where: { userId: stranger.id } });
    await db.userAccessLevel.deleteMany({ where: { userId: stranger.id } }).catch(() => null);
    ok("the wins report isn't for just anybody who sees activity", !(await mayReadWebReport(stranger.id)) || (await can(stranger.id, "marketing.viewAll")) || (await can(stranger.id, "activity.viewAll")));

    await db.lead.update({ where: { id: lead.id }, data: { status: "WON", estimatedValue: 50000, stageChangedAt: new Date() } });
    const report = await webActivityReport(30);
    ok("the report: the win is on the pages they saw", report.pages.some((p) => p.label === "acme.zz/pricing" && p.won >= 1 && p.wonValue >= 50000), report.pages.slice(0, 3));
    ok("…and on the campaign that first brought them", report.sources.some((r) => r.label === "diwali" && r.won >= 1 && r.wonValue >= 50000), report.sources.slice(0, 3));
    await db.lead.update({ where: { id: lead.id }, data: { status: "NEW", stageChangedAt: new Date() } });

    console.log("\n— Starting a chat from the Visitors tab —\n");
    const { staffStartVisitorChat } = await import("../src/lib/inbox/server");
    const agent = { id: owner.id, viewAll: true };
    await db.inboxChannel.update({ where: { id: channel.id }, data: { settings: { activity: { on: true } } } });
    await runAsTenant(home, async () => {
      const browsing = "f".repeat(24);
      await recordView(channel.id, { ...base, visitorId: browsing, page: "https://acme.zz/" }, []);
      const row = await db.webVisitor.findUnique({ where: { tokenHash: createHash("sha256").update(browsing).digest("hex") } });
      ok("a ping with nothing waiting says nothing", (await pingVisitor(channel.id, browsing)) === null);
      ok("nor to another channel, or a made-up id", (await pingVisitor(other.id, browsing)) === null && (await pingVisitor(channel.id, "x")) === null);

      await db.webVisitor.update({ where: { id: row!.id }, data: { lastSeenAt: new Date(Date.now() - 90_000) } });
      await pingVisitor(channel.id, browsing);
      ok("a ping keeps them on the site", onSiteNow((await db.webVisitor.findUnique({ where: { id: row!.id } }))!.lastSeenAt) && Date.now() - (await db.webVisitor.findUnique({ where: { id: row!.id } }))!.lastSeenAt.getTime() < 5000);

      await db.webVisitor.update({ where: { id: row!.id }, data: { lastSeenAt: new Date(Date.now() - 3 * 60_000) } });
      const left = await staffStartVisitorChat(agent, row!.id, "Hello");
      ok("they've left: refused, saying so", !left.ok && /left the website/.test(left.error), left);
      await db.webVisitor.update({ where: { id: row!.id }, data: { lastSeenAt: new Date() } });
      const blank = await staffStartVisitorChat(agent, row!.id, "   ");
      ok("nothing to say: refused", !blank.ok);

      await db.inboxChannel.update({ where: { id: channel.id }, data: { settings: { activity: { on: false } } } });
      const off = await staffStartVisitorChat(agent, row!.id, "Hello");
      ok("activity switched off for the channel: refused", !off.ok && /switched off/.test(off.error), off);
      await db.inboxChannel.update({ where: { id: channel.id }, data: { settings: { activity: { on: true } } } });

      const started = await staffStartVisitorChat(agent, row!.id, "Can I help with pricing?");
      ok("on the site now: a chat starts", started.ok, started);
      if (!started.ok) return;
      const chat = await db.conversation.findUnique({ where: { id: started.data.id }, select: { assignedToUserId: true, botActive: true, status: true, visitorTokenHash: true, messages: { select: { author: true, body: true } } } });
      ok("…with whoever started it, the bot out of it", chat?.assignedToUserId === owner.id && chat.botActive === false && chat.status === "OPEN");
      ok("…their message in it", chat?.messages.some((m) => m.author === "AGENT" && m.body === "Can I help with pricing?") === true);
      ok("…and no way in is stored in the clear", !!chat?.visitorTokenHash && (await db.webVisitor.findUnique({ where: { id: row!.id } }))?.conversationId === started.data.id);
      const invite = await pingVisitor(channel.id, browsing);
      ok("their next ping brings the message and the chat's key", invite?.text === "Can I help with pricing?" && !!invite.token, invite?.text ?? "");
      ok("…a key that opens that chat", createHash("sha256").update(invite?.token ?? "").digest("hex") === chat?.visitorTokenHash);
      ok("…and only once", (await pingVisitor(channel.id, browsing)) === null);

      const again = await staffStartVisitorChat(agent, row!.id, "Still there?");
      ok("with a chat open, it goes in that one", again.ok && again.data.id === started.data.id, again);
      const second = await pingVisitor(channel.id, browsing);
      ok("…and they're told, with no new key: they have it", second?.text === "Still there?" && second.token === null, second);

      const stranger2 = await db.user.create({ data: { name: "Zz Other", email: "other@zzprobe-wa.invalid", role: "SALES", passwordHash: "!" }, select: { id: true } });
      await db.conversation.update({ where: { id: started.data.id }, data: { assignedToUserId: owner.id } });
      const taken = await staffStartVisitorChat({ id: stranger2.id, viewAll: false }, row!.id, "Me too");
      ok("a colleague's open chat isn't walked into", !taken.ok && /colleague/.test(taken.error), taken);

      await db.conversation.update({ where: { id: started.data.id }, data: { status: "CLOSED" } });
      await db.inboxBlock.create({ data: { kind: "WEB", value: chat!.visitorTokenHash! } });
      const barred = await staffStartVisitorChat(agent, row!.id, "Hello again");
      ok("somebody the team blocked gets nothing", !barred.ok && /blocked/.test(barred.error), barred);
      await db.inboxBlock.deleteMany({ where: { kind: "WEB", value: chat!.visitorTokenHash! } });
      const fresh = await staffStartVisitorChat(agent, row!.id, "Hello again");
      ok("a closed chat stays closed; this starts afresh", fresh.ok && fresh.data.id !== started.data.id, fresh);
      const late = await db.webVisitor.update({ where: { id: row!.id }, data: { inviteAt: new Date(Date.now() - 11 * 60_000) }, select: { id: true } });
      ok("an invitation nobody came for lapses", (await pingVisitor(channel.id, browsing)) === null && !!late);
      const seen = await visitorDetail({ viewerId: owner.id, seesEveryChat: true, visitorId: row!.id });
      ok("the tab's detail has the journey and their chat", (seen?.journey.length ?? 0) >= 1 && !!seen?.conversationId);
      ok("the panel beside the chat finds the visitor", (await activityOfConversation(seen!.conversationId!))?.journey.length === seen?.journey.length);
    });

    console.log("\n— Lists and the clean-up —\n");
    const everyone = await recentVisitors({ viewerId: admin.id, seesEveryChat: true, knownOnly: false, take: 500 });
    ok("the tab lists them with their last page", everyone.visitors.some((x) => !!x.lastPath && x.pageCount >= 2));
    const known = await recentVisitors({ viewerId: admin.id, seesEveryChat: true, knownOnly: true, take: 500 });
    ok("known only", known.visitors.every((x) => x.contact || x.conversation?.contact));
    const hundredDays = new Date(Date.now() - 100 * 86_400_000);
    await db.webPageView.updateMany({ where: { visitorId: v1!.id, path: "/" }, data: { at: hundredDays } });
    await sweepWebActivity();
    ok("an address goes after 90 days; the page stays", (await db.webPageView.findFirst({ where: { visitorId: v1!.id, path: "/" } }))?.ipAddress === null);
    await db.webPageView.updateMany({ where: { visitorId: v1!.id, path: "/" }, data: { at: new Date(Date.now() - 400 * 86_400_000) } });
    await db.webVisitor.update({ where: { tokenHash: createHash("sha256").update(vid2).digest("hex") }, data: { lastSeenAt: new Date(Date.now() - 400 * 86_400_000) } });
    await sweepWebActivity();
    ok("a page goes after a year", (await db.webPageView.count({ where: { visitorId: v1!.id, path: "/" } })) === 0);
    ok("a visitor unseen for a year goes, with their pages", (await db.webVisitor.count({ where: { tokenHash: createHash("sha256").update(vid2).digest("hex") } })) === 0);
    await db.contact.update({ where: { id: contact.id }, data: { leftAt: new Date() } });
    await db.webVisitor.update({ where: { id: v1!.id }, data: { lastAlertAt: null } });
    const before = await db.notification.count({ where: { userId: owner.id, type: "WEBSITE_VISIT" } });
    await recordView(channel.id, { ...base, page: "https://acme.zz/pricing" }, ["/pricing"]);
    ok("somebody who has left the company tells nobody", (await db.notification.count({ where: { userId: owner.id, type: "WEBSITE_VISIT" } })) === before);
  } finally {
    await db.notification.deleteMany({ where: { user: { email: { endsWith: "@zzprobe-wa.invalid" } } } });
    await cleanup();
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} failed` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}

void main();
