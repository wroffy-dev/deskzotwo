import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { isModuleEnabled } from "@/actions/module";
import { statutoryFiles } from "@/actions/statutory-files";
import { bankCsv } from "@/lib/hr/statutory-files";
import { monthLabel } from "@/lib/hr/calendar";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit";

/** What each file is called in the audit log. */
const FILE_NAMES: Record<string, string> = { ecr: "PF ECR file", esi: "ESI return", bank: "Bank transfer file" };

/**
 * A locked payroll month's files (owner, 31 Oct 2026): `ecr` — EPFO's ECR text, `esi` — ESIC's monthly upload as a
 * workbook, `bank` — the bank's bulk transfer CSV. Anybody who may not run payroll, or a draft month, gets a 404.
 *
 * Every download is logged (owner, 2 Nov 2026 — "Phase 1 security fixes", audit M-9): these files carry everybody's
 * pay, UAN and bank account, and the bank file is what money moves on — like every other export, who took one and
 * when belongs in the audit log. Only a file actually handed over is logged; a refusal is the 404 it always was.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ runId: string; kind: string }> }) {
  const { runId, kind } = await params;
  if (!(await isModuleEnabled("payroll"))) return new NextResponse("Not found", { status: 404 });
  const files = await statutoryFiles(runId);
  if (!files || !files.ready) return new NextResponse("Not found", { status: 404 });
  const stamp = `${files.run.year}-${String(files.run.month).padStart(2, "0")}`;
  const send = (body: BodyInit, type: string, name: string) =>
    new NextResponse(body, { headers: { "content-type": type, "content-disposition": `attachment; filename="${name}"`, "cache-control": "private, no-store" } });
  // The person statutoryFiles has just let through (it refuses anybody else), with "view as" credited by recordAudit.
  const logDownload = async (included: number) => {
    const user = await requireUser();
    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "PayrollRun",
      entityId: files.run.id,
      entityLabel: `${FILE_NAMES[kind]} for ${monthLabel(files.run.month, files.run.year)} downloaded — ${included} ${included === 1 ? "person" : "people"}`,
    });
  };

  if (kind === "ecr") {
    await logDownload(files.ecr.included);
    return send(files.ecr.content, "text/plain; charset=utf-8", `ECR-${stamp}.txt`);
  }
  if (kind === "bank") {
    const narration = `Salary ${monthLabel(files.run.month, files.run.year)}`;
    await logDownload(files.bank.included);
    return send(bankCsv(files.bank.content, narration), "text/csv; charset=utf-8", `Salary-transfer-${stamp}.csv`);
  }
  if (kind === "esi") {
    await logDownload(files.esi.included);
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Sheet1");
    sheet.columns = [
      { header: "IP Number (10 Digits)", width: 16 },
      { header: "IP Name( Only alphabets and space )", width: 30 },
      { header: "No of Days for which wages paid/payable during the month", width: 14 },
      { header: "Total Monthly Wages", width: 14 },
      { header: "Reason Code for Zero workings days(numeric only; provide 0 for all other reasons- Click on the link for reference)", width: 14 },
      { header: "Last Working Day( Format DD/MM/YYYY  or DD-MM-YYYY)", width: 16 },
    ];
    for (const l of files.esi.content) sheet.addRow([l.ipNumber, l.name, l.days, l.wages, l.reasonCode, l.lastWorkingDay]);
    // IP numbers as text, so Excel keeps a leading zero.
    sheet.getColumn(1).numFmt = "@";
    const buf = await book.xlsx.writeBuffer();
    return send(new Uint8Array(buf as ArrayBuffer), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", `ESI-${stamp}.xlsx`);
  }
  return new NextResponse("Not found", { status: 404 });
}
