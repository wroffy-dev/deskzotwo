import Link from "next/link";
import { ChevronRight, LifeBuoy } from "lucide-react";
import { Card } from "@/components/ui/card";

/** One line of what they have: a customer's ticket, a colleague's request, a step, something to approve or answer. */
export type SupportRow = { key: string; href: string; kind: string; title: string; detail?: string; late?: boolean };

/**
 * Support on Today (owner, 25 Nov 2026 — the help desk, phase 2): customers' tickets and colleagues' requests given to
 * this person, in one list, so whoever works both looks in one place. What's late comes first.
 */
export function SupportTodayCard({ rows, more }: { rows: SupportRow[]; more: number }) {
  if (rows.length === 0) return null;
  const late = rows.filter((r) => r.late).length;
  return (
    <Card id="support-today" className="scroll-mt-20 p-4">
      <div className="flex items-center gap-3">
        <span className="text-muted">
          <LifeBuoy aria-hidden="true" className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-text">Support with you</span>
          <span className="block text-xs text-muted">
            {rows.length + more} open
            {late ? <span className="text-danger"> · {late} overdue</span> : null}
          </span>
        </span>
      </div>
      <ul className="mt-3 divide-y divide-line border-t border-line">
        {rows.map((r) => (
          <li key={r.key}>
            <Link href={r.href} className="flex items-start gap-2 py-2.5">
              <span className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${r.late ? "bg-danger-bg text-danger" : "bg-surface-sunken text-muted"}`}>{r.kind}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-text">{r.title}</span>
                {r.detail && <span className="block text-xs text-muted">{r.detail}</span>}
              </span>
              <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-subtle" />
            </Link>
          </li>
        ))}
      </ul>
      {more > 0 && <p className="mt-2 text-xs text-muted">{more} more on their own lists.</p>}
    </Card>
  );
}
