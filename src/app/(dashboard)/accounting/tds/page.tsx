import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { CompanyLink } from "@/components/companies/company-link";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { tdsSummary } from "@/actions/tax-reports";
import { getOrganisation } from "@/lib/organisation";
import { Card } from "@/components/ui/card";
import { Amount, ReportHeader } from "@/components/accounting/report-chrome";
import { MonthPicker } from "@/components/accounting/month-picker";
import { monthName } from "@/lib/ledger/period";
import { formatCurrency } from "@/lib/utils";
import { previousIstMonth } from "@/lib/india-time";
import { formatCalendarDay, indiaClock } from "@/lib/time/zone";
import { notFound } from "next/navigation";
import { viewerHas } from "@/actions/permission";
import { companyPath } from "@/lib/record-links";
import { sectionOf } from "@/lib/tds/sections";
import { taxYearShortfalls } from "@/lib/tds/vendor";
import { tdsDeposits } from "@/lib/tds/challans";
import { TdsDeposits } from "@/components/accounting/tds-deposits";
import { TdsStatementCard } from "@/components/accounting/tds-statement-card";
import { form140Overview, tdsSettings } from "@/lib/tds/form140";
import { quarterOf, statementDueOn } from "@/lib/tds/form140-format";
import { workspacePack } from "@/lib/country-pack";

/**
 * What was withheld, both ways.
 *
 * The date is the point. TDS deducted in a month is payable by the 7th of the next, and interest
 * runs at 1.5% a month from the day after — so this page leads with the deadline rather than with
 * a total.
 */
