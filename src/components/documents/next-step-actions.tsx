"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { TradeDocumentStatus, TradeDocumentType } from "@prisma/client";
import { ArrowRightLeft, Check, FolderPlus, IndianRupee, X } from "lucide-react";
import { convertTradeDocument, setTradeDocumentStatus } from "@/actions/trade-document";
import { invoiceBillingStage } from "@/actions/progress-billing";
import { InvoiceReminderButton } from "@/components/collect/invoice-reminder-button";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem } from "@/components/ui/menu";
import { tradeDocumentLabels } from "@/lib/trade-documents";

/**
 * The buttons in a document's "What's next?" box (owner, 3 Nov 2026 — "I like this in Zoho": the action sits beside the
 * words that call for it). Each is the same action the page's own buttons run, offered only where the person may:
 * convert a quote or proforma, mark a sent quote accepted or rejected, start a project for the customer, record a
 * payment on an invoice still owed.
 */
export function NextStepActions({
  id,
  convertTo,
  orderHref = null,
  orderLabel = "sales order",
  nextStage = null,
  markable,
  projectHref,
  payable,
  remindable = false,
}: {
  /** An open invoice, for someone who follows up payments: a reminder mailed from here. */
  remindable?: boolean;
  id: string;
  convertTo: TradeDocumentType[];
  /** A quote with lines still to order: the Punch order form, filled from the next (src/lib/orders/from-quote.ts). */
  orderHref?: string | null;
  /** What the order is called on its button — "order" on a proforma (owner, 16 Nov 2026: "order punching"). */
  orderLabel?: string;
  /** A quote billed in stages: the next stage to invoice (src/lib/documents/progress-billing.ts). */
  nextStage?: { id: string; label: string } | null;
  /** Statuses it may be set to by hand from here — a sent quote's Accepted and Rejected. */
  markable: TradeDocumentStatus[];
  /** The new-project form with the customer chosen, for someone who may make projects. */
  projectHref: string | null;
  /** An invoice still owed, for someone who may record payments: the payments panel below. */
  payable: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (!convertTo.length && !orderHref && !nextStage && !markable.length && !projectHref && !payable && !remindable) return null;

  const run = (work: () => Promise<{ ok: boolean; error?: string; data?: unknown }>, after?: (data: unknown) => void) =>
    start(async () => {
      setError(null);
      const r = await work();
      if (!r.ok) return setError(r.error ?? "That didn't work.");
      if (after) after(r.data);
      else router.refresh();
    });

  const convert = (target: TradeDocumentType) =>
    run(
      () => convertTradeDocument({ id, target }),
      (data) => router.push(`/documents/${(data as { id: string }).id}`),
    );

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-2">
      {nextStage && (
        <Button size="sm" disabled={pending} onClick={() => run(() => invoiceBillingStage(nextStage.id), (data) => router.push(`/documents/${(data as { id: string }).id}`))}>
          <IndianRupee className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Invoice &ldquo;{nextStage.label}&rdquo;
        </Button>
      )}
      {convertTo.length === 1 && !orderHref && (
        <Button size="sm" disabled={pending} onClick={() => convert(convertTo[0]!)}>
          <ArrowRightLeft className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Convert to {tradeDocumentLabels[convertTo[0]!].toLowerCase()}
        </Button>
      )}
      {convertTo.length === 0 && orderHref && (
        <Button size="sm" disabled={pending} onClick={() => router.push(orderHref)}>
          <ArrowRightLeft className="mr-1.5 h-3.5 w-3.5" aria-hidden /> {orderLabel === "order" ? "Punch order" : `Convert to ${orderLabel}`}
        </Button>
      )}
      {convertTo.length + (orderHref ? 1 : 0) > 1 && (
        <Menu label="Convert" align="start" width={220}>
          {(close) =>
            convertTo.map((t) => (
              <MenuItem
                key={t}
                disabled={pending}
                onClick={() => {
                  close();
                  convert(t);
                }}
              >
                To {tradeDocumentLabels[t].toLowerCase()}
              </MenuItem>
            )).concat(
              orderHref
                ? [
                    <MenuItem
                      key="order"
                      disabled={pending}
                      onClick={() => {
                        close();
                        router.push(orderHref);
                      }}
                    >
                      {orderLabel === "order" ? "Punch order" : `To ${orderLabel}`}
                    </MenuItem>,
                  ]
                : [],
            )
          }
        </Menu>
      )}
      {markable.includes("ACCEPTED") && (
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => setTradeDocumentStatus(id, "ACCEPTED"))}>
          <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Mark accepted
        </Button>
      )}
      {markable.includes("REJECTED") && (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => setTradeDocumentStatus(id, "REJECTED"))}>
          <X className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Mark rejected
        </Button>
      )}
      {projectHref && (
        <Link href={projectHref} className="inline-flex h-8 items-center rounded-base border border-line px-3 text-sm text-text transition-colors hover:border-brand hover:text-brand">
          <FolderPlus className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Create project
        </Link>
      )}
      {payable && (
        <a href="#payments" className="inline-flex h-8 items-center rounded-base border border-line px-3 text-sm text-text transition-colors hover:border-brand hover:text-brand">
          <IndianRupee className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Record payment
        </a>
      )}
      {remindable && <InvoiceReminderButton documentId={id} />}
      {error && <p className="w-full text-xs text-danger">{error}</p>}
    </div>
  );
}
