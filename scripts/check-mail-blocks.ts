/**
 * check:mail-blocks — who no mail goes to (owner, 31 Oct 2026):
 *
 *   · a workspace's own blocks (src/lib/mail-blocks.ts, Settings › Blocked addresses): an address or a whole domain
 *     with its subdomains, from all mail or from marketing and reminders only — refused where every email leaves,
 *     the workspace's providers and Deskzo's mailer alike, saying who blocked it and when;
 *   · the platform's own list (src/lib/platform/mail/suppressions.ts): a hard bounce on Deskzo's servers recorded by
 *     a hash, and the address not mailed again from anywhere until it expires;
 *   · the queue: a message to an address that can't receive mail is Failed and its contact's email marked Invalid.
 *
 * On the local workspace (DESKZO_TENANCY_FALLBACK) with its own zz rows, removed at the end, and a scratch control
 * plane, dropped at the end. DNS is stood in for; nothing is sent.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const withDatabase = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

const TAG = "zzblk";
let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, useRouter: () => ({ refresh() {}, push() {}, replace() {} }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() };
  }
  // The console page, rendered as staff without a staff sign-in.
  if (request === "@/lib/platform/console-page" || request.endsWith("lib/platform/console-page")) return { consoleStaff: async () => ({ id: "zz-staff", role: "OWNER" }) };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    const user = async () => ({ id: actorId, role: "ADMIN", name: "Zz Blocker", email: `admin@${TAG}.example` });
    return { ...real, requireUser: user, currentUser: user, refuseWhileViewingAs: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  const url = process.env.DATABASE_URL!;
  if (!["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname)) throw new Error("not a local database");
  const db = directClient(url);
  const controlName = `${new URL(url).pathname.slice(1)}_mailblk_control`;
  const controlUrl = withDatabase(url, controlName);
  const admin = directClient(withDatabase(url, "postgres"));

  const clean = async () => {
    const contacts = await db.contact.findMany({ where: { email: { contains: TAG } }, select: { id: true } });
    await db.marketingMessage.deleteMany({ where: { OR: [{ contactId: { in: contacts.map((c) => c.id) } }, { toEmail: { contains: TAG } }] } });
    await db.contact.deleteMany({ where: { id: { in: contacts.map((c) => c.id) } } });
    await db.company.deleteMany({ where: { name: { startsWith: "Zz Blk" } } });
    await db.suppression.deleteMany({ where: { value: { contains: TAG } } });
    await db.auditLog.deleteMany({ where: { entityType: "Suppression", entityId: { contains: TAG } } });
  };

  try {
    section("The rules");
    const rules = await import("../src/lib/mail-block-rules");
    ok("a domain and those above it, down to two labels", JSON.stringify(rules.domainAndParents("a.b.acme.co.in")) === JSON.stringify(["a.b.acme.co.in", "b.acme.co.in", "acme.co.in", "co.in"]));
    ok("acme.com covers itself and mail.acme.com — not notacme.com", rules.domainCovers("acme.com", "acme.com") && rules.domainCovers("acme.com", "mail.in.acme.com") && !rules.domainCovers("acme.com", "notacme.com") && !rules.domainCovers("acme.com", null));
    const typed = ["@Acme.com", "https://www.acme.com/contact?x=1", " ravi@ACME.com ", "acme.com."].map((t) => rules.readBlockValue("DOMAIN", t));
    ok("a domain read the way people paste it", typed.every((r) => r.ok && r.value === "acme.com"), typed);
    ok("  a whole country's suffix refused", !rules.readBlockValue("DOMAIN", "co.in").ok && !rules.readBlockValue("DOMAIN", "gov.in").ok);
    ok("  not a domain refused", !rules.readBlockValue("DOMAIN", "acme").ok && !rules.readBlockValue("DOMAIN", "ac me.com").ok);
    const email = rules.readBlockValue("EMAIL", " Ravi@Acme.COM ");
    ok("an address, lowercased; not one refused", email.ok && email.value === "ravi@acme.com" && !rules.readBlockValue("EMAIL", "ravi@").ok);

    section("A scratch control plane");
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${controlName}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: controlUrl }, timeout: 5 * 60_000 });
    process.env.CONTROL_DATABASE_URL = controlUrl;
    // Deskzo's mailer with no account and no server: development's outbox, so nothing is sent.
    process.env.PLATFORM_SMTP_URL = "";
    ok("built from the migrations", true);

    await clean();
    const superAdmin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true, name: true } });
    if (!superAdmin) throw new Error("the workspace has no super admin");
    actorId = superAdmin.id;
    const gate = await import("../src/lib/mail-address-gate");
    gate.setTestMailDomains((d) => !d.includes("gone"));

    section("A workspace's blocks, from Settings");
    const actions = await import("../src/actions/mail-blocks");
    const addDomain = await actions.addMailBlock({ scope: "DOMAIN", value: `https://www.${TAG}-acme.example/contact`, allMail: true, note: "No longer a customer." });
    ok("a whole domain, from all mail — read from a pasted link", addDomain.ok && addDomain.data.value === `${TAG}-acme.example`, addDomain);
    const addOne = await actions.addMailBlock({ scope: "EMAIL", value: `Ravi@${TAG}-solo.example`, allMail: true });
    const addSoft = await actions.addMailBlock({ scope: "EMAIL", value: `offers@${TAG}-soft.example`, allMail: false });
    ok("an address from all mail; another from marketing and reminders only", addOne.ok && addSoft.ok);
    ok("  a country's suffix is refused", !(await actions.addMailBlock({ scope: "DOMAIN", value: "co.in", allMail: true })).ok);
    const listed = await actions.listMailBlocks();
    const mine = listed.ok ? listed.data.rows.filter((r) => r.value.includes(TAG)) : [];
    ok("the list shows the three, who and what each stops", listed.ok && listed.data.allMailReady && mine.length === 3 && mine.filter((r) => r.allMail).length === 2 && mine.every((r) => r.by === superAdmin.name), mine);
    ok("  audited", (await db.auditLog.count({ where: { entityType: "Suppression", entityId: { contains: TAG } } })) === 3);

    const blocks = await import("../src/lib/mail-blocks");
    const sub = await blocks.allMailBlockFor([`priya@sales.in.${TAG}-acme.example`]);
    ok("a subdomain of a blocked domain is blocked", sub?.scope === "DOMAIN" && sub.value === `${TAG}-acme.example`, sub);
    const sentence = sub ? await blocks.blockSentence(sub) : "";
    ok("  saying which domain, who and where", sentence.includes(`${TAG}-acme.example was blocked by ${superAdmin.name} on `) && sentence.includes("Settings › Blocked addresses"), sentence);
    ok("the address blocked, in any case", (await blocks.allMailBlockFor([`RAVI@${TAG}-solo.example`]))?.scope === "EMAIL");
    ok("marketing-only and unblocked addresses: not blocked from all mail", (await blocks.allMailBlockFor([`offers@${TAG}-soft.example`, `someone@${TAG}-free.example`])) === null);
    ok("one blocked among several: found", (await blocks.allMailBlockFor([`someone@${TAG}-free.example`, `x@${TAG}-acme.example`]))?.address === `x@${TAG}-acme.example`);

    section("Refused where mail leaves");
    const { providerByKey } = await import("../src/lib/marketing/providers");
    const config = { id: "x", fromEmail: "billing@zzmail.example", fromName: null, replyTo: null, credentials: {} } as never;
    const viaSmtp = await providerByKey.smtp!.send({ to: `someone@${TAG}-free.example`, cc: [`accounts@mail.${TAG}-acme.example`], subject: "Invoice", html: "<p>x</p>" }, config);
    ok("an invoice copied to a blocked domain: refused for good, saying why", !viaSmtp.ok && !viaSmtp.retryable && /^Not sent: accounts@mail\.zzblk-acme\.example is blocked from all mail/.test(viaSmtp.error), viaSmtp);
    const viaMock = await providerByKey.mock!.send({ to: `ravi@${TAG}-solo.example`, subject: "Quote", html: "<p>x</p>" }, config);
    ok("  the mock too — a block is every kind of mail", !viaMock.ok && /blocked from all mail/.test(viaMock.error), viaMock);
    const free = await providerByKey.mock!.send({ to: `offers@${TAG}-soft.example`, subject: "Invoice", html: "<p>x</p>" }, config);
    ok("  marketing-only: their invoice still goes", free.ok, free);
    const mailer = await import("../src/lib/platform/mailer");
    const viaDeskzo = await mailer.deliverMail({ type: "DOCUMENTS", to: `ravi@${TAG}-solo.example`, subject: "Your invoice", text: "Attached." }).catch((e: Error & { responseCode?: number }) => e);
    ok("a document sent through Deskzo: refused as a 550, before the outbox", viaDeskzo instanceof Error && viaDeskzo.responseCode === 550 && /blocked from all mail/.test(viaDeskzo.message), viaDeskzo instanceof Error ? viaDeskzo.message : viaDeskzo);

    const reach = await actions.setMailBlockReach(mine.find((r) => r.value === `ravi@${TAG}-solo.example`)!.id, false);
    ok("turned to marketing and reminders only: the quote goes again", reach.ok && (await providerByKey.mock!.send({ to: `ravi@${TAG}-solo.example`, subject: "Quote", html: "<p>x</p>" }, config)).ok);
    const removed = await actions.removeMailBlock(mine.find((r) => r.scope === "DOMAIN")!.id);
    ok("a domain unblocked: gone, mail goes", removed.ok && !removed.data.kept && (await blocks.allMailBlockFor([`x@${TAG}-acme.example`])) === null);
    await db.suppression.create({ data: { scope: "EMAIL", value: `left@${TAG}-unsub.example`, reason: "UNSUBSCRIBED", allMail: true } });
    const unsubRow = (await actions.listMailBlocks());
    const unsub = unsubRow.ok ? unsubRow.data.rows.find((r) => r.value === `left@${TAG}-unsub.example`) : undefined;
    const kept = unsub ? await actions.removeMailBlock(unsub.id) : null;
    ok("an unsubscribe blocked from all mail, unblocked: the unsubscribe stays theirs", !!kept?.ok && kept.data.kept && (await db.suppression.findFirst({ where: { value: `left@${TAG}-unsub.example` } }))?.reason === "UNSUBSCRIBED");

    section("The pages");
    const { renderHtml } = await import("./lib/render-html");
    const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
    await actions.addMailBlock({ scope: "DOMAIN", value: `${TAG}-shown.example`, allMail: true, note: "Shown on the page." });
    const settingsPage = (await import("../src/app/(dashboard)/settings/blocked-addresses/page")).default;
    const shown = text(await renderHtml(settingsPage()));
    ok("Settings › Blocked addresses: the domain, what it stops, why, who", shown.includes("Blocked addresses") && shown.includes(`${TAG}-shown.example`) && shown.includes("Whole domain, with its subdomains") && shown.includes("Nothing goes to them") && shown.includes("Shown on the page.") && shown.includes(superAdmin.name), shown.slice(0, 600));
    ok("  and the button to block another", shown.includes("Block an address or domain"));
    const consolePage = (await import("../src/app/platform-console/(console)/mail/suppressions/page")).default;
    const consoleHtml = text(await renderHtml(consolePage()));
    ok("the console's Suppressed page: the counts, the look-up, nobody yet", consoleHtml.includes("Suppressed addresses") && consoleHtml.includes("0 bounced for good (kept 90 days)") && consoleHtml.includes("Look up an address") && consoleHtml.includes("Nobody on the list."), consoleHtml.slice(0, 600));

    section("The campaign and notice lists cover subdomains too");
    await actions.addMailBlock({ scope: "DOMAIN", value: `${TAG}-camp.example`, allMail: false });
    const company = await db.company.create({ data: { name: "Zz Blk Campaign Co", normalizedName: "zz blk campaign co", createdById: actorId }, select: { id: true } });
    const pipeline = await import("../src/lib/marketing/pipeline");
    // The lookup pipeline.ts and order-notice.ts make: the address's domain and its parents, matched by domainCovers.
    const rows = await db.suppression.findMany({ where: { scope: "DOMAIN", value: { in: rules.domainAndParents(`mail.${TAG}-camp.example`) } }, select: { value: true } });
    ok("a contact at mail.<domain> meets the domain's block", rows.some((r) => rules.domainCovers(r.value, `mail.${TAG}-camp.example`)), rows);

    section("The queue: an address that can't receive mail");
    const othersDue = await db.marketingMessage.count({ where: { status: "QUEUED", scheduledFor: { lte: new Date() } } });
    if (othersDue > 0) {
      console.log(`  (skipped — ${othersDue} real message(s) are queued and due, and this check never sends those)`);
    } else {
      const gone = await db.contact.create({ data: { companyId: company.id, name: "Zz Gone", email: `ravi@${TAG}-gone.example`, emailStatus: "UNCHECKED" }, select: { id: true } });
      const msg = await db.marketingMessage.create({
        data: { token: `${TAG}-${Date.now()}`, companyId: company.id, contactId: gone.id, channel: "EMAIL", messageClass: "TRANSACTIONAL", subject: "Your renewal", body: "<p>x</p>", toEmail: `ravi@${TAG}-gone.example`, scheduledFor: new Date(Date.now() - 1000), status: "QUEUED" },
        select: { id: true },
      });
      const providers = await db.messagingProvider.findMany({ where: { kind: "EMAIL", enabled: true, key: { not: "mock" } }, select: { key: true, classes: true } });
      if (!providers.some((p) => (p.classes as string[]).includes("TRANSACTIONAL"))) {
        console.log("  (skipped — no real email provider here takes transactional mail, so the queue would never reach the check)");
      } else {
        const tick = await pipeline.sendQueued(`${TAG}-run`);
        const after = await db.marketingMessage.findUnique({ where: { id: msg.id }, select: { status: true, error: true } });
        const marked = await db.contact.findUnique({ where: { id: gone.id }, select: { emailStatus: true, emailCheckedValue: true, emailCheckMethod: true, emailCheckDetail: true } });
        ok("the message: Failed, saying why, never handed to a provider", tick.failed >= 1 && after?.status === "FAILED" && /^Not sent: zzblk-gone\.example doesn't exist/.test(after.error ?? ""), after);
        ok("  and the contact's email badge: Invalid, for this address", marked?.emailStatus === "INVALID" && marked.emailCheckedValue === `ravi@${TAG}-gone.example` && marked.emailCheckMethod === "AUTOMATIC" && !!marked.emailCheckDetail, marked);
      }
    }

    section("The platform's own list");
    const sup = await import("../src/lib/platform/mail/suppressions");
    const bounce = Object.assign(new Error("Can't send mail - all recipients were rejected: 550 5.1.1 <nobody@zzbounce.example>: Recipient address rejected: User unknown"), { responseCode: 550 });
    ok("a 550 5.1.1 for the one recipient: a hard bounce", JSON.stringify(sup.hardBounced(bounce, ["nobody@zzbounce.example"])) === JSON.stringify(["nobody@zzbounce.example"]));
    ok("  with several recipients, only those the server named", sup.hardBounced(Object.assign(bounce, { rejected: ["nobody@zzbounce.example"] }), ["a@zzmail.example", "nobody@zzbounce.example"]).join() === "nobody@zzbounce.example");
    ok("  a policy refusal, a full mailbox, a 4xx: not a bounce", sup.hardBounced(Object.assign(new Error("550 5.7.1 Relaying denied"), { responseCode: 550 }), ["a@x.example"]).length === 0 && sup.hardBounced(Object.assign(new Error("552 5.2.2 Mailbox full"), { responseCode: 552 }), ["a@x.example"]).length === 0 && sup.hardBounced(Object.assign(new Error("451 4.1.1 try later"), { responseCode: 451 }), ["a@x.example"]).length === 0);

    const t0 = new Date();
    await sup.recordPlatformSuppression("Nobody@ZZBounce.example", "HARD_BOUNCE", "550 5.1.1 <nobody@zzbounce.example>: User unknown", t0);
    const control = (await import("../src/lib/platform/control-db")).controlDb();
    const row = await control.platformMailSuppression.findFirst();
    ok("recorded by a hash, never the address — the server's words without it either", !!row && row.addressHash === sup.addressHash("nobody@zzbounce.example") && !JSON.stringify(row).toLowerCase().includes("nobody@zzbounce") && row.detail?.includes("<address>") === true, row);
    ok("  kept 90 days", !!row && Math.round((row.expiresAt.getTime() - t0.getTime()) / 86_400_000) === 90);
    const stop = await mailer.deliverMail({ type: "ACCOUNT", to: "nobody@zzbounce.example", subject: "Your code", text: "123456" }).catch((e: Error & { responseCode?: number }) => e);
    ok("Deskzo's mail to it — from any workspace, or none — refused as a 550, saying until when", stop instanceof Error && stop.responseCode === 550 && /bounced mail from Deskzo for good/.test(stop.message) && /isn't mailed again until/.test(stop.message), stop instanceof Error ? stop.message : stop);
    ok("  counted as a send stopped", (await control.platformMailSuppression.findFirst())?.stopped === 1);
    ok("a workspace's own provider doesn't ask it — its own reputation, its own list", (await providerByKey.mock!.send({ to: "nobody@zzbounce.example", subject: "s", html: "h" }, config)).ok);
    await sup.recordPlatformSuppression("nobody@zzbounce.example", "COMPLAINT", null, t0);
    await sup.recordPlatformSuppression("nobody@zzbounce.example", "HARD_BOUNCE", null, t0);
    const twice = await control.platformMailSuppression.findFirst();
    ok("a complaint outranks a bounce, and stays a year; hits counted", twice?.reason === "COMPLAINT" && twice.hits === 3 && Math.round((twice.expiresAt.getTime() - t0.getTime()) / 86_400_000) === 365, twice);
    ok("expired: mailed again", (await sup.platformSuppressionFor(["nobody@zzbounce.example"], new Date(t0.getTime() + 366 * 86_400_000))) === null);
    ok("  and cleared on the tick", (await sup.purgePlatformSuppressions(new Date(t0.getTime() + 366 * 86_400_000))) === 1 && (await control.platformMailSuppression.count()) === 0);

    // A real bounce from the server, recorded where it happens.
    process.env.PLATFORM_SMTP_URL = "smtp://zzmail.example";
    const store = await import("../src/lib/platform/mail/store");
    store.setTestMailTransport(() => ({ sendMail: async () => Promise.reject(Object.assign(new Error("550 5.1.1 The email account that you tried to reach does not exist"), { responseCode: 550 })) }) as never);
    await mailer.deliverMail({ type: "ACCOUNT", to: "typo@zzmail.example", subject: "Your code", text: "1" }).catch(() => null);
    store.setTestMailTransport(null);
    process.env.PLATFORM_SMTP_URL = "";
    ok("the server's own 550 5.1.1: on the list at once", (await sup.platformSuppressionOf("typo@zzmail.example"))?.reason === "HARD_BOUNCE");
    ok("  taken off when the customer fixes it", (await sup.removePlatformSuppression("TYPO@zzmail.example")) && (await sup.platformSuppressionOf("typo@zzmail.example")) === null);
  } finally {
    await clean().catch((err) => console.error("clean-up:", err));
    await db.$disconnect();
    const { closeControlDb } = await import("../src/lib/platform/control-db");
    await closeControlDb().catch(() => null);
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`).catch(() => null);
    await admin.$disconnect();
  }
  console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll mail block checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
