"use client";

import { useState, useTransition } from "react";
import { CircleAlert, LoaderCircle, ShieldCheck } from "lucide-react";
import type { GstTreatment } from "@prisma/client";
import { checkGstin } from "@/actions/gstin";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { useClock } from "@/components/time/clock-provider";
import { GST_STATE_CODES } from "@/lib/gst-engine";
import {
  gstinNotes,
  gstinStatusLabels,
  gstinStatusMeaning,
  gstinStatusTone,
  lookupReady,
  normalizeGstin,
  treatmentForTaxpayerType,
  type GstinCheckView,
} from "@/lib/gstin/notes";

/** What a check found that a form can take: the GST system's name, address, state and treatment. */
export type GstinDetailsToUse = {
  name: string | null;
  address: string | null;
  state: string | null;
  pincode: string | null;
  treatment: GstTreatment | null;
};

/**
 * Under a customer's or vendor's GSTIN field (owner, 25 Oct 2026; src/lib/gstin): what the number itself says
 * as it's typed — a mistyped character, another state, another company's PAN, a treatment that doesn't fit —
 * and "Check with GST", which asks the GST system whether it is real and active and whose it is. A form that
 * can take the answer offers "Use these details".
 */
export function GstinAssist({
  gstin,
  state,
  companyPan,
  treatment,
  saved,
  onUse,
}: {
  gstin: string;
  state?: string | null;
  companyPan?: string | null;
  treatment?: string | null;
  /** The check already on file for this GSTIN, if any. */
  saved?: GstinCheckView | null;
  onUse?: (details: GstinDetailsToUse) => void;
}) {
  const value = normalizeGstin(gstin);
  const notes = gstinNotes({ gstin: value, state, companyPan, treatment });
  if (!value && notes.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {notes.length > 0 && (
        <ul className="space-y-0.5">
          {notes.map((n) => (
            <li key={n} className="flex items-start gap-1.5 text-xs text-warning">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {n}
            </li>
          ))}
        </ul>
      )}
      {value && <GstinLiveCheck gstin={value} saved={saved} onUse={onUse} />}
    </div>
  );
}

/** "Check with GST" and its answer, for a GSTIN already typed — on its own in the side rail's lookup. */
export function GstinLiveCheck({ gstin, saved, onUse }: { gstin: string; saved?: GstinCheckView | null; onUse?: (details: GstinDetailsToUse) => void }) {
  const value = normalizeGstin(gstin);
  const [result, setResult] = useState<{ check: GstinCheckView; reused: boolean } | null>(null);
  const [error, setError] = useState<{ gstin: string; message: string } | null>(null);
  const [pending, start] = useTransition();
  const shown = result?.check.gstin === value ? result : saved?.gstin === value ? { check: saved, reused: true } : null;
  const ready = lookupReady(value);

  const ask = () =>
    start(async () => {
      setError(null);
      const r = await checkGstin({ gstin: value, fresh: !!shown });
      if (!r.ok) return setError({ gstin: value, message: r.error });
      setResult(r.data);
    });

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="secondary" disabled={!ready || pending} onClick={ask} title={ready ? undefined : "Fix the GSTIN first"}>
          {pending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />}
          {shown ? "Check again" : "Check with GST"}
        </Button>
        {error?.gstin === value && <span className="text-xs text-danger">{error.message}</span>}
      </div>
      {shown && <GstinCheckCard check={shown.check} reused={shown.reused} onUse={onUse} />}
    </div>
  );
}

/** One check's answer: the status and what it means, then whose GSTIN it is and where. */
export function GstinCheckCard({ check, reused, onUse }: { check: GstinCheckView; reused?: boolean; onUse?: (details: GstinDetailsToUse) => void }) {
  const clock = useClock();
  const stateName = check.stateCode ? (GST_STATE_CODES[check.stateCode] ?? null) : null;
  const known = check.status !== "NOT_FOUND";
  return (
    <div className="space-y-1.5 rounded-base border border-line bg-surface-sunken px-3 py-2.5 text-sm" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={gstinStatusTone[check.status]}>{gstinStatusLabels[check.status]}</Badge>
        {check.blocked && <Badge tone="red">Blocked for e-way bills</Badge>}
        <span className="text-xs text-muted">
          {reused ? "Checked" : "Just checked"} {clock.date(check.checkedAt)}
          {check.source === "mock" ? " · the mock portal, not the GST system" : " · GST system"}
        </span>
      </div>
      <p className="text-xs text-muted">
        {gstinStatusMeaning[check.status]}
        {check.blocked ? " Their returns are behind, so the GST system won't make e-way bills for them." : ""}
      </p>
      {known && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          {check.legalName && (
            <>
              <dt className="text-muted">Legal name</dt>
              <dd className="text-text">{check.legalName}</dd>
            </>
          )}
          {check.tradeName && check.tradeName !== check.legalName && (
            <>
              <dt className="text-muted">Trade name</dt>
              <dd className="text-text">{check.tradeName}</dd>
            </>
          )}
          {(check.address || check.pincode) && (
            <>
              <dt className="text-muted">Address</dt>
              <dd className="text-text">{[check.address, check.pincode].filter(Boolean).join(" ")}</dd>
            </>
          )}
          {stateName && (
            <>
              <dt className="text-muted">State</dt>
              <dd className="text-text">
                {stateName} ({check.stateCode})
              </dd>
            </>
          )}
          {check.taxpayerType && (
            <>
              <dt className="text-muted">Type</dt>
              <dd className="text-text">{check.taxpayerType === "REG" ? "Regular" : check.taxpayerType === "COM" ? "Composition" : check.taxpayerType}</dd>
            </>
          )}
        </dl>
      )}
      {known && onUse && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() =>
            onUse({
              name: check.tradeName || check.legalName,
              address: check.address,
              state: stateName,
              pincode: check.pincode && /^\d{6}$/.test(check.pincode) ? check.pincode : null,
              treatment: treatmentForTaxpayerType(check.taxpayerType),
            })
          }
        >
          Use these details
        </Button>
      )}
    </div>
  );
}
