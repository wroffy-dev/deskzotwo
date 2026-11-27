"use server";

import { revalidatePath } from "next/cache";
import { emitTicketStatusChanged } from "@/lib/automate/emit-tickets";
import { Prisma, type TicketStatus, type TicketPriority, type TicketType } from "@prisma/client";
import { db } from "@/lib/db";
import { getWording } from "@/lib/terms/server";
import { slot, upperFirst } from "@/lib/terms/dictionary";
import { CATEGORY_SELECT } from "@/lib/customers/categories";
import { requireModuleAccess, requireModuleUser } from "@/lib/modules-access";
import { isModuleEnabled } from "@/actions/module";
import { orderAccess, ticketAccess, type AccessAction } from "@/lib/authz/access";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { hasEffectivePermission, viewerHas } from "@/actions/permission";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { formatTicketId } from "@/lib/tickets";
import { ticketPath } from "@/lib/record-links";
import { UNPAGED_LIST_CEILING, pageSlice } from "@/lib/pagination";
import {
  createTicketSchema,
  updateTicketStatusSchema,
  updateTicketPrioritySchema,
  assignTicketSchema,
  bulkUpdateTicketsSchema,
  addTicketCommentSchema,
} from "@/lib/validation/ticket";
import type { ActionResult } from "@/actions/company";
import { filteredWordsRefusal } from "@/lib/word-filter/server";
import { isSupportAgent, liveForSupport, newTicketRefusal, writeTicket } from "@/lib/ticket-open";
import { liveNamesakes, ticketCompanies } from "@/lib/ticket-companies";
import { addTicketContactAt, ticketContacts } from "@/lib/ticket-contacts";
import { formSetup } from "@/lib/custom-fields/server";
import { contactInputSchema } from "@/lib/validation/company";
import { seqSearchTerm } from "@/lib/order-id";
import { maskContactRows } from "@/lib/contacts/masking";

/** Active users belonging to a department marked as a support team — the only people a ticket can be assigned to. */
export async function listSupportAgents() {
  await requireModuleAccess("helpdesk");
  return db.user.findMany({
    where: { active: true, department: { isSupportTeam: true } },
    orderBy: { name: "asc" },
    select: { id: true, name: true, role: true },
  });
}

export async function createTicket(input: unknown): Promise<ActionResult<{ id: string; ticketSeq: number }>> {
  const user = await requireModuleUser("helpdesk");
  // Only somebody who may open the Helpdesk: the Create menu and the form are hidden otherwise, and this
  // is the same rule for a caller who posts anyway (decideModuleAccess, src/lib/navigation.ts).
  if (!(await isModuleEnabled("helpdesk"))) return { ok: false, error: "You don't have access to the Helpdesk." };
  if (!(await hasEffectivePermission(user.id, "tickets.create"))) {
    return { ok: false, error: "You don't have permission to create tickets." };
  }
  const parsed = createTicketSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  // The rules about this ticket, and writing it, are shared with Automate's workflows (src/lib/ticket-open.ts).
  const refused = await newTicketRefusal(user.id, data);
  if (refused) return { ok: false, error: refused };
  const ticket = await db.$transaction((tx) => writeTicket(tx, user.id, data, "person"));

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "Ticket",
    entityId: ticket.id,
    entityLabel: `${formatTicketId(ticket.ticketSeq)} — ${ticket.title}`,
  });

  revalidatePath("/tickets");
  revalidatePath(`/companies/${data.companyId}`);
  return { ok: true, data: { id: ticket.id, ticketSeq: ticket.ticketSeq } };
}

