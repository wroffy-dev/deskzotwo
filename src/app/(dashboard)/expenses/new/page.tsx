import Link from "next/link";
import { listCompanyOptions } from "@/actions/company";
import { getVisit } from "@/actions/visit";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { ExpenseForm } from "@/components/expenses/expense-form";
import { mayReadReceipts } from "@/actions/receipt-reader";
import { isModuleEntitled } from "@/lib/modules-access";
import { workspaceClock } from "@/lib/time/workspace";
import { visitPath } from "@/lib/record-links";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { companyScope } from "@/lib/authz/company-scope";

/**
 * How many companies the page sends with the form, asked for one more: when that one comes back the
 * picker searches the server instead (owner, 30 Oct 2026: the form sent every company before anything
 * could be typed). The picker shows a handful of matches at a time.
 */
const COMPANIES_SENT = 300;

/**
 * The company the URL names (`?companyId=`), as the picker shows it — only one the picker itself would
 * offer (in scope, not disqualified, not a reseller's end customer), else null. An id someone chose is
 * checked rather than trusted, so it can't be used to read a name from outside this person's accounts.
 */
async function prefillOption(companyId: unknown) {
  if (typeof companyId !== "string" || !companyId) return null;
  const user = await requireUser();
  return db.company.findFirst({
    where: { id: companyId, AND: [await companyScope(user.id)], stage: { not: "DISQUALIFIED" }, managedByResellerId: null },
    select: { id: true, name: true },
  });
}

export default async function NewExpensePage({
  searchParams,
}: {
  searchParams: Promise<{ visitId?: string; companyId?: string }>;
}) {
  const enabled = await isModuleEnabled("expenses");
  if (!enabled) return <ModuleDisabledNotice moduleKey="expenses" />;

  const params = await searchParams;
  const [companyRows, visit, clock] = await Promise.all([
    listCompanyOptions({ withContacts: false, take: COMPANIES_SENT + 1 }),
    params.visitId && (await isModuleEntitled("visits")) ? getVisit(params.visitId) : Promise.resolve(null),
    workspaceClock(),
  ]);
  const companySearch = companyRows.length > COMPANIES_SENT;
  const sentCompanies = companyRows.slice(0, COMPANIES_SENT);
  // The prefilled company stays in the list wherever it falls in the alphabet, so the picker can name it.
  const prefill =
    params.companyId && !sentCompanies.some((c) => c.id === params.companyId) ? await prefillOption(params.companyId) : null;
  const companies = prefill ? [prefill, ...sentCompanies] : sentCompanies;

  return (
    <div>
      <div className="mb-5">
        <Link href={visit ? visitPath(visit.visitSeq) : "/expenses"} className="text-sm text-muted hover:text-text">
          ← {visit ? "Back to the visit" : "Expenses"}
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-text">New expense</h1>
        <p className="mt-1 text-sm text-muted">
          Submit it to send it to your manager, or save it as a draft and submit a batch later.
        </p>
      </div>

      <ExpenseForm
        companies={companies}
        companySearch={companySearch}
        // Arjun fills the claim in from its receipt, for somebody who may use Deskzo AI (owner, 20 Nov 2026).
        mayReadReceipts={await mayReadReceipts().catch(() => false)}
        visit={visit ? { id: visit.id, visitSeq: visit.visitSeq, companyName: visit.company.name } : null}
        defaults={{
          category: visit ? "TRAVEL" : "OTHER",
          amount: "",
          taxAmount: "",
          spentOn: clock.today(),
          description: "",
          paymentMode: "CASH",
          reimbursable: true,
          visitId: params.visitId ?? "",
          companyId: params.companyId ?? "",
          leadId: "",
          receiptName: "",
        }}
      />
    </div>
  );
}
