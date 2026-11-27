/**
 * check:audit-fixes-d — the security audit of 11 Nov 2026 (docs/reports/security-audit-2026-11-11.md), group D: public
 * endpoints, the helpdesk and customer inbox, the API and calls. Each fix shown to hold the way it was broken, by
 * calling the server's own code.
 *
 *   SEC-07  a helpdesk email whose sender wasn't proved answers into no ticket and is filed under nobody
 *   SEC-27  forms and raw bodies read with a ceiling a chunked sender can't slip past
 *   SEC-33  a person's certificate found by number shows neither their name nor its page
 *   SEC-34  emailed files, chat files and website activity have daily ceilings
 *   SEC-46  the bot asks the AI within a per-conversation and per-workspace allowance, and answers customers only
 *           from the AI Knowledge files ticked "Website chat may use this"
 *   SEC-47  a website visitor's typed email suggests a customer; it never links one
 *   SEC-49  quick messages have a daily ceiling per person
 *   SEC-51  an API key without contacts:read gets no contact details through companies or leads
 *   SEC-52  any request that sends a recording counts as a play, once per few minutes
 *   SEC-54  a recording is checked by its bytes; a call can't end in the future
 *   SEC-62  custom-field files nothing names are cleaned up after a day
 *
 * Pure rules first, then a fixture of its own in the local database, named ZZD, removed in a finally.
 *
 *   npx tsx scripts/check-audit-fixes-d.ts
 */
import "dotenv/config";
import Module from "node:module";
import { createHash } from "node:crypto";
import { db } from "../src/lib/db";
import { readBytesWithin, readFormWithin } from "../src/lib/http/body";
import { domainOf, FLOOD_PER_DOMAIN_PER_HOUR, ATTACHMENT_BYTES_PER_SENDER_PER_DAY } from "../src/lib/support-mail/rules";
import { soundMatches, recordingType } from "../src/lib/calls/recordings";

const TAG = "ZZD";
const MAIL = "zzd-mail.test";
/** The AI Knowledge files this check makes all start with this. */
const KNOWLEDGE = "zzd-sec46-";
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

