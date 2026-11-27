"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { History, MessageSquare, Send, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { commentOnRow, deleteRowComment, rowActivity, type RowActivity } from "@/actions/smart-list-team";

/**
 * A row's comments and history on its page (owner, 20 Nov 2026 — Smart Lists phase 3). Comments are for a list of its
 * own rows — a list of companies keeps Deskzo Connect's comments above this — and "@Full Name" tells that person, as in
 * team chat: typing "@" offers the people who may open the list. The history is every list's: what changed, who, when.
 */

const MENTION = /(^|\s)@([^\s@]{0,30})$/;
const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export function RowActivityPanel({ workbookId, rowKey, own, canEdit }: { workbookId: string; rowKey: string; own: boolean; canEdit: boolean }) {
  const [data, setData] = useState<RowActivity | null>(null);
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [to, setTo] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let live = true;
    void rowActivity(workbookId, rowKey).then((d) => live && setData(d));
    return () => {
      live = false;
    };
  }, [workbookId, rowKey]);

  const typed = MENTION.exec(draft.slice(0, caret))?.[2] ?? null;
  const offers = useMemo(() => (typed === null || !data ? [] : data.people.filter((p) => p.name.toLowerCase().includes(typed.toLowerCase())).slice(0, 6)), [typed, data]);
  const pick = (name: string) => {
    const before = draft.slice(0, caret).replace(MENTION, (_m, lead: string) => `${lead}@${name} `);
    const next = before + draft.slice(caret);
    setDraft(next);
    setCaret(before.length);
    window.setTimeout(() => {
      box.current?.focus();
      box.current?.setSelectionRange(before.length, before.length);
    }, 0);
  };

  const send = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    const r = await commentOnRow({ workbookId, rowId: rowKey, body: draft, to });
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    setData((d) => (d ? { ...d, comments: [...(d.comments ?? []), r.data.comment] } : d));
    setDraft("");
    if (r.data.told) toast.success(`${r.data.told} ${r.data.told === 1 ? "person" : "people"} told.`);
  };

  const remove = async (id: string) => {
    const r = await deleteRowComment(id);
    if (!r.ok) return void toast.error(r.error);
    setData((d) => (d ? { ...d, comments: (d.comments ?? []).filter((c) => c.id !== id) } : d));
  };

  // "@Name" shown in the brand colour — split on the names offered, never as HTML.
  const names = useMemo(() => [...(data?.people ?? [])].sort((a, b) => b.name.length - a.name.length).map((p) => `@${p.name}`), [data]);
  const withMentions = (text: string) => {
    if (!names.length) return text;
    const parts: (string | { m: string })[] = [text];
    for (const n of names) {
      for (let i = 0; i < parts.length; i += 1) {
        const p = parts[i];
        if (typeof p !== "string") continue;
        const at = p.toLowerCase().indexOf(n.toLowerCase());
        if (at < 0) continue;
        parts.splice(i, 1, p.slice(0, at), { m: p.slice(at, at + n.length) }, p.slice(at + n.length));
      }
    }
    return parts.map((p, i) => (typeof p === "string" ? p : <span key={i} className="font-medium text-brand">{p.m}</span>));
  };

  if (!data) return <p className="text-xs text-subtle">Loading its comments and history…</p>;
  const history = showAll ? data.history : data.history.slice(0, 8);

  return (
    <div className="space-y-5">
      {own && data.comments && (
        <section className="space-y-2 border-t border-line pt-4">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text">
            <MessageSquare className="h-4 w-4 text-subtle" aria-hidden="true" />
            Comments
          </h3>
          <ul className="space-y-2">
            {data.comments.map((c) => (
              <li key={c.id} className="group rounded-base bg-surface-sunken px-3 py-2 text-sm">
                <div className="mb-0.5 flex items-center gap-2 text-xs text-subtle">
                  <span className="font-medium text-muted">{c.author ?? "Somebody"}</span>
                  {c.byGuest && <span className="rounded bg-info-bg px-1 text-info">guest</span>}
                  {c.byGuest && c.team && <span>{c.team}</span>}
                  {!c.byGuest && c.shared && <span className="rounded bg-brand-subtle px-1 text-brand">{c.team ? `to ${c.team}` : "guests see it"}</span>}
                  <span>{when(c.at)}</span>
                  {(c.mine || canEdit) && (
                    <button type="button" aria-label="Delete this comment" className="ml-auto rounded p-0.5 opacity-0 hover:text-danger focus:opacity-100 group-hover:opacity-100" onClick={() => remove(c.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <p className="whitespace-pre-wrap text-text">{withMentions(c.body)}</p>
              </li>
            ))}
            {data.comments.length === 0 && <li className="text-xs text-subtle">No comments yet.</li>}
          </ul>
          <div className="relative">
            <textarea
              ref={box}
              aria-label="Write a comment"
              rows={2}
              maxLength={2000}
              value={draft}
              placeholder="Write a comment — @ to mention somebody"
              className="w-full rounded-base border border-line-strong bg-surface px-3 py-2 text-sm text-text outline-none focus:border-brand"
              onChange={(e) => {
                setDraft(e.target.value);
                setCaret(e.target.selectionStart ?? e.target.value.length);
              }}
              onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
              onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
              onKeyDown={(e) => {
                if (offers.length && (e.key === "Tab" || e.key === "Enter")) {
                  e.preventDefault();
                  pick(offers[0]!.name);
                } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            {offers.length > 0 && (
              <ul role="listbox" aria-label="Mention somebody" className="absolute bottom-full left-0 z-10 mb-1 w-64 overflow-hidden rounded-base border border-line bg-surface shadow-lg">
                {offers.map((p, i) => (
                  <li key={p.id} role="option" aria-selected={i === 0}>
                    <button type="button" className={cn("block w-full px-3 py-1.5 text-left text-sm hover:bg-surface-sunken", i === 0 && "bg-surface-sunken")} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(p.name)}>
                      {p.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-1 flex items-center justify-between">
              <span className="flex items-center gap-3 text-[11px] text-subtle">
                Ctrl+Enter sends. Whoever you @mention is told.
                {data.teams.length > 0 && (
                  <select aria-label="Who sees it" className="rounded border border-line bg-surface px-1 py-0.5 text-[11px] text-text" value={to} onChange={(e) => setTo(e.target.value)}>
                    <option value="">Only us</option>
                    <option value="all">Every guest</option>
                    {data.teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} only
                      </option>
                    ))}
                  </select>
                )}
              </span>
              <Button size="sm" disabled={busy || !draft.trim()} onClick={() => void send()}>
                <Send className="h-3.5 w-3.5" />
                Comment
              </Button>
            </div>
          </div>
        </section>
      )}

      <section className="space-y-2 border-t border-line pt-4">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text">
          <History className="h-4 w-4 text-subtle" aria-hidden="true" />
          History
        </h3>
        {data.history.length === 0 ? (
          <p className="text-xs text-subtle">No changes recorded yet.</p>
        ) : (
          <ol className="space-y-1.5">
            {history.map((h) => (
              <li key={h.id} className="text-xs">
                <span className="text-text">{h.text}</span>
                <span className="text-subtle">
                  {" "}
                  — {h.by ?? "Deskzo"}, {when(h.at)}
                </span>
              </li>
            ))}
          </ol>
        )}
        {data.history.length > 8 && (
          <button type="button" className="text-xs text-brand hover:underline" onClick={() => setShowAll((s) => !s)}>
            {showAll ? "Show fewer" : `Show all ${data.history.length}`}
          </button>
        )}
      </section>
    </div>
  );
}