/** Lightweight order list for the ticket "which order is this support for?" picker — no Decimal fields, so it's safe to pass straight to a Client Component. */
export async function listCompanyOrderOptions(companyId: string) {
  const user = await requireModuleAccess("helpdesk");
  const rows = await db.companyProduct.findMany({
    // Scoped as well as filtered by id: the company id arrives from the caller and is not a
    // secret, so without this the picker would list what any account has bought to anyone who
    // passes one in. Asked of the orders' own rule, so it lists the orders this person may open.
    // Theirs, or bought for them by a reseller — the end customer's to be supported on.
    where: { AND: [{ OR: [{ companyId }, { endCustomerId: companyId }] }, { orderStatus: "FULFILLED", parentId: null }, await orderAccess(user.id, "view")] },
    orderBy: { createdAt: "desc" },
    select: { id: true, orderSeq: true, orderStatus: true, parentId: true, endDate: true, item: { select: { name: true, type: true } } },
  });
  // Only what is live (src/lib/ticket-open.ts liveForSupport): delivered, and a subscription not expired.
  return rows
    .filter((r) => liveForSupport(r))
    .map((r) => ({ id: r.id, orderSeq: r.orderSeq, item: { name: r.item.name }, until: r.item.type === "SUBSCRIPTION" && r.endDate ? r.endDate.toISOString().slice(0, 10) : null }));
}

/** The New ticket form's company search, each with what it has live (src/lib/ticket-companies.ts). */
export async function searchTicketCompanies(query: string) {
  const user = await requireModuleAccess("helpdesk");
  if (!(await hasEffectivePermission(user.id, "tickets.create"))) return [];
  return ticketCompanies(user.id, query);
}

/** Companies of the same name with something live, for one picked that has nothing. */
export async function ticketNamesakes(companyId: string) {
  const user = await requireModuleAccess("helpdesk");
  if (typeof companyId !== "string" || !companyId || !(await hasEffectivePermission(user.id, "tickets.create"))) return [];
  return liveNamesakes(user.id, companyId);
}

/** The chosen company's people, and whether somebody new can be added from here (src/lib/ticket-contacts.ts). */
export async function listTicketContacts(companyId: string) {
  const user = await requireModuleAccess("helpdesk");
  return ticketContacts(user.id, companyId);
}

/** The workspace's own contact fields, for adding a contact from New ticket — `contactFieldSetup` is the Contacts rule's. */
export async function ticketContactFieldSetup(): Promise<Awaited<ReturnType<typeof formSetup>>> {
  const user = await requireModuleAccess("helpdesk");
  if (!(await hasEffectivePermission(user.id, "tickets.create"))) return { fields: [], values: {}, people: [] };
  return formSetup("CONTACT", user.id);
}

/** Adds somebody to the company a ticket is being logged on, from that form. */
export async function addTicketContact(companyId: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleAccess("helpdesk");
  const parsed = contactInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const made = await addTicketContactAt(user.id, companyId, parsed.data);
  if (!made.ok) return made;
  revalidatePath(`/companies/${companyId}`);
  return { ok: true, data: { id: made.id } };
}

type TicketListParams = {
  status?: TicketStatus;
  priority?: TicketPriority;
  ticketType?: TicketType;
  assignedToUserId?: string;
  search?: string;
  companyId?: string;
};

/**
 * A ticket reaches its company in one hop — `Ticket.companyId` — so the account manager on that
 * company is what decides whose ticket it is, exactly as `companies.viewAll` describes.
 *
 * Support is untouched by this: every support preset holds `companies.viewAll`, so the ticket rule
 * (src/lib/authz/access.ts, "tickets") hands them `{}` and the helpdesk still sees every ticket in the
 * business — until an admin sets a level of its own for tickets on the role.
 */
