import type { StatementPrint as Data } from "@/lib/statements/print-data";
import { formatCurrency } from "@/lib/utils";

const KIND: Record<string, string> = {
  INVOICE: "Invoice",
  PAYMENT: "Payment",
  CREDIT_NOTE: "Credit note",
  EXCHANGE: "Exchange difference",
  JOURNAL: "Journal",
  OPENING: "Opening balance",
};

/** "31 Oct 2026" from a YYYY-MM-DD, as the day it names. */
const dayLabel = (d: string | null) => (d ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`)) : "");

/**
 * A statement of account on paper (owner, 31 Oct 2026): our letterhead, the party's address, the period and the
 * account summary, then every line with its running balance — or only what is still open. Black on white, A4, as the
 * print layout sets it (src/app/(print)/layout.tsx); the PDF an email carries is this page, printed by the server.
 */
export function StatementPrint({ data, printedOn }: { data: Data; printedOn: string }) {
  const ar = data.side === "AR";
  const period = data.from || data.to ? `${data.from ? dayLabel(data.from) : "Beginning"} to ${dayLabel(data.to) || printedOn}` : `All transactions to ${printedOn}`;
  const money = (n: number) => formatCurrency(n);
  return (
    <div className="mx-auto w-[190mm] bg-white p-8 text-[12px] leading-snug text-neutral-900 shadow print:w-auto print:p-0 print:shadow-none">
      <div className="flex items-start justify-between gap-6">
        <div>
          {data.ours.logo && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={data.ours.logo} alt="" className="mb-2 max-h-16 max-w-[180px] object-contain" />
          )}
        </div>
        <div className="text-right">
          <div className="text-sm font-semibold">{data.ours.name}</div>
          {data.ours.lines.map((l) => (
            <div key={l}>{l}</div>
          ))}
          {data.ours.gstin && <div>GSTIN: {data.ours.gstin}</div>}
          {data.ours.phone && <div>Phone: {data.ours.phone}</div>}
          {data.ours.email && <div>{data.ours.email}</div>}
          {data.ours.cin && <div>CIN: {data.ours.cin}</div>}
        </div>
      </div>

      <div className="mt-8 flex items-start justify-between gap-6">
        <div>
          <div className="font-semibold">To</div>
          <div className="font-semibold">{data.party.name}</div>
          {data.party.lines.map((l) => (
            <div key={l}>{l}</div>
          ))}
          {data.party.gstin && <div>GSTIN: {data.party.gstin}</div>}
        </div>
        <div className="text-right">
          <div className="border-b-2 border-neutral-900 pb-1 text-lg font-semibold">Statement of Accounts</div>
          <div className="mt-1 text-neutral-700">{period}</div>
          <table className="print-keep mt-4 ml-auto w-64 border-collapse">
            <thead>
              <tr>
                <th colSpan={2} className="bg-neutral-200 px-2 py-1 text-left font-semibold">
                  Account summary
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="px-2 py-1 text-left">Opening balance</td>
                <td className="px-2 py-1 text-right">{money(data.summary.opening)}</td>
              </tr>
              <tr>
                <td className="px-2 py-1 text-left">{ar ? "Invoiced" : "Billed"}</td>
                <td className="px-2 py-1 text-right">{money(data.summary.raised)}</td>
              </tr>
              <tr>
                <td className="px-2 py-1 text-left">{ar ? "Received & credited" : "Paid & credited"}</td>
                <td className="px-2 py-1 text-right">{money(data.summary.settled)}</td>
              </tr>
              <tr className="border-t border-neutral-900 font-semibold">
                <td className="px-2 py-1 text-left">{data.summary.closing < 0 ? "In credit" : "Balance due"}</td>
                <td className="px-2 py-1 text-right">{money(Math.abs(data.summary.closing))}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {data.show === "outstanding" ? (
        <table className="mt-8 w-full border-collapse">
          <thead>
            <tr className="bg-neutral-800 text-left text-white">
              <th className="px-2 py-1.5">{ar ? "Invoice" : "Bill"}</th>
              <th className="px-2 py-1.5">Date</th>
              <th className="px-2 py-1.5">Due</th>
              <th className="px-2 py-1.5 text-right">Days overdue</th>
              <th className="px-2 py-1.5 text-right">Balance</th>
            </tr>
          </thead>
          <tbody>
            {data.open.map((d) => (
              <tr key={d.docNumber} className="border-b border-neutral-200">
                <td className="px-2 py-1.5">{d.docNumber}</td>
                <td className="px-2 py-1.5">{dayLabel(d.issueDate)}</td>
                <td className="px-2 py-1.5">{dayLabel(d.dueDate) || "—"}</td>
                <td className="px-2 py-1.5 text-right">{d.daysOverdue > 0 ? d.daysOverdue : "—"}</td>
                <td className="px-2 py-1.5 text-right">{money(d.balance)}</td>
              </tr>
            ))}
            {data.open.length === 0 && (
              <tr>
                <td colSpan={5} className="px-2 py-4 text-center text-neutral-500">
                  Nothing outstanding.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className={data.onAccount || data.journals ? "" : "font-semibold"}>
              <td colSpan={4} className="px-2 py-1.5 text-right">
                {ar ? "Open on invoices" : "Open on bills"}
              </td>
              <td className="px-2 py-1.5 text-right">{money(data.open.reduce((t, d) => t + d.balance, 0))}</td>
            </tr>
            {/* What takes the open invoices to the balance due, so the two figures on the page reconcile. */}
            {data.onAccount !== 0 && (
              <tr>
                <td colSpan={4} className="px-2 py-1.5 text-right">
                  Less: {ar ? "paid or credited" : "paid or credited to them"} on account, not yet applied
                </td>
                <td className="px-2 py-1.5 text-right">−{money(data.onAccount)}</td>
              </tr>
            )}
            {data.journals !== 0 && (
              <tr>
                <td colSpan={4} className="px-2 py-1.5 text-right">
                  Opening balances and adjustments
                </td>
                <td className="px-2 py-1.5 text-right">{money(data.journals)}</td>
              </tr>
            )}
            {(data.onAccount !== 0 || data.journals !== 0) && (
              <tr className="border-t border-neutral-900 font-semibold">
                <td colSpan={4} className="px-2 py-2 text-right">
                  {data.balanceToday < 0 ? "In credit" : "Balance due"}
                </td>
                <td className="px-2 py-2 text-right">{money(Math.abs(data.balanceToday))}</td>
              </tr>
            )}
          </tfoot>
        </table>
      ) : (
        <table className="mt-8 w-full border-collapse">
          <thead>
            <tr className="bg-neutral-800 text-left text-white">
              <th className="px-2 py-1.5">Date</th>
              <th className="px-2 py-1.5">Transaction</th>
              <th className="px-2 py-1.5">Details</th>
              <th className="px-2 py-1.5 text-right">{ar ? "Amount" : "Billed"}</th>
              <th className="px-2 py-1.5 text-right">{ar ? "Payments" : "Paid"}</th>
              <th className="px-2 py-1.5 text-right">Balance</th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map((l, i) => (
              <tr key={`${l.date}-${l.reference}-${i}`} className="border-b border-neutral-200 align-top">
                <td className="whitespace-nowrap px-2 py-1.5">{dayLabel(l.date)}</td>
                <td className="px-2 py-1.5">
                  {KIND[l.kind] ?? l.kind}
                  {l.kind !== "OPENING" && <div className="text-neutral-600">{l.reference}</div>}
                </td>
                <td className="px-2 py-1.5 text-neutral-700">{l.kind === "OPENING" ? "" : l.description}</td>
                <td className="px-2 py-1.5 text-right">{l.raised ? money(l.raised) : ""}</td>
                <td className="px-2 py-1.5 text-right">{l.settled ? money(l.settled) : ""}</td>
                <td className="px-2 py-1.5 text-right">{money(l.balance)}</td>
              </tr>
            ))}
            {data.lines.length === 0 && (
              <tr>
                <td colSpan={6} className="px-2 py-4 text-center text-neutral-500">
                  No transactions in this period.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="font-semibold">
              <td colSpan={5} className="px-2 py-2 text-right">
                {data.summary.closing < 0 ? "In credit" : "Balance due"}
              </td>
              <td className="px-2 py-2 text-right">{money(Math.abs(data.summary.closing))}</td>
            </tr>
          </tfoot>
        </table>
      )}

      <p className="mt-8 text-[11px] text-neutral-500">
        This is a computer-generated statement printed on {printedOn}. Please let us know within 15 days if anything on it doesn&apos;t match your records.
      </p>
    </div>
  );
}
