import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { can } from "@/lib/authz/resolve";
import { notifyUser } from "@/lib/notify";
import { documentWriteKey } from "@/lib/documents/write-permission";
import { agentMayRead, mailReadingEnabled } from "@/lib/mail-reading/server";

/**
 * Arjun reading money mail from the mailboxes an admin lets him read (owner, 23 Nov 2026: "Yes, Arjun next" — phase two of
 * src/lib/mail-reading). Two kinds, each handed to what Arjun already does, so a person acts on it as they already do:
 *
 *   · **A customer's mail about money** — paid, will pay, disputes, asks for a copy — goes to his chase-reply reader
 *     (src/lib/collections/chase-server.ts): a reply on a carrier chase of status "MAILBOX" (never a draft, never "sent",
 *     so no list of chases counts it), with the customer's open invoices. On the next heartbeat he reads it, and the
 *     mailbox's owner acts in My collections: log the promise, ask accounts to check the bank, pause reminders.
 *   · **A vendor's bill by email** — listed for the mailbox's owner on Purchase › Read a bill; "Read it" fetches the
 *     attachment from the mailbox (src/lib/mail-reading/attachments.ts) into the bill reader, as an upload would.
 *
 * Only mail from a mailbox Arjun is allowed, only once each, and every read logged (MailReadLog, agentMayRead).
 */

const MONEY = /\b(paid|payment|pay|remit(tance)?|utr|neft|rtgs|imps|upi|transfer(red)?|cheque|check|dd|outstanding|overdue|due|balance|ledger|statement|tds|credit note|debit note|dispute|short ?paid)\b/i;
const BILL = /\b(invoice|bill|tax invoice|proforma)\b/i;
const PER_TICK = 20;
const DAY = 86_400_000;

async function arjunMailboxes(): Promise<string[]> {
  return (await db.mailReadGrant.findMany({ where: { agent: "arjun", user: { active: true } }, select: { userId: true } })).map((g) => g.userId);
}

/** Messages Arjun has already looked at for one purpose. */
async function seen(messageIds: string[], purpose: string): Promise<Set<string>> {
  if (!messageIds.length) return new Set();
  return new Set((await db.mailReadLog.findMany({ where: { messageId: { in: messageIds }, agent: "arjun", purpose: { startsWith: purpose } }, select: { messageId: true } })).map((l) => l.messageId));
}

