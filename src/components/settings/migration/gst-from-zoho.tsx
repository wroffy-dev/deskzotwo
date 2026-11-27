"use client";

import { useEffect, useState, useTransition } from "react";
import { LoaderCircle } from "lucide-react";
import { fillZohoItemGst, zohoItemsWithoutGst } from "@/actions/zoho";
import { Button } from "@/components/ui/button";
import { ActionNoticeRegion } from "@/components/ui/action-notice";

/**
 * Switch to Deskzo › Zoho: items without a GST rate or HSN/SAC (owner, 21 Nov 2026: "gst rate not set on items" — "can you
 * fetch this from zoho?"). Reads each one's own record in Zoho and fills only what's empty (src/lib/zoho/item-gst.ts).
 */
export function GstFromZoho() {
  const [left, setLeft] = useState<number | null>(null);
  const [note, setNote] = useState<{ tone: "success" | "error" | "info"; message: string } | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    void zohoItemsWithoutGst().then((r) => r.ok && setLeft(r.data));
  }, []);

  if (left === null || (left === 0 && !note)) return null;

  const run = () =>
    start(async () => {
      setNote(null);
      const r = await fillZohoItemGst();
      if (!r.ok) return setNote({ tone: "error", message: r.error });
      const d = r.data;
      setLeft(d.left);
      const parts = [
        d.rates ? `${d.rates} GST rate${d.rates === 1 ? "" : "s"} filled` : "No GST rate found this time",
        d.codes ? `${d.codes} HSN/SAC code${d.codes === 1 ? "" : "s"} filled` : "",
        d.noRateInZoho ? `${d.noRateInZoho} with no rate in Zoho either — set those by hand` : "",
        d.notInZoho ? `${d.notInZoho} not found in Zoho` : "",
        d.left ? `${d.left} still to ask — press again to carry on` : "every item asked",
      ].filter(Boolean);
      setNote({ tone: d.rates || d.codes ? "success" : "info", message: `${parts.join(" · ")}.` });
    });

  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      <p className="text-sm font-medium text-text">Items without a GST rate</p>
      <p className="text-xs text-muted">
        {left ? `${left.toLocaleString("en-IN")} item${left === 1 ? "" : "s"} ${left === 1 ? "has" : "have"} no GST rate or no HSN/SAC in Deskzo. ` : ""}
        Deskzo reads each one&apos;s own record in Zoho and fills only what&apos;s empty — a rate or code set in Deskzo is never changed. One of Zoho&apos;s calls an item;
        about forty seconds a press.
      </p>
      <Button type="button" size="sm" variant="secondary" disabled={pending || left === 0} onClick={run}>
        {pending && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
        {pending ? "Asking Zoho…" : "Bring the GST rates from Zoho"}
      </Button>
      <ActionNoticeRegion notice={note} />
    </div>
  );
}