export default async function TdsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; year?: string }>;
}) {
  const enabled = await isModuleEnabled("accounting");
  if (!enabled) return <ModuleDisabledNotice moduleKey="accounting" />;
  // The finance function's (`payments.manage`), like every action behind the page: without it the
  // page is not there, the same as its link (owner, 8 Oct 2026 — pages you can't open are a 404).
  if (!(await viewerHas("payments.manage"))) notFound();
  // India's returns: a UAE workspace files VAT (/accounting/vat-return), and the menu leaves this out.
  if (!workspacePack().india) notFound();

  const params = await searchParams;
  const now = new Date();
  // India's last month (india-time `previousIstMonth`): the host's, on a server in UTC, was still the
  // month before that until 05:30 IST on the 1st.
  const previous = previousIstMonth(now);
  const month = Number(params.month) || previous.month;
  const year = Number(params.year) || previous.year;

  // Vendors past a limit this tax year with TDS not deducted (src/lib/tds): the tax year of the month shown.
  const monthDay = `${year}-${String(month).padStart(2, "0")}-01`;
  const [tds, org, shortfalls, deposits] = await Promise.all([
    tdsSummary({ month, year }),
    getOrganisation(),
    taxYearShortfalls(monthDay).catch(() => []),
    // The month's challans (src/lib/tds/challans.ts); null where the workspace's database is still to be updated.
    tdsDeposits(monthDay.slice(0, 7)),
  ]);
  if (!tds) notFound();
  // The quarter's statement (src/lib/tds/form140.ts): Form 140 is the 2025 Act's, from the quarter that began 1 April 2026.
  const statementQuarter = quarterOf(monthDay);
  const [statement, statementDetails] =
    statementQuarter.taxYear >= 2026 ? await Promise.all([form140Overview(statementQuarter.taxYear, statementQuarter.quarter), tdsSettings()]) : [null, null];

  // One reading of the clock for the whole render, so "overdue" and "days left" can't disagree. Both
  // count India's days, in every workspace: the deposit is due by the end of the 7th (30 April for March) in India. Comparing
  // the due day's UTC midnight with now made it overdue from 05:30 IST on the 7th itself.
  const daysLeft = indiaClock.daysBetween(now, indiaClock.startOfDay(tds.dueOn) ?? now);
  // What is still to deposit: the deductions — vendors' and salary's — on no challan; without the challans
  // tables yet, all that vendors' bills deducted.
  const toDeposit = deposits ? deposits.left : tds.totals.payable;
  const overdue = toDeposit > 0 && daysLeft < 0;

  return (
    <div className="animate-fade-rise">
      <ReportHeader
        title="TDS"
        subtitle={`${monthName(month)} ${year}`}
        organisation={`${org.legalName}${org.pan ? ` · PAN ${org.pan}` : ""}`}
      >
        <MonthPicker month={month} year={year} />
      </ReportHeader>

      {toDeposit > 0 && (
        <Card
          className={`mt-4 px-4 py-3 text-sm ${overdue ? "border-danger/40 bg-danger-bg text-danger" : "border-warning/40 bg-warning-bg text-warning"}`}
        >
          <span className="font-medium">{formatCurrency(toDeposit)}</span> was deducted and is still to be deposited
          {overdue ? (
            <> — it was due by {formatCalendarDay(tds.dueOn)}, and interest runs at 1.5% a month, counted from the month it was deducted.</>
          ) : (
            <> by {formatCalendarDay(tds.dueOn)}{daysLeft >= 0 && ` — ${daysLeft} day(s) left`}.</>
          )}
        </Card>
      )}
      {deposits && toDeposit === 0 && deposits.deducted > 0 && (
        <Card className="mt-4 border-success/40 bg-success-bg px-4 py-3 text-sm text-success">
          All of {monthName(month)}&apos;s TDS — <span className="font-medium">{formatCurrency(deposits.deducted)}</span> — is deposited.
        </Card>
      )}

      {tds.problems.length > 0 && (
        <Card className="mt-4 border-warning/40 bg-warning-bg px-4 py-3 text-sm text-warning">
          <p className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="h-3.5 w-3.5" />
            {tds.problems.length} thing(s) to fix before filing
          </p>
          <ul className="mt-2 space-y-1">
            {tds.problems.slice(0, 8).map((p, i) => (
              <li key={`${p.docNumber}-${i}`}>
                <span className="font-mono text-xs">{p.docNumber}</span> — {p.issue}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {shortfalls.length > 0 && (
        <Card className="mt-4 border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger">
          <p className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="h-3.5 w-3.5" />
            TDS not deducted this tax year: {formatCurrency(shortfalls.reduce((t, s) => t + s.shortfall, 0))}
          </p>
          <p className="mt-1 text-xs">
            These vendors’ bills crossed a section’s limit for the year, and less was deducted than the section asks. Deduct it from
            their next bill or payment, and pay it with interest.
          </p>
          <ul className="mt-2 space-y-1">
            {shortfalls.slice(0, 10).map((s) => (
              <li key={`${s.companyId}-${s.section.key}`}>
                <CompanyLink href={companyPath(s.companySeq)} className="font-medium hover:underline">
                  {s.companyName}
                </CompanyLink>{" "}
                — {s.section.oldSection}: {formatCurrency(s.shortfall)} short on {formatCurrency(s.taxable)} billed ({formatCurrency(s.deducted)} deducted)
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">We deducted, and owe</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-text">{formatCurrency(tds.totals.payable)}</div>
          <div className="mt-0.5 text-xs text-muted">A liability until it&apos;s paid to the government.</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Customers withheld from us</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-text">
            {formatCurrency(tds.totals.receivable)}
          </div>
          <div className="mt-0.5 text-xs text-muted">
            An asset — claim it against the year&apos;s tax, and check it appears in 26AS.
          </div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Due on</div>
          <div className="mt-1 text-2xl font-semibold text-text">{formatCalendarDay(tds.dueOn)}</div>
          <div className="mt-0.5 text-xs text-muted">The 7th of the following month; March&apos;s by 30 April.</div>
        </Card>
      </div>

      {deposits && (
        <TdsDeposits
          month={deposits.month}
          monthLabel={`${monthName(month)} ${year}`}
          dueOn={formatCalendarDay(deposits.dueOn)}
          today={indiaClock.today(now)}
          groups={deposits.groups}
          challans={deposits.challans}
          linkedByChallan={deposits.linked}
          bankAccounts={deposits.bankAccounts}
        />
      )}

      {statement && statementDetails && (
        <TdsStatementCard
          overview={statement}
          settings={statementDetails}
          organisation={[org.legalName, org.pan && `PAN ${org.pan}`, [org.city, org.state, org.pincode].filter(Boolean).join(" "), org.email, org.phone].filter(Boolean).join(" · ")}
          dueOn={formatCalendarDay(statementDueOn(statement.taxYear, statement.quarter))}
          today={indiaClock.today(now)}
        />
      )}

      <TdsTable
        title="Deducted from vendors"
        hint="Withheld from what we paid them, and owed onwards. The quarterly Form 140 (was 26Q) reports these."
        rows={tds.payable}
        total={tds.totals.payable}
      />
      <TdsTable
        title="Withheld by customers"
        hint="They paid us less and paid the difference to the government on our behalf. Verify each against Form 26AS before claiming it."
        rows={tds.receivable}
        total={tds.totals.receivable}
      />
    </div>
  );
}

function TdsTable({
  title,
  hint,
  rows,
  total,
}: {
  title: string;
  hint: string;
  rows: { docNumber: string; issueDate: string | Date; partyName: string; partyPan: string | null; section: string | null; taxableValue: number; amount: number }[];
  total: number;
}) {
  return (
    <Card className="mt-4 overflow-hidden p-0">
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-medium text-text">{title}</h2>
        <p className="mt-0.5 text-xs text-muted">{hint}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Document</th>
              <th className="px-4 py-2.5">Date</th>
              <th className="px-4 py-2.5">Party</th>
              <th className="px-4 py-2.5">PAN</th>
              <th className="px-4 py-2.5">Section</th>
              <th className="px-4 py-2.5 text-right">Taxable value</th>
              <th className="px-4 py-2.5 text-right">Withheld</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.docNumber} className="border-b border-line last:border-0">
                <td className="px-4 py-2 font-mono text-xs text-muted">{row.docNumber}</td>
                {/* The day the return reports it on: India's, in every workspace. */}
                <td className="px-4 py-2 text-muted">{indiaClock.date(row.issueDate)}</td>
                <td className="px-4 py-2 text-text">{row.partyName}</td>
                <td className="px-4 py-2 font-mono text-xs">
                  {row.partyPan ?? <span className="text-danger">missing</span>}
                </td>
                {/* The 1961 number everybody says, for a section from the list; what was typed, for one before it. */}
                <td className="px-4 py-2 text-xs text-muted">{sectionOf(row.section)?.oldSection ?? row.section ?? "—"}</td>
                <td className="px-4 py-2 text-right">
                  <Amount value={row.taxableValue} muted />
                </td>
                <td className="px-4 py-2 text-right">
                  <Amount value={row.amount} bold />
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-subtle">
                  Nothing withheld this month.{" "}
                  <Link href="/documents" className="text-brand hover:underline">
                    Documents
                  </Link>
                </td>
              </tr>
            )}
            {rows.length > 0 && (
              <tr className="border-t-2 border-line-strong bg-surface-sunken">
                <td colSpan={6} className="px-4 py-2.5 font-semibold text-text">
                  Total
                </td>
                <td className="px-4 py-2.5 text-right">
                  <Amount value={total} bold />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
