import Link from "next/link";
import { CompanyLink } from "@/components/companies/company-link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { newBilledCustomers } from "@/actions/new-customers";
import { Card } from "@/components/ui/card";
import { NewCustomersDownload } from "@/components/performance/new-customers-download";
import { companyPath } from "@/lib/record-links";
import { formatCurrency } from "@/lib/utils";
import { workspaceClock } from "@/lib/time/workspace";

export const metadata = { title: "New customers" };

type Params = { year?: string; person?: string; month?: string };

/**
 * Performance › New customers (owner, 9 Nov 2026): who billed a customer for the first time ever, month by month across
 * a financial year — src/lib/customers/first-billed.ts says what counts. A number opens the customers behind it.
 */
export default async function NewCustomersPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const view = await newBilledCustomers({ year: params.year });
  if (!view) notFound();
  const clock = await workspaceClock();
  const href = (over: Partial<Params>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ year: String(view.year), person: params.person, month: params.month, ...over })) if (v !== undefined && v !== "") q.set(k, v);
    return `/performance/new-customers?${q.toString()}`;
  };
  // A cell, a person's total or a month's total narrows the list below.
  const month = params.month !== undefined && params.month !== "" ? Number(params.month) : null;
  const person = params.person;
  const listed = view.customers.filter((c) => (month === null || c.month === month) && (person === undefined || (c.userId ?? "nobody") === person));
  const narrowed = [person !== undefined ? (view.people.find((p) => (p.userId ?? "nobody") === person)?.name ?? "Nobody") : null, month !== null ? view.months[month] : null].filter(Boolean).join(" · ");
  const cell = (n: number, over: Partial<Params>, current = false) =>
    n === 0 ? (
      <span className="text-subtle">·</span>
    ) : (
      <Link href={href(over)} className={`font-medium tabular-nums hover:underline ${current ? "text-brand" : "text-text"}`}>
        {n}
      </Link>
    );

  return (
    <div className="space-y-5">
      <div>
        <Link href="/performance" className="inline-flex items-center gap-1 text-xs text-muted hover:text-text">
          <ArrowLeft className="h-3.5 w-3.5" /> Performance
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-text">New customers</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Customers billed for the first time ever, by the month of that first tax invoice — the old system&apos;s invoices counted too, so a
          returning customer isn&apos;t new. Credited to the salesperson on that invoice, else the customer&apos;s account manager. Drafts and
          cancelled invoices don&apos;t count; a company only added, or ordered from but not invoiced, isn&apos;t a customer yet.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Link href={href({ year: String(view.year - 1), person: undefined, month: undefined })} className="rounded-full border border-line-strong px-3 py-1 text-muted hover:text-text">
          ← FY {view.year - 1}–{String(view.year).slice(2)}
        </Link>
        <span className="rounded-full border border-brand bg-brand/10 px-3 py-1 font-medium text-brand">{view.label}</span>
        {view.current === null && (
          <Link href={href({ year: String(view.year + 1), person: undefined, month: undefined })} className="rounded-full border border-line-strong px-3 py-1 text-muted hover:text-text">
            FY {view.year + 1}–{String(view.year + 2).slice(2)} →
          </Link>
        )}
        <span className="ml-auto text-muted">
          {view.total.toLocaleString("en-IN")} new customer{view.total === 1 ? "" : "s"} · first invoices {formatCurrency(view.value)}
        </span>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full min-w-[60rem] text-sm">
          <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2">Person</th>
              {view.months.map((m, i) => (
                <th key={m} className={`px-2 py-2 text-right ${view.current === i ? "text-brand" : ""}`}>
                  {m}
                </th>
              ))}
              <th className="px-3 py-2 text-right">Year</th>
              <th className="px-4 py-2 text-right">First invoices</th>
            </tr>
          </thead>
          <tbody>
            {view.people.map((p) => {
              const key = p.userId ?? "nobody";
              return (
                <tr key={key} className={`border-b border-line last:border-0 ${person === key ? "bg-brand/5" : ""}`}>
                  <td className="px-4 py-2 text-text">{p.name}</td>
                  {p.counts.map((n, i) => (
                    <td key={i} className="px-2 py-2 text-right">
                      {cell(n, { person: key, month: String(i) }, view.current === i)}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right">{cell(p.total, { person: key, month: undefined })}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-muted">{formatCurrency(p.value)}</td>
                </tr>
              );
            })}
            {view.people.length === 0 && (
              <tr>
                <td colSpan={15} className="px-4 py-6 text-center text-muted">
                  No customer was billed for the first time in {view.label}.
                </td>
              </tr>
            )}
          </tbody>
          {view.people.length > 0 && (
            <tfoot className="border-t border-line-strong text-sm">
              <tr>
                <td className="px-4 py-2 font-medium text-text">Everyone</td>
                {view.totals.map((n, i) => (
                  <td key={i} className="px-2 py-2 text-right">
                    {cell(n, { person: undefined, month: String(i) }, view.current === i)}
                  </td>
                ))}
                <td className="px-3 py-2 text-right">{cell(view.total, { person: undefined, month: undefined })}</td>
                <td className="px-4 py-2 text-right tabular-nums text-muted">{formatCurrency(view.value)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-text">
          {narrowed ? `${narrowed} — ` : ""}
          {listed.length.toLocaleString("en-IN")} customer{listed.length === 1 ? "" : "s"}
          {narrowed && (
            <Link href={href({ person: undefined, month: undefined })} className="ml-2 text-xs font-normal text-brand hover:underline">
              Show all
            </Link>
          )}
        </h2>
        <NewCustomersDownload rows={listed} label={view.label} />
      </div>
      {listed.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[48rem] text-sm">
            <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2">Customer</th>
                <th className="px-4 py-2">First billed</th>
                <th className="px-4 py-2">Invoice</th>
                <th className="px-4 py-2 text-right">Value</th>
                <th className="px-4 py-2">Credited to</th>
              </tr>
            </thead>
            <tbody>
              {listed.map((c) => (
                <tr key={c.companyId} className="border-b border-line last:border-0">
                  <td className="px-4 py-2">
                    <CompanyLink href={companyPath(c.companySeq)} className="text-brand hover:underline">
                      {c.name}
                    </CompanyLink>
                  </td>
                  <td className="px-4 py-2 text-muted">{clock.date(new Date(c.at))}</td>
                  <td className="px-4 py-2 font-mono text-xs text-muted">
                    {c.number}
                    {c.fromArchive && <span className="ml-1 font-sans text-subtle">(earlier years)</span>}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatCurrency(c.value)}</td>
                  <td className="px-4 py-2 text-muted">
                    {c.person}
                    <span className="ml-1 text-xs text-subtle">{c.creditFrom === "SALESPERSON" ? "salesperson" : "account manager"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
