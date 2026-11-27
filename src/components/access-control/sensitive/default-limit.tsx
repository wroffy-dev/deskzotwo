"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setUnmaskDefaultLimit, type UnmaskDefaultLimitState } from "@/actions/unmask-log";
import { Dialog } from "@/components/ui/dialog";
import { confirmAction } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { acButton, acInput } from "@/components/access-control/ui";
import { cn } from "@/lib/utils";

export const LIMIT_PRESETS = [10, 25, 50, 100];

/**
 * The workspace's default daily unmasking limit, changed from a dialog: how many leads, contacts and
 * companies somebody granted unmask may reveal a day when neither they nor their role has a limit — 25
 * until it is changed. "No limit" is a choice of its own, ticked and confirmed, never what an empty field
 * means. The super admin's to change (`state.mayChange`); for everybody else this draws nothing, and the
 * screen beside it says what the default is.
 */
export function DefaultLimitButton({ state, className, children }: { state: UnmaskDefaultLimitState; className?: string; children: React.ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [unlimited, setUnlimited] = useState(state.dailyLimit === null);
  const [value, setValue] = useState(state.dailyLimit === null ? "" : String(state.dailyLimit));
  const [pending, start] = useTransition();
  if (!state.mayChange) return null;

  const dirty = unlimited !== (state.dailyLimit === null) || (!unlimited && value !== String(state.dailyLimit ?? ""));

  function show() {
    setUnlimited(state.dailyLimit === null);
    setValue(state.dailyLimit === null ? "" : String(state.dailyLimit));
    setOpen(true);
  }

  async function save() {
    if (
      unlimited &&
      !(await confirmAction({
        title: "No default limit?",
        message: "Everybody granted unmask with no limit of their own or their role's will be able to unmask as many leads and contacts a day as they like.",
        confirmLabel: "Save no limit",
        danger: true,
      }))
    )
      return;
    start(async () => {
      const result = await setUnmaskDefaultLimit(unlimited ? { limited: false } : { limited: true, dailyLimit: value });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(unlimited ? "Default daily limit removed — no limit" : `Default daily limit set to ${value} a day`);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <button type="button" onClick={show} className={className}>
        {children}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Default daily unmasking limit">
        <div className="space-y-4 text-[13px] text-text">
          <p className="leading-[1.5] text-muted">
            For anybody who may unmask a field and has no daily limit of their own or their role&apos;s. Each lead, contact or company shown counts once a day; a role&apos;s or a
            person&apos;s own limit, where one is set, comes first.
          </p>
          {state.changedAtText && (
            <p className="text-xs text-subtle">
              Last changed {state.changedBy ? `by ${state.changedBy}, ` : ""}
              {state.changedAtText}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="ac-default-limit" className="sr-only">
              Records a day
            </label>
            <input
              id="ac-default-limit"
              inputMode="numeric"
              value={unlimited ? "" : value}
              disabled={unlimited || pending}
              onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))}
              placeholder={unlimited ? "No limit" : "25"}
              className={cn(acInput, "w-24 text-right disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:opacity-55")}
            />
            <span className="text-xs text-subtle">records a day</span>
            {!unlimited &&
              LIMIT_PRESETS.map((n) => (
                <button key={n} type="button" onClick={() => setValue(String(n))} className="h-8 rounded-md border border-line px-2.5 text-xs text-muted transition-colors hover:bg-surface-sunken">
                  {n}
                </button>
              ))}
          </div>
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={unlimited} disabled={pending} onChange={(e) => setUnlimited(e.target.checked)} className="h-4 w-4 accent-[var(--color-brand)]" />
            No limit
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={() => setOpen(false)} className={acButton.secondary}>
              Cancel
            </button>
            <button type="button" onClick={save} disabled={pending || !dirty || (!unlimited && value.trim() === "")} className={acButton.primary}>
              {pending ? "Saving…" : "Save default"}
            </button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
