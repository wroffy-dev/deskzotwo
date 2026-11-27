import Link from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { ServiceRenewsButtons } from "@/components/renewals/service-renews-buttons";
import { listUnwatchedServices } from "@/lib/renewals-unwatched";
import { formatCalendarDay } from "@/lib/time/zone";

export const metadata = { title: "Services not watched for renewal" };

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Items › Services that renew (owner, 11 Nov 2026 — src/lib/renewals-unwatched-rules.ts): services that look as if they renew,
 * an AMC say, and aren't managed as a subscription — so nothing reminds anybody when one is about to end. Each is
 * answered once: watch it, or it doesn't renew. Under Items, as the answer changes the item; Renewals links here.
 */
export default async function RenewalsNotWatchedPage() {
  // An Items page: the answer changes the item, so whoever opens Items gives it. It needs Renewals too, to mean anything.
  if (!(await isModuleEnabled("items"))) return <ModuleDisabledNotice moduleKey="items" />;
  if (!(await isModuleEnabled("renewals"))) return <ModuleDisabledNotice moduleKey="renewals" />;
  const services = await listUnwatchedServices();
  return (
    <div className="animate-fade-rise space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-text">Services not watched for renewal</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Renewals reminds people about items managed as a subscription. These services look as if they renew too — an AMC, a yearly support contract —
          but aren&apos;t, so nobody is reminded before one ends. Choose <strong className="font-medium text-text">Watch for renewal</strong> and its
          orders with an end date come up in Renewals from then on, with the same reminders. Choose{" "}
          <strong className="font-medium text-text">It doesn&apos;t renew</strong> for one that is sold once, and it won&apos;t be asked about again.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Link href="/renewals" className="rounded-full border border-line-strong bg-surface px-3 py-1 text-sm text-muted transition-colors hover:text-text">
          Renewals
        </Link>
        <Link href="/items" className="rounded-full border border-line-strong bg-surface px-3 py-1 text-sm text-muted transition-colors hover:text-text">
          Items
        </Link>
      </div>

      {services.length === 0 ? (
        <p className="rounded-2xl border border-line bg-surface p-6 text-sm text-muted">No service looks as if it renews without being watched.</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Service</th>
                <th className="px-4 py-2.5 font-medium">Why it looks as if it renews</th>
                <th className="px-4 py-2.5 font-medium">Next to end</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {services.map((s) => (
                <tr key={s.id}>
                  <td className="px-4 py-2.5">
                    <span className="font-medium text-text">{s.name}</span>
                    {s.sku && <span className="block text-xs text-subtle">{s.sku}</span>}
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {s.byName
                      ? "Its name says so, and it has been sold lately. No order of it has an end date yet."
                      : [s.running > 0 ? `${count(s.running, "order has", "orders have")} a term running now` : null, s.ended > 0 ? `${count(s.ended, "order's term", "orders' terms")} ended in the last year` : null]
                          .filter(Boolean)
                          .join("; ")}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-muted">{s.nextEnd ? formatCalendarDay(s.nextEnd) : "—"}</td>
                  <td className="px-4 py-2.5"><ServiceRenewsButtons itemId={s.id} name={s.name} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
