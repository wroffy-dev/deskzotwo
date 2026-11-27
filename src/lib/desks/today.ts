import { db } from "@/lib/db";
import { ticketAccess } from "@/lib/authz/access";
import { formatTicketId, getTicketSlaStatus } from "@/lib/tickets";
import { ticketPath } from "@/lib/record-links";
import { notMigratedYet } from "@/lib/not-migrated";
import { viewAsContext } from "@/lib/session";
import type { Clock } from "@/lib/time/zone";
import type { SupportRow } from "@/components/today/support-card";
import { formatRequestId, requestPath } from "./rules";
import { deskDay, viewerOf } from "./server";

const SHOWN = 12;

/**
 * What support work is with this person today (owner, 25 Nov 2026): customers' tickets given to them, as their ticket
 * rule lets them see; colleagues' requests and steps; and what waits for their approval or their answer. Each only where
 * its module is open to them, and nothing of the help desk while viewing as somebody.
 */
export async function supportToday(userId: string, openModules: readonly string[], clock: Clock, now = new Date()): Promise<{ rows: SupportRow[]; more: number }> {
  const rows: SupportRow[] = [];
  if (openModules.includes("helpdesk")) {
    const tickets = await db.ticket.findMany({
      where: { AND: [await ticketAccess(userId, "view"), { assignedToUserId: userId, status: { in: ["OPEN", "IN_PROGRESS", "ON_HOLD"] } }] },
      orderBy: { createdAt: "asc" },
      take: 100,
      select: { ticketSeq: true, title: true, priority: true, status: true, createdAt: true, company: { select: { name: true } } },
    });
    for (const t of tickets) {
      const late = getTicketSlaStatus(t.priority, t.status, t.createdAt, clock, now).key === "overdue";
      rows.push({ key: `t${t.ticketSeq}`, href: ticketPath(t.ticketSeq), kind: "Ticket", title: t.title, detail: `${formatTicketId(t.ticketSeq)}, ${t.company.name}`, late });
    }
  }
  if (openModules.includes("desks") && !(await viewAsContext())) {
    try {
      const v = await viewerOf(userId);
      const d = v ? await deskDay(v, now) : null;
      if (d?.approvals) rows.push({ key: "approvals", href: "/approvals", kind: "Approve", title: d.approvals === 1 ? "A help desk request waits for your approval" : `${d.approvals} help desk requests wait for your approval` });
      for (const a of d?.answers ?? []) rows.push({ key: `a${a.seq}`, href: requestPath(a.seq), kind: "Answer", title: a.title, detail: `${formatRequestId(a.seq)}, waiting for you` });
      for (const r of d?.assigned ?? []) rows.push({ key: `r${r.seq}`, href: requestPath(r.seq), kind: "Request", title: r.title, detail: `${formatRequestId(r.seq)}, ${r.from}`, late: r.late });
      for (const [i, s] of (d?.steps ?? []).entries()) rows.push({ key: `s${s.seq}-${i}`, href: requestPath(s.seq), kind: "Step", title: s.title, detail: `${formatRequestId(s.seq)}, ${s.request}` });
    } catch (err) {
      // This workspace hasn't the help desk's tables yet.
      if (!notMigratedYet(err)) throw err;
    }
  }
  // What's late first, then as they came.
  const ordered = [...rows.filter((r) => r.late), ...rows.filter((r) => !r.late)];
  return { rows: ordered.slice(0, SHOWN), more: Math.max(0, ordered.length - SHOWN) };
}
