"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, FileUp, OctagonX } from "lucide-react";
import { makeDraftBill, readBillFile, reviewBillReading } from "@/actions/bill-reader";
import type { ReadingView } from "@/lib/bill-reader/server";
import { ACCEPTED_TYPES, FILE_MAX_BYTES } from "@/lib/bill-reader/rules";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { CompanyCombobox, type CompanyComboOption } from "@/components/ui/company-combobox";
import { TeammateAvatar, useTeammate } from "@/components/ai/teammate-avatar";
import { searchCompanyOptions } from "@/actions/company-options";
import { formatMoney } from "@/lib/currency";
import { shrinkPhoto } from "@/lib/images/shrink";

/**
 * Purchase › Bills › Read a bill (owner, 20 Nov 2026 — src/lib/bill-reader): the vendor's PDF or a photo in, Arjun reads
 * it, and the person checks what he read next to the file — the vendor, the purchase order, the number and dates, and
 * anything that doesn't add up — then makes the draft bill, which opens in the bill form to finish.
 */
export function BillReader({ initial }: { initial: ReadingView | null }) {
  const arjun = useTeammate("arjun");
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<ReadingView | null>(initial);
  const [preview, setPreview] = useState<{ url: string; type: string } | null>(initial ? { url: `/api/bill-readings/${initial.id}`, type: initial.contentType } : null);
  const [busy, setBusy] = useState<"read" | "review" | "draft" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vendor, setVendor] = useState<CompanyComboOption | null>(initial?.vendor ? { id: initial.vendor.id, name: initial.vendor.name } : null);
  const [billNumber, setBillNumber] = useState(initial?.bill?.billNumber ?? "");
  const [billDate, setBillDate] = useState(initial?.bill?.billDate ?? "");
  const [dueDate, setDueDate] = useState(initial?.bill?.dueDate ?? "");
  const [, start] = useTransition();

  useEffect(() => () => (preview?.url.startsWith("blob:") ? URL.revokeObjectURL(preview.url) : undefined), [preview]);

  const take = (v: ReadingView) => {
    setView(v);
    setBillNumber(v.bill?.billNumber ?? "");
    setBillDate(v.bill?.billDate ?? "");
    setDueDate(v.bill?.dueDate ?? "");
    setVendor(v.vendor ? { id: v.vendor.id, name: v.vendor.name } : null);
  };

  const read = (file: File) =>
    start(async () => {
      setError(null);
      if (!(file.type in ACCEPTED_TYPES)) return setError(`Arjun reads ${Object.values(ACCEPTED_TYPES).join(", ")} files.`);
      const small = await shrinkPhoto(file);
      if (small.size > FILE_MAX_BYTES) return setError(`That file is over ${FILE_MAX_BYTES / 1024 / 1024} MB — upload the vendor's PDF, or a smaller photo.`);
      setPreview({ url: URL.createObjectURL(small), type: small.type });
      setBusy("read");
      const form = new FormData();
      form.set("file", small);
      const r = await readBillFile(form);
      setBusy(null);
      if (!r.ok) return setError(r.error);
      take(r.data);
      router.replace(`/purchase/bills/read?reading=${r.data.id}`, { scroll: false });
    });

  const review = (patch: { vendorId?: string | null; poId?: string | null }) =>
    start(async () => {
      if (!view) return;
      setBusy("review");
      setError(null);
      const r = await reviewBillReading({ id: view.id, vendorId: patch.vendorId !== undefined ? patch.vendorId : (vendor?.id ?? null), ...(patch.poId !== undefined ? { poId: patch.poId } : { poId: view.poId }) });
      setBusy(null);
      if (!r.ok) return setError(r.error);
      setView(r.data);
    });

  const draft = () =>
    start(async () => {
      if (!view || !vendor) return;
      setBusy("draft");
      setError(null);
      const r = await makeDraftBill({ id: view.id, vendorId: vendor.id, poId: view.poId, billNumber, billDate, dueDate: dueDate || null });
      setBusy(null);
      if (!r.ok) return setError(r.error);
      router.push(`/documents/${r.data.documentId}/edit`);
    });

  const bill = view?.bill ?? null;
  const stops = useMemo(() => (view?.checks ?? []).filter((c) => c.level === "stop"), [view]);
  const warns = useMemo(() => (view?.checks ?? []).filter((c) => c.level === "warn"), [view]);
  const taxable = bill ? bill.lines.reduce((t, l) => t + l.taxable, 0) : 0;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="flex min-h-[420px] flex-col p-3">
        {preview ? (
          preview.type === "application/pdf" ? (
            <iframe title="The vendor's bill" src={preview.url} className="h-[70vh] w-full flex-1 rounded-base border border-line" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- the person's own upload, shown as it is
            <img src={preview.url} alt="The vendor's bill" className="max-h-[70vh] w-full rounded-base border border-line object-contain" />
          )
        ) : (
          <button
            type="button"
            onClick={() => input.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files[0];
              if (f) read(f);
            }}
            className="flex flex-1 flex-col items-center justify-center gap-2 rounded-base border-2 border-dashed border-line-strong p-8 text-center text-sm text-muted hover:bg-surface-sunken"
          >
            <FileUp className="h-8 w-8 text-subtle" />
            <span className="font-medium text-text">Drop the vendor&apos;s bill here, or choose it</span>
            <span>A PDF, or a photo of it — {Object.values(ACCEPTED_TYPES).join(", ")}</span>
          </button>
        )}
        <input
          ref={input}
          type="file"
          accept={Object.keys(ACCEPTED_TYPES).join(",")}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) read(f);
            e.target.value = "";
          }}
        />
        {preview && (
          <div className="mt-2 flex justify-end">
            <Button size="sm" variant="ghost" onClick={() => input.current?.click()} disabled={busy !== null}>
              Read another bill
            </Button>
          </div>
        )}
      </Card>

      <Card className="space-y-4 p-4 text-sm">
        <div className="flex items-start gap-3">
          <TeammateAvatar teammate="arjun" size="md" />
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold text-text">
              {busy === "read" ? `${arjun.name} is reading it…` : bill ? `What ${arjun.name} read` : `${arjun.name} reads it for you`}
            </h2>
            <p className="text-xs text-muted">
              He fills in a draft bill from the vendor&apos;s file and checks the GST and totals. Nothing is saved or posted until you check the draft and save it.
            </p>
          </div>
        </div>
        {error && <p className="rounded-base bg-danger-bg px-3 py-2 text-xs text-danger">{error}</p>}
        {view && !bill && view.error && <p className="rounded-base bg-danger-bg px-3 py-2 text-xs text-danger">{view.error}</p>}

        {bill && view && (
          <>
            {(stops.length > 0 || warns.length > 0) && (
              <ul className="space-y-1">
                {stops.map((c) => (
                  <li key={c.text} className="flex items-start gap-2 rounded-base bg-danger-bg px-3 py-1.5 text-xs text-danger">
                    <OctagonX className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {c.text}
                  </li>
                ))}
                {warns.map((c) => (
                  <li key={c.text} className="flex items-start gap-2 rounded-base bg-warning-bg px-3 py-1.5 text-xs text-warning">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {c.text}
                  </li>
                ))}
              </ul>
            )}

            <div className="space-y-1.5">
              <Label>Vendor</Label>
              <p className="text-xs text-muted">
                On the bill: {bill.vendorName ?? "no name read"}
                {bill.vendorGstin ? ` · GSTIN ${bill.vendorGstin}` : ""}
              </p>
              {bill.endCustomer && (
                <p className="text-xs text-muted">
                  End customer: <span className="font-medium text-text">{bill.endCustomer}</span> — kept in the bill&apos;s notes
                </p>
              )}
              <CompanyCombobox
                companies={vendor ? [vendor] : []}
                value={vendor?.id ?? ""}
                onSelect={(c) => {
                  setVendor(c);
                  review({ vendorId: c?.id ?? null, poId: null });
                }}
                search={(q) => searchCompanyOptions(q, { side: "vendor" })}
                placeholder="Search your vendors…"
              />
              {!view.vendor && view.vendorCandidates.length > 0 && !vendor && (
                <div className="flex flex-wrap gap-1.5 text-xs">
                  <span className="text-muted">Perhaps:</span>
                  {view.vendorCandidates.map((c) => (
                    <button key={c.id} type="button" className="rounded-full border border-line px-2 py-0.5 hover:bg-surface-sunken" onClick={() => (setVendor({ id: c.id, name: c.name }), review({ vendorId: c.id, poId: null }))}>
                      {c.name}
                    </button>
                  ))}
                </div>
              )}
              {!view.vendor && !vendor && (
                <p className="text-xs text-muted">
                  Not one of your vendors yet?{" "}
                  <Link href="/vendors/new" target="_blank" className="text-brand hover:underline">
                    Add them
                  </Link>{" "}
                  with the GSTIN on the bill, then pick them here.
                </p>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="bill-number">Vendor&apos;s bill number</Label>
                <Input id="bill-number" value={billNumber} onChange={(e) => setBillNumber(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="bill-date">Bill date</Label>
                <Input id="bill-date" type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="due-date">Due date</Label>
                <Input id="due-date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </div>
            </div>

            {vendor && (
              <div className="space-y-1">
                <Label htmlFor="po">Against purchase order</Label>
                <Select id="po" value={view.poId ?? ""} onChange={(e) => review({ poId: e.target.value || null })}>
                  <option value="">None</option>
                  {view.pos.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.number} · {p.issued}
                    </option>
                  ))}
                </Select>
                {bill.poNumber && !view.poId && <p className="text-xs text-muted">The bill quotes PO {bill.poNumber}, which isn&apos;t one of this vendor&apos;s open orders.</p>}
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-left text-subtle">
                  <tr>
                    <th className="py-1 pr-2 font-medium">Line</th>
                    <th className="py-1 pr-2 font-medium">HSN</th>
                    <th className="py-1 pr-2 text-right font-medium">Qty</th>
                    <th className="py-1 pr-2 text-right font-medium">Rate</th>
                    <th className="py-1 pr-2 text-right font-medium">Taxable</th>
                    <th className="py-1 text-right font-medium">GST</th>
                  </tr>
                </thead>
                <tbody>
                  {bill.lines.map((l, i) => (
                    <tr key={i} className="border-t border-line align-top">
                      <td className="py-1 pr-2">
                        <span className="text-text">{l.description}</span>
                        {view.items[i] && <span className="block text-subtle">Our item: {view.items[i]!.name}</span>}
                      </td>
                      <td className="py-1 pr-2 font-mono">{l.hsn ?? "—"}</td>
                      <td className="py-1 pr-2 text-right">
                        {l.quantity} {l.unit ?? ""}
                      </td>
                      <td className="py-1 pr-2 text-right">{formatMoney(l.rate)}</td>
                      <td className="py-1 pr-2 text-right">{formatMoney(l.taxable)}</td>
                      <td className="py-1 text-right">{l.gstRate}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs sm:grid-cols-3">
              <div>
                <dt className="text-subtle">Taxable</dt>
                <dd className="text-text">{formatMoney(taxable)}</dd>
              </div>
              <div>
                <dt className="text-subtle">{bill.igst > 0 ? "IGST" : "CGST + SGST"}</dt>
                <dd className="text-text">{formatMoney(bill.igst > 0 ? bill.igst : bill.cgst + bill.sgst)}</dd>
              </div>
              <div>
                <dt className="text-subtle">Total on the bill</dt>
                <dd className="font-medium text-text">{bill.total !== null ? formatMoney(bill.total) : "—"}</dd>
              </div>
            </dl>

            <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
              <Button onClick={draft} disabled={busy !== null || !vendor || stops.length > 0 || !billNumber.trim() || !billDate}>
                {busy === "draft" ? "Making the draft…" : "Make the draft bill"}
              </Button>
              <span className="text-xs text-muted">It opens in the bill form — change anything, then save.</span>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
