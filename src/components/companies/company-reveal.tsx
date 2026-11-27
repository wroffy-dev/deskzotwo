"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye } from "lucide-react";
import { unmaskCompany } from "@/actions/company-unmask";
import { AnchoredPopover, insideAnchoredPopover } from "@/components/ui/anchored-popover";

/**
 * "Show" beside a company's masked fields on its page (owner, 5 Nov 2026 — Phase 3 masking fixes, wave B;
 * src/actions/company-unmask.ts): reveals its address, GSTINs, PAN, website and custom fields that this person may unmask,
 * for the rest of the day, against the same daily limit as leads and contacts — then refreshes, so the page reads them
 * through field access again. Its name is never masked, so there is nothing of that to show.
 *
 * As a contact's "Show" (src/components/contacts/contact-reveal.tsx): one small panel with a reason, which may be left
 * blank, and "Show" — Enter does it — the reason kept with the reveal in the unmasking log.
 */
export function CompanyReveal({ companyId, name }: { companyId: string; name: string }) {
  const router = useRouter();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (anchor.current?.contains(e.target as Node) || insideAnchoredPopover(e.target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const reveal = () =>
    start(async () => {
      const r = await unmaskCompany(companyId, reason);
      setMessage(r.message);
      setOpen(false);
      if (r.result === "ALLOWED" || r.result === "REPEAT") router.refresh();
    });

  return (
    <span className="inline-flex items-center gap-1">
      <button
        ref={anchor}
        type="button"
        title={`Show ${name}'s masked details — counts once today against your unmasking limit`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={pending}
        onClick={() => {
          setMessage(null);
          setOpen((v) => !v);
        }}
        className="inline-flex items-center gap-1 rounded-base px-1.5 py-0.5 text-xs text-brand hover:bg-brand/10 disabled:opacity-50"
      >
        <Eye className="h-3.5 w-3.5" /> {pending ? "…" : "Show"}
      </button>
      <AnchoredPopover anchorRef={anchor} open={open} width={260} align="end">
        <form
          role="dialog"
          aria-label={`Show ${name}'s masked details`}
          className="space-y-2 p-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!pending) reveal();
          }}
        >
          <p className="text-xs text-muted">Shown for the rest of today — counts once against your daily unmasking limit.</p>
          <input
            autoFocus
            aria-label="Reason (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={200}
            placeholder="Reason (optional)"
            className="h-8 w-full rounded-base border border-line-strong bg-surface px-2 text-xs text-text placeholder:text-subtle focus-visible:border-brand"
          />
          <div className="flex justify-end gap-1.5">
            <button type="button" onClick={() => setOpen(false)} className="rounded-base px-2 py-1 text-xs text-muted hover:bg-surface-sunken">
              Cancel
            </button>
            <button type="submit" disabled={pending} className="inline-flex items-center gap-1 rounded-base bg-brand px-2 py-1 text-xs font-medium text-brand-contrast hover:brightness-110 disabled:opacity-50">
              <Eye className="h-3.5 w-3.5" /> Show
            </button>
          </div>
        </form>
      </AnchoredPopover>
      {message && <span className="text-[11px] text-danger">{message}</span>}
    </span>
  );
}
