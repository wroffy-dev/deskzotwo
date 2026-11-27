"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { addTdsCertificate, removeTdsCertificate, setVendorTdsSection } from "@/actions/tds";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { IconButton } from "@/components/ui/icon-button";
import { Input, Label, Select } from "@/components/ui/input";

export type TdsSectionOption = { key: string; label: string; oldSection: string; rates: string };
export type VendorTdsCertificateRow = { id: string; sectionKey: string; certificateNo: string; ratePercent: number; amountLimit: number | null; validFrom: string; validTo: string };
export type VendorTdsYearRow = { sectionKey: string; taxable: number; deducted: number; overLimit: boolean; shortfall: number };

const money = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/**
 * A vendor's TDS (src/lib/tds), beside its PAN: the section its bills start from, the lower deduction
 * certificates it holds, and this tax year so far — what it was paid under each section, what was deducted,
 * and what should have been and wasn't. Finance changes it (`payments.manage`); others read it.
 */
export function VendorTdsCard({
  companyId,
  canManage,
  pan,
  kindLabel,
  usualSectionKey,
  sections,
  certificates,
  year,
  taxYearLabel,
}: {
  companyId: string;
  canManage: boolean;
  pan: string | null;
  kindLabel: string;
  usualSectionKey: string | null;
  sections: TdsSectionOption[];
  certificates: VendorTdsCertificateRow[];
  year: VendorTdsYearRow[];
  taxYearLabel: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ sectionKey: usualSectionKey ?? sections[0]?.key ?? "", certificateNo: "", ratePercent: "", amountLimit: "", validFrom: "", validTo: "" });
  const sectionName = (key: string) => {
    const s = sections.find((x) => x.key === key);
    return s ? `${s.oldSection} — ${s.label}` : key;
  };

  const run = (work: () => Promise<{ ok: true } | { ok: false; error: string }>, after?: () => void) =>
    start(async () => {
      setError(null);
      const r = await work();
      if (!r.ok) return setError(r.error);
      after?.();
      router.refresh();
    });

  const usual = sections.find((s) => s.key === usualSectionKey);
  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">TDS</CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-xs text-muted">
          {pan ? (
            <>
              PAN {pan}: {kindLabel}.
            </>
          ) : (
            <span className="text-warning">No valid PAN on file: TDS on its bills is at the higher rate until one is added.</span>
          )}
        </p>

        <div className="space-y-1.5">
          <Label htmlFor={`tds-section-${companyId}`} className="text-xs">
            Usual section
          </Label>
          {canManage ? (
            <Select
              id={`tds-section-${companyId}`}
              value={usualSectionKey ?? ""}
              disabled={pending}
              onChange={(e) => run(() => setVendorTdsSection(companyId, e.target.value || null))}
            >
              <option value="">None — each bill chooses</option>
              {sections.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.oldSection} — {s.label}
                </option>
              ))}
            </Select>
          ) : (
            <p className="text-text">{usual ? `${usual.oldSection} — ${usual.label}` : "None"}</p>
          )}
          {usual && <p className="text-xs text-muted">{usual.rates}</p>}
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted">Lower deduction certificates</p>
          {certificates.length === 0 && <p className="text-xs text-subtle">None recorded.</p>}
          {certificates.map((c) => (
            <div key={c.id} className="flex items-start justify-between gap-2 rounded-base border border-line px-3 py-2">
              <div className="text-xs">
                <p className="font-medium text-text">
                  {c.certificateNo} · {c.ratePercent}%
                </p>
                <p className="text-muted">
                  {sectionName(c.sectionKey)} · {c.validFrom} to {c.validTo}
                  {c.amountLimit !== null ? ` · up to ${money(c.amountLimit)}` : ""}
                </p>
              </div>
              {canManage && <IconButton icon={Trash2} label="Remove certificate" tone="danger" disabled={pending} onClick={() => run(() => removeTdsCertificate(c.id))} />}
            </div>
          ))}
          {canManage && !adding && (
            <Button type="button" size="sm" variant="secondary" onClick={() => setAdding(true)}>
              + Add certificate
            </Button>
          )}
          {canManage && adding && (
            <div className="grid grid-cols-2 gap-2 rounded-base border border-line bg-surface-sunken p-3">
              <div className="col-span-2 space-y-1">
                <Label htmlFor={`tds-cert-section-${companyId}`} className="text-xs">
                  Section
                </Label>
                <Select id={`tds-cert-section-${companyId}`} value={draft.sectionKey} onChange={(e) => setDraft({ ...draft, sectionKey: e.target.value })}>
                  {sections.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.oldSection} — {s.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`tds-cert-no-${companyId}`} className="text-xs">
                  Certificate number
                </Label>
                <Input id={`tds-cert-no-${companyId}`} value={draft.certificateNo} onChange={(e) => setDraft({ ...draft, certificateNo: e.target.value })} className="font-mono uppercase" />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`tds-cert-rate-${companyId}`} className="text-xs">
                  Rate %
                </Label>
                <Input id={`tds-cert-rate-${companyId}`} type="number" step="0.01" min="0" max="100" value={draft.ratePercent} onChange={(e) => setDraft({ ...draft, ratePercent: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`tds-cert-from-${companyId}`} className="text-xs">
                  Valid from
                </Label>
                <Input id={`tds-cert-from-${companyId}`} type="date" value={draft.validFrom} onChange={(e) => setDraft({ ...draft, validFrom: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`tds-cert-to-${companyId}`} className="text-xs">
                  Valid to
                </Label>
                <Input id={`tds-cert-to-${companyId}`} type="date" value={draft.validTo} onChange={(e) => setDraft({ ...draft, validTo: e.target.value })} />
              </div>
              <div className="col-span-2 space-y-1">
                <Label htmlFor={`tds-cert-limit-${companyId}`} className="text-xs">
                  Amount it covers (blank if it names none)
                </Label>
                <Input id={`tds-cert-limit-${companyId}`} type="number" step="0.01" min="0" value={draft.amountLimit} onChange={(e) => setDraft({ ...draft, amountLimit: e.target.value })} />
              </div>
              <div className="col-span-2 flex justify-end gap-2">
                <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)} disabled={pending}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    run(
                      () => addTdsCertificate({ companyId, ...draft, amountLimit: draft.amountLimit || null }),
                      () => {
                        setAdding(false);
                        setDraft({ ...draft, certificateNo: "", ratePercent: "", amountLimit: "", validFrom: "", validTo: "" });
                      },
                    )
                  }
                >
                  Save certificate
                </Button>
              </div>
            </div>
          )}
        </div>

        {year.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted">Tax year {taxYearLabel} so far</p>
            <table className="w-full text-xs">
              <thead className="text-left text-subtle">
                <tr>
                  <th className="py-1 font-normal">Section</th>
                  <th className="py-1 text-right font-normal">Billed</th>
                  <th className="py-1 text-right font-normal">Deducted</th>
                </tr>
              </thead>
              <tbody>
                {year.map((r) => (
                  <tr key={r.sectionKey} className="border-t border-line">
                    <td className="py-1.5 text-text">
                      {sections.find((s) => s.key === r.sectionKey)?.oldSection ?? r.sectionKey}
                      {!r.overLimit && <span className="ml-1 text-subtle">(within the limit)</span>}
                      {r.shortfall > 0 && <span className="ml-1 text-danger">{money(r.shortfall)} not deducted</span>}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-text">{money(r.taxable)}</td>
                    <td className="py-1.5 text-right tabular-nums text-text">{money(r.deducted)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
      </CardContent>
    </Card>
  );
}
