/**
 * check:masking-lib — the masking guard's KNOWN_GAPS in src/lib closed (owner, 5 Nov 2026 — Phase 3 masking fixes, wave B):
 * each screen fed from these modules shows a contact's, a lead's or a company's masked values masked for the person
 * looking — by their list answers — and none of its responses carries the raw value; what the server does with the
 * real value (a send, an invite, a merge, grouping, a repair) is unchanged, and somebody with no masks sees what they did.
 *
 *    1. Marketing › Subscribers (src/lib/marketing/subscribers.ts): each subscriber's name and address; its search
 *       doesn't match a masked address.
 *    2. The app's due callbacks (src/lib/app/calls.ts): each contact's number and name, and the notes quoting them.
 *    3. Automate's test sample (src/lib/automate/samples.ts): the lead a test starts from, as the tester sees it.
 *    4. A workflow's Emails report (src/lib/automate/email-report.ts), and the action behind its page and Excel: each
 *       contact recipient, and the subject quoting them.
 *    5. Settings › Data › Duplicate leads (src/lib/leads/duplicates.ts): each lead's name, its company's and contact's.
 *    6. The phone repair plan (src/lib/leads/phone-repair.ts): each contact's name, the number from and the number to.
 *    7. The company merge preview (src/lib/companies/merge.ts): both companies' people, website, PAN, GSTINs and place,
 *       and the pairs' reasons.
 *    8. A form's Invite dialog (src/lib/forms/send-invites.ts): each candidate's name and address.
 *    9. A renewal notice's recipients and its preview (src/lib/marketing/order-notice.ts): each contact, and the words.
 *   10. The Schedule meeting dialog (src/lib/calendar/records.ts, src/actions/calendar.ts): the record's people — the
 *       meeting still invites the real address.
 *
 * The Mail dialog's recipients (src/lib/documents/send-email.ts) are checked in check:document-mail, and the statement
 * dialog's in check:statement-print, where those dialogs' documents and sends are set up.
 *
 * Makes a sales person of its own with personal field policies, two companies with their people, leads, a callback and
 * a workflow with a run, and removes all of it after.
 *
 *   npm run check:masking-lib            (`-- --only=3,4` runs those sections)
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

type Actor = { id: string; role: string; name: string; email: string };
let actor: Actor | null = null;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/lib/modules-access" || request.endsWith("lib/modules-access")) {
    const real = realLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, requireModuleUser: async () => actor, requireModuleAccess: async () => actor, switchedOn: async () => true };
  }
  if (request === "@/actions/module" || request.endsWith("actions/module")) {
    const real = realLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, isModuleEnabled: async () => true };
  }
  return realLoad.call(this, request, parent, isMain);
} as typeof realLoad;

const db = directClient();
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
/** The raw values among `values` that `value` still carries anywhere, in any case. */
const leaks = (value: unknown, values: (string | null | undefined)[]) =>
  values.filter((v): v is string => !!v && v.trim().length >= 3 && JSON.stringify(value ?? null).toLowerCase().includes(v.trim().toLowerCase()));
const masked = (shown: string | null | undefined, real: string) => !!shown && shown !== real && shown.includes("*");

const MASK = { view: true, maskInList: true, maskInDetail: true, unmask: true };
const TAG = "ZZML";
const RUN = Date.now().toString(36);
const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice("--only=".length).split(",").filter(Boolean).map(Number);
const wanted = (n: number) => only.length === 0 || only.includes(n);

