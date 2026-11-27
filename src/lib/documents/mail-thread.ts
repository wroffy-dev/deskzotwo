import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * A document's email thread (owner, 3 Nov 2026: "let admin decide whether the mail should go as separate mail or in same
 * thread" — Settings › Payment collection). Every email a document is sent with carries a Message-ID of ours, kept here
 * with the subject the thread began with. A payment reminder, where the admin chose it, then goes as a reply in that
 * thread: "Re: <that subject>", In-Reply-To the last email, References all of them.
 *
 * The headers reach the customer through the company's mail server, Deskzo's mail and a connected Gmail. Outlook and
 * Zoho's sending APIs write their own, so there the shared "Re:" subject is what keeps it together — which is also how
 * Outlook groups a conversation. A mail server that rewrites the Message-ID (Amazon SES does) is the same: the subject
 * carries it.
 */

/** Kept at most: enough for any reminder schedule, short enough for a header. */
const KEEP = 20;

export type ThreadHeaders = { messageId: string; inReplyTo?: string; references?: string[] };

/** A new Message-ID, on the sender's own domain where there is one. */
export function newMessageId(senderEmail: string | null | undefined): string {
  const domain = senderEmail?.split("@")[1]?.trim().toLowerCase() || "mail.deskzo.com";
  return `<${randomUUID()}@${domain}>`;
}

/** The thread's subject with any "Re:" in front of it already taken off — one "Re:" is enough. */
export function replySubject(subject: string): string {
  return `Re: ${subject.replace(/^\s*(re|fwd?|aw)\s*:\s*/i, "").trim()}`;
}

/** The thread a document's mail has begun, or null — none sent yet, or a workspace not migrated yet. */
export async function documentThread(documentId: string): Promise<{ subject: string; messageIds: string[] } | null> {
  try {
    return await db.documentMailThread.findUnique({ where: { documentId }, select: { subject: true, messageIds: true } });
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

/** What an email in the thread carries: a new Message-ID, and — a reply — the ones before it. */
export function headersFor(senderEmail: string | null | undefined, replyingTo: { messageIds: string[] } | null): ThreadHeaders {
  const messageId = newMessageId(senderEmail);
  const before = replyingTo?.messageIds ?? [];
  return before.length ? { messageId, inReplyTo: before[before.length - 1], references: before.slice(-KEEP) } : { messageId };
}

/** Records an email sent for a document: it begins the thread, or joins the one there. */
export async function rememberSent(documentId: string, subject: string, messageId: string): Promise<void> {
  try {
    const was = await db.documentMailThread.findUnique({ where: { documentId }, select: { messageIds: true } });
    if (!was) {
      await db.documentMailThread.create({ data: { documentId, subject, messageIds: [messageId] } });
      return;
    }
    await db.documentMailThread.update({ where: { documentId }, data: { messageIds: [...was.messageIds, messageId].slice(-KEEP) } });
  } catch (err) {
    // A workspace not migrated yet keeps no thread; two sends at once — the other began it, and that's fine.
    if (notMigratedYet(err)) return;
    if (err instanceof Error && "code" in err && (err as { code?: string }).code === "P2002") return;
    throw err;
  }
}
