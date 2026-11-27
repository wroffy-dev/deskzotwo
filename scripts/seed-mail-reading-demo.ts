/**
 * seed:mail-reading-demo — the AI teammates reading connected mailboxes, shown on the local workspace (owner, 23 Nov
 * 2026: "Show me mail reading working in chrome"). Local demo data only:
 *
 *   · Two mailboxes stand in as connected — the super admin's (Outlook) and Vivaan Gupta's (Gmail) — with the read
 *     permission granted. Their tokens are not real, so nothing ever reaches a provider: the emails a real read would
 *     have kept are written straight into what reading keeps (MailMessage), as `readOne` would.
 *   · Mail reading on; the admin's mailbox read by every agent, Vivaan's by the Timeline and Tara.
 *   · Seven emails with real customers, a lead and a vendor, then the agents run for real on them: Arjun's money mail
 *     and his reply reader, Tara's replies, Support's tickets with Kabir's draft (when local Deskzo AI is set up), and
 *     the vendor's bill listed for reading.
 *
 * Emails are from the workspace's own demo contacts (@….example) and one made here (@mail-demo.example). Everything is
 * removed by `clean`: the two connections and all they kept and read, the tickets, the chases, the activity, the
 * notifications they made, and the contact.
 *
 *   npx tsx scripts/seed-mail-reading-demo.ts          make it (cleans a previous run first)
 *   npx tsx scripts/seed-mail-reading-demo.ts clean    remove it
 */
import "dotenv/config";
import { directClient } from "../src/lib/tenancy/direct-client";

const db = directClient();
const DEMO_TOKEN = "demo-not-a-token";
const BILL_FROM = "accounts@mail-demo.example";
const MIN = 60_000;

async function clean() {
  const conns = await db.mailConnection.findMany({ where: { refreshTokenCipher: DEMO_TOKEN }, select: { userId: true, connectedAt: true } });
  const users = conns.map((c) => c.userId);
  if (!users.length) return console.log("Nothing to clean.");
  const from = new Date(Math.min(...conns.map((c) => c.connectedAt.getTime())) - MIN);
  const tickets = await db.supportEmail.findMany({ where: { messageId: { endsWith: "@mail-reading.deskzo>" } }, select: { ticketId: true } });
  const ticketIds = [...new Set(tickets.map((t) => t.ticketId).filter((t): t is string => !!t))];
  await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
  await db.supportEmail.deleteMany({ where: { messageId: { endsWith: "@mail-reading.deskzo>" } } });
  await db.collectionChase.deleteMany({ where: { status: "MAILBOX", createdById: { in: users } } });
  const subjects = (await db.mailMessage.findMany({ where: { userId: { in: users } }, select: { subject: true } })).map((m) => m.subject);
  for (const s of subjects) await db.activity.deleteMany({ where: { type: "EMAIL", userId: { in: users }, notes: { contains: s } } });
  await db.notification.deleteMany({ where: { createdAt: { gte: from, lte: new Date(from.getTime() + 30 * MIN) }, type: { in: ["TICKET_EMAIL", "LEAD_ASSIGNED"] } } });
  await db.mailMessage.deleteMany({ where: { userId: { in: users } } });
  await db.mailReadGrant.deleteMany({ where: { userId: { in: users } } });
  await db.mailReadCursor.deleteMany({ where: { userId: { in: users } } });
  await db.mailConnection.deleteMany({ where: { userId: { in: users } } });
  await db.contact.deleteMany({ where: { email: BILL_FROM } });
  if (!(await db.mailConnection.count())) await db.mailReadSettings.deleteMany({ where: { id: "default" } });
  console.log(`Cleaned: ${users.length} mailboxes, ${ticketIds.length} tickets.`);
}

