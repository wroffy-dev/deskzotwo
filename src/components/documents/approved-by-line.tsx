"use client";

import { useState } from "react";
import { BadgeCheck } from "lucide-react";
import { useClock } from "@/components/time/clock-provider";

/**
 * "Approved by: Sachin Chauhan · View approval details" (owner, 3 Nov 2026 — as Zoho shows it): one quiet line once a
 * document's sign-off is done and it has gone out, in place of the approval bar. The details are who asked, who
 * approved, when, and what they said.
 */
export function ApprovedByLine({
  approvedBy,
  approvedAt,
  submittedBy,
  submittedAt,
  note,
}: {
  approvedBy: string;
  approvedAt: Date | string | null;
  submittedBy: string | null;
  submittedAt: Date | string | null;
  note: string | null;
}) {
  const clock = useClock();
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted">
        <span>Approved by:</span>
        <span className="inline-flex items-center gap-1 font-medium text-text">
          <BadgeCheck className="h-4 w-4 text-success" aria-hidden /> {approvedBy}
        </span>
        <span aria-hidden className="text-subtle">
          •
        </span>
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="text-brand hover:underline">
          {open ? "Hide approval details" : "View approval details"}
        </button>
      </div>
      {open && (
        <dl className="mt-2 grid max-w-md grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-xs">
          {submittedBy && (
            <>
              <dt className="text-subtle">Submitted by</dt>
              <dd className="text-text">
                {submittedBy}
                {submittedAt ? ` · ${clock.dateTimeShort(submittedAt)}` : ""}
              </dd>
            </>
          )}
          <dt className="text-subtle">Approved by</dt>
          <dd className="text-text">
            {approvedBy}
            {approvedAt ? ` · ${clock.dateTimeShort(approvedAt)}` : ""}
          </dd>
          {note && (
            <>
              <dt className="text-subtle">Note</dt>
              <dd className="whitespace-pre-line text-text">{note}</dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}
