"use client";

import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { acButton, acInput } from "@/components/access-control/ui";
import type { SaveOptions } from "@/components/access-control/scope/reach";
import { cn } from "@/lib/utils";

/**
 * Staged changes, and the two places they are saved from: the title row's "N staged · Reset · Save",
 * as the design draws it, and a bar that stays at the foot of the window while anything is staged, so
 * Save is in reach from the bottom of a long grid.
 */

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function StagedActions({ count, saving, saveLabel, canSave, onReset, onSave }: { count: number; saving: boolean; saveLabel: string; canSave: boolean; onReset: () => void; onSave: () => void }) {
  if (!canSave) return null;
  return (
    <>
      {count > 0 && <span className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-subtle px-2.5 text-xs font-semibold text-brand">{count} staged</span>}
      <button type="button" className={acButton.secondary} disabled={count === 0 || saving} onClick={onReset}>
        Reset
      </button>
      <button type="button" className={acButton.primary} disabled={count === 0 || saving} onClick={onSave}>
        <Save className="h-[18px] w-[18px]" aria-hidden />
        {saving ? "Saving…" : saveLabel}
      </button>
    </>
  );
}

export function StickySaveBar({ count, saving, saveLabel, onDiscard, onSave }: { count: number; saving: boolean; saveLabel: string; onDiscard: () => void; onSave: () => void }) {
  if (count === 0) return null;
  return (
    <div className="sticky bottom-4 z-10 mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-line-strong bg-surface px-4 py-2.5 shadow-lg">
      <span className="font-semibold text-text">{plural(count, "unsaved change")}</span>
      <span className="min-w-0 flex-1 text-xs text-subtle">Nothing applies until you save. Enforced on the server for every request — not just hidden in the menu.</span>
      <button type="button" className={acButton.secondary} disabled={saving} onClick={onDiscard}>
        Discard
      </button>
      <button type="button" className={acButton.primary} disabled={saving} onClick={onSave}>
        <Save className="h-[18px] w-[18px]" aria-hidden />
        {saving ? "Saving…" : saveLabel}
      </button>
    </div>
  );
}

/**
 * Saving for one person asks once for a reason and an end date, as their own page always has: the
 * exceptions go into the permission history with the reason, and an end date makes them temporary.
 */
export function OverrideDialog({ open, count, name, saving, onClose, onConfirm }: { open: boolean; count: number; name: string; saving: boolean; onClose: () => void; onConfirm: (options: SaveOptions) => void }) {
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  return (
    <Dialog open={open} onClose={() => !saving && onClose()} title={`Save ${plural(count, "override")} for ${name}`}>
      <div className="space-y-3 text-[13px]">
        <p className="text-muted">Overrides sit on the person, above their role. They are written to the permission history with this reason; an end date makes them temporary.</p>
        <div className="flex flex-col gap-1">
          <label htmlFor="ac-scope-reason" className="text-xs font-medium text-muted">
            Reason (optional)
          </label>
          <input id="ac-scope-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Covering collections this week" className={cn(acInput, "w-full")} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="ac-scope-until" className="text-xs font-medium text-muted">
            Until (optional)
          </label>
          <input id="ac-scope-until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} className={cn(acInput, "w-48")} />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={acButton.secondary} disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={acButton.primary} disabled={saving} onClick={() => onConfirm({ reason: reason.trim() || undefined, expiresAt: until || null })}>
            {saving ? "Saving…" : "Save overrides"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** The browser's own "leave this page?" while changes are staged — a reload or a closed tab would drop them. */
export function useLeaveGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
}
