import { NextResponse } from "next/server";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { db } from "@/lib/db";
import { isModuleEnabled } from "@/actions/module";
import { currentUser } from "@/lib/session";
import { bytesOf, StoredFileMissing } from "@/lib/storage/files";
import { accessLevel } from "@/lib/authz/access";
import { zohoPdfPath } from "@/lib/zoho/archive-pdf";
import { openArchivedPdf } from "@/lib/zoho/open-archived-pdf";

/** The archive's kinds on the purchase side (src/lib/migration/archive.ts ARCHIVE_KINDS); the rest are sales. */
const PURCHASE_KINDS = new Set<string>(["PURCHASE_ORDER", "BILL", "VENDOR_CREDIT", "VENDOR_PAYMENT"]);

/**
 * An archived document's PDF, as the old system sent it (src/lib/migration/archive.ts; fetched by the Zoho pull,
 * or from Zoho as it is first opened — src/lib/zoho/open-archived-pdf.ts).
 * To whoever may see its company and its documents — out of scope and missing answer the same.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return new NextResponse("Not found", { status: 404 });
  const doc = await db.archivedDocument.findUnique({
    where: { id: (await params).id },
    select: { id: true, number: true, kind: true, oldId: true, companyId: true, file: { select: { contentType: true, data: true, size: true } } },
  });
  // An empty file is a PDF Zoho had none of; with no file at all, it may still be Zoho's to give.
  if (!doc?.companyId || (doc.file ? doc.file.size === 0 : zohoPdfPath(doc) === null)) return new NextResponse("Not found", { status: 404 });
  const company = await db.company.findUnique({ where: { id: doc.companyId }, select: { id: true, ownerUserId: true, relationshipType: true } });
  // Security audit round two, 13 Nov 2026 (low): seeing the company was enough — a bill's PDF opened for somebody with
  // only sales documents, and for somebody who may not see documents at all. Now the document's own side must be
  // switched on for them, and their documents rule must reach it: an archived document belongs to no person, so only a
  // rule that follows the account, or reaches everybody's, does.
  const side = PURCHASE_KINDS.has(doc.kind) ? "purchase_documents" : "sales_documents";
  const level = await accessLevel(user.id, "documents", "view");
  if (!(await isModuleEnabled(side)) || (level !== "FOLLOW" && level !== "ALL") || !(await canSeeCompany(user.id, company))) {
    return new NextResponse("Not found", { status: 404 });
  }
  // The PDF from the storage box when it is kept there; one the box no longer has is not found.
  let pdf: Buffer;
  try {
    if (doc.file) pdf = await bytesOf(doc.file.data);
    else {
      // Only here, after every check above: asking Zoho spends one of the day's calls.
      const opened = await openArchivedPdf(doc.id);
      if (!opened.ok) return new NextResponse(opened.why, { status: opened.status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" } });
      pdf = opened.pdf;
    }
  } catch (err) {
    if (err instanceof StoredFileMissing) return new NextResponse("Not found", { status: 404 });
    throw err;
  }
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${doc.number.replace(/[^\w.-]+/g, "-")}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}
