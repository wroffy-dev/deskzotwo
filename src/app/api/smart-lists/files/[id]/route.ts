import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { isModuleEnabled } from "@/actions/module";
import { attachmentHeader } from "@/lib/custom-fields/secure";
import { readListFile } from "@/lib/smart-lists/files";
import { mayOpenList } from "@/lib/smart-lists/links";
import { companyInList } from "@/lib/smart-lists/membership";

/**
 * A file in a Smart List's Files column (owner, 20 Nov 2026 — Smart Lists phase 2, src/lib/smart-lists/files.ts): for
 * whoever may open the list — and, in a list of companies, for whom that company is in it — while its cell still names
 * it. Anything else answers as a made-up id does.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const missing = () => new Response("Not found", { status: 404 });
  const user = await currentUser();
  if (!user || !id || !(await isModuleEnabled("workspace"))) return missing();
  const file = await readListFile(id);
  if (!file || !(await mayOpenList(user.id, file.workbookId))) return missing();
  const wb = await db.workbook.findUnique({ where: { id: file.workbookId }, select: { id: true, mode: true, filters: true } });
  if (!wb) return missing();
  const cell = wb.mode === "ROWS"
    ? await db.workbookRowValue.findUnique({ where: { propertyId_rowId: { propertyId: file.propertyId, rowId: file.rowKey } }, select: { value: true } })
    : (await companyInList(user.id, wb, file.rowKey))
      ? await db.workbookValue.findUnique({ where: { propertyId_companyId: { propertyId: file.propertyId, companyId: file.rowKey } }, select: { value: true } })
      : null;
  if (!cell || !Array.isArray(cell.value) || !cell.value.includes(id)) return missing();
  return new Response(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": attachmentHeader(file.name, true),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