async function make() {
  await clean();
  const admin = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true, active: true }, select: { id: true, name: true, email: true } });
  const vivaan = await db.user.findFirstOrThrow({ where: { email: "vivaan.gupta@team.deskzo.test", active: true }, select: { id: true, name: true, email: true } });
  const contactAt = async (name: string) => {
    const c = await db.company.findFirstOrThrow({ where: { name }, select: { id: true, name: true, contacts: { where: { email: { not: null }, leftAt: null }, orderBy: { createdAt: "asc" }, take: 1, select: { name: true, email: true } } } });
    if (!c.contacts[0]) throw new Error(`${name} has no contact with an email`);
    return { company: c.name, name: c.contacts[0].name, email: c.contacts[0].email!.toLowerCase() };
  };
  const owing = await contactAt("Bluestone Hospitals Limited");
  const support = await contactAt("Northstar Motors LLP");
  const friendly = await contactAt("Everest Realty Limited");
  const lead = await db.lead.findFirstOrThrow({ where: { leadSeq: 39 }, select: { companyId: true } });
  const leadCo = await db.company.findUniqueOrThrow({ where: { id: lead.companyId }, select: { name: true } });
  const prospect = await contactAt(leadCo.name);
  const vendor = await db.company.findFirstOrThrow({ where: { relationshipType: "VENDOR" }, orderBy: { createdAt: "asc" }, select: { id: true, name: true } });
  await db.contact.create({ data: { companyId: vendor.id, name: "Accounts team", email: BILL_FROM } });

  await db.mailReadSettings.upsert({ where: { id: "default" }, create: { id: "default", enabled: true, updatedById: admin.id }, update: { enabled: true, updatedById: admin.id } });
  const now = Date.now();
  await db.mailConnection.create({ data: { userId: admin.id, provider: "MICROSOFT", mailbox: admin.email, displayName: admin.name, refreshTokenCipher: DEMO_TOKEN, scopes: "offline_access Mail.Send Mail.Read User.Read" } });
  await db.mailConnection.create({ data: { userId: vivaan.id, provider: "GOOGLE", mailbox: vivaan.email, displayName: vivaan.name, refreshTokenCipher: DEMO_TOKEN, scopes: "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly" } });
  for (const [userId, agents] of [[admin.id, ["timeline", "arjun", "tara", "support"]], [vivaan.id, ["timeline", "tara"]]] as const) {
    for (const agent of agents) await db.mailReadGrant.create({ data: { userId, agent, createdById: admin.id } });
    await db.mailReadCursor.create({ data: { userId, since: new Date(now - 3 * 3_600_000), lastRunAt: new Date(now - 2 * MIN), kept: 0 } });
  }

  // What a read of the two mailboxes would have kept: the company, the contact, and an open lead where there is one.
  type M = { user: string; provider: string; id: string; from: { name: string; email: string }; to: string; subject: string; body: string; minsAgo: number; out?: boolean; attach?: boolean };
  const mails: M[] = [
    { user: admin.id, provider: "MICROSOFT", id: "demo-1", from: owing, to: admin.email, minsAgo: 95, subject: "Payment for the October invoices", body: `Hi,\n\nWe've released the payment for the October invoices this morning by NEFT — UTR HDFCN52026112300417. One invoice is held back: the AMC line is short by ₹4,200, we'll pay it once the revised copy comes.\n\nRegards,\n${owing.name}\n${owing.company}` },
    { user: admin.id, provider: "MICROSOFT", id: "demo-2", from: support, to: admin.email, minsAgo: 80, subject: "Portal login not working since yesterday", body: `Hello,\n\nNone of us can log in to the licence portal since yesterday evening — it says "Access denied" after the password. Two of our designers are blocked on a delivery today. Please help urgently.\n\nThanks,\n${support.name}\n${support.company}` },
    { user: admin.id, provider: "MICROSOFT", id: "demo-3", from: prospect, to: admin.email, minsAgo: 70, subject: "Delivery date for the IronWolf drives?", body: `Hi,\n\nBefore we place the order — can the 8TB drives reach our Jaipur site by the 5th? If so we'll send the PO this week.\n\n${prospect.name}\n${leadCo.name}` },
    { user: admin.id, provider: "MICROSOFT", id: "demo-4", from: { name: "Accounts team", email: BILL_FROM }, to: admin.email, minsAgo: 60, attach: true, subject: `Tax invoice INV-2611 for November — ${vendor.name}`, body: "Dear customer,\n\nPlease find attached our tax invoice INV-2611 for November. Kindly arrange payment within 30 days.\n\nAccounts team" },
    { user: admin.id, provider: "MICROSOFT", id: "demo-5", from: friendly, to: admin.email, minsAgo: 50, subject: "Thanks for yesterday's meeting", body: `Hi,\n\nThanks for the time yesterday — the team liked the walkthrough. We'll come back with the user count next week.\n\n${friendly.name}` },
    { user: admin.id, provider: "MICROSOFT", id: "demo-6", out: true, from: { name: admin.name, email: admin.email }, to: friendly.email, minsAgo: 40, subject: "Re: Thanks for yesterday's meeting", body: `Thank you, ${friendly.name.split(" ")[0]} — I'll keep the proposal ready for when the count comes in.` },
    { user: vivaan.id, provider: "GOOGLE", id: "demo-7", from: friendly, to: vivaan.email, minsAgo: 30, subject: "Training slots for our team", body: `Hi Vivaan,\n\nCould we book two training slots in the first week of December for the new users?\n\n${friendly.name}` },
  ];
  for (const m of mails) {
    const party = m.out ? friendly : m.from;
    const contact = await db.contact.findFirst({ where: { email: { equals: party.email, mode: "insensitive" } }, select: { id: true, companyId: true } });
    const openLead = contact ? await db.lead.findFirst({ where: { companyId: contact.companyId, status: { notIn: ["WON", "LOST", "DISQUALIFIED"] } }, orderBy: { updatedAt: "desc" }, select: { id: true } }) : null;
    await db.mailMessage.create({
      data: {
        userId: m.user,
        provider: m.provider,
        providerId: m.id,
        direction: m.out ? "OUT" : "IN",
        fromEmail: m.from.email,
        fromName: m.from.name,
        toEmails: [m.to],
        ccEmails: [],
        subject: m.subject,
        snippet: m.body.replace(/\s+/g, " ").slice(0, 200),
        bodyText: m.body,
        hasAttachments: !!m.attach,
        sentAt: new Date(now - m.minsAgo * MIN),
        companyId: contact?.companyId ?? null,
        contactId: contact?.id ?? null,
        leadId: openLead?.id ?? null,
      },
    });
  }
  for (const userId of [admin.id, vivaan.id]) await db.mailReadCursor.update({ where: { userId }, data: { kept: mails.filter((m) => m.user === userId).length } });

  // The agents, as the heartbeat runs them.
  const { arjunMoneyMail } = await import("../src/lib/mail-reading/arjun");
  const { taraReadsReplies } = await import("../src/lib/mail-reading/tara");
  const { supportReadsMail } = await import("../src/lib/mail-reading/support");
  const { readChaseReplies } = await import("../src/lib/collections/chase-server");
  console.log("Arjun, money mail:", await arjunMoneyMail());
  console.log("Tara, replies:", await taraReadsReplies());
  console.log("Support, tickets:", await supportReadsMail());
  console.log("Arjun, reading replies:", await readChaseReplies().catch((err) => `failed: ${err instanceof Error ? err.message : err}`));
  console.log(`\nMailboxes: ${admin.name} (Outlook, every agent), ${vivaan.name} (Gmail, Timeline and Tara). ${mails.length} emails.`);
}

(process.argv[2] === "clean" ? clean() : make()).then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
