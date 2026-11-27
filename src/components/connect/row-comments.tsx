"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { addRowComment, rowComments } from "@/actions/connect-review";
import type { RowComment } from "@/lib/connect/working";

/**
 * Comments on a company inside a Smart List (owner, 20 Nov 2026 — Deskzo Connect phase 3): internal by default; one
 * marked "Shared with guests" is seen — and answered — by the people the list is shared with. Internal ones never
 * reach a guest.
 */
export function RowComments({ workbookId, companyId }: { workbookId: string; companyId: string }) {
  const [data, setData] = useState<{ comments: RowComment[]; guests: number; teams: { id: string; name: string; guests: number }[] } | null | undefined>(undefined);
  const [body, setBody] = useState("");
  // "" internal, "all" every guest, or a team's id — that team only (owner, 20 Nov 2026).
  const [to, setTo] = useState("");
  const shared = to !== "";
  const [pending, start] = useTransition();

  useEffect(() => {
    let live = true;
    void rowComments(workbookId, companyId).then((d) => live && setData(d));
    return () => {
      live = false;
    };
  }, [workbookId, companyId]);

  if (data === undefined || data === null) return null;

  const send = () =>
    start(async () => {
      const r = await addRowComment({ workbookId, companyId, body, shared, to: to && to !== "all" ? to : null });
      if (!r.ok) return void toast.error(r.error);
      setData((d) => (d ? { ...d, comments: [...d.comments, r.data] } : d));
      setBody("");
    });

  return (
    <section className="space-y-2 border-t border-line pt-4">
      <h3 className="text-sm font-semibold text-text">Comments</h3>
      {data.comments.length === 0 && <p className="text-sm text-subtle">None yet.</p>}
      <ul className="space-y-2">
        {data.comments.map((c) => (
          <li key={c.id} className={c.shared ? "text-sm" : "rounded-base border border-warning/30 bg-warning-bg/40 px-2 py-1.5 text-sm"}>
            <span className="font-medium text-text">{c.author}</span>
            {c.byGuest && <span className="ml-1 rounded bg-text px-1 text-[9px] font-bold text-surface">GUEST</span>}
            <span className="ml-1 text-xs text-subtle">
              {new Date(c.at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
              {!c.shared && " · internal — guests don't see this"}
              {c.shared && c.team && (c.byGuest ? ` · ${c.team}` : ` · to ${c.team} only`)}
            </span>
            <p className="mt-0.5 whitespace-pre-wrap text-text">{c.body}</p>
          </li>
        ))}
      </ul>
      <Textarea aria-label="Write a comment" rows={3} value={body} maxLength={2000} placeholder={shared ? "Guests on this list will see this…" : "Only your team sees this…"} onChange={(e) => setBody(e.target.value)} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        {data.guests > 0 ? (
          <label className="flex items-center gap-2 text-xs text-muted">
            To
            <select value={to} onChange={(e) => setTo(e.target.value)} className="rounded-base border border-line bg-surface px-1.5 py-1 text-xs text-text">
              <option value="">Your team only (internal)</option>
              <option value="all">Every guest on this list ({data.guests})</option>
              {data.teams.length > 1 &&
                data.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    Only {t.name} ({t.guests})
                  </option>
                ))}
            </select>
          </label>
        ) : (
          <span className="text-xs text-subtle">Internal — this list isn&apos;t shared with guests.</span>
        )}
        <Button size="sm" onClick={send} disabled={pending || !body.trim()}>
          {pending ? "Sending…" : "Send"}
        </Button>
      </div>
    </section>
  );
}
