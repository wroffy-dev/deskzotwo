/**
 * check:audit-lows-cms — the public website CMS and partner portal lows of the security audit's round two
 * (docs/reports/security-audit-2026-11-11.md §11, "CMS and partners", C2–C11), each shown to hold the way it was broken:
 *
 *   C2   removing your own authenticator: five wrong codes end the session; a used code doesn't work twice
 *   C3   new payout details need a fresh authenticator code, and every admin is emailed when they are asked for
 *   C4   a signup whose name or GSTIN/PAN is the partner's own, and a partner's first three, are flagged for staff
 *   C5   past a public form's whole-site cap, a caller under its own cap is kept and held (nothing mailed); the
 *        privacy form is never closed by it; IPv6 callers share a /64
 *   C6   the privacy acknowledgement carries none of the typed name or company
 *   C7   only a CMS admin changes the website chat
 *   C8   a CMS author can't change a built-in page's draft, or another author's
 *   C9   a partner's name, website and listing wait for staff; the directory keeps the approved values
 *   C10  registering a customer's domain is taken in as PENDING like any other; staff can't approve it
 *   C11  /track records one open and one click per message per ten minutes, and re-scores once
 *
 * Pure rules first, then a fixture of its own in the control plane, tagged ZZL1, removed in a finally.
 *
 *   npx tsx scripts/check-audit-lows-cms.ts
 */
import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import Module from "node:module";
import path from "node:path";
import { authenticator } from "otplib";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
// Emptied, not deleted: a Prisma client imported later reloads .env and would put a deleted value back.
process.env.TRUST_PROXY = "";
process.env.TRUST_PROXY_HOPS = "";
process.env.TRUST_PROXY_CLOUDFLARE = "";
process.env.TENANCY_LEGACY_HOSTS = "";
process.env.PLATFORM_SALES_EMAIL = "sales@zzl1.invalid";

const TAG = "zzl1";
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const why = (r: { ok: boolean; error?: string }) => (r.ok ? "ok" : (r.error ?? ""));
async function thrown(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

// ─── A request: headers and a cookie jar ────────────────────────────────────────────────────────
const jar = new Map<string, string>();
let requestHeaders = new Headers({ host: "localhost" });
const at = (host: string, extra: Record<string, string> = {}) => {
  requestHeaders = new Headers({ host, "user-agent": "check:audit-lows-cms", ...extra });
};

// ─── /track's workspace database, faked: only the route's own calls ──────────────────────────────
type FakeEvent = { messageId: string; type: string; occurredAt: Date };
const fakeEvents: FakeEvent[] = [];
let fakeMessage: { id: string; status: string } | null = null;
let rescored = 0;
const fakeDb = {
  marketingMessage: {
    findUnique: async () => fakeMessage,
    update: async ({ data }: { data: { status: string } }) => {
      if (fakeMessage) fakeMessage.status = data.status;
      return fakeMessage;
    },
  },
  messageEvent: {
    findFirst: async ({ where }: { where: { messageId: string; type: string; occurredAt: { gt: Date } } }) =>
      fakeEvents.find((e) => e.messageId === where.messageId && e.type === where.type && e.occurredAt > where.occurredAt.gt) ?? null,
    create: async ({ data }: { data: { messageId: string; type: string } }) => {
      const row = { ...data, occurredAt: new Date() };
      fakeEvents.push(row);
      return row;
    },
  },
};

const internals = Module as unknown as { _load(request: string, parent: { filename?: string } | undefined, isMain: boolean): unknown };
const original = internals._load;
const fromTrack = (parent: { filename?: string } | undefined) => !!parent?.filename?.includes(path.join("app", "track"));
internals._load = function (this: unknown, request: string, parent: { filename?: string } | undefined, isMain: boolean) {
  if (request === "next/headers" || request.endsWith(`${path.sep}next${path.sep}headers.js`)) {
    return {
      headers: async () => requestHeaders,
      cookies: async () => ({
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        has: (name: string) => jar.has(name),
        set: (name: string, value: string) => void jar.set(name, value),
        delete: (name: string) => void jar.delete(name),
      }),
    };
  }
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") {
    return {
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      notFound: () => {
        throw new Error("notFound");
      },
    };
  }
  if (request === "@/lib/auth") return { auth: async () => null, signIn: async () => {}, signOut: async () => {}, handlers: {} };
  if (fromTrack(parent)) {
    if (request === "@/lib/db") return { db: fakeDb };
    if (request === "@/lib/marketing/tracking") return { destinationIsOurs: async () => true };
    if (request === "@/lib/marketing/engagement-tasks") return { afterMarketingClick: async () => void (rescored += 1) };
    if (request === "@/lib/inbox/activity") return { siteReportsActivity: async () => false, visitLinkParam: async () => "" };
  }
  return original.call(this, request, parent, isMain);
} as typeof original;

