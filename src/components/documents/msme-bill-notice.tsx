import { CompanyLink } from "@/components/companies/company-link";
import { Card } from "@/components/ui/card";
import { workspaceClock } from "@/lib/time/workspace";
import { formatCalendarDay } from "@/lib/time/zone";
import { MSME_CATEGORY_LABELS, heldToLimit, msmeStanding, standingWords, vendorMsmeOf } from "@/lib/payables/msme";
import { companyPath } from "@/lib/record-links";

/**
 * On a bill from a micro or small vendor (owner, 17 Nov 2026; src/lib/payables/msme.ts): the last day the MSMED Act
 * gives to pay it, and how near it is. Red once it has passed, amber within a week, quiet before that. Nothing once it is
 * paid, or for a vendor that isn't micro or small.
 */
export async function MsmeBillNotice({
  bill,
}: {
  bill: { companyId: string; companySeq: number; issueDate: Date | string; dueDate: Date | string | null; unpaid: boolean; draft: boolean };
}) {
  if (!bill.unpaid) return null;
  const msme = await vendorMsmeOf(bill.companyId);
  if (!msme || !heldToLimit(msme.category)) return null;
  const standing = msmeStanding({ issueDate: new Date(bill.issueDate), dueDate: bill.dueDate ? new Date(bill.dueDate) : null }, await workspaceClock());
  const tone =
    standing.state === "late"
      ? "border-danger/40 bg-danger-bg text-danger"
      : standing.state === "soon"
        ? "border-warning/40 bg-warning-bg text-warning"
        : "border-line bg-surface-sunken text-muted";
  return (
    <Card className={`mt-4 px-4 py-3 text-sm ${tone}`}>
      <p>
        <span className="font-medium">
          <CompanyLink href={companyPath(bill.companySeq)} className="underline-offset-2 hover:underline">
            {MSME_CATEGORY_LABELS[msme.category]} enterprise
          </CompanyLink>{" "}
          · pay by {formatCalendarDay(standing.payBy)}
        </span>
        {bill.draft ? "" : ` — ${standingWords(standing)}.`}
      </p>
      <p className="mt-1 text-xs opacity-90">
        {standing.noDueDate
          ? "No due date on the bill, so the Act's 15 days apply. "
          : standing.dueBeyondLimit
            ? "The bill's due date is later than the Act allows — the limit is 45 days from the bill. "
            : "The bill's due date, within the Act's 45 days. "}
        {standing.state === "late"
          ? "It is now owed interest at three times the RBI bank rate, and the amount isn't an expense for the year until paid (Income-tax s.43B(h))."
          : "Paid later, interest at three times the RBI bank rate is owed, and the amount isn't an expense for the year until paid (Income-tax s.43B(h))."}
      </p>
    </Card>
  );
}
