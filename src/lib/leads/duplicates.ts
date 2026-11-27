import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { formatLeadId } from "@/lib/order-id";
import { listLeadMasker, maskLeadTitle } from "@/lib/leads/masking";

/**
 * Duplicate leads, and taking the extra copies away (owner, 30 Oct 2026 — the old CRM's leads imported through
 * Settings › Import & export › Leads over leads already here). The leads import matches only on Key or Old system ID,
 * so a file without them, or a lead already brought by another road, comes in again as a new lead.
 *
 *   · **A group** is leads at the same company, in the same pipeline, with the same title (case and spacing aside) and
 *     the same contact. The lead in Deskzo first — the lowest LEAD number, as `createdAt` is whatever the file said —
 *     is the one kept; the rest are copies.
 *   · **Only groups an import made**: at least one copy came from an import — "Brought from the old system", or an
 *     old system ID. Two leads somebody typed in alike are theirs to sort out.
 *   · **Only copies nobody has worked on** can be taken away: no activity, task, call, visit, quotation, proposal,
 *     requirement, note, meeting, booking, expense, form entry, card or conversation. The rest are listed to open.
 *   · **Taken away** with the super admin's say-so, group by group: the copy is deleted as the lead delete does
 *     (src/actions/super-admin-delete.ts), its old system ID moved to the kept lead where that has none — so the same
 *     file imported again matches it instead of making the copy again — each written to the audit log.
 */

export type DuplicateLead = {
  id: string;
  leadSeq: number;
  title: string;
  status: string;
  stage: string | null;
  owner: string | null;
  value: string | null;
  createdAt: Date;
  imported: boolean;
  externalId: string | null;
  /** What somebody has done on it; empty, it may be taken away. */
  workedOn: string[];
};

export type DuplicateGroup = {
  key: string;
  company: { id: string; companySeq: number; name: string };
  contact: string | null;
  keep: DuplicateLead;
  copies: DuplicateLead[];
};

const IMPORT_NOTE = "Brought from the old system";

const WORK: [keyof WorkCounts, string][] = [
  ["activities", "activity"],
  ["tasks", "tasks"],
  ["calls", "calls"],
  ["visits", "visits"],
  ["documents", "quotations"],
  ["proposals", "proposals"],
  ["requirements", "products"],
  ["stickyNotes", "notes"],
  ["calendarEvents", "meetings"],
  ["bookings", "bookings"],
  ["expenses", "expenses"],
  ["formSubmissions", "form entries"],
  ["cardContacts", "cards"],
  ["conversations", "conversations"],
  ["carriedOnAs", "carried on as another lead"],
];
type WorkCounts = {
  activities: number;
  tasks: number;
  calls: number;
  visits: number;
  documents: number;
  proposals: number;
  requirements: number;
  stickyNotes: number;
  calendarEvents: number;
  bookings: number;
  expenses: number;
  formSubmissions: number;
  cardContacts: number;
  conversations: number;
  carriedOnAs: number;
};
const COUNT_SELECT = Object.fromEntries(WORK.map(([k]) => [k, true])) as Record<keyof WorkCounts, true>;

const titleKey = (title: string) => title.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Every group of duplicates an import made, worst first.
 *
 * `viewerId`, who is looking: each lead's name, and its company's and contact's names, as their leads policy shows them in
 * a list (owner, 5 Nov 2026 — Phase 3 masking fixes; src/lib/leads/masking.ts) — grouped first, on the real values. The
 * page is the super admin's, who sees every field in the clear; whoever else it opens to sees what a list shows them.
 * Without a viewer, as stored: what the removal itself reads.
 */