/** The heartbeat's turn: customers' money mail, newest kept, handed to the reply reader. Null when reading is off. */
export async function arjunMoneyMail(now = new Date()): Promise<{ handed: number } | null> {
  try {
    if (!(await mailReadingEnabled())) return null;
    const owners = await arjunMailboxes();
    if (!owners.length) return { handed: 0 };
    const candidates = await db.mailMessage.findMany({
      where: { userId: { in: owners }, direction: "IN", companyId: { not: null }, sentAt: { gte: new Date(now.getTime() - 14 * DAY) } },
      orderBy: { sentAt: "asc" },
      take: 200,
      select: { id: true, userId: true, companyId: true, fromEmail: true, fromName: true, subject: true, bodyText: true, snippet: true, sentAt: true, company: { select: { name: true, relationshipType: true } } },
    });
    const done = await seen(candidates.map((c) => c.id), "money");
    let handed = 0;
    for (const m of candidates) {
      if (handed >= PER_TICK) break;
      if (done.has(m.id) || !m.companyId) continue;
      if (!MONEY.test(`${m.subject}\n${m.bodyText.slice(0, 4000)}`)) continue;
      const invoices = await db.tradeDocument.findMany({ where: { companyId: m.companyId, docType: "INVOICE", status: { notIn: ["DRAFT", "CANCELLED", "PAID"] } }, orderBy: { dueDate: "asc" }, take: 50, select: { id: true } });
      // About money, but nothing owed: a payment to a vendor, or a quote — not Arjun's.
      if (!invoices.length) {
        await db.mailReadLog.create({ data: { messageId: m.id, agent: "arjun", purpose: "money: nothing owed — passed" } });
        continue;
      }
      const allowed = await agentMayRead("arjun", [m.id], "money: a customer's email about what they owe");
      if (!allowed.length) continue;
      // The same email in two mailboxes (one copied in) is read once.
      const token = `mail-${createHash("sha256").update(`${m.companyId}|${m.fromEmail}|${m.subject}|${Math.floor(m.sentAt.getTime() / 60_000)}`).digest("hex").slice(0, 32)}`;
      if (await db.collectionChase.findUnique({ where: { replyToken: token }, select: { id: true } })) continue;
      const chase = await db.collectionChase.create({
        data: { companyId: m.companyId, createdById: m.userId, sentById: m.userId, status: "MAILBOX", tone: "mailbox", subject: m.subject.slice(0, 300) || "(no subject)", body: "", documentIds: invoices.map((i) => i.id), replyToken: token, sentAt: m.sentAt },
        select: { id: true },
      });
      await db.collectionReply.create({
        data: { chaseId: chase.id, fromName: (m.fromName || m.fromEmail).slice(0, 200), fromEmail: m.fromEmail.slice(0, 320) || null, senderVerified: true, subject: m.subject.slice(0, 300) || "(no subject)", text: (m.bodyText || m.snippet).slice(0, 20_000) },
      });
      handed += 1;
    }
    return { handed };
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

export type MailBill = { id: string; vendor: string; companyId: string | null; subject: string; from: string; sentAt: string };

/** Vendor bills that came by email to this person's own mailbox, not yet read — for Purchase › Read a bill. */
export async function mailBillsFor(userId: string, now = new Date()): Promise<MailBill[]> {
  try {
    if (!(await mailReadingEnabled())) return [];
    if (!(await db.mailReadGrant.count({ where: { userId, agent: "arjun" } }))) return [];
    const rows = await db.mailMessage.findMany({
      where: {
        userId,
        direction: "IN",
        hasAttachments: true,
        sentAt: { gte: new Date(now.getTime() - 60 * DAY) },
        company: { OR: [{ relationshipType: "VENDOR" }, { alsoVendor: true }] },
      },
      orderBy: { sentAt: "desc" },
      take: 40,
      select: { id: true, subject: true, fromEmail: true, fromName: true, sentAt: true, bodyText: true, companyId: true, company: { select: { name: true } } },
    });
    const done = await seen(rows.map((r) => r.id), "bill");
    return rows
      .filter((r) => !done.has(r.id) && BILL.test(`${r.subject}\n${r.bodyText.slice(0, 2000)}`))
      .slice(0, 20)
      .map((r) => ({ id: r.id, vendor: r.company?.name ?? "A vendor", companyId: r.companyId, subject: r.subject || "(no subject)", from: r.fromName || r.fromEmail, sentAt: r.sentAt.toISOString() }));
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

/** The email behind a bill, for reading it: this person's own, from a mailbox Arjun may read — logged as read. */
export async function mailBillToRead(userId: string, messageId: string): Promise<{ providerId: string; userId: string } | null> {
  const m = await db.mailMessage.findUnique({ where: { id: String(messageId) }, select: { id: true, userId: true, providerId: true, hasAttachments: true } });
  if (!m || m.userId !== userId || !m.hasAttachments) return null;
  const allowed = await agentMayRead("arjun", [m.id], "bill: a vendor's bill read into a draft");
  return allowed.length ? { providerId: m.providerId, userId: m.userId } : null;
}

/** "Skip": a bill that isn't one, or was entered already — off the list. */
export async function skipMailBill(userId: string, messageId: string): Promise<boolean> {
  const m = await db.mailMessage.findUnique({ where: { id: String(messageId) }, select: { id: true, userId: true } });
  if (!m || m.userId !== userId) return false;
  await db.mailReadLog.create({ data: { messageId: m.id, agent: "arjun", purpose: "bill: skipped by its owner" } });
  return true;
}

/** Once a day, tell each person with bills waiting from their mailbox — only those who may create bills. */
export async function tellMailBills(now = new Date()): Promise<number> {
  try {
    if (!(await mailReadingEnabled())) return 0;
    let told = 0;
    for (const userId of await arjunMailboxes()) {
      const bills = await mailBillsFor(userId, now);
      const fresh = bills.filter((b) => now.getTime() - Date.parse(b.sentAt) < DAY);
      if (!fresh.length || !(await can(userId, documentWriteKey("BILL", "create")).catch(() => false))) continue;
      await notifyUser({ userId, type: "PAYMENT_FOLLOW_UP_DUE", title: `Arjun: ${fresh.length} vendor bill${fresh.length === 1 ? "" : "s"} came by email`, message: fresh.map((b) => b.vendor).slice(0, 3).join(", "), link: "/purchase/bills/read#by-email" }).catch(() => {});
      told += 1;
    }
    return told;
  } catch (err) {
    if (notMigratedYet(err)) return 0;
    throw err;
  }
}
