"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { decideResignation, submitResignation, withdrawResignation, type ResignationView } from "@/actions/resignation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { formatCalendarDay } from "@/lib/time/zone";

const day = (iso: string) => formatCalendarDay(new Date(`${iso}T00:00:00Z`));

function Status({ r }: { r: ResignationView }) {
  const last = r.acceptedLastDay ?? r.requestedLastDay;
  return (
    <div className="space-y-1 text-sm">
      <p className="text-text">
        Handed in on {day(r.submittedOn)} · {r.noticeDays} days&apos; notice · last working day{" "}
        <strong className="font-medium">{day(last)}</strong>
        {r.acceptedLastDay && r.acceptedLastDay !== r.requestedLastDay ? <span className="text-muted"> (asked for {day(r.requestedLastDay)})</span> : null}
      </p>
      {r.shortfall > 0 && <p className="text-xs text-warning">{r.shortfall} days of notice short — the full and final may recover them.</p>}
      <p className="text-xs text-muted">Reason: {r.reason}</p>
      {r.decisionNote && (
        <p className="text-xs text-muted">
          {r.decidedBy?.name ?? "HR"}: {r.decisionNote}
        </p>
      )}
    </div>
  );
}

const STATUS_WORDS: Record<ResignationView["status"], { label: string; tone: string }> = {
  PENDING: { label: "Waiting for a decision", tone: "bg-warning-bg text-warning" },
  ACCEPTED: { label: "Accepted", tone: "bg-success/10 text-success" },
  REJECTED: { label: "Not accepted", tone: "bg-danger/10 text-danger" },
  WITHDRAWN: { label: "Withdrawn", tone: "bg-surface-sunken text-muted" },
};

function Head({ title, status }: { title: string; status?: ResignationView["status"] }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <LogOut className="h-4 w-4 text-muted" />
      <h3 className="text-sm font-semibold text-text">{title}</h3>
      {status && <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_WORDS[status].tone}`}>{STATUS_WORDS[status].label}</span>}
    </div>
  );
}

/**
 * My HR's Resignation card (owner, 31 Oct 2026): hand it in with a reason and the last working day — by default the
 * day the notice ends — withdraw it while it waits, and see how it was decided.
 */
export function MyResignationCard({ latest, noticeDays, today, suggestedLastDay, exited }: { latest: ResignationView | null; noticeDays: number; today: string; suggestedLastDay: string; exited: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [lastDay, setLastDay] = useState(suggestedLastDay);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) return setError(r.error ?? "That didn't work.");
      setOpen(false);
      router.refresh();
    });

  const waiting = latest?.status === "PENDING";
  const settled = latest?.status === "ACCEPTED" || exited;
  return (
    <Card className="p-4">
      <Head title="Resignation" status={latest?.status} />
      {latest && latest.status !== "WITHDRAWN" && (
        <div className="mt-3">
          <Status r={latest} />
        </div>
      )}
      {waiting && (
        <div className="mt-3">
          <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => run(() => withdrawResignation(latest.id))}>
            Withdraw it
          </Button>
        </div>
      )}
      {!waiting && !settled && !open && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted">Leaving? Hand in your resignation here — your manager and HR are told, and guide you through the rest.</p>
          <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
            Apply for resignation
          </Button>
        </div>
      )}
      {open && (
        <div className="mt-3 space-y-3">
          <div>
            <Label htmlFor="resign-reason">Why you&apos;re leaving</Label>
            <Textarea id="resign-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="A line is enough." />
          </div>
          <div>
            <Label htmlFor="resign-day">Last working day</Label>
            <Input id="resign-day" type="date" min={today} value={lastDay} onChange={(e) => setLastDay(e.target.value)} className="w-48" />
            <p className="mt-1 text-xs text-subtle">
              Your notice is {noticeDays} days, so it ends on {day(suggestedLastDay)}. An earlier day is up to your manager and HR.
            </p>
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={pending} onClick={() => run(() => submitResignation({ reason, lastDay }))}>
              {pending ? "Handing it in…" : "Hand in resignation"}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </Card>
  );
}

/**
 * The person's record, for their manager or HR (owner, 31 Oct 2026): their resignation, and — while it waits — accept
 * it for a last working day, which records their exit, or turn it down with a reason.
 */
export function ResignationDecisionCard({ resignation, canDecide }: { resignation: ResignationView; canDecide: boolean }) {
  const router = useRouter();
  const [lastDay, setLastDay] = useState(resignation.requestedLastDay);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const decide = (accept: boolean) =>
    start(async () => {
      setError(null);
      const r = await decideResignation({ id: resignation.id, accept, lastDay, note });
      if (!r.ok) return setError(r.error);
      router.refresh();
    });
  const waiting = resignation.status === "PENDING";
  return (
    <Card className="p-4">
      <Head title="Resignation" status={resignation.status} />
      <div className="mt-3">
        <Status r={resignation} />
      </div>
      {waiting && canDecide && (
        <div className="mt-3 space-y-3 border-t border-line pt-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label htmlFor="decide-day">Accept for a last working day of</Label>
              <Input id="decide-day" type="date" min={resignation.submittedOn} value={lastDay} onChange={(e) => setLastDay(e.target.value)} className="w-48" />
            </div>
          </div>
          <div>
            <Label htmlFor="decide-note">Note to them</Label>
            <Textarea id="decide-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Needed to turn it down; optional to accept." />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={pending} onClick={() => decide(true)}>
              Accept — record the exit
            </Button>
            <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => decide(false)}>
              Don&apos;t accept
            </Button>
          </div>
          <p className="text-xs text-subtle">Accepting records their exit on that day and raises the leaving tasks. Their login stays on until then.</p>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </Card>
  );
}
