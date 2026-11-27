import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { notMigratedYet } from "@/lib/not-migrated";
import { byStageDate, salesLeads } from "@/lib/pipeline/server";

/**
 * What brings wins, in Inbox reports (owner, 6 Nov 2026): which pages and campaigns come before leads and wins.
 *
 * Counted honestly, and the page says how: a lead counts for a campaign when that campaign first brought a browser of
 * its contact's before the lead was made or won, and for every page they opened before the win. So a page's wins are
 * "wins that saw this page", not "wins this page caused", and one win can count for several pages. Only visitors who
 * agreed to being remembered are in it, so the figures are a floor, not the whole.
 *
 * The whole business's wins, with their values, so it's for those who see the whole of sales or marketing.
 */

export async function mayReadWebReport(userId: string): Promise<boolean> {
  if (!(await can(userId, "website.activity"))) return false;
  return (await can(userId, "marketing.viewAll")) || (await can(userId, "activity.viewAll"));
}

export type WonLead = { id: string; contactId: string; value: number; wonAt: Date };
export type NewLead = { id: string; contactId: string; createdAt: Date };
export type SeenPage = { host: string; path: string; contactId: string; at: Date };
export type KnownVisitor = { contactId: string; source: string; firstSeenAt: Date };

export type ReportRow = { label: string; visitors: number; known: number; leads: number; won: number; wonValue: number };
export type Traffic = { label: string; visitors: number; known: number; views?: number };

/** Largest wins first, then most visited. */
const byWorth = (a: ReportRow, b: ReportRow) => b.wonValue - a.wonValue || b.won - a.won || b.leads - a.leads || b.visitors - a.visitors || a.label.localeCompare(b.label);

/** A campaign's name, the source that sent them, or "Direct": what a visitor's first arrival is filed under. */
export const sourceLabel = (campaign: string | null | undefined, source: string | null | undefined): string => campaign?.trim() || source?.trim() || "Direct";

/**
 * The arithmetic, with nothing to read. A campaign gets a lead or a win only if it brought them before it happened; a
 * page gets a win only if it was opened before it. Each lead counts once for a row, however many browsers or visits.
 */
export function attribute(input: { sources: Traffic[]; pages: Traffic[]; visitors: KnownVisitor[]; views: SeenPage[]; newLeads: NewLead[]; won: WonLead[] }): { sources: ReportRow[]; pages: ReportRow[] } {
  const row = (t: Traffic): ReportRow => ({ label: t.label, visitors: t.visitors, known: t.known, leads: 0, won: 0, wonValue: 0 });
  const sources = new Map(input.sources.map((t) => [t.label, row(t)]));
  const pages = new Map(input.pages.map((t) => [t.label, row(t)]));
  const blank = (label: string): ReportRow => ({ label, visitors: 0, known: 0, leads: 0, won: 0, wonValue: 0 });

  const visitorsOf = new Map<string, KnownVisitor[]>();
  for (const v of input.visitors) visitorsOf.set(v.contactId, [...(visitorsOf.get(v.contactId) ?? []), v]);
  const viewsOf = new Map<string, SeenPage[]>();
  for (const v of input.views) viewsOf.set(v.contactId, [...(viewsOf.get(v.contactId) ?? []), v]);

  for (const lead of input.newLeads) {
    const labels = new Set((visitorsOf.get(lead.contactId) ?? []).filter((v) => v.firstSeenAt <= lead.createdAt).map((v) => v.source));
    for (const label of labels) {
      const r = sources.get(label) ?? blank(label);
      r.leads += 1;
      sources.set(label, r);
    }
  }
  for (const win of input.won) {
    const labels = new Set((visitorsOf.get(win.contactId) ?? []).filter((v) => v.firstSeenAt <= win.wonAt).map((v) => v.source));
    for (const label of labels) {
      const r = sources.get(label) ?? blank(label);
      r.won += 1;
      r.wonValue += win.value;
      sources.set(label, r);
    }
    const seen = new Set((viewsOf.get(win.contactId) ?? []).filter((v) => v.at <= win.wonAt).map((v) => pageLabel(v.host, v.path)));
    for (const label of seen) {
      const r = pages.get(label) ?? blank(label);
      r.won += 1;
      r.wonValue += win.value;
      pages.set(label, r);
    }
  }
  return { sources: [...sources.values()].sort(byWorth), pages: [...pages.values()].sort(byWorth) };
}

export const pageLabel = (host: string, path: string) => `${host.replace(/^www\./, "")}${path}`;

const MANY = 20_000;

