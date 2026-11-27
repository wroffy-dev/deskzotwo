import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { isModuleEnabled } from "@/actions/module";
import { viewerHas } from "@/actions/permission";
import { AlsoCustomersTable } from "@/components/companies/also-customers-table";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { ListHeader } from "@/components/ui/list-header";
import { companyScope } from "@/lib/authz/company-scope";
import { vendorsMarkedAsCustomers } from "@/lib/companies/also-customers";
import { requireUser } from "@/lib/session";

export const metadata = { title: "Vendors marked as customers" };

/**
 * Vendors › Marked as customers (owner, 5 Nov 2026 — src/lib/companies/also-customers.ts): every vendor on the Customer
 * list because it's marked "Also a customer", whether it has ever been sold to, and the ones that haven't taken off together.
 * For whoever may change a company's role (`companies.changeRole`).
 */
export default async function VendorsMarkedAsCustomersPage() {
  if (!(await isModuleEnabled("vendors"))) return <ModuleDisabledNotice moduleKey="vendors" />;
  if (!(await viewerHas("companies.changeRole"))) notFound();
  const user = await requireUser();
  const rows = await vendorsMarkedAsCustomers(await companyScope(user.id));
  const noSales = rows.filter((r) => r.noSales).length;

  return (
    <div className="animate-fade-rise">
      <Link href="/vendors" className="mb-2 inline-flex items-center gap-1 text-sm text-muted transition-colors hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden /> Vendors
      </Link>
      <ListHeader title="Vendors marked as customers" subtitle={`${rows.length} ${rows.length === 1 ? "vendor" : "vendors"} · ${noSales} with no sales`} />
      <p className="mt-2 text-sm text-muted">
        These show on the Customer list, and anybody who can see customers can see them. The Zoho import marks a vendor when a Zoho customer has its GSTIN or PAN, which can be a branch in another state. Taking the mark off leaves the vendor as it is. Any order, sales document, payment received, lead or archived sale counts as a sale; open those on their own page, and use Roles there if the mark is still wrong.
      </p>
      <AlsoCustomersTable rows={rows} />
    </div>
  );
}
