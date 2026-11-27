"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { CompanyLink } from "@/components/companies/company-link";
import { useRouter } from "next/navigation";
import { Check, PhoneIncoming, PhoneOutgoing, Play, Trash2 } from "lucide-react";
import type { CallDirection, CallOutcome } from "@prisma/client";
import { completeFollowUp, deleteCall } from "@/actions/call";
import { reviewCloudCall } from "@/actions/telephony";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { QuickMessageButton } from "@/components/messages/quick-message";
import { useClock } from "@/components/time/clock-provider";
import { callOutcomeLabels, callOutcomeTones, callOutcomeValues, formatDuration } from "@/lib/calls";
import { formatTicketId } from "@/lib/tickets";
import { companyPath, leadPath, orderPath, ticketPath } from "@/lib/record-links";

type Call = {
  id: string;
  phoneNumber: string;
  direction: CallDirection;
  outcome: CallOutcome;
  startedAt: Date | string;
  durationSeconds: number;
  notes: string | null;
  followUpAt: Date | string | null;
  followUpDone: boolean;
  company: { id: string; name: string; companySeq: number };
  contact: { id: string; name: string; designation: string } | null;
  lead: { id: string; title: string; leadSeq: number } | null;
  ticket: { id: string; ticketSeq: number; title: string } | null;
  companyProduct: { id: string; orderSeq: number; item: { name: string } } | null;
  user: { id: string; name: string };
  /** A call through the business line: its recording, and whether its person may still say how it went (src/lib/telephony). */
  cloud?: { recordingId: string | null; mayReview: boolean } | null;
  /** A recording from the caller's phone, for this viewer to play (src/lib/calls/recordings.ts). */
  phoneRecording?: boolean;
};

/**
 * A call history. Used on the Calls screen and again on a company's 360, so the same call reads the
 * same way wherever you meet it.
 *
 * `showCompany` is off inside a company, where repeating its name on every row is noise. `canDelete` is the
 * super admin's alone (src/actions/call.ts deleteCall).
 */
export function CallList({
  calls,
  showCompany = true,
  emptyMessage = "No calls logged yet.",
  canDelete = false,
  canMessage = false,
}: {
  calls: Call[];
  showCompany?: boolean;
  emptyMessage?: string;
  canDelete?: boolean;
  /** May send a ready-written email or WhatsApp after a call (owner, 11 Nov 2026 — src/lib/quick-messages). */
  canMessage?: boolean;
}) {
  if (calls.length === 0) {
    return <Card className="px-4 py-12 text-center text-sm text-subtle">{emptyMessage}</Card>;
  }

  return (
    <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
      {calls.map((call) => (
        <CallRow key={call.id} call={call} showCompany={showCompany} canDelete={canDelete} canMessage={canMessage} />
      ))}
    </div>
  );
}