async function ticketListWhere(userId: string, params?: TicketListParams): Promise<Prisma.TicketWhereInput> {
  return {
    // Inside an AND: the level may itself be an OR (its assignee or creator), and so is the search.
    AND: [await ticketAccess(userId, "view")],
    ...(params?.status ? { status: params.status } : {}),
    ...(params?.priority ? { priority: params.priority } : {}),
    ...(params?.ticketType ? { ticketType: params.ticketType } : {}),
    ...(params?.companyId ? { companyId: params.companyId } : {}),
    ...(params?.assignedToUserId
      ? params.assignedToUserId === "unassigned"
        ? { assignedToUserId: null }
        : { assignedToUserId: params.assignedToUserId }
      : {}),
    ...(params?.search
      ? {
          OR: [
            { title: { contains: params.search, mode: "insensitive" as const } },
            { company: { name: { contains: params.search, mode: "insensitive" as const } } },
            // Its number, as the list shows it — "TCK-000123", "123" (owner, 1 Nov 2026).
            ...seqSearchTerm(params.search, "ticketSeq"),
          ],
        }
      : {}),
  };
}

const ticketListInclude = {
  company: { select: { id: true, name: true, companySeq: true } },
  contact: { select: { id: true, name: true } },
  companyProduct: { select: { id: true, orderSeq: true } },
  assignedTo: { select: { id: true, name: true } },
} as const;

export async function listTickets(params?: TicketListParams) {
  const user = await requireModuleUser("helpdesk");
  if (!(await viewerHas("tickets.view"))) return [];
  return db.ticket.findMany({
    where: await ticketListWhere(user.id, params),
    orderBy: { updatedAt: "desc" },
    include: ticketListInclude,
    // Security audit, 13 Nov 2026 (SEC-29): its one screen, a company's Tickets tab, asks for one company's; the
    // Helpdesk list reads listTicketsPaged. Unfiltered, it stops at the ceiling rather than returning every ticket.
    take: UNPAGED_LIST_CEILING,
  });
}

export async function listTicketsPaged(params: TicketListParams & { page: number; pageSize: number }) {
  const user = await requireModuleUser("helpdesk");
  if (!(await viewerHas("tickets.view"))) return { rows: [], total: 0 };
  const where = await ticketListWhere(user.id, params);
  const [rows, total] = await Promise.all([
    db.ticket.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      include: ticketListInclude,
      ...pageSlice(params.page, params.pageSize),
    }),
    db.ticket.count({ where }),
  ]);
  return { rows, total };
}

/**
 * `findFirst` rather than `findUnique` so the scope can sit in the same `where` as the id: a ticket
 * on somebody else's account is missing rather than refused, which is the same answer as for an id
 * that never existed and so cannot be used to probe which accounts are real. The detail page
 * already renders `notFound()` for `null`.
 */
export async function getTicket(id: string) {
  const user = await requireModuleUser("helpdesk");
  if (!(await viewerHas("tickets.view"))) return null;
  const ticket = await db.ticket.findFirst({
    where: { AND: [{ id }, await ticketAccess(user.id, "view")] },
    include: {
      company: { select: { id: true, name: true, companySeq: true, customerCategory: { select: CATEGORY_SELECT } } },
      contact: { select: { id: true, name: true, email: true, phone: true, designation: true } },
      companyProduct: { select: { id: true, orderSeq: true, item: { select: { name: true } } } },
      assignedTo: { select: { id: true, name: true } },
      createdBy: { select: { id: true, name: true } },
      comments: { orderBy: { createdAt: "asc" }, include: { user: { select: { id: true, name: true } } } },
    },
  });
  if (!ticket) return null;
  // Its contact as the contacts policy shows them in a list — a ticket's page is not the contact's (owner, 5 Nov 2026 —
  // Phase 3 masking fixes, audit H.4.3; src/lib/contacts/masking.ts): the email and phone went out in full. Calling a
  // masked number still works — the server dials it (`dialledNumber`).
  const [contact] = ticket.contact ? await maskContactRows(user.id, "list", [ticket.contact]) : [null];
  return { ...ticket, contact: contact ?? null };
}

/**
 * The ticket, when this person may act on it this way (src/lib/authz/access.ts) — a ticket they can't
 * reach is missing rather than refused, as an id that never existed is.
 */
