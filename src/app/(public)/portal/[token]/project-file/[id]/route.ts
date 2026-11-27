import { portalProjectFileAllowed } from "@/actions/portal-public";
import { db } from "@/lib/db";
import { storedFile } from "@/lib/storage/files";
import { attachmentHeader } from "@/lib/custom-fields/secure";

/**
 * A project document the team shared with the customer (owner, 16 Nov 2026 — src/lib/projects/portal.ts). Only one
 * shared, on a project shown on this link's portal, behind the emailed code where the portal asks for it. Anything else
 * answers as a made-up link does.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await params;
  if (!(await portalProjectFileAllowed(token, id))) return new Response("Not found", { status: 404 });
  const doc = await db.projectDocument.findUnique({ where: { id }, select: { name: true, mimeType: true, fileDataUrl: true } });
  const file = doc ? await storedFile(doc.fileDataUrl, doc.mimeType) : null;
  if (!doc || !file) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": attachmentHeader(doc.name),
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