const internals = Module as unknown as { _load(req: string, parent: unknown, isMain: boolean): unknown };
const original = internals._load;
let actorId = "";
const acknowledgements: string[] = [];
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
  if (request.endsWith("lib/session") || request === "@/lib/session") {
    const user = async () => ({ id: actorId, name: "Probe", role: "ADMIN" });
    return { requireUser: user, currentUser: user, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  // The helpdesk's acknowledgement: kept here instead of sent.
  if (request === "@/lib/support-mail/send" || request.endsWith("support-mail/send")) {
    return { sendSupportEmail: async (input: { body: string }) => void acknowledgements.push(input.body) };
  }
  return original.call(this, request, parent, isMain);
} as typeof original;

const chunked = (bytes: number, type?: string) =>
  new Request("http://localhost/x", {
    method: "POST",
    headers: type ? { "content-type": type } : {},
    body: new ReadableStream({
      start(c) {
        for (let sent = 0; sent < bytes; sent += 1024) c.enqueue(new Uint8Array(1024));
        c.close();
      },
    }),
    duplex: "half",
  } as RequestInit);

const mail = (from: string, extra: Record<string, unknown> = {}) => ({
  from: { address: from, name: "Mallory <script>" },
  to: [`wroffy@tickets.${MAIL}`],
  cc: [],
  subject: `${TAG} help please`,
  text: `${TAG} body`,
  messageId: `<${Math.random().toString(36).slice(2)}@${MAIL}>`,
  inReplyTo: null as string | null,
  references: [] as string[],
  automated: null,
  attachments: [] as { fileName: string; mimeType: string; sizeBytes: number; dataUrl: string }[],
  // Proved unless a check says otherwise, as mail from the redeployed worker is (SEC-07).
  senderVerified: true,
  senderCheck: "dmarc=pass",
  ...extra,
});

async function cleanup() {
  const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  const tickets = (await db.ticket.findMany({ where: { companyId: { in: companies } }, select: { id: true } })).map((t) => t.id);
  await db.supportEmail.deleteMany({ where: { OR: [{ fromAddress: { endsWith: `@${MAIL}` } }, { fromAddress: { endsWith: "@zzd-flood.test" } }, { ticketId: { in: tickets } }] } });
  await db.auditLog.deleteMany({ where: { OR: [{ entityId: { in: tickets } }, { user: { email: { endsWith: "@zzd.invalid" } } }] } });
  await db.notification.deleteMany({ where: { OR: [{ message: { contains: TAG } }, { title: { contains: TAG } }] } });
  await db.ticket.deleteMany({ where: { id: { in: tickets } } });
  const channels = (await db.inboxChannel.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  await db.conversation.deleteMany({ where: { channelId: { in: channels } } });
  await db.inboxChannel.deleteMany({ where: { id: { in: channels } } });
  const calls = (await db.callLog.findMany({ where: { companyId: { in: companies } }, select: { id: true } })).map((c) => c.id);
  await db.callRecording.deleteMany({ where: { callLogId: { in: calls } } });
  await db.callLog.deleteMany({ where: { id: { in: calls } } });
  await db.verifiableDocument.deleteMany({ where: { number: { startsWith: TAG } } });
  await db.customFieldFile.deleteMany({ where: { fieldKey: "zzd_file" } });
  const knowledge = (await db.aiKnowledgeFile.findMany({ where: { name: { startsWith: KNOWLEDGE, mode: "insensitive" } }, select: { id: true } })).map((f) => f.id);
  await db.auditLog.deleteMany({ where: { entityType: "AiKnowledgeFile", entityId: { in: knowledge } } });
  await db.aiKnowledgeFile.deleteMany({ where: { id: { in: knowledge } } });
  await db.contact.deleteMany({ where: { companyId: { in: companies } } });
  await db.company.deleteMany({ where: { id: { in: companies } } });
  await db.user.deleteMany({ where: { email: { endsWith: "@zzd.invalid" } } });
}

async function main() {
  // SEC-07's verdict itself — Cloudflare's results read and matched to the From domain — is check:support-sender's.
  ok("domainOf", domainOf("A@Acme.COM") === "acme.com" && domainOf("nobody") === "");

  section("SEC-27: bodies read with a ceiling");
  ok("bytes past the ceiling, chunked, are refused", (await readBytesWithin(chunked(64 * 1024), 16 * 1024)) === null);
  ok("  bytes within it are read whole", (await readBytesWithin(chunked(8 * 1024), 16 * 1024))?.length === 8 * 1024);
  const form = new FormData();
  form.set("token", "abc");
  form.set("file", new File([new Uint8Array(2048)], "a.pdf", { type: "application/pdf" }));
  const posted = new Request("http://localhost/x", { method: "POST", body: form });
  const read = await readFormWithin(posted, 64 * 1024);
  ok("a form within its ceiling is parsed as one", read?.get("token") === "abc" && read.get("file") instanceof File && (read.get("file") as File).size === 2048);
  ok("  one past it, chunked, isn't read at all", (await readFormWithin(chunked(64 * 1024, "multipart/form-data; boundary=zzd"), 16 * 1024)) === null);

  section("SEC-54: a recording is what its bytes say");
  const m4a = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A ")]);
  ok("an m4a with its ftyp box passes", soundMatches("m4a", m4a));
  ok("  a PDF named .m4a doesn't", !soundMatches("m4a", Buffer.from("%PDF-1.7 ...")));
  ok("  WAV, Ogg, AMR, MP3 by their own marks", soundMatches("wav", Buffer.from("RIFF\0\0\0\0WAVEfmt ")) && soundMatches("ogg", Buffer.from("OggS\0")) && soundMatches("amr", Buffer.from("#!AMR\n")) && soundMatches("mp3", Buffer.from("ID3\x04")));
  ok("  a script named .mp3 doesn't", !soundMatches("mp3", Buffer.from("#!/bin/sh")) && recordingType("x.mp3")?.ext === "mp3");

  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!admin) throw new Error("no super admin to act as");
  actorId = admin.id;

  await cleanup();
  try {
    const company = await db.company.create({ data: { name: `${TAG} Buyer Co`, normalizedName: `${TAG.toLowerCase()} buyer co`, createdById: admin.id }, select: { id: true } });
    const contact = await db.contact.create({ data: { companyId: company.id, name: "ZZD Buyer", email: `buyer@${MAIL}`, phone: "+91 98100 77001" }, select: { id: true } });

    section("SEC-07: unproved senders are strangers");
    const { receiveEmail, attachmentsWithinBudget } = await import("../src/lib/support-mail/receive");
    const ticket = await db.ticket.create({ data: { companyId: company.id, contactId: contact.id, title: `${TAG} printer`, createdByUserId: admin.id, status: "RESOLVED" }, select: { id: true, ticketSeq: true } });
    await db.supportEmail.create({ data: { direction: "INBOUND", state: "NEW_TICKET", ticketId: ticket.id, fromAddress: `buyer@${MAIL}`, subject: `${TAG} printer`, body: "x", messageId: `<zzd-first@${MAIL}>`, toAddresses: [], ccAddresses: [], references: [] } });
    const forged = await receiveEmail(mail(`buyer@${MAIL}`, { inReplyTo: `<zzd-first@${MAIL}>`, senderVerified: false, senderCheck: "no pass for the From domain" }));
    const still = await db.ticket.findUnique({ where: { id: ticket.id }, select: { status: true } });
    ok("a forged reply waits in the inbox and doesn't reopen the ticket", forged.state === "INBOX" && still?.status === "RESOLVED", { forged, still });
    const real = await receiveEmail(mail(`buyer@${MAIL}`, { inReplyTo: `<zzd-first@${MAIL}>`, senderVerified: true, senderCheck: "DMARC pass" }));
    const reopened = await db.ticket.findUnique({ where: { id: ticket.id }, select: { status: true } });
    ok("  the same reply, proved: added, and the ticket opens again", real.state === "REPLY" && reopened?.status === "OPEN", { real, reopened });
    const forgedNew = await receiveEmail(mail(`buyer@${MAIL}`, { senderVerified: false, senderCheck: "no pass for the From domain" }));
    ok("an unproved new email from a customer's address opens no ticket on them", forgedNew.state === "INBOX" && !forgedNew.ticketSeq, forgedNew);
    acknowledgements.length = 0;
    const legacy = await receiveEmail(mail(`buyer@${MAIL}`, { subject: `${TAG} new question`, senderVerified: true, senderCheck: "DMARC pass" }));
    ok("  a proved new email opens a ticket", legacy.state === "NEW_TICKET", legacy);
    ok("  and its acknowledgement carries no display name", acknowledgements.length === 1 && acknowledgements[0]!.startsWith("Hello,\n") && !acknowledgements[0]!.includes("Mallory"), acknowledgements);
    await db.supportEmail.createMany({
      data: Array.from({ length: FLOOD_PER_DOMAIN_PER_HOUR }, (_, i) => ({ direction: "INBOUND" as const, state: "IGNORED" as const, fromAddress: `x${i}@zzd-flood.test`, subject: TAG, body: "", toAddresses: [], ccAddresses: [], references: [] })),
    });
    const flooded = await receiveEmail(mail("fresh@zzd-flood.test", { senderVerified: true, senderCheck: "DMARC pass" }));
    ok("a new address on a flooding domain is left out", flooded.state === "IGNORED" && /zzd-flood\.test/.test(flooded.note ?? ""), flooded);

    section("SEC-34: daily ceilings on what outsiders store");
    const big = [{ sizeBytes: ATTACHMENT_BYTES_PER_SENDER_PER_DAY + 1 }];
    ok("an emailed file past the sender's day isn't kept", (await attachmentsWithinBudget(big, `buyer@${MAIL}`)).length === 0);
    ok("  a small one is", (await attachmentsWithinBudget([{ sizeBytes: 1000 }], `buyer@${MAIL}`)).length === 1);
    const { visitorFileBudgetRefusal, VISITOR_FILE_BUDGET } = await import("../src/lib/inbox/server");
    ok("a chat file past the conversation's day is refused", !!(await visitorFileBudgetRefusal("zzd-none", VISITOR_FILE_BUDGET.perConversationPerDay + 1)));
    ok("  a small one isn't", (await visitorFileBudgetRefusal("zzd-none", 1000)) === null);
    const channel = await db.inboxChannel.create({ data: { kind: "WEB", name: `${TAG} site`, publicKey: `zzd-${Date.now()}` }, select: { id: true } });
    const { recordView, ACTIVITY_LIMITS } = await import("../src/lib/inbox/activity");
    const vid = "zzd-visitor-000000000001";
    const visitor = await db.webVisitor.create({ data: { channelId: channel.id, tokenHash: createHash("sha256").update(vid).digest("hex"), firstSeenAt: new Date(), lastSeenAt: new Date() }, select: { id: true } });
    await db.webPageView.createMany({ data: Array.from({ length: ACTIVITY_LIMITS.viewsPerVisitorPerDay }, () => ({ visitorId: visitor.id, host: "zzd.test", path: "/", at: new Date() })) });
    const view = { visitorId: vid, page: "https://zzd.test/pricing", title: "Pricing", referrer: null, fromEmail: null, screen: null, touchPoints: null, connection: null, language: null, timezone: null, ip: null, headers: new Headers({ "user-agent": "Mozilla/5.0" }) };
    ok("a visitor past their day's pages adds no more rows", (await recordView(channel.id, view, [])) === false && (await db.webPageView.count({ where: { visitorId: visitor.id } })) === ACTIVITY_LIMITS.viewsPerVisitorPerDay);

    section("SEC-47: typed details suggest; they never link");
    const { linkCustomer, undecided, botMayUseAi, resetBotAiDays, BOT_AI_LIMITS } = await import("../src/lib/inbox/server");
    const web = await db.conversation.create({ data: { channelId: channel.id, kind: "WEB", customerName: "Someone", customerEmail: `buyer@${MAIL}` }, select: { id: true } });
    await linkCustomer(web.id);
    const webAfter = await db.conversation.findUnique({ where: { id: web.id }, select: { contactId: true } });
    const could = await undecided(web.id);
    ok("a website visitor typing a customer's email isn't linked to them", webAfter?.contactId === null, webAfter);
    ok("  the customer shows to the team as 'could be', to confirm", could.length === 1 && could[0]!.contactId === contact.id, could);
    const wa = await db.inboxChannel.create({ data: { kind: "WHATSAPP", name: `${TAG} wa`, phoneNumberId: `zzd-${Date.now()}` }, select: { id: true } });
    const whatsapp = await db.conversation.create({ data: { channelId: wa.id, kind: "WHATSAPP", waId: "919810077001", customerPhone: "+919810077001" }, select: { id: true } });
    await linkCustomer(whatsapp.id);
    ok("  WhatsApp's own number still links", (await db.conversation.findUnique({ where: { id: whatsapp.id }, select: { contactId: true } }))?.contactId === contact.id);

    section("SEC-46: the bot's AI allowance");
    resetBotAiDays();
    let allowed = 0;
    for (let i = 0; i < BOT_AI_LIMITS.perWorkspacePerDay + 5; i++) if (await botMayUseAi(web.id)) allowed += 1;
    ok("a workspace's AI answers stop at the day's allowance", allowed === BOT_AI_LIMITS.perWorkspacePerDay, allowed);
    resetBotAiDays();
    await db.conversationMessage.createMany({ data: Array.from({ length: BOT_AI_LIMITS.perConversation }, () => ({ conversationId: web.id, author: "BOT" as const, body: TAG })) });
    ok("  one conversation's stop at its own", (await botMayUseAi(web.id)) === false);
    resetBotAiDays();

    section("SEC-33: a person's certificate by number");
    const settings = { searchOn: true, nameSearch: false };
    const { searchVerifiable } = await import("../src/lib/verifiable/search");
    const { numberKeyOf } = await import("../src/lib/verifiable/rules");
    for (const [n, person] of [["ZZD-P-0001", true], ["ZZD-C-0001", false]] as const) {
      await db.verifiableDocument.create({ data: { token: `zzd-${n}-${Date.now()}`, docType: "CERTIFICATE", number: n, numberKey: numberKeyOf(n) ?? "", title: "Training", holderName: person ? "Asha Verma" : `${TAG} Buyer Co`, holderIsPerson: person, issuedOn: new Date("2026-01-01"), createdById: admin.id } });
    }
    const [p] = await searchVerifiable("ZZD-P-0001", settings, new Date());
    const [c] = await searchVerifiable("zzd c 0001", settings, new Date());
    ok("a person's certificate: real, but no name and no page", !!p && p.holderName === null && p.token === null && p.standing === "VALID", p);
    ok("  a company's: named, with its page", !!c && c.holderName === `${TAG} Buyer Co` && !!c.token, c);

    section("SEC-49: quick messages a day");
    const { quickDailyRefusal, QUICK_MESSAGES_PER_DAY } = await import("../src/lib/quick-messages/server");
    const rep = await db.user.create({ data: { name: "ZZD Rep", email: "rep@zzd.invalid", passwordHash: "!", role: "SALES" }, select: { id: true } });
    ok("nobody near the ceiling is held", (await quickDailyRefusal(rep.id)) === null);
    await db.auditLog.createMany({ data: Array.from({ length: QUICK_MESSAGES_PER_DAY }, () => ({ userId: rep.id, action: "CREATE" as const, entityType: "QuickMessage", entityId: company.id, entityLabel: TAG })) });
    ok("  the day's ceiling reached, the next is refused", /messages from you in the last day/.test((await quickDailyRefusal(rep.id)) ?? ""));

    section("SEC-46: the bot answers customers only from files marked for them");
    const { saveKnowledgeTexts, listKnowledgeFiles, countKnowledgeForCustomers } = await import("../src/lib/ai-knowledge/store");
    const { searchKnowledge } = await import("../src/lib/ai-knowledge/search");
    const { setAiKnowledgeForCustomers } = await import("../src/actions/ai-knowledge");
    const fileName = `${KNOWLEDGE}internal.md`;
    const finds = async (word: string, forCustomers: boolean) => (await searchKnowledge(word, 5, forCustomers ? { forCustomers: true } : {})).some((h) => h.file === fileName);
    const markedBefore = await countKnowledgeForCustomers();
    await saveKnowledgeTexts(admin.id, [{ name: fileName, content: ["# Margins", "", "Our zzdquorvex margin is forty percent."].join("\n") }]);
    const mine = async () => (await listKnowledgeFiles())?.find((f) => f.name === fileName);
    const uploaded = await mine();
    ok("a new file starts not marked for the website chat", uploaded?.forCustomers === false, uploaded);
    ok("  the team's search finds it", await finds("zzdquorvex", false));
    ok("  the search for customers doesn't", !(await finds("zzdquorvex", true)));
    actorId = rep.id;
    const refusedTick = await setAiKnowledgeForCustomers({ id: uploaded!.id, on: true });
    actorId = admin.id;
    ok("somebody who can't change settings can't mark it", !refusedTick.ok && (await mine())?.forCustomers === false && !(await finds("zzdquorvex", true)), refusedTick);
    const ticked = await setAiKnowledgeForCustomers({ id: uploaded!.id, on: true });
    ok("marked by an admin, it is found by both searches", ticked.ok && (await mine())?.forCustomers === true && (await finds("zzdquorvex", true)) && (await finds("zzdquorvex", false)), ticked);
    ok("  the count for the inbox's settings goes up by one", markedBefore !== null && (await countKnowledgeForCustomers()) === markedBefore + 1);
    ok("  and it's in the audit trail", (await db.auditLog.count({ where: { entityType: "AiKnowledgeFile", entityId: uploaded!.id, userId: admin.id, action: "UPDATE" } })) === 1);
    const again = await saveKnowledgeTexts(admin.id, [{ name: fileName.toUpperCase().replace(/\.MD$/, ".md"), content: ["# Margins", "", "Our zzdplimbast margin is fifty percent."].join("\n") }]);
    ok("a file replaced by an upload keeps its mark", again.replaced.length === 1 && (await mine())?.forCustomers === true && (await finds("zzdplimbast", true)) && !(await finds("zzdquorvex", false)), again);
    const cleared = await setAiKnowledgeForCustomers({ id: uploaded!.id, on: false });
    ok("the mark taken off, customers aren't answered from it again", cleared.ok && (await mine())?.forCustomers === false && !(await finds("zzdplimbast", true)) && (await finds("zzdplimbast", false)), cleared);
    ok("  a file that isn't there is said so", (await setAiKnowledgeForCustomers({ id: "zzd-none", on: true })).ok === false);

    section("SEC-51: contacts need contacts:read");
    const { mayReadContacts } = await import("../src/lib/api/v1/companies");
    const { leadsOut } = await import("../src/lib/api/v1/leads");
    ok("companies:read alone doesn't read contacts", !mayReadContacts(["companies:read", "leads:read"]) && mayReadContacts(["contacts:read"]));
    const row = { id: "zzd-none", leadSeq: 1, title: "x", status: "NEW", contact: { id: contact.id, name: "ZZD Buyer", email: `buyer@${MAIL}`, phone: "+91 98100 77001" } };
    const [without] = await leadsOut(admin.id, [row], { contactDetails: false });
    const [withDetails] = await leadsOut(admin.id, [row]);
    ok("a lead's contact without contacts:read: name, no email or phone", !!without?.contact && !("email" in without.contact) && without.contact.name === "ZZD Buyer", without?.contact);
    ok("  with it, as before", (withDetails?.contact as { email?: string } | null)?.email === `buyer@${MAIL}`);

    section("SEC-52: every play that sends sound is written down");
    const call = await db.callLog.create({ data: { companyId: company.id, contactId: contact.id, phoneNumber: "+919810077001", outcome: "CONNECTED", startedAt: new Date(), userId: admin.id, source: "PHONE" }, select: { id: true } });
    const recording = await db.callRecording.create({ data: { callLogId: call.id, storageKey: "zzd/none.m4a", contentType: "audio/mp4", sizeBytes: 10 }, select: { id: true } });
    const { notePlay, PLAY_COVERS_MS } = await import("../src/lib/calls/recordings");
    const first = await notePlay(recording.id, admin.id);
    const seek = await notePlay(recording.id, admin.id);
    const later = await notePlay(recording.id, admin.id, new Date(Date.now() + PLAY_COVERS_MS + 1000));
    ok("a play is counted once, its seeks not, and a play later again", first && !seek && later && (await db.callRecordingPlay.count({ where: { recordingId: recording.id } })) === 2);

    section("SEC-62: custom-field files nothing names");
    const { sweepUnclaimedFieldFiles } = await import("../src/lib/custom-fields/secure");
    const old = new Date(Date.now() - 2 * 86_400_000);
    const orphan = await db.customFieldFile.create({ data: { entity: "COMPANY", fieldKey: "zzd_file", name: "a.pdf", contentType: "application/pdf", size: 5, data: new Uint8Array(Buffer.from("%PDF-")), createdAt: old }, select: { id: true } });
    const named = await db.customFieldFile.create({ data: { entity: "COMPANY", fieldKey: "zzd_file", name: "b.pdf", contentType: "application/pdf", size: 5, data: new Uint8Array(Buffer.from("%PDF-")), createdAt: old }, select: { id: true } });
    const fresh = await db.customFieldFile.create({ data: { entity: "COMPANY", fieldKey: "zzd_file", name: "c.pdf", contentType: "application/pdf", size: 5, data: new Uint8Array(Buffer.from("%PDF-")) }, select: { id: true } });
    await db.company.update({ where: { id: company.id }, data: { customFields: { zzd_file: `f1|${named.id}|b.pdf` } } });
    const swept = await sweepUnclaimedFieldFiles(new Date(), { ids: [orphan.id, named.id, fresh.id] });
    const left = new Set((await db.customFieldFile.findMany({ where: { id: { in: [orphan.id, named.id, fresh.id] } }, select: { id: true } })).map((f) => f.id));
    ok("a day-old file nothing names is deleted; one a record names, or one just uploaded, isn't", swept === 1 && !left.has(orphan.id) && left.has(named.id) && left.has(fresh.id), { swept, left: [...left] });
  } finally {
    await cleanup();
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  await db.$disconnect();
  if (failures) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