async function reachableTicket(userId: string, ticketId: string, action: AccessAction) {
  return db.ticket.findFirst({ where: { AND: [{ id: ticketId }, await ticketAccess(userId, action)] } });
}

export async function updateTicketStatus(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("helpdesk");
  const parsed = updateTicketStatusSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { ticketId, status } = parsed.data;

  const ticket = await reachableTicket(user.id, ticketId, "edit");
  if (!ticket) {
    return { ok: false, error: "Ticket not found." };
  }

  const isResolved = status === "RESOLVED" || status === "CLOSED";
  const isClosed = status === "CLOSED";

  await db.$transaction(async (tx) => {
    await tx.ticket.update({
      where: { id: ticketId },
      data: {
        status,
        resolvedAt: isResolved ? (ticket.resolvedAt ?? new Date()) : null,
        closedAt: isClosed ? (ticket.closedAt ?? new Date()) : null,
      },
    });
    await emitTicketStatusChanged(tx, ticketId, user.id, ticket.status, status);
  });

  if (ticket.assignedToUserId && ticket.assignedToUserId !== user.id) {
    await notifyUser({
      userId: ticket.assignedToUserId,
      type: "TICKET_STATUS_CHANGED",
      title: slot(await getWording(), "Your ticket's status changed", "ticket", "Your {one:lower}'s status changed"),
      message: `${formatTicketId(ticket.ticketSeq)} — now ${status.replaceAll("_", " ")}`,
      link: ticketPath(ticket.ticketSeq),
    });
  }

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Ticket",
    entityId: ticketId,
    entityLabel: `${formatTicketId(ticket.ticketSeq)} — ${ticket.title}`,
  });

  revalidatePath("/tickets");
  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath(`/companies/${ticket.companyId}`);
  return { ok: true, data: { id: ticketId } };
}

export async function updateTicketPriority(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("helpdesk");
  const parsed = updateTicketPrioritySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { ticketId, priority } = parsed.data;

  const ticket = await reachableTicket(user.id, ticketId, "edit");
  if (!ticket) {
    return { ok: false, error: "Ticket not found." };
  }

  await db.ticket.update({ where: { id: ticketId }, data: { priority } });

  revalidatePath("/tickets");
  revalidatePath(`/tickets/${ticketId}`);
  return { ok: true, data: { id: ticketId } };
}

export async function assignTicket(input: unknown): Promise<ActionResult<{ id: string }>> {
  const actor = await requireModuleUser("helpdesk");
  const parsed = assignTicketSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { ticketId, userId } = parsed.data;

  const ticket = await reachableTicket(actor.id, ticketId, "assign");
  if (!ticket) {
    return { ok: false, error: "Ticket not found." };
  }
  if (userId && !(await isSupportAgent(userId))) {
    return { ok: false, error: "Tickets can only be assigned to someone in the Tech Support department." };
  }

  await db.ticket.update({ where: { id: ticketId }, data: { assignedToUserId: userId || null } });

  if (userId && userId !== actor.id) {
    await notifyUser({
      userId,
      type: "TICKET_ASSIGNED",
      title: upperFirst(slot(await getWording(), "A ticket was assigned to you", "ticket", "{a} was assigned to you")),
      message: `${formatTicketId(ticket.ticketSeq)} — ${ticket.title}`,
      link: ticketPath(ticket.ticketSeq),
    });
  }

  revalidatePath("/tickets");
  revalidatePath(`/tickets/${ticketId}`);
  revalidatePath(`/companies/${ticket.companyId}`);
  return { ok: true, data: { id: ticketId } };
}

