/**
 * check:utm — UTM tags on the links in Deskzo's emails (owner, 1 Nov 2026 — src/lib/marketing/utm.ts).
 *
 *   1. A link: the four tags added; a tag it has kept; mailto:, tel:, anchors and the app's own links left alone; only
 *      the workspace's sites when it says so, subdomains included; off means nothing.
 *   2. An email: every <a href> in HTML, every address written out in text (a full stop after one left outside it),
 *      entities in an address kept as they were.
 *   3. A campaign's email built as it is sent: the links tagged before the click tracker wraps them, so the
 *      address the tracker sends people on to carries the tags; the unsubscribe link untouched.
 *   4. The settings: saved and read back, a bad website refused, "only our sites" without one refused, no
 *      permission refused — and the workspace's own setting put back afterwards.
 *
 *   npm run check:utm
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actor: { id: string; role: string; name: string; email: string } | null = null;
let allowed = true;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  if (request === "@/actions/permission" || request.endsWith("actions/permission")) return { hasEffectivePermission: async () => allowed };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function main() {
  const { tagUrl, tagHtmlLinks, tagTextLinks, utmSlug, readUtm, DEFAULT_UTM } = await import("../src/lib/marketing/utm");
  const on = DEFAULT_UTM;
  const tags = { campaign: "M365 Renewal — Nov 2026", content: "Subscription renewal notice" };
  const q = (u: string) => Object.fromEntries(new URL(u).searchParams);

  section("1. A link");
  const tagged = tagUrl("https://wroffy.com/m365?ref=x#plans", on, tags);
  ok("the four tags added, the address's own kept, its anchor kept", JSON.stringify(q(tagged)) === JSON.stringify({ ref: "x", utm_source: "deskzo", utm_medium: "email", utm_campaign: "m365-renewal-nov-2026", utm_content: "subscription-renewal-notice" }) && tagged.endsWith("#plans"), tagged);
  ok("a tag the link has is kept", q(tagUrl("https://wroffy.com/?utm_campaign=mine", on, tags)).utm_campaign === "mine");
  ok("mailto:, tel: and an anchor left alone", tagUrl("mailto:a@b.com", on, tags) === "mailto:a@b.com" && tagUrl("tel:+911", on, tags) === "tel:+911" && tagUrl("#top", on, tags) === "#top");
  ok("the app's own links left alone", tagUrl("https://wroffy.deskzo.com/preferences/abc", on, tags, "https://wroffy.deskzo.com") === "https://wroffy.deskzo.com/preferences/abc");
  const own = readUtm({ on: true, source: "Wroffy Mail", ownSitesOnly: true, domains: ["https://www.Wroffy.com/x", "not a site"] });
  ok("settings read back cleaned: the source a slug, a website a domain, a bad one dropped", own.source === "wroffy-mail" && JSON.stringify(own.domains) === JSON.stringify(["wroffy.com"]), own);
  ok("only our sites: ours tagged, a subdomain too, another left alone", q(tagUrl("https://wroffy.com/a", own, tags)).utm_source === "wroffy-mail" && !!q(tagUrl("https://shop.wroffy.com/a", own, tags)).utm_medium && tagUrl("https://microsoft.com/a", own, tags) === "https://microsoft.com/a");
  ok("switched off: nothing tagged", tagUrl("https://wroffy.com/", { ...on, on: false }, tags) === "https://wroffy.com/");
  ok("names made into tags", utmSlug("  Diwali Offer!! 2026 ") === "diwali-offer-2026" && readUtm(null).on === true);

  section("2. An email");
  const html = '<p><a href="https://wroffy.com/a?x=1&amp;y=2">A</a> <a href="mailto:x@y.com">B</a> <a style="c" href="https://microsoft.com/b">C</a></p>';
  const out = tagHtmlLinks(html, on, tags);
  ok("every web link in HTML tagged, an email link not", (out.match(/utm_medium=email/g) ?? []).length === 2 && out.includes('href="mailto:x@y.com"'), out);
  ok("  an address's own &amp; kept as an entity", out.includes("x=1&amp;y=2&amp;utm_source=deskzo"), out);
  const text = tagTextLinks("See https://wroffy.com/renew. Or (https://wroffy.com/help), thanks", on, tags);
  ok("addresses in text tagged, the full stop and bracket after them left outside", /renew\?utm_source=deskzo[^ ]*\. Or/.test(text) && /help\?utm_[^ )]*\), thanks/.test(text), text);

  section("3. A campaign's email, as it is sent");
  const { buildMarketingEmail } = await import("../src/lib/marketing/pipeline");
  const key = Buffer.alloc(32, 7);
  const recipient = { contactId: "c1", companyId: "co1", companyName: "ZZ Co", name: "Asha Rao", email: "asha@zz.invalid", phone: null, ownerName: null, ownerEmail: null, state: {} as never };
  const settings = { rules: {} as never, limits: {} as never, postalAddress: "ZZ address", approvalThreshold: 200, ourName: "ZZ Brand", utm: on };
  const built = buildMarketingEmail({
    template: { subject: "Hi", preheader: null, body: '<p>Hi {{firstName}}, <a href="https://wroffy.com/offer">see the offer</a></p>', format: "HTML" },
    recipient,
    settings,
    token: "tok123",
    origin: "https://zz.deskzo.invalid",
    trackingKey: key,
    utm: { campaign: "Diwali offer", content: "Special offer" },
  });
  const links = built.ok ? [...built.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&")) : [];
  const tracked = links.find((l) => l.includes("/api/marketing/") || l.includes("/track/") || l.includes("/r/"));
  const destination = tracked ? decodeURIComponent(tracked) : "";
  ok("built", built.ok, built.ok ? "" : built);
  ok("  the offer link goes through the click tracker, which sends people on to the tagged address", !!tracked && destination.includes("wroffy.com/offer") && destination.includes("utm_campaign=diwali-offer") && destination.includes("utm_content=special-offer"), tracked);
  ok("  the unsubscribe link untouched", links.some((l) => l.includes("/preferences/tok123") && !l.includes("utm_")) || links.some((l) => l.includes("unsubscribe") && !l.includes("utm_")), links.filter((l) => /prefer|unsub/.test(l)));
  const plain = buildMarketingEmail({ template: { subject: "Hi", preheader: null, body: "Renew at https://wroffy.com/renew.", format: "TEXT" }, recipient, settings, token: "tok124", origin: "https://zz.deskzo.invalid", trackingKey: null, utm: { campaign: "Renewals" } });
  ok("a plain-text campaign's address tagged too", plain.ok && plain.text.includes("https://wroffy.com/renew?utm_source=deskzo&utm_medium=email&utm_campaign=renewals."), plain.ok ? plain.text : plain);

  section("4. The settings");
  const { updateUtmSettings } = await import("../src/actions/marketing-utm");
  const { utmSettings } = await import("../src/lib/marketing/utm-settings");
  const admin = await db.user.findFirst({ where: { role: "ADMIN", active: true }, select: { id: true, role: true, name: true, email: true } });
  if (!admin) throw new Error("No admin to act as.");
  actor = admin;
  const before = await db.organisationSettings.findUnique({ where: { id: "global" }, select: { marketingUtm: true } });
  try {
    const saved = await updateUtmSettings({ on: true, source: "Wroffy", ownSitesOnly: true, domains: "wroffy.com, https://shop.wroffy.com/x" });
    ok("saved", saved.ok, saved.ok ? saved.data : saved.error);
    const read = await utmSettings();
    ok("  and read back as sent", read.source === "wroffy" && read.ownSitesOnly && JSON.stringify(read.domains) === JSON.stringify(["wroffy.com", "shop.wroffy.com"]), read);
    const bad = await updateUtmSettings({ on: true, source: "x", ownSitesOnly: true, domains: "wroffy.com, not a site" });
    ok("a website that isn't one refused", !bad.ok && bad.error.includes("not"), bad.ok ? "saved" : bad.error);
    const none = await updateUtmSettings({ on: true, source: "x", ownSitesOnly: true, domains: "" });
    ok("only our sites with none named refused", !none.ok, none.ok ? "saved" : none.error);
    allowed = false;
    const refused = await updateUtmSettings({ on: false, source: "x", ownSitesOnly: false, domains: "" });
    ok("refused without settings.manage", !refused.ok, refused.ok ? "saved" : refused.error);
    allowed = true;
  } finally {
    await db.organisationSettings.update({ where: { id: "global" }, data: { marketingUtm: (before?.marketingUtm ?? null) === null ? (await import("@prisma/client")).Prisma.DbNull : before!.marketingUtm! } }).catch(() => undefined);
    await db.auditLog.deleteMany({ where: { userId: admin.id, entityType: "OrganisationSettings", entityLabel: { startsWith: "Email links" }, createdAt: { gte: new Date(Date.now() - 10 * 60_000) } } });
  }

  console.log(failures === 0 ? `\nAll ${passes} UTM checks passed.\n` : `\n${failures} check(s) failed.\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
