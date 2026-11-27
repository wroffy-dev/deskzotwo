import Link from "next/link";
import { itemServicePlan, listCycles, type CycleRow } from "@/actions/service-cycles";
import { ItemServicePlanPicker } from "@/components/service-cycles/item-service-plan-picker";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatCalendarDay } from "@/lib/time/zone";

/**
 * Service cycles where they're met (owner, 9 Nov 2026 — src/actions/service-cycles.ts): a customer's cycles, an order's,
 * and the plan an item's orders start. Each shows nothing to somebody who can't see cycles, or with Tasks switched off.
 */

const STATUS_WORDS = { ACTIVE: "Running", STOPPED: "Stopped", ENDED: "Ended" } as const;

function CycleList({ rows }: { rows: CycleRow[] }) {
  return (
    <ul className="divide-y divide-line">
      {rows.map((c) => (
        <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
          <div className="min-w-0">
            <Link href={`/service-cycles/${c.seq}`} className="font-medium text-brand hover:underline">{c.templateName}</Link>
            <div className="text-xs text-muted">
              {formatCalendarDay(c.start)} to {formatCalendarDay(c.end)} · {c.progress.done} of {c.progress.total} done{c.owner ? ` · ${c.owner.name}` : ""}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {c.progress.overdue > 0 && <Badge tone="red">{c.progress.overdue} overdue</Badge>}
            <Badge tone={c.status === "ACTIVE" ? "green" : "default"}>{STATUS_WORDS[c.status]}</Badge>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Whoever runs cycles, with no plan yet, is pointed at making one rather than shown nothing (owner, 9 Nov 2026). */
const NoPlanYet = () => (
  <p className="text-sm text-muted">
    No plan yet. <Link href="/service-cycles/templates/new" className="text-brand hover:underline">Make one</Link>: the steps a contract promises and how often each comes round.
  </p>
);

/** On a customer's page: their cycles, and starting one. Nothing for somebody who neither has cycles to see nor runs them. */
export async function CompanyServiceCycles({ companyId }: { companyId: string }) {
  const data = await listCycles({ companyId }).catch(() => null);
  if (!data) return null;
  const mayStart = data.mayManage && data.plansInUse > 0;
  if (data.rows.length === 0 && !data.mayManage) return null;
  return (
    <Card>
      <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
        Service cycles
        {mayStart && (
          <Link href={`/service-cycles/new?companyId=${encodeURIComponent(companyId)}`} className="text-xs font-normal text-brand hover:underline">
            Start one
          </Link>
        )}
      </CardHeader>
      <CardContent>{data.rows.length ? <CycleList rows={data.rows} /> : mayStart ? <p className="text-sm text-muted">None yet.</p> : <NoPlanYet />}</CardContent>
    </Card>
  );
}

/** On an order's page: the cycle it started, or starting one for it. */
export async function OrderServiceCycles({ orderId, companyId, closed }: { orderId: string; companyId: string; closed: boolean }) {
  const data = await listCycles({ orderId }).catch(() => null);
  if (!data) return null;
  const mayStart = data.mayManage && data.plansInUse > 0 && !closed;
  if (data.rows.length === 0 && (!data.mayManage || closed)) return null;
  return (
    <Card>
      <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
        Service cycle
        {mayStart && data.rows.length === 0 && (
          <Link href={`/service-cycles/new?companyId=${encodeURIComponent(companyId)}&orderId=${encodeURIComponent(orderId)}`} className="text-xs font-normal text-brand hover:underline">
            Start one for this order
          </Link>
        )}
      </CardHeader>
      <CardContent>
        {data.rows.length ? (
          <CycleList rows={data.rows} />
        ) : mayStart ? (
          <p className="text-sm text-muted">None. An item with a service plan starts one by itself when its order is approved.</p>
        ) : (
          <NoPlanYet />
        )}
      </CardContent>
    </Card>
  );
}

/** On an item's page: the plan its approved orders start. */
export async function ItemServicePlanCard({ itemId }: { itemId: string }) {
  const data = await itemServicePlan(itemId).catch(() => null);
  if (!data || (!data.templateId && !data.mayManage)) return null;
  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Service plan</CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-muted">When an order for this item is approved, this plan&apos;s cycle starts for the customer, with the order&apos;s dates.</p>
        {data.mayManage && data.templates.length === 0 && !data.templateId ? (
          <NoPlanYet />
        ) : data.mayManage ? (
          <ItemServicePlanPicker itemId={itemId} templateId={data.templateId} templates={data.templates} />
        ) : (
          <p className="font-medium text-text">{data.templateName}</p>
        )}
      </CardContent>
    </Card>
  );
}
