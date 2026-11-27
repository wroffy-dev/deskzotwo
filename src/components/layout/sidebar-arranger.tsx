"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Check, ChevronDown, GripVertical, RotateCcw, X } from "lucide-react";
import { headedNavigation, navGroupIcon, type VisibleNavSection } from "@/lib/navigation";
import { moved, orderOf } from "@/lib/navigation-order";
import { saveSidebarOrder, resetSidebarOrder } from "@/actions/sidebar-order";
import { IconButton } from "@/components/ui/icon-button";
import { useWording } from "@/components/terms/wording-provider";
import { slot } from "@/lib/terms/dictionary";
import { cn } from "@/lib/utils";

/**
 * Arranging the sidebar (owner, 17 Nov 2026): the person puts the sections in their own order, and each section's pages
 * in their own order inside it — a split section's parts too, and a part's pages inside the part. Nothing moves out of
 * where it lives: a drag is only taken by a row of the same kind in the same list, and the arrows only swap neighbours
 * in it. Sections move among the others under the same heading (CRM, Finance…), since the heading is the section's.
 *
 * Drag a row by its handle, or use its arrows (the keyboard's and a phone's way). Done saves; the round arrow, with no
 * words beside it, puts the app's own order back ("Reset Sidebar" on hover).
 */

type Scope = { kind: "group"; heading: string } | { kind: "part"; group: string } | { kind: "item"; group: string; part: string | null };
type Dragging = { scope: string; key: string } | null;

const scopeKey = (s: Scope) => (s.kind === "group" ? `g:${s.heading}` : s.kind === "part" ? `p:${s.group}` : `i:${s.group}:${s.part ?? ""}`);

/** The parts of a section in the order its pages come in. */
const partsOf = (items: VisibleNavSection["items"]) => {
  const out: string[] = [];
  for (const i of items) if (i.section && !out.includes(i.section)) out.push(i.section);
  return out;
};

