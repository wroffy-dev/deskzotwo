import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { isModuleEnabled } from "@/actions/module";
import { listElsewhere } from "@/actions/elsewhere";
import { categoryLabel, sourceLabel } from "@/lib/customers/elsewhere-rules";
import { elsewhereCategoryOptions } from "@/lib/customers/elsewhere-categories";
import { formatCompanyId } from "@/lib/order-id";
import { recordAudit } from "@/lib/audit";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * Customers › Installed elsewhere as an Excel file (owner, 2 Nov 2026 — src/lib/customers/elsewhere.ts): the list as
 * filtered on screen, read by the same action, so it holds only the customers this person may see. Under /api, so
 * outside the proxy's gate; `currentUser` applies it instead. Recorded in the audit log.
 *
 * Needs data.exportCrm, as every other way of taking CRM records away as a file does (security audit, Nov 2026):
 * it checked only who was signed in, so anybody who could open the page could download the list.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await currentUser();
  if (!user || !(await isModuleEnabled("companies"))) return new NextResponse("Not found", { status: 404 });
  if (!(await can(user.id, "data.exportCrm"))) return new NextResponse("Not found", { status: 404 });
  const url = new URL(request.url);
  const pick = (k: string) => url.searchParams.get(k) ?? undefined;
  const categories = await elsewhereCategoryOptions();
  const data = await listElsewhere({ q: pick("q"), category: pick("category"), from: pick("from"), renews: pick("renews"), owner: pick("owner") });

  const book = new ExcelJS.Workbook();
  book.creator = "Deskzo";
  const sheet = book.addWorksheet("Installed elsewhere");
  sheet.columns = [
    { header: "Customer", width: 32 },
    { header: "Customer ID", width: 14 },
    { header: "Account manager", width: 22 },
    { header: "Product", width: 36 },
    { header: "Category", width: 18 },
    { header: "Quantity", width: 10 },
    { header: "Bought from", width: 26 },
    { header: "Renews on", width: 14 },
    { header: "Value a year", width: 14 },
    { header: "How we know", width: 28 },
    { header: "Reminder", width: 18 },
    { header: "Notes", width: 50 },
  ];
  for (const r of data.rows) {
    sheet.addRow([
      r.company.name,
      formatCompanyId(r.company.companySeq),
      r.company.owner?.name ?? "",
      r.productName,
      r.category ? categoryLabel(r.category, categories) : "",
      r.quantity ?? null,
      r.boughtFrom ?? "",
      // A day, as Excel reads one — the @db.Date's own day, whatever the zone.
      r.renewsOn ? new Date(String(r.renewsOn)) : null,
      r.yearlyValue === null ? null : Number(r.yearlyValue),
      sourceLabel(r.source),
      r.remindDays ? `${r.remindDays} days before` : "None",
      r.notes ?? "",
    ]);
  }
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };
  sheet.getColumn(8).numFmt = "dd mmm yyyy";
  sheet.getColumn(9).numFmt = "#,##0";

  await recordAudit({ userId: user.id, action: "CREATE", entityType: "Company", entityId: "installed-elsewhere", entityLabel: `Exported Installed elsewhere — ${data.rows.length} products` });
  const buf = await book.xlsx.writeBuffer();
  const stamp = (await workspaceClock()).today();
  return new NextResponse(new Uint8Array(buf as ArrayBuffer), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="installed-elsewhere-${stamp}.xlsx"`,
      "cache-control": "private, no-store",
    },
  });
}
