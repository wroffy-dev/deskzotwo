/**
 * check:audit-lows-platform — the round-two lows for Deskzo's billing, signup and domains, the console's sign-in, and
 * the portal's and other public pages' tokens (docs/reports/security-audit-2026-11-11.md §11), each shown to hold
 * the way it was broken:
 *
 *   B3  a partner's invitation no longer skips one-trial-per-mailbox, nor starts a workspace on an add-on plan
 *   B5  the buyer GSTIN on Deskzo's own tax invoices is checked, matched to the state, and locked once invoiced
 *   B7  a custom domain stopped for 14 days can be taken over by a workspace that proves it; a newer stop can't
 *   P6  strangers' wrong passwords no longer keep a staff member with their authenticator out of the console
 *   O6  portal and reception-desk links are stored hashed and sealed, TV secrets sealed — and links made before
 *       20261213210000_token_hashes still work after it
 *   O7  the Outlook signature endpoint answers an unknown address like an empty signature; no shared "unknown" bucket
 *   O8  a poll answer counts only when it is one of that poll's own answers
 *
 * Its own fixture in both databases, tagged ZZL3, removed in a finally.
 *
 *   npx tsx scripts/check-audit-lows-platform.ts
 */
import "dotenv/config";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import Module from "node:module";
import bcrypt from "bcryptjs";
import { authenticator } from "otplib";