export async function addTicketComment(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("helpdesk");
  const parsed = addTicketCommentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { ticketId, body } = parsed.data;

  const ticket = await reachableTicket(user.id, ticketId, "edit");
  if (!ticket) {
    return { ok: false, error: "Ticket not found." };
  }

  // Words the workspace keeps out of tickets (src/lib/word-filter): not saved, and only the writer is told.
  const filtered = await filteredWordsRefusal("TICKETS", [body]);
  if (filtered) return { ok: false, error: filtered };

  const comment = await db.ticketComment.create({ data: { ticketId, userId: user.id, body } });

  if (ticket.assignedToUserId && ticket.assignedToUserId !== user.id) {
    await notifyUser({
      userId: ticket.assignedToUserId,
      type: "TICKET_COMMENT",
      title: slot(await getWording(), "New comment on your ticket", "ticket", "New comment on your {one:lower}"),
      message: `${formatTicketId(ticket.ticketSeq)} — ${body}`,
      link: ticketPath(ticket.ticketSeq),
    });
  }

  revalidatePath(`/tickets/${ticketId}`);
  return { ok: true, data: { id: comment.id } };
}

/**
 * Deleting a ticket, and its whole thread, is the workspace's super admin's alone (owner, 27 Oct 2026) — whatever
 * a role's "tickets.delete" says; never while viewing as someone else. Written to the audit log.
 */
export async function deleteTicket(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("helpdesk");
  if (!(await actingAsSuperAdmin(user.id))) {
    return { ok: false, error: "Only the workspace's super admin can delete tickets." };
  }
  // Tickets have no delete scope (src/lib/authz/access.ts): the super admin reaches every ticket to edit, so to delete.
  const ticket = await reachableTicket(user.id, id, "edit");
  if (!ticket) {
    return { ok: false, error: "Ticket not found." };
  }

  const gone = await db.ticket.findUnique({ where: { id }, select: { ticketSeq: true, title: true } });
  await db.ticket.delete({ where: { id } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "Ticket", entityId: id, entityLabel: `Deleted ticket ${gone ? formatTicketId(gone.ticketSeq) : id}${gone?.title ? ` — ${gone.title.slice(0, 120)}` : ""}` });

  revalidatePath("/tickets");
  revalidatePath(`/companies/${ticket.companyId}`);
  return { ok: true, data: null };
}

/**
 * Bulk edits from the ticket list's selection bar. Each change goes through the single-ticket
 * action rather than an `updateMany`: status, priority and assignment each notify someone and
 * write an audit entry, and a bulk path that skipped those would leave the helpdesk's history
 * depending on how the change happened to be made.
 */
export async function bulkUpdateTickets(input: unknown): Promise<ActionResult<{ count: number }>> {
  await requireModuleUser("helpdesk");
  const parsed = bulkUpdateTicketsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { ticketIds, assignedToUserId, status, priority } = parsed.data;
  if (!assignedToUserId && !status && !priority) {
    return { ok: false, error: "Pick an agent, status or priority to apply." };
  }

  for (const ticketId of ticketIds) {
    if (assignedToUserId) {
      const result = await assignTicket({
        ticketId,
        userId: assignedToUserId === "unassign" ? "" : assignedToUserId,
      });
      if (!result.ok) return { ok: false, error: result.error };
    }
    if (status) {
      const result = await updateTicketStatus({ ticketId, status });
      if (!result.ok) return { ok: false, error: result.error };
    }
    if (priority) {
      const result = await updateTicketPriority({ ticketId, priority });
      if (!result.ok) return { ok: false, error: result.error };
    }
  }

  revalidatePath("/tickets");
  return { ok: true, data: { count: ticketIds.length } };
}

/** Open tickets across the whole filtered set, so the header count doesn't shrink as you page. */
export async function countOpenTickets(params?: TicketListParams) {
  const user = await requireModuleAccess("helpdesk");
  if (!(await viewerHas("tickets.view"))) return 0;
  return db.ticket.count({
    // Scoped through the same `where` as the list it sits above, or the header would count
    // tickets the rows beneath it no longer show.
    where: { AND: [await ticketListWhere(user.id, params), { status: { notIn: ["RESOLVED", "CLOSED"] } }] },
  });
}
