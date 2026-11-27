import Link from "next/link";
import { CompanyLink } from "@/components/companies/company-link";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listUndated } from "@/lib/renewals-undated";
import { formatOrderId } from "@/lib/order-id";
import { companyPath, orderPath } from "@/lib/record-links";
import { formatCalendarDay } from "@/lib/time/zone";

export const metadata = { title: "Subscriptions with no end date" };

/**
 * Renewals › No end date (owner, 11 Nov 2026 — src/lib/renewals-undated.ts): running subscriptions nothing can remind
 * anybody about, because every reminder counts back from an end date they don't have. Each opens its order, where the
 * date is entered; it leaves this list, and joins Renewals, the moment it has one.
 */
export default async function RenewalsNoEndDatePage() {
  if (!(await isModuleEnabled("renewals"))) return <ModuleDisabledNotice moduleKey="renewals" />;
  const { rows, total } = await listUndated();
  return (
    <div className="animate-fade-rise space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-text">Subscriptions with no end date</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Renewal reminders, the renewal task and the Renewals list all work from a subscription&apos;s end date. These have none, so nobody is reminded to
          renew them and they aren&apos;t on Renewals. Open each order and enter when its term ends.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Link href="/renewals" className="rounded-full border border-line-strong bg-surface px-3 py-1 text-sm text-muted transition-colors hover:text-text">
          Renewals
        </Link>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-2xl border border-line bg-surface p-6 text-sm text-muted">Every running subscription you can see has an end date.</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Order</th>
                <th className="px-4 py-2.5 font-medium">Customer</th>
                <th className="px-4 py-2.5 font-medium">Subscription</th>
                <th className="px-4 py-2.5 font-medium">Started</th>
                <th className="px-4 py-2.5 font-medium">Looked after by</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap px-4 py-2.5 text-text">{formatOrderId(r.orderSeq)}</td>
                  <td className="px-4 py-2.5">
                    <CompanyLink href={companyPath(r.company.companySeq)} className="text-text hover:underline">
                      {r.company.name}
                    </CompanyLink>
                  </td>
                  <td className="px-4 py-2.5 text-text">{r.product}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-muted">{r.startDate ? formatCalendarDay(r.startDate) : `Added ${formatCalendarDay(r.addedOn)}`}</td>
                  <td className="px-4 py-2.5 text-muted">{r.lookedAfterBy ?? "Nobody"}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right">
                    <Link href={orderPath(r.orderSeq)} className="font-medium text-brand hover:underline">
                      Open the order
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {total > rows.length && (
            <p className="border-t border-line px-4 py-2.5 text-xs text-subtle">
              Showing the first {rows.length} of {total}. The rest appear as these get their end dates.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