export async function findDuplicateLeads(viewerId?: string): Promise<DuplicateGroup[]> {
  const all = await db.lead.findMany({
    select: { id: true, companyId: true, pipelineId: true, contactId: true, title: true, assignmentNote: true, externalId: true },
    orderBy: { leadSeq: "asc" },
  });
  const byKey = new Map<string, typeof all>();
  for (const lead of all) {
    const key = [lead.companyId, lead.pipelineId ?? "", lead.contactId ?? "", titleKey(lead.title)].join("|");
    const list = byKey.get(key);
    if (list) list.push(lead);
    else byKey.set(key, [lead]);
  }
  const isImported = (l: (typeof all)[number]) => Boolean(l.externalId) || (l.assignmentNote ?? "").startsWith(IMPORT_NOTE);
  // In leadSeq order already, so the first is the one in Deskzo first.
  const wanted = [...byKey.entries()].filter(([, list]) => list.length > 1 && list.slice(1).some(isImported));
  if (wanted.length === 0) return [];

  const ids = wanted.flatMap(([, list]) => list.map((l) => l.id));
  const details = new Map<string, DuplicateLead & { company: DuplicateGroup["company"]; contact: string | null }>();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db.lead.findMany({
      where: { id: { in: ids.slice(i, i + 500) } },
      select: {
        id: true,
        leadSeq: true,
        title: true,
        status: true,
        estimatedValue: true,
        createdAt: true,
        assignmentNote: true,
        externalId: true,
        stage: { select: { label: true } },
        owner: { select: { name: true } },
        contact: { select: { name: true } },
        company: { select: { id: true, companySeq: true, name: true } },
        _count: { select: COUNT_SELECT },
      },
    });
    for (const r of rows) {
      details.set(r.id, {
        id: r.id,
        leadSeq: r.leadSeq,
        title: r.title,
        status: r.status,
        stage: r.stage?.label ?? null,
        owner: r.owner?.name ?? null,
        value: r.estimatedValue?.toString() ?? null,
        createdAt: r.createdAt,
        imported: Boolean(r.externalId) || (r.assignmentNote ?? "").startsWith(IMPORT_NOTE),
        externalId: r.externalId,
        workedOn: WORK.filter(([k]) => r._count[k] > 0).map(([k, label]) => `${r._count[k]} ${label}`),
        company: r.company,
        contact: r.contact?.name ?? null,
      });
    }
  }

  const groups: DuplicateGroup[] = [];
  for (const [key, list] of wanted) {
    const [first, ...rest] = list.map((l) => details.get(l.id)).filter((d): d is NonNullable<typeof d> => Boolean(d));
    if (!first || rest.length === 0) continue;
    const strip = (d: typeof first): DuplicateLead => ({
      id: d.id,
      leadSeq: d.leadSeq,
      title: d.title,
      status: d.status,
      stage: d.stage,
      owner: d.owner,
      value: d.value,
      createdAt: d.createdAt,
      imported: d.imported,
      externalId: d.externalId,
      workedOn: d.workedOn,
    });
    groups.push({ key, company: first.company, contact: first.contact, keep: strip(first), copies: rest.map(strip) });
  }
  const sorted = groups.sort((a, b) => b.copies.length - a.copies.length || a.company.name.localeCompare(b.company.name));
  return viewerId ? groupsSeenBy(viewerId, sorted) : sorted;
}

/** The groups as one person sees their leads in a list — see `findDuplicateLeads`. */
async function groupsSeenBy(userId: string, groups: DuplicateGroup[]): Promise<DuplicateGroup[]> {
  const m = await listLeadMasker(userId);
  if (!m.active) return groups;
  const lead = (l: DuplicateLead): DuplicateLead => ({ ...l, title: maskLeadTitle(m, l.title) });
  return groups.map((g) => ({
    ...g,
    // The group's key quotes the name it was grouped on: the lead kept names the group instead.
    key: g.keep.id,
    company: { ...g.company, name: m.present("companyName", g.company.name) ?? "" },
    contact: g.contact === null ? null : m.present("contactName", g.contact),
    keep: lead(g.keep),
    copies: g.copies.map(lead),
  }));
}

export type RemoveResult = { removed: number; kept: number; refused: string[] };

/**
 * Takes away the copies asked for — each only if it is still a copy in a group as `findDuplicateLeads` finds it,
 * not the lead kept, and still nobody has worked on it. One transaction a copy.
 */
export async function removeDuplicateLeads(copyIds: string[], actorId: string): Promise<RemoveResult> {
  const asked = new Set(copyIds);
  const result: RemoveResult = { removed: 0, kept: 0, refused: [] };
  if (asked.size === 0) return result;
  const groups = await findDuplicateLeads();
  for (const group of groups) {
    for (const copy of group.copies) {
      if (!asked.has(copy.id)) continue;
      asked.delete(copy.id);
      if (copy.workedOn.length > 0) {
        result.kept += 1;
        result.refused.push(`${formatLeadId(copy.leadSeq)}: somebody has worked on it (${copy.workedOn.join(", ")}).`);
        continue;
      }
      // The old system ID goes to the kept lead (where it has none), so the same file again matches it.
      const moveId = !group.keep.externalId && copy.externalId ? copy.externalId : null;
      await db.$transaction(async (tx) => {
        await tx.lead.delete({ where: { id: copy.id } });
        if (moveId) {
          await tx.lead.update({ where: { id: group.keep.id }, data: { externalId: moveId } });
          group.keep.externalId = moveId;
        }
      });
      result.removed += 1;
      await recordAudit({
        userId: actorId,
        action: "DELETE",
        entityType: "Lead",
        entityId: copy.id,
        entityLabel: `Deleted duplicate lead ${formatLeadId(copy.leadSeq)} “${copy.title}” — a copy of ${formatLeadId(group.keep.leadSeq)}${moveId ? `, which now carries its old system ID ${moveId}` : ""}`,
        subject: { companyId: group.company.id, leadId: group.keep.id },
      });
    }
  }
  // Anything asked for that isn't a copy any more — already gone, or the lead kept.
  for (const id of asked) {
    result.kept += 1;
    result.refused.push(`One lead (${id}) isn't a duplicate copy any more, so it was left alone.`);
  }
  return result;
}
