"use client";

import { useEffect, useState, useTransition } from "react";
import { Mail, Phone } from "lucide-react";
import { SidePane } from "@/components/ui/side-pane";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { guestComment, guestCorrect, guestRow } from "@/actions/connect-public";
import { previewGuestRow } from "@/actions/connect";
import type { GuestRowDetail } from "@/lib/connect/working";

/**
 * A company's page for a guest (owner, 20 Nov 2026 — Deskzo Connect phase 3): who to reach at the workspace about it,
 * the comments shared with them — they write shared ones too — and a correction to suggest. Company details are the
 * workspace's: a guest never edits them, only suggests.
 */
export function GuestRowPage({ shareId, row, onClose, previewGuestId }: { shareId: string; row: { id: string; name: string; place: string }; onClose: () => void; previewGuestId?: string }) {
  const [detail, setDetail] = useState<GuestRowDetail | null | undefined>(undefined);
  const [body, setBody] = useState("");
  const [correcting, setCorrecting] = useState(false);
  const [correction, setCorrection] = useState("");
  const [pending, start] = useTransition();

  useEffect(() => {
    let live = true;
    void (previewGuestId ? previewGuestRow(previewGuestId, shareId, row.id) : guestRow(shareId, row.id)).then((d) => live && setDetail(d));
    return () => {
      live = false;
    };
  }, [shareId, row.id, previewGuestId]);

  const send = () =>
    start(async () => {
      const r = await guestComment({ shareId, companyId: row.id, body });
      if (!r.ok) return void toast.error(r.error);
      setDetail((d) => (d ? { ...d, comments: [...d.comments, r.comment] } : d));
      setBody("");
    });

  const correct = () =>
    start(async () => {
      const r = await guestCorrect({ shareId, companyId: row.id, note: correction });
      if (!r.ok) return void toast.error(r.error);
      toast.success("Sent. They'll look at it and change it if it's right.");
      setCorrection("");
      setCorrecting(false);
    });

  return (
    <SidePane open onClose={onClose} title={row.name}>
      {detail === undefined ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : detail === null ? (
        <p className="text-sm text-muted">This row isn&apos;t in a list shared with you any more.</p>
      ) : (
        <div className="space-y-5">
          {row.place && <p className="text-xs text-muted">{row.place}</p>}

          {/* A row of a list of its own (Smart Lists phase 3) has no account owner to name, nothing to correct. */}
          {!detail.own && (
          <section aria-label="Your contact" className="space-y-2 rounded-card border border-brand/30 bg-brand-subtle/40 p-4">
            <p className="text-[11px] font-bold uppercase tracking-wide text-brand">Your contact</p>
            {detail.contact ? (
              <>
                <p className="font-semibold text-text">{detail.contact.name}</p>
                <div className="space-y-1 text-sm">
                  {detail.contact.email && (
                    <a href={`mailto:${detail.contact.email}`} className="flex items-center gap-2 text-brand hover:underline">
                      <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                      {detail.contact.email}
                    </a>
                  )}
                  {detail.contact.phone && (
                    <a href={`tel:${detail.contact.phone.replace(/\s+/g, "")}`} className="flex items-center gap-2 text-brand hover:underline">
                      <Phone className="h-3.5 w-3.5" aria-hidden="true" />
                      {detail.contact.phone}
                    </a>
                  )}
                </div>
              </>
            ) : (
              <p className="text-sm text-muted">Nobody is named for this company yet — comment below and the list&apos;s owner will see it.</p>
            )}
          </section>
          )}

          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-text">Comments</h3>
            {detail.comments.length === 0 && <p className="text-sm text-subtle">None yet.</p>}
            <ul className="space-y-2">
              {detail.comments.map((c) => (
                <li key={c.id} className="text-sm">
                  <span className="font-medium text-text">{c.author}</span>
                  {c.byGuest && <span className="ml-1 rounded bg-text px-1 text-[9px] font-bold text-surface">GUEST</span>}
                  <span className="ml-1 text-xs text-subtle">{new Date(c.at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</span>
                  <p className="mt-0.5 whitespace-pre-wrap text-text">{c.body}</p>
                </li>
              ))}
            </ul>
            {previewGuestId ? (
              <p className="text-xs text-subtle">View only — they&apos;d write a comment here.</p>
            ) : (
              <>
            <Textarea aria-label="Write a comment" rows={3} value={body} maxLength={2000} placeholder="Write to the people you work with on this…" onChange={(e) => setBody(e.target.value)} />
            <div className="flex justify-end">
              <Button size="sm" onClick={send} disabled={pending || !body.trim()}>
                {pending ? "Sending…" : "Send"}
              </Button>
            </div>
              </>
            )}
          </section>

          {!previewGuestId && !detail.own && (
          <section className="space-y-2 border-t border-line pt-4">
            {!correcting ? (
              <button type="button" className="text-sm text-brand hover:underline" onClick={() => setCorrecting(true)}>
                Something wrong about this company? Suggest a correction
              </button>
            ) : (
              <>
                <h3 className="text-sm font-semibold text-text">Suggest a correction</h3>
                <Textarea aria-label="What should change" rows={3} value={correction} maxLength={1000} placeholder="Their GSTIN changed to…, they moved to…" onChange={(e) => setCorrection(e.target.value)} />
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setCorrecting(false)}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={correct} disabled={pending || !correction.trim()}>
                    Send
                  </Button>
                </div>
              </>
            )}
          </section>
          )}
        </div>
      )}
    </SidePane>
  );
}
