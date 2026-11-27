import Link from "next/link";
import { notFound } from "next/navigation";
import { viewerHas } from "@/actions/permission";
import { listDuplicates } from "@/actions/company-merge";
import { DuplicatesList } from "@/components/companies/duplicates-list";
import { BulkMergeButton } from "@/components/companies/bulk-merge-button";
import { DuplicateGroupsPanel } from "@/components/companies/duplicate-groups-panel";
import { ActionNotice } from "@/components/ui/action-notice";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import type { Metadata } from "next";
import { getWording } from "@/lib/terms/server";
import { slot } from "@/lib/terms/dictionary";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { Pagination } from "@/components/ui/pagination";
import { ToolbarSearch } from "@/components/ui/filter-toolbar";
import { DUPLICATE_GROUPS, GROUP_LABELS, type DuplicateGroup } from "@/lib/companies/duplicate-groups";

export async function generateMetadata(): Promise<Metadata> {
  return { title: slot(await getWording(), "Duplicate companies", "company", "Duplicate {many:lower}") };
}

/**
 * Companies that are probably one company entered twice — the same GSTIN or PAN, the same name once
 * Pvt, Ltd and the like are set aside, a near-identical name, or a shared email domain or phone.
 * See src/lib/companies/duplicates.ts.
 */
export default async function DuplicateCompaniesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!(await isModuleEnabled("companies"))) return <ModuleDisabledNotice moduleKey="companies" />;
  if (!(await viewerHas("companies.merge"))) notFound();
  const params = await searchParams;
  const one = (key: string) => (Array.isArray(params[key]) ? params[key][0] : params[key]) as string | undefined;
  const q = one("q")?.trim() ?? "";
  // Every pair, a page at a time, or only those naming a company searched for (owner, 13 Nov 2026).
  // A group (A–D) and "no orders on either side" narrow it (owner, 14 Nov 2026).
  const result = await listDuplicates({ q, page: resolvePage(one("page")), pageSize: resolvePageSize(one("pageSize")), group: one("group"), noOrders: one("orders") === "none" });
  /** This page's address with `change` applied, back to the first page. */
  const hrefWith = (change: Record<string, string | null>) => {
    const next = new URLSearchParams();
    for (const key of ["q", "pageSize", "group", "orders"]) {
      const value = key in change ? change[key] : one(key);
      if (value) next.set(key, value);
    }
    const query = next.toString();
    return query ? `/companies/duplicates?${query}` : "/companies/duplicates";
  };
  const chip = (on: boolean) =>
    `inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${on ? "border-brand bg-brand-subtle font-medium text-brand" : "border-line text-muted hover:text-text"}`;
  const w = await getWording();
  const companies = slot(w, "companies", "company", "{many:lower}");

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">{slot(w, "Duplicate companies", "company", "Duplicate {many:lower}")}</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Companies that look like one company entered twice. Review a pair to merge it — everything under the duplicate moves to the one you keep,
          and its old links open it — or mark it as not a duplicate and it won&apos;t be offered again.
        </p>
      </div>
      {!result.ok ? (
        <ActionNotice tone="error">{result.error}</ActionNotice>
      ) : (
        <>
          {/* Sorted into groups, the ones sharing a GSTIN merged in the background (owner, 14 Nov 2026). */}
          <DuplicateGroupsPanel />
          <BulkMergeButton count={result.data.bulk} />
          <div className="flex flex-wrap items-center gap-2">
            <ToolbarSearch paramName="q" placeholder="Find a company" label="Find pairs by company name or reference" resetParams={["page"]} className="w-full sm:w-72" />
          </div>
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Show">
            <Link href={hrefWith({ group: null })} className={chip(!result.data.group)}>
              All groups
            </Link>
            {DUPLICATE_GROUPS.map((g: DuplicateGroup) => {
              const c = result.data.counts[g];
              const shown = result.data.noOrders ? c.noOrders : c.all;
              return (
                <Link key={g} href={hrefWith({ group: g })} className={chip(result.data.group === g)} title={GROUP_LABELS[g].detail}>
                  {GROUP_LABELS[g].letter} · {GROUP_LABELS[g].title}
                  <span className="tabular-nums text-subtle">{shown.toLocaleString("en-IN")}</span>
                </Link>
              );
            })}
            <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />
            <Link
              href={hrefWith({ orders: result.data.noOrders ? null : "none" })}
              className={chip(result.data.noOrders)}
              title="Neither company has an order (its own or one bought for it), a sales or purchase document, or a payment"
            >
              {result.data.noOrders ? "✓ " : ""}No orders, invoices or payments on either
            </Link>
          </div>
          <p className="text-xs text-subtle">
            {result.data.total === 0
              ? q
                ? `No pair here names "${q}" — checked ${result.data.scanned.toLocaleString("en-IN")} ${companies}.`
                : `Checked ${result.data.scanned.toLocaleString("en-IN")} ${companies}.`
              : `${result.data.total.toLocaleString("en-IN")} pair${result.data.total === 1 ? "" : "s"}${q ? ` naming "${q}"` : ""} among ${result.data.scanned.toLocaleString("en-IN")} ${companies}, the likeliest first.`}{" "}
            {slot(w, "Only companies of the same kind are compared.", "company", "Only {many:lower} of the same kind are compared.")}{" "}
            <Link href="/companies/merge" className="underline underline-offset-2">
              {slot(w, "Merge two companies by hand", "company", "Merge two {many:lower} by hand")}
            </Link>
          </p>
          <DuplicatesList rows={result.data.rows} />
          {result.data.total > 0 && (
            <Pagination
              page={result.data.page}
              pageSize={result.data.pageSize}
              total={result.data.total}
              totalPages={totalPages(result.data.total, result.data.pageSize)}
              pageSizes={PAGE_SIZES}
              label="pairs"
            />
          )}
        </>
      )}
    </div>
  );
}