async function main() {
  const attribution = await import("../src/lib/partners/attribution");
  const lockout = await import("../src/lib/security/lockout");
  const totp = await import("../src/lib/totp");
  const finder = await import("../src/lib/platform/find-workspaces");
  const { PLATFORM_DOMAIN } = await import("../src/lib/tenancy/host");

  // ─── C4, pure ────────────────────────────────────────────────────────────────────────────────
  section("C4: the partner's own company, by name and tax number");
  const partnerSide = { legalName: "Acme Solutions Private Limited", displayName: "Acme", taxIds: [{ kind: "GSTIN", value: "27AAPFU0939F1ZV" }] };
  ok("a name differing only in its legal form and punctuation matches", attribution.ownCompanyMatches({ name: "ACME Solutions Pvt. Ltd.", taxId: null }, partnerSide).includes("name"));
  ok("  the same GSTIN matches as gstin and pan", JSON.stringify(attribution.ownCompanyMatches({ name: "Someone Else", taxId: "27aapfu0939f1zv" }, partnerSide)) === JSON.stringify(["gstin", "pan"]));
  ok("  another state's GSTIN on the same PAN matches as pan", JSON.stringify(attribution.ownCompanyMatches({ name: "Someone Else", taxId: "29AAPFU0939F1Z1" }, partnerSide)) === JSON.stringify(["pan"]));
  ok("  a bare PAN matches the GSTIN's", attribution.ownCompanyMatches({ name: "Someone Else", taxId: "AAPFU0939F" }, partnerSide).includes("pan"));
  ok("  a different company matches nothing", attribution.ownCompanyMatches({ name: "Sunrise Traders", taxId: "27BBBBB1234B1Z5" }, partnerSide).length === 0);

  // ─── C11 ─────────────────────────────────────────────────────────────────────────────────────
  section("C11: /track writes one open and one click per message per ten minutes");
  const track = (await import("../src/app/track/[token]/route")) as { GET: (req: Request, ctx: { params: Promise<{ token: string }> }) => Promise<Response> };
  fakeMessage = { id: "zzl1-message", status: "SENT" };
  const hit = (click: boolean) => track.GET(new Request(`http://localhost/track/zzl1tok${click ? "?u=https%3A%2F%2Fexample.com%2F&s=x" : ""}`), { params: Promise.resolve({ token: "zzl1tok" }) });
  for (let i = 0; i < 50; i++) await hit(false);
  ok("fifty opens of one message write one OPEN row", fakeEvents.filter((e) => e.type === "OPEN").length === 1, fakeEvents.length);
  const clicks = [];
  for (let i = 0; i < 20; i++) clicks.push(await hit(true));
  ok("  twenty clicks write one CLICK row and re-score the lead once", fakeEvents.filter((e) => e.type === "CLICK").length === 1 && rescored === 1, { events: fakeEvents.length, rescored });
  ok("  every click is still redirected", clicks.every((r) => r.status === 302));
  fakeEvents[0]!.occurredAt = new Date(Date.now() - 11 * 60_000);
  await hit(false);
  ok("  an open after ten minutes is recorded again", fakeEvents.filter((e) => e.type === "OPEN").length === 2);

  // ─── C5 / C6, the public forms ─────────────────────────────────────────────────────────────────
  const { controlConfigured, controlDb } = await import("../src/lib/platform/control-db");
  if (!controlConfigured() || !process.env.PLATFORM_MASTER_KEY) {
    ok("a control plane and PLATFORM_MASTER_KEY to try the rest against", false, "CONTROL_DATABASE_URL / PLATFORM_MASTER_KEY not set");
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(1);
  }
  const control = controlDb();
  const { setTestPlatformMailer } = await import("../src/lib/platform/mailer");
  const { sealForPlatform } = await import("../src/lib/platform/kek");
  const mails: { to: string; subject: string; text: string }[] = [];
  setTestPlatformMailer(async (m) => void mails.push({ to: m.to, subject: m.subject, text: m.text }));
  const site = await import("../src/actions/platform/site");
  const partnerSite = await import("../src/actions/platform/partner-site");

  const ids: { cmsUsers: string[]; partnerId: string | null; tenantId: string | null } = { cmsUsers: [], partnerId: null, tenantId: null };
  const cleanup = async () => {
    await control.siteLead.deleteMany({ where: { email: { endsWith: `@${TAG}.invalid` } } });
    await control.privacyRequest.deleteMany({ where: { email: { endsWith: `@${TAG}.invalid` } } });
    await control.partnerApplication.deleteMany({ where: { contactEmail: { endsWith: `@${TAG}.invalid` } } });
    const cmsUsers = (await control.cmsUser.findMany({ where: { email: { endsWith: `@${TAG}.invalid` } }, select: { id: true } })).map((u) => u.id);
    await control.cmsAuditLog.deleteMany({ where: { actorId: { in: cmsUsers } } });
    await control.cmsSession.deleteMany({ where: { userId: { in: cmsUsers } } });
    await control.cmsUser.deleteMany({ where: { id: { in: cmsUsers } } });
    const partners = (await control.partner.findMany({ where: { slug: { startsWith: `${TAG}-` } }, select: { id: true } })).map((p) => p.id);
    await control.dealRegistration.deleteMany({ where: { partnerId: { in: partners } } });
    await control.tenantAttribution.deleteMany({ where: { partnerId: { in: partners } } });
    await control.partnerRequest.deleteMany({ where: { partnerId: { in: partners } } });
    await control.partnerAuditLog.deleteMany({ where: { partnerId: { in: partners } } });
    const users = (await control.partnerUser.findMany({ where: { partnerId: { in: partners } }, select: { id: true } })).map((u) => u.id);
    await control.partnerSession.deleteMany({ where: { userId: { in: users } } });
    await control.partnerUser.deleteMany({ where: { id: { in: users } } });
    await control.tenant.deleteMany({ where: { slug: { startsWith: `${TAG}-` } } });
    await control.partner.deleteMany({ where: { id: { in: partners } } });
  };

  try {
    await cleanup();
    process.env.TRUST_PROXY = "1";

    section("C5: the contact form past its whole-site cap");
    finder.siteAllowance([{ key: "platform|contact:all", max: 100 }]);
    while (finder.siteAllowance([{ key: "platform|contact:all", max: 100 }]));
    at("localhost", { "x-forwarded-for": "203.0.113.41" });
    mails.length = 0;
    const contact = (n: number) =>
      site.sendContactRequest({ name: "Zz Visitor", email: `contact-${n}@${TAG}.invalid`, company: "Zz Visitors Ltd", phone: "", topic: "sales", message: "We would like to know more about the product, please.", product: "", website: "" });
    const heldContact = await contact(1);
    const lead = await control.siteLead.findFirst({ where: { email: `contact-1@${TAG}.invalid` } });
    ok("before: one outsider filling the cap closed the form for everybody — now a known caller under its own cap is thanked", heldContact.ok, why(heldContact));
    ok("  its lead is kept and marked held", !!lead && /^Held:/.test(lead.notes ?? ""), lead?.notes ?? "no lead");
    ok("  and nothing is mailed", mails.length === 0, mails.length);
    for (let i = 2; i <= 5; i++) await contact(i);
    const sixth = await contact(6);
    ok("  the caller's own cap (5 an hour) still refuses its sixth", !sixth.ok);
    at("localhost", { "x-forwarded-for": "2001:db8:aa:1::1" });
    for (let i = 0; i < 5; i++) {
      at("localhost", { "x-forwarded-for": `2001:db8:aa:1:${i + 1}::${i + 9}` });
      await contact(10 + i);
    }
    at("localhost", { "x-forwarded-for": "2001:db8:aa:1:ffff::1" });
    const v6 = await contact(20);
    ok("  five addresses in one IPv6 /64 are one caller: a sixth address in it is refused", !v6.ok);
    at("localhost", { "x-forwarded-for": "2001:db8:aa:2::1" });
    ok("  the neighbouring /64 is a caller of its own", (await contact(21)).ok);
    process.env.TRUST_PROXY = "";
    at("localhost");
    const unknown = await contact(22);
    ok("  a caller whose address isn't known has no cap of its own: refused past the whole-site cap", !unknown.ok);
    process.env.TRUST_PROXY = "1";

    section("C5 / C6: the privacy form is never closed, and its acknowledgement carries no typed text");
    at("localhost", { "x-forwarded-for": "203.0.113.61" });
    mails.length = 0;
    const typed = await site.sendPrivacyRequest({ kind: "ACCESS", name: "Zz Click here evil.example", email: `privacy-0@${TAG}.invalid`, relation: "user", company: "Zz Pay at evil.example", message: "Please send me a copy of my data held by you." });
    const ackMail = mails.find((m) => m.to === `privacy-0@${TAG}.invalid`);
    ok("before: the acknowledgement carried the typed name and company to any address — now neither", typed.ok && !!ackMail && !/evil\.example/.test(`${ackMail.subject}\n${ackMail.text}`), ackMail ? ackMail.text.slice(0, 120) : why(typed as { ok: boolean; error?: string }));
    ok("  it greets generically", !!ackMail && /Dear Sir or Madam/.test(ackMail.text));
    while (finder.siteAllowance([{ key: "platform|privacy:all", max: 60 }]));
    process.env.TRUST_PROXY = "";
    at("localhost");
    mails.length = 0;
    const privacyHeld = await site.sendPrivacyRequest({ kind: "ACCESS", name: "Zz Person", email: `privacy-1@${TAG}.invalid`, relation: "user", company: "Zz Company", message: "Please send me a copy of my data held by you." });
    const kept = await control.privacyRequest.findFirst({ where: { email: `privacy-1@${TAG}.invalid` } });
    ok("past the whole-site cap, even from an unknown caller, a privacy request is taken", privacyHeld.ok, why(privacyHeld as { ok: boolean; error?: string }));
    ok("  kept and marked held, nothing mailed", !!kept && /^Held:/.test(kept.notes ?? "") && mails.length === 0, { notes: kept?.notes, mails: mails.length });

    section("C5: the partner application past its whole-site cap");
    const { applicationsOpen } = await import("../src/lib/partners/settings");
    if (!(await applicationsOpen())) {
      ok("applications are closed in this control plane — the held path can't be reached here", true, "skipped");
    } else {
      process.env.TRUST_PROXY = "1";
      while (finder.siteAllowance([{ key: "platform|partner-apply:all", max: 50 }]));
      at("localhost", { "x-forwarded-for": "203.0.113.71" });
      mails.length = 0;
      const applied = await partnerSite.applyToPartnerProgramme({
        companyName: "Zz Applicant",
        companyWebsite: "",
        country: "IN",
        kindWanted: "RESELLER",
        contactName: "Zz Applicant",
        contactEmail: `apply-1@${TAG}.invalid`,
        contactPhone: "",
        message: "We resell business software across Maharashtra and would like to join.",
        website: "",
      });
      const app = await control.partnerApplication.findFirst({ where: { contactEmail: `apply-1@${TAG}.invalid` } });
      ok("a known caller past the whole-site cap is thanked; the application is kept, held, and sales is not mailed", applied.ok && !!app && /^Held:/.test(app.notes ?? "") && mails.length === 0, { applied, notes: app?.notes, mails: mails.length });
    }
    process.env.TRUST_PROXY = "";

    // ─── The CMS ─────────────────────────────────────────────────────────────────────────────────
    const cmsSession = await import("../src/lib/cms/session");
    const content = await import("../src/lib/cms/content");
    const port = process.env.PLATFORM_PORT?.trim() ? `:${process.env.PLATFORM_PORT.trim()}` : "";
    const CMS = `cms.${PLATFORM_DOMAIN}${port}`;
    const PARTNERS = `partners.${PLATFORM_DOMAIN}${port}`;
    const cmsSecret = authenticator.generateSecret();
    const newCmsUser = async (role: "ADMIN" | "EDITOR" | "AUTHOR", n: string) => {
      const u = await control.cmsUser.create({
        data: { email: `${n}@${TAG}.invalid`, name: `ZZL1 ${n}`, role, totpSecretCipher: sealForPlatform("cms-totp", cmsSecret), totpEnabledAt: new Date(), createdBy: "script" } as never,
      });
      ids.cmsUsers.push(u.id);
      return u;
    };
    const cmsSignIn = async (userId: string) => {
      const token = randomBytes(32).toString("base64url");
      await control.cmsSession.create({ data: { id: sha256(token), userId, expiresAt: new Date(Date.now() + 3_600_000), mfaAt: new Date() } });
      jar.clear();
      jar.set("deskzo-cms", token);
      jar.set("__Host-deskzo-cms", token);
      at(CMS);
      return sha256(token);
    };

    section("C2: removing your own CMS authenticator");
    lockout.resetLockouts();
    totp.forgetUsedTotpSteps();
    const editor = await newCmsUser("EDITOR", "editor");
    const cmsSid = await cmsSignIn(editor.id);
    const signedIn = await cmsSession.currentCmsSession();
    ok("the fixture is signed in, through two-factor", !!signedIn?.mfaDone, signedIn ? "" : "no session");
    let lastCms = { ok: true } as { ok: boolean; error?: string };
    for (let i = 0; i < 5; i++) lastCms = await cmsSession.removeOwnCmsTwoFactor("000000");
    const revoked = await control.cmsSession.findUniqueOrThrow({ where: { id: cmsSid } });
    ok("before: wrong codes were unlimited — now the fifth ends the session", !!revoked.revokedAt && /signed out/i.test(why(lastCms)), why(lastCms));
    ok("  the authenticator is still on", !!(await control.cmsUser.findUniqueOrThrow({ where: { id: editor.id } })).totpEnabledAt);
    lockout.resetLockouts();
    const usedCode = authenticator.generate(cmsSecret);
    ok("  (the code is used once elsewhere — as at sign-in)", totp.verifyTotpCodeOnce(`cms:${editor.id}`, cmsSecret, usedCode));
    await cmsSignIn(editor.id);
    const replayed = await cmsSession.removeOwnCmsTwoFactor(usedCode);
    ok("  the same code replayed: refused", !replayed.ok && !!(await control.cmsUser.findUniqueOrThrow({ where: { id: editor.id } })).totpEnabledAt, why(replayed));
    totp.forgetUsedTotpSteps();
    const fresh = await cmsSession.removeOwnCmsTwoFactor(authenticator.generate(cmsSecret));
    ok("  a fresh code removes it", fresh.ok && !(await control.cmsUser.findUniqueOrThrow({ where: { id: editor.id } })).totpEnabledAt, why(fresh));

    section("C7: only an admin changes the website chat");
    const me = (u: { id: string; email: string; name: string; role: string }) => ({ id: u.id, email: u.email, name: u.name, role: u.role as "ADMIN" | "EDITOR" | "AUTHOR" });
    const current = await content.getSettingsForEdit();
    const otherChat = { workspace: current.draft.chat.workspace === "zzl1-elsewhere" ? "zzl1-other" : "zzl1-elsewhere", key: "zzl1KeyZzl1Key01" };
    const asEditor = await thrown(() => content.saveSettingsDraft({ settings: { chat: otherChat }, version: current.version, force: true }, me(editor)));
    ok("before: an editor pointed deskzo.com's chat anywhere — now refused", asEditor === "Only an admin can change the website chat.", asEditor);
    ok("  and the draft's chat is unchanged", JSON.stringify((await content.getSettingsForEdit()).draft.chat) === JSON.stringify(current.draft.chat));
    const admin = await newCmsUser("ADMIN", "admin");
    ok("  for an admin the guard lets it through (and reports a change, for the audit row)", (await content.websiteChatGuard(me(admin), otherChat, "draft")) === true);
    ok("  an editor saving the same chat as the draft's is fine", (await content.websiteChatGuard(me(editor), current.draft.chat, "draft")) === false);

    section("C8: authors and page drafts");
    const author = await newCmsUser("AUTHOR", "author");
    const builtin = await thrown(() => content.savePageDraft("builtin-home", { document: { title: "Zz", blocks: [] }, version: "", force: true }, me(author)));
    ok("before: an author rewrote the home page's draft — now refused", /Authors can change only the pages they created/.test(builtin), builtin);
    ok("  an author's own added page: allowed", content.mayChangePageDraft({ row: { createdBy: `cms:${author.id}` }, builtin: false }, me(author)));
    ok("  another person's added page: refused", !content.mayChangePageDraft({ row: { createdBy: `cms:${editor.id}` }, builtin: false }, me(author)));
    ok("  editors and admins: any page, built-in ones too", content.mayChangePageDraft({ row: null, builtin: true }, me(editor)) && content.mayChangePageDraft({ row: { createdBy: "script" }, builtin: true }, me(admin)));
    const restore = await thrown(() => content.restorePageVersion("builtin-home", "zzl1nonexistentversion0", {}, me(author)));
    ok("  restoring a version into a built-in page's draft: refused too", /Authors can change only the pages they created/.test(restore), restore);

    // ─── The partner portal ──────────────────────────────────────────────────────────────────────
    const pSession = await import("../src/lib/partners/session");
    const registry = await import("../src/lib/partners/registry");
    const requests = await import("../src/lib/partners/requests");
    const referrals = await import("../src/lib/partners/referrals");
    const profile = await import("../src/actions/partners/profile");
    const partner = await control.partner.create({
      data: {
        slug: `${TAG}-acme`,
        kind: "RESELLER",
        status: "ACTIVE",
        legalName: "ZZL1 Acme Solutions Private Limited",
        displayName: "ZZL1 Acme",
        country: "IN",
        territories: ["IN"],
        contactName: "Zz Contact",
        contactEmail: `contact@${TAG}.invalid`,
        taxIds: [{ kind: "GSTIN", value: "27AAPFU0939F1ZV" }],
        website: "https://zzl1-acme.example",
        createdBy: "script",
      },
    });
    ids.partnerId = partner.id;
    const pSecret = authenticator.generateSecret();
    const newPartnerUser = async (role: "ADMIN" | "FINANCE", n: string, enrolled = true) =>
      control.partnerUser.create({
        data: { partnerId: partner.id, email: `${n}@${TAG}.invalid`, name: `ZZL1 ${n}`, role, createdBy: "script", ...(enrolled ? { totpSecretCipher: sealForPlatform("partner-totp", pSecret), totpEnabledAt: new Date() } : {}) },
      });
    const pAdmin = await newPartnerUser("ADMIN", "padmin");
    const pAdmin2 = await newPartnerUser("ADMIN", "padmin2", false);
    const pFinance = await newPartnerUser("FINANCE", "pfinance");
    const partnerSignIn = async (userId: string) => {
      const token = randomBytes(32).toString("base64url");
      await control.partnerSession.create({ data: { id: sha256(token), userId, expiresAt: new Date(Date.now() + 3_600_000), mfaAt: new Date() } });
      jar.clear();
      jar.set("deskzo-partners", token);
      jar.set("__Host-deskzo-partners", token);
      at(PARTNERS);
      return sha256(token);
    };

    section("C2: removing your own partner authenticator");
    lockout.resetLockouts();
    totp.forgetUsedTotpSteps();
    const pSid = await partnerSignIn(pFinance.id);
    ok("the fixture is signed in to the portal", !!(await pSession.currentPartnerSession())?.mfaDone);
    let lastP = { ok: true } as { ok: boolean; error?: string };
    for (let i = 0; i < 5; i++) lastP = await pSession.removeOwnPartnerTwoFactor("000000");
    ok("the fifth wrong code ends the session", !!(await control.partnerSession.findUniqueOrThrow({ where: { id: pSid } })).revokedAt && /signed out/i.test(why(lastP)), why(lastP));
    lockout.resetLockouts();
    const pUsed = authenticator.generate(pSecret);
    totp.verifyTotpCodeOnce(`partner:${pFinance.id}`, pSecret, pUsed);
    await partnerSignIn(pFinance.id);
    ok("  a used code replayed: refused", !(await pSession.removeOwnPartnerTwoFactor(pUsed)).ok);
    totp.forgetUsedTotpSteps();
    lockout.resetLockouts();

    section("C3: new payout details");
    const payout = { accountHolder: "ZZL1 Acme Solutions", bankName: "Zz Bank", country: "IN", currency: "INR", accountNumber: "112233445566", ifsc: "HDFC0001234" };
    await partnerSignIn(pAdmin.id);
    mails.length = 0;
    const noCode = await profile.partnerRequestPayoutChange(payout);
    ok("before: a session alone sent the commission elsewhere — now no code is refused", !noCode.ok && (await control.partnerRequest.count({ where: { partnerId: partner.id, kind: "PAYOUT" } })) === 0, why(noCode));
    const wrong = await profile.partnerRequestPayoutChange(payout, "000000");
    ok("  a wrong code: refused", !wrong.ok);
    const pCode = authenticator.generate(pSecret);
    const sent = await profile.partnerRequestPayoutChange(payout, pCode);
    ok("  a fresh code: the request is made", sent.ok, why(sent));
    const told = mails.filter((m) => /new payout details asked for/.test(m.subject)).map((m) => m.to);
    ok("  every ADMIN is emailed now, before any approval (the finance user is not)", told.includes(pAdmin.email) && told.includes(pAdmin2.email) && !told.includes(pFinance.email), told);
    ok("  the email shows the mask only", mails.every((m) => !m.text.includes("112233445566")) && mails.some((m) => m.text.includes("ending 5566")));
    await control.partnerRequest.deleteMany({ where: { partnerId: partner.id, kind: "PAYOUT" } });
    const replay = await profile.partnerRequestPayoutChange(payout, pCode);
    ok("  the same code again: refused", !replay.ok && /not right/.test(why(replay)), why(replay));
    await partnerSignIn(pAdmin2.id);
    const noAuthenticator = await profile.partnerRequestPayoutChange(payout, "123456");
    ok("  someone with no authenticator is told to set one up", !noAuthenticator.ok && /Set up an authenticator/.test(why(noAuthenticator)), why(noAuthenticator));
    totp.forgetUsedTotpSteps();
    lockout.resetLockouts();

    section("C9: the directory waits for staff");
    await partnerSignIn(pAdmin.id);
    const meAdmin = (await pSession.currentPartnerSession())!.user;
    const listedBefore = (await registry.publicPartnerDirectory()).partners.some((p) => p.displayName === "ZZL1 Acme");
    const self = await profile.partnerUpdateProfile({ displayName: "ZZL1 Totally Different", website: "https://zzl1-phish.example", publicListing: true, publicBlurb: "Zz blurb", contactPhone: "+91 98765 43210" });
    const after = await control.partner.findUniqueOrThrow({ where: { id: partner.id } });
    ok("before: name, website and listing went live unreviewed — now they wait", self.ok && after.displayName === "ZZL1 Acme" && after.website === "https://zzl1-acme.example" && !after.publicListing, self.ok ? self.data : why(self));
    ok("  the phone applies at once", after.contactPhone === "+91 98765 43210");
    ok("  the held ones are one PROFILE request", self.ok && JSON.stringify(self.data.held.sort()) === JSON.stringify(["displayName", "publicBlurb", "publicListing", "website"]) && !!self.data.requestId);
    ok("  the directory still shows nothing new", !listedBefore && !(await registry.publicPartnerDirectory()).partners.some((p) => /ZZL1/.test(p.displayName)));
    const direct = await thrown(() => registry.updatePartnerSelf(meAdmin, { displayName: "ZZL1 Sneaky" }));
    ok("  updatePartnerSelf with nowhere to hold a change refuses rather than apply it", /needs review/.test(direct), direct);
    const staff = { id: "zzl1-staff", email: `staff@${TAG}.invalid`, name: "ZZL1 Staff", role: "OWNER" as const };
    if (self.ok && self.data.requestId) await requests.decideRequest(self.data.requestId, "APPROVE", null, staff);
    const approved = await control.partner.findUniqueOrThrow({ where: { id: partner.id } });
    ok("  once staff approve, they apply", approved.displayName === "ZZL1 Totally Different" && approved.publicListing && approved.website === "https://zzl1-phish.example" && approved.publicBlurb === "Zz blurb");
    await control.partner.update({ where: { id: partner.id }, data: { publicListing: false, displayName: "ZZL1 Acme" } });

    section("C10: registering a customer's domain");
    const tenant = await control.tenant.create({
      data: { slug: `${TAG}-cust`, name: "ZZL1 Acme Solutions Pvt Ltd", status: "SUSPENDED", keyBundleCipher: "zzl1", ownerEmail: `owner@${TAG}-cust.example`, taxId: "27AAPFU0939F1ZV" },
    });
    ids.tenantId = tenant.id;
    const deal = await referrals.registerDeal(meAdmin, { companyName: "Zz Customer", domain: `${TAG}-cust.example`, country: "IN" }).then(
      (d) => ({ ok: true as const, d }),
      (err: Error) => ({ ok: false as const, error: err.message }),
    );
    ok("before: a customer's domain was refused, telling the partner who is a customer — now taken in as PENDING", deal.ok && deal.d.status === "PENDING", deal.ok ? deal.d.status : deal.error);
    const fresh2 = await referrals.registerDeal(meAdmin, { companyName: "Zz Nobody", domain: `${TAG}-nobody.example`, country: "IN" }).then((d) => d.status, (err: Error) => err.message);
    ok("  the same answer as for a domain nobody has", fresh2 === "PENDING", fresh2);
    if (deal.ok) {
      const approve = await thrown(() => referrals.decideDeal(deal.d.id, "APPROVE", null, staff));
      ok("  staff can't approve the customer's domain — they decline it", /already a customer/.test(approve), approve);
    }

    section("C4: a signup that looks like the partner's own, and its first three");
    class Rollback extends Error {}
    let flags: unknown = null;
    await control
      .$transaction(async (tx) => {
        const decision = { partnerId: partner.id, source: "REFERRAL_LINK" as const, reference: "link:zzl1", commissionable: true, flags: null, dealId: null, referralLinkId: null };
        const made = await attribution.recordSignupAttribution(tx, tenant.id, decision);
        flags = (await tx.tenantAttribution.findUniqueOrThrow({ where: { id: made!.attributionId } })).flags;
        throw new Rollback();
      })
      .catch((err) => {
        if (!(err instanceof Rollback)) throw err;
      });
    const f = (flags ?? {}) as { ownCompanyMatch?: string[]; earlyAttribution?: number };
    ok("before: a fresh mailbox hid the partner's own company — now its name, GSTIN and PAN are flagged", JSON.stringify(f.ownCompanyMatch) === JSON.stringify(["name", "gstin", "pan"]), flags);
    ok("  and the partner's first signup is flagged for staff", f.earlyAttribution === 1, flags);
  } finally {
    setTestPlatformMailer(null);
    totp.forgetUsedTotpSteps();
    lockout.resetLockouts();
    process.env.TRUST_PROXY = "";
    await cleanup();
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
