import ExcelJS from "exceljs";
import type { ScorecardRow, TargetedFigure } from "@/lib/scorecard/compute";

/**
 * The Sales scorecard as an Excel workbook (owner, 31 Oct 2026): one row a person with every figure the page shows, as
 * numbers Excel can add up, and each target set for the period beside its figure — and a sheet saying what it is.
 */

const COLUMNS: { header: string; width: number; money?: boolean; percent?: boolean; of: (r: ScorecardRow) => number | string | null }[] = [
  { header: "Person", width: 24, of: (r) => r.name },
  { header: "New business", width: 16, money: true, of: (r) => r.orders.new.value },
  { header: "New business margin", width: 16, money: true, of: (r) => r.orders.new.margin },
  { header: "New customers", width: 12, of: (r) => r.newCustomers },
  { header: "Renewals", width: 16, money: true, of: (r) => r.orders.renewal.value },
  { header: "Renewals due", width: 12, of: (r) => r.renewals.due },
  { header: "Renewed", width: 10, of: (r) => r.renewals.renewed },
  { header: "Renewals lost", width: 12, of: (r) => r.renewals.lost },
  { header: "Renewal rate %", width: 12, percent: true, of: (r) => r.renewals.rate },
  { header: "Add-ons", width: 14, money: true, of: (r) => r.orders.addon.value },
  { header: "Total business", width: 16, money: true, of: (r) => r.orderValue },
  { header: "Total business target", width: 16, money: true, of: (r) => goal(r, "orderValue") },
  { header: "Margin", width: 16, money: true, of: (r) => r.orderMargin },
  { header: "Margin %", width: 10, percent: true, of: (r) => r.marginPercent },
  { header: "Margin target", width: 16, money: true, of: (r) => goal(r, "orderMargin") },
  { header: "Collected", width: 16, money: true, of: (r) => r.collected },
  { header: "Collected target", width: 16, money: true, of: (r) => goal(r, "collected") },
  { header: "Invoiced", width: 16, money: true, of: (r) => r.invoiced },
  { header: "Invoiced target", width: 16, money: true, of: (r) => goal(r, "invoiced") },
  { header: "Leads created", width: 12, of: (r) => r.leads.created },
  { header: "Leads won", width: 10, of: (r) => r.leads.won },
  { header: "Leads won target", width: 12, of: (r) => goal(r, "leadsWon") },
  { header: "Leads lost", width: 10, of: (r) => r.leads.lost },
  { header: "Leads open now", width: 12, of: (r) => r.leads.open },
  { header: "Won rate %", width: 10, percent: true, of: (r) => r.leads.wonRate },
  { header: "Lost rate %", width: 10, percent: true, of: (r) => r.leads.lostRate },
  { header: "Closure rate %", width: 12, percent: true, of: (r) => r.leads.closureRate },
  { header: "Value of leads won", width: 16, money: true, of: (r) => r.leads.wonValue },
  { header: "Calls made", width: 10, of: (r) => r.calls.made },
  { header: "Calls reached", width: 12, of: (r) => r.calls.reached },
  { header: "Call minutes", width: 12, of: (r) => r.calls.minutes },
];

const goal = (r: ScorecardRow, f: TargetedFigure) => r.targets[f]?.target ?? null;

export async function scorecardWorkbook(rows: ScorecardRow[], meta: { period: string; fromDate: string; toDate: string; by: string; takenAt: Date }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Deskzo";
  wb.created = meta.takenAt;

  const sheet = wb.addWorksheet("Scorecard", { views: [{ state: "frozen", xSplit: 1, ySplit: 1 }] });
  sheet.columns = COLUMNS.map((c) => ({ header: c.header, width: c.width, style: c.money ? { numFmt: "#,##0.00" } : {} }));
  sheet.getRow(1).font = { bold: true };
  for (const r of rows) sheet.addRow(COLUMNS.map((c) => c.of(r)));

  const about = wb.addWorksheet("About");
  about.columns = [
    { header: "", width: 22 },
    { header: "", width: 90 },
  ];
  for (const line of [
    ["Report", "Sales scorecard"],
    ["Period", `${meta.period} (${meta.fromDate} to ${meta.toDate})`],
    ["Taken", meta.takenAt.toISOString()],
    ["By", meta.by],
    ["Business", "Orders booked in the period, at the price charged. New business is orders marked New, and renewals won from elsewhere; renewals are orders marked Renewal."],
    ["Margin", "Only where the purchase price is known; the margin % is of the business it is known on."],
    ["Lead rates", "Won and lost rates are of the leads closed in the period (disqualified count as neither); the closure rate is of the leads made in the period, the share closed by now."],
    ["Renewal rate", "Of the subscriptions whose term ended in the period on customers they manage, renewed of those decided (renewed or lost)."],
    ["Targets", "A person's own targets set for exactly this period; blank where none is set."],
  ]) {
    about.addRow(line);
  }
  about.getColumn(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** "sales-scorecard-2026-04-01-to-2027-03-31.xlsx" */
export const scorecardFilename = (fromDate: string, toDate: string) => `sales-scorecard-${fromDate}-to-${toDate}.xlsx`;
