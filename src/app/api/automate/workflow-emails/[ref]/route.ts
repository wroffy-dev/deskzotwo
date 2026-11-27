import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { isModuleEnabled } from "@/actions/module";
import { workflowEmails } from "@/actions/automate-emails";
import { recordAudit } from "@/lib/audit";
import { workspaceClock } from "@/lib/time/workspace";
import { formatCompanyId } from "@/lib/order-id";

/**
 * A workflow's emails as an Excel file (owner, 2 Nov 2026 — src/lib/automate/email-report.ts): the list on its "Emails
 * sent" page, `?show=` SENT, SKIPPED or FAILED as the page was filtered. Whoever may use Automate; anybody else a 404.
 * Under /api, outside the proxy's gate; `currentUser` applies it instead. Recorded in the audit log.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const user = await currentUser();
  if (!user || !(await isModuleEnabled("automate"))) return new NextResponse("Not found", { status: 404 });
  const { ref } = await params;
  const data = await workflowEmails(decodeURIComponent(ref));
  if (!data) return new NextResponse("Not found", { status: 404 });
  const show = new URL(request.url).searchParams.get("show");
  const rows = show === "SENT" || show === "SKIPPED" || show === "FAILED" ? data.report.rows.filter((r) => r.outcome === show) : data.report.rows;
  const clock = await workspaceClock();

  const book = new ExcelJS.Workbook();
  book.creator = "Deskzo";
  const sheet = book.addWorksheet("Emails sent");
  sheet.columns = [
    { header: "When", width: 20 },
    { header: "Outcome", width: 10 },
    { header: "To", width: 26 },
    { header: "Email address", width: 32 },
    { header: "Customer", width: 30 },
    { header: "Customer ID", width: 14 },
    { header: "Subject", width: 50 },
    { header: "From", width: 30 },
    { header: "In CC", width: 8 },
    { header: "Why skipped or failed", width: 50 },
    { header: "Run", width: 14 },
  ];
  for (const r of rows) {
    sheet.addRow([
      clock.dateTimeShort(r.at),
      r.outcome === "SENT" ? "Sent" : r.outcome === "FAILED" ? "Failed" : "Skipped",
      r.recipientName ?? "",
      r.recipientEmail ?? "",
      r.companyName ?? (r.recipientKind === "person" ? "A colleague" : ""),
      r.companySeq ? formatCompanyId(r.companySeq) : "",
      r.subject ?? "",
      r.from ?? "",
      r.copied || null,
      r.reason ?? "",
      r.runRef,
    ]);
  }
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };

  await recordAudit({ userId: user.id, action: "CREATE", entityType: "AutomationWorkflow", entityId: data.workflow.id, entityLabel: `Exported the emails of ${data.workflow.ref} ${data.workflow.name} — ${rows.length}` });
  const buf = await book.xlsx.writeBuffer();
  return new NextResponse(new Uint8Array(buf as ArrayBuffer), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${data.workflow.ref}-emails-${clock.today()}.xlsx"`,
      "cache-control": "private, no-store",
    },
  });
}