function CallRow({ call, showCompany, canDelete, canMessage }: { call: Call; showCompany: boolean; canDelete: boolean; canMessage: boolean }) {
  const router = useRouter();
  const clock = useClock();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  function remove() {
    setError(null);
    startTransition(async () => {
      const result = await deleteCall(call.id);
      if (!result.ok) return setError(result.error);
      router.refresh();
    });
  }

  const Icon = call.direction === "INBOUND" ? PhoneIncoming : PhoneOutgoing;
  // A callback whose time has passed is the only thing on this screen that needs chasing.
  const overdue = !!call.followUpAt && !call.followUpDone && new Date(call.followUpAt) < new Date();

  function done() {
    setError(null);
    startTransition(async () => {
      const result = await completeFollowUp(call.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="px-4 py-3 transition-colors hover:bg-surface-sunken">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex flex-wrap items-center gap-2">
            <Icon className={`h-3.5 w-3.5 shrink-0 ${call.direction === "INBOUND" ? "text-brand" : "text-subtle"}`} />
            {showCompany ? (
              <CompanyLink href={companyPath(call.company.companySeq)} className="text-sm font-medium text-text hover:underline">
                {call.company.name}
              </CompanyLink>
            ) : (
              <span className="text-sm font-medium text-text">{call.contact?.name ?? call.phoneNumber}</span>
            )}
            <Badge tone={callOutcomeTones[call.outcome]}>{callOutcomeLabels[call.outcome]}</Badge>
            {call.durationSeconds > 0 && (
              <span className="font-mono text-xs text-subtle">{formatDuration(call.durationSeconds)}</span>
            )}
          </div>

          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-subtle">
            {showCompany && call.contact && <span>{call.contact.name}</span>}
            <span className="font-mono">{call.phoneNumber}</span>
            <span>·</span>
            <span>{clock.dateTimeShort(call.startedAt)}</span>
            <span>·</span>
            <span>{call.user.name}</span>
          </div>

          {(call.lead || call.ticket || call.companyProduct) && (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
              {call.lead && (
                <Link href={leadPath(call.lead.leadSeq)} className="text-brand hover:underline">
                  Lead: {call.lead.title}
                </Link>
              )}
              {call.ticket && (
                <Link href={ticketPath(call.ticket.ticketSeq)} className="text-brand hover:underline">
                  {formatTicketId(call.ticket.ticketSeq)}: {call.ticket.title}
                </Link>
              )}
              {call.companyProduct && (
                <Link href={orderPath(call.companyProduct.orderSeq)} className="text-brand hover:underline">
                  Subscription: {call.companyProduct.item.name}
                </Link>
              )}
            </div>
          )}

          {call.notes && <p className="mt-1.5 text-sm text-muted">{call.notes}</p>}
          {call.cloud && <CloudExtras call={call} />}
          {call.phoneRecording && <PhoneRecording callId={call.id} />}
        </div>

        {/* A follow-up by hand, for a call logged anywhere — the phone app too. Nothing goes until Send is pressed. */}
        {canMessage && (
          <QuickMessageButton
            ask={{ moment: "AFTER_CALL", companyId: call.company.id, leadId: call.lead?.id ?? null, contactId: call.contact?.id ?? null, phone: call.contact ? null : call.phoneNumber, outcome: call.outcome, callId: call.id }}
            title={`Follow up with ${call.company.name}`}
            label="Message"
            variant="ghost"
            size="sm"
            className="shrink-0"
          />
        )}

        {call.followUpAt && (
          <div className="flex shrink-0 items-center gap-2">
            {call.followUpDone ? (
              <Badge tone="green">Called back</Badge>
            ) : (
              <>
                <Badge tone={overdue ? "red" : "amber"}>
                  {overdue ? "Callback overdue" : "Call back"} {clock.date(call.followUpAt)}
                </Badge>
                <Button size="sm" variant="ghost" disabled={pending} onClick={done} title="Mark the callback done">
                  <Check className="h-3.5 w-3.5" />
                  Done
                </Button>
              </>
            )}
          </div>
        )}

        {canDelete &&
          (confirming ? (
            <div className="flex shrink-0 items-center gap-2 text-xs text-muted">
              Delete this call?
              <Button size="sm" variant="danger" disabled={pending} onClick={remove}>
                {pending ? "Deleting…" : "Delete"}
              </Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              title="Delete this call"
              aria-label="Delete this call"
              className="inline-grid h-8 w-8 shrink-0 place-items-center rounded-base text-subtle transition-colors hover:bg-danger-bg hover:text-danger"
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </button>
          ))}
      </div>
      {error && <p className="mt-1 text-sm text-danger">{error}</p>}
    </div>
  );
}

/**
 * A call through the business line (owner, 26 Oct 2026 — src/lib/telephony): its recording, played through
 * Deskzo when asked for, and — for its own person, within a fortnight — how it went, which it logged without.
 */
function CloudExtras({ call }: { call: Call }) {
  const router = useRouter();
  const clock = useClock();
  const [playing, setPlaying] = useState(false);
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<string>(call.outcome);
  const [notes, setNotes] = useState(call.notes ?? "");
  const [followUpAt, setFollowUpAt] = useState(call.followUpAt ? clock.input(call.followUpAt) : "");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const id = (k: string) => `cloud-${call.id}-${k}`;

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await reviewCloudCall(call.id, { outcome, notes, followUpAt }).catch(() => ({ ok: false as const, error: "Couldn't save that just now — try again." }));
      if (!result.ok) return setError(result.error);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <div className="mt-1.5 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {call.cloud?.recordingId && !playing && (
          <Button size="sm" variant="ghost" onClick={() => setPlaying(true)} title="Play the call's recording">
            <Play className="h-3.5 w-3.5" />
            Recording
          </Button>
        )}
        {call.cloud?.mayReview && !open && (
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            How did it go?
          </Button>
        )}
      </div>
      {playing && call.cloud?.recordingId && (
        // Through Deskzo, never CallerDesk's own link: whether you may hear it is asked as it plays.
        <audio controls autoPlay preload="none" src={`/api/telephony/recordings/${call.cloud.recordingId}`} className="h-9 w-full max-w-md">
          Your browser can&apos;t play this recording.
        </audio>
      )}
      {open && (
        <div className="grid max-w-xl gap-3 rounded-base border border-line p-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={id("outcome")}>How did it go?</Label>
            <Select id={id("outcome")} value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              {callOutcomeValues.map((o) => (
                <option key={o} value={o}>
                  {callOutcomeLabels[o]}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={id("follow")}>Call back on</Label>
            <Input id={id("follow")} type="datetime-local" value={followUpAt} onChange={(e) => setFollowUpAt(e.target.value)} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor={id("notes")}>Notes</Label>
            <Textarea id={id("notes")} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was said, and what happens next" />
          </div>
          {error && <p className="text-sm text-danger sm:col-span-2">{error}</p>}
          <div className="flex gap-2 sm:col-span-2">
            <Button size="sm" disabled={pending || (outcome === "CALLBACK_REQUESTED" && !followUpAt)} onClick={save}>
              {pending ? "Saving…" : "Save"}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A phone call's recording from the caller's phone, played through Deskzo — whether you may hear it asked as it plays. */
function PhoneRecording({ callId }: { callId: string }) {
  const [playing, setPlaying] = useState(false);
  return (
    <div className="mt-1.5">
      {playing ? (
        <audio controls autoPlay preload="none" src={`/api/calls/${callId}/recording`} className="h-9 w-full max-w-md">
          Your browser can&apos;t play this recording.
        </audio>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setPlaying(true)} title="Play the recording from the caller's phone">
          <Play className="h-3.5 w-3.5" />
          Recording
        </Button>
      )}
    </div>
  );
}
