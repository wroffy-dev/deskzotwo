import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { mayAccessAccount, mayAddTo } from "@/lib/authz/access";
import { getRenewalStatus } from "@/lib/renewals";
import { filteredWordsRefusal } from "@/lib/word-filter/server";
import { emitTicketCreated } from "@/lib/automate/emit-tickets";
import type { EventCause } from "@/lib/automate/action-types";
import type { CreateTicketInput } from "@/lib/validation/ticket";

/**
 * Opening a ticket by hand — the one way it is done, by a person (`createTicket`, src/actions/ticket.ts)
 * or by a workflow's step (src/lib/automate/actions). Whether the person may open tickets at all is the
 * caller's question; these are the rules about this one: a company they reach, a contact and an order
 * of that company, somebody in support to assign it to, and none of the words the workspace keeps out.
 */

/** Only users in a department marked as a support team can be assigned tickets. */
export async function isSupportAgent(userId: string): Promise<boolean> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { department: { select: { isSupportTeam: true } } },
  });
  return user?.department?.isSupportTeam ?? false;
}

/** Why this person can't open this ticket, in words — or null. */
export async function newTicketRefusal(actorId: string, data: CreateTicketInput): Promise<string | null> {
  const company = await db.company.findUnique({ where: { id: data.companyId } });
  // A ticket is logged on a company the person reaches — one they couldn't then open is refused as missing.
  if (!company) return "Company not found.";
  if (!(await mayAddTo(actorId, "tickets", company))) {
    // One they can see is told why (owner, 25 Nov 2026: Support, seeing every customer but changing none, read "Company
    // not found" for each); one they can't stays missing.
    return (await mayAccessAccount(actorId, "view", company))
      ? "You can see this company, but your role can't add tickets to it. An admin can allow it in Settings › Access Control › Data Scope › Support tickets."
      : "Company not found.";
  }
  if (data.contactId) {
    const contact = await db.contact.findUnique({ where: { id: data.contactId } });
    if (!contact || contact.companyId !== data.companyId) return "That contact does not belong to the selected company.";
  }
  if (data.companyProductId) {
    const order = await db.companyProduct.findUnique({
      where: { id: data.companyProductId },
      select: { companyId: true, endCustomerId: true, orderStatus: true, parentId: true, endDate: true, item: { select: { type: true } } },
    });
    if (!order || (order.companyId !== data.companyId && order.endCustomerId !== data.companyId)) return "That order does not belong to the selected company.";
    if (!liveForSupport(order)) return "Support is only for a product or subscription that is live — this one isn't delivered yet, has ended or was cancelled.";
  }
  if (data.assignedToUserId && !(await isSupportAgent(data.assignedToUserId))) {
    return "Tickets can only be assigned to someone in the Tech Support department.";
  }
  // Words the workspace keeps out of tickets (src/lib/word-filter): not saved, and only the writer is told.
  return filteredWordsRefusal("TICKETS", [data.title, data.description]);
}

/**
 * What a customer may raise a ticket about (owner, 2 Nov 2026 — "no customer can ask for support for a product he
 * didn't purchase"): an order delivered to them, and — a subscription — not yet expired. Seats added mid-term come
 * with their subscription, so only the subscription itself is offered.
 */
export function liveForSupport(order: { orderStatus: string; parentId: string | null; endDate: Date | string | null; item: { type: string } }, now: Date = new Date()): boolean {
  if (order.orderStatus !== "FULFILLED" || order.parentId !== null) return false;
  return order.item.type !== "SUBSCRIPTION" || getRenewalStatus(order.endDate, now).key !== "expired";
}

/** The ticket, in the caller's transaction, with its event for workflows. */
export async function writeTicket(tx: Prisma.TransactionClient, actorId: string, data: CreateTicketInput, via: string, cause: EventCause | null = null) {
  const made = await tx.ticket.create({
    data: {
      companyId: data.companyId,
      contactId: data.contactId || null,
      companyProductId: data.companyProductId || null,
      title: data.title,
      description: data.description || null,
      ticketType: data.ticketType,
      priority: data.priority,
      assignedToUserId: data.assignedToUserId || null,
      createdByUserId: actorId,
    },
  });
  await emitTicketCreated(tx, made.id, actorId, via, cause);
  return made;
}
