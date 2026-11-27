"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, Repeat, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { confirmAction } from "@/components/ui/confirm";
import { deleteListRepeat, duplicateOwnRow, listRepeats, saveListRepeat } from "@/actions/smart-list-rows";
import type { RepeatLine } from "@/lib/smart-lists/repeats";
import { EVERY_LABELS, REPEAT_EVERY, isDay, titleFor, type RepeatEvery } from "@/lib/smart-lists/repeat-dates";

/**
 * A row of a list's own, copied or made to repeat (owner, 20 Nov 2026 — Smart Lists phase 4; src/lib/smart-lists/repeats.ts).
 * Copy: whoever may fill the list in. Repeat: whoever may change the list — it adds rows by itself.
 */

const fmt = (day: string) => (isDay(day) ? new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : day);

export function OwnRowTools({ workbookId, rowId, rowTitle, canFill, canEdit, today, onCopied }: { workbookId: string; rowId: string; rowTitle: string; canFill: boolean; canEdit: boolean; today: string; onCopied: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [repeating, setRepeating] = useState(false);
  if (!canFill && !canEdit) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {canFill && (
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await duplicateOwnRow({ rowId });
              if (!r.ok) return void toast.error(r.error);
              toast.success("Copied — the copy is just below it.");
              onCopied();
              router.refresh();
            })
          }
        >
          <Copy className="h-3.5 w-3.5" />
          Copy row
        </Button>
      )}
      {canEdit && (
        <Button size="sm" variant="secondary" onClick={() => setRepeating(true)}>
          <Repeat className="h-3.5 w-3.5" />
          Repeat…
        </Button>
      )}
      {repeating && <RepeatDialog workbookId={workbookId} fromRowId={rowId} line={null} rowTitle={rowTitle} today={today} onClose={() => setRepeating(false)} onSaved={() => setRepeating(false)} />}
    </div>
  );
}

/** A repeat set up from a row, or one changed. */
function RepeatDialog({ workbookId, fromRowId, line, rowTitle, today, onClose, onSaved }: { workbookId: string; fromRowId: string | null; line: RepeatLine | null; rowTitle: string; today: string; onClose: () => void; onSaved: () => void }) {
  const router = useRouter();
  const [title, setTitle] = useState(line?.title ?? `${rowTitle} — {month}`);
  const [every, setEvery] = useState<RepeatEvery>(line?.every ?? "month");
  const [startOn, setStartOn] = useState(line?.nextOn ?? today);
  const [active, setActive] = useState(line?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Dialog open onClose={onClose} title={line ? "Repeat" : "Repeat this row"}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await saveListRepeat({ workbookId, id: line?.id ?? null, fromRowId, title, every, startOn, active });
            if (!r.ok) return setError(r.error);
            toast.success(r.data.nextOn <= today ? "Set — today's row is added." : `Set — the next one comes on ${fmt(r.data.nextOn)}.`);
            router.refresh();
            onSaved();
          });
        }}
      >
        {!line && <p className="text-sm text-muted">A new row like this one — what&apos;s typed or picked in it, not its files — is added on each date.</p>}
        <div className="space-y-1.5">
          <Label htmlFor="rep-title">Title of each new row</Label>
          <Input id="rep-title" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
          <p className="text-xs text-subtle">
            {"{date}"}, {"{month}"} and {"{year}"} become the row&apos;s date. Next: &ldquo;{titleFor(title, isDay(startOn) && startOn > today ? startOn : today)}&rdquo;
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="rep-every">How often</Label>
            <Select id="rep-every" value={every} onChange={(e) => setEvery(e.target.value as RepeatEvery)}>
              {REPEAT_EVERY.map((k) => (
                <option key={k} value={k}>
                  {EVERY_LABELS[k]}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rep-start">{line ? "Next on" : "First on"}</Label>
            <Input id="rep-start" type="date" value={startOn} onChange={(e) => setStartOn(e.target.value)} />
          </div>
        </div>
        {line && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            On — rows keep coming
          </label>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || !title.trim() || !isDay(startOn)}>
            {pending ? "Saving…" : line ? "Save" : "Repeat it"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The list's repeats — shown once it has one — to change, stop or delete. */
export function RepeatsButton({ workbookId, count, today }: { workbookId: string; count: number; today: string }) {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<RepeatLine[] | null>(null);
  const [editing, setEditing] = useState<RepeatLine | null>(null);
  const load = () => void listRepeats(workbookId).then((l) => setLines(l ?? []));
  useEffect(() => {
    if (!open) return;
    let live = true;
    void listRepeats(workbookId).then((l) => live && setLines(l ?? []));
    return () => {
      live = false;
    };
  }, [open, workbookId]);
  if (count === 0) return null;
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Repeat className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        Repeats
      </Button>
      {open && !editing && (
        <Dialog open onClose={() => setOpen(false)} title="Rows that repeat">
          <div className="space-y-4">
            <ul className="space-y-2">
              {(lines ?? []).map((l) => (
                <li key={l.id} className="flex flex-wrap items-center gap-2 rounded-base border border-line px-3 py-2">
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing(l)}>
                    <span className="block truncate text-sm font-medium text-text hover:underline">{l.title}</span>
                    <span className="block text-xs text-subtle">
                      {l.everyLabel} · {l.active ? `next on ${fmt(l.nextOn)}` : "stopped"}
                      {l.by ? ` · set up by ${l.by}` : ""}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete the repeat ${l.title}`}
                    className="rounded p-1 text-subtle hover:text-danger"
                    onClick={async () => {
                      if (!(await confirmAction({ title: `Delete the repeat "${l.title}"?`, message: "No more rows come from it. Rows it added stay.", confirmLabel: "Delete repeat", danger: true }))) return;
                      const r = await deleteListRepeat({ workbookId, id: l.id });
                      if (!r.ok) return void toast.error(r.error);
                      load();
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
              {lines && lines.length === 0 && <li className="text-sm text-subtle">No repeats. Open a row and choose Repeat… to make one.</li>}
            </ul>
            <div className="flex justify-end border-t border-line pt-4">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        </Dialog>
      )}
      {open && editing && (
        <RepeatDialog
          workbookId={workbookId}
          fromRowId={null}
          line={editing}
          rowTitle={editing.title}
          today={today}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </>
  );
}