async function main() {
  const made: { userId?: string; companyIds: string[]; leadIds: string[]; callId?: string; workflowId?: string; messageId?: string } = { companyIds: [], leadIds: [] };
  const masking = await db.fieldMaskingSettings.findUnique({ where: { id: "global" } });
  // A digit run of this run's own, so each number is nobody else's.
  const digits = String(Date.now()).slice(-4);
  try {
    await db.fieldMaskingSettings.upsert({ where: { id: "global" }, create: { id: "global", enabled: true }, update: { enabled: true } });

    // ── Who is looking, and what ──────────────────────────────────────────────────────────────────
    const viewer = await db.user.create({ data: { name: `Zzml Viewer ${RUN}`, email: `zzml-viewer-${RUN}@zzml.example`, role: "SALES", passwordHash: "x".repeat(60) }, select: { id: true, name: true, email: true, role: true } });
    made.userId = viewer.id;
    actor = viewer;
    // What the screens below ask of them, held by rows of this check's own.
    await db.userPermission.createMany({
      data: ["settings.manage", "contacts.view", "meetings.schedule"].map((permission) => ({ userId: viewer.id, permission, allowed: true, reason: TAG })),
    });
    await db.userFieldPolicy.createMany({
      data: [
        { entity: "contacts", field: "name", format: "first" },
        { entity: "contacts", field: "email", format: "email" },
        { entity: "contacts", field: "phone", format: "phone_last4" },
        { entity: "leads", field: "title", format: "first" },
        { entity: "leads", field: "companyName", format: "first" },
        { entity: "leads", field: "contactName", format: "first" },
        { entity: "companies", field: "address", format: "stars" },
        { entity: "companies", field: "gstin", format: "stars" },
        { entity: "companies", field: "pan", format: "stars" },
        { entity: "companies", field: "website", format: "stars" },
      ].map((p) => ({ userId: viewer.id, ...MASK, ...p, reason: TAG })),
    });

    const company = (side: string, extra: { website: string; panNumber: string; gst: string }) =>
      db.company.create({
        data: {
          name: `Zzml ${side} ${RUN}`,
          normalizedName: `zzml ${side.toLowerCase()} ${RUN}`,
          createdById: viewer.id,
          ownerUserId: viewer.id,
          website: extra.website,
          panNumber: extra.panNumber,
          locations: { create: { label: "HO", isPrimary: true, address: `${side} Zzmlstreet 12`, city: `Zzmlcity${side}`, state: `Zzmlstate${side}`, pincode: "110099", gstNumber: extra.gst } },
        },
        select: { id: true, name: true, website: true, panNumber: true },
      });
    const keep = await company("Keep", { website: `https://keep-${RUN}.zzml.example`, panNumber: "ZZMLK1234A", gst: "07ZZMLK1234A1Z5" });
    const drop = await company("Drop", { website: `https://drop-${RUN}.zzml.example`, panNumber: "ZZMLD1234A", gst: "07ZZMLD1234A1Z5" });
    made.companyIds.push(keep.id, drop.id);
    const asha = await db.contact.create({ data: { companyId: keep.id, name: `Ashazzml Rao ${RUN}`, email: `asha-${RUN}@zzml-mail.example`, phone: `+91 98765 0${digits}`, isPrimary: true }, select: { id: true, name: true, email: true, phone: true } });
    // The same person under the duplicate: the merge pairs them by address.
    const ashaToo = await db.contact.create({ data: { companyId: drop.id, name: asha.name, email: asha.email, phone: `+91 98765 1${digits}` }, select: { id: true, name: true, email: true, phone: true } });
    // And one by number and name, with no address on either side.
    const ravi = await db.contact.create({ data: { companyId: keep.id, name: `Ravizzml Iyer ${RUN}`, phone: `+91 98111 2${digits}` }, select: { id: true, name: true, phone: true } });
    const raviToo = await db.contact.create({ data: { companyId: drop.id, name: ravi.name, phone: ravi.phone }, select: { id: true } });
    const broken = await db.contact.create({ data: { companyId: keep.id, name: `Brokenzzml Shah ${RUN}`, email: `broken-${RUN}@zzml-mail.example`, phone: "9.20E+11" }, select: { id: true, name: true, email: true, phone: true } });
    const raw = [asha.name, asha.email!, asha.phone!];

    // ── 1 ─────────────────────────────────────────────────────────────────────────────────────────
    if (wanted(1)) {
      section("1. Marketing › Subscribers");
      try {
        const { subscribersPage } = await import("../src/lib/marketing/subscribers");
        await db.contactConsent.create({ data: { contactId: asha.id, channel: "EMAIL", topic: "OFFERS", status: "SUBSCRIBED" } });
        const page = await subscribersPage(keep.name, 1, viewer.id);
        const row = page.rows.find((r) => r.id === asha.id);
        ok("the subscriber is listed, their address masked", masked(row?.email, asha.email!), row?.email);
        ok("  their name masked as the contacts policy says", masked(row?.name, asha.name), row?.name);
        ok("  the page carries no raw value", leaks(page, raw).length === 0, leaks(page, raw));
        const byAddress = await subscribersPage(asha.email!, 1, viewer.id);
        ok("  a search on the masked address doesn't find them", !byAddress.rows.some((r) => r.id === asha.id), byAddress.total);
        const stored = (await subscribersPage(keep.name, 1)).rows.find((r) => r.id === asha.id);
        ok("asked by no one (the server's own use), the address as stored", stored?.email === asha.email, stored?.email);
      } catch (e) {
        ok("1 ran", false, (e as Error).message);
      }
    }

    // ── 2 ─────────────────────────────────────────────────────────────────────────────────────────
    if (wanted(2)) {
      section("2. The app's due callbacks");
      try {
        const { dueCallbacks } = await import("../src/lib/app/calls");
        const call = await db.callLog.create({
          data: { companyId: keep.id, contactId: asha.id, userId: viewer.id, phoneNumber: asha.phone!, outcome: "NO_ANSWER", startedAt: new Date(), followUpAt: new Date(Date.now() + 3_600_000), followUpDone: false, notes: `ZZML rang ${asha.name} on ${asha.phone} — call back` },
          select: { id: true },
        });
        made.callId = call.id;
        const due = await dueCallbacks();
        const row = due.find((r) => r.id === call.id);
        ok("the callback is listed, its number masked", masked(row?.number, asha.phone!), row?.number);
        ok("  the contact's name masked", masked(row?.contact, asha.name), row?.contact);
        ok("  no raw number or name, the notes included", !!row && leaks(row, raw).length === 0, row && leaks(row, raw));
      } catch (e) {
        ok("2 ran", false, (e as Error).message);
      }
    }

    // Two leads at the keep company, alike, the second "imported": a duplicate group, and the latest lead for a sample.
    const title = `Zzml duplicated enquiry ${RUN}`;
    for (const externalId of [null, `zzml-${RUN}`]) {
      made.leadIds.push((await db.lead.create({ data: { companyId: keep.id, contactId: asha.id, ownerUserId: viewer.id, title, externalId, lostReason: null }, select: { id: true } })).id);
    }

    // ── 3 ─────────────────────────────────────────────────────────────────────────────────────────
    if (wanted(3)) {
      section("3. Automate's test sample");
      try {
        const { sampleTrigger } = await import("../src/lib/automate/samples");
        const sample = await sampleTrigger(viewer.id, "lead.created");
        const leadId = (sample?.payload as { lead?: { id?: string } } | undefined)?.lead?.id ?? null;
        const real = leadId ? await db.lead.findUnique({ where: { id: leadId }, select: { title: true, company: { select: { name: true } }, contact: { select: { name: true } } } }) : null;
        ok("a sample: the latest lead the tester can see", !!sample && !!real, sample?.about);
        const shownTitle = (sample?.payload as { lead?: { title?: string } } | undefined)?.lead?.title;
        ok("  its name as the tester sees it in a list", !!real && masked(shownTitle, real.title), shownTitle);
        ok("  and so in what the builder says it is", !!real && !!sample && !sample.about.includes(real.title), sample?.about);
        const secrets = real ? [real.title, real.company.name, real.contact?.name] : [];
        ok("  no raw name, company or contact anywhere in it", !!sample && leaks(sample, secrets).length === 0, sample && leaks(sample, secrets));
      } catch (e) {
        ok("3 ran", false, (e as Error).message);
      }
    }

    // ── 4 ─────────────────────────────────────────────────────────────────────────────────────────
    if (wanted(4)) {
      section("4. A workflow's Emails report");
      try {
        const { workflowEmailReport } = await import("../src/lib/automate/email-report");
        const { workflowEmails } = await import("../src/actions/automate-emails");
        const { workflowRef } = await import("../src/lib/automate/refs");
        const definition = { trigger: { type: "manual" }, steps: [{ id: "s-email", type: "action", action: "email.send", input: {} }] };
        const workflow = await db.automationWorkflow.create({ data: { name: `Zzml workflow ${RUN}`, ownerUserId: viewer.id, createdById: viewer.id, draft: definition }, select: { id: true, workflowSeq: true } });
        made.workflowId = workflow.id;
        const version = await db.automationVersion.create({ data: { workflowId: workflow.id, number: 1, definition, definitionHash: TAG, triggerType: "manual", publishedById: viewer.id }, select: { id: true } });
        const now = new Date();
        const run = await db.automationRun.create({ data: { workflowId: workflow.id, idempotencyKey: `zzml-${RUN}`, status: "SUCCEEDED", cursor: {}, contextCipher: TAG, isTest: false, versionId: version.id, finishedAt: now }, select: { id: true } });
        await db.automationRunStep.create({ data: { runId: run.id, stepId: "s-email", type: "action", attempt: 1, status: "SUCCEEDED", startedAt: new Date(now.getTime() - 1000), finishedAt: now, outputSummary: { sent: true, from: "zzml@example.com", recipient: "contact", contactId: asha.id } } });
        made.messageId = (
          await db.marketingMessage.create({
            data: { token: `zzml-${RUN}`, companyId: keep.id, contactId: asha.id, channel: "EMAIL", messageClass: "TRANSACTIONAL", subject: `ZZML a note for ${asha.name} (${asha.email})`, body: "<p>x</p>", toEmail: asha.email, status: "SENT", scheduledFor: now, sentAt: now, attempts: 1 },
            select: { id: true },
          })
        ).id;
        const report = await workflowEmailReport(workflow.id, viewer.id);
        const row = report.rows[0];
        ok("the send is listed: its contact's name and address masked", masked(row?.recipientName, asha.name) && masked(row?.recipientEmail, asha.email!), row && { name: row.recipientName, email: row.recipientEmail });
        ok("  the subject quoting them redacted, not dropped", !!row?.subject && row.subject.startsWith("ZZML a note for") && leaks(row.subject, raw).length === 0, row?.subject);
        ok("  the report carries no raw value", leaks(report, raw).length === 0, leaks(report, raw));
        const page = await workflowEmails(workflowRef(workflow.workflowSeq));
        ok("the page's and the Excel's action: the same, masked", !!page && page.report.rows.length === 1 && leaks(page, raw).length === 0, page ? leaks(page, raw) : "no report");
        const stored = await workflowEmailReport(workflow.id, null);
        ok("asked by no one, as stored", stored.rows[0]?.recipientEmail === asha.email, stored.rows[0]?.recipientEmail);
      } catch (e) {
        ok("4 ran", false, (e as Error).message);
      }
    }

    // ── 5 ─────────────────────────────────────────────────────────────────────────────────────────
    if (wanted(5)) {
      section("5. Settings › Data › Duplicate leads");
      try {
        const { findDuplicateLeads } = await import("../src/lib/leads/duplicates");
        const groups = await findDuplicateLeads(viewer.id);
        const group = groups.find((g) => g.keep.id === made.leadIds[0]);
        ok("the import's copy is found, grouped on the real name", !!group && group.copies.some((c) => c.id === made.leadIds[1]));
        ok("  each lead's name masked", !!group && masked(group.keep.title, title) && group.copies.every((c) => masked(c.title, title)), group && [group.keep.title, ...group.copies.map((c) => c.title)]);
        const secrets = [title, keep.name, asha.name];
        ok("  no raw lead name, company or contact name in the group", !!group && leaks(group, secrets).length === 0, group && leaks(group, secrets));
        const stored = (await findDuplicateLeads()).find((g) => g.keep.id === made.leadIds[0]);
        ok("asked by no one (the removal's own read), as stored", stored?.keep.title === title, stored?.keep.title);
      } catch (e) {
        ok("5 ran", false, (e as Error).message);
      }
    }

    // ── 6 ─────────────────────────────────────────────────────────────────────────────────────────
    if (wanted(6)) {
      section("6. The phone repair plan");
      try {
        const { planPhoneRepair } = await import("../src/lib/leads/phone-repair");
        const fileNumber = `+91987650${digits}9`;
        const rows = [{ "Contact email": broken.email!, "Contact phone": fileNumber }];
        const plan = await planPhoneRepair(rows, [broken.id], viewer.id);
        const fix = "error" in plan ? null : plan.sample.find((f) => f.contactId === broken.id);
        ok("the shortened number is matched by the email", !!fix && !("error" in plan) && plan.fixable === 1, "error" in plan ? plan.error : plan.fixable);
        ok("  the contact's name, and the number from and to, masked", !!fix && masked(fix.name, broken.name) && masked(fix.from, broken.phone!) && masked(fix.to, fileNumber), fix);
        const secrets = [broken.name, broken.phone, fileNumber, fileNumber.slice(3)];
        ok("  the plan carries no raw value", leaks(plan, secrets).length === 0, leaks(plan, secrets));
        const stored = await planPhoneRepair(rows, [broken.id]);
        ok("asked by no one (the repair's own read), as it will be written", !("error" in stored) && stored.sample[0]?.to.replace(/\D/g, "").endsWith(fileNumber.replace(/\D/g, "").slice(-10)) === true, "error" in stored ? stored.error : stored.sample[0]);
      } catch (e) {
        ok("6 ran", false, (e as Error).message);
      }
    }

    // ── 7 ─────────────────────────────────────────────────────────────────────────────────────────
    if (wanted(7)) {
      section("7. The company merge preview");
      try {
        const { planMerge } = await import("../src/lib/companies/merge");
        const plan = await planMerge(keep.id, drop.id, viewer.id);
        const person = plan?.keep.contacts.find((c) => c.id === asha.id);
        ok("both companies' people: name, address and number masked", !!person && masked(person.name, asha.name) && masked(person.email, asha.email!) && masked(person.phone, asha.phone!), person);
        const field = (key: string) => plan?.fields.find((f) => f.key === key);
        ok("  the website and the PAN, either side, masked", masked(field("website")?.keep, keep.website!) && masked(field("website")?.drop, drop.website!) && masked(field("panNumber")?.keep, keep.panNumber!), [field("website"), field("panNumber")]);
        ok("  the GSTINs and the place masked", !!plan && masked(plan.keep.gstins[0], "07ZZMLK1234A1Z5") && !!plan.keep.place && !plan.keep.place.includes("Zzmlcity"), plan && { gstins: plan.keep.gstins, place: plan.keep.place });
        const pair = plan?.contactPairs.find((p) => p.keepId === asha.id && p.dropId === ashaToo.id);
        ok("  the pair is found on the real address, its reason naming it masked", !!pair && pair.reason.startsWith("Same email") && leaks(pair, raw).length === 0, pair?.reason);
        const secrets = [...raw, ashaToo.phone, ravi.name, ravi.phone, keep.website, drop.website, keep.panNumber, drop.panNumber, "07ZZMLK1234A1Z5", "07ZZMLD1234A1Z5", "ZzmlcityKeep", "ZzmlstateDrop"];
        ok("  the preview carries no raw value", !!plan && leaks(plan, secrets).length === 0, plan && leaks(plan, secrets));
        const byNumber = (p: typeof plan) => p?.contactPairs.find((x) => x.keepId === ravi.id && x.dropId === raviToo.id)?.reason;
        ok("  a pair by number: its last four, which this policy shows anyway", byNumber(plan)?.startsWith("Same phone …") === true && byNumber(plan)!.includes(digits), byNumber(plan));
        await db.userFieldPolicy.update({ where: { user_entity_field: { userId: viewer.id, entity: "contacts", field: "phone" } }, data: { format: "stars" } });
        const starred = await planMerge(keep.id, drop.id, viewer.id);
        await db.userFieldPolicy.update({ where: { user_entity_field: { userId: viewer.id, entity: "contacts", field: "phone" } }, data: { format: "phone_last4" } });
        ok("  …and none of it where the number is all stars", byNumber(starred)?.startsWith("Same phone") === true && !/\d/.test(byNumber(starred) ?? "0"), byNumber(starred));
        const stored = await planMerge(keep.id, drop.id);
        ok("asked by no one, as stored", stored?.keep.contacts.find((c) => c.id === asha.id)?.email === asha.email && stored?.contactPairs.length === 2, stored?.contactPairs.map((p) => p.reason));
      } catch (e) {
        ok("7 ran", false, (e as Error).message);
      }
    }

    // ── 8 ─────────────────────────────────────────────────────────────────────────────────────────
    if (wanted(8)) {
      section("8. A form's Invite dialog");
      try {
        const { inviteCandidates } = await import("../src/lib/forms/send-invites");
        const form = { id: `zzml-no-form-${RUN}`, topic: "EVENTS" as const };
        const [person] = await inviteCandidates(form, [asha.id], viewer.id);
        ok("the candidate's name and address masked", !!person && masked(person.name, asha.name) && masked(person.email, asha.email!), person && { name: person.name, email: person.email });
        ok("  whether they can be written to is worked out on the real address", person?.canReceive === true, person?.blockedBecause);
        ok("  no raw value", !!person && leaks(person, raw).length === 0, person && leaks(person, raw));
        const [stored] = await inviteCandidates(form, [asha.id]);
        ok("asked by no one (the send's own read), as stored", stored?.email === asha.email);
      } catch (e) {
        ok("8 ran", false, (e as Error).message);
      }
    }

    // ── 9 ─────────────────────────────────────────────────────────────────────────────────────────
    if (wanted(9)) {
      section("9. A renewal notice's recipients and preview");
      try {
        const { previewCustomerNotice, resolveNoticeRecipients } = await import("../src/lib/marketing/order-notice");
        // A live subscription whose customer has somebody who can be written to, as check:notice-preview finds one.
        const candidates = await db.companyProduct.findMany({
          where: { orderStatus: "FULFILLED", parentId: null, item: { type: "SUBSCRIPTION" }, endDate: { not: null }, company: { contacts: { some: { email: { not: null } } } } },
          select: { id: true },
          take: 40,
        });
        let order: string | null = null;
        let people: { id: string; name: string; email: string | null; phone: string | null; canReceive: boolean }[] = [];
        for (const c of candidates) {
          const r = await resolveNoticeRecipients(c.id, "RENEWAL");
          if (r?.contacts.some((x) => x.canReceive && x.email)) {
            order = c.id;
            people = r.contacts;
            break;
          }
        }
        if (!order) ok("a subscription to write about — none here with somebody to write to", true);
        else {
          const secrets = people.flatMap((p) => [p.name, p.email, p.phone]);
          const shown = await resolveNoticeRecipients(order, "RENEWAL", viewer.id);
          const first = people.find((p) => p.canReceive && p.email)!;
          const row = shown?.contacts.find((c) => c.id === first.id);
          ok("the dialog's recipients: each name, address and number masked", !!row && masked(row.email, first.email!) && masked(row.name, first.name), row && { name: row.name, email: row.email });
          ok("  who can be written to is worked out on the real address", row?.canReceive === true);
          ok("  no raw value among them", !!shown && leaks(shown.contacts, secrets).length === 0, shown && leaks(shown.contacts, secrets));
          const preview = await previewCustomerNotice({ companyProductId: order, contactIds: [first.id], kind: "RENEWAL", note: `ZZML for ${first.name} at ${first.email}`, origin: "https://example.test", sentByUserId: viewer.id });
          ok("the preview: to the person ticked, masked", preview.ok && masked(preview.data.to.email, first.email!) && masked(preview.data.to.name, first.name), preview.ok ? preview.data.to : preview.error);
          ok("  its words quoting them redacted", preview.ok && preview.data.text.includes("ZZML for") && leaks(preview.data, secrets).length === 0, preview.ok ? leaks(preview.data, secrets) : "");
          const plain = await previewCustomerNotice({ companyProductId: order, contactIds: [first.id], kind: "RENEWAL", origin: "https://example.test" });
          ok("asked by no one, as it goes", plain.ok && plain.data.to.email === first.email, plain.ok ? plain.data.to : plain.error);
        }
      } catch (e) {
        ok("9 ran", false, (e as Error).message);
      }
    }

    // ── 10 ────────────────────────────────────────────────────────────────────────────────────────
    if (wanted(10)) {
      section("10. The Schedule meeting dialog");
      try {
        const calendar = await import("../src/actions/calendar");
        const { meetingRecordFor } = await import("../src/lib/calendar/records");
        const form = await calendar.meetingFormFor({ record: { kind: "company", id: keep.id } });
        const person = form.ok ? form.data.record?.contacts.find((c) => c.id === asha.id) : undefined;
        ok("the dialog lists the record's people, each name and address masked", !!person && masked(person.name, asha.name) && masked(person.email, asha.email!), form.ok ? person : form.error);
        ok("  the dialog carries no raw value", form.ok && leaks(form.data.record, raw).length === 0, form.ok ? leaks(form.data.record, raw) : "");
        const record = await meetingRecordFor(viewer.id, { kind: "company", id: keep.id });
        ok("what the meeting invites, by contact id, is the real address", record?.contacts.find((c) => c.id === asha.id)?.email === asha.email);
      } catch (e) {
        ok("10 ran", false, (e as Error).message);
      }
    }
  } finally {
    actor = null;
    const userId = made.userId;
    if (made.messageId) await db.marketingMessage.deleteMany({ where: { id: made.messageId } });
    if (made.workflowId) {
      await db.automationRunStep.deleteMany({ where: { run: { workflowId: made.workflowId } } });
      await db.automationRun.deleteMany({ where: { workflowId: made.workflowId } });
      await db.automationVersion.deleteMany({ where: { workflowId: made.workflowId } });
      await db.automationWorkflow.deleteMany({ where: { id: made.workflowId } });
    }
    if (made.callId) await db.callLog.deleteMany({ where: { id: made.callId } });
    if (made.leadIds.length) await db.lead.deleteMany({ where: { id: { in: made.leadIds } } });
    if (made.companyIds.length) {
      await db.contactConsent.deleteMany({ where: { contact: { companyId: { in: made.companyIds } } } });
      await db.contact.deleteMany({ where: { companyId: { in: made.companyIds } } });
      await db.companyLocation.deleteMany({ where: { companyId: { in: made.companyIds } } });
      await db.company.deleteMany({ where: { id: { in: made.companyIds } } });
    }
    if (userId) {
      await db.userFieldPolicy.deleteMany({ where: { userId } });
      await db.userPermission.deleteMany({ where: { userId } });
      await db.auditLog.deleteMany({ where: { userId } });
      await db.user.deleteMany({ where: { id: userId } });
    }
    if (masking) await db.fieldMaskingSettings.update({ where: { id: "global" }, data: { enabled: masking.enabled } });
    else await db.fieldMaskingSettings.deleteMany({ where: { id: "global" } });
    const left = await Promise.all([db.user.count({ where: { email: { endsWith: "@zzml.example" } } }), db.company.count({ where: { normalizedName: { startsWith: "zzml " } } }), db.lead.count({ where: { title: { startsWith: "Zzml " } } })]);
    ok("everything this check made is gone", left.every((n) => n === 0), left);
  }

  console.log(failures === 0 ? `\nAll ${passes} masking-lib checks passed.\n` : `\n${failures} check(s) failed (${passes} passed).\n`);
  await db.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
