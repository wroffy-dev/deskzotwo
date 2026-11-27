import { db } from "@/lib/db";
import { formatLeadId } from "@/lib/order-id";
import { leadPath } from "@/lib/record-links";
import { documentPath } from "@/lib/trade-documents";

/**
 * Each order's invoices and the proposal it came from, for a company's Products & Subscriptions (owner, 21 Nov 2026:
 * "why no invoices and proposals here"). The list showed only the PO / invoice number typed on the order.
 *
 *   · Its invoices: the tax invoices with a line billing it (TradeDocumentLine.companyProductId) — raised from the
 *     order, linked to it by hand, or an old-CRM order linked on the switch page — any not cancelled; a draft says so.
 *   · Its proposal: the quote — or the proforma, said so — it was ordered from (QuoteOrderLink), else the lead's
 *     proposal it was punched from (CompanyProduct.proposal).
 *
 * Read on its own, beside the company's orders rather than inside their query, which is big enough already.
 */

/** `tag`: a word beside it — "draft", "proforma"; `title`: what it says on hover. */
export type PaperLink = { href: string; label: string; tag?: string; title?: string };
export type OrderPaperwork = { invoices: PaperLink[]; proposal: PaperLink | null };

const CHUNK = 1000;

export async function orderPaperwork(orderIds: string[]): Promise<Record<string, OrderPaperwork>> {
  const ids = [...new Set(orderIds.filter(Boolean))];
  const out: Record<string, OrderPaperwork> = {};
  for (const id of ids) out[id] = { invoices: [], proposal: null };
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const [lines, quoteLinks, punched] = await Promise.all([
      db.tradeDocumentLine.findMany({
        where: { companyProductId: { in: part }, document: { docType: "INVOICE", status: { not: "CANCELLED" } } },
        orderBy: { document: { issueDate: "asc" } },
        select: { companyProductId: true, document: { select: { id: true, docNumber: true, status: true } } },
      }),
      db.quoteOrderLink.findMany({ where: { orderId: { in: part } }, select: { orderId: true, quoteId: true } }),
      db.companyProduct.findMany({ where: { id: { in: part }, proposalId: { not: null } }, select: { id: true, proposal: { select: { lead: { select: { leadSeq: true, title: true } } } } } }),
    ]);
    for (const l of lines) {
      const mine = out[l.companyProductId!]!;
      if (mine.invoices.some((x) => x.href === documentPath(l.document.id))) continue;
      mine.invoices.push({ href: documentPath(l.document.id), label: l.document.docNumber ?? "Draft invoice", ...(l.document.status === "DRAFT" ? { tag: "draft" } : {}) });
    }
    const quotes = new Map(
      (await db.tradeDocument.findMany({ where: { id: { in: [...new Set(quoteLinks.map((q) => q.quoteId))] } }, select: { id: true, docNumber: true, docType: true } })).map((q) => [q.id, q]),
    );
    for (const q of quoteLinks) {
      const quote = quotes.get(q.quoteId);
      // An order made from a proforma is linked the same way: said so, as it isn't a quote.
      if (quote && !out[q.orderId]!.proposal) out[q.orderId]!.proposal = { href: documentPath(quote.id), label: quote.docNumber ?? "Quote", ...(quote.docType === "PROFORMA" ? { tag: "proforma" } : {}) };
    }
    for (const p of punched) {
      const lead = p.proposal?.lead;
      if (lead && !out[p.id]!.proposal) out[p.id]!.proposal = { href: leadPath(lead.leadSeq), label: formatLeadId(lead.leadSeq), tag: "lead's proposal", title: lead.title };
    }
  }
  return out;
}
