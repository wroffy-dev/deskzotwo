import { portalFileAllowed } from "@/actions/portal-public";
import { attachmentHeader, readFieldFile } from "@/lib/custom-fields/secure";

/**
 * A file on one of the customer's subscriptions — a licence certificate (owner, 29 Oct 2026). Only one a field marked
 * for the portal holds, on a subscription their link shows; behind the emailed code where the portal asks for it.
 * Anything else answers as a made-up link does.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await params;
  if (!(await portalFileAllowed(token, id))) return new Response("Not found", { status: 404 });
  const file = await readFieldFile(id);
  if (!file) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": attachmentHeader(file.name),
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
