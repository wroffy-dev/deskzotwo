import { db } from "@/lib/db";
import { orderAccess } from "@/lib/authz/access";
import { requireModuleUser } from "@/lib/modules-access";
import { viewerHas } from "@/actions/permission";
import { renewalManagersOf } from "@/lib/companies/renewal-manager";
import { noEndDateWhere } from "@/lib/renewal-watch-rules";

/**
 * Renewals › No end date (owner, 11 Nov 2026): running subscriptions saved without an end date. Every part of the
 * renewal watch reads the end date — the reminders, the escalations, the task raised ahead, Lapsed, and the Renewals
 * list itself — so one without it is watched by nothing and shown nowhere. Listed here until somebody enters the date
 * on its order. Each person sees the ones on orders they may see, as on Renewals.
 */

export type UndatedRow = {
  id: string;
  orderSeq: number;
  company: { name: string; companySeq: number };
  product: string;
  startDate: Date | null;
  addedOn: Date;
  /** Whose renewal it would be: the customer's renewal manager, else its account manager. */
  lookedAfterBy: string | null;
};

async function viewer(): Promise<{ id: string } | null> {
  const user = await requireModuleUser("renewals");
  return (await viewerHas("renewals.view")) ? user : null;
}

/** How many this person can see — for the link on Renewals; nothing where there are none. */
export async function undatedCount(): Promise<number> {
  const user = await viewer();
  if (!user) return 0;
  return db.companyProduct.count({ where: { AND: [noEndDateWhere(), await orderAccess(user.id, "view")] } });
}

/** The first `take` of them, oldest first, and how many there are in all. */
export async function listUndated(take = 200): Promise<{ rows: UndatedRow[]; total: number }> {
  const user = await viewer();
  if (!user) return { rows: [], total: 0 };
  const where = { AND: [noEndDateWhere(), await orderAccess(user.id, "view")] };
  const [found, total] = await Promise.all([
    db.companyProduct.findMany({
      where,
      orderBy: [{ startDate: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
      take,
      select: {
        id: true,
        orderSeq: true,
        startDate: true,
        createdAt: true,
        item: { select: { name: true } },
        company: { select: { id: true, name: true, companySeq: true, owner: { select: { id: true, name: true } } } },
      },
    }),
    db.companyProduct.count({ where }),
  ]);
  const managers = await renewalManagersOf(found.map((r) => r.company));
  return {
    total,
    rows: found.map((r) => ({
      id: r.id,
      orderSeq: r.orderSeq,
      company: { name: r.company.name, companySeq: r.company.companySeq },
      product: r.item.name,
      startDate: r.startDate,
      addedOn: r.createdAt,
      lookedAfterBy: managers.get(r.company.id)?.name ?? null,
    })),
  };
}
