import { db } from "@/lib/db";
import { lapsedWhere } from "@/lib/renewal-lapse-rules";

/**
 * Tidying old renewals away (owner, 31 Oct 2026: "why showing so old expired renewals? are they of any use?").
 *
 * Subscriptions that ended long ago — most brought across from the old CRM — sit on the Renewals list as "Expired /
 * Not started" for ever: usually they *were* renewed, as a new order that came across on its own, unlinked. This
 * settles every one that ended before a chosen day and that nobody has renewed or marked:
 *
 *   · **Linked** to its renewal where there is one: the same customer's next order of the same product, starting no
 *     earlier than 60 days before it ended nor later than 180 after, not already somebody's renewal. The earliest such, each used once, oldest
 *     first — so a chain of yearly orders links up year to year.
 *   · **Closed** otherwise: Lost, with one note (`TIDY_NOTE`), quietly — nobody is notified, and the renewals report
 *     leaves these out of its rate. A renewal marked by hand (lost, negotiating, on hold) is never touched.
 *
 * Planned first, so the screen can say what will happen before anything does (src/actions/renewal-tidy.ts).
 */

export const TIDY_NOTE = "Ended before Deskzo — closed in the clean-up";
/** How long before a subscription ended its renewal may already have started — an early renewal. */
const EARLY_DAYS = 60;
/** How long after it ended a renewal may start — a late one. An order started later than that is a new purchase. */
const LATE_DAYS = 180;
const DAY = 86_400_000;

export type TidyPlan = {
  /** Each old subscription and the later order that renewed it. */
  links: { fromId: string; toId: string }[];
  /** Old subscriptions with no renewal: closed as Lost. */
  close: string[];
};

export async function planRenewalTidy(endedBefore: Date): Promise<TidyPlan> {
  const old = await db.companyProduct.findMany({
    where: lapsedWhere(endedBefore),
    orderBy: [{ endDate: "asc" }, { orderSeq: "asc" }],
    select: { id: true, companyId: true, itemId: true, endDate: true, startDate: true },
  });
  if (old.length === 0) return { links: [], close: [] };

  // Every order that could be a renewal of one of them: the same customers and products, not already one.
  const successors = await db.companyProduct.findMany({
    where: {
      companyId: { in: [...new Set(old.map((o) => o.companyId))] },
      itemId: { in: [...new Set(old.map((o) => o.itemId))] },
      parentId: null,
      renewedFromId: null,
      startDate: { not: null },
      orderStatus: { notIn: ["CANCELLED", "REJECTED"] },
    },
    orderBy: [{ startDate: "asc" }, { orderSeq: "asc" }],
    select: { id: true, companyId: true, itemId: true, startDate: true },
  });
  const byKey = new Map<string, { id: string; start: number }[]>();
  for (const s of successors) {
    const key = `${s.companyId}:${s.itemId}`;
    const list = byKey.get(key) ?? [];
    list.push({ id: s.id, start: s.startDate!.getTime() });
    byKey.set(key, list);
  }

  const used = new Set<string>();
  const links: TidyPlan["links"] = [];
  const close: string[] = [];
  for (const o of old) {
    const ended = o.endDate!.getTime();
    const began = o.startDate?.getTime() ?? -Infinity;
    const next = (byKey.get(`${o.companyId}:${o.itemId}`) ?? []).find((s) => s.id !== o.id && !used.has(s.id) && s.start >= ended - EARLY_DAYS * DAY && s.start <= ended + LATE_DAYS * DAY && s.start > began);
    if (next) {
      used.add(next.id);
      links.push({ fromId: o.id, toId: next.id });
    } else {
      close.push(o.id);
    }
  }
  return { links, close };
}

/** Carries a plan out, in batches; each change re-checks that the row is still as planned. What was done. */
export async function applyRenewalTidy(plan: TidyPlan, userId: string, now = new Date()): Promise<{ linked: number; closed: number }> {
  let linked = 0;
  let closed = 0;
  for (let i = 0; i < plan.links.length; i += 200) {
    const batch = plan.links.slice(i, i + 200);
    linked += await db.$transaction(async (tx) => {
      let n = 0;
      for (const link of batch) {
        // Still nobody's renewal, and the old one still not renewed (renewedFromId is unique).
        const taken = await tx.companyProduct.count({ where: { renewedFromId: link.fromId } });
        if (taken) continue;
        const { count } = await tx.companyProduct.updateMany({ where: { id: link.toId, renewedFromId: null }, data: { renewedFromId: link.fromId } });
        n += count;
      }
      return n;
    });
  }
  for (let i = 0; i < plan.close.length; i += 500) {
    const ids = plan.close.slice(i, i + 500);
    const { count } = await db.companyProduct.updateMany({
      // Still unmarked and unrenewed — lapsedWhere's own rule, read again now.
      where: { AND: [{ id: { in: ids } }, lapsedWhere(new Date("9999-12-31T00:00:00Z"))] },
      data: { renewalStage: "LOST", renewalStageNote: TIDY_NOTE, renewalStageAt: now, renewalStageById: userId },
    });
    closed += count;
  }
  return { linked, closed };
}
