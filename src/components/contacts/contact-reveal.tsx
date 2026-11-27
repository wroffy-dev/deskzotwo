"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye } from "lucide-react";
import { unmaskContact } from "@/actions/contact-unmask";
import { unmaskLead } from "@/actions/lead-unmask";
import { whatsappHref } from "@/components/ui/outbound-link";
import { AnchoredPopover, insideAnchoredPopover } from "@/components/ui/anchored-popover";

/**
 * "Show" beside a masked contact — or a lead on the Leads list (`kind="lead"`) (owner, 3 Nov 2026 — src/actions/contact-unmask.ts): reveals its unmaskable fields for
 * the day, against the daily limit leads use too, and refreshes so the screen reads them through field access again.
 *
 * It asks for a reason first, which may be left blank (owner, 5 Nov 2026 — Phase 3 masking fixes, audit M-10): a small
 * panel under the button with one line to type in and "Show" — Enter does it — kept with the reveal in the unmasking log.
 */
export function ContactReveal({ contactId, name, kind = "contact" }: { contactId: string; name: string; kind?: "contact" | "lead" }) {
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
      // A lead on the Leads list reveals what the list masks (src/actions/lead-unmask.ts); a contact, what masks it.
      const r = kind === "lead" ? await unmaskLead(contactId, "list", reason) : await unmaskContact(contactId, reason);
      setMessage(r.message);
      setOpen(false);
      if (r.result === "ALLOWED" || r.result === "REPEAT") router.refresh();
    });

  return (
    <span className="inline-flex items-center gap-1">
      <button
        ref={anchor}
        type="button"
        title={`Show ${name}'s details — counts once today against your unmasking limit`}
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
          aria-label={`Show ${name}'s details`}
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

/** A WhatsApp link for a contact: straight to wa.me, or — its number masked — through the server, which knows it. */
export function contactWhatsappHref(contact: { id: string; phone: string | null; masked?: { phone?: boolean } }): string | null {
  if (!contact.phone) return null;
  return contact.masked?.phone ? `/api/contacts/${contact.id}/whatsapp` : whatsappHref(contact.phone);
}
