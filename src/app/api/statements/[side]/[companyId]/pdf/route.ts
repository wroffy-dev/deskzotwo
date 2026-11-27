import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { PdfError } from "@/lib/documents/pdf";
import { maySeeStatement } from "@/lib/statements/print-data";
import { statementFilename, statementPdf } from "@/lib/statements/render";

/**
 * A customer's (AR) or vendor's (AP) statement as a PDF to download (owner, 31 Oct 2026): the print page, printed by the
 * server, for the period and view asked. Somebody who may not see the statement gets a 404, as a missing one would.
 */
export async function GET(req: Request, { params }: { params: Promise<{ side: string; companyId: string }> }) {
  const user = await currentUser();
  const { side, companyId } = await params;
  if (!user || (side !== "AR" && side !== "AP") || !(await maySeeStatement(user.id, side, companyId))) return new NextResponse("Not found", { status: 404 });
  const company = await db.company.findUnique({ where: { id: companyId }, select: { name: true } });
  if (!company) return new NextResponse("Not found", { status: 404 });
  const url = new URL(req.url);
  // Security audit, 11 Nov 2026 (SEC-41): the period went into the download's filename as typed, so a quote or a
  // header-breaking character in `from` or `to` landed in Content-Disposition. Only a calendar day is kept; anything
  // else is left out, as if it hadn't been asked for.
  const day = (value: string | null) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);
  const view = {
    from: day(url.searchParams.get("from")),
    to: day(url.searchParams.get("to")),
    show: url.searchParams.get("show") === "outstanding" ? "outstanding" : null,
  };
  try {
    const pdf = await statementPdf(user.id, side, companyId, view);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${statementFilename(company.name, view)}"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (err) {
    return new NextResponse(err instanceof PdfError ? err.message : "The PDF couldn't be made.", { status: 500 });
  }
}
