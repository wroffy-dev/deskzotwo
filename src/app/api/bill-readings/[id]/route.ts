import { NextResponse } from "next/server";
import { contentDisposition } from "@/lib/content-disposition";
import { currentUser } from "@/lib/session";
import { findTradeDocumentFor } from "@/lib/documents/load";
import { readingFile } from "@/lib/bill-reader/server";

/**
 * A vendor's bill as it was uploaded for Arjun to read (owner, 20 Nov 2026 — src/lib/bill-reader): for whoever uploaded
 * it, or anybody who may open the bill made from it. Anything else — and a guessed id — is a plain 404.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await currentUser();
  if (!user) return new NextResponse("Not found", { status: 404 });
  const file = await readingFile(String(id ?? ""));
  if (!file) return new NextResponse("Not found", { status: 404 });
  const mayOpen = file.createdById === user.id || (file.documentId !== null && (await findTradeDocumentFor(user.id, file.documentId)) !== null);
  if (!mayOpen) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(file.bytes), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": contentDisposition("inline", file.fileName),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      ...(file.contentType === "application/pdf" ? {} : { "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" }),
    },
  });
}
