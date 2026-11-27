import { db } from "@/lib/db";
import { portalInvoiceAllowed } from "@/actions/portal-public";
import { can } from "@/lib/authz/resolve";
import { mintRenderGrant } from "@/lib/documents/render-grant";
import { RENDER_PARAM } from "@/lib/documents/render-token";
import { PdfError, renderPdf } from "@/lib/documents/pdf";
import { attachmentHeader } from "@/lib/custom-fields/secure";
import { renderTarget } from "@/lib/tenancy/render-target";

/**
 * An invoice's PDF for the customer, from their portal (owner, 29 Oct 2026): the same PDF an emailed invoice carries
 * — its own print page printed by the server's browser — for an invoice their link lists. The print page needs
 * somebody to render as: whoever made the invoice, or, gone or without the right to see documents, the super admin.
 *
 * A browser run for each, so a link is held to ten a minute.
 */
export const dynamic = "force-dynamic";

const WINDOW_MS = 60_000;
const PER_WINDOW = 10;
const recent = new Map<string, number[]>();
/**
 * Security audit round two, 13 Nov 2026 (low): ten a minute, all at once, was ten browsers at once on the one process
 * serving every workspace. One PDF at a time a link; the next waits for it.
 */
const rendering = new Set<string>();

function allowed(token: string): boolean {
  const now = Date.now();
  const kept = (recent.get(token) ?? []).filter((t) => now - t < WINDOW_MS);
  if (kept.length >= PER_WINDOW) return false;
  kept.push(now);
  recent.set(token, kept);
  if (recent.size > 5000) recent.clear();
  return true;
}

async function renderer(createdById: string): Promise<string | null> {
  const maker = await db.user.findUnique({ where: { id: createdById }, select: { id: true, active: true } });
  if (maker?.active && (await can(maker.id, "documents.view"))) return maker.id;
  const owner = await db.user.findFirst({ where: { isSuperAdmin: true, active: true }, select: { id: true } });
  return owner?.id ?? null;
}

export async function GET(_request: Request, { params }: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await params;
  if (!(await portalInvoiceAllowed(token, id))) return new Response("Not found", { status: 404 });
  if (!allowed(token)) return new Response("Too many downloads — try again in a minute.", { status: 429 });
  const doc = await db.tradeDocument.findUnique({ where: { id }, select: { id: true, docNumber: true, createdById: true } });
  const as = doc ? await renderer(doc.createdById) : null;
  if (!doc || !as) return new Response("Not found", { status: 404 });
  if (rendering.has(token)) return new Response("Another PDF is still being made — try again in a moment.", { status: 429 });
  rendering.add(token);
  let pdf: Buffer;
  try {
    const pass = await mintRenderGrant(doc.id, as);
    const target = await renderTarget(`/documents/${doc.id}/print?${RENDER_PARAM}=${encodeURIComponent(pass)}`);
    pdf = await renderPdf(target.url, { hostRules: target.hostRules });
  } catch (err) {
    console.error("[portal] invoice PDF", err instanceof PdfError ? err.message : err);
    return new Response("The PDF couldn't be made just now — try again in a moment.", { status: 503 });
  } finally {
    rendering.delete(token);
  }
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": attachmentHeader(`${doc.docNumber.replace(/[\\/]+/g, "-")}.pdf`),
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
