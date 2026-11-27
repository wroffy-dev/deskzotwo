import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatMoneyWhole } from "@/lib/currency";
import { renewalRate, spanSince, TIER_LABEL, TIER_TONE, type LoyaltyTier } from "@/lib/customers/loyalty-rules";
import type { HistoryColumn } from "@/lib/customers/history-columns";
import type { CustomerHistory } from "@/lib/customers/stats";

/**
 * A customer's history with us, as the lists' cells and the company page's card say it (owner, 31 Oct 2026 —
 * src/lib/customers/stats.ts). No hooks, so both the client table and the server page draw it. "—" for no row: a
 * company that hasn't bought, or a workspace not migrated yet.
 */

const day = (iso: string) => new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(new Date(iso));
const Dash = () => <span className="text-subtle">—</span>;

export function LoyaltyBadge({ tier }: { tier: LoyaltyTier | null | undefined }) {
  if (!tier) return <Dash />;
  return <Badge tone={TIER_TONE[tier]}>{TIER_LABEL[tier]}</Badge>;
}

/** Up or down on the 12 months before, as a percentage; "new" where there was nothing before. */
function trend(h: CustomerHistory) {
  if (h.prev12Value <= 0) return h.last12Value > 0 ? <span className="text-success">new</span> : null;
  const pct = Math.round(((h.last12Value - h.prev12Value) / h.prev12Value) * 100);
  if (pct === 0) return <span className="text-subtle">level</span>;
  return pct > 0 ? <span className="text-success">▲ {pct}%</span> : <span className="text-danger">▼ {Math.abs(pct)}%</span>;
}

/** One column's cell contents. */
export function HistoryValue({ column, history }: { column: HistoryColumn; history: CustomerHistory | null | undefined }) {
  const h = history;
  if (!h) return <Dash />;
  const money = (v: number) => formatMoneyWhole(v, h.currency);
  switch (column) {
    case "customerSince":
      return h.firstOrderAt ? (
        <span title={`${spanSince(h.firstOrderAt)} a customer`}>
          {day(h.firstOrderAt)} <span className="text-subtle">· {spanSince(h.firstOrderAt)}</span>
        </span>
      ) : (
        <Dash />
      );
    case "lifetimeValue":
      return <span className="tabular-nums">{money(h.lifetimeValue)}</span>;
    case "last12":
      return (
        <span className="tabular-nums" title={`The 12 months before: ${money(h.prev12Value)}`}>
          {money(h.last12Value)} {trend(h)}
        </span>
      );
    case "orderHistory":
      return (
        <span>
          {h.orders} <span className="text-subtle">· {h.liveSubscriptions} live</span>
        </span>
      );
    case "lastPurchase":
      return h.lastPurchaseAt ? (
        <span>
          {day(h.lastPurchaseAt)} <span className="text-subtle">· {spanSince(h.lastPurchaseAt) === "today" ? "today" : `${spanSince(h.lastPurchaseAt)} ago`}</span>
        </span>
      ) : (
        <Dash />
      );
    case "renewalRate": {
      const rate = renewalRate(h);
      return rate === null ? (
        <span className="text-subtle">None due yet</span>
      ) : (
        <span>
          {Math.round(rate * 100)}% <span className="text-subtle">({h.renewalsRenewed} of {h.renewalsDue})</span>
        </span>
      );
    }
    case "paysIn":
      return (
        <span>
          {h.avgDaysToPay === null ? <span className="text-subtle">—</span> : `${h.avgDaysToPay} day${h.avgDaysToPay === 1 ? "" : "s"}`}
          {h.overdue > 0 && <span className="text-danger"> · {money(h.overdue)} overdue</span>}
        </span>
      );
    case "products":
      return <span>{h.productCount}</span>;
    case "loyalty":
      return <LoyaltyBadge tier={h.tier} />;
  }
}

const CARD_ROWS: { column: HistoryColumn; label: string }[] = [
  { column: "customerSince", label: "Customer since" },
  { column: "lifetimeValue", label: "Lifetime value" },
  { column: "last12", label: "Last 12 months" },
  { column: "orderHistory", label: "Orders" },
  { column: "lastPurchase", label: "Last purchase" },
  { column: "renewalRate", label: "Renewal rate" },
  { column: "paysIn", label: "Pays in" },
  { column: "products", label: "Products" },
];

/** The company page's "History with us" card: the same figures and the tier. */
export function HistoryCard({ history }: { history: CustomerHistory }) {
  return (
    <Card>
      <CardHeader className="flex items-center justify-between gap-2 text-sm font-medium text-text">
        <span>History with us</span>
        <LoyaltyBadge tier={history.tier} />
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {CARD_ROWS.map((r) => (
            <div key={r.column} className="flex justify-between gap-3">
              <dt className="text-muted">{r.label}</dt>
              <dd className="text-right text-text">
                <HistoryValue column={r.column} history={history} />
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-subtle">
          Worked out {new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(history.computedAt))} — once a day.
        </p>
      </CardContent>
    </Card>
  );
}
