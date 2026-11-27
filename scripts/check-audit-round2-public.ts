/**
 * check:audit-round2-public — the security audit's round two (13 Nov 2026, docs/reports/security-audit-2026-11-11.md
 * section 11), group A: Automate, public intake, booking and the portal. Each fix shown to hold the way it was broken,
 * by calling the server's own code as a hand-made request or a worker would.
 *
 *   R2-09  taking a workflow over cancels its open runs (paths too) and their waits; nothing carries on as the new owner
 *   R2-10  from the lead owner's own mailbox: a saved template, to that lead's contact, nobody copied — at publish and run
 *   R2-14  a visitor naming a customer we have is an unconfirmed contact there, left out of automatic recipients
 *   R2-15  the booking page's invitation carries a cleaned name, never visitor text; two bookings an address a day
 *   R2-20  twenty wrong portal codes a day pause the link, its account manager told; eight-digit codes
 *   lows   outside-call keys hidden from colleagues and copies; kiosk text capped; an invite code claimed once
 *
 * A fixture of its own in the local database, tagged ZZR2A, removed in a finally; every count is of its own rows.
 *
 *   npx tsx scripts/check-audit-round2-public.ts
 */
import "dotenv/config";
import Module from "node:module";
import { randomBytes } from "node:crypto";

const TAG = "ZZR2A";
const MAIL = "@zzr2a.invalid";
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

