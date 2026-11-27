"use server";

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { logActivity } from "@/lib/activity";
import { notMigratedYet } from "@/lib/not-migrated";
import { pageSlice } from "@/lib/pagination";
import { csvRow } from "@/lib/csv";
import { workspaceClock } from "@/lib/time/workspace";
import { APPROVAL_DECISIONS, APPROVAL_KINDS, isApprovalKind, type ApprovalDecision } from "@/lib/approvals/kinds";
import type { ActionResult } from "@/actions/company";

/**
 * Approvals › History (owner, 30 Oct 2026 — "who approved what, wherever approval is required"): every approval
 * decision, from `approval_events` (src/lib/approvals/log.ts). Everybody sees the decisions they made and those on
 * what they asked for; "See everyone's activity" (`activity.viewAll`) sees them all, and "Export the activity log"
 * (`activity.export`) downloads them.
 */

export type ApprovalHistoryFilters = {
  /** YYYY-MM-DD, both ends included, on the workspace's clock. */
  from?: string;
  to?: string;
  kind?: string;
  decision?: string;
  /** Who decided. */
  person?: string;
  q?: string;
  /**
   * "everyone" for every decision, to somebody who may see everyone's activity; otherwise theirs — what they decided and
   * what they asked for (owner, 9 Nov 2026: an admin opening Approvals saw every expense HR approved).
   */
  whose?: string;
};

export type ApprovalHistoryRow = {
  id: string;
  kind: string;
  kindLabel: string;
  decision: ApprovalDecision;
  label: string;
  href: string | null;
  note: string | null;
  requestedBy: string | null;
  decidedBy: string;
  decidedAt: string;
  backfilled: boolean;
};

const DECISIONS = Object.keys(APPROVAL_DECISIONS) as ApprovalDecision[];
const EXPORT_CAP = 20_000;

async function scope(userId: string, whose: string | undefined): Promise<{ where: Prisma.ApprovalEventWhereInput; all: boolean; mayAll: boolean }> {
  const mayAll = await hasEffectivePermission(userId, "activity.viewAll");
  // Everybody's only when asked for: the page opens on what is the person's own.
  const all = mayAll && whose === "everyone";
  return { all, mayAll, where: all ? {} : { OR: [{ decidedById: userId }, { requestedById: userId }] } };
}

async function whereFor(filters: ApprovalHistoryFilters, scoped: Prisma.ApprovalEventWhereInput): Promise<Prisma.ApprovalEventWhereInput> {
  const clock = await workspaceClock();
  const range = clock.dayRange(filters.from || null, filters.to || null);
  const and: Prisma.ApprovalEventWhereInput[] = [scoped];
  if (range) and.push({ decidedAt: range });
  if (isApprovalKind(filters.kind)) and.push({ kind: filters.kind });
  if (filters.decision && (DECISIONS as string[]).includes(filters.decision)) and.push({ decision: filters.decision });
  if (filters.person) and.push({ decidedById: String(filters.person).slice(0, 64) });
  const q = filters.q?.trim();
  if (q) and.push({ OR: [{ label: { contains: q.slice(0, 100), mode: "insensitive" } }, { note: { contains: q.slice(0, 100), mode: "insensitive" } }] });
  return { AND: and };
}

async function namesOf(ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  return new Map((await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
}

export async function listApprovalHistory(
  filters: ApprovalHistoryFilters,
  page: { page: number; pageSize: number },
): Promise<ActionResult<{ rows: ApprovalHistoryRow[]; total: number; people: { id: string; name: string }[]; all: boolean; mayAll: boolean }>> {
  const user = await requireUser();
  try {
    const { where: scoped, all, mayAll } = await scope(user.id, filters?.whose);
    const where = await whereFor(filters ?? {}, scoped);
    const [rows, total, deciders] = await Promise.all([
      db.approvalEvent.findMany({ where, orderBy: { decidedAt: "desc" }, ...pageSlice(Math.max(1, page.page), Math.min(200, Math.max(1, page.pageSize))) }),
      db.approvalEvent.count({ where }),
      // Everybody who has decided something this person may see, for the filter.
      db.approvalEvent.findMany({ where: scoped, distinct: ["decidedById"], select: { decidedById: true }, take: 500 }),
    ]);
    const names = await namesOf([...rows.flatMap((r) => [r.decidedById, r.requestedById]), ...deciders.map((d) => d.decidedById)]);
    return {
      ok: true,
      data: {
        rows: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          kindLabel: isApprovalKind(r.kind) ? APPROVAL_KINDS[r.kind] : r.kind,
          decision: r.decision as ApprovalDecision,
          label: r.label,
          href: r.href,
          note: r.note,
          requestedBy: r.requestedById ? (names.get(r.requestedById) ?? "A removed user") : null,
          decidedBy: names.get(r.decidedById) ?? "A removed user",
          decidedAt: r.decidedAt.toISOString(),
          backfilled: r.backfilled,
        })),
        total,
        people: deciders.map((d) => ({ id: d.decidedById, name: names.get(d.decidedById) ?? "A removed user" })).sort((a, b) => a.name.localeCompare(b.name)),
        all,
        mayAll,
      },
    };
  } catch (err) {
    if (notMigratedYet(err)) return { ok: true, data: { rows: [], total: 0, people: [], all: false, mayAll: false } };
    throw err;
  }
}

/** The same rows as a CSV, for whoever may export the activity log — and the export itself goes in it. */
export async function exportApprovalHistory(filters: ApprovalHistoryFilters): Promise<ActionResult<{ csv: string; rows: number }>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "activity.export"))) {
    await logActivity({ kind: "PERMISSION_DENIED", summary: `${user.name} tried to export the approvals history without permission` });
    return { ok: false, error: "You can't export the approvals history." };
  }
  const { where: scoped } = await scope(user.id, filters?.whose);
  const where = await whereFor(filters ?? {}, scoped);
  const rows = await db.approvalEvent.findMany({ where, orderBy: { decidedAt: "desc" }, take: EXPORT_CAP });
  const names = await namesOf(rows.flatMap((r) => [r.decidedById, r.requestedById]));
  const clock = await workspaceClock();
  const header = csvRow(["When", "What", "Record", "Decision", "Decided by", "Asked by", "Note", "From the record before the history began"]);
  const body = rows.map((r) =>
    csvRow([
      clock.dateTimeShort(r.decidedAt),
      isApprovalKind(r.kind) ? APPROVAL_KINDS[r.kind] : r.kind,
      r.label,
      APPROVAL_DECISIONS[r.decision as ApprovalDecision] ?? r.decision,
      names.get(r.decidedById) ?? "",
      r.requestedById ? (names.get(r.requestedById) ?? "") : "",
      r.note ?? "",
      r.backfilled ? "Yes" : "",
    ]),
  );
  await logActivity({ kind: "EXPORT", severity: "WARNING", summary: `${user.name} exported ${rows.length.toLocaleString("en-IN")} approval decisions` });
  return { ok: true, data: { csv: [header, ...body].join("\n"), rows: rows.length } };
}
