import { Globe } from "lucide-react";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { NETWORK_LABELS, durationText, onSiteNow } from "@/lib/inbox/activity-rules";
import { countryName } from "@/lib/inbox/visitor";
import type { Clock } from "@/lib/time/zone";

/**
 * Website activity's pieces (owner, 6 Nov 2026; src/lib/inbox/activity.ts): how a visitor was seen, and their journey —
 * visit by visit, page by page. On a lead's page, and in the inbox (src/components/inbox/visitors-tab.tsx).
 */

type Who = { id: string; name: string; company: { id: string; companySeq: number; name: string } } | null;
export type VisitorFacts = {
  ipAddress: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  isp: string | null;
  networkKind: string | null;
  deviceKind: string | null;
  browser: string | null;
  screen: string | null;
  language: string | null;
  timezone: string | null;
  firstSource: string | null;
  firstCampaign: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  visits: number;
  pageCount: number;
  identifiedBy: string | null;
  contact: Who;
  conversation: { contact: Who; customerName: string | null; customerCompany: string | null } | null;
};
type View = { id: string; host: string; path: string; title: string | null; referrerHost: string | null; utmSource: string | null; utmCampaign: string | null; durationSec: number | null; ipAddress: string | null; city: string | null; isp: string | null; networkKind: string | null; at: Date };
export type Journey = { visitNo: number; startedAt: Date; views: View[] }[];

export const whereOf = (v: { city: string | null; region: string | null; country: string | null }) => [v.city, v.region, countryName(v.country)].filter(Boolean).join(", ") || null;

/** What's known of a visitor, as label and value. */
export function Facts({ v, oneColumn = false }: { v: VisitorFacts; oneColumn?: boolean }) {
  const rows: [string, string | null][] = [
    ["Location", whereOf(v)],
    ["IP address", v.ipAddress],
    ["ISP", v.isp],
    ["Network", v.networkKind ? `${NETWORK_LABELS[v.networkKind] ?? v.networkKind} (best guess)` : null],
    ["Device", v.deviceKind ? v.deviceKind[0]!.toUpperCase() + v.deviceKind.slice(1) : null],
    ["Browser", v.browser],
    ["Screen", v.screen],
    ["Language", v.language],
    ["Time zone", v.timezone],
    ["First came from", [v.firstSource, v.firstCampaign].filter(Boolean).join(" · ") || "Direct"],
  ];
  return (
    <dl className={oneColumn ? "space-y-1 text-xs" : "grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2"}>
      {rows
        .filter(([, value]) => value)
        .map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3">
            <dt className="text-muted">{label}</dt>
            <dd className="min-w-0 break-words text-right text-text">{value}</dd>
          </div>
        ))}
    </dl>
  );
}

/** The visits, newest first, and each one's pages in the order they went, with how long and where from. */
export function JourneyList({ journey, clock }: { journey: Journey; clock: Pick<Clock, "dateTimeShort"> }) {
  return (
    <ol className="space-y-3">
      {journey.map((visit) => {
        const first = visit.views[0];
        const from = first?.utmSource ?? first?.referrerHost;
        const network = first?.isp ?? (first?.networkKind ? NETWORK_LABELS[first.networkKind] : null);
        return (
          <li key={visit.visitNo}>
            <p className="text-xs font-medium text-text" suppressHydrationWarning>
              Visit {visit.visitNo} · {clock.dateTimeShort(visit.startedAt)}
              <span className="font-normal text-muted">
                {from ? ` · from ${from}` : ""}
                {first?.utmCampaign ? ` (${first.utmCampaign})` : ""}
                {first?.city ? ` · ${first.city}` : ""}
                {network ? ` · ${network}` : ""}
              </span>
            </p>
            <ul className="mt-1 space-y-0.5 border-l-2 border-line pl-3">
              {visit.views.map((view) => (
                <li key={view.id} className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
                  <span className="min-w-0 break-all text-text" title={view.host}>
                    {view.title ? `${view.title} ` : ""}
                    <span className="text-muted">{view.path}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-subtle" suppressHydrationWarning>
                    {clock.dateTimeShort(view.at).split(", ").pop()}
                    {view.durationSec !== null ? ` · ${durationText(view.durationSec)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ol>
  );
}

/** On a lead's page: their visits, how they were seen, and the journey of the latest browser. */
export function LeadWebActivity({ activity, clock }: { activity: { visitors: VisitorFacts[]; journey: Journey; pages: number; visits: number }; clock: Clock }) {
  const latest = activity.visitors[0]!;
  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
        <span className="inline-flex items-center gap-1.5">
          <Globe className="h-4 w-4 text-subtle" aria-hidden />
          Website activity
        </span>
        {onSiteNow(latest.lastSeenAt) && <Badge tone="green">On the site now</Badge>}
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted">
          {activity.visits} visit{activity.visits === 1 ? "" : "s"}, {activity.pages} page{activity.pages === 1 ? "" : "s"} · last seen {clock.dateTimeShort(latest.lastSeenAt)}
        </p>
        <Facts v={latest} />
        <JourneyList journey={activity.journey} clock={clock} />
      </CardContent>
    </Card>
  );
}
