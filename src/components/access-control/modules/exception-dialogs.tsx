"use client";

import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { acButton, acInput } from "@/components/access-control/ui";
import { cn } from "@/lib/utils";

/** A calendar day `days` from today, as the date input and the actions take it (YYYY-MM-DD, local). */
function dayFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const ENDS = [
  { v: "never", l: "Never" },
  { v: "1", l: "In 1 day" },
  { v: "7", l: "In 7 days" },
  { v: "30", l: "In 30 days" },
  { v: "date", l: "On a date…" },
] as const;

/**
 * The step between "Save as exceptions" and the save, for a person: one reason and one end for every
 * exception being written. Both are the exception's own (UserPermission) — the reason goes into the
 * permission history, and an end date is the last day it applies, after which they are back on their
 * role without anybody remembering to undo it.
 */
export function SaveExceptionsDialog({
  name,
  count,
  removing,
  busy,
  onClose,
  onSave,
}: {
  name: string;
  count: number;
  /** How many of them only put an answer back to the role's — those carry no reason or end. */
  removing: number;
  busy: boolean;
  onClose: () => void;
  onSave: (options: { reason?: string; expiresAt: string | null }) => void;
}) {
  const [reason, setReason] = useState("");
  const [ends, setEnds] = useState<(typeof ENDS)[number]["v"]>("never");
  const [date, setDate] = useState("");
  const until = ends === "never" ? null : ends === "date" ? date || null : dayFromNow(Number(ends));
  const incomplete = ends === "date" && !date;

  return (
    <Dialog open onClose={() => !busy && onClose()} title={`Save ${count} ${count === 1 ? "exception" : "exceptions"} for ${name}`}>
      <div className="flex flex-col gap-3 text-[13px]">
        <p className="text-muted">
          Exceptions sit on top of the person&apos;s role and are logged individually.
          {removing > 0 && ` ${removing} of these ${removing === 1 ? "puts an answer" : "put answers"} back to the role's, which needs no reason or end.`}
        </p>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-text/80">Reason (optional)</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder="Covering collections this week"
            className={cn(acInput, "h-auto resize-y py-2")}
          />
        </label>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-text/80">Expires</span>
            <select value={ends} onChange={(e) => setEnds(e.target.value as typeof ends)} className={cn(acInput, "min-w-[150px]")}>
              {ENDS.map((o) => (
                <option key={o.v} value={o.v}>
                  {o.l}
                </option>
              ))}
            </select>
          </label>
          {ends === "date" && <input type="date" aria-label="Last day it applies" min={dayFromNow(0)} value={date} onChange={(e) => setDate(e.target.value)} className={acInput} />}
        </div>
        <p className="text-xs text-subtle">{until ? `Applies up to the end of ${until}, then they are back on their role.` : "With no end date an exception stays until somebody removes it."}</p>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={acButton.secondary} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={acButton.primary} disabled={busy || incomplete} onClick={() => onSave({ reason: reason.trim() || undefined, expiresAt: until })}>
            {busy ? "Saving…" : "Save exceptions"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * A live exception's end date, changed without re-stating it (`extendUserPermission`): "this cover is
 * running another fortnight" shouldn't mean re-typing the reason — which is how a temporary grant gets
 * made permanent by accident.
 */
export function ExceptionEndDialog({
  name,
  permission,
  until,
  busy,
  onClose,
  onSave,
}: {
  name: string;
  permission: string;
  /** The last day it applies now, in words; null when it has no end. */
  until: string | null;
  busy: boolean;
  onClose: () => void;
  onSave: (expiresAt: string | null) => void;
}) {
  const [date, setDate] = useState("");
  return (
    <Dialog open onClose={() => !busy && onClose()} title={`Change when “${permission}” ends for ${name}`}>
      <div className="flex flex-col gap-3 text-[13px]">
        <p className="text-muted">{until ? `This exception applies until ${until}.` : "This exception has no end date."} The answer and its reason stay as they are.</p>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-text/80">Last day it applies</span>
          <input type="date" min={dayFromNow(0)} value={date} onChange={(e) => setDate(e.target.value)} className={cn(acInput, "w-48")} />
        </label>
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button type="button" className={acButton.secondary} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {until && (
            <button type="button" className={acButton.secondary} onClick={() => onSave(null)} disabled={busy}>
              Remove the end date
            </button>
          )}
          <button type="button" className={acButton.primary} disabled={busy || !date} onClick={() => onSave(date)}>
            {busy ? "Saving…" : "Save end date"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
