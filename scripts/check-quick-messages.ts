/**
 * check:quick-messages — a ready-written email or WhatsApp to a customer, sent by hand (owner, 11 Nov 2026):
 * after a call, and to introduce a new account manager. src/lib/quick-messages.
 *
 *   1. Fields: filled per person; a field with no value and no fallback stops the message; WhatsApp's {{1}}, {{2}}…
 *      are numbered as the text first names them.
 *   2. The starter templates: given once, each sound.
 *   3. A new account manager: noted when the manager changes, gone when it changes back or is told or dismissed.
 *   4. Email: from the sender's mailbox, each contact's own name; the introduction from the NEW manager with the
 *      previous one copied; kept on the contact's mail log; someone who left or has no address is not mailed.
 *   5. WhatsApp: free text inside 24 hours of the customer's message; the approved template, its values in order,
 *      outside; refused with no approved template.
 *   6. Only whoever holds "Message customers from templates".
 *   8. From the phone: the same follow-up for one of the person's own calls (src/lib/app/follow-up.ts) — the
 *      templates for how it went, sent as the web sends them; somebody else's call, or no permission, gets nothing.
 *   7. A template's PDF — the company profile: a PDF by its bytes, up to 5 MB; with the email, on WhatsApp as a
 *      document (after the words inside 24 hours, in the template's header outside); left off when unticked.
 *
 * Nothing leaves the machine: the mailbox and WhatsApp are stubbed. People on @zzprobe-qm.invalid, a customer and a
 * WhatsApp number of its own, removed in a finally.
 *
 *   npm run check:quick-messages
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";
import { STARTERS } from "../src/lib/quick-messages/starters";
import { callResultOf, fieldsInOrder, fill, metaText, templateRefusal, whatsappVariables } from "../src/lib/quick-messages/fields";

type Mail = { userId: string; subject: string; html: string; to: { name: string; email: string }[]; cc?: { name: string | null; email: string }[]; attachments: { name: string; contentType: string; bytes: Buffer }[] };
const mails: Mail[] = [];
let actorId = "";
const MAIL = "@zzprobe-qm.invalid";
const TAG = "ZZPROBE_QM";

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "SALES", name: "Zzprobe", email: `actor${MAIL}` });
    return { requireUser: async () => user(), currentUser: async () => user(), viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  // Every person has a working mailbox, and what it would send is kept here instead.
  if (request === "@/lib/mail/mailbox" || request.endsWith("lib/mail/mailbox")) {
    return {
      mailboxState: async (userId: string) => ({ state: "connected", provider: "MICROSOFT", mailbox: `${userId}${MAIL}` }),
      sendAsUser: async (userId: string, mail: Omit<Mail, "userId">) => {
        mails.push({ userId, ...mail, attachments: mail.attachments ?? [] });
        return { ok: true, mailbox: `${userId}${MAIL}`, provider: "MICROSOFT" };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};

async function cleanup() {
  const users = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  const channels = (await db.inboxChannel.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  await db.conversationMessage.deleteMany({ where: { conversation: { channelId: { in: channels } } } });
  await db.conversation.deleteMany({ where: { channelId: { in: channels } } });
  await db.inboxChannel.deleteMany({ where: { id: { in: channels } } });
  await db.accountManagerNotice.deleteMany({ where: { companyId: { in: companies } } });
  await db.marketingMessage.deleteMany({ where: { companyId: { in: companies } } });
  await db.callLog.deleteMany({ where: { companyId: { in: companies } } });
  await db.contact.deleteMany({ where: { companyId: { in: companies } } });
  await db.company.deleteMany({ where: { id: { in: companies } } });
  const mine = (await db.quickTemplate.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((t) => t.id);
  await db.quickTemplateFile.deleteMany({ where: { templateId: { in: mine } } });
  await db.quickTemplate.deleteMany({ where: { id: { in: mine } } });
  await db.userPermission.deleteMany({ where: { userId: { in: users } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
}

async function main() {
  console.log("\n— 1. Fields —\n");
  const values = { firstName: "Rajesh", myName: "Priya", ourName: "Acme" };
  ok("fields are filled", fill("Hi {{firstName}}, {{myName}} from {{ourName}}", values).text === "Hi Rajesh, Priya from Acme");
  const blank = fill("Hi {{firstName}}, call {{myPhone}}", { firstName: "Rajesh" });
  ok("a field with no value and no fallback stops it, by name", !blank.ok && blank.missing.join() === "myPhone");
  ok("  a fallback is used instead", fill("Hi {{firstName|there}}", {}).text === "Hi there" && fill("Hi {{firstName|there}}", {}).ok);
  ok("  something that isn't a field is named", fill("Hi {{nickname}}", {}).unknown.join() === "nickname");
  const wa = "Hi {{firstName|there}}, I'm {{myName}} from {{ourName}}. {{myName}} here.";
  ok("WhatsApp's fields are numbered as they first appear", metaText(wa) === "Hi {{1}}, I'm {{2}} from {{3}}. {{2}} here." && fieldsInOrder(wa).map((f) => f.key).join() === "firstName,myName,ourName");
  const vars = whatsappVariables(wa, { myName: "Priya", ourName: "Acme" });
  ok("  and its values go in that order, a fallback standing in", vars.ok && vars.variables.join("|") === "there|Priya|Acme", vars);
  ok("  a value missing with no fallback stops it", !whatsappVariables("{{myPhone}}", {}).ok);
  ok("a call that connected, and one that didn't", callResultOf("CONNECTED") === "CONNECTED" && callResultOf("NO_ANSWER") === "NOT_CONNECTED" && callResultOf("BUSY") === "NOT_CONNECTED" && callResultOf(null) === null);
  ok("a template needs a name, something to send, and a subject for its email", templateRefusal({ name: "", emailBody: "x" }) !== null && templateRefusal({ name: "A" }) !== null && templateRefusal({ name: "A", emailBody: "x" }) !== null && templateRefusal({ name: "A", emailSubject: "s", emailBody: "x" }) === null);
  ok("  a Meta name is lower case, digits and underscores", templateRefusal({ name: "A", whatsappBody: "x", whatsappTemplateName: "Bad Name" }) !== null && templateRefusal({ name: "A", whatsappBody: "x", whatsappTemplateName: "good_name_1" }) === null);

  console.log("\n— 2. The starters —\n");
  ok("each starter is sound", STARTERS.every((s) => templateRefusal(s) === null), STARTERS.filter((s) => templateRefusal(s)).map((s) => s.key));
  ok("one is written to carry the company profile", STARTERS.filter((x) => x.wantsFile).length === 1 && /attached/.test(STARTERS.find((x) => x.wantsFile)!.emailBody));
  ok("one introduces a new account manager; after a call there is one for each way it went", STARTERS.some((s) => s.moment === "MANAGER_CHANGED") && STARTERS.some((s) => s.callResult === "CONNECTED") && STARTERS.some((s) => s.callResult === "NOT_CONNECTED"));

  /* eslint-disable @typescript-eslint/no-require-imports */
  const server = require("../src/lib/quick-messages/server") as typeof import("../src/lib/quick-messages/server");
  const notices = require("../src/lib/quick-messages/notices") as typeof import("../src/lib/quick-messages/notices");
  const actions = require("../src/actions/quick-messages") as typeof import("../src/actions/quick-messages");
  const whatsapp = require("../src/lib/inbox/whatsapp") as typeof import("../src/lib/inbox/whatsapp");
  const phone = require("../src/lib/app/follow-up") as typeof import("../src/lib/app/follow-up");
  /* eslint-enable @typescript-eslint/no-require-imports */
  type Sent = Parameters<NonNullable<Parameters<typeof whatsapp.setTestWhatsAppSender>[0]>>[0];
  const chats: Sent[] = [];
  whatsapp.setTestWhatsAppSender(async (m) => {
    chats.push(m);
    return { ok: true, id: `wamid.${chats.length}` };
  });

  await cleanup();
  try {
    const first = await server.listQuickTemplates();
    const again = await server.listQuickTemplates();
    ok("the starters are given once", first.filter((t) => t.starter).length === STARTERS.length && again.length === first.length, first.length);
    const afterMissed = await server.listQuickTemplates({ moment: "AFTER_CALL", outcome: "NO_ANSWER", activeOnly: true });
    ok("after a call nobody answered: the missed-call ones, not the thank-yous", afterMissed.some((t) => t.callResult === "NOT_CONNECTED") && !afterMissed.some((t) => t.callResult === "CONNECTED"));

    const person = (local: string, name: string) => db.user.create({ data: { name, email: `${local}${MAIL}`, role: "SALES", phone: "+91 98100 00001", passwordHash: "!" }, select: { id: true, name: true, email: true } });
    const old = await person("old", "Zz Old Manager");
    const fresh = await person("new", "Zz New Manager");
    const admin = await person("admin", "Zz Admin");
    const outsider = await person("outsider", "Zz Outsider");
    for (const u of [old, fresh, admin]) {
      await db.userPermission.createMany({ data: [{ userId: u.id, permission: "messages.send", allowed: true, reason: TAG }, { userId: u.id, permission: "companies.viewAll", allowed: true, reason: TAG }, { userId: u.id, permission: "contacts.view", allowed: true, reason: TAG }] });
    }
    await db.userPermission.create({ data: { userId: outsider.id, permission: "messages.send", allowed: false, reason: TAG } });
    const company = await db.company.create({ data: { name: `${TAG} Customer`, normalizedName: `${TAG} customer`.toLowerCase(), createdById: old.id, ownerUserId: old.id, relationshipType: "CLIENT", stage: "CUSTOMER" }, select: { id: true } });
    const contact = (name: string, email: string | null, phone: string | null, extra: object = {}) => db.contact.create({ data: { companyId: company.id, name, email, phone, ...extra }, select: { id: true } });
    const rajesh = await contact("Rajesh Kumar", `rajesh${MAIL}`, "+91 98200 00011", { isPrimary: true });
    const meera = await contact("Meera Shah", `meera${MAIL}`, null);
    const gone = await contact("Gone Person", `gone${MAIL}`, null, { leftAt: new Date() });
    const noMail = await contact("No Mail", null, "+91 98200 00022");

    console.log("\n— 3. A new account manager —\n");
    ok("nothing to tell before anything changes", (await notices.pendingNotice(company.id)) === null);
    await db.company.update({ where: { id: company.id }, data: { ownerUserId: fresh.id } });
    await notices.recordManagerChange([{ companyId: company.id, fromUserId: old.id }], fresh.id, admin.id);
    const waiting = await notices.pendingNotice(company.id);
    ok("the change is kept: who took over, and from whom", waiting?.toName === "Zz New Manager" && waiting.fromName === "Zz Old Manager", waiting);
    await db.company.update({ where: { id: company.id }, data: { ownerUserId: old.id } });
    await notices.recordManagerChange([{ companyId: company.id, fromUserId: fresh.id }], old.id, admin.id);
    ok("changed back before anybody was told: nothing to tell", (await notices.pendingNotice(company.id)) === null);
    await db.company.update({ where: { id: company.id }, data: { ownerUserId: fresh.id } });
    await notices.recordManagerChange([{ companyId: company.id, fromUserId: old.id }], fresh.id, admin.id);
    actorId = admin.id;
    const listed = await actions.listManagerNotices();
    ok("it is on the list of customers to introduce", listed.ok && listed.data.some((r) => r.companyId === company.id && r.hasEmail));

    console.log("\n— 4. Email —\n");
    const intro = (await server.listQuickTemplates({ moment: "MANAGER_CHANGED", activeOnly: true })).find((t) => t.moment === "MANAGER_CHANGED")!;
    const opened = await actions.openQuickMessage({ moment: "MANAGER_CHANGED", companyId: company.id });
    ok("the dialog opens with the customer's contacts, the one who left not among them", opened.ok && opened.data.context.contacts.some((c) => c.id === rajesh.id) && !opened.data.context.contacts.some((c) => c.id === gone.id));
    ok("  it is from the new account manager, though an admin is sending", opened.ok && opened.data.context.sender.id === fresh.id && opened.data.context.values.newManagerName === "Zz New Manager" && opened.data.context.values.oldManagerName === "Zz Old Manager");
    const sent = await actions.sendQuickMessageEmail({ moment: "MANAGER_CHANGED", companyId: company.id, templateId: intro.id, contactIds: [rajesh.id, meera.id, gone.id, noMail.id], subject: intro.emailSubject!, body: intro.emailBody! });
    ok("the introduction goes to the two who can be emailed", sent.ok && sent.data.sent === 2, sent);
    ok("  from the new manager's mailbox, the previous one copied", mails.length === 2 && mails.every((m) => m.userId === fresh.id && m.cc?.[0]?.email === old.email));
    ok("  each with their own first name, and the new manager's", mails[0]!.html.includes("Hi Rajesh") && mails[1]!.html.includes("Hi Meera") && mails.every((m) => m.html.includes("Zz New Manager")));
    ok("  kept on each contact's mail log", (await db.marketingMessage.count({ where: { companyId: company.id, channel: "EMAIL", status: "SENT", sentByUserId: fresh.id } })) === 2);
    ok("  and the customer counts as told", (await notices.pendingNotice(company.id)) === null && (await db.accountManagerNotice.findUnique({ where: { companyId: company.id } }))?.toldById === admin.id);
    const twice = await actions.sendQuickMessageEmail({ moment: "MANAGER_CHANGED", companyId: company.id, templateId: intro.id, contactIds: [rajesh.id], subject: "x", body: "y" });
    ok("told once: there is no change left to introduce", !twice.ok);

    mails.length = 0;
    actorId = old.id;
    const call = (await server.listQuickTemplates({ moment: "AFTER_CALL", outcome: "CONNECTED", activeOnly: true })).find((t) => t.callResult === "CONNECTED")!;
    const followUp = await actions.sendQuickMessageEmail({ moment: "AFTER_CALL", companyId: company.id, contactId: rajesh.id, outcome: "CONNECTED", templateId: call.id, contactIds: [rajesh.id], subject: call.emailSubject!, body: `${call.emailBody!}\nP.S. typed by hand` });
    ok("after a call: from whoever made it, as they changed it, nobody copied", followUp.ok && mails.length === 1 && mails[0]!.userId === old.id && mails[0]!.html.includes("typed by hand") && !mails[0]!.cc?.length, followUp);
    const stuck = await actions.sendQuickMessageEmail({ moment: "AFTER_CALL", companyId: company.id, contactIds: [rajesh.id], subject: "Hi {{nickname}}", body: "Hello" });
    ok("a field that isn't one stops it, and nothing goes", !stuck.ok && mails.length === 1);
    // Cc (owner, 16 Nov 2026: "add cc").
    const badCc = await actions.sendQuickMessageEmail({ moment: "AFTER_CALL", companyId: company.id, contactId: rajesh.id, outcome: "CONNECTED", templateId: call.id, contactIds: [rajesh.id], subject: call.emailSubject!, body: call.emailBody!, cc: "ops@zz-qm.in, not-an-address" });
    ok("a Cc that isn't an address stops it, and nothing goes", !badCc.ok && mails.length === 1, badCc.ok ? "ACCEPTED" : badCc.error);
    const withCc = await actions.sendQuickMessageEmail({ moment: "AFTER_CALL", companyId: company.id, contactId: rajesh.id, outcome: "CONNECTED", templateId: call.id, contactIds: [rajesh.id], subject: call.emailSubject!, body: call.emailBody!, cc: "Ops@ZZ-qm.in; ops@zz-qm.in" });
    ok("the person's Cc goes on the Cc line, once", withCc.ok && mails.length === 2 && mails[1]!.cc?.map((x) => x.email).join() === "ops@zz-qm.in", mails[1]?.cc);

    console.log("\n— 5. WhatsApp —\n");
    const channel = await db.inboxChannel.create({ data: { kind: "WHATSAPP", name: `${TAG} number`, phoneNumberId: `zzqm-${Date.now()}`, displayPhone: "+91 11 4000 0000", ownerUserId: old.id }, select: { id: true } });
    const plain = await server.saveQuickTemplate(old.id, { name: `${TAG} not approved`, moment: "AFTER_CALL", callResult: "ANY", whatsappBody: "Hi {{firstName|there}}, {{myName}} here." });
    const approved = await server.saveQuickTemplate(old.id, { name: `${TAG} approved`, moment: "AFTER_CALL", callResult: "ANY", whatsappBody: "Hi {{firstName|there}}, {{myName}} from {{ourName}}.", whatsappTemplateName: "zz_follow_up" });
    if (!plain.ok || !approved.ok) throw new Error("templates didn't save");
    const refused = await actions.sendQuickMessageWhatsApp({ moment: "AFTER_CALL", companyId: company.id, contactId: rajesh.id, templateId: plain.id });
    ok("outside 24 hours, with nothing approved at Meta: refused, saying why", !refused.ok && /approved/.test(refused.ok ? "" : refused.error) && chats.length === 0, refused.ok ? "sent" : refused.error);
    const viaTemplate = await actions.sendQuickMessageWhatsApp({ moment: "AFTER_CALL", companyId: company.id, contactId: rajesh.id, templateId: approved.id, body: "something else entirely" });
    const t = chats[0] as Extract<Sent, { template: unknown }> | undefined;
    ok("with an approved template: that template, its values in order — an edit ignored", viaTemplate.ok && !!t && "template" in t && t.template.name === "zz_follow_up" && t.template.variables[0] === "Rajesh" && t.template.variables[1] === "Zz Old Manager" && t.template.variables.length === 3, t);
    ok("  from the sender's own number, to the contact's", !!t && t.to.replace(/\D/g, "").endsWith("9820000011"));
    // The customer writes in: 24 hours of free text.
    await db.conversation.create({ data: { channelId: channel.id, kind: "WHATSAPP", waId: "919820000011", lastCustomerAt: new Date() } });
    const free = await actions.sendQuickMessageWhatsApp({ moment: "AFTER_CALL", companyId: company.id, contactId: rajesh.id, templateId: plain.id, body: "Hi {{firstName}}, as typed just now" });
    const f = chats[1] as Extract<Sent, { text: string }> | undefined;
    ok("within 24 hours of their message: the words as typed, no approval needed", free.ok && !!f && "text" in f && f.text === "Hi Rajesh, as typed just now", f);
    ok("  and it shows in their conversation", (await db.conversationMessage.count({ where: { conversation: { channelId: channel.id }, author: "AGENT" } })) >= 1);
    ok("each WhatsApp is on the mail log too", (await db.marketingMessage.count({ where: { companyId: company.id, channel: "WHATSAPP", status: "SENT" } })) === 2);
    // A number that isn't a contact goes only as the number this person just called (security audit SEC-49).
    const bare = await actions.sendQuickMessageWhatsApp({ moment: "AFTER_CALL", companyId: company.id, phone: "+91 98200 00099", templateId: approved.id });
    ok("a number typed with no call behind it — refused", !bare.ok && /number you just called/.test(bare.ok ? "" : bare.error) && chats.length === 2, bare);
    const coldCall = await db.callLog.create({ data: { companyId: company.id, phoneNumber: "+919820000099", outcome: "CONNECTED", startedAt: new Date(), userId: actorId }, select: { id: true } });
    const loose = await actions.sendQuickMessageWhatsApp({ moment: "AFTER_CALL", companyId: company.id, phone: "+91 98200 00099", templateId: approved.id, callId: coldCall.id });
    const l = chats[2] as Extract<Sent, { template: unknown }> | undefined;
    ok("a number with nobody behind it — a cold call — gets \"there\"", loose.ok && !!l && "template" in l && l.template.variables[0] === "there");

    console.log("\n— 7. A template's PDF —\n");
    actorId = old.id;
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(2048, 0x20), Buffer.from("\n%%EOF")]);
    const profile = await server.saveQuickTemplate(old.id, { name: `${TAG} profile`, moment: "AFTER_CALL", callResult: "ANY", emailSubject: "Our profile", emailBody: "Hi {{firstName|there}}, attached.", whatsappBody: "Hi {{firstName|there}}, our profile.", whatsappTemplateName: "zz_profile" });
    if (!profile.ok) throw new Error("profile template didn't save");
    ok("something that isn't a PDF is refused, whatever it is called", !(await server.attachTemplateFile(old.id, profile.id, { bytes: Buffer.from("MZ not a pdf"), name: "profile.pdf" })).ok);
    ok("  and one over 5 MB", !(await server.attachTemplateFile(old.id, profile.id, { bytes: Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(server.ATTACHMENT_LIMIT)]), name: "big.pdf" })).ok);
    const kept = await server.attachTemplateFile(old.id, profile.id, { bytes: pdf, name: "Company Profile 2026.pdf" });
    ok("a PDF is attached, under its name", kept.ok && kept.name === "Company Profile 2026.pdf" && kept.size === pdf.length, kept);
    const shown = (await server.listQuickTemplates()).find((t) => t.id === profile.id);
    ok("  and the template lists it", shown?.attachment?.name === "Company Profile 2026.pdf");
    const mailsBefore = mails.length;
    const withFile = await actions.sendQuickMessageEmail({ moment: "AFTER_CALL", companyId: company.id, templateId: profile.id, contactIds: [rajesh.id], subject: "Our profile", body: "Hi {{firstName}}, attached." });
    const m = mails[mailsBefore];
    ok("the email carries it", withFile.ok && m?.attachments.length === 1 && m.attachments[0]!.name === "Company Profile 2026.pdf" && m.attachments[0]!.contentType === "application/pdf" && m.attachments[0]!.bytes.length === pdf.length);
    await actions.sendQuickMessageEmail({ moment: "AFTER_CALL", companyId: company.id, templateId: profile.id, contactIds: [rajesh.id], subject: "Our profile", body: "Hi {{firstName}}.", attach: false });
    ok("  unticked, it is left off", mails[mailsBefore + 1]?.attachments.length === 0);
    const chatsBefore = chats.length;
    // Rajesh wrote within 24 hours (above): the words, then the document.
    const inWindow = await actions.sendQuickMessageWhatsApp({ moment: "AFTER_CALL", companyId: company.id, contactId: rajesh.id, templateId: profile.id });
    const words = chats[chatsBefore];
    const doc = chats[chatsBefore + 1];
    ok("on WhatsApp inside 24 hours: the words, then the PDF as a document", inWindow.ok && !!words && "text" in words && !!doc && "media" in doc && doc.media.name === "Company Profile 2026.pdf" && doc.media.mime === "application/pdf");
    // No Mail hasn't written in: the approved template, the PDF in its header.
    const outside = await actions.sendQuickMessageWhatsApp({ moment: "AFTER_CALL", companyId: company.id, contactId: noMail.id, templateId: profile.id });
    const header = chats[chatsBefore + 2];
    ok("  outside: the approved template with the PDF in its header", outside.ok && !!header && "template" in header && header.template.name === "zz_profile" && header.template.document?.name === "Company Profile 2026.pdf");
    await server.removeTemplateFile(old.id, profile.id);
    ok("removed, the template has none", (await server.listQuickTemplates()).find((t) => t.id === profile.id)?.attachment === null && (await server.templateFile(profile.id)) === null);

    console.log("\n— 8. From the phone —\n");
    actorId = old.id;
    await db.userPermission.create({ data: { userId: old.id, permission: "calls.view", allowed: true, reason: TAG } });
    const made = await db.callLog.create({ data: { companyId: company.id, contactId: rajesh.id, phoneNumber: "+91 98200 00011", outcome: "NO_ANSWER", startedAt: new Date(), userId: old.id, source: "PHONE" }, select: { id: true } });
    const offered = await phone.followUpFor(made.id).catch((e: Error) => e);
    if (offered instanceof Error) ok("the phone is told what can follow its call", false, offered.message);
    else {
      ok("the phone is told what can follow its call: the person called first", offered.contacts[0]?.id === rajesh.id && offered.email.ready && offered.whatsapp.ready, { email: offered.email, whatsapp: offered.whatsapp });
      ok("  with the templates for a call nobody answered", offered.templates.length > 0 && offered.templates.some((t) => t.name === "Sorry we missed you") && !offered.templates.some((t) => t.name === "Thanks for speaking with us"));
      const missed = offered.templates.find((t) => t.name === "Sorry we missed you")!;
      const mailsWere = mails.length;
      const byPhone = await phone.sendFollowUp(made.id, { channel: "email", template_id: missed.id, contact_ids: [rajesh.id], subject: missed.email_subject, body: missed.email_body });
      ok("an email sent from the phone goes as it does from the web", byPhone.sent === 1 && mails.length === mailsWere + 1 && mails[mailsWere]!.userId === old.id && mails[mailsWere]!.html.includes("Hi Rajesh"));
      const chatsWere = chats.length;
      const waPhone = await phone.sendFollowUp(made.id, { channel: "whatsapp", template_id: plain.id, contact_id: rajesh.id, body: "Hi {{firstName}}, from my phone" });
      const said = chats[chatsWere];
      ok("  and a WhatsApp too", waPhone.sent === 1 && !!said && "text" in said && said.text === "Hi Rajesh, from my phone");
      const bad = await phone.sendFollowUp(made.id, { channel: "email", template_id: missed.id, contact_ids: [], subject: "s", body: "b" }).then(() => "sent", () => "refused");
      ok("  nobody chosen: refused", bad === "refused");
    }
    actorId = fresh.id;
    await db.userPermission.create({ data: { userId: fresh.id, permission: "calls.view", allowed: true, reason: TAG } });
    ok("somebody else's call offers nothing", (await phone.followUpFor(made.id).then(() => "offered", () => "nothing")) === "nothing");

    console.log("\n— 6. Who may —\n");
    actorId = outsider.id;
    const before = mails.length + chats.length;
    ok("without the permission: no dialog", !(await actions.openQuickMessage({ moment: "AFTER_CALL", companyId: company.id })).ok);
    ok("  no email, no WhatsApp", !(await actions.sendQuickMessageEmail({ moment: "AFTER_CALL", companyId: company.id, contactIds: [rajesh.id], subject: "s", body: "b" })).ok && !(await actions.sendQuickMessageWhatsApp({ moment: "AFTER_CALL", companyId: company.id, contactId: rajesh.id, templateId: approved.id })).ok && mails.length + chats.length === before);
    ok("  and nothing from the phone", (await phone.followUpFor("zz-none").then(() => "offered", () => "nothing")) === "nothing");
    ok("  and the templates are an admin's to change", !(await actions.saveMessageTemplate({ name: `${TAG} sneaky`, moment: "ANY", callResult: "ANY", emailSubject: "s", emailBody: "b" })).ok);
  } finally {
    whatsapp.setTestWhatsAppSender(null);
    await cleanup();
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} failed` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}

void main();
