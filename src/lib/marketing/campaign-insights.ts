import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { baseCurrency } from "@/lib/currency";
import { mailboxProvider } from "@/lib/marketing/spam-check";

/**
 * The deeper campaign report (owner, 1 Nov 2026): how each mailbox provider took it, what the companies that
 * clicked went on to buy, and the workspace's own usual rates to hold it against. The rules are in
 * src/lib/marketing/report-rules.ts.
 *
 * Revenue is counted the cautious way: sales invoices issued to a company within 30 days after somebody there first
 * clicked this campaign — a sign the email helped, not proof it made the sale. Credit notes take theirs back.
 */

const DAY = 24 * 60 * 60 * 1000;
export const REVENUE_WINDOW_DAYS = 30;
const GONE = ["SENT", "DELIVERED", "OPENED", "CLICKED", "BOUNCED", "COMPLAINED"] as const;

export type ProviderRow = { provider: string; sent: number; opened: number; clicked: number; bounced: number };

export async function providerBreakdown(campaignId: string): Promise<ProviderRow[]> {
  const [messages, events] = await Promise.all([
    db.marketingMessage.findMany({ where: { campaignId, status: { in: [...GONE] } }, select: { id: true, toEmail: true, status: true } }),
    db.messageEvent.findMany({ where: { message: { campaignId }, type: { in: ["OPEN", "CLICK"] } }, select: { messageId: true, type: true } }),
  ]);
  const opened = new Set(events.map((e) => e.messageId));
  const clicked = new Set(events.filter((e) => e.type === "CLICK").map((e) => e.messageId));
  const rows = new Map<string, ProviderRow>();
  for (const m of messages) {
    const provider = mailboxProvider(m.toEmail);
    const r = rows.get(provider) ?? { provider, sent: 0, opened: 0, clicked: 0, bounced: 0 };
    r.sent++;
    if (opened.has(m.id)) r.opened++;
    if (clicked.has(m.id)) r.clicked++;
    if (m.status === "BOUNCED" || m.status === "COMPLAINED") r.bounced++;
    rows.set(provider, r);
  }
  return [...rows.values()].sort((a, b) => b.sent - a.sent);
}

export type CampaignRevenue = { amount: number; invoices: number; companies: number; currency: string };

export async function campaignRevenue(campaignId: string): Promise<CampaignRevenue> {
  const base = baseCurrency();
  // Each clicking company's first click on this campaign.
  const firsts = await db.$queryRaw<{ companyId: string; first: Date }[]>`
    SELECT m."companyId", MIN(e."occurredAt") AS first
    FROM "marketing_message_events" e JOIN "marketing_messages" m ON m."id" = e."messageId"
    WHERE m."campaignId" = ${campaignId} AND e."type"::text = 'CLICK'
    GROUP BY m."companyId"`;
  if (!firsts.length) return { amount: 0, invoices: 0, companies: 0, currency: base };
  const pairs = Prisma.join(firsts.map((f) => Prisma.sql`(${f.companyId}, ${f.first}::timestamp)`));
  const rows = await db.$queryRaw<{ amount: Prisma.Decimal | null; invoices: number; companies: number }[]>`
    SELECT SUM((CASE WHEN d."docType"::text = 'CREDIT_NOTE' THEN -1 ELSE 1 END) * d."total"
             * (CASE WHEN d."currency" IS NULL OR d."currency" = ${base} THEN 1 ELSE COALESCE(NULLIF(d."exchangeRate", 0), 1) END)) AS amount,
           COUNT(*) FILTER (WHERE d."docType"::text = 'INVOICE')::int AS invoices,
           COUNT(DISTINCT d."companyId") FILTER (WHERE d."docType"::text = 'INVOICE')::int AS companies
    FROM "trade_documents" d
    JOIN (VALUES ${pairs}) AS c("companyId", "first") ON c."companyId" = d."companyId"
    WHERE d."direction"::text = 'SALES' AND d."docType"::text IN ('INVOICE', 'CREDIT_NOTE')
      AND d."status"::text IN ('ISSUED', 'ACCEPTED', 'PARTIALLY_PAID', 'PAID')
      AND d."issueDate" >= date_trunc('day', c."first") AND d."issueDate" < c."first" + make_interval(days => ${REVENUE_WINDOW_DAYS})`;
  const r = rows[0];
  return { amount: Math.round(Number(r?.amount ?? 0) * 100) / 100, invoices: r?.invoices ?? 0, companies: r?.companies ?? 0, currency: base };
}

export type OwnAverage = { open: number | null; click: number | null; unsubscribe: number | null; campaigns: number };

/** The workspace's own rates over its last ten finished campaigns before this one — its truest benchmark. */
export async function ownAverage(campaignId: string, before: Date): Promise<OwnAverage> {
  const recent = await db.campaign.findMany({
    where: { id: { not: campaignId }, status: "SENT", createdAt: { lt: before, gte: new Date(before.getTime() - 365 * DAY) } },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true },
  });
  if (!recent.length) return { open: null, click: null, unsubscribe: null, campaigns: 0 };
  const ids = recent.map((c) => c.id);
  const [sent, opened, clicked, unsubscribed] = await Promise.all([
    db.marketingMessage.count({ where: { campaignId: { in: ids }, status: { in: [...GONE] } } }),
    db.messageEvent.findMany({ where: { message: { campaignId: { in: ids } }, type: { in: ["OPEN", "CLICK"] } }, distinct: ["messageId"], select: { messageId: true } }),
    db.messageEvent.findMany({ where: { message: { campaignId: { in: ids } }, type: "CLICK" }, distinct: ["messageId"], select: { messageId: true } }),
    db.messageEvent.count({ where: { message: { campaignId: { in: ids } }, type: "UNSUBSCRIBE" } }),
  ]);
  if (!sent) return { open: null, click: null, unsubscribe: null, campaigns: recent.length };
  return { open: opened.length / sent, click: clicked.length / sent, unsubscribe: unsubscribed / sent, campaigns: recent.length };
}
