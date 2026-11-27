import { TicketPriority, TicketStatus, type Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { mayAddTo, ticketAccess } from "@/lib/authz/access";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { can } from "@/lib/authz/resolve";
import { optionalUserRef, requireCompany } from "./lookups";
import {
  createRow,
  diff,
  errorRow,
  keyOf,
  seqFromKey,
  updateRow,
  RowReader,
  type Importer,
  type ImportContext,
  type Resolved,
} from "./types";

/**
 * Support tickets — the header of one, not the conversation on it.
 *
 * Matched on the Ticket cell (TKT-000123). No key means a new ticket, which is what makes importing
 * a helpdesk's back catalogue possible at all; a key we do not have is refused rather than being
 * quietly turned into a create, because a file full of another system's numbering would otherwise
 * duplicate every ticket it touches.
 *
 * ## Three judgment calls
 *
 * **`Raised` is write-once.** Importing history is the point of this importer, so the date the
 * ticket was raised is honoured on create. On a ticket that already exists it is neither compared
 * nor written: a spreadsheet's idea of a date is a day, the record's is a timestamp, and letting the
 * two argue would rewrite the age of every ticket in the file on every import — while the numbers
 * that hang off that age (resolution time, SLA) silently moved with it.
 *
 * **A ticket cannot change company.** The Company cell is required, but on an existing ticket it has
 * to be the company it is already against. A ticket carries a contact, an order and an asset that
 * all belong to that account; moving the header alone would leave those pointing into somebody
 * else's records, and nothing in the app offers that move either.
 *
 * **`resolvedAt` and `closedAt` are never invented, only retracted.** A file can say a ticket is
 * CLOSED and that is recorded, but no resolution time is made up for it: stamping "resolved just
 * now" onto a ticket raised two years ago would report a two-year resolution against whoever it is
 * assigned to, in `performance.ts` and in the targets. Those stamps belong to the act of resolving.
 * A stamp the new status makes untrue is cleared, though — see `clearedStamps` — because a
 * reopened ticket that keeps its `resolvedAt` is counted as resolved and as open simultaneously.
 *
 * Comments are deliberately out of scope. A thread is a list of authored, timestamped messages and a
 * flat file has one cell per column; a "Comments" column is therefore not a column this importer
 * understands, and lands in the unknown-column warning rather than being half-read.
 *
 * ## Whose tickets (owner, 3 Nov 2026 — "Phase 2 permission fixes", audit H-6 follow-up)
 *
 * `data.importCrm` says the person may import, not which tickets they may change — and this matched any ticket by its
 * key, wrote over it, and showed its title, status and assignee in the preview. Now, as the ticket screens ask:
 *   · the company named is one they may see; one they can't answers as a name nobody has;
 *   · a ticket out of their view scope (`ticketAccess(view)`) is no ticket here — its key answers as a made-up one;
 *   · one they may see but not change (`ticketAccess(edit)`) refuses the row, saying so;
 *   · a new one needs what New ticket needs (`createTicket`): "Create tickets", and the company one they may log a
 *     ticket on (`mayAddTo`).
 */

type ResolvedTicket = {
  title: string;
  companyId: string;
  companyName: string;
  status?: TicketStatus;
  priority?: TicketPriority;
  assigneeUserId?: string;
  assigneeName?: string;
  raisedAt?: Date;
  existing: {
    id: string;
    ticketSeq: number;
    title: string;
    status: TicketStatus;
    priority: TicketPriority;
    assignedToName: string | null;
  } | null;
};

/** Who is importing, read once per file: which tickets they may see and change, and whether they may raise one. */
type Scope = { view: Prisma.TicketWhereInput; edit: Prisma.TicketWhereInput; mayCreate: boolean };
const scopes = new WeakMap<ImportContext, Promise<Scope>>();
function scopeFor(ctx: ImportContext): Promise<Scope> {
  let found = scopes.get(ctx);
  if (!found) {
    found = (async () => {
      const [view, edit, mayCreate] = await Promise.all([ticketAccess(ctx.actorUserId, "view"), ticketAccess(ctx.actorUserId, "edit"), can(ctx.actorUserId, "tickets.create")]);
      return { view, edit, mayCreate };
    })();
    scopes.set(ctx, found);
  }
  return found;
}

async function resolve(row: Record<string, string>, ctx: ImportContext): Promise<Resolved<ResolvedTicket>> {
  const scope = await scopeFor(ctx);
  const r = new RowReader(row);
  const title = r.text("Title");
  if (!title) return { error: "Title is required." };

  const status = r.enum("Status", TicketStatus);
  const priority = r.enum("Priority", TicketPriority);
  const raisedAt = r.date("Raised");
  if (r.error) return { error: r.error };

  const company = await requireCompany("Company", r.text("Company"));
  if ("error" in company) return { error: company.error };
  // A company out of sight answers as a name nobody has (audit H-6 follow-up).
  const account = await db.company.findUniqueOrThrow({ where: { id: company.value.id }, select: { id: true, ownerUserId: true, relationshipType: true } });
  if (!(await canSeeCompany(ctx.actorUserId, account))) {
    return { error: `No company named "${r.text("Company")}" (Company). Import the company first, or correct the spelling.` };
  }

  // A cell that holds *something* is somebody naming a ticket. If it is not one of our keys we
  // cannot tell which, and `seqFromKey` returning null would otherwise fall through to "no key
  // means create" — turning a file carrying another helpdesk's numbering into a duplicate of every
  // ticket in it, which is the one outcome this importer exists to prevent.
  const ticketCell = r.text("Ticket");
  const seq = seqFromKey("TKT", ticketCell);
  if (ticketCell && seq === null) {
    return {
      error: `Ticket "${ticketCell}" isn't one of our ticket keys — they look like ${keyOf("TKT", 123)}. Clear the cell to raise a new ticket, or correct it to the key of an existing one.`,
    };
  }

  // Only among the tickets this person may see: one outside it answers as a made-up key does (audit H-6 follow-up).
  const found = seq
    ? await db.ticket.findFirst({
        where: { AND: [{ ticketSeq: seq }, scope.view] },
        include: { assignedTo: { select: { id: true, name: true, email: true, active: true } } },
      })
    : null;

  if (seq && !found) {
    return { error: `No ticket with key ${keyOf("TKT", seq)}. Remove the Ticket cell to raise a new one.` };
  }
  if (found && (await db.ticket.count({ where: { AND: [{ id: found.id }, scope.edit] } })) === 0) {
    return { error: `${keyOf("TKT", found.ticketSeq)} is a ticket you may see but not change. Take its row out of the file, or ask whoever it's with.` };
  }
  // A new one, as New ticket asks (`createTicket`, `newTicketRefusal`).
  if (!found && !scope.mayCreate) {
    return { error: "This row would raise a ticket, and you can't create tickets. Give it the key of a ticket you may change, or take it out of the file." };
  }
  if (!found && !(await mayAddTo(ctx.actorUserId, "tickets", account))) {
    return { error: `You can't log tickets on ${company.value.name}. Take the row out, or ask whoever looks after the account.` };
  }

  if (found && found.companyId !== company.value.id) {
    return {
      error: `${keyOf("TKT", found.ticketSeq)} belongs to another company, and a ticket can't be moved by an import — its contact, order and asset belong to that account. Correct the Company cell, or clear the Ticket cell to raise a new ticket.`,
    };
  }

  // After the ticket, so the person it is assigned to today reads back even if they have since left.
  const assignee = await optionalUserRef("Assigned to", r.text("Assigned to"), false, found?.assignedTo);
  if ("error" in assignee) return { error: assignee.error };

  return {
    value: {
      title,
      companyId: company.value.id,
      companyName: company.value.name,
      status,
      priority,
      assigneeUserId: assignee.value?.id,
      assigneeName: assignee.value?.name,
      raisedAt,
      existing: found
        ? {
            id: found.id,
            ticketSeq: found.ticketSeq,
            title: found.title,
            status: found.status,
            priority: found.priority,
            assignedToName: found.assignedTo?.name ?? null,
          }
        : null,
    },
  };
}

/**
 * The resolution stamps a new status contradicts, to be cleared alongside it.
 *
 * Nothing is invented here — a ticket the file says is CLOSED still gets no "closed just now", for
 * the reason in the header. But a stamp the new status makes *false* is cleared, exactly as
 * `updateTicketStatus` clears it. A leftover `resolvedAt` on a ticket an import has reopened is not
 * a harmless stale field: `targets/measure.ts` counts TICKETS_RESOLVED on `resolvedAt` alone and
 * `actions/performance.ts` derives resolution time and SLA from it without consulting status, while
 * its open count goes by status — so one ticket would be reported as open and as resolved at once,
 * and would keep paying out against somebody's target every period.
 *
 * Only ever nulls, so this stays idempotent and a re-import of the same file writes the same thing.
 */
function clearedStamps(status: TicketStatus | undefined): { resolvedAt?: null; closedAt?: null } {
  if (!status || status === TicketStatus.CLOSED) return {};
  // Resolved but not closed: it was resolved, it is no longer closed.
  if (status === TicketStatus.RESOLVED) return { closedAt: null };
  // Back in play. Neither stamp describes it any more.
  return { resolvedAt: null, closedAt: null };
}

export const ticketsImporter: Importer = {
  templateColumns: ["Ticket", "Company", "Title", "Status", "Priority", "Assigned to", "Raised"],

  async plan(row, line, ctx) {
    const resolved = await resolve(row, ctx);
    if ("error" in resolved) return errorRow(line, row.Title ?? "", resolved.error);
    const t = resolved.value;
    const label = `${t.title} (${t.companyName})`;

    if (!t.existing) {
      return createRow(line, `${t.companyName}: ${t.title}`, label, {
        Company: t.companyName,
        Title: t.title,
        Status: t.status,
        Priority: t.priority,
        "Assigned to": t.assigneeName,
        Raised: t.raisedAt,
      });
    }

    // Company is absent from the comparison because a row that named a different one never reaches
    // here, and Raised because it is write-once.
    return updateRow(line, keyOf("TKT", t.existing.ticketSeq), label, [
      diff("Title", t.existing.title, t.title),
      t.status ? diff("Status", t.existing.status, t.status) : null,
      t.priority ? diff("Priority", t.existing.priority, t.priority) : null,
      t.assigneeName ? diff("Assigned to", t.existing.assignedToName, t.assigneeName) : null,
    ]);
  },

  async apply(row, ctx: ImportContext) {
    const resolved = await resolve(row, ctx);
    if ("error" in resolved) throw new Error(resolved.error);
    const t = resolved.value;

    const data = {
      title: t.title,
      ...(t.status ? { status: t.status } : {}),
      ...(t.priority ? { priority: t.priority } : {}),
      ...(t.assigneeUserId ? { assignedToUserId: t.assigneeUserId } : {}),
    };

    if (t.existing) {
      await db.ticket.update({
        where: { id: t.existing.id },
        data: { ...data, ...clearedStamps(t.status) },
      });
      return;
    }

    await db.ticket.create({
      data: {
        ...data,
        companyId: t.companyId,
        createdByUserId: ctx.actorUserId,
        ...(t.raisedAt ? { createdAt: t.raisedAt } : {}),
      },
    });
  },
};
