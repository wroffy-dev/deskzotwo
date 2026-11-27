import type { Prisma, PrismaClient } from "@prisma/client";
import type { Clock } from "@/lib/time/zone";

/**
 * When a customer became one: their first tax invoice ever (owner, 9 Nov 2026 — "how many new customers by account
 * manager or salesperson, monthly and yearly — the customer should be billed, not just the record added").
 *
 *   · **Billed** is a tax invoice that isn't a draft or cancelled. A credit note later doesn't undo it, and an order not
 *     yet invoiced doesn't make one.
 *   · **Ever** includes the old system's invoices kept under Earlier years (src/lib/migration/archive.ts), less a void
 *     or draft one there: a customer billed in 2024 isn't new because their first Deskzo invoice is this year.
 *   · **Who** is the salesperson on that first invoice, else the customer's account manager. One from the archive names
 *     no salesperson, so the account manager.
 *
 * A customer counts once, in the period their first invoice falls in — so nobody claims the same one twice.
 */
export type FirstBilled = {
  companyId: string;
  companySeq: number;
  name: string;
  /** The first invoice's moment: a Deskzo invoice's issue time, an archived one's day at midnight on the workspace's clock. */
  at: Date;
  number: string;
  /** In the workspace's own currency. */
  value: number;
  userId: string | null;
  /** Whose that is: the invoice's salesperson, or the customer's account manager. */
  creditFrom: "SALESPERSON" | "ACCOUNT_MANAGER";
  fromArchive: boolean;
};

type Range = { gte: Date; lt: Date };
const LIVE = { docType: "INVOICE" as const, status: { notIn: ["DRAFT", "CANCELLED"] as ("DRAFT" | "CANCELLED")[] } };
/** An archived invoice that was a sale: no status, or one that isn't void or a draft. NOT over a null drops it, so an OR. */
const ARCHIVED_SALE = {
  kind: "INVOICE",
  OR: [{ status: null }, { AND: [{ status: { not: null } }, { NOT: { status: { contains: "void", mode: "insensitive" as const } } }, { NOT: { status: { contains: "draft", mode: "insensitive" as const } } }] }],
};

/**
 * What one person may see of the answer (security audit round three, 14 Nov 2026, R3-19): the companies they
 * reach and the invoices their document rule opens. "First ever" is still worked out over every invoice — a
 * customer isn't new to someone just because their older invoice is out of that person's sight — and then a
 * customer is listed only when its company and its first invoice are both visible to them.
 */
export type FirstBilledVisibility = { company: Prisma.CompanyWhereInput; document: Prisma.TradeDocumentWhereInput };

/** Every customer whose first invoice ever falls in the range, newest first. `companyIds` narrows to those. */
export async function firstBilledBetween(db: PrismaClient, range: Range, clock: Clock, companyIds?: string[], visible?: FirstBilledVisibility): Promise<FirstBilled[]> {
  const narrow = companyIds ? { companyId: { in: companyIds } } : {};
  const [live, archived] = await Promise.all([
    db.tradeDocument.groupBy({ by: ["companyId"], where: { ...LIVE, ...narrow }, _min: { issueDate: true } }),
    db.archivedDocument.groupBy({ by: ["companyId"], where: { ...ARCHIVED_SALE, ...(companyIds ? { companyId: { in: companyIds } } : { companyId: { not: null } }) }, _min: { date: true } }),
  ]);
  // An archived day is a calendar day: its first moment on the workspace's clock.
  const dayStart = (d: Date) => clock.midnight(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const earliest = new Map<string, { at: Date; fromArchive: boolean }>();
  for (const r of live) if (r.companyId && r._min.issueDate) earliest.set(r.companyId, { at: r._min.issueDate, fromArchive: false });
  for (const r of archived) {
    if (!r.companyId || !r._min.date) continue;
    const at = dayStart(r._min.date);
    const had = earliest.get(r.companyId);
    if (!had || at < had.at) earliest.set(r.companyId, { at, fromArchive: true });
  }
  const inRange = [...earliest].filter(([, e]) => e.at >= range.gte && e.at < range.lt);
  if (inRange.length === 0) return [];

  const ids = inRange.map(([id]) => id);
  const [companies, firstLive, firstArchived] = await Promise.all([
    db.company.findMany({ where: { id: { in: ids }, ...(visible ? { AND: [visible.company] } : {}) }, select: { id: true, companySeq: true, name: true, ownerUserId: true } }),
    db.tradeDocument.findMany({
      where: { ...LIVE, companyId: { in: inRange.filter(([, e]) => !e.fromArchive).map(([id]) => id) } },
      orderBy: [{ issueDate: "asc" }, { createdAt: "asc" }],
      select: { id: true, companyId: true, issueDate: true, docNumber: true, total: true, exchangeRate: true, salespersonId: true },
    }),
    db.archivedDocument.findMany({
      where: { ...ARCHIVED_SALE, companyId: { in: inRange.filter(([, e]) => e.fromArchive).map(([id]) => id) } },
      orderBy: [{ date: "asc" }, { number: "asc" }],
      select: { companyId: true, date: true, number: true, total: true },
    }),
  ]);
  const company = new Map(companies.map((c) => [c.id, c]));
  const liveFirst = new Map<string, (typeof firstLive)[number]>();
  for (const d of firstLive) if (d.companyId && !liveFirst.has(d.companyId)) liveFirst.set(d.companyId, d);
  // The first invoices this person's document rule opens (R3-19); with no rule given, all of them.
  const openFirsts = visible
    ? new Set((await db.tradeDocument.findMany({ where: { AND: [{ id: { in: [...liveFirst.values()].map((d) => d.id) } }, visible.document] }, select: { id: true } })).map((d) => d.id))
    : null;
  const archivedFirst = new Map<string, (typeof firstArchived)[number]>();
  for (const d of firstArchived) if (d.companyId && !archivedFirst.has(d.companyId)) archivedFirst.set(d.companyId, d);

  const out: FirstBilled[] = [];
  for (const [id, e] of inRange) {
    const c = company.get(id);
    if (!c) continue;
    if (e.fromArchive) {
      const d = archivedFirst.get(id);
      out.push({ companyId: id, companySeq: c.companySeq, name: c.name, at: e.at, number: d?.number ?? "", value: Number(d?.total ?? 0), userId: c.ownerUserId, creditFrom: "ACCOUNT_MANAGER", fromArchive: true });
      continue;
    }
    const d = liveFirst.get(id);
    if (openFirsts && (!d || !openFirsts.has(d.id))) continue;
    out.push({
      companyId: id,
      companySeq: c.companySeq,
      name: c.name,
      at: e.at,
      number: d?.docNumber ?? "",
      value: Math.round(Number(d?.total ?? 0) * (Number(d?.exchangeRate) || 1) * 100) / 100,
      userId: d?.salespersonId ?? c.ownerUserId,
      creditFrom: d?.salespersonId ? "SALESPERSON" : "ACCOUNT_MANAGER",
      fromArchive: false,
    });
  }
  return out.sort((a, b) => b.at.getTime() - a.at.getTime());
}
