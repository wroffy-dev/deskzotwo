"use client";

import Link from "next/link";
import { useState } from "react";
import { linkOldOrdersNow, listOldOrderLinks } from "@/actions/migration";
import { linkInvoiceLine } from "@/actions/order-billing";
import type { OldOrderLinks } from "@/lib/migration/old-orders";
import { Button } from "@/components/ui/button";
import { orderPath } from "@/lib/record-links";
import { documentPath } from "@/lib/trade-documents";
import { formatCurrency } from "@/lib/utils";

/**
 * Old orders and the old system's invoices that billed them (owner, 21 Nov 2026; src/lib/migration/old-orders.ts):
 * look first, then link the pairs that are the only fit either way. The rest are listed to choose on each order's
 * page, with "Link an invoice already raised".
 */
export function OldOrdersLink({ onError }: { onError: (message: string | null) => void }) {
  const [list, setList] = useState<OldOrderLinks | null>(null);
  const [working, setWorking] = useState(false);
  const [sure, setSure] = useState<null | "sure" | "nearest">(null);
  const [linked, setLinked] = useState<number | null>(null);
  // One order linked from the list — the same link as the order page's, with its checks; the row then leaves the list.
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ orderId: string; message: string } | null>(null);

  const linkOne = async (orderId: string, lineId: string) => {
    setRowError(null);
    setRowBusy(orderId);
    try {
      const r = await linkInvoiceLine(orderId, lineId);
      if (!r.ok) return setRowError({ orderId, message: r.error });
      setLinked((n) => (n ?? 0) + 1);
      setList((l) => {
        if (!l) return l;
        // A line bills one order: it leaves the other orders' choices too.
        const toChoose = l.toChoose
          .filter((o) => o.orderId !== orderId)
          .map((o) => ({ ...o, candidates: o.candidates.filter((c) => c.lineId !== lineId) }));
        return { ...l, toChoose, toChooseCount: l.toChooseCount - 1 };
      });
    } catch {
      setRowError({ orderId, message: "That didn't go through — try again." });
    } finally {
      setRowBusy(null);
    }
  };

  const look = async () => {
    onError(null);
    setWorking(true);
    try {
      const r = await listOldOrderLinks();
      if (r.ok) setList(r.data);
      else onError(r.error);
    } catch {
      onError("That didn't go through — reload the page.");
    } finally {
      setWorking(false);
    }
  };

  const link = async (nearest: boolean) => {
    onError(null);
    setWorking(true);
    setSure(null);
    let count = 0;
    try {
      for (;;) {
        const r = await linkOldOrdersNow(nearest);
        if (!r.ok) {
          onError(r.error);
          break;
        }
        count += r.data.linked;
        setLinked(count);
        if (!r.data.more || !r.data.linked) break;
      }
      const again = await listOldOrderLinks();
      if (again.ok) setList(again.data);
    } catch {
      onError("It stopped part-way; what was linked stays. Press Look again, then carry on.");
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="space-y-2 border-b border-line pb-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="secondary" disabled={working} onClick={() => void look()}>
          {working ? "Working…" : list ? "Look again" : "Link old orders to their invoices"}
        </Button>
        <span className="text-muted">
          The old CRM&apos;s orders and the old system&apos;s invoices came across apart. This pairs them by customer, product, quantity and date — only where
          there is exactly one fit. Looking changes nothing.
        </span>
      </div>
      {linked !== null && <p className="rounded-md bg-surface-sunken px-3 py-2 text-text">Linked {linked.toLocaleString("en-IN")} order(s) to the invoice that billed them.</p>}
      {list && (
        <div className="space-y-2">
          <p className="text-text">
            {list.sure.toLocaleString("en-IN")} to link for sure
            {list.toChooseCount > 0 && <>, {list.toChooseCount.toLocaleString("en-IN")} with more than one invoice that fits</>}
            {list.noMatch > 0 && <>, {list.noMatch.toLocaleString("en-IN")} this year that no invoice fits</>}.
            {list.earlierYears > 0 && (
              <span className="text-muted"> {list.earlierYears.toLocaleString("en-IN")} from earlier years were billed then — kept in Earlier years, not linked.</span>
            )}
          </p>
          {sure ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-text">
                {sure === "sure"
                  ? <>This links {list.sure.toLocaleString("en-IN")} order(s) to the invoice line that billed each.</>
                  : <>This links {list.nearest.toLocaleString("en-IN")} order(s) left to choose, each to the fitting invoice nearest its date — a line to one order only. Check a few after; a wrong one is unlinked on its order.</>}{" "}
                The invoices themselves don&apos;t change.
              </span>
              <Button type="button" size="sm" disabled={working} onClick={() => void link(sure === "nearest")}>
                Yes, link them
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={working} onClick={() => setSure(null)}>
                Not now
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {list.sure > 0 && (
                <Button type="button" size="sm" disabled={working} onClick={() => setSure("sure")}>
                  Link {list.sure.toLocaleString("en-IN")}…
                </Button>
              )}
              {list.sure === 0 && list.nearest > 0 && (
                <Button type="button" size="sm" variant="secondary" disabled={working} onClick={() => setSure("nearest")}>
                  Link the {list.nearest.toLocaleString("en-IN")} left by nearest date…
                </Button>
              )}
            </div>
          )}
          {list.toChoose.length > 0 && (
            <div className="max-h-[32rem] overflow-auto rounded-lg border border-line">
              <table className="w-full text-left">
                <thead className="sticky top-0 bg-surface text-muted">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">Order</th>
                    <th className="px-2 py-1.5 font-medium">Customer</th>
                    <th className="px-2 py-1.5 font-medium">Product</th>
                    <th className="px-2 py-1.5 font-medium">Invoices that fit — nearest its date first</th>
                  </tr>
                </thead>
                <tbody>
                  {list.toChoose.map((o) => (
                    <tr key={o.orderId} className="border-t border-line align-top">
                      <td className="px-2 py-1.5">
                        <Link href={orderPath(o.orderSeq)} className="font-mono text-brand hover:underline">
                          {o.orderLabel}
                        </Link>
                        <div className="text-subtle">{o.bookedOn}</div>
                      </td>
                      <td className="px-2 py-1.5 text-text">{o.company}</td>
                      <td className="px-2 py-1.5 text-text">
                        {o.item} × {o.quantity}
                      </td>
                      <td className="px-2 py-1.5 text-muted">
                        <div className="space-y-1">
                          {o.candidates.map((c) => (
                            <div key={c.lineId} className="flex items-center justify-between gap-2">
                              <span>
                                <a href={documentPath(c.documentId)} target="_blank" rel="noopener noreferrer" className="font-mono text-brand hover:underline">
                                  {c.docNumber}
                                </a>{" "}
                                · {c.issueDate} · {formatCurrency(c.amount)}
                              </span>
                              <Button type="button" size="sm" variant="secondary" className="h-6 px-2 text-xs" disabled={working || rowBusy !== null} onClick={() => void linkOne(o.orderId, c.lineId)}>
                                {rowBusy === o.orderId ? "…" : "Link"}
                              </Button>
                            </div>
                          ))}
                          {o.candidates.length === 0 && <span className="text-subtle">Its invoices went to other orders — open the order to choose.</span>}
                          {rowError?.orderId === o.orderId && <p className="text-danger">{rowError.message}</p>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {list.toChooseCount > list.toChoose.length && (
                <p className="border-t border-line px-2 py-1.5 text-muted">The first {list.toChoose.length} of {list.toChooseCount.toLocaleString("en-IN")}.</p>
              )}
            </div>
          )}
          {list.toChoose.length > 0 && <p className="text-muted">Press Link beside the invoice that billed each order. A wrong one is unlinked on the order&apos;s page.</p>}
        </div>
      )}
    </div>
  );
}