/** The report for a period: what the site brought in it, and the leads and wins that had been on it. */
export async function webActivityReport(days: number, now = new Date()) {
  const from = new Date(now.getTime() - days * 86_400_000);
  const empty = { sources: [] as ReportRow[], pages: [] as ReportRow[], totals: { visitors: 0, known: 0, leads: 0, won: 0, wonValue: 0 } };
  try {
    const sales = await salesLeads();
    const [sourceRows, pageRows] = await Promise.all([
      db.$queryRaw<{ campaign: string | null; source: string | null; visitors: number; known: number }[]>`
        SELECT v."firstCampaign"::text AS campaign, v."firstSource"::text AS source, count(*)::int AS visitors,
               (count(*) FILTER (WHERE v."contactId" IS NOT NULL OR c."contactId" IS NOT NULL))::int AS known
        FROM "web_visitors" v LEFT JOIN "conversations" c ON c."id" = v."conversationId"
        WHERE v."lastSeenAt" >= ${from}
        GROUP BY 1, 2`,
      db.$queryRaw<{ host: string; path: string; views: number; visitors: number; known: number }[]>`
        SELECT p."host"::text AS host, p."path"::text AS path, count(*)::int AS views, count(DISTINCT p."visitorId")::int AS visitors,
               (count(DISTINCT p."visitorId") FILTER (WHERE v."contactId" IS NOT NULL OR c."contactId" IS NOT NULL))::int AS known
        FROM "web_page_views" p JOIN "web_visitors" v ON v."id" = p."visitorId" LEFT JOIN "conversations" c ON c."id" = v."conversationId"
        WHERE p."at" >= ${from}
        GROUP BY 1, 2
        ORDER BY views DESC
        LIMIT 200`,
    ]);

    const knownRows = await db.webVisitor.findMany({
      where: { OR: [{ contactId: { not: null } }, { conversation: { contactId: { not: null } } }] },
      take: MANY,
      orderBy: { lastSeenAt: "desc" },
      select: { firstCampaign: true, firstSource: true, firstSeenAt: true, contactId: true, conversation: { select: { contactId: true } } },
    });
    const visitors: KnownVisitor[] = knownRows.flatMap((v) => {
      const contactId = v.contactId ?? v.conversation?.contactId;
      return contactId ? [{ contactId, source: sourceLabel(v.firstCampaign, v.firstSource), firstSeenAt: v.firstSeenAt }] : [];
    });
    const contactIds = [...new Set(visitors.map((v) => v.contactId))];

    const [created, wonRows] = await Promise.all([
      db.lead.findMany({ where: { createdAt: { gte: from }, contactId: { in: contactIds }, AND: [sales] }, take: MANY, select: { id: true, contactId: true, createdAt: true } }),
      byStageDate((moved) =>
        db.lead.findMany({ where: { status: "WON", contactId: { in: contactIds }, ...moved({ gte: from }), AND: [sales] }, take: MANY, select: { id: true, contactId: true, estimatedValue: true, stageChangedAt: true, updatedAt: true } }),
      ),
    ]);
    const won: WonLead[] = wonRows.flatMap((l) => (l.contactId ? [{ id: l.id, contactId: l.contactId, value: Number(l.estimatedValue ?? 0), wonAt: l.stageChangedAt ?? l.updatedAt }] : []));
    const wonContacts = [...new Set(won.map((w) => w.contactId))];
    const viewRows = wonContacts.length
      ? await db.webPageView.findMany({
          where: { visitor: { OR: [{ contactId: { in: wonContacts } }, { conversation: { contactId: { in: wonContacts } } }] } },
          take: MANY,
          orderBy: { at: "desc" },
          select: { host: true, path: true, at: true, visitor: { select: { contactId: true, conversation: { select: { contactId: true } } } } },
        })
      : [];
    const views: SeenPage[] = viewRows.flatMap((v) => {
      const contactId = v.visitor.contactId ?? v.visitor.conversation?.contactId;
      return contactId ? [{ host: v.host, path: v.path, at: v.at, contactId }] : [];
    });

    // Several campaigns' rows can read the same once labelled: a source with no campaign, say. They're one line.
    const merged = new Map<string, Traffic>();
    for (const r of sourceRows) {
      const label = sourceLabel(r.campaign, r.source);
      const t = merged.get(label) ?? { label, visitors: 0, known: 0 };
      t.visitors += r.visitors;
      t.known += r.known;
      merged.set(label, t);
    }
    const result = attribute({
      sources: [...merged.values()],
      pages: pageRows.map((r) => ({ label: pageLabel(r.host, r.path), visitors: r.visitors, known: r.known, views: r.views })),
      visitors,
      views,
      newLeads: created.flatMap((l) => (l.contactId ? [{ id: l.id, contactId: l.contactId, createdAt: l.createdAt }] : [])),
      won,
    });
    const viewsByPage = new Map(pageRows.map((r) => [pageLabel(r.host, r.path), r.views]));
    return {
      sources: result.sources,
      pages: result.pages.map((p) => ({ ...p, views: viewsByPage.get(p.label) ?? 0 })),
      totals: {
        visitors: sourceRows.reduce((t, r) => t + r.visitors, 0),
        known: sourceRows.reduce((t, r) => t + r.known, 0),
        leads: created.length,
        won: won.length,
        wonValue: won.reduce((t, w) => t + w.value, 0),
      },
    };
  } catch (err) {
    if (notMigratedYet(err)) return empty;
    throw err;
  }
}
