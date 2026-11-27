import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { lastDayToPay } from "@/lib/collect/msme";
import { settleInvoice } from "@/lib/receivables";
import { bookingRate } from "@/lib/ledger/posting";
import type { Clock } from "@/lib/time/zone";
import { documentAccess } from "@/lib/authz/access";
import { workspaceClock } from "@/lib/time/workspace";
import { MSME_SOON_DAYS, heldToLimit, type MsmeBillRow, type MsmeStanding } from "@/lib/payables/msme-rules";

export * from "@/lib/payables/msme-rules";

/**
 * Paying MSME vendors on time (owner, 17 Nov 2026: "build it with the 45 day warning").
 *
 * A vendor registered under Udyam as micro or small is protected by the MSMED Act, 2006:
 *
 *   · s.15: it is paid on the day agreed in writing, never more than 45 days from acceptance of the goods or
 *     services; with nothing agreed, within 15 days. The bill's date stands in for acceptance and its due date for
 *     the day agreed — the same reading as interest we claim from customers (src/lib/collect/msme.ts `lastDayToPay`).
 *   · s.16: past that, compound interest with monthly rests at three times the RBI bank rate is owed to it.
 *   · Income-tax s.43B(h): what is still owed to it past that day isn't an expense for the year until it is paid.
 *
 * A medium enterprise is recorded but not held to the limit — the Act's protection is micro and small only.
 */

const DAY = 86_400_000;

const key = (d: Date) => d.toISOString().slice(0, 10);

/** Where a bill stands against the limit, on the workspace's calendar. */
export function msmeStanding(bill: { issueDate: Date; dueDate: Date | null }, clock: Clock, now: Date = new Date()): MsmeStanding {
  const issued = clock.calendarDate(bill.issueDate);
  const due = bill.dueDate ? clock.calendarDate(bill.dueDate) : null;
  const last = lastDayToPay(issued, due);
  const today = clock.calendarDate(now);
  const daysLeft = Math.round((last.getTime() - today.getTime()) / DAY);
  return {
    payBy: key(last),
    daysLeft,
    state: daysLeft < 0 ? "late" : daysLeft <= MSME_SOON_DAYS ? "soon" : "ok",
    dueBeyondLimit: !!due && due.getTime() > issued.getTime() + 45 * DAY,
    noDueDate: !due,
  };
}

/** A vendor's registration; null when it has none, or the workspace's database hasn't the table yet. */
export async function vendorMsmeOf(companyId: string) {
  return db.vendorMsme
    .findUnique({ where: { companyId }, select: { udyamNumber: true, category: true, updatedAt: true } })
    .catch(() => null);
}

/**
 * The open bills of micro and small vendors, soonest limit first — `access` is the caller's document access fragment,
 * so nobody sees a bill they couldn't open. Empty where the workspace hasn't the table yet.
 */
export async function msmeOpenBills(input: { access: Prisma.TradeDocumentWhereInput; companyId?: string; clock: Clock; now?: Date }): Promise<MsmeBillRow[]> {
  const bills = await db.tradeDocument
    .findMany({
      where: {
        AND: [
          {
            docType: "BILL",
            status: { notIn: ["DRAFT", "CANCELLED", "PAID"] },
            company: { vendorMsme: { category: { in: ["MICRO", "SMALL"] } } },
            ...(input.companyId ? { companyId: input.companyId } : {}),
          },
          input.access,
        ],
      },
      select: {
        id: true,
        docNumber: true,
        issueDate: true,
        dueDate: true,
        total: true,
        currency: true,
        exchangeRate: true,
        paidBefore: true,
        payments: { select: { amount: true } },
        creditsReceived: { select: { amount: true } },
        vendorCredits: { select: { amount: true } },
        company: { select: { id: true, companySeq: true, name: true, vendorMsme: { select: { category: true } } } },
      },
      take: 2000,
    })
    .catch(() => []);

  const sum = (rows: { amount: Prisma.Decimal | number }[]) => rows.reduce((t, r) => t + Number(r.amount), 0);
  const rows: MsmeBillRow[] = [];
  for (const bill of bills) {
    const settled = settleInvoice(Number(bill.total), sum(bill.payments), sum(bill.creditsReceived) + sum(bill.vendorCredits), Number(bill.paidBefore));
    if (settled.balance < 0.01 || !bill.company.vendorMsme) continue;
    rows.push({
      id: bill.id,
      docNumber: bill.docNumber,
      companyId: bill.company.id,
      companySeq: bill.company.companySeq,
      vendorName: bill.company.name,
      category: bill.company.vendorMsme.category,
      issueDate: key(input.clock.calendarDate(bill.issueDate)),
      balance: Math.round(settled.balance * bookingRate(bill) * 100) / 100,
      currency: bill.currency,
      balanceAsWritten: settled.balance,
      ...msmeStanding(bill, input.clock, input.now),
    });
  }
  return rows.sort((a, b) => a.daysLeft - b.daysLeft);
}

/**
 * The vendor page's MSME card: its registration, and — micro or small — its open bills against the limit, those this
 * person may open. Null where the workspace's database hasn't the table yet.
 */
export async function vendorMsmeCardData(companyId: string, userId: string) {
  const [msme, clock, access] = await Promise.all([vendorMsmeOf(companyId), workspaceClock(), documentAccess(userId, "view")]);
  const bills = msme && heldToLimit(msme.category) ? await msmeOpenBills({ access, companyId, clock }) : [];
  return { msme: msme ? { udyamNumber: msme.udyamNumber, category: msme.category } : null, bills };
}
