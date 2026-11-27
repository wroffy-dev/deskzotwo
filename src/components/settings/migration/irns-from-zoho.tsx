"use client";

import { useEffect, useState, useTransition } from "react";
import { LoaderCircle } from "lucide-react";
import { fillZohoIrns, zohoIrnsToAsk } from "@/actions/zoho";
import { Button } from "@/components/ui/button";
import { ActionNoticeRegion } from "@/components/ui/action-notice";

/**
 * Switch to Deskzo › Zoho: invoices brought across without their IRN (owner, 21 Nov 2026: "after 29 oct invoices not
 * showing irn"). Asks Zoho for each one's e-invoice — newest first, about forty seconds a press, carrying on when pressed
 * again — and puts the IRN, acknowledgement and signed QR on it (src/lib/zoho/einvoices.ts).
 */
export function IrnsFromZoho() {
  const [left, setLeft] = useState<number | null>(null);
  const [note, setNote] = useState<{ tone: "success" | "error" | "info"; message: string } | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    void zohoIrnsToAsk().then((r) => r.ok && setLeft(r.data));
  }, []);

  if (left === null || (left === 0 && !note)) return null;

  const run = () =>
    start(async () => {
      setNote(null);
      const r = await fillZohoIrns();
      if (!r.ok) return setNote({ tone: "error", message: r.error });
      const d = r.data;
      setLeft(d.left);
      const parts = [
        d.filled ? `${d.filled} IRN${d.filled === 1 ? "" : "s"} brought across` : "No IRN found this time",
        d.notEInvoiced ? `${d.notEInvoiced} not e-invoiced in Zoho` : "",
        d.notFound ? `${d.notFound} not found in Zoho by number` : "",
        d.left ? `${d.left} still to ask — press again to carry on` : "every invoice asked",
      ].filter(Boolean);
      const fields = d.fieldsSeen.length ? ` Zoho's reply had these e-invoice fields, none of them an IRN Deskzo reads: ${d.fieldsSeen.join(", ")} — tell support.` : "";
      setNote({ tone: d.filled ? "success" : "info", message: `${parts.join(" · ")}.${fields}` });
    });

  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      <p className="text-sm font-medium text-text">Invoices without their IRN</p>
      <p className="text-xs text-muted">
        {left ? `${left.toLocaleString("en-IN")} invoice${left === 1 ? "" : "s"} brought across from Zoho ${left === 1 ? "has" : "have"} no IRN in Deskzo. ` : ""}
        Deskzo asks Zoho for each one&apos;s e-invoice — the IRN, acknowledgement and signed QR — and puts it on the invoice and its print. Three of Zoho&apos;s calls an
        invoice; about forty seconds a press, newest first.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="secondary" disabled={pending || left === 0} onClick={run}>
          {pending && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          {pending ? "Asking Zoho…" : "Bring the IRNs from Zoho"}
        </Button>
      </div>
      <ActionNoticeRegion notice={note} />
    </div>
  );
}
