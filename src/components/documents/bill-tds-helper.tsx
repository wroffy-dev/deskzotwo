"use client";

import { useEffect, useRef, useState } from "react";
import { CircleAlert, Info } from "lucide-react";
import { tdsAdviceForBill } from "@/actions/tds";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { TDS_SECTIONS, sectionOf } from "@/lib/tds/sections";
import { effectiveRate, type TdsAdvice } from "@/lib/tds/rules";

type Advice = { sectionKey: string; advice: TdsAdvice; pan: string | null; usualSectionKey: string | null; yearSoFar: number };

const OTHER = "__other";

/**
 * A vendor bill's TDS (src/lib/tds), under its totals: the section from a list rather than typed — the vendor's
 * usual one to start with — and the rate it should deduct at, with why: the vendor's PAN, a lower deduction
 * certificate, or the year's limits not crossed yet. The rate fills itself until somebody types one; a bill that
 * should deduct and doesn't says so.
 */
export function BillTdsHelper({
  companyId,
  documentId,
  issueDate,
  taxableValue,
  mode,
  section,
  rate,
  onMode,
  onSection,
  onRate,
}: {
  companyId: string;
  documentId: string | null;
  issueDate: string;
  taxableValue: number;
  mode: string;
  section: string;
  rate: string | number;
  onMode: (mode: "NONE" | "TDS") => void;
  onSection: (section: string) => void;
  onRate: (rate: string) => void;
}) {
  const [advice, setAdvice] = useState<Advice | null>(null);
  // The rate follows the advice until somebody types one; an edited bill keeps the rate it was saved with.
  const rateTyped = useRef(documentId !== null);
  const known = sectionOf(section);
  const [other, setOther] = useState(!!section && !known);

  useEffect(() => {
    if (!companyId) return;
    let live = true;
    const timer = setTimeout(async () => {
      // Advice only: a refusal or a dropped connection leaves the bill as it is, saying nothing.
      const got = await tdsAdviceForBill({ companyId, sectionKey: known?.key ?? null, amount: taxableValue, day: issueDate, documentId }).catch(() => null);
      if (!live) return;
      setAdvice(got);
      // A new bill to a vendor with a usual section starts from it.
      if (got && !section && got.usualSectionKey && !documentId) onSection(got.usualSectionKey);
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // onSection is the form's setter, stable; section is read for the first fill only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, known?.key, taxableValue, issueDate, documentId]);

  const suggested = advice ? effectiveRate(advice.advice, taxableValue) : null;
  useEffect(() => {
    if (mode !== "TDS" || rateTyped.current || suggested === null || !advice?.advice.due) return;
    if (Number(rate) !== suggested) onRate(String(suggested));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggested, mode, advice?.advice.due]);

  const note = advice?.advice.note;
  return (
    <div className="space-y-1.5">
      {mode === "TDS" && (
        <div className="flex flex-wrap items-center gap-2 pl-1">
          <Select
            aria-label="TDS section"
            className="h-8 w-56"
            value={other ? OTHER : (known?.key ?? "")}
            onChange={(e) => {
              if (e.target.value === OTHER) {
                setOther(true);
                onSection("");
                return;
              }
              setOther(false);
              rateTyped.current = false;
              onSection(e.target.value);
            }}
          >
            <option value="">Choose the section…</option>
            {TDS_SECTIONS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.oldSection} — {s.label}
              </option>
            ))}
            <option value={OTHER}>Another section…</option>
          </Select>
          {other && <Input value={section} onChange={(e) => onSection(e.target.value)} placeholder="Section" className="h-8 w-28" aria-label="TDS section, typed" />}
          <Input
            type="number"
            step="0.01"
            min="0"
            value={rate}
            onChange={(e) => {
              rateTyped.current = true;
              onRate(e.target.value);
            }}
            placeholder="Rate"
            className="h-8 w-20 text-right"
            aria-label="TDS rate"
          />
          <span className="text-xs text-subtle">% of taxable value</span>
        </div>
      )}
      {note && (mode === "TDS" || advice?.advice.due) && (
        <p className={`flex items-start gap-1.5 pl-1 text-xs ${advice?.advice.basis === "NO_PAN" || advice?.advice.shortfall ? "text-warning" : "text-muted"}`}>
          {advice?.advice.basis === "NO_PAN" || advice?.advice.shortfall ? <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
          <span>
            {mode === "NONE" ? `TDS is due on this bill. ${note}` : note}
            {mode === "TDS" && suggested !== null && advice?.advice.due && Number(rate) !== suggested && (
              <>
                {" "}
                <button
                  type="button"
                  className="text-brand hover:underline"
                  onClick={() => {
                    rateTyped.current = false;
                    onRate(String(suggested));
                  }}
                >
                  Use {suggested}%
                </button>
              </>
            )}
          </span>
        </p>
      )}
      {mode === "NONE" && advice?.advice.due && (
        <div className="pl-1">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              rateTyped.current = false;
              onMode("TDS");
              if (!known) onSection(advice.sectionKey);
              if (suggested !== null) onRate(String(suggested));
            }}
          >
            Deduct TDS at {suggested}%
          </Button>
        </div>
      )}
    </div>
  );
}