(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;
process.env.DESKZO_TENANCY_FALLBACK = "legacy";
process.env.TRUST_PROXY = "1";
delete process.env.PLATFORM_CONSOLE_IP_ALLOWLIST;

const TAG = "zzl3";
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const thrown = async (fn: () => Promise<unknown>): Promise<string | null> => {
  try {
    await fn();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};

// ─── Stubs: the request (cookies, headers), the signed-in person, the GST system ─────────────────
const jar = new Map<string, string>();
let requestHeaders = new Headers({ host: "localhost:3000", "x-forwarded-for": "203.0.113.50" });
let actor: { id: string; name: string; email: string; role: string } | null = null;
class StubGstinLookupRefused extends Error {}
/** What the stubbed GST system answers; null: no e-invoice login (refused, as a workspace without one is). */
let gstAnswer: { status: string; legalName: string | null; stateCode: string | null } | null = null;
const internals = Module as unknown as { _load(req: string, parent: { filename?: string } | undefined, isMain: boolean): unknown };
const original = internals._load;
internals._load = function (this: unknown, request: string, parent: { filename?: string } | undefined, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
  if (request === "next/headers" || request.endsWith(`${path.sep}next${path.sep}headers.js`)) {
    return {
      headers: async () => requestHeaders,
      cookies: async () => ({
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        has: (name: string) => jar.has(name),
        set: (name: string, value: string, opts?: { maxAge?: number }) => {
          if (!value || opts?.maxAge === 0) jar.delete(name);
          else jar.set(name, value);
        },
        delete: (name: string) => void jar.delete(name),
      }),
    };
  }
  if (request === "@/lib/auth") return { auth: async () => null, signIn: async () => {}, signOut: async () => {}, handlers: {} };
  if ((request === "node:child_process" || request === "child_process") && parent?.filename?.endsWith("signup.ts")) return { spawn: () => ({ unref() {} }) };
  if (request === "@/lib/gstin/lookup") {
    return {
      GstinLookupRefused: StubGstinLookupRefused,
      lookupGstin: async (gstin: string) => {
        if (!gstAnswer) throw new StubGstinLookupRefused("Checking with the GST system uses your e-invoice login.");
        return { check: { gstin, ...gstAnswer }, reused: false };
      },
    };
  }
  const resolved = original.call(this, request, parent, isMain) as Record<string, unknown>;
  if (request === "@/lib/session" || request.endsWith(`lib${path.sep}session`)) {
    return {
      ...resolved,
      requireUser: async () => {
        if (!actor) throw new Error("Unauthorized");
        return actor;
      },
      currentUser: async () => actor,
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => null,
    };
  }
  return resolved;
} as typeof original;

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { controlConfigured, controlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
  if (!controlConfigured() || !process.env.PLATFORM_MASTER_KEY || !process.env.DATABASE_URL) throw new Error("CONTROL_DATABASE_URL, DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  const local = (u: string) => ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(u).hostname);
  if (!local(process.env.CONTROL_DATABASE_URL!) || !local(process.env.DATABASE_URL)) throw new Error("This check runs against local databases only.");

  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { UNRESTRICTED } = require("../src/lib/entitlements") as typeof import("../src/lib/entitlements");
  const { setTestPlatformMailer } = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
  const lockout = require("../src/lib/security/lockout") as typeof import("../src/lib/security/lockout");
  const totp = require("../src/lib/totp") as typeof import("../src/lib/totp");
  const { lookupReady } = require("../src/lib/gstin/notes") as typeof import("../src/lib/gstin/notes");
  const { buyerGstinCheck } = require("../src/lib/billing/buyer-gstin") as typeof import("../src/lib/billing/buyer-gstin");
  const domains = require("../src/lib/platform/domains") as typeof import("../src/lib/platform/domains");
  const { routingTarget } = require("../src/lib/platform/domain-rules") as typeof import("../src/lib/platform/domain-rules");
  const referrals = require("../src/lib/partners/referrals") as typeof import("../src/lib/partners/referrals");
  const signup = require("../src/actions/platform/signup") as typeof import("../src/actions/platform/signup");
  const staffSession = require("../src/lib/platform/staff-session") as typeof import("../src/lib/platform/staff-session");
  const settings = require("../src/lib/platform/settings") as typeof import("../src/lib/platform/settings");
  const { sealForPlatform } = require("../src/lib/platform/kek") as typeof import("../src/lib/platform/kek");
  const linkToken = require("../src/lib/portal/link-token") as typeof import("../src/lib/portal/link-token");
  const portal = require("../src/actions/portal") as typeof import("../src/actions/portal");
  const portalPublic = require("../src/actions/portal-public") as typeof import("../src/actions/portal-public");
  const visitor = require("../src/actions/visitor") as typeof import("../src/actions/visitor");
  const visitorPublic = require("../src/actions/visitor-public") as typeof import("../src/actions/visitor-public");
  const tvScreens = require("../src/lib/tv/screens") as typeof import("../src/lib/tv/screens");
  const { decryptSecret } = require("../src/lib/crypto") as typeof import("../src/lib/crypto");
  const outlook = require("../src/lib/signatures/outlook") as typeof import("../src/lib/signatures/outlook");
  const polls = require("../src/lib/marketing/polls") as typeof import("../src/lib/marketing/polls");
  const { expandWidgets } = require("../src/lib/marketing/email-widgets") as typeof import("../src/lib/marketing/email-widgets");

  const control = controlDb();
  const mail: { to: string; subject: string }[] = [];
  setTestPlatformMailer(async (m) => void mail.push({ to: m.to, subject: m.subject }));

  // Fixture handles, for the finally.
  const tenantIds: string[] = [];
  const partnerIds: string[] = [];
  const planKeys = [`${TAG}-edition`, `${TAG}-addon`];
  const inviteHashes: string[] = [];
  const staffEmail = `owner@${TAG}.invalid`;
  const tvCodes: string[] = [];
  const companyIds: string[] = [];
  const messageIds: string[] = [];
  const settingBefore = await settings.getSetting("staff.twoFactor");
  const portalSettingsBefore = await db.portalSettings.findUnique({ where: { id: "global" } });
  const signatureBefore = await db.signatureSettings.findUnique({ where: { id: "global" }, select: { outlookOn: true } });

  const cleanupControl = async () => {
    const staff = await control.platformUser.findMany({ where: { email: { endsWith: `@${TAG}.invalid` } }, select: { id: true } });
    const staffIds = staff.map((s) => s.id);
    await control.platformAuditLog.deleteMany({ where: { OR: [{ actor: { in: staffIds } }, { tenantId: { in: tenantIds } }] } });
    await control.platformSession.deleteMany({ where: { userId: { in: staffIds } } });
    await control.platformUser.deleteMany({ where: { id: { in: staffIds } } });
    await control.pendingSignup.deleteMany({ where: { email: { contains: `${TAG}-` } } });
    await control.signupInvite.deleteMany({ where: { OR: [{ codeHash: { in: inviteHashes } }, { partnerId: { in: partnerIds } }, { note: { startsWith: TAG } }] } });
    await control.partnerAuditLog.deleteMany({ where: { partnerId: { in: partnerIds } } });
    await control.partner.deleteMany({ where: { id: { in: partnerIds } } });
    const stray = await control.partner.findMany({ where: { slug: { startsWith: `${TAG}-` } }, select: { id: true } });
    if (stray.length) {
      await control.signupInvite.deleteMany({ where: { partnerId: { in: stray.map((p) => p.id) } } });
      await control.partnerAuditLog.deleteMany({ where: { partnerId: { in: stray.map((p) => p.id) } } });
      await control.partner.deleteMany({ where: { id: { in: stray.map((p) => p.id) } } });
    }
    await control.invoice.deleteMany({ where: { externalId: { startsWith: `${TAG}-` } } });
    await control.tenantDomain.deleteMany({ where: { host: { endsWith: `.${TAG}.example` } } });
    await control.tenant.deleteMany({ where: { slug: { startsWith: TAG } } });
    await control.plan.deleteMany({ where: { key: { in: planKeys } } });
  };
  const cleanupWorkspace = async () => {
    await db.tvScreen.deleteMany({ where: { name: { startsWith: "ZZL3" } } });
    if (tvCodes.length) await db.tvPairing.deleteMany({ where: { code: { in: tvCodes } } });
    await db.visitorKiosk.deleteMany({ where: { name: { startsWith: "ZZL3" } } });
    if (messageIds.length) {
      await db.emailPollAnswer.deleteMany({ where: { messageId: { in: messageIds } } });
      await db.marketingMessage.deleteMany({ where: { id: { in: messageIds } } });
    }
    const companies = await db.company.findMany({ where: { name: { startsWith: "ZZL3" } }, select: { id: true } });
    const ids = [...new Set([...companyIds, ...companies.map((c) => c.id)])];
    if (ids.length) {
      await db.portalLogin.deleteMany({ where: { companyId: { in: ids } } });
      await db.auditLog.deleteMany({ where: { entityType: { in: ["PortalLogin", "VisitorKiosk"] }, entityLabel: { contains: "ZZL3" } } }).catch(() => undefined);
      await db.company.deleteMany({ where: { id: { in: ids } } });
    }
  };

  try {
    await cleanupControl();
    await cleanupWorkspace();

    // ─── Pure rules ─────────────────────────────────────────────────────────────────────────────
    section("O6: the hash the migration fills in is the one the app looks up");
    const probe = randomBytes(24).toString("base64url");
    const sqlHash = (await control.$queryRaw<{ h: string }[]>`SELECT encode(sha256(convert_to(${probe}::text, 'UTF8')), 'hex') AS h`)[0]?.h;
    ok("Postgres's encode(sha256(token)) equals tokenHash(token)", sqlHash === linkToken.tokenHash(probe));

    section("B7: when a stopped address may be taken over");
    const DAY = 86_400_000;
    const now = new Date();
    const failingFor = (days: number) => new Date(now.getTime() - days * DAY);
    ok("stopped 3 days after failing began, plus 14 days: takeable", domains.releasable({ status: "BROKEN", failingSince: failingFor(3 + 14 + 0.1) }, now));
    ok("  stopped less than 14 days: kept", !domains.releasable({ status: "BROKEN", failingSince: failingFor(3 + 13) }, now));
    ok("  live (even failing), waiting, or with no date: kept", !domains.releasable({ status: "ACTIVE", failingSince: failingFor(40) }, now) && !domains.releasable({ status: "PENDING", failingSince: null }, now) && !domains.releasable({ status: "BROKEN", failingSince: null }, now));

    section("O8: a poll's answers are the ones its block offered");
    const ORIGIN = "https://zzl3.localhost";
    const htmlBody = expandWidgets("<p>Hello. Unsubscribe here. Great deals inside.</p>{{poll How did we do? | Great | Okay & fine}}", "HTML", { origin: ORIGIN, token: "tok" });
    const textBody = expandWidgets("Hello. Unsubscribe here.\n{{poll Will you come? | Yes | No: not this time}}\nBye", "TEXT", { origin: ORIGIN, token: "tok" });
    const htmlPolls = polls.sentPolls(htmlBody);
    ok("an HTML email: its one poll and its two answers, escaped as drawn", JSON.stringify(htmlPolls) === JSON.stringify([{ question: "How did we do?", answers: ["Great", "Okay &amp; fine"] }]), htmlPolls);
    const textPolls = polls.sentPolls(textBody);
    ok("  a text email: the same, an answer with a colon in it kept whole", JSON.stringify(textPolls) === JSON.stringify([{ question: "Will you come?", answers: ["Yes", "No: not this time"] }]), textPolls);

    // ─── B3 ─────────────────────────────────────────────────────────────────────────────────────
    section("B3: partner invitations — one trial per mailbox, editions only");
    await control.plan.create({ data: { key: planKeys[0]!, name: "ZZL3 Edition", kind: "EDITION", active: true, sortOrder: 9990 } });
    await control.plan.create({ data: { key: planKeys[1]!, name: "ZZL3 Add-on", kind: "ADDON", active: true, sortOrder: 9991 } });
    const partner = await control.partner.create({
      data: {
        slug: `${TAG}-partner`, kind: "RESELLER", status: "ACTIVE", legalName: "ZZL3 Partner Pvt Ltd", displayName: "ZZL3 Partner", country: "IN", territories: ["IN"],
        contactName: "ZZL3 Contact", contactEmail: `contact@${TAG}-partner.example`, addressLine1: "1 Zzl3 Road", city: "Pune", postalCode: "411001", taxIds: [], createdBy: "script:check-audit-lows-platform",
      },
      select: { id: true, slug: true, displayName: true, kind: true, status: true, parentId: true, territories: true },
    });
    partnerIds.push(partner.id);
    const me = { id: `${TAG}-seller`, email: `seller@${TAG}-partner.example`, name: "ZZL3 Seller", role: "SALES" as const, partner: { ...partner, territories: [...partner.territories] } };
    const addonRefusal = await thrown(() => referrals.createPartnerInvite(me as never, { note: `${TAG} addon`, planKey: planKeys[1] }));
    ok("a partner's code naming an add-on plan: refused", addonRefusal === "That plan is not one a new workspace can start on.", addonRefusal ?? "made");
    const partnerCode = await referrals.createPartnerInvite(me as never, { note: `${TAG} edition`, planKey: planKeys[0], uses: 5 });
    inviteHashes.push(partnerCode.codeHash);
    ok("  naming an edition: made", !!partnerCode.code);

    const owner = await control.tenant.create({ data: { slug: `${TAG}own`, name: "ZZL3 Own", status: "ACTIVE", keyBundleCipher: "pending", ownerEmail: `owner@${TAG}-own.example`, entitlements: UNRESTRICTED as never } });
    tenantIds.push(owner.id);
    const staffCode = randomBytes(9).toString("base64url");
    const { createHash } = await import("node:crypto");
    const staffHash = createHash("sha256").update(staffCode).digest("hex");
    inviteHashes.push(staffHash);
    await control.signupInvite.create({ data: { codeHash: staffHash, maxUses: 5, expiresAt: new Date(Date.now() + 7 * DAY), createdBy: "script", note: `${TAG} staff` } });
    const form = (invite: string) => ({ companyName: "Zzl Three Traders", slug: "zzlthreetraders", ownerName: "Zzl Owner", email: `Owner+again@${TAG}-own.example`, password: "x", country: "IN", invite, referral: "", referralVia: "" as const });
    lockout.resetLockouts();
    const viaPartner = await signup.startSignup(form(partnerCode.code));
    const partnerEmailIssue = viaPartner.ok ? null : (viaPartner as { issues?: Record<string, string> }).issues?.email ?? null;
    ok("a person with a workspace, through a partner's code: told to sign in instead", !!partnerEmailIssue && partnerEmailIssue.includes("already has a Deskzo workspace"), partnerEmailIssue ?? "no email problem");
    const viaStaff = await signup.startSignup(form(staffCode));
    const staffEmailIssue = viaStaff.ok ? null : (viaStaff as { issues?: Record<string, string> }).issues?.email ?? null;
    ok("  through Deskzo staff's own invitation: let through (staff set up a second workspace on purpose)", !staffEmailIssue, staffEmailIssue ?? "");

    // ─── B5 ─────────────────────────────────────────────────────────────────────────────────────
    section("B5: the buyer GSTIN on Deskzo's tax invoices");
    const prefix = "27AAPFU0939F1Z";
    const gstin = [..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((c) => prefix + c).find((g) => lookupReady(g))!;
    const otherGstin = [..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((c) => "29AAPFU0939F1Z" + c).find((g) => lookupReady(g))!;
    const badCheck = gstin.slice(0, 14) + (gstin.endsWith("A") ? "B" : "A");
    gstAnswer = null;
    const typo = await buyerGstinCheck(owner.id, badCheck, "27", "u1");
    ok("a GSTIN whose check character is wrong: refused", !typo.ok && /isn't a valid GSTIN/.test(typo.error), typo);
    const elsewhere = await buyerGstinCheck(owner.id, gstin, "29", "u1");
    ok("  one registered in Maharashtra, with Karnataka chosen: refused, naming its state", !elsewhere.ok && elsewhere.error.includes("Maharashtra"), elsewhere);
    const unverified = await buyerGstinCheck(owner.id, gstin, "27", "u1");
    ok("  no e-invoice login to ask the GST system: kept, unverified, as before", unverified.ok && unverified.legalName === null, unverified);
    gstAnswer = { status: "NOT_FOUND", legalName: null, stateCode: null };
    const unknown = await buyerGstinCheck(owner.id, gstin, "27", "u1");
    ok("  the GST system doesn't know it: refused", !unknown.ok && /doesn't know/.test(unknown.error), unknown);
    gstAnswer = { status: "CNL", legalName: "Old Co", stateCode: "27" };
    const cancelled = await buyerGstinCheck(owner.id, gstin, "27", "u1");
    ok("  cancelled: refused", !cancelled.ok && /cancelled/.test(cancelled.error), cancelled);
    gstAnswer = { status: "ACT", legalName: "Zzl Three Traders Private Limited", stateCode: "27" };
    const verified = await buyerGstinCheck(owner.id, gstin, "27", "u1");
    ok("  active: kept, and its registered name becomes the billing name", verified.ok && verified.legalName === "Zzl Three Traders Private Limited", verified);
    await control.tenant.update({ where: { id: owner.id }, data: { taxId: gstin, billingState: "27" } });
    gstAnswer = null;
    ok("  before any tax invoice, the workspace may still change it", (await buyerGstinCheck(owner.id, otherGstin, "29", "u1")).ok);
    await control.invoice.create({ data: { tenantId: owner.id, gateway: "MANUAL", externalId: `${TAG}-inv-1`, status: "PAID", currency: "INR", subtotal: 100, total: 118, issuedAt: new Date(), taxNumber: `ZZL3/2026-27/${randomInt(1000, 9999)}` } });
    const locked = await buyerGstinCheck(owner.id, otherGstin, "29", "u1");
    ok("once a tax invoice has been issued to it: locked, changes go through staff", !locked.ok && /write to Deskzo support/.test(locked.error), locked);
    ok("  clearing it is a change too: locked", !(await buyerGstinCheck(owner.id, "", undefined, "u1")).ok);
    ok("  saving the same GSTIN again (the other fields changing): fine", (await buyerGstinCheck(owner.id, gstin, "27", "u1")).ok);

    // ─── B7 ─────────────────────────────────────────────────────────────────────────────────────
    section("B7: a long-stopped custom domain can move to the workspace that proves it");
    const dns = { txt: new Map<string, string[][]>(), cname: new Map<string, string[]>() };
    const nx = (code: string) => Object.assign(new Error(code), { code });
    domains.setTestDomainResolver({
      resolveTxt: async (n) => dns.txt.get(n) ?? Promise.reject(nx("ENOTFOUND")),
      resolveCname: async (n) => dns.cname.get(n) ?? Promise.reject(nx("ENODATA")),
      resolve4: async () => Promise.reject(nx("ENODATA")),
      resolve6: async () => Promise.reject(nx("ENODATA")),
    });
    const mk = async (key: string) => {
      const t = await control.tenant.create({ data: { slug: `${TAG}${key}`, name: `ZZL3 ${key.toUpperCase()}`, status: "ACTIVE", keyBundleCipher: "pending", ownerEmail: `owner@${TAG}-${key}.example`, entitlements: UNRESTRICTED as never }, select: { id: true, slug: true } });
      tenantIds.push(t.id);
      return t;
    };
    const oldWs = await mk("old");
    const newWs = await mk("new");
    const staleHost = `shop.${TAG}.example`;
    const freshHost = `crm.${TAG}.example`;
    await control.tenantDomain.create({ data: { tenantId: oldWs.id, host: staleHost, kind: "CUSTOM", status: "BROKEN", verifyToken: "old-token", verifiedAt: failingFor(60), failingSince: failingFor(3 + 15) } });
    await control.tenantDomain.create({ data: { tenantId: oldWs.id, host: freshHost, kind: "CUSTOM", status: "BROKEN", verifyToken: "old-token-2", verifiedAt: failingFor(60), failingSince: failingFor(3 + 4) } });
    const freshAdd = await thrown(() => domains.addDomain(newWs.id, freshHost, `owner@${TAG}-new.example`));
    ok("an address stopped only days ago: another workspace can't add it (still reserved)", freshAdd === "That address is already used by another workspace.", freshAdd ?? "added");
    const staleRow = await domains.addDomain(newWs.id, staleHost, `owner@${TAG}-new.example`);
    ok("  one stopped for over 14 days: another workspace may add it, waiting for its proof", staleRow.status === "PENDING");
    const unproved = await domains.checkDomain(staleRow.id, { now });
    ok("  without its TXT record the stopped one stays where it was", !unproved.passed && (await control.tenantDomain.count({ where: { tenantId: oldWs.id, host: staleHost } })) === 1);
    dns.txt.set(`_domain-verify.${staleHost}`, [[`domain-verify=${staleRow.verifyToken}`]]);
    dns.cname.set(staleHost, [routingTarget(newWs.slug)]);
    mail.length = 0;
    const proved = await domains.checkDomain(staleRow.id, { now, actor: "zzl3" });
    const moved = await control.tenantDomain.findMany({ where: { host: staleHost }, select: { tenantId: true, status: true } });
    ok("with a fresh TXT proof: it goes live on the new workspace, and the old one's row is gone", proved.outcome === "verified" && moved.length === 1 && moved[0]!.tenantId === newWs.id && moved[0]!.status === "ACTIVE", { outcome: proved.outcome, moved });
    ok("  the old workspace's owner is told", mail.some((m) => m.to === `owner@${TAG}-old.example` && m.subject.includes(staleHost)), mail);
    ok("  and the take-over is in the platform log against the old workspace", (await control.platformAuditLog.count({ where: { tenantId: oldWs.id, action: "tenant.domain.taken-over" } })) === 1);
    // A waiting row on the recently stopped address (made before it stopped, say): proving it still can't take it.
    const waiting = await control.tenantDomain.create({ data: { tenantId: newWs.id, host: freshHost, kind: "CUSTOM", status: "PENDING", verifyToken: "new-token-2" } });
    dns.txt.set(`_domain-verify.${freshHost}`, [["domain-verify=new-token-2"]]);
    dns.cname.set(freshHost, [routingTarget(newWs.slug)]);
    const notYet = await domains.checkDomain(waiting.id, { now });
    ok("  proving an address stopped only days ago: 'taken', and it stays the old workspace's", notYet.outcome === "taken" && (await control.tenantDomain.findMany({ where: { host: freshHost } })).every((d) => d.tenantId === oldWs.id), notYet.outcome);
    domains.setTestDomainResolver(null);

    // ─── P6 ─────────────────────────────────────────────────────────────────────────────────────
    section("P6: strangers can't lock a staff member with an authenticator out");
    const secret = authenticator.generateSecret();
    const password = `Zz-${randomBytes(9).toString("base64url")}`;
    await control.platformUser.create({ data: { email: staffEmail, name: "ZZL3 Owner", role: "OWNER", passwordHash: await bcrypt.hash(password, 10), totpSecretCipher: sealForPlatform("staff-totp", secret), totpEnabledAt: new Date() } });
    await settings.setSetting("staff.twoFactor", "required", "script:check-audit-lows-platform");
    lockout.resetLockouts();
    totp.forgetUsedTotpSteps();
    const from = (ip: string) => (requestHeaders = new Headers({ host: "localhost:3000", "x-forwarded-for": ip }));
    const strangers = async () => {
      for (let i = 0; i < lockout.MAX_FAILURES; i++) {
        from(`198.51.100.${10 + i}`);
        await staffSession.signInStaff({ email: staffEmail, password: "wrong-guess", code: "123456" });
      }
    };
    await strangers();
    ok("eight wrong passwords from eight addresses lock the account key", lockout.lockoutState([`console|account:${staffEmail}`]).lockedOut);
    from("203.0.113.50");
    jar.clear();
    const realOne = await staffSession.signInStaff({ email: staffEmail, password, code: authenticator.generate(secret) });
    ok("  the staff member, with the right password AND a right code: signed in all the same", realOne.ok, realOne);
    ok("  (a console session cookie was set)", jar.size === 1);
    totp.forgetUsedTotpSteps();
    lockout.resetLockouts();
    await strangers();
    from("203.0.113.51");
    const noCode = await staffSession.signInStaff({ email: staffEmail, password });
    ok("  the right password without a code: the lock's words", !noCode.ok && /Too many attempts/.test(noCode.error), noCode);
    const wrongCode = await staffSession.signInStaff({ email: staffEmail, password, code: "000000" });
    const wrongPassword = await staffSession.signInStaff({ email: staffEmail, password: "still-wrong", code: authenticator.generate(secret) });
    ok("  a wrong code and a wrong password say the same (the lock's words) — nothing learned", !wrongCode.ok && !wrongPassword.ok && wrongCode.error === wrongPassword.error && /Too many attempts/.test(wrongCode.error), { wrongCode, wrongPassword });
    lockout.resetLockouts();
    totp.forgetUsedTotpSteps();
    from("203.0.113.60");
    for (let i = 0; i < lockout.MAX_FAILURES; i++) await staffSession.signInStaff({ email: `nobody@${TAG}.invalid`, password: "x", code: "123456" });
    const fromLockedCaller = await staffSession.signInStaff({ email: staffEmail, password, code: authenticator.generate(secret) });
    ok("a caller that has failed eight times itself is still refused, right password and code or not", !fromLockedCaller.ok && /Too many attempts/.test(fromLockedCaller.error), fromLockedCaller);
    lockout.resetLockouts();

    const envExample = readFileSync(path.join(__dirname, "..", "deploy", "azure", "env.example"), "utf8");
    ok("deploy/azure/env.example names PLATFORM_CONSOLE_IP_ALLOWLIST and TLS_ASK_SECRET", envExample.includes("PLATFORM_CONSOLE_IP_ALLOWLIST") && envExample.includes("TLS_ASK_SECRET"));

    // ─── O6 ─────────────────────────────────────────────────────────────────────────────────────
    section("O6: portal links hashed and sealed; links made before still work");
    const admin = await db.user.findFirst({ where: { isSuperAdmin: true, active: true }, select: { id: true, name: true, email: true, role: true } });
    if (!admin) throw new Error("Seed the app first — this needs a super admin.");
    actor = { id: admin.id, name: admin.name, email: admin.email, role: String(admin.role) };
    const company = await db.company.create({
      data: { name: `ZZL3 Portal ${Date.now()}`, normalizedName: `zzl3 portal ${Date.now()}`, relationshipType: "CLIENT", portalEnabled: true, createdById: admin.id },
      select: { id: true },
    });
    companyIds.push(company.id);
    const portalOn = { enabled: true, access: "SELECTED" as const, showSubscriptions: true, showInvoices: true, showPayments: false, showTickets: true, showAssets: false, showContacts: false, allowRenewalRequest: true, allowSeatRequest: true, allowQuestion: true, linkValidityDays: null, requireCode: false };
    await db.portalSettings.upsert({ where: { id: "global" }, create: { id: "global", ...portalOn }, update: portalOn });

    // A link written before the migration: the plain token only. The migration's own backfill, then a visit.
    const oldToken = randomBytes(24).toString("base64url");
    const oldRow = await db.$queryRaw<{ id: string }[]>`INSERT INTO "portal_logins" ("id", "token", "companyId", "personName", "createdAt", "visits") VALUES (${`zzl3-${randomBytes(6).toString("hex")}`}, ${oldToken}, ${company.id}, 'ZZL3 Old', now(), 0) RETURNING "id"`;
    const migration = readFileSync(path.join(__dirname, "..", "prisma", "migrations", "20261213210000_token_hashes", "migration.sql"), "utf8");
    const backfills = migration.split(";").map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter((s) => s.startsWith("UPDATE"));
    ok("the migration fills in hashes for both tables", backfills.length === 2 && backfills.some((s) => s.includes("portal_logins")) && backfills.some((s) => s.includes("visitor_kiosks")));
    const beforeBackfill = await portalPublic.openPortal(oldToken);
    ok("a link from before, its hash not filled in yet (an old release wrote it): works by its plain token", beforeBackfill !== null);
    for (const sql of backfills) await db.$executeRawUnsafe(sql);
    const backfilled = await db.portalLogin.findUniqueOrThrow({ where: { id: oldRow[0]!.id }, select: { tokenHash: true } });
    ok("  the migration's backfill gives it the hash the app looks up", backfilled.tokenHash === linkToken.tokenHash(oldToken));
    await db.portalLogin.update({ where: { id: oldRow[0]!.id }, data: { token: null }, select: { id: true } });
    ok("  and it still works found by the hash alone (its plain token cleared to prove it)", (await portalPublic.openPortal(oldToken)) !== null);
    await db.portalLogin.update({ where: { id: oldRow[0]!.id }, data: { token: oldToken }, select: { id: true } });

    const created = await portal.createPortalLogin({ companyId: company.id, personName: "ZZL3 New" });
    ok("a new link is made", created.ok, created.ok ? "" : created.error);
    const newToken = created.ok ? created.data.url.replace("/portal/", "") : "";
    const stored = created.ok ? await db.portalLogin.findUniqueOrThrow({ where: { id: created.data.id }, select: { token: true, tokenHash: true, tokenCipher: true } }) : null;
    ok("  stored without the token in clear: its hash, and a sealed copy", !!stored && stored.token === null && stored.tokenHash === linkToken.tokenHash(newToken) && !!stored.tokenCipher && !stored.tokenCipher.includes(newToken));
    ok("  the sealed copy opens to the token", !!stored?.tokenCipher && (await decryptSecret(stored.tokenCipher)) === newToken);
    ok("  the link works", (await portalPublic.openPortal(newToken)) !== null);
    const listed = await portal.portalLogins(company.id);
    const urls = listed.ok ? listed.data.map((r) => r.url) : [];
    ok("  staff can copy both links again from the list", urls.includes(`/portal/${newToken}`) && urls.includes(`/portal/${oldToken}`), urls);
    ok("  a made-up token, or the hash itself, opens nothing", (await portalPublic.openPortal(randomBytes(24).toString("base64url"))) === null && (await portalPublic.openPortal(stored?.tokenHash ?? "x")) === null);
    if (created.ok) await portal.revokePortalLogin({ loginId: created.data.id });
    ok("  revoked, it stops", (await portalPublic.openPortal(newToken)) === null);

    section("O6: reception-desk (kiosk) links");
    const oldKioskToken = randomBytes(24).toString("base64url");
    await db.$executeRaw`INSERT INTO "visitor_kiosks" ("id", "name", "token", "active", "createdAt", "updatedAt") VALUES (${`zzl3-${randomBytes(6).toString("hex")}`}, 'ZZL3 Old desk', ${oldKioskToken}, true, now(), now())`.catch(async () => {
      await db.$executeRaw`INSERT INTO "visitor_kiosks" ("id", "name", "token", "active", "createdAt") VALUES (${`zzl3-${randomBytes(6).toString("hex")}`}, 'ZZL3 Old desk', ${oldKioskToken}, true, now())`;
    });
    ok("a desk from before the migration: works by its plain token", (await visitorPublic.kioskDirectory(oldKioskToken)) !== null);
    for (const sql of backfills) await db.$executeRawUnsafe(sql);
    ok("  after the backfill, its hash is the app's, and it still works", (await db.visitorKiosk.findFirstOrThrow({ where: { name: "ZZL3 Old desk" }, select: { tokenHash: true } })).tokenHash === linkToken.tokenHash(oldKioskToken) && (await visitorPublic.kioskDirectory(oldKioskToken)) !== null);
    const desk = await visitor.saveKiosk({ name: "ZZL3 New desk" });
    ok("a new desk is set up", desk.ok, desk.ok ? "" : desk.error);
    const kiosks = (await visitor.listKiosks()) ?? [];
    const deskToken = kiosks.find((k) => k.name === "ZZL3 New desk")?.token ?? "";
    const deskRow = await db.visitorKiosk.findFirstOrThrow({ where: { name: "ZZL3 New desk" }, select: { id: true, token: true, tokenHash: true, tokenCipher: true } });
    ok("  stored as its hash and a sealed copy; the list shows its link again", deskRow.token === null && deskRow.tokenHash === linkToken.tokenHash(deskToken) && !!deskRow.tokenCipher && deskToken.length >= 20);
    ok("  the tablet opens with it", (await visitorPublic.kioskDirectory(deskToken)) !== null);
    ok("  the older desk's link is listed as it was", kiosks.find((k) => k.name === "ZZL3 Old desk")?.token === oldKioskToken);
    const rotated = await visitor.rotateKioskToken(deskRow.id);
    ok("rotating: the old link stops, the new one works, nothing in clear", rotated.ok && (await visitorPublic.kioskDirectory(deskToken)) === null && (await visitorPublic.kioskDirectory(rotated.data.token)) !== null && (await db.visitorKiosk.findUniqueOrThrow({ where: { id: deskRow.id }, select: { token: true } })).token === null);
    const oldDeskId = (await db.visitorKiosk.findFirstOrThrow({ where: { name: "ZZL3 Old desk" }, select: { id: true } })).id;
    const rotatedOld = await visitor.rotateKioskToken(oldDeskId);
    ok("  rotating an older desk takes its plain token away too", rotatedOld.ok && (await db.visitorKiosk.findUniqueOrThrow({ where: { id: oldDeskId }, select: { token: true } })).token === null && (await visitorPublic.kioskDirectory(oldKioskToken)) === null);

    section("O6: a TV's secret waits for it sealed");
    const pairing = async (secretValue: string | null, screenId: string | null) => {
      const key = randomBytes(32).toString("base64url");
      const code = String(randomInt(100000, 999999));
      tvCodes.push(code);
      await db.tvPairing.create({ data: { code, deviceKeyHash: tvScreens.hashSecret(key), expiresAt: new Date(Date.now() + 10 * 60_000), screenId, secret: secretValue } });
      return { key, code };
    };
    jar.clear();
    const legacySecret = randomBytes(32).toString("base64url");
    const legacy = await pairing(legacySecret, `${TAG}-screen`);
    jar.set(tvScreens.TV_PAIR_COOKIE, legacy.key);
    ok("a pairing made before (its secret in clear): the TV still collects it", (await tvScreens.collectPairing()) === "PAIRED" && jar.get(tvScreens.TV_COOKIE) === legacySecret);
    jar.clear();
    const fresh = await pairing(null, null);
    const screen = await tvScreens.pairScreen({ code: fresh.code, name: "ZZL3 Screen", branchId: null, pairedById: admin.id });
    const waitingSecret = (await db.tvPairing.findUniqueOrThrow({ where: { code: fresh.code }, select: { secret: true } })).secret ?? "";
    ok("a new pairing keeps the secret sealed (not the screen's key in clear)", !!screen && waitingSecret.split(":").length === 3);
    jar.set(tvScreens.TV_PAIR_COOKIE, fresh.key);
    const collected = await tvScreens.collectPairing();
    const tvCookie = jar.get(tvScreens.TV_COOKIE) ?? "";
    const screenRow = screen ? await db.tvScreen.findUniqueOrThrow({ where: { id: screen.id }, select: { tokenHash: true } }) : null;
    ok("  the TV collects the real secret, and it is its screen's", collected === "PAIRED" && !!tvCookie && !tvCookie.includes(":") && screenRow?.tokenHash === tvScreens.hashSecret(tvCookie));

    // ─── O7 ─────────────────────────────────────────────────────────────────────────────────────
    section("O7: the Outlook signature endpoint doesn't say who works here");
    await db.signatureSettings.upsert({ where: { id: "global" }, create: { id: "global", outlookOn: true }, update: { outlookOn: true } });
    outlook.resetOutlookMisses();
    const nobody = await outlook.outlookSignature(`nobody@${TAG}.invalid`, "caller-a");
    ok("an address that is nobody's: 200 and an empty signature, like a person with none", nobody.status === 200 && JSON.stringify(nobody) === JSON.stringify(outlook.NO_SIGNATURE), nobody);
    for (let i = 0; i < 30; i++) await outlook.outlookSignature(`guess${i}@${TAG}.invalid`, null);
    ok("  callers whose address is unknown share no bucket: thirty misses don't stop the next", (await outlook.outlookSignature(`guess-next@${TAG}.invalid`, null)).status === 200);
    for (let i = 0; i < 25; i++) await outlook.outlookSignature(`guess${i}@${TAG}.invalid`, "caller-guessing");
    ok("  a known caller guessing is still stopped after twenty", (await outlook.outlookSignature(`guess-more@${TAG}.invalid`, "caller-guessing")).status === 429);
    outlook.resetOutlookMisses();

    // ─── O8 ─────────────────────────────────────────────────────────────────────────────────────
    section("O8: poll answers only from the poll");
    const msgToken = randomBytes(24).toString("base64url");
    const msg = await db.marketingMessage.create({
      data: { token: msgToken, companyId: company.id, body: expandWidgets("<p>Hello. Unsubscribe here. Great deals inside.</p>{{poll How did we do? | Great | Okay}}", "HTML", { origin: ORIGIN, token: msgToken }), scheduledFor: new Date(), status: "SENT" },
      select: { id: true },
    });
    messageIds.push(msg.id);
    ok("one of its answers counts", await polls.answerPoll(msgToken, "How did we do?", "Great"));
    ok("  other words of the email don't (before: anything found in it did)", !(await polls.answerPoll(msgToken, "How did we do?", "Unsubscribe")) && !(await polls.answerPoll(msgToken, "How did we do?", "deals")));
    ok("  nor a question made of the email's words", !(await polls.answerPoll(msgToken, "Hello", "Great")));
    ok("  and the answer kept is the real one", (await db.emailPollAnswer.findFirst({ where: { messageId: msg.id }, select: { answer: true } }))?.answer === "Great");
  } finally {
    actor = null;
    setTestPlatformMailer(null);
    domains.setTestDomainResolver(null);
    lockout.resetLockouts();
    totp.forgetUsedTotpSteps();
    await settings.setSetting("staff.twoFactor", settingBefore, "script:check-audit-lows-platform").catch((err) => console.error("restoring staff.twoFactor:", err));
    if (portalSettingsBefore) {
      const { id: _id, ...rest } = portalSettingsBefore as Record<string, unknown> & { id: string };
      void _id;
      await db.portalSettings.update({ where: { id: "global" }, data: rest as never }).catch(() => undefined);
    } else await db.portalSettings.deleteMany({ where: { id: "global" } });
    if (signatureBefore) await db.signatureSettings.update({ where: { id: "global" }, data: { outlookOn: signatureBefore.outlookOn } }).catch(() => undefined);
    else await db.signatureSettings.deleteMany({ where: { id: "global" } }).catch(() => undefined);
    await cleanupWorkspace().catch((err) => console.error("workspace clean-up:", err));
    await cleanupControl().catch((err) => console.error("control clean-up:", err));
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
