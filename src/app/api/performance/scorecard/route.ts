import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { salesScorecard } from "@/actions/scorecard";
import { scorecardFilename, scorecardWorkbook } from "@/lib/scorecard/workbook";

/**
 * Performance › Sales scorecard as an Excel workbook (owner, 31 Oct 2026) — the period and people the page shows, for
 * whoever may see the page. Anybody else gets a 404, as the page answers.
 */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return new NextResponse("Not found", { status: 404 });
  const url = new URL(req.url);
  const q = (k: string) => url.searchParams.get(k) ?? undefined;
  const view = await salesScorecard({ period: q("period"), from: q("from"), to: q("to"), everyone: q("everyone") === "1" });
  if (!view) return new NextResponse("Not found", { status: 404 });
  const file = await scorecardWorkbook(view.rows, { period: view.window.label, fromDate: view.window.fromDate, toDate: view.window.toDate, by: user.name ?? user.email ?? "", takenAt: new Date() });
  return new NextResponse(new Uint8Array(file), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${scorecardFilename(view.window.fromDate, view.window.toDate)}"`,
      "cache-control": "private, no-store",
    },
  });
}
