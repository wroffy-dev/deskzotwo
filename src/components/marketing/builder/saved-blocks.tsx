"use client";

import { useState, useTransition } from "react";
import { Bookmark, Trash2 } from "lucide-react";
import { deleteSavedBlock, saveBlocks } from "@/actions/marketing-blocks";
import { blockSummary, type Block } from "@/lib/marketing/email-design";
import type { SavedBlock } from "@/lib/marketing/saved-blocks";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { confirmAction } from "@/components/ui/confirm";

/**
 * The email builder's saved blocks (owner, 1 Nov 2026: "saved blocks / brand kit"): the list under the blocks on the
 * left, dragged or clicked into the email like any block, and the dialog that saves the chosen block — with the ones
 * around it, if they belong together — under a name.
 */

const NAMES = ["Header", "Footer", "Header with partner logo", "Offer banner"];

export function SavedBlockList({ saved, onPick, onDragStart, onDragEnd, onDeleted }: { saved: SavedBlock[]; onPick: (s: SavedBlock) => void; onDragStart: (s: SavedBlock) => void; onDragEnd: () => void; onDeleted: (id: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const remove = async (s: SavedBlock) => {
    if (!(await confirmAction({ title: `Delete “${s.name}”?`, message: "Emails it was dropped into keep their copy.", confirmLabel: "Delete", danger: true }))) return;
    const result = await deleteSavedBlock(s.id);
    if (!result.ok) return setError(result.error);
    setError(null);
    onDeleted(s.id);
  };
  return (
    <div className="mt-4 space-y-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-subtle">Saved blocks</p>
      {saved.length === 0 ? (
        <p className="text-[11px] text-subtle">
          Save your header, footer or an offer once and drop it into any email: choose a block in the email and press <Bookmark className="inline h-3 w-3" /> on it.
        </p>
      ) : (
        saved.map((s) => (
          <div key={s.id} className="group flex items-center gap-1 rounded-base border border-line hover:border-brand">
            <button
              type="button"
              draggable
              title={s.blocks.map(blockSummary).join("\n")}
              onDragStart={(e) => {
                onDragStart(s);
                e.dataTransfer.effectAllowed = "copy";
                e.dataTransfer.setData("text/plain", s.id);
              }}
              onDragEnd={onDragEnd}
              onClick={() => onPick(s)}
              className="flex min-w-0 flex-1 cursor-grab items-center gap-2 px-2 py-2 text-left text-xs text-text active:cursor-grabbing"
            >
              <Bookmark className="h-3.5 w-3.5 shrink-0 text-brand" />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className="shrink-0 text-[10px] text-subtle">{s.blocks.length === 1 ? "1 block" : `${s.blocks.length} blocks`}</span>
            </button>
            <button type="button" title={`Delete “${s.name}”`} onClick={() => remove(s)} className="hidden p-1.5 text-muted hover:text-danger group-hover:block">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

/** Saves `blocks` — the chosen one ticked, the rest offered beside it — under a name; the same name replaces. */
export function SaveBlocksDialog({ open, onClose, blocks, chosenId, saved, onSaved }: { open: boolean; onClose: () => void; blocks: Block[]; chosenId: string | null; saved: SavedBlock[]; onSaved: (s: SavedBlock) => void }) {
  const [name, setName] = useState("");
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [openedFor, setOpenedFor] = useState<string | null>(null);

  // Opened afresh for a block: just that one ticked, no name yet.
  const key = open ? (chosenId ?? "-") : null;
  if (key !== openedFor) {
    setOpenedFor(key);
    if (key) {
      setTicked(new Set(chosenId ? [chosenId] : []));
      setName("");
      setError(null);
    }
  }

  const replaces = saved.find((s) => s.name.toLowerCase() === name.trim().replace(/\s+/g, " ").toLowerCase());
  const save = () =>
    start(async () => {
      const chosen = blocks.filter((b) => ticked.has(b.id));
      const result = await saveBlocks({ name, blocks: chosen });
      if (!result.ok) return setError(result.error);
      onSaved(result.data);
      onClose();
    });

  return (
    <Dialog open={open} onClose={onClose} title="Save for any email">
      <div className="space-y-3">
        <div className="space-y-1">
          <Label className="text-xs">Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Header, Footer, Microsoft offer…" autoFocus />
          <div className="flex flex-wrap gap-1 pt-1">
            {NAMES.filter((n) => n !== name).map((n) => (
              <button key={n} type="button" onClick={() => setName(n)} className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted hover:border-brand hover:text-brand">
                {n}
              </button>
            ))}
          </div>
          {replaces && <p className="text-[11px] text-subtle">Replaces the saved “{replaces.name}” — emails it went into keep their copy.</p>}
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Blocks to save — tick the ones that belong together, as a footer&apos;s social links and sign-off</Label>
          <div className="max-h-64 space-y-0.5 overflow-y-auto rounded-base border border-line p-1">
            {blocks.map((b) => (
              <label key={b.id} className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm ${ticked.has(b.id) ? "bg-brand/10 text-text" : "text-muted hover:bg-surface-sunken"}`}>
                <input
                  type="checkbox"
                  checked={ticked.has(b.id)}
                  onChange={(e) => {
                    const next = new Set(ticked);
                    if (e.target.checked) next.add(b.id);
                    else next.delete(b.id);
                    setTicked(next);
                  }}
                />
                <span className="truncate">{blockSummary(b)}</span>
              </label>
            ))}
          </div>
          <p className="text-[11px] text-subtle">Saved in the order they&apos;re in the email. Everybody who designs your emails can use them.</p>
        </div>
        {error && <ActionNotice tone="error">{error}</ActionNotice>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={pending || ticked.size === 0 || !name.trim()}>
            {pending ? "Saving…" : replaces ? "Replace" : "Save"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
