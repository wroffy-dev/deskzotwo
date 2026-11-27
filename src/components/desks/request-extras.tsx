"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { addDeskStep, askDeskApproval, changeDeskStep, decideDeskRequest, sendDeskAssetForRepair } from "@/actions/desks";
import { Button } from "@/components/ui/button";
import { confirmAction } from "@/components/ui/confirm";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { SearchSelect } from "@/components/ui/search-select";
import { Problem, useWork } from "@/components/desks/request-controls";
import { COMMENT_MAX, STEP_MAX } from "@/lib/desks/rules";

/** Approve or not, to whoever was asked (phase 2 of the help desk — src/lib/desks). */
export function DecideBox({ id, question, reasonSeenBy }: { id: string; question: string; reasonSeenBy: string }) {
  const { busy, error, run } = useWork();
  const [comment, setComment] = useState("");
  return (
    <div className="space-y-2.5">
      <p className="text-sm font-medium text-text">{question}</p>
      <div className="space-y-1.5">
        <Label htmlFor="decide-comment">A word with it (seen by {reasonSeenBy})</Label>
        <Textarea id="decide-comment" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={COMMENT_MAX} className="min-h-16" />
      </div>
      <Problem error={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy} onClick={() => run(() => decideDeskRequest(id, true, comment))}>
          Approve
        </Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => run(() => decideDeskRequest(id, false, comment))}>
          Don&apos;t approve
        </Button>
      </div>
    </div>
  );
}

/** The desk asking somebody to approve it: money, access, a decision. */
export function AskApproval({ id, colleagues }: { id: string; colleagues: { id: string; name: string }[] }) {
  const { busy, error, run } = useWork();
  const [open, setOpen] = useState(false);
  const [who, setWho] = useState("");
  const [reason, setReason] = useState("");
  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Ask for approval
      </Button>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        run(
          () => askDeskApproval(id, who, reason),
          () => setOpen(false),
        );
      }}
      className="space-y-2.5"
    >
      <div className="space-y-1.5">
        <Label htmlFor="ask-who">Who approves it</Label>
        <SearchSelect id="ask-who" value={who} onChange={(e) => setWho(e.target.value)} searchPlaceholder="Search colleagues…" required>
          <option value="">Choose a colleague</option>
          {colleagues.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SearchSelect>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="ask-why">What they&apos;re asked to approve</Label>
        <Textarea id="ask-why" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={COMMENT_MAX} className="min-h-16" required />
      </div>
      <p className="text-xs text-muted">They see what was asked and this, not the conversation or your notes. The clock stops until they answer.</p>
      <Problem error={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy || !who || !reason.trim()}>
          Ask
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

type Step = { id: string; title: string; assignee: { id: string; name: string } | null; done: boolean; doneNote: string | null };

/** The desk's own steps on a request. */
export function DeskSteps({ id, steps, people, open }: { id: string; steps: Step[]; people: { id: string; name: string }[]; open: boolean }) {
  const { busy, error, run } = useWork();
  const [title, setTitle] = useState("");
  const [who, setWho] = useState("");
  return (
    <div className="space-y-3">
      {steps.length === 0 && <p className="text-sm text-muted">No steps yet. Only the desk and the super admin see them.</p>}
      <ul className="divide-y divide-line">
        {steps.map((s) => (
          <li key={s.id} className="flex items-center gap-2.5 py-2">
            <input id={`step-${s.id}`} type="checkbox" className="h-4 w-4 shrink-0" checked={s.done} disabled={busy} onChange={(e) => run(() => changeDeskStep(s.id, e.target.checked))} />
            <label htmlFor={`step-${s.id}`} className="min-w-0 flex-1 text-sm">
              <span className={s.done ? "text-muted line-through" : "text-text"}>{s.title}</span>
              {(s.assignee || s.doneNote) && <span className="block text-xs text-muted">{s.doneNote ?? s.assignee?.name}</span>}
            </label>
            <button type="button" aria-label={`Remove ${s.title}`} disabled={busy} onClick={() => run(() => changeDeskStep(s.id, null))} className="rounded p-1 text-muted hover:text-text">
              <X aria-hidden="true" className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(
              () => addDeskStep(id, title, who || null),
              () => {
                setTitle("");
                setWho("");
              },
            );
          }}
          className="flex flex-wrap items-center gap-2"
        >
          <Input aria-label="New step" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={STEP_MAX} placeholder="Add a step" className="min-w-48 flex-1" />
          <Select aria-label="Whose step" value={who} onChange={(e) => setWho(e.target.value)} className="w-56">
            <option value="">Anybody on the desk</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="secondary" disabled={busy || !title.trim()}>
            Add
          </Button>
        </form>
      )}
      <Problem error={error} />
    </div>
  );
}

/** Sends the asset for repair in the asset register, and says so on the request. */
export function SendForRepair({ id, assetTag, holder }: { id: string; assetTag: string; holder: string }) {
  const { busy, error, run } = useWork();
  const [open, setOpen] = useState(false);
  const [where, setWhere] = useState("");
  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Send for repair
      </Button>
    );
  }
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (await confirmAction({ title: `Send ${assetTag} for repair?`, message: `It comes off ${holder}'s name in the asset register until it's handed back.`, confirmLabel: "Send it", danger: false })) run(() => sendDeskAssetForRepair(id, where), () => setOpen(false));
      }}
      className="space-y-2"
    >
      <Label htmlFor="repair-where">Where it goes</Label>
      <Input id="repair-where" value={where} onChange={(e) => setWhere(e.target.value)} maxLength={120} placeholder="Dell service centre" required />
      <Problem error={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy || !where.trim()}>
          Send
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
