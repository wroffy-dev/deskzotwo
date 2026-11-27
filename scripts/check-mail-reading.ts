/**
 * check:mail-reading — the AI teammates reading connected mailboxes (owner, 23 Nov 2026: "lets give agent access to read
 * mails ! this will be admin based if he wants to give access or not"; src/lib/mail-reading).
 *
 *   · Off until an admin turns it on, and then only the mailboxes and agents ticked; the provider's permission to read is
 *     asked only of a person ticked, and a mailbox without it isn't read.
 *   · Outlook, Gmail and Zoho Mail read alike — oldest first, from where reading got to, never twice.
 *   · Only mail with somebody already in Deskzo is kept: a contact by address, one company by its contacts' domain or its
 *     website. Internal mail, a stranger, and a free-mail sender who isn't a contact are read past and never kept.
 *   · The timeline shows a kept email only where the admin lets the Timeline read that mailbox.
 *   · An agent reads a kept email only from a mailbox it's allowed, and every read is logged.
 *   · Only whoever manages settings can turn it on or tick a mailbox.
 *   · Arjun (src/lib/mail-reading/arjun.ts): a customer's email about money, with invoices open, goes to his reply
 *     reader once — on a MAILBOX carrier chase no list counts; one with nothing owed, or not about money, doesn't. A
 *     vendor's bill by email is listed only for its mailbox's owner, read from the mailbox's attachment, and skippable.
 *   · Tara and Ved (src/lib/mail-reading/tara.ts): a nurtured lead's email goes to the nurture-reply reader, a customer's
 *     answer after a check-in to the check-in reader — not emailed again to an owner whose own mailbox it's in; any
 *     other open lead's email goes on its activity, its owner told. Each once.
 *   · Support (src/lib/mail-reading/support.ts): a customer's email about a problem opens a ticket under their company —
 *     nothing sent to them — with Kabir's draft as an internal comment; one carrying the ticket's tag goes on it as a
 *     reply; one not about a problem, or that Arjun took as money mail, doesn't. Each once.
 *
 * Against the local database, with the mailboxes standing in; everything made is removed.
 *
 *   npm run check:mail-reading
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actor = { id: "", role: "ADMIN", name: "Zz Mail", email: "zz-mail@example.invalid" };
const tokens: Record<string, { provider: "MICROSOFT" | "GOOGLE" | "ZOHO"; mailbox: string }> = {};
// Tara's two readers stand in: what reaches them, and whether it's forwarded (their own suites test what they do).
const handed: { to: "nurture" | "checkIn"; token: string; subject: string; forward: boolean }[] = [];
const told: { userId: string; title: string }[] = [];

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/lib/nurture/server" || request.endsWith("lib/nurture/server")) {
    return { receiveNurtureReply: async (token: string, mail: { subject: string }, _now: Date, opts: { forward?: boolean } = {}) => void handed.push({ to: "nurture", token, subject: mail.subject, forward: opts.forward !== false }) };
  }
  if (request === "@/lib/reengage/server" || request.endsWith("lib/reengage/server")) {
    return { receiveCheckInReply: async (token: string, mail: { subject: string }, _now: Date, opts: { forward?: boolean } = {}) => void handed.push({ to: "checkIn", token, subject: mail.subject, forward: opts.forward !== false }) };
  }
  if (request === "@/lib/notify" || request.endsWith("lib/notify")) return { notifyUser: async (n: { userId: string; title: string }) => void told.push(n) };
  if (request === "@/lib/mail/mailbox" || request.endsWith("lib/mail/mailbox")) {
    return {
      workplaceAccess: async (userId: string) => {
        const t = tokens[userId];
        return t ? { ok: true, token: `tok-${userId}`, connection: { provider: t.provider, mailbox: t.mailbox, displayName: null, zoho: t.provider === "ZOHO" ? { region: "in", accountId: "ACC1" } : null } } : { ok: false, error: "no", reconnect: true };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function main() {
  const db = directClient();
  const run = Date.now().toString(36);
  const acme = `acme-${run}.example`;
  const site = `site-${run}.example`;
  const admin = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true, active: true }, select: { id: true, name: true, email: true } });
  actor = { id: admin.id, role: "ADMIN", name: admin.name, email: admin.email ?? actor.email };
  const free = await db.user.findMany({ where: { active: true, mailConnection: null, isSuperAdmin: false }, take: 3, select: { id: true, email: true } });
  if (free.length < 3) throw new Error("Needs three active people without a mailbox in the local database.");
  const [outlook, gmail, zoho] = free as [{ id: string; email: string | null }, { id: string; email: string | null }, { id: string; email: string | null }];
  const ourDomain = (admin.email ?? "x@ours.example").split("@")[1]!;
  const mailboxOf = (u: { email: string | null }) => (u.email ?? `zz-${run}@${ourDomain}`).toLowerCase();

  // The fake mailboxes, by URL.
  const T0 = new Date(Date.now() + 1000);
  const at = (mins: number) => new Date(T0.getTime() + mins * 60_000);
  const graphMsg = (id: string, from: string, to: string[], mins: number, subject: string) => ({
    id,
    conversationId: `c-${id}`,
    from: { emailAddress: { address: from, name: from.split("@")[0] } },
    toRecipients: to.map((a) => ({ emailAddress: { address: a } })),
    ccRecipients: [],
    subject,
    receivedDateTime: at(mins).toISOString(),
    bodyPreview: `Preview ${subject}`,
    body: { contentType: "text", content: `Body of ${subject}` },
    hasAttachments: false,
  });
  const b64 = (t: string) => Buffer.from(t).toString("base64url");
  const extraGraph: ReturnType<typeof graphMsg>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/v1.0/me/messages/o8/attachments")) return json({ value: [{ name: "INV-9.pdf", contentType: "application/pdf", size: 9, contentBytes: Buffer.from("%PDF-1.4 x").toString("base64") }] });
    if (url.includes("/v1.0/me/messages")) {
      const since = new Date(decodeURIComponent(url).match(/receivedDateTime gt ([^&]+)/)![1]!);
      const all = [
        graphMsg("o1", `ravi@${acme}`, [mailboxOf(outlook)], 1, "Our PO for 10 seats"),
        graphMsg("o2", `stranger@nowhere-${run}.example`, [mailboxOf(outlook)], 2, "Cold pitch"),
        graphMsg("o3", `colleague@${ourDomain}`, [mailboxOf(outlook)], 3, "Lunch?"),
        graphMsg("o4", mailboxOf(outlook), [`priya@${acme}`], 4, "Re: renewal quote"),
        graphMsg("o5", `someone${run}@gmail.com`, [mailboxOf(outlook)], 5, "Personal"),
        graphMsg("o6", `info@${site}`, [mailboxOf(outlook)], 6, "Website enquiry"),
        ...extraGraph,
      ];
      return json({ value: all.filter((m) => new Date(m.receivedDateTime) > since) });
    }
    if (url.includes("/gmail/v1/users/me/messages/g1")) {
      return json({ id: "g1", threadId: "t1", internalDate: String(at(7).getTime()), snippet: "Payment done", payload: { mimeType: "multipart/alternative", headers: [{ name: "From", value: `Ravi <ravi@${acme}>` }, { name: "To", value: mailboxOf(gmail) }, { name: "Subject", value: "Payment advice" }], parts: [{ mimeType: "text/plain", body: { data: b64("UTR 12345 for invoice 42") } }, { mimeType: "application/pdf", filename: "advice.pdf", body: { attachmentId: "a1" } }] } });
    }
    if (url.includes("/gmail/v1/users/me/messages?")) return json({ messages: [{ id: "g1" }] });
    if (url.includes("/api/accounts/ACC1/folders/F1/messages/z1/content")) return json({ data: { content: "<p>Please call me <b>tomorrow</b></p>" } });
    if (url.includes("/api/accounts/ACC1/folders")) return json({ data: [{ folderId: "F1", folderName: "Inbox", folderType: "Inbox" }] });
    if (url.includes("/api/accounts/ACC1/messages/view")) return json({ data: [{ messageId: "z1", threadId: "zt", fromAddress: `ravi@${acme}`, sender: "Ravi", toAddress: `&lt;${mailboxOf(zoho)}&gt;`, ccAddress: "", subject: "Call me", summary: "Please call", receivedTime: String(at(8).getTime()), hasAttachment: "0" }] });
    return realFetch(input as RequestInfo);
  }) as typeof fetch;

  const companies: string[] = [];
  let c0 = "";
  const conns: string[] = [];
  const server = await import("../src/lib/mail-reading/server");
  const { grantsRead } = await import("../src/lib/mail-reading/providers");
  const actions = await import("../src/actions/mail-reading");
  const before = await db.mailReadSettings.findUnique({ where: { id: "default" }, select: { enabled: true } }).catch(() => null);
  try {
    const c = await db.company.create({ data: { name: `Zz Mail ${run} Acme`, normalizedName: `zz mail ${run} acme`, createdById: admin.id }, select: { id: true } });
    companies.push(c.id);
    c0 = c.id;
    const ravi = await db.contact.create({ data: { companyId: c.id, name: "Ravi", email: `ravi@${acme}` }, select: { id: true } });
    await db.contact.create({ data: { companyId: c.id, name: "Priya", email: `priya@${acme}` } });
    const lead = await db.lead.create({ data: { companyId: c.id, title: `Zz Mail ${run} lead` } as never, select: { id: true } }).catch(() => null);
    const w = await db.company.create({ data: { name: `Zz Mail ${run} Site`, normalizedName: `zz mail ${run} site`, website: `https://www.${site}/`, createdById: admin.id }, select: { id: true } });
    companies.push(w.id);
    const mk = async (u: { id: string; email: string | null }, provider: "MICROSOFT" | "GOOGLE" | "ZOHO", scopes: string) => {
      await db.mailConnection.create({ data: { userId: u.id, provider, mailbox: mailboxOf(u), refreshTokenCipher: "x", scopes } });
      conns.push(u.id);
      tokens[u.id] = { provider, mailbox: mailboxOf(u) };
    };
    await mk(outlook, "MICROSOFT", "Mail.Send User.Read Mail.Read");
    await mk(gmail, "GOOGLE", "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly");
    await mk(zoho, "ZOHO", "ZohoMail.messages.CREATE,ZohoMail.messages.READ");

    section("Off until an admin turns it on");
    await db.mailReadSettings.upsert({ where: { id: "default" }, create: { id: "default", enabled: false }, update: { enabled: false } });
    ok("off: no reading, nobody asked for the permission", (await server.mailReadingChores({ budgetMs: 10_000 })) === null && !(await server.readingWantedFor(outlook.id)));
    ok("grantsRead knows each provider's permission", grantsRead("MICROSOFT", "Mail.Send Mail.Read") && !grantsRead("MICROSOFT", "Mail.Send") && grantsRead("GOOGLE", "x/gmail.readonly") && grantsRead("ZOHO", "ZohoMail.messages.READ") && !grantsRead("ZOHO", "ZohoMail.messages.CREATE"));
    const { hasEffectivePermission } = await import("../src/actions/permission");
    let plain: { id: string; name: string; email: string | null } | null = null;
    for (const u of await db.user.findMany({ where: { active: true, isSuperAdmin: false }, select: { id: true, name: true, email: true }, take: 60 })) {
      if (!(await hasEffectivePermission(u.id, "settings.manage"))) {
        plain = u;
        break;
      }
    }
    if (plain) {
      actor = { id: plain.id, role: "USER", name: plain.name, email: plain.email ?? "zz@example.invalid" };
      ok("somebody who doesn't manage settings can't turn it on, or tick a mailbox", !(await actions.setMailReadingOn(true)).ok && !(await actions.setPersonMailReaders(outlook.id, ["timeline"])).ok && (await actions.getMailReading()) === null);
      actor = { id: admin.id, role: "ADMIN", name: admin.name, email: admin.email ?? actor.email };
    }
    ok("an admin turns it on", (await actions.setMailReadingOn(true)).ok);
    ok("  and ticks Outlook for the Timeline and Arjun, Gmail and Zoho for Arjun", (await actions.setPersonMailReaders(outlook.id, ["timeline", "arjun"])).ok && (await actions.setPersonMailReaders(gmail.id, ["arjun"])).ok && (await actions.setPersonMailReaders(zoho.id, ["arjun", "nonsense"])).ok);
    ok("  a person ticked is asked for the permission to read; one not ticked isn't", (await server.readingWantedFor(outlook.id)) && !(await server.readingWantedFor(admin.id)));
    // Reading starts from the moment ticked: put the cursors just before the fake mail.
    await db.mailReadCursor.updateMany({ where: { userId: { in: [outlook.id, gmail.id, zoho.id] } }, data: { since: new Date(T0.getTime() - 1000) } });

    section("Reading, and keeping only known parties");
    const r1 = await server.mailReadingChores({ budgetMs: 60_000 });
    const kept = await db.mailMessage.findMany({ where: { userId: { in: [outlook.id, gmail.id, zoho.id] } }, orderBy: { sentAt: "asc" }, select: { providerId: true, companyId: true, contactId: true, leadId: true, direction: true, bodyText: true, hasAttachments: true } });
    const ids = kept.map((k) => k.providerId);
    ok("three mailboxes read", r1?.mailboxes === 3, r1);
    ok("a contact by address: kept, with its company, contact and open lead", kept.some((k) => k.providerId === "o1" && k.companyId === c.id && k.contactId === ravi.id && (!lead || k.leadId === lead.id)));
    ok("sent mail to a contact: kept as OUT", kept.some((k) => k.providerId === "o4" && k.direction === "OUT" && k.companyId === c.id));
    ok("a company by its website: kept", kept.some((k) => k.providerId === "o6" && k.companyId === w.id));
    ok("a stranger, a colleague and a free-mail sender: never kept", !ids.includes("o2") && !ids.includes("o3") && !ids.includes("o5"), ids);
    ok("Gmail: its text and that it had an attachment", kept.some((k) => k.providerId === "g1" && k.bodyText.includes("UTR 12345") && k.hasAttachments));
    ok("Zoho Mail: read from its Inbox, text out of the HTML", kept.some((k) => k.providerId === "F1/z1" && k.bodyText.includes("Please call me tomorrow")), kept.find((k) => k.providerId === "F1/z1")?.bodyText);
    const r2 = await server.mailReadingChores({ budgetMs: 60_000 });
    ok("read again: nothing kept twice", r2?.kept === 0 && (await db.mailMessage.count({ where: { userId: { in: [outlook.id, gmail.id, zoho.id] } } })) === kept.length, r2);

    section("A mailbox without the permission isn't read");
    await db.mailConnection.update({ where: { userId: zoho.id }, data: { scopes: "ZohoMail.messages.CREATE" } });
    const r3 = await server.mailReadingChores({ budgetMs: 60_000 });
    ok("Zoho without READ: skipped", r3?.mailboxes === 2, r3);
    ok("  and its person is told to connect again", (await server.myMailReading(zoho.id))?.needsReconnect === true && (await server.myMailReading(outlook.id))?.needsReconnect === false);

    section("The timeline, only where the Timeline may read");
    const { recordActivity } = await import("../src/lib/activity/timeline");
    const feed = await recordActivity(admin.id, { companyId: c.id }, { take: 50 });
    const mailItems = feed.items.filter((i) => i.id.startsWith("mailbox-"));
    ok("Outlook's (Timeline ticked) emails are on the customer's timeline", mailItems.some((i) => i.title.startsWith("Email from") && i.detail === "Our PO for 10 seats") && mailItems.some((i) => i.title.startsWith("Email to")), mailItems.map((i) => `${i.title} | ${i.detail}`));
    ok("  Gmail's and Zoho's (Arjun only) aren't", !mailItems.some((i) => i.detail === "Payment advice" || i.detail === "Call me"));

    section("An agent reads only what it's allowed, and it's logged");
    const all = await db.mailMessage.findMany({ where: { userId: { in: [outlook.id, gmail.id, zoho.id] } }, select: { id: true, userId: true } });
    const tara = await server.agentMayRead("tara", all.map((m) => m.id), "check");
    ok("Tara isn't allowed any of these mailboxes: reads nothing", tara.length === 0);
    const arjun = await server.agentMayRead("arjun", all.map((m) => m.id), "payment advice check");
    ok("Arjun reads all three mailboxes' mail", arjun.length === all.length);
    ok("  every read logged with its purpose", (await db.mailReadLog.count({ where: { messageId: { in: all.map((m) => m.id) }, agent: "arjun", purpose: "payment advice check" } })) === all.length);
    section("Arjun: a customer's money mail, to his reply reader");
    const owing = await db.tradeDocument.findFirst({ where: { docType: "INVOICE", status: { notIn: ["DRAFT", "CANCELLED", "PAID"] } }, select: { companyId: true } });
    const vendor = await db.company.create({ data: { name: `Zz Mail ${run} Vendor`, normalizedName: `zz mail ${run} vendor`, relationshipType: "VENDOR", createdById: admin.id }, select: { id: true } });
    companies.push(vendor.id);
    await db.contact.create({ data: { companyId: vendor.id, name: "Billing", email: `billing@vendor-${run}.example` } });
    const payer = owing?.companyId ? await db.contact.create({ data: { companyId: owing.companyId, name: `Zz Payer ${run}`, email: `payer@payer-${run}.example` }, select: { id: true } }) : null;
    const mail = (id: string, from: string, mins: number, subject: string, attach = false) => ({ ...graphMsg(id, from, [mailboxOf(outlook)], mins, subject), hasAttachments: attach, body: { contentType: "text", content: `${subject} — details inside` } });
    if (payer) extraGraph.push(mail("o7", `payer@payer-${run}.example`, 20, "Payment done — UTR 555 via NEFT"), mail("o9", `payer@payer-${run}.example`, 21, "Team lunch photos"));
    extraGraph.push(mail("o10", `priya@${acme}`, 22, "Payment of the balance next week"));
    extraGraph.push(mail("o8", `billing@vendor-${run}.example`, 23, "Tax invoice INV-9 for October", true));
    await db.mailConnection.update({ where: { userId: zoho.id }, data: { scopes: "ZohoMail.messages.READ" } });
    await server.mailReadingChores({ budgetMs: 60_000 });
    const arjunMail = await import("../src/lib/mail-reading/arjun");
    const arjunHanded = await arjunMail.arjunMoneyMail();
    const carriers = await db.collectionChase.findMany({ where: { status: "MAILBOX", createdById: outlook.id }, select: { id: true, companyId: true, documentIds: true, replies: { select: { subject: true, reading: true } } } });
    if (payer) {
      ok("a customer with invoices open, writing about payment: handed to Arjun's reader", carriers.some((c) => c.companyId === owing!.companyId && c.documentIds.length > 0 && c.replies[0]?.subject.startsWith("Payment done") && c.replies[0]?.reading === null), { handed: arjunHanded, carriers: carriers.length });
      ok("  their email that isn't about money: not handed", !carriers.some((c) => c.replies.some((r) => r.subject === "Team lunch photos")));
    }
    ok("a customer with nothing owed: passed, and noted so it isn't asked again", !carriers.some((c) => c.companyId === c0) && (await db.mailReadLog.count({ where: { agent: "arjun", purpose: { startsWith: "money: nothing owed" }, message: { providerId: "o10" } } })) === 1);
    const again = await arjunMail.arjunMoneyMail();
    ok("  run again: nothing handed twice", again?.handed === 0 && (await db.collectionChase.count({ where: { status: "MAILBOX", createdById: outlook.id } })) === carriers.length, again);
    if (payer) {
      const { repliesFor } = await import("../src/lib/collections/chase-server");
      ok("  it's among the mailbox owner's replies in My collections", (await repliesFor(outlook.id)).some((r) => r.subject.startsWith("Payment done")));
    }

    section("Arjun: a vendor's bill by email");
    const bills = await arjunMail.mailBillsFor(outlook.id);
    const bill = bills.find((b) => b.subject.startsWith("Tax invoice INV-9"));
    ok("listed for the mailbox's owner, with the vendor", !!bill && bill.vendor === `Zz Mail ${run} Vendor`, bills);
    ok("  not for anybody else", !(await arjunMail.mailBillsFor(gmail.id)).some((b) => b.id === bill?.id) && (await arjunMail.mailBillToRead(gmail.id, bill?.id ?? "")) === null);
    const toRead = await arjunMail.mailBillToRead(outlook.id, bill?.id ?? "");
    const { firstReadableFile } = await import("../src/lib/mail-reading/attachments");
    const file = toRead ? await firstReadableFile(toRead.userId, toRead.providerId) : null;
    ok("its attachment fetched from the mailbox, as the bill reader takes it", file?.type === "application/pdf" && file.name === "INV-9.pdf" && file.bytes.toString().startsWith("%PDF"), file && { name: file.name, type: file.type });
    ok("  and logged as read for a bill", (await db.mailReadLog.count({ where: { messageId: bill?.id ?? "", agent: "arjun", purpose: { startsWith: "bill:" } } })) === 1);
    ok("  read, it's off the list", !(await arjunMail.mailBillsFor(outlook.id)).some((b) => b.id === bill?.id));

    section("Tara and Ved: leads' and customers' replies");
    // Three companies: a nurtured lead's, a customer Tara checked in with, and one with a plain open lead.
    const mkCo = async (tag: string) => {
      const co = await db.company.create({ data: { name: `Zz Mail ${run} ${tag}`, normalizedName: `zz mail ${run} ${tag.toLowerCase()}`, createdById: admin.id }, select: { id: true } });
      companies.push(co.id);
      const person = await db.contact.create({ data: { companyId: co.id, name: `${tag} person`, email: `${tag.toLowerCase()}@${tag.toLowerCase()}-${run}.example` }, select: { id: true } });
      return { co: co.id, contact: person.id, email: `${tag.toLowerCase()}@${tag.toLowerCase()}-${run}.example` };
    };
    const n = await mkCo("Nurtured");
    const k = await mkCo("Checked");
    const o = await mkCo("Open");
    const nLead = await db.lead.create({ data: { companyId: n.co, title: `Zz ${run} nurtured lead`, ownerUserId: outlook.id } as never, select: { id: true } });
    const oLead = await db.lead.create({ data: { companyId: o.co, title: `Zz ${run} open lead`, ownerUserId: admin.id } as never, select: { id: true } });
    const enrol = await db.nurtureEnrolment.create({ data: { leadId: nLead.id, contactId: n.contact, ownerId: outlook.id, enrolledById: admin.id, replyToken: `zz-n-${run}` }, select: { id: true } });
    await db.reengageEmail.create({ data: { companyId: k.co, contactId: k.contact, ownerId: gmail.id, subject: "Checking in", body: "x", replyToken: `zz-e-${run}`, status: "SENT", sentAt: new Date(T0.getTime() - 86_400_000) } });
    await actions.setPersonMailReaders(outlook.id, ["timeline", "arjun", "tara"]);
    await actions.setPersonMailReaders(gmail.id, ["arjun", "tara"]);
    extraGraph.push(mail("o11", n.email, 30, "Re: our plans — call me Thursday"), mail("o12", k.email, 31, "Re: Checking in — yes, send a quote"), mail("o13", o.email, 32, "Question about pricing"));
    await server.mailReadingChores({ budgetMs: 60_000 });
    // Cc'd to the Gmail mailbox too (its owner isn't the lead's): the same nurture email, in a colleague's mailbox.
    const nurturedKept = await db.mailMessage.findFirst({ where: { userId: outlook.id, providerId: "o11" }, select: { leadId: true, companyId: true } });
    ok("the nurtured lead's email kept, on its lead", nurturedKept?.leadId === nLead.id);
    const taraMail = await import("../src/lib/mail-reading/tara");
    const r = await taraMail.taraReadsReplies();
    const toNurture = handed.find((h) => h.to === "nurture" && h.token === `zz-n-${run}`);
    ok("a nurtured lead's email: to Tara's nurture-reply reader", !!toNurture && toNurture.subject.includes("call me Thursday"), { r, handed });
    ok("  in its owner's own mailbox: not emailed to them again", toNurture?.forward === false);
    const toCheckIn = handed.find((h) => h.to === "checkIn" && h.token === `zz-e-${run}`);
    ok("a customer's answer after a check-in: to her check-in reader", !!toCheckIn && toCheckIn.subject.includes("send a quote"));
    ok("  in a mailbox not the account manager's: forwarded to them", toCheckIn?.forward === true);
    const act = await db.activity.findFirst({ where: { leadId: oLead.id, type: "EMAIL" }, select: { notes: true } });
    ok("any other open lead's email: on its activity", !!act && act.notes.includes("Question about pricing"));
    ok("  and its owner told, the mailbox not being theirs", told.some((t) => t.userId === admin.id && t.title.includes("open lead")));
    const before2 = handed.length;
    const again2 = await taraMail.taraReadsReplies();
    ok("run again: nothing handled twice", handed.length === before2 && (await db.activity.count({ where: { leadId: oLead.id, type: "EMAIL" } })) === 1, again2);
    ok("every one logged as Tara's read", (await db.mailReadLog.count({ where: { agent: "tara", message: { providerId: { in: ["o11", "o12", "o13"] } } } })) === 3);
    await db.nurtureEnrolment.delete({ where: { id: enrol.id } });

    section("Support: a customer's email about a problem, to a ticket");
    const sup = await mkCo("Helped");
    // A deal open with them too: Tara notes their emails on the lead, and a problem still gets its ticket.
    const supLead = await db.lead.create({ data: { companyId: sup.co, title: "Zz " + run + " renewal", ownerUserId: admin.id } as never, select: { id: true } });
    await actions.setPersonMailReaders(outlook.id, ["timeline", "arjun", "tara", "support"]);
    const supportMail = await import("../src/lib/mail-reading/support");
    const drafted: string[] = [];
    supportMail.setTestTicketDrafter(async ({ question }) => {
      drafted.push(question);
      return "Sorry about that. Could you send a screenshot of the error and when it started?";
    });
    extraGraph.push(mail("o14", sup.email, 33, "Login not working — error 500 since morning"), mail("o15", sup.email, 34, "Team lunch next week"));
    if (payer) extraGraph.push(mail("o16", `payer@payer-${run}.example`, 35, "Payment failed with an error on the bank's site"));
    await server.mailReadingChores({ budgetMs: 60_000 });
    await arjunMail.arjunMoneyMail();
    await taraMail.taraReadsReplies();
    const s1 = await supportMail.supportReadsMail();
    const made = await db.ticket.findMany({ where: { companyId: sup.co }, select: { id: true, ticketSeq: true, title: true, contactId: true } });
    ok("a customer's email about a problem: a ticket under their company, from them", made.length === 1 && made[0]!.title.startsWith("Login not working") && made[0]!.contactId === sup.contact, { s1, made });
    const keptMail = made[0] ? await db.supportEmail.findMany({ where: { ticketId: made[0].id }, select: { direction: true, note: true } }) : [];
    ok("  nothing sent to the customer, and the email says whose mailbox it came to", keptMail.length === 1 && keptMail[0]!.direction === "INBOUND" && (keptMail[0]!.note ?? "").includes("mailbox"), keptMail);
    const notes = made[0] ? await db.ticketComment.findMany({ where: { ticketId: made[0].id }, select: { body: true } }) : [];
    ok("  Kabir's draft answer on it, as an internal comment", notes.length === 1 && notes[0]!.body.startsWith("Kabir's draft answer — not sent") && notes[0]!.body.includes("screenshot") && drafted[0]?.includes("error 500") === true);
    ok("  with a deal open, Tara noted it on the lead as well", (await db.activity.count({ where: { leadId: supLead.id, type: "EMAIL" } })) >= 1);
    ok("their email that isn't about a problem: no ticket", !(await db.supportEmail.count({ where: { subject: "Team lunch next week" } })));
    if (payer) ok("one Arjun took as money mail: not a ticket too", !(await db.supportEmail.count({ where: { subject: "Payment failed with an error on the bank's site" } })));
    const s2 = await supportMail.supportReadsMail();
    ok("run again: nothing handled twice", s2?.tickets === 0 && s2.replies === 0 && (await db.ticket.count({ where: { companyId: sup.co } })) === 1, s2);
    if (made[0]) {
      const { ticketTag } = await import("../src/lib/support-mail/rules");
      extraGraph.push(mail("o17", sup.email, 36, `Re: Login not working ${ticketTag(made[0].ticketSeq)} — still failing`));
      await server.mailReadingChores({ budgetMs: 60_000 });
      const s3 = await supportMail.supportReadsMail();
      ok("one carrying the ticket's tag: on that ticket as a reply, with a new draft", s3?.replies === 1 && (await db.supportEmail.count({ where: { ticketId: made[0].id, state: "REPLY" } })) === 1 && (await db.ticketComment.count({ where: { ticketId: made[0].id } })) === 2, s3);
    }
    ok("every one logged as Support's read", (await db.mailReadLog.count({ where: { agent: "support", message: { providerId: { in: ["o14", "o17"] } }, purpose: { startsWith: "ticket: a customer" } } })) === (made[0] ? 2 : 1));
    supportMail.setTestTicketDrafter(null);

    await actions.setMailReadingOn(false);
    ok("turned off: no agent reads", (await server.agentMayRead("arjun", all.map((m) => m.id), "x")).length === 0);
  } finally {
    globalThis.fetch = realFetch;
    await db.collectionChase.deleteMany({ where: { status: "MAILBOX", createdById: { in: conns } } });
    await db.reengageEmail.deleteMany({ where: { replyToken: { startsWith: "zz-e-" } } });
    await db.activity.deleteMany({ where: { lead: { companyId: { in: companies } } } });
    await db.contact.deleteMany({ where: { email: { endsWith: `@payer-${run}.example` } } });
    await db.mailMessage.deleteMany({ where: { userId: { in: conns } } });
    await db.mailReadGrant.deleteMany({ where: { userId: { in: conns } } });
    await db.mailReadCursor.deleteMany({ where: { userId: { in: conns } } });
    await db.mailConnection.deleteMany({ where: { userId: { in: conns } } });
    await db.lead.deleteMany({ where: { companyId: { in: companies } } });
    await db.contact.deleteMany({ where: { companyId: { in: companies } } });
    await db.company.deleteMany({ where: { id: { in: companies } } });
    if (before) await db.mailReadSettings.update({ where: { id: "default" }, data: { enabled: before.enabled } });
    else await db.mailReadSettings.deleteMany({ where: { id: "default" } });
  }

  console.log(failures === 0 ? `\nAll ${passes} mail-reading checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
