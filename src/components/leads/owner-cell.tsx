"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, UserRound, UserX } from "lucide-react";
import { bulkUpdateLeads } from "@/actions/lead";

/**
 * A lead's owner, changed in its row of the Leads list (owner, 20 Nov 2026 — "assign or reassign owner like Notion has"):
 * the name is a button; it opens a list of people to search and pick, with Unassign where this person may leave a lead
 * with nobody. The same action as the bulk bar (`bulkUpdateLeads`), which asks the reassign rules again for this lead.
 */
export function OwnerCell({
  leadId,
  owner,
  people,
  canUnassign,
}: {
  leadId: string;
  owner: { id: string; name: string } | null;
  people: { id: string; name: string }[];
  canUnassign: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  // Where the list opens, against the window: the table's card clips anything inside it (overflow hidden).
  const [place, setPlace] = useState<{ top: number; left: number; up: boolean } | null>(null);

  // Closed by a click anywhere else, or Escape.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // Scrolling would leave it behind: closed instead.
    const scrolled = (e: Event) => {
      if (box.current && e.target instanceof Node && box.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", scrolled);
    search.current?.focus();
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", scrolled);
    };
  }, [open]);

  const choose = (to: string | null) => {
    if ((to ?? null) === (owner?.id ?? null)) return setOpen(false);
    setError(null);
    start(async () => {
      const result = await bulkUpdateLeads({ leadIds: [leadId], ownerUserId: to ?? "unassign" }).catch(() => ({ ok: false as const, error: "Couldn't change it just now — try again." }));
      if (!result.ok) return setError(result.error);
      setOpen(false);
      setQuery("");
      router.refresh();
    });
  };

  const words = query.trim().toLowerCase();
  const shown = people.filter((p) => !words || p.name.toLowerCase().includes(words));

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        ref={trigger}
        onClick={() => {
          const r = trigger.current?.getBoundingClientRect();
          if (r) {
            const up = window.innerHeight - r.bottom < 320 && r.top > 320;
            setPlace({ top: up ? r.top - 4 : r.bottom + 4, left: Math.min(r.left, window.innerWidth - 248), up });
          }
          setOpen((o) => !o);
        }}
        disabled={pending}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={owner ? "Change the owner" : "Assign an owner"}
        className="group -mx-1.5 inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-left hover:bg-surface-sunken"
      >
        <span className={owner ? "truncate text-muted" : "truncate text-subtle"}>{pending ? "Saving…" : (owner?.name ?? "Unassigned")}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-subtle opacity-0 group-hover:opacity-100" aria-hidden="true" />
      </button>
      {error && <p className="mt-0.5 text-[11px] text-danger">{error}</p>}
      {open && place && (
        <div
          className="fixed z-50 w-60 rounded-lg border border-line bg-surface p-1 shadow-lg"
          style={{ left: place.left, ...(place.up ? { bottom: window.innerHeight - place.top } : { top: place.top }) }}
        >
          <input
            ref={search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && shown.length === 1) choose(shown[0]!.id);
            }}
            placeholder="Search people…"
            aria-label="Search people"
            className="mb-1 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-text outline-none focus:border-brand"
          />
          <ul role="listbox" aria-label="Owner" className="max-h-64 overflow-y-auto">
            {canUnassign && owner && !words && (
              <li>
                <button type="button" onClick={() => choose(null)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted hover:bg-surface-sunken">
                  <UserX className="h-3.5 w-3.5" aria-hidden="true" />
                  Unassign
                </button>
              </li>
            )}
            {shown.map((p) => (
              <li key={p.id} role="option" aria-selected={p.id === owner?.id}>
                <button type="button" onClick={() => choose(p.id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-text hover:bg-surface-sunken">
                  <UserRound className="h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {p.id === owner?.id && <Check className="h-3.5 w-3.5 text-brand" aria-hidden="true" />}
                </button>
              </li>
            ))}
            {shown.length === 0 && <li className="px-2 py-1.5 text-sm text-subtle">Nobody by that name.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
