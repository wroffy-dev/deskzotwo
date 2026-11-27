import { db } from "@/lib/db";
import { getOrganisation } from "@/lib/organisation";
import type { CollectionConfig } from "@/lib/collect/settings";

/**
 * Who a payment reminder comes from (owner, 3 Nov 2026: "option to send from the user's mailbox, or a particular email
 * id, or SMTP settings") — Settings › Payment collection's "Send from":
 *
 *   · PERSON — the person named, through their mailbox or the company's mail server as Settings › Document emails says.
 *   · ACCOUNT_MANAGER — each customer's own account manager, the same way, so the customer hears from who they know and
 *     replies land with them. A customer with nobody active managing it, or whose manager can't send it (they can't
 *     open the invoice, or haven't connected the mailbox they must send from), gets it from the person named instead.
 *   · COLLECTIONS — a shared address on the company's mail server (Settings › Messaging): "Accounts — Wroffy" at
 *     accounts@…, replies and the copy to it. The From address is the shared one where the mail server lets it send as
 *     that address (Microsoft 365 or Google signed in as it, or any SMTP that allows it); else the server's own, with
 *     replies still to the shared one. The person named is still whose signature and access it goes with.
 */

export type ReminderSender = { id: string; name: string; email: string | null };
export type SharedFrom = { fromName: string; fromEmail: string | null; replyTo: string };
export type SendAs = { sender: ReminderSender; shared?: SharedFrom; fallback: ReminderSender | null };

/** The shared address, as the mail goes: its name (or "Accounts — <our name>") and address. */
export async function sharedFrom(config: CollectionConfig): Promise<SharedFrom | null> {
  const email = config.collectionsEmail?.trim();
  if (!email) return null;
  const org = await getOrganisation();
  const ours = org.tradeName || org.legalName || "";
  return { fromName: config.collectionsFromName?.trim() || (ours ? `Accounts — ${ours}` : "Accounts"), fromEmail: email, replyTo: email };
}

/** Whom one customer's reminder goes as, and who takes over if they can't send it. */
export async function sendAsFor(config: CollectionConfig, companyId: string, named: ReminderSender, shared: SharedFrom | null): Promise<SendAs> {
  if (config.senderMode === "COLLECTIONS" && shared) return { sender: named, shared, fallback: null };
  if (config.senderMode === "ACCOUNT_MANAGER") {
    const company = await db.company.findUnique({ where: { id: companyId }, select: { owner: { select: { id: true, name: true, email: true, active: true } } } });
    const owner = company?.owner;
    if (owner?.active && owner.id !== named.id) return { sender: { id: owner.id, name: owner.name, email: owner.email }, fallback: named };
  }
  return { sender: named, fallback: null };
}

export const SENDER_MODE_WORDS: Record<CollectionConfig["senderMode"], string> = {
  PERSON: "One person",
  ACCOUNT_MANAGER: "Each customer's account manager",
  COLLECTIONS: "A shared collections address",
};
