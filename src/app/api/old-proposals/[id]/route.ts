import { NextResponse } from "next/server";
import { isModuleEnabled } from "@/actions/module";
import { accessLevel } from "@/lib/authz/access";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { currentUser } from "@/lib/session";
import { bytesOf, StoredFileMissing } from "@/lib/storage/files";

/**
 * An old proposal's own file (src/lib/old-proposals/files.ts), as it was made — saved, never shown in the page. To whoever
 * may see its company and its documents, as an archived document's PDF is (src/app/api/archive/[id]/pdf): out of scope and
 * missing answer the same.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const notFound = () => new NextResponse("Not found", { status: 404 });
  const user = await currentUser();
  if (!user) return notFound();
  const file = await db.oldProposalFile
    .findUnique({ where: { id: (await params).id }, select: { name: true, contentType: true, data: true, proposal: { select: { company: { select: { id: true, ownerUserId: true, relationshipType: true } } } } } })
    .catch((err: unknown) => {
      if (notMigratedYet(err)) return null;
      throw err;
    });
  if (!file) return notFound();
  const level = await accessLevel(user.id, "documents", "view");
  if (!(await isModuleEnabled("sales_documents")) || (level !== "FOLLOW" && level !== "ALL") || !(await canSeeCompany(user.id, file.proposal.company))) return notFound();
  let bytes: Buffer;
  try {
    bytes = await bytesOf(file.data);
  } catch (err) {
    if (err instanceof StoredFileMissing) return notFound();
    throw err;
  }
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": file.contentType,
      "content-disposition": `attachment; filename="${file.name.replace(/[^\w .()&-]+/g, "-")}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}
