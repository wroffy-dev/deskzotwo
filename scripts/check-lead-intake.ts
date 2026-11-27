/**
 * check:lead-intake — every other way a lead is written, under the lead limits (owner, 12 Nov 2026 — Phase 4 lead limits,
 * wave 2: audit H.6.5, H.6.6, M-14, M-17, D.5, D.6.5, D.6.6; src/lib/leads/intake-owner.ts).
 *
 *   capture    the website's capture API: everybody the rules choose full → made with nobody, noted, the managers told;
 *              a REFUSE rule → 422, nothing made; the plan's cap → 429, nothing made; the minute's limit counted
 *              atomically on every request (seventy at once, of bodies that make nothing: sixty answered, ten 429).
 *   forms      a public form: the rate limit decided under the form's lock (ten at once from one address: five); the
 *              owner chosen after it (a refused answer takes no round-robin turn); the form's person full → nobody;
 *              the plan's cap → refused, nothing saved.
 *   booking    ten bookings at once from one place: five; the host full → the booking stands, its lead with nobody.
 *   cards      fifteen share-backs at once to one card: ten; the holder full → nobody, the holder told why.
 *   inbox      the agent full → nobody; the plan's cap → refused in words, not thrown.
 *   automate   naming somebody else as the owner needs leads.assign (M-14); the owner full → ownerAssigned false; the
 *              plan's cap → a permanent failure in words.
 *   carry      a won lead carried on to an owner at their limit → made with nobody, noted, the managers told.
 *   sweep      the response-hours sweep moves a lead only while it's still with the person it read (D.5): a reassignment
 *              made while it waits stands; and somebody full is never moved onto.
 *   import     the CRM leads importer and the legacy importer: a row whose owner is full fails with the reason.
 *   dataimport no window → at most 2000 rows; the day's 50,000 taken atomically (two at once over it: one refused).
 *   idem       a lead's request token: the same body → the same lead; another body → refused (409 in the API); older
 *              than a day → a new lead.
 *
 * In a scratch workspace built from the migrations, dropped after. `ONLY=capture,forms` runs those sections.
 *
 *   npm run check:lead-intake
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const ONLY = new Set((process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const runs = (name: string) => ONLY.size === 0 || ONLY.has(name);
const section = (title: string) => console.log(`\n— ${title} —\n`);
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["@/lib/session", session],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("../src/lib/session"), session],
]);
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (byName.has(request)) return byName.get(request);
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && byFile.has(resolved)) return byFile.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const realName = new URL(url).pathname.slice(1);
  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratch = `${realName}_leadintake`;
  const scratchUrl = withDatabase(url, scratch);
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  let close: (() => Promise<void>) | null = null;
  let side: ReturnType<typeof directClient> | null = null;
  let undoNotifier: (() => void) | null = null;
  // A booking's invitation, with no mail account, is written to platform-outbox/ (src/lib/platform-mail): ours are taken away after.
  const outbox = join(process.cwd(), "platform-outbox");
  const outboxThere = existsSync(outbox);
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratch}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60_000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);
    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = "";
    // Real concurrency: each transaction on a connection of its own.
    process.env.TENANCY_CONNECTION_LIMIT = "40";
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    close = () => db.$disconnect();
    const leadActions = require("../src/actions/lead") as typeof import("../src/actions/lead");
    const limits = require("../src/lib/leads/limits") as typeof import("../src/lib/leads/limits");
    const intakeOwner = require("../src/lib/leads/intake-owner") as typeof import("../src/lib/leads/intake-owner");
    const tenancy = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    const receive = require("../src/lib/lead-capture/receive") as typeof import("../src/lib/lead-capture/receive");
    const publicForms = require("../src/actions/marketing-public") as typeof import("../src/actions/marketing-public");
    const { categoryOf } = require("../src/lib/forms/categories") as typeof import("../src/lib/forms/categories");
    const booking = require("../src/lib/booking/server") as typeof import("../src/lib/booking/server");
    const cardPublic = require("../src/actions/card-public") as typeof import("../src/actions/card-public");
    const inbox = require("../src/lib/inbox/server") as typeof import("../src/lib/inbox/server");
    const { defaultChannelSettings } = require("../src/lib/inbox/settings") as typeof import("../src/lib/inbox/settings");
    const { leadCreate } = require("../src/lib/automate/actions/lead-create") as typeof import("../src/lib/automate/actions/lead-create");
    const { ActionError } = require("../src/lib/automate/action-types") as typeof import("../src/lib/automate/action-types");
    const pipelineActions = require("../src/actions/pipeline") as typeof import("../src/actions/pipeline");
    const carryOn = require("../src/lib/pipeline/carry-on") as typeof import("../src/lib/pipeline/carry-on");
    const response = require("../src/lib/leads/response") as typeof import("../src/lib/leads/response");
    const portability = require("../src/lib/portability/import") as typeof import("../src/lib/portability/import");
    const legacy = require("../src/lib/legacy-import/apply") as typeof import("../src/lib/legacy-import/apply");
    const legacyContext = require("../src/lib/legacy-import/context") as typeof import("../src/lib/legacy-import/context");
    const dataImport = require("../src/actions/data-import") as typeof import("../src/actions/data-import");
    const { runAsApiActor } = require("../src/lib/api/actor") as typeof import("../src/lib/api/actor");
    const { ApiError } = require("../src/lib/api/handler") as typeof import("../src/lib/api/handler");
    const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
    /* eslint-enable @typescript-eslint/no-require-imports */
    side = directClient(scratchUrl, { max: 2 });

    // Who the managers would be told about: every call to the overflow notice, by lead.
    const told: { leadIds: string[]; reason: string }[] = [];
    undoNotifier = intakeOwner.replaceOverflowNotifier(async (leadIds, reason) => {
      told.push({ leadIds, reason });
    });
    const toldAbout = (leadId: string | null | undefined) => told.filter((t) => !!leadId && t.leadIds.includes(leadId));

    let n = 0;
    const person = (name: string, extra: Record<string, unknown> = {}) =>
      db.user.create({ data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}.${(n += 1)}@zz-intake.in`, passwordHash: "!", role: "SALES", ...extra }, select: { id: true, name: true, email: true, role: true } });
    const asActor = (u: { id: string; name: string; email: string | null; role: string }): Actor => ({ id: u.id, name: u.name, email: u.email!, role: u.role });
    const boss = await person("Zz Boss", { role: "ADMIN", isSuperAdmin: true });
    actor = asActor(boss);
    const full = async (name: string) => {
      const p = await person(name);
      await db.userLeadLimit.create({ data: { userId: p.id, limited: true, maxOpen: 0, reason: "Zz full" } });
      return p;
    };
    const rule = (name: string, data: Record<string, unknown>) =>
      db.leadAssignmentRule.create({ data: { name, priority: 100, skipOnLeave: false, brandIds: [], itemTypes: [], designations: [], sources: [], states: [], ...data }, select: { id: true } });
    const clearRules = () => db.leadAssignmentRule.deleteMany({});
    const workspace = await tenancy.currentTenant();
    const month = (await limits.leadUsageFor(boss.id)).month;
    const used = async () => (await db.leadUsage.findUnique({ where: { month } }))?.created ?? 0;
    /** As the workspace, with this month's plan cap at what's been used: the next lead is past it. */
    const capped = async <T,>(work: () => Promise<T>) => {
      const at = await used();
      return tenancy.runAsTenant({ ...workspace, entitlements: { ...workspace.entitlements, leads: { monthly: at } } }, work);
    };
    const leadOf = (id: string | null | undefined) => (id ? db.lead.findUnique({ where: { id }, select: { ownerUserId: true, assignmentNote: true, title: true } }) : Promise.resolve(null));
    const waitForLock = async (pattern: string) => {
      const until = Date.now() + 15_000;
      while (Date.now() < until) {
        const rows = await admin.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock' AND query ILIKE $2`, scratch, pattern);
        if (Number(rows[0]?.n ?? 0) > 0) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    };

    // ─── The website's capture API ──────────────────────────────────────────────────────────────────
    if (runs("capture")) {
      section("capture: the website's capture API");
      const key = await db.leadCaptureKey.create({ data: { name: "Zz site", keyId: `lck_zz${Date.now()}`, secretDigest: "x", createdById: boss.id } });
      const post = (body: unknown) =>
        receive.receiveLead(new Request("http://zz.test/api/v1/leads", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }), key, receive.readApiBody);
      const enquiry = (i: string) => ({ name: `Zz Visitor ${i}`, email: `visitor${i}@zz-capture.example`, company: `Zz Capture ${i} Pvt Ltd`, external_id: `zz-${i}` });
      const [ana, ben] = [await full("Ana Zz"), await full("Ben Zz")];
      await rule("Zz web", { strategy: "ROUND_ROBIN", userIds: [ana.id, ben.id] });
      const over = await post(enquiry("o1"));
      const overBody = (await over.json()) as { lead?: { id: string }; assigned?: boolean };
      const overLead = await leadOf(overBody.lead?.id);
      ok("everybody the rules would choose is full (SKIP): 201, made with nobody, saying why", over.status === 201 && overBody.assigned === false && overLead?.ownerUserId === null && /lead limit/.test(overLead?.assignmentNote ?? ""), { status: over.status, overLead });
      ok("  and the managers are told, about that lead, with the reason", toldAbout(overBody.lead?.id).length === 1 && /“.*”: everybody the rule “Zz web”/.test(toldAbout(overBody.lead?.id)[0]?.reason ?? ""), toldAbout(overBody.lead?.id));
      await db.leadAssignmentRule.updateMany({ data: { overflow: "REFUSE" } });
      const before = await db.lead.count();
      const refused = await post(enquiry("r1"));
      ok("a REFUSE rule: 422, in words, and nothing made", refused.status === 422 && (await db.lead.count()) === before && /Nobody is free/.test(((await refused.json()) as { error: string }).error), refused.status);
      await clearRules();
      const plan = await capped(() => post(enquiry("p1")));
      const planBody = (await plan.json()) as { error?: string };
      ok("past the plan's monthly cap: 429, saying so, and nothing made", plan.status === 429 && /plan includes/.test(planBody.error ?? "") && (await db.lead.count()) === before, { status: plan.status, planBody });
      // Every request counts — these make nothing (an invalid body), and still use the minute up.
      await db.leadCaptureKey.update({ where: { id: key.id }, data: { rateWindowStart: null, rateWindowCount: 0 } });
      const burst = await Promise.all(Array.from({ length: 70 }, () => post({ name: "", email: "not-an-address" })));
      const statuses = burst.map((r) => r.status);
      ok("seventy at once of bodies that make nothing: sixty answered, ten told to wait — counted atomically, every request", statuses.filter((s) => s === 400).length === 60 && statuses.filter((s) => s === 429).length === 10, { "400": statuses.filter((s) => s === 400).length, "429": statuses.filter((s) => s === 429).length });
      // The real notice, end to end (src/lib/leads/overflow-notify.ts): with the checks' stand-in put aside.
      undoNotifier();
      await db.leadCaptureKey.update({ where: { id: key.id }, data: { rateWindowStart: null, rateWindowCount: 0 } });
      await rule("Zz web again", { strategy: "ROUND_ROBIN", userIds: [ana.id, ben.id] });
      const real = await post(enquiry("n1"));
      const realBody = (await real.json()) as { lead?: { id: string } };
      const notices = await db.notification.findMany({ where: { userId: boss.id, dedupeKey: { startsWith: "lead-overflow:" } }, select: { title: true } });
      ok("  without the stand-in, the managers' notice is written (whoever holds leads.assign — the super admin here)", real.status === 201 && notices.length >= 1, { lead: realBody.lead?.id, notices });
      undoNotifier = intakeOwner.replaceOverflowNotifier(async (leadIds, reason) => {
        told.push({ leadIds, reason });
      });
      await clearRules();
    }

    // ─── Public forms ───────────────────────────────────────────────────────────────────────────────
    if (runs("forms")) {
      section("forms: a public form");
      const form = (slug: string, extra: Record<string, unknown> = {}) =>
        db.inboundForm.create({ data: { slug, name: `Zz ${slug}`, fields: categoryOf("ENQUIRY").starter as object, createsLead: true, ownerUserId: boss.id, createdById: boss.id, ...extra }, select: { id: true, slug: true } });
      const submit = (slug: string, email: string, company: string) => publicForms.submitForm({ slug, values: { name: "Zz Person", email, companyName: company }, elapsedMs: 5000 });
      const [cy, dee] = [await person("Cy Zz"), await person("Dee Zz")];
      const rr = await rule("Zz form pair", { strategy: "ROUND_ROBIN", userIds: [cy.id, dee.id] });
      const enquiries = await form("zz-enquiry");
      const cursorBefore = (await db.leadAssignmentRule.findUnique({ where: { id: rr.id }, select: { rrCursor: true } }))!.rrCursor;
      const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => submit(enquiries.slug, "same@zz-forms.example", `Zz Forms ${i} Pvt Ltd`)));
      const saved = await db.formSubmission.count({ where: { formId: enquiries.id } });
      ok("ten answers at once from one address: five saved, five told to wait", burst.filter((r) => r.ok).length === 5 && saved === 5 && burst.filter((r) => !r.ok && /Too many answers/.test(r.error)).length === 5, { ok: burst.filter((r) => r.ok).length, saved });
      const cursorAfter = (await db.leadAssignmentRule.findUnique({ where: { id: rr.id }, select: { rrCursor: true } }))!.rrCursor;
      ok("  the round robin moved once for each lead made, and not for the answers refused", cursorAfter - cursorBefore === 5, { cursorBefore, cursorAfter });
      await clearRules();
      const eve = await full("Eve Zz");
      const toEve = await form("zz-to-eve", { assignToUserId: eve.id });
      const answered = await submit(toEve.slug, "a1@zz-forms.example", "Zz Eve Customer Pvt Ltd");
      const eveLead = await db.formSubmission.findFirst({ where: { formId: toEve.id }, select: { lead: { select: { id: true, ownerUserId: true, assignmentNote: true } } } });
      ok("the form's person is full: the answer is saved, its lead with nobody, saying why", answered.ok && eveLead?.lead?.ownerUserId === null && /Eve Zz is at their limit/.test(eveLead.lead.assignmentNote ?? ""), eveLead);
      ok("  and the managers are told", toldAbout(eveLead?.lead?.id).length === 1);
      const plain = await form("zz-plain");
      const capAnswer = await capped(() => submit(plain.slug, "a2@zz-forms.example", "Zz Cap Customer Pvt Ltd"));
      ok("past the plan's cap: refused, asking them to come back, and nothing saved", !capAnswer.ok && /can't take answers/.test(capAnswer.error) && (await db.formSubmission.count({ where: { formId: plain.id } })) === 0, capAnswer.ok ? "saved" : capAnswer.error);
    }

    // ─── Booking pages ──────────────────────────────────────────────────────────────────────────────
    if (runs("booking")) {
      section("booking: a booking page");
      const fay = await full("Fay Zz");
      const allDay = Object.fromEntries(["1", "2", "3", "4", "5", "6", "7"].map((d) => [d, [["00:00", "23:30"]]]));
      await db.bookingPage.create({ data: { slug: "zz-intake", title: "Zz call", durationMinutes: 30, hostUserIds: [fay.id], hours: allDay, daysAhead: 7, minNoticeHours: 0, bufferMinutes: 0, online: true, active: true, createdById: boss.id } });
      const page = await booking.publicBookingPage("zz-intake");
      const slots = (page?.days ?? []).flatMap((d) => d.slots).slice(0, 10);
      ok("(ten open times to book)", slots.length === 10, slots.length);
      const burst = await Promise.all(slots.map((start, i) => booking.bookSlot("zz-intake", { start, name: `Zz Guest ${i}`, email: `guest${i}@zz-booking.example`, company: `Zz Booking ${i} Pvt Ltd` }, "203.0.113.9")));
      const made = await db.booking.findMany({ where: { page: { slug: "zz-intake" } }, select: { leadId: true } });
      ok("ten bookings at once from one place: five made, five told to wait", burst.filter((r) => r.ok).length === 5 && made.length === 5 && burst.filter((r) => !r.ok && /Too many bookings/.test(r.error)).length === 5, burst.map((r) => (r.ok ? "ok" : r.error)));
      const leads = await db.lead.findMany({ where: { id: { in: made.flatMap((m) => (m.leadId ? [m.leadId] : [])) } }, select: { id: true, ownerUserId: true, assignmentNote: true } });
      ok("  the host is full: each booking stands, its lead with nobody, saying why, and the managers told", leads.length === 5 && leads.every((l) => l.ownerUserId === null && /Fay Zz is at their limit/.test(l.assignmentNote ?? "") && toldAbout(l.id).length === 1), leads);
    }

    // ─── Digital cards ──────────────────────────────────────────────────────────────────────────────
    if (runs("cards")) {
      section("cards: a digital card's share-back");
      const gus = await full("Gus Zz");
      const template = await db.cardTemplate.create({ data: { name: "Zz template", isDefault: true, shareBack: true } });
      const card = await db.digitalCard.create({ data: { userId: gus.id, templateId: template.id, handle: "zz-gus-intake" } });
      const burst = await Promise.all(Array.from({ length: 15 }, (_, i) => cardPublic.shareBackFromCard({ handle: card.handle, name: `Zz Met ${i}`, email: `met${i}@zz-cards.example`, company: `Zz Cards ${i} Pvt Ltd`, elapsedMs: 5000 })));
      const contacts = await db.cardContact.findMany({ where: { cardId: card.id }, select: { leadId: true } });
      ok("fifteen share-backs at once to one card: ten taken, five told to wait", burst.filter((r) => r.ok).length === 10 && contacts.length === 10 && burst.filter((r) => !r.ok && /A lot of people/.test(r.error)).length === 5, { ok: burst.filter((r) => r.ok).length, contacts: contacts.length });
      const leads = await db.lead.findMany({ where: { id: { in: contacts.flatMap((c) => (c.leadId ? [c.leadId] : [])) } }, select: { id: true, ownerUserId: true, assignmentNote: true } });
      ok("  the holder is full: each a lead with nobody, saying why, the managers told", leads.length === 10 && leads.every((l) => l.ownerUserId === null && /Gus Zz is at their limit/.test(l.assignmentNote ?? "") && toldAbout(l.id).length === 1), leads.length);
      const heard = await db.notification.count({ where: { userId: gus.id, message: { contains: "you're at your lead limit" } } });
      ok("  and the holder hears of each, and why it isn't theirs", heard === 10, heard);
    }

    // ─── The inbox ──────────────────────────────────────────────────────────────────────────────────
    if (runs("inbox")) {
      section("inbox: a lead from a conversation");
      const hal = await full("Hal Zz");
      const channel = await db.inboxChannel.create({ data: { kind: "WEB", name: "Zz chat", publicKey: `zzintake${Date.now()}`, settings: defaultChannelSettings("WEB") as object, createdById: boss.id } });
      const conversation = (i: number) => db.conversation.create({ data: { channelId: channel.id, kind: "WEB", customerName: `Zz Chatter ${i}`, customerEmail: `chat${i}@zz-inbox.example` }, select: { id: true } });
      const c1 = await conversation(1);
      const made = await inbox.makeLead(c1.id, { ownerUserId: hal.id, notify: true });
      const lead = made.ok ? await leadOf(made.leadId) : null;
      ok("the agent is full: made, with nobody, saying why, the managers told", made.ok && lead?.ownerUserId === null && /Hal Zz is at their limit/.test(lead?.assignmentNote ?? "") && toldAbout(made.ok ? made.leadId : null).length === 1, { made, lead });
      const c2 = await conversation(2);
      let answer: unknown;
      try {
        answer = await capped(() => inbox.makeLead(c2.id, { ownerUserId: boss.id, notify: false }));
      } catch (err) {
        answer = `threw: ${err instanceof Error ? err.message : String(err)}`;
      }
      const refusal = answer as { ok?: boolean; error?: string };
      ok("past the plan's cap: refused in words, not thrown", refusal?.ok === false && /plan includes/.test(refusal.error ?? ""), answer);
    }

    // ─── Automate's "Create a lead" ─────────────────────────────────────────────────────────────────
    if (runs("automate")) {
      section("automate: a workflow's \"Create a lead\"");
      const ivy = await person("Ivy Zz");
      const jon = await full("Jon Zz");
      let step = 0;
      const ctxFor = async (actorId: string) => {
        const wf = await db.automationWorkflow.create({ data: { name: `Zz flow ${(step += 1)}`, ownerUserId: actorId, draft: {}, createdById: actorId }, select: { id: true, name: true } });
        const run = await db.automationRun.create({ data: { workflowId: wf.id, idempotencyKey: `zz-run-${step}-${Date.now()}`, cursor: {}, contextCipher: "" }, select: { id: true } });
        return { actorId, workflowId: wf.id, workflowName: wf.name, runId: run.id, stepId: "make", key: `${run.id}:make`, depth: 0, clock: await workspaceClock() };
      };
      const input = (i: string, owner: string) => ({ name: `Zz Flow ${i}`, email: `flow${i}@zz-automate.example`, company: `Zz Automate ${i} Pvt Ltd`, source: "OTHER" as const, owner });
      const failure = async (work: () => Promise<unknown>) => {
        try {
          await work();
          return null;
        } catch (err) {
          return err;
        }
      };
      const salesNamesOther = await failure(async () => leadCreate.run(await ctxFor(ivy.id), input("1", boss.id)));
      ok("a workflow's owner without leads.assign naming somebody else: refused, permanently (M-14)", salesNamesOther instanceof ActionError && salesNamesOther.kind === "PERMANENT" && /can't assign leads to other people/.test(salesNamesOther.message), salesNamesOther instanceof Error ? salesNamesOther.message : salesNamesOther);
      const selfNamed = await failure(async () => leadCreate.run(await ctxFor(ivy.id), input("2", "owner")));
      ok("  naming themselves: made", selfNamed === null, selfNamed instanceof Error ? selfNamed.message : selfNamed);
      const ctx = await ctxFor(boss.id);
      const toJon = (await leadCreate.run(ctx, input("3", jon.id))) as { status: string; leadId?: string; ownerAssigned?: boolean };
      const jonLead = await leadOf(toJon.leadId);
      ok("with leads.assign, to somebody full: made, ownerAssigned false, with nobody, saying why, the managers told", toJon.status === "created" && toJon.ownerAssigned === false && jonLead?.ownerUserId === null && /Jon Zz is at their limit/.test(jonLead?.assignmentNote ?? "") && toldAbout(toJon.leadId).length === 1, { toJon, jonLead });
      const capFail = await failure(async () => {
        const c = await ctxFor(boss.id);
        return capped(() => leadCreate.run(c, input("4", "owner")));
      });
      ok("past the plan's cap: a permanent failure, in its own words", capFail instanceof ActionError && capFail.kind === "PERMANENT" && /plan includes/.test(capFail.message), capFail instanceof Error ? `${capFail.name}: ${capFail.message}` : capFail);
    }

    // ─── Pipeline carry-on ──────────────────────────────────────────────────────────────────────────
    if (runs("carry")) {
      section("carry: a won lead carried on into the next pipeline");
      actor = asActor(boss);
      const made = await pipelineActions.savePipeline({ name: "Zz Onboarding", sales: false });
      const onboardingId = made.ok ? made.data.id : "";
      const connect = await pipelineActions.savePipeline({ id: "lpip_sales", name: "Sales", sales: true, nextPipelineId: onboardingId });
      ok("(Sales carries its won leads on into Zz Onboarding)", made.ok && connect.ok, [made, connect]);
      const won = await db.leadStage.findFirstOrThrow({ where: { pipelineId: "lpip_sales", status: "WON" }, select: { id: true } });
      const co = await db.company.create({ data: { name: "Zz Carry Pvt Ltd", normalizedName: "zz carry pvt ltd", relationshipType: "CLIENT", createdById: boss.id }, select: { id: true } });
      const kay = await person("Kay Zz");
      const lead = await db.lead.create({ data: { title: "Zz carried deal", companyId: co.id, ownerUserId: kay.id, status: "WON", stageId: won.id, pipelineId: "lpip_sales" }, select: { id: true } });
      await db.userLeadLimit.create({ data: { userId: kay.id, limited: true, maxOpen: 0 } });
      const next = await carryOn.carryOnWonLead(lead.id, boss.id);
      const nextLead = await db.lead.findUnique({ where: { id: next?.id ?? "" }, select: { id: true, ownerUserId: true, assignmentNote: true, pipelineId: true } });
      ok("its owner is full: carried on all the same, with nobody, saying why", nextLead?.pipelineId === onboardingId && nextLead.ownerUserId === null && /Kay Zz is at their limit/.test(nextLead.assignmentNote ?? ""), nextLead);
      ok("  and the managers are told", toldAbout(nextLead?.id).length === 1);
      const lee = await person("Lee Zz");
      const lead2 = await db.lead.create({ data: { title: "Zz carried deal 2", companyId: co.id, ownerUserId: lee.id, status: "WON", stageId: won.id, pipelineId: "lpip_sales" }, select: { id: true } });
      const next2 = await carryOn.carryOnWonLead(lead2.id, boss.id);
      ok("  an owner with room keeps it, as before", (await leadOf(next2?.id))?.ownerUserId === lee.id);
      await pipelineActions.savePipeline({ id: "lpip_sales", name: "Sales", sales: true, nextPipelineId: null });
    }

    // ─── The response-hours sweep ───────────────────────────────────────────────────────────────────
    if (runs("sweep")) {
      section("sweep: a lead moved on for want of an answer");
      const [mo, ned, ola, pip] = [await person("Mo Zz"), await person("Ned Zz"), await person("Ola Zz"), await person("Pip Zz")];
      await rule("Zz answer in an hour", { strategy: "ROUND_ROBIN", userIds: [mo.id, ned.id, ola.id], responseHours: 1 });
      const co = await db.company.create({ data: { name: "Zz Sweep Pvt Ltd", normalizedName: "zz sweep pvt ltd", relationshipType: "CLIENT", createdById: boss.id }, select: { id: true } });
      const waiting = async (title: string) => {
        const lead = await db.lead.create({ data: { title, companyId: co.id, ownerUserId: mo.id }, select: { id: true } });
        await db.leadAssignment.updateMany({ where: { leadId: lead.id }, data: { assignedAt: new Date(Date.now() - 5 * HOUR) } });
        return lead;
      };
      // Somebody reassigns the lead while the sweep is moving it.
      const raced = await waiting("Zz raced");
      let release: () => void = () => {};
      const released = new Promise<void>((r) => (release = r));
      let held: () => void = () => {};
      const isHeld = new Promise<void>((r) => (held = r));
      const blocker = side!.$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(`SELECT 1 FROM "leads" WHERE "id" = $1 FOR UPDATE`, raced.id);
          held();
          await released;
          await tx.lead.update({ where: { id: raced.id }, data: { ownerUserId: pip.id } });
        },
        { timeout: 30_000 },
      );
      await isHeld;
      const sweeping = response.leadResponseChores(new Date());
      ok("  (the sweep is waiting on the lead another transaction is reassigning)", await waitForLock("%leads%"));
      release();
      await blocker;
      await sweeping;
      const after = await leadOf(raced.id);
      ok("a lead reassigned while the sweep moves it: the reassignment stands (D.5)", after?.ownerUserId === pip.id, after);
      // Nobody in the rule with room: it stays, and is escalated.
      await db.userLeadLimit.createMany({ data: [ned.id, ola.id].map((userId) => ({ userId, limited: true, maxOpen: 0 })) });
      const stuck = await waiting("Zz stuck");
      await response.leadResponseChores(new Date());
      const stuckRow = await db.leadAssignment.findFirst({ where: { leadId: stuck.id, userId: mo.id }, select: { escalatedAt: true, timedOutAt: true } });
      ok("everybody else in the rule full: it stays, escalated, never moved onto somebody full", (await leadOf(stuck.id))?.ownerUserId === mo.id && !!stuckRow?.escalatedAt && !stuckRow.timedOutAt, stuckRow);
      await db.userLeadLimit.deleteMany({ where: { userId: { in: [ned.id, ola.id] } } });
      const moving = await waiting("Zz moving");
      await response.leadResponseChores(new Date());
      const movedTo = (await leadOf(moving.id))?.ownerUserId;
      const movedRow = await db.leadAssignment.findFirst({ where: { leadId: moving.id, userId: mo.id }, select: { timedOutAt: true } });
      ok("  with room again: moved on to the next in the rule, the old assignment marked timed out", (movedTo === ned.id || movedTo === ola.id) && !!movedRow?.timedOutAt, { movedTo, movedRow });
      await clearRules();
    }

    // ─── Importers ──────────────────────────────────────────────────────────────────────────────────
    if (runs("import")) {
      section("import: the CRM leads importer and the legacy importer");
      actor = asActor(boss);
      const quinn = await full("Quinn Zz");
      const rae = await person("Rae Zz");
      const result = await portability.apply("leads", [
        { Title: "Zz imported 1", Company: "Zz Import One Pvt Ltd", Owner: quinn.name },
        { Title: "Zz imported 2", Company: "Zz Import Two Pvt Ltd", Owner: rae.name },
      ], boss.id);
      ok("a row whose owner is full fails with the reason; the row beside it lands", result.created === 1 && result.failed.length === 1 && /Quinn Zz has reached their limit/.test(result.failed[0]?.error ?? ""), result);
      ok("  nothing of the failed row was written", (await db.lead.count({ where: { title: "Zz imported 1" } })) === 0 && (await db.lead.count({ where: { title: "Zz imported 2", ownerUserId: rae.id } })) === 1);

      const run = await db.legacyImport.create({ data: { createdById: boss.id }, select: { id: true } });
      await db.legacyImportRecord.createMany({ data: [{ importId: run.id, kind: "users", oldId: "u-quinn", recordId: quinn.id, action: "LINKED" }, { importId: run.id, kind: "users", oldId: "u-rae", recordId: rae.id, action: "LINKED" }] });
      const ctx = {
        importId: run.id,
        actorId: boss.id,
        strategy: "NEW" as const,
        decisions: {},
        lookups: { users: {}, departments: {}, designations: {}, brands: {}, categories: {}, customerCategories: {}, tags: {}, entityTags: {}, products: {} },
        records: new legacyContext.RecordCache(),
        ownName: "zz own company",
      };
      const oldRow = (id: string, owner: string) => ({ row: { id, status: "new", company: `Zz Legacy ${id} Pvt Ltd`, name: `Zz Legacy Person ${id}`, assigned_to: owner, created_by: owner, createdAt: "2026-10-01 10:00:00" }, file: "leads.csv", line: 2 });
      const toQuinn = await legacy.applyRow("leads", oldRow("L1", "u-quinn"), ctx as never);
      const toRae = await legacy.applyRow("leads", oldRow("L2", "u-rae"), ctx as never);
      ok("legacy: a row whose owner is full is the row's error, in words; the next lands", toQuinn.kind === "error" && /Quinn Zz has reached their limit/.test((toQuinn as { message?: string }).message ?? JSON.stringify(toQuinn)) && toRae.kind === "created", { toQuinn, toRae });
      ok("  nothing of the failed row was written", (await db.lead.count({ where: { externalId: "oldcrm:L1" } })) === 0 && (await db.company.count({ where: { name: "Zz Legacy L1 Pvt Ltd" } })) === 0);
    }

    // ─── The import's caps ──────────────────────────────────────────────────────────────────────────
    if (runs("dataimport")) {
      section("dataimport: rows a request, rows a day");
      actor = asActor(boss);
      const csv = (rows: number) => Buffer.from(["Key", ...Array.from({ length: rows }, (_, i) => `zz-not-a-key-${i}`)].join("\n")).toString("base64");
      const whole = await dataImport.commitImport({ area: "leads", filename: "zz-big.csv", base64: csv(2500) });
      ok("a file of 2,500 rows sent with no window: 2,000 taken, and the answer says how many there are", whole.ok && whole.data.processed === 2000 && whole.data.totalRows === 2500, whole.ok ? { processed: whole.data.processed, totalRows: whole.data.totalRows } : whole.error);
      const asked = await dataImport.commitImport({ area: "leads", filename: "zz-big.csv", base64: csv(2500), from: 0, count: 2500 });
      ok("  a window of 2,500 asked for: 2,000 taken", asked.ok && asked.data.processed === 2000, asked.ok ? asked.data.processed : asked.error);
      const today = (await workspaceClock()).dateKey(new Date());
      const counted = await db.organisationSettings.findUnique({ where: { id: "global" }, select: { importDay: true, importRows: true } });
      ok("  each counted against today's rows", counted?.importDay === today && counted.importRows === 4000, counted);
      await db.organisationSettings.update({ where: { id: "global" }, data: { importRows: 50_000 - 150 } });
      const pair = await Promise.all([1, 2].map(() => dataImport.commitImport({ area: "leads", filename: "zz-small.csv", base64: csv(100), from: 0, count: 100 })));
      ok("two at once with room for one: one imported, one refused, saying the day's rows are used", pair.filter((r) => r.ok).length === 1 && pair.some((r) => !r.ok && /50,000 rows a day/.test(r.error)), pair.map((r) => (r.ok ? "ok" : r.error)));
      ok("  and the count never passes the cap", (await db.organisationSettings.findUnique({ where: { id: "global" }, select: { importRows: true } }))?.importRows === 50_000 - 50);
      await db.organisationSettings.update({ where: { id: "global" }, data: { importDay: "2000-01-01" } });
      const tomorrow = await dataImport.commitImport({ area: "leads", filename: "zz-small.csv", base64: csv(100), from: 0, count: 100 });
      ok("  another day: room again", tomorrow.ok, tomorrow.ok ? "" : tomorrow.error);
    }

    // ─── A lead's request token ─────────────────────────────────────────────────────────────────────
    if (runs("idem")) {
      section("idem: a lead's request token (D.6.6)");
      actor = asActor(boss);
      const co = await db.company.create({ data: { name: "Zz Idem Pvt Ltd", normalizedName: "zz idem pvt ltd", relationshipType: "CLIENT", createdById: boss.id }, select: { id: true } });
      const create = (title: string, requestId: string) => leadActions.createLead({ companyId: co.id, title, ownerUserId: boss.id, requestId });
      const first = await create("Zz idem one", "zz-request-0001");
      const again = await create("Zz idem one", "zz-request-0001");
      ok("the same request twice: one lead", first.ok && again.ok && first.data.id === again.data.id && (await db.lead.count({ where: { companyId: co.id } })) === 1);
      const other = await create("Zz idem a different lead", "zz-request-0001");
      ok("the same token with a different body: refused, not answered with the first lead", !other.ok && /used for a different lead/.test(other.error) && (await db.lead.count({ where: { companyId: co.id } })) === 1, other.ok ? other.data : other.error);
      let thrown: unknown = null;
      try {
        await runAsApiActor({ userId: boss.id, name: boss.name, email: boss.email!, role: boss.role, keyId: "zz", keyName: "zz", scopes: ["leads:write"] }, () => create("Zz idem a different lead", "zz-request-0001"));
      } catch (err) {
        thrown = err;
      }
      ok("  through the API: a 409", thrown instanceof ApiError && thrown.status === 409 && thrown.code === "idempotency_key_reused", thrown instanceof Error ? thrown.message : thrown);
      if (first.ok) await db.lead.update({ where: { id: first.data.id }, data: { createdAt: new Date(Date.now() - 25 * HOUR) } });
      const later = await create("Zz idem a day later", "zz-request-0001");
      const old = first.ok ? await db.lead.findUnique({ where: { id: first.data.id }, select: { idempotencyKey: true } }) : null;
      ok("older than a day: no longer a match — a new lead, which takes the token over", later.ok && first.ok && later.data.id !== first.data.id && old?.idempotencyKey === null, later.ok ? { later: later.data.id, old } : later.error);
      const replay = await create("Zz idem a day later", "zz-request-0001");
      ok("  and the same request again is that new lead", replay.ok && later.ok && replay.data.id === later.data.id);
      const raced = await Promise.all(Array.from({ length: 6 }, () => create("Zz idem raced", "zz-request-0002")));
      ok("six of one request at once: one lead, every answer it", raced.every((r) => r.ok) && new Set(raced.map((r) => (r.ok ? r.data.id : ""))).size === 1 && (await db.lead.count({ where: { title: "Zz idem raced" } })) === 1, raced.map((r) => (r.ok ? r.data.id : r.error)));
    }
    void DAY;
  } finally {
    actor = null;
    undoNotifier?.();
    await side?.$disconnect().catch(() => {});
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratch}'`);
    ok("the scratch database is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
    if (existsSync(outbox)) {
      for (const file of readdirSync(outbox)) if (/zz-booking\.example/.test(readFileSync(join(outbox, file), "utf8"))) unlinkSync(join(outbox, file));
      if (!outboxThere && readdirSync(outbox).length === 0) rmdirSync(outbox);
    }
  }

  console.log(failures === 0 ? `\nAll ${passes} lead intake checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