// Stubs, before anything that reads them is loaded (hence require below, not import).
let actorId = "";
const jar = new Map<string, string>();
const internals = Module as unknown as { _load(req: string, parent: unknown, isMain: boolean): unknown };
const original = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
  if (request === "next/headers") {
    return {
      cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined), set: (name: string, value: string) => void jar.set(name, value) }),
      headers: async () => new Headers(),
    };
  }
  if (request.endsWith("lib/session") || request === "@/lib/session") {
    const user = async () => ({ id: actorId, name: "Zz Probe", role: "ADMIN" });
    return { requireUser: user, currentUser: user, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return original.call(this, request, parent, isMain);
} as typeof original;

/* eslint-disable @typescript-eslint/no-require-imports */
const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
const store = require("../src/lib/automate/store") as typeof import("../src/lib/automate/store");
const { clearOutsideKeys } = require("../src/lib/automate/blanks") as typeof import("../src/lib/automate/blanks");
const { validateDefinition } = require("../src/lib/automate/validate") as typeof import("../src/lib/automate/validate");
const { emailSend, leadOwnerProblems } = require("../src/lib/automate/actions/email-send") as typeof import("../src/lib/automate/actions/email-send");
const { intakeLead, leadPayloadSchema } = require("../src/lib/lead-capture/intake") as typeof import("../src/lib/lead-capture/intake");
const unconfirmed = require("../src/lib/contacts/unconfirmed") as typeof import("../src/lib/contacts/unconfirmed");
const { confirmWebsiteContact } = require("../src/actions/contact-confirm") as typeof import("../src/actions/contact-confirm");
const booking = require("../src/lib/booking/server") as typeof import("../src/lib/booking/server");
const device = require("../src/lib/portal/device") as typeof import("../src/lib/portal/device");
const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
const kiosk = require("../src/actions/visitor-public") as typeof import("../src/actions/visitor-public");
/* eslint-enable @typescript-eslint/no-require-imports */

async function cleanup() {
  const users = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  const leads = (await db.lead.findMany({ where: { companyId: { in: companies } }, select: { id: true } })).map((l) => l.id);
  await db.automationWorkflow.deleteMany({ where: { name: { contains: TAG } } });
  await db.automationEffect.deleteMany({ where: { key: { startsWith: TAG } } }).catch(() => {});
  const pages = (await db.bookingPage.findMany({ where: { slug: { startsWith: TAG.toLowerCase() } }, select: { id: true } })).map((p) => p.id);
  await db.booking.deleteMany({ where: { pageId: { in: pages } } });
  await db.bookingPage.deleteMany({ where: { id: { in: pages } } });
  const kiosks = (await db.visitorKiosk.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((k) => k.id);
  await db.visitorInvite.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.visitorEntry.deleteMany({ where: { kioskId: { in: kiosks } } });
  await db.visitorKiosk.deleteMany({ where: { id: { in: kiosks } } });
  await db.visitorCompany.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.activity.deleteMany({ where: { leadId: { in: leads } } });
  await db.automationEvent.deleteMany({ where: { recordId: { in: leads } } }).catch(() => {});
  await db.lead.deleteMany({ where: { id: { in: leads } } });
  await db.portalLogin.deleteMany({ where: { companyId: { in: companies } } });
  await db.auditLog.deleteMany({ where: { userId: { in: users } } });
  await db.company.deleteMany({ where: { id: { in: companies } } });
  await db.notification.deleteMany({ where: { userId: { in: users } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
}

async function main() {
  await cleanup();
  try {
    const mk = (name: string) => db.user.create({ data: { name: `Zz ${name}`, email: `${name.toLowerCase()}${MAIL}`, passwordHash: "!", role: "ADMIN" }, select: { id: true, name: true } });
    const ana = await mk("Ana");
    const ben = await mk("Ben");
    actorId = ana.id;
    const clock = await workspaceClock();

    // ── R2-09 ──────────────────────────────────────────────────────────────────────────────────
    section("R2-09: taking a workflow over");
    const draft = {
      schema: 1,
      trigger: { type: "manual" },
      steps: [{ id: "call", type: "action", action: "http.request", input: { method: "POST", url: "https://hooks.example.invalid/T0/zz-secret", headers: { Authorization: "Bearer zz-key" } } }],
    };
    const wf = await db.automationWorkflow.create({ data: { name: `${TAG} flow`, ownerUserId: ana.id, createdById: ana.id, draft }, select: { id: true } });
    let n = 0;
    const run = (status: "QUEUED" | "WAITING" | "RUNNING" | "NEEDS_ATTENTION" | "SUCCEEDED", parentRunId?: string) =>
      db.automationRun.create({ data: { workflowId: wf.id, idempotencyKey: `${TAG}:${(n += 1)}:${randomBytes(4).toString("hex")}`, cursor: {}, contextCipher: "zz", status, ...(parentRunId ? { parentRunId, parentStepKey: "p" } : {}) }, select: { id: true } });
    const queued = await run("QUEUED");
    const waiting = await run("WAITING");
    const running = await run("RUNNING");
    const held = await run("NEEDS_ATTENTION");
    const done = await run("SUCCEEDED");
    const path = await run("WAITING", waiting.id);
    await db.automationEventWait.create({ data: { runId: waiting.id, stepKey: "w", eventType: "lead.created", rules: [], expiresAt: new Date(Date.now() + 86_400_000) } });
    await db.automationEventWait.create({ data: { runId: path.id, stepKey: "w", eventType: "lead.created", rules: [], expiresAt: new Date(Date.now() + 86_400_000) } });
    const taken = await store.takeOverWorkflow(wf.id, ben.id);
    const runs = new Map((await db.automationRun.findMany({ where: { workflowId: wf.id }, select: { id: true, status: true, cancelRequested: true } })).map((r) => [r.id, r]));
    ok("taken over: the new owner's, off until they publish", taken.ok && (await db.automationWorkflow.findUnique({ where: { id: wf.id }, select: { ownerUserId: true, status: true } }))?.ownerUserId === ben.id, taken);
    ok("  queued, waiting and held-for-a-decision runs are cancelled", [queued, waiting, held].every((r) => runs.get(r.id)?.status === "CANCELLED"), [...runs.values()]);
    ok("  a parallel path of a waiting run too", runs.get(path.id)?.status === "CANCELLED");
    ok("  one a worker holds is told to stop at its next step", runs.get(running.id)?.status === "RUNNING" && runs.get(running.id)?.cancelRequested === true);
    ok("  a finished run is left as it was", runs.get(done.id)?.status === "SUCCEEDED");
    ok("  their waits for an event are gone", (await db.automationEventWait.count({ where: { runId: { in: [waiting.id, path.id] } } })) === 0);
    ok("  the count told to the previous owner is the runs stopped", taken.ok && taken.data.cancelledRuns === 5, taken.ok ? taken.data : taken);
    const after = (await db.automationWorkflow.findUnique({ where: { id: wf.id }, select: { draft: true } }))?.draft as typeof draft;
    ok("  and the previous owner's keys for the outside call stay theirs", after.steps[0]!.input.url === "" && after.steps[0]!.input.headers.Authorization === "");

    section("Low: outside-call keys");
    const cleared = clearOutsideKeys(draft);
    ok("a colleague's view of a workflow empties an outside call's address and header values", cleared.cleared === 1 && cleared.definition.steps[0]!.input.url === "" && cleared.definition.steps[0]!.input.method === "POST");
    const mine = await db.automationWorkflow.create({ data: { name: `${TAG} keyed`, ownerUserId: ana.id, createdById: ana.id, draft }, select: { id: true } });
    const copyByBen = await store.duplicateWorkflow(mine.id, ben.id);
    const copyByAna = await store.duplicateWorkflow(mine.id, ana.id);
    const draftOf = async (r: typeof copyByBen) => (r.ok ? ((await db.automationWorkflow.findUnique({ where: { id: r.data.id }, select: { draft: true } }))?.draft as typeof draft) : null);
    ok("  a colleague's copy leaves the keys out", (await draftOf(copyByBen))?.steps[0]!.input.url === "");
    ok("  its owner's own copy keeps them", (await draftOf(copyByAna))?.steps[0]!.input.url === draft.steps[0]!.input.url);
    await db.automationWorkflow.updateMany({ where: { id: { in: [copyByBen, copyByAna].flatMap((c) => (c.ok ? [c.data.id] : [])) } }, data: { name: `${TAG} copy` } });

    // ── R2-14 ──────────────────────────────────────────────────────────────────────────────────
    section("R2-14: a visitor naming a customer we have");
    const existing = await db.company.create({ data: { name: `${TAG} Existing Co`, normalizedName: `${TAG} existing co`.toLowerCase(), createdById: ana.id, ownerUserId: ana.id }, select: { id: true } });
    const real = await db.contact.create({ data: { companyId: existing.id, name: "Zz Real Person", email: `real${MAIL}`, phone: "+919800000001" }, select: { id: true } });
    const key = { id: null, name: `${TAG} form`, sourceLabel: null, createdById: ana.id };
    const visitorEmail = `visitor@zzr2a-elsewhere.invalid`;
    const made = await intakeLead(key, leadPayloadSchema.parse({ name: "Zz Visitor", email: visitorEmail, company: `${TAG} Existing Co`, phone: "+919800000002" }), { ownerUserId: ben.id, notify: false, raisedBy: null });
    const visitor = await db.contact.findFirst({ where: { companyId: existing.id, email: visitorEmail }, select: { id: true, unconfirmedFrom: true } });
    ok("the visitor became a contact of the existing customer, marked as from the website", !!visitor && visitor.unconfirmedFrom === "WEB_FORM", { made, visitor });
    ok("  the customer's own contact is untouched", (await db.contact.findUnique({ where: { id: real.id }, select: { unconfirmedFrom: true } }))?.unconfirmedFrom === null);
    await intakeLead(key, leadPayloadSchema.parse({ name: "Zz Founder", email: `founder@zzr2a-new.invalid`, company: `${TAG} Brand New Co` }), { ownerUserId: ben.id, notify: false, raisedBy: null });
    const founder = await db.contact.findFirst({ where: { email: `founder@zzr2a-new.invalid` }, select: { unconfirmedFrom: true } });
    ok("  a contact on a company the same form made is not marked — there's nobody to mistake them for", founder?.unconfirmedFrom === null, founder);
    const cardMade = await intakeLead({ ...key, name: `${TAG} card` }, leadPayloadSchema.parse({ name: "Zz Card Person", email: `card@zzr2a-elsewhere.invalid`, company: `${TAG} Existing Co` }), { ownerUserId: ana.id, notify: false, unconfirmedFrom: "CARD" });
    ok("  one shared back from a card says so", (await db.contact.findFirst({ where: { email: `card@zzr2a-elsewhere.invalid` }, select: { unconfirmedFrom: true } }))?.unconfirmedFrom === "CARD", cardMade);
    await intakeLead({ ...key, name: `${TAG} scan` }, leadPayloadSchema.parse({ name: "Zz Scanned", email: `scan@zzr2a-elsewhere.invalid`, company: `${TAG} Existing Co` }), { ownerUserId: ana.id, notify: false, unconfirmedFrom: null });
    ok("  one a person scanned themselves isn't", (await db.contact.findFirst({ where: { email: `scan@zzr2a-elsewhere.invalid` }, select: { unconfirmedFrom: true } }))?.unconfirmedFrom === null);

    // The visitor made primary, as the fallbacks rank primaries first: they still aren't picked.
    await db.contact.update({ where: { id: visitor!.id }, data: { isPrimary: true, receivesDocuments: true } });
    const picked = await unconfirmed.withConfirmed((confirmed) =>
      db.contact.findFirst({ where: { companyId: existing.id, leftAt: null, phone: { not: null }, ...confirmed }, orderBy: [{ receivesDocuments: "desc" }, { isPrimary: "desc" }, { createdAt: "asc" }], select: { id: true } }),
    );
    ok("an automatic pick (pay link's payer, WhatsApp reminder) passes over them, even made primary", picked?.id === real.id, picked);
    const among = await unconfirmed.unconfirmedAmong([real.id, visitor!.id]);
    ok("  they are told apart for the dialogs' badge", among.size === 1 && among.get(visitor!.id) === "WEB_FORM");
    actorId = ana.id;
    const confirmed = await confirmWebsiteContact(visitor!.id);
    ok("Confirm, by somebody who may edit the customer's contacts: a contact like any other", confirmed.ok && (await db.contact.findUnique({ where: { id: visitor!.id }, select: { unconfirmedFrom: true } }))?.unconfirmedFrom === null, confirmed);
    const pickedNow = await unconfirmed.withConfirmed((c) => db.contact.findFirst({ where: { companyId: existing.id, leftAt: null, phone: { not: null }, ...c }, orderBy: [{ receivesDocuments: "desc" }, { isPrimary: "desc" }, { createdAt: "asc" }], select: { id: true } }));
    ok("  and then picked as before", pickedNow?.id === visitor!.id);

    // ── R2-10 ──────────────────────────────────────────────────────────────────────────────────
    section("R2-10: from the lead owner's own mailbox");
    const step = (input: Record<string, unknown>) => ({ schema: 1, trigger: { type: "lead.created" }, steps: [{ id: "mail", type: "action", action: "email.send", input: { to: "lead_contact", leadId: "{{trigger.lead.id}}", from: "lead_owner", ...input } }] });
    const typed = validateDefinition(step({ subject: "Hello", body: "Pay at evil.example" }));
    ok("typed words from the lead owner's mailbox are refused at publish", !typed.ok && typed.problems.some((p) => p.field === "templateId" && /saved email template/.test(p.message)), typed.ok ? "" : typed.problems);
    const elsewhere = validateDefinition(step({ to: "contact", contactId: "c1", templateId: "t1", ccEmails: ["x@example.com"] }));
    ok("  as is another contact, or an address copied in", !elsewhere.ok && ["to", "ccEmails"].every((f) => elsewhere.problems.some((p) => p.field === f)), elsewhere.ok ? "" : elsewhere.problems);
    ok("  a saved template to the lead's own contact is fine", leadOwnerProblems({ from: "lead_owner", to: "lead_contact", templateId: "t1" }).length === 0);
    ok("  and from the workflow owner's own mailbox, words are still theirs to write", validateDefinition(step({ from: "owner", subject: "Hello", body: "Hi" })).ok);

    const lead = made.status === "created" ? await db.lead.findUnique({ where: { id: made.leadId }, select: { id: true, ownerUserId: true } }) : null;
    ok("(the visitor's lead is Ben's)", lead?.ownerUserId === ben.id, { made, lead });
    if (lead) {
      const ctx = { actorId: ana.id, workflowId: wf.id, workflowName: `${TAG} flow`, runId: queued.id, stepId: "mail", key: `${TAG}:mail:${randomBytes(4).toString("hex")}`, depth: 0, clock };
      const input = emailSend.input.parse({ to: "lead_contact", leadId: lead.id, from: "lead_owner", subject: "Hello", body: "Pay at evil.example" });
      const err = await emailSend.run(ctx, input).then(() => "sent", (e: unknown) => (e instanceof Error ? e.message : String(e)));
      ok("a version published before this, run on a colleague's lead: refused, nothing sent", /^Not sent: .*saved email template/.test(err), err);
      await db.lead.update({ where: { id: lead.id }, data: { ownerUserId: ana.id } });
      const own = await emailSend.run({ ...ctx, key: `${TAG}:mail2` }, input).then(() => "sent", (e: unknown) => (e instanceof Error ? e.message : String(e)));
      ok("  the workflow owner's own lead goes as from their own mailbox (here, none connected)", !/^Not sent:/.test(own) && /mailbox/.test(own), own);
    }

    // ── R2-15 ──────────────────────────────────────────────────────────────────────────────────
    section("R2-15: the booking page");
    ok("the invitation's name is cleaned: no link, no sentence", booking.inviteName("Ravi https://evil.example/pay now!!") === "Ravi now" && booking.inviteName("Priya O'Neil-Shah") === "Priya O'Neil-Shah");
    ok("  at most 40 characters; nothing usable is \"Guest\"", booking.inviteName("A".repeat(90)).length === 40 && booking.inviteName("<<>> 12345") === "Guest");
    const slug = `${TAG.toLowerCase()}-page-${randomBytes(3).toString("hex")}`;
    const page = await db.bookingPage.create({ data: { slug, title: `${TAG} Demo`, hostUserIds: [ana.id], hours: {}, createdById: ana.id }, select: { id: true } });
    const guest = `guest${MAIL}`;
    for (let i = 0; i < booking.GUEST_BOOKINGS_PER_DAY; i += 1) {
      await db.booking.create({ data: { pageId: page.id, hostUserId: ana.id, startsAt: new Date(Date.now() + (i + 2) * 86_400_000), endsAt: new Date(Date.now() + (i + 2) * 86_400_000 + 1_800_000), name: "Zz Guest", email: guest, sourceHash: `zz${i}` } });
    }
    const third = await booking.bookSlot(slug, { start: new Date(Date.now() + 5 * 86_400_000).toISOString(), name: "Zz Guest", email: guest }, `zz-fresh-${randomBytes(3).toString("hex")}`);
    ok(`a third booking from one address on one page in a day is refused, from any place`, !third.ok && /as often as it can today/.test(third.error), third);
    const other = await booking.bookSlot(slug, { start: new Date(Date.now() + 5 * 86_400_000).toISOString(), name: "Zz Guest", email: `other${MAIL}` }, `zz-fresh-${randomBytes(3).toString("hex")}`);
    ok("  another address isn't held by it", other.ok || !/as often as it can today/.test(other.error), other);

    // ── R2-20 ──────────────────────────────────────────────────────────────────────────────────
    section("R2-20: wrong portal codes across codes");
    const link = await db.portalLogin.create({ data: { token: randomBytes(24).toString("base64url"), companyId: existing.id, personName: "Zz Real Person", personEmail: `real${MAIL}`, createdById: ana.id }, select: { id: true } });
    const before = device.FAILED_CODES_A_DAY - 1;
    for (const attempts of [5, 5, 5, before - 15]) await db.portalCode.create({ data: { loginId: link.id, codeHash: "x".repeat(64), attempts, usedAt: new Date(), expiresAt: new Date() } });
    ok(`${before} wrong codes today: not paused yet`, (await device.failedCodesToday(link.id)) === before && !(await device.codesLocked(link.id)));
    await db.portalCode.create({ data: { loginId: link.id, codeHash: "y".repeat(64), expiresAt: new Date(Date.now() + 600_000) } });
    const twentieth = await device.checkCode(link.id, "12345678");
    ok(`the ${device.FAILED_CODES_A_DAY}th wrong one pauses the link, and says so`, !twentieth.ok && twentieth.error === device.LOCKED_TEXT, twentieth);
    ok("  its live code is spent", (await db.portalCode.count({ where: { loginId: link.id, usedAt: null } })) === 0);
    ok("  the account manager is told", (await db.notification.count({ where: { userId: ana.id, title: { contains: "portal link is paused" } } })) === 1);
    const send = await device.sendCode({ id: link.id, personName: "Zz Real Person", personEmail: `real${MAIL}` }, "Zz Business");
    ok("  no new code is sent while paused", !send.ok && send.error === device.LOCKED_TEXT && (await db.portalCode.count({ where: { loginId: link.id } })) === 5, send);
    await db.portalCode.create({ data: { loginId: link.id, codeHash: "z".repeat(64), expiresAt: new Date(Date.now() + 600_000) } });
    const tried = await device.checkCode(link.id, "12345678");
    ok("  and no code is checked, not even counted", !tried.ok && tried.error === device.LOCKED_TEXT && (await db.portalCode.findFirst({ where: { loginId: link.id, codeHash: "z".repeat(64) }, select: { attempts: true } }))?.attempts === 0);
    await db.portalCode.updateMany({ where: { loginId: link.id }, data: { createdAt: new Date(Date.now() - 25 * 3_600_000) } });
    ok("a day on, the link takes codes again", !(await device.codesLocked(link.id)));
    ok("codes are eight digits", device.CODE_DIGITS === 8);

    // ── Kiosk (low) ────────────────────────────────────────────────────────────────────────────
    section("Low: the reception kiosk");
    const deskToken = randomBytes(24).toString("base64url");
    const desk = { ...(await db.visitorKiosk.create({ data: { name: `${TAG} Desk`, token: deskToken }, select: { id: true } })), token: deskToken };
    if (!(await kiosk.kioskDirectory(desk.token))) {
      console.log("  (visitors isn't on in this workspace — kiosk checks skipped)");
    } else {
      const big = await kiosk.checkIn({ token: desk.token, purpose: "MEETING", hostUserId: ana.id, name: `${TAG} ${"N".repeat(5000)}`, phone: "+919800000003", company: `${TAG} Visiting Co`, email: `walkin${MAIL}`, note: "x".repeat(50_000), photoUnavailable: true });
      const entry = await db.visitorEntry.findFirst({ where: { kioskId: desk.id }, select: { name: true, note: true } });
      ok("a 5,000-character name and a 50,000-character note are cut to size", big.ok && (entry?.name.length ?? 0) <= 120 && (entry?.note?.length ?? 0) <= 600, { big, len: entry?.name.length });
      const photo = await kiosk.checkIn({ token: desk.token, purpose: "MEETING", hostUserId: ana.id, name: `${TAG} Photo`, phone: "+919800000004", company: `${TAG} Visiting Co`, email: `photo${MAIL}`, photoDataUrl: `data:image/jpeg;base64,${"A".repeat(700_000)}` });
      ok("  a photo of several hundred KB more than a face needs is refused", !photo.ok && /too large/.test(photo.error), photo);
      const day = new Date();
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { generateCode } = require("../src/lib/visitors/invite-code") as typeof import("../src/lib/visitors/invite-code");
      const code = generateCode();
      await db.visitorInvite.create({ data: { code, hostUserId: ana.id, name: `${TAG} Invited`, expectedAt: day } });
      const both = await Promise.all([1, 2].map(() => kiosk.checkInWithInvite({ token: desk.token, code, photoUnavailable: true })));
      const signedIn = both.filter((r) => r.ok).length;
      const entries = await db.visitorEntry.count({ where: { kioskId: desk.id, name: `${TAG} Invited` } });
      ok("one invite code, used twice at once: one visit", entries === 1 && signedIn === 1, { both, entries });
    }
  } finally {
    await cleanup();
    const left = await db.user.count({ where: { email: { endsWith: MAIL } } });
    ok("the fixture is gone", left === 0 && (await db.company.count({ where: { name: { startsWith: TAG } } })) === 0);
    await db.$disconnect();
  }
  console.log(failures === 0 ? `\nAll ${passes} round-two checks (group A) passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