export function SidebarArranger({ navigation, arranged, onClose }: { navigation: VisibleNavSection[]; /** Whether an order of their own is saved. */ arranged: boolean; onClose: () => void }) {
  const router = useRouter();
  const wording = useWording();
  const [draft, setDraft] = useState<VisibleNavSection[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [dragging, setDragging] = useState<Dragging>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const sections = draft ?? navigation;
  const label = (i: VisibleNavSection["items"][number]) => (i.term ? slot(wording, i.label, i.term.key, i.term.template) : i.label);

  // ── The moves: each within one list, by key ──
  function moveGroup(heading: string, from: string, to: string) {
    const siblings = headedNavigation(sections).find((h) => (h.heading ?? "") === heading)?.sections.map((s) => s.group) ?? [];
    if (!siblings.includes(from) || !siblings.includes(to)) return;
    const all = sections.map((s) => s.group);
    setDraft(moved(sections, all.indexOf(from), all.indexOf(to)));
  }
  function movePart(group: string, from: string, to: string) {
    setDraft(
      sections.map((s) => {
        if (s.group !== group) return s;
        const parts = partsOf(s.items);
        const order = moved(parts, parts.indexOf(from), parts.indexOf(to));
        // The pages follow their part; within a part they keep their order (a stable sort).
        return { ...s, items: [...s.items].sort((a, b) => order.indexOf(a.section ?? "") - order.indexOf(b.section ?? "")) };
      }),
    );
  }
  function moveItem(group: string, from: string, to: string) {
    setDraft(
      sections.map((s) => {
        if (s.group !== group) return s;
        const a = s.items.findIndex((i) => i.href === from);
        const b = s.items.findIndex((i) => i.href === to);
        // Never across parts: a page stays in its part as it stays in its section.
        if (a === -1 || b === -1 || s.items[a]!.section !== s.items[b]!.section) return s;
        return { ...s, items: moved(s.items, a, b) };
      }),
    );
  }
  function move(scope: Scope, from: string, to: string) {
    if (from === to) return;
    if (scope.kind === "group") moveGroup(scope.heading, from, to);
    else if (scope.kind === "part") movePart(scope.group, from, to);
    else moveItem(scope.group, from, to);
  }

  function save() {
    setError(null);
    startTransition(async () => {
      if (draft) {
        const result = await saveSidebarOrder(orderOf(draft));
        if (!result.ok) {
          setError(result.error);
          return;
        }
        router.refresh();
      }
      onClose();
    });
  }
  function reset() {
    setError(null);
    startTransition(async () => {
      const result = await resetSidebarOrder();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDraft(null);
      router.refresh();
    });
  }

  /** One row: its handle, what it is, and the arrows that swap it with its neighbours in the same list. */
  function row(scope: Scope, keyOf: string, keys: string[], name: string, children: React.ReactNode) {
    const at = keys.indexOf(keyOf);
    const sk = scopeKey(scope);
    return (
      <div
        key={`${sk}|${keyOf}`}
        draggable
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", keyOf);
          setDragging({ scope: sk, key: keyOf });
        }}
        onDragEnd={() => setDragging(null)}
        onDragOver={(e) => {
          // Only a row of the same list takes the drop — anything else shows "not here".
          if (dragging?.scope === sk) {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
          }
        }}
        onDrop={(e) => {
          if (dragging?.scope !== sk) return;
          e.preventDefault();
          e.stopPropagation();
          move(scope, dragging.key, keyOf);
          setDragging(null);
        }}
        className={cn(
          "group/row flex items-center gap-1 rounded-base pr-0.5",
          dragging?.scope === sk && dragging.key === keyOf ? "opacity-50" : dragging?.scope === sk ? "bg-surface-sunken/60" : "hover:bg-surface-sunken",
        )}
      >
        <GripVertical aria-hidden="true" className="h-3.5 w-3.5 shrink-0 cursor-grab text-subtle" />
        <div className="min-w-0 flex-1">{children}</div>
        <IconButton icon={ArrowUp} label={`Move ${name} up`} className="h-6 w-6" disabled={at <= 0 || pending} onClick={() => move(scope, keyOf, keys[at - 1]!)} />
        <IconButton icon={ArrowDown} label={`Move ${name} down`} className="h-6 w-6" disabled={at === -1 || at >= keys.length - 1 || pending} onClick={() => move(scope, keyOf, keys[at + 1]!)} />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden px-2.5 py-3">
      <div className="mb-2 flex items-center gap-1.5">
        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-text">Arrange sidebar</p>
        <IconButton icon={RotateCcw} label="Reset Sidebar" disabled={pending || (!arranged && !draft)} onClick={reset} />
        <IconButton icon={X} label="Cancel" disabled={pending} onClick={onClose} />
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="inline-flex h-7 items-center gap-1 rounded-base bg-brand px-2 text-xs font-medium text-brand-contrast transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <Check aria-hidden="true" className="h-3.5 w-3.5" />
          {pending ? "Saving…" : "Done"}
        </button>
      </div>
      <p className="mb-3 text-xs text-subtle">Drag by the handle, or use the arrows. Pages stay inside their own section.</p>
      {error && <p className="mb-2 text-xs text-danger">{error}</p>}

      {headedNavigation(sections).map(({ heading, sections: inHeading }) => {
        const scope: Scope = { kind: "group", heading: heading ?? "" };
        const keys = inHeading.map((s) => s.group);
        return (
          <div key={heading ?? "top"} className="pb-2">
            {heading && <p className="px-1 pb-1 pt-2 text-xs font-semibold uppercase tracking-[0.08em] text-subtle">{heading}</p>}
            {inHeading.map((s) => {
              const Icon = navGroupIcon(s.group, s.items[0]?.href);
              const isOpen = open === s.group;
              const parts = partsOf(s.items);
              const many = s.items.length > 1;
              return (
                <div key={s.group}>
                  {row(
                    scope,
                    s.group,
                    keys,
                    s.group,
                    <button
                      type="button"
                      onClick={() => many && setOpen(isOpen ? null : s.group)}
                      aria-expanded={many ? isOpen : undefined}
                      className="flex h-8 w-full min-w-0 items-center gap-2 text-left text-sm font-medium text-text"
                    >
                      <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />
                      <span className="min-w-0 flex-1 truncate">{s.group}</span>
                      {many && <ChevronDown aria-hidden="true" className={cn("h-3.5 w-3.5 shrink-0 text-subtle transition-transform", isOpen && "rotate-180")} />}
                    </button>,
                  )}
                  {isOpen && (
                    <div className="mb-1 ml-[13px] space-y-0.5 border-l border-line pl-1.5">
                      {parts.length > 0
                        ? parts.map((part) => {
                            const inPart = s.items.filter((i) => i.section === part);
                            return (
                              <div key={part}>
                                {row({ kind: "part", group: s.group }, part, parts, part, <span className="block truncate py-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-subtle">{part}</span>)}
                                <div className="ml-3 space-y-0.5">
                                  {inPart.length > 1 &&
                                    inPart.map((i) =>
                                      row({ kind: "item", group: s.group, part }, i.href, inPart.map((x) => x.href), label(i), <span className="block truncate py-1 text-sm text-muted">{label(i)}</span>),
                                    )}
                                  {inPart.length === 1 && <p className="truncate px-5 py-1 text-sm text-muted">{label(inPart[0]!)}</p>}
                                </div>
                              </div>
                            );
                          })
                        : s.items.map((i) =>
                            row({ kind: "item", group: s.group, part: null }, i.href, s.items.map((x) => x.href), label(i), <span className="block truncate py-1 text-sm text-muted">{label(i)}</span>),
                          )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
