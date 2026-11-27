"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MsmeCategory } from "@prisma/client";
import { clearVendorMsme, setVendorMsme } from "@/actions/vendor-msme";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { formatCalendarDay } from "@/lib/time/zone";
import { MSME_CATEGORIES, MSME_CATEGORY_LABELS, heldToLimit, standingWords, type MsmeBillRow } from "@/lib/payables/msme-rules";
import { formatCurrency } from "@/lib/utils";

/**
 * A vendor's MSME registration (owner, 17 Nov 2026; src/lib/payables/msme.ts): its Udyam number and category and, when
 * it is micro or small, its open bills against the 45-day limit — the soonest first. Finance changes it
 * (`payments.manage`); everyone who sees the vendor reads it.
 */
export function VendorMsmeCard({
  companyId,
  canManage,
  msme,
  bills,
}: {
  companyId: string;
  canManage: boolean;
  msme: { udyamNumber: string; category: MsmeCategory } | null;
  bills: MsmeBillRow[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [udyam, setUdyam] = useState(msme?.udyamNumber ?? "");
  const [category, setCategory] = useState<string>(msme?.category ?? "MICRO");

  const run = (work: () => Promise<{ ok: true } | { ok: false; error: string }>) =>
    start(async () => {
      setError(null);
      const r = await work();
      if (!r.ok) return setError(r.error);
      setEditing(false);
      router.refresh();
    });

  const openEditor = () => {
    setUdyam(msme?.udyamNumber ?? "");
    setCategory(msme?.category ?? "MICRO");
    setError(null);
    setEditing(true);
  };

  return (
    <Card>
      <CardHeader className="flex items-center justify-between gap-2 text-sm font-medium text-text">
        <span>MSME (Udyam)</span>
        {msme && <Badge tone={heldToLimit(msme.category) ? "amber" : "default"}>{MSME_CATEGORY_LABELS[msme.category]}</Badge>}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!editing && (
          <>
            {msme ? (
              <div className="space-y-1">
                <p className="font-mono text-text">{msme.udyamNumber}</p>
                <p className="text-xs text-muted">
                  {heldToLimit(msme.category)
                    ? "Pay its bills by the day agreed, at most 45 days from the bill — 15 days when no day was agreed (MSMED Act s.15). Paid later, it is owed interest at three times the RBI bank rate, and the amount isn't an expense for the year until paid (Income-tax s.43B(h))."
                    : "A medium enterprise: recorded, but not held to the 45-day limit."}
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted">Not recorded as an MSME. Add its Udyam number if it is one, so its bills are watched against the 45-day limit.</p>
            )}

            {bills.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted">Open bills</p>
                {bills.map((b) => (
                  <Link
                    key={b.id}
                    href={`/documents/${b.id}`}
                    className="flex items-center justify-between gap-2 rounded-base border border-line px-3 py-2 text-xs hover:bg-surface-sunken"
                  >
                    <span className="min-w-0">
                      <span className="font-medium text-text">{b.docNumber ?? "Bill"}</span>
                      <span className="text-muted"> · pay by {formatCalendarDay(b.payBy)} · {formatCurrency(b.balance)}</span>
                    </span>
                    <span className={b.state === "late" ? "shrink-0 font-medium text-danger" : b.state === "soon" ? "shrink-0 font-medium text-warning" : "shrink-0 text-muted"}>
                      {standingWords(b)}
                    </span>
                  </Link>
                ))}
              </div>
            )}

            {canManage && (
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="secondary" onClick={openEditor}>
                  {msme ? "Change" : "Add Udyam number"}
                </Button>
                {msme && (
                  <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => run(() => clearVendorMsme(companyId))}>
                    Not an MSME
                  </Button>
                )}
              </div>
            )}
          </>
        )}

        {editing && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor={`udyam-${companyId}`} className="text-xs">
                Udyam registration number
              </Label>
              <Input
                id={`udyam-${companyId}`}
                value={udyam}
                onChange={(e) => setUdyam(e.target.value)}
                placeholder="UDYAM-MH-19-0012345"
                className="font-mono uppercase"
                maxLength={30}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`msme-category-${companyId}`} className="text-xs">
                Category
              </Label>
              <Select id={`msme-category-${companyId}`} value={category} onChange={(e) => setCategory(e.target.value)}>
                {MSME_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {MSME_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-subtle">As on its Udyam certificate. Micro and small are held to the 45-day limit.</p>
            </div>
            <div className="flex gap-2">
              <Button type="button" size="sm" disabled={pending} onClick={() => run(() => setVendorMsme(companyId, { udyamNumber: udyam, category }))}>
                {pending ? "Saving…" : "Save"}
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
