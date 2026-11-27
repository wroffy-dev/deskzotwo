import Link from "next/link";
import { CompanyLink } from "@/components/companies/company-link";
import { ChevronLeft, Download, ListFilter, Store, Tag, UserRound, CalendarClock } from "lucide-react";
import { isModuleEnabled } from "@/actions/module";
import { listAssignableUsers } from "@/actions/company";
import { listElsewhere } from "@/actions/elsewhere";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { ListHeader } from "@/components/ui/list-header";
import { ClearFilters, ToolbarSearch } from "@/components/ui/filter-toolbar";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { RENEW_WINDOWS, categoryLabel } from "@/lib/customers/elsewhere-rules";
import { elsewhereCategoryOptions } from "@/lib/customers/elsewhere-categories";
import { formatMoneyWhole } from "@/lib/currency";
import { formatCalendarDay } from "@/lib/time/zone";
import { companyPath } from "@/lib/record-links";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";

export const metadata = { title: "Installed elsewhere" };

/**
 * Customers › Installed elsewhere (owner, 2 Nov 2026 — src/lib/customers/elsewhere.ts): every customer's noted
 * products from other sellers, the ones this person may see, soonest renewal first — "all Google Workspace renewing
 * before April", "everything xyz reseller sold" — with the same list as an Excel file.
 */
export default async function InstalledElsewherePage({ searchParams }: { searchParams: Promise<{ q?: string; category?: string; from?: string; renews?: string; owner?: string }> }) {
  if (!(await isModuleEnabled("companies"))) return <ModuleDisabledNotice moduleKey="companies" />;
  const params = await searchParams;
  const filters = { q: params.q, category: params.category, from: params.from, renews: params.renews, owner: params.owner };
  const user = await requireUser();
  const [data, people, categories, mayExport] = await Promise.all([listElsewhere(filters), listAssignableUsers(), elsewhereCategoryOptions(), can(user.id, "data.exportCrm")]);
  const query = new URLSearchParams(Object.entries(filters).filter((e): e is [string, string] => !!e[1]));
  const value = data.rows.reduce((sum, r) => sum + (r.yearlyValue === null ? 0 : Number(r.yearlyValue)), 0);
  const daysTo = (iso: string) => Math.round((Date.parse(iso.slice(0, 10)) - Date.parse(data.today)) / 86_400_000);

  return (
    <div className="animate-fade-rise">
      <Link href="/customers" className="mb-2 inline-flex items-center gap-1 text-sm text-muted transition-colors hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden /> Customers
      </Link>
      <ListHeader
        title="Installed elsewhere"
        subtitle={`${data.rows.length} ${data.rows.length === 1 ? "product" : "products"}`}
        search={<ToolbarSearch paramName="q" placeholder="Search" label="Product, seller, customer or note" />}
        filters={
          <>
            <SelectParamFilter variant="pill" icon={<CalendarClock />} paramName="renews" label="Renews" allLabel="Any time" options={RENEW_WINDOWS.map((r) => ({ value: r.key, label: r.label }))} />
            <SelectParamFilter variant="pill" icon={<Tag />} paramName="category" label="Category" allLabel="All" options={categories.map((c) => ({ value: c.key, label: c.name }))} />
            <SelectParamFilter searchable variant="pill" icon={<Store />} paramName="from" label="Bought from" allLabel="Anyone" options={data.sellers.map((s) => ({ value: s, label: s }))} />
            <SelectParamFilter searchable variant="pill" icon={<UserRound />} paramName="owner" label="Account manager" allLabel="Anyone" options={people.map((u) => ({ value: u.id, label: u.name }))} />
            <ClearFilters params={["q", "renews", "category", "from", "owner"]} />
          </>
        }
        actions={
          // Only for those who may take CRM records away as a file (data.exportCrm), as the export itself asks.
          data.rows.length > 0 && mayExport ? (
            <a href={`/api/customers/elsewhere-export?${query}`} className="inline-flex items-center gap-1.5 rounded-base border border-line px-3 py-1.5 text-sm text-text transition-colors hover:border-brand hover:text-brand">
              <Download className="h-4 w-4" aria-hidden /> Excel
            </a>
          ) : undefined
        }
      />
      <p className="mt-1 text-sm text-muted">
        What your customers use that they didn&apos;t buy from you — each a renewal to win.
        {value > 0 && <> Noted value: {formatMoneyWhole(value)} a year.</>}
      </p>

      <Card className="mt-4">
        <CardContent className="p-0">
          {!data.ready ? (
            <p className="px-4 py-8 text-center text-sm text-subtle">This workspace can keep these after its next update.</p>
          ) : data.rows.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-subtle">
              <ListFilter className="mx-auto mb-2 h-5 w-5" />
              Nothing here{query.size ? " for these filters" : " yet"}. Add what a customer uses from the &ldquo;Installed elsewhere&rdquo; tab on their page.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-4 py-2.5">Customer</th>
                    <th className="px-4 py-2.5">Product</th>
                    <th className="px-4 py-2.5">Qty</th>
                    <th className="px-4 py-2.5">Bought from</th>
                    <th className="px-4 py-2.5">Renews</th>
                    <th className="px-4 py-2.5">A year</th>
                    <th className="px-4 py-2.5">Account manager</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => {
                    const renews = r.renewsOn ? String(r.renewsOn) : null;
                    const days = renews ? daysTo(renews) : null;
                    return (
                      <tr key={r.id} className="border-b border-line align-top last:border-0 hover:bg-surface-sunken">
                        <td className="px-4 py-2.5">
                          <CompanyLink href={`${companyPath(r.company.companySeq)}?tab=elsewhere`} className="font-medium text-text hover:underline">
                            {r.company.name}
                          </CompanyLink>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="text-text">{r.productName}</span>
                          {r.category && <span className="block text-[11px] text-subtle">{categoryLabel(r.category, categories)}</span>}
                        </td>
                        <td className="px-4 py-2.5 text-muted">{r.quantity ?? "—"}</td>
                        <td className="px-4 py-2.5 text-muted">{r.boughtFrom ?? "—"}</td>
                        <td className="px-4 py-2.5 text-muted">
                          {formatCalendarDay(r.renewsOn)}
                          {days !== null && days >= 0 && days <= 90 && (
                            <span className="mt-0.5 block">
                              <Badge tone="amber">{days === 0 ? "Today" : `In ${days} day${days === 1 ? "" : "s"}`}</Badge>
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-muted">{r.yearlyValue === null ? "—" : formatMoneyWhole(Number(r.yearlyValue))}</td>
                        <td className="px-4 py-2.5 text-muted">{r.company.owner?.name ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
