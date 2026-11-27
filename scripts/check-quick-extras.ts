/**
 * check:quick-extras — the quick-message email's own attachments and Marketing's designed emails (owner, 16 Nov 2026:
 * "template selection? no attachment option?" — "both"; src/lib/quick-messages/extras.ts).
 *
 *   1. Own files: the allowed kinds only, each what its name says, 5 files and 3 MB at most; a path in a name dropped.
 *   2. Sent with the email, beside nothing else — through the person's mailbox.
 *   3. Marketing's emails: offered in the window for whoever has Marketing; sent filled in for each person, with the
 *      unsubscribe link and the subject as typed; refused without Marketing, as a new manager's introduction, and as a
 *      renewal email to a company with no live subscription.
 *
 * Nothing leaves the machine: the mailbox is stubbed. People on @zzprobe-qx.invalid and a customer, removed in a finally.
 *
 *   npm run check:quick-extras
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";
import { checkedOwnFiles } from "../src/lib/quick-messages/extras";

type Mail = { userId: string; subject: string; html: string; to: { name: string; email: string }[]; attachments: { name: string; contentType: string; bytes: Buffer }[] };
const mails: Mail[] = [];
let actorId = "";
let marketingOn = true;
const MAIL = "@zzprobe-qx.invalid";
const TAG = "ZZPROBE_QX";

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "SALES", name: "Zzprobe", email: `actor${MAIL}` });
    return { requireUser: async () => user(), currentUser: async () => user(), viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/actions/module" || request.endsWith("actions/module")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, isModuleEnabled: async (key: string) => (key === "marketing" ? marketingOn : true) };
  }
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
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const companies = await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const cids = companies.map((c) => c.id);
  await db.marketingMessage.deleteMany({ where: { companyId: { in: cids } } });
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.activity.deleteMany({ where: { companyId: { in: cids } } }).catch(() => {});
  await db.contact.deleteMany({ where: { companyId: { in: cids } } });
  await db.company.deleteMany({ where: { id: { in: cids } } });
  await db.marketingTemplate.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
}

async function main() {
  section("1. The sender's own files");
  const one = checkedOwnFiles([{ name: "C:\\Users\\me\\Quote 42.pdf", bytes: PDF }]);
  ok("a PDF is attached, by its own name without the path", one.ok && one.files[0].name === "Quote 42.pdf" && one.files[0].mime === "application/pdf", one);
  ok("only PDFs (owner: \"only pdf\") — a picture is refused", !checkedOwnFiles([{ name: "site.png", bytes: PNG }]).ok);
  ok("  and a Word file", !checkedOwnFiles([{ name: "quote.docx", bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]) }]).ok);
  ok("  and a program", !checkedOwnFiles([{ name: "invoice.exe", bytes: Buffer.from("MZ") }]).ok);
  ok("  and a file named .pdf that isn't one", !checkedOwnFiles([{ name: "quote.pdf", bytes: PNG }]).ok);
  ok("  and an empty file", !checkedOwnFiles([{ name: "empty.pdf", bytes: Buffer.alloc(0) }]).ok);
  ok("more than 3 MB together is refused", !checkedOwnFiles([{ name: "a.pdf", bytes: Buffer.concat([PDF, Buffer.alloc(2 * 1024 * 1024)]) }, { name: "b.pdf", bytes: Buffer.concat([PDF, Buffer.alloc(1.5 * 1024 * 1024)]) }]).ok);
  ok("  and so are six files", !checkedOwnFiles(Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.pdf`, bytes: PDF }))).ok);

  await cleanup();
  try {
    const me = await db.user.create({ data: { name: "Zzprobe Seller", email: `seller${MAIL}`, role: "SALES", passwordHash: "!" }, select: { id: true } });
    actorId = me.id;
    const company = await db.company.create({ data: { name: `${TAG} Customer`, normalizedName: `${TAG} customer`.toLowerCase(), createdById: me.id, ownerUserId: me.id, relationshipType: "CLIENT", stage: "CUSTOMER" }, select: { id: true } });
    const ravi = await db.contact.create({ data: { companyId: company.id, name: "Ravi Kumar", email: `ravi${MAIL}`, isPrimary: true }, select: { id: true } });
    const quick = await import("../src/actions/quick-messages");
    const ask = { moment: "AFTER_CALL", companyId: company.id };

    section("2. Sent with the email");
    const opened = await quick.openQuickMessage(ask);
    const tpl = opened.ok ? opened.data.templates.find((t) => t.emailBody) : null;
    ok("the window opens with message templates", !!tpl, opened.ok ? "" : opened.error);
    const form = new FormData();
    form.set("payload", JSON.stringify({ ...ask, templateId: tpl?.id, contactIds: [ravi.id], subject: "Your quote", body: "Hi {{firstName|there}}, the quote is attached.", cc: "" }));
    form.append("file", new File([PDF], "Quote 42.pdf", { type: "application/pdf" }));
    mails.length = 0;
    const sent = await quick.sendQuickMessageEmailWithFiles(form);
    ok("an email with a file of one's own goes", sent.ok && sent.data.sent === 1, sent);
    ok("  carrying the file, as a PDF, by its name", mails[0]?.attachments.length === 1 && mails[0].attachments[0].name === "Quote 42.pdf" && mails[0].attachments[0].contentType === "application/pdf" && mails[0].attachments[0].bytes.equals(PDF), mails[0]?.attachments.map((a) => a.name));
    const bad = new FormData();
    bad.set("payload", JSON.stringify({ ...ask, templateId: tpl?.id, contactIds: [ravi.id], subject: "x", body: "y" }));
    bad.append("file", new File([Buffer.from("MZ")], "run-me.exe"));
    mails.length = 0;
    const refusedFile = await quick.sendQuickMessageEmailWithFiles(bad);
    ok("  a file that can't be attached stops the send, and nothing goes", !refusedFile.ok && mails.length === 0, refusedFile);

    section("3. Marketing's designed emails");
    const designed = await db.marketingTemplate.create({ data: { name: `${TAG} brochure`, channel: "EMAIL", topic: "OFFERS", subject: "A note for {{companyName}}", body: "Hi {{firstName}}, here is what {{ourName}} does.", format: "TEXT", createdById: me.id }, select: { id: true } });
    const renewal = await db.marketingTemplate.create({ data: { name: `${TAG} renewal`, channel: "EMAIL", topic: "RENEWALS", subject: "Renew {{productName}}", body: "{{productName}} ends on {{expiryDate}}.", format: "TEXT", createdById: me.id }, select: { id: true } });
    const offered = await quick.openQuickMessage(ask);
    ok("the window offers Marketing's emails, each with a preview", offered.ok && offered.data.marketing.some((m) => m.id === designed.id && m.html.includes("here is what")), offered.ok ? offered.data.marketing.map((m) => m.name) : offered.error);
    mails.length = 0;
    const viaDesigned = await quick.sendQuickMessageEmail({ ...ask, marketingTemplateId: designed.id, contactIds: [ravi.id], subject: "", body: "", cc: "" });
    ok("a designed email goes, filled in for the person", viaDesigned.ok && viaDesigned.data.sent === 1 && /Hi Ravi, here is what/.test(mails[0]?.html ?? ""), viaDesigned);
    ok("  with the template's subject, for this company", mails[0]?.subject === `A note for ${TAG} Customer`, mails[0]?.subject);
    ok("  and an unsubscribe link of its own", /\/preferences\/[A-Za-z0-9_-]{20,}/.test(mails[0]?.html ?? ""));
    const row = await db.marketingMessage.findFirst({ where: { companyId: company.id, contactId: ravi.id }, orderBy: { createdAt: "desc" }, select: { subject: true, sentByUserId: true } });
    ok("  logged as sent by this person", row?.sentByUserId === me.id && row.subject === `A note for ${TAG} Customer`, row);
    mails.length = 0;
    const typedSubject = await quick.sendQuickMessageEmail({ ...ask, marketingTemplateId: designed.id, contactIds: [ravi.id], subject: "For {{firstName}} — as promised", body: "", cc: "" });
    ok("a subject typed over the template's is used, filled in", typedSubject.ok && mails[0]?.subject === "For Ravi — as promised", mails[0]?.subject);
    const form2 = new FormData();
    form2.set("payload", JSON.stringify({ ...ask, marketingTemplateId: designed.id, contactIds: [ravi.id], subject: "", body: "" }));
    form2.append("file", new File([PDF], "Brochure.pdf", { type: "application/pdf" }));
    mails.length = 0;
    const designedWithFile = await quick.sendQuickMessageEmailWithFiles(form2);
    ok("  and a file goes with a designed email too", designedWithFile.ok && mails[0]?.attachments[0]?.name === "Brochure.pdf", designedWithFile);

    mails.length = 0;
    const noSub = await quick.sendQuickMessageEmail({ ...ask, marketingTemplateId: renewal.id, contactIds: [ravi.id], subject: "", body: "" });
    ok("a renewal email to a company with no live subscription is refused, and nothing goes", !noSub.ok && /no live subscription/.test(noSub.error) && mails.length === 0, noSub);
    const asIntro = await quick.sendQuickMessageEmail({ moment: "MANAGER_CHANGED", companyId: company.id, marketingTemplateId: designed.id, contactIds: [ravi.id], subject: "", body: "" });
    ok("not as a new account manager's introduction", !asIntro.ok, asIntro);
    marketingOn = false;
    const closed = await quick.openQuickMessage(ask);
    ok("without Marketing, none is offered", closed.ok && closed.data.marketing.length === 0);
    const sneaked = await quick.sendQuickMessageEmail({ ...ask, marketingTemplateId: designed.id, contactIds: [ravi.id], subject: "", body: "" });
    ok("  nor sent", !sneaked.ok, sneaked);
    marketingOn = true;
    await db.marketingTemplate.update({ where: { id: designed.id }, data: { active: false } });
    const retired = await quick.sendQuickMessageEmail({ ...ask, marketingTemplateId: designed.id, contactIds: [ravi.id], subject: "", body: "" });
    ok("a designed email taken out of use isn't sent", !retired.ok, retired);
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
  process.exit(1);
});
