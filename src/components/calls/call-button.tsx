"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Phone, PhoneCall, Play, Smartphone, Square } from "lucide-react";
import { callsAllowed, logCall, listCompanyNumbers } from "@/actions/call";
import { myCallingPhone, ringMyPhone, ringState } from "@/actions/phone-calls";
import { callThroughLine, lineCallState, myLine, reviewCloudCall } from "@/actions/telephony";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { SearchSelect } from "@/components/ui/search-select";
import { callOutcomeLabels, callOutcomeValues, formatDuration, hasDialableNumber } from "@/lib/calls";
import { PhoneInput } from "@/components/ui/phone-input";
import { mayQuickMessage, type QuickAsk } from "@/actions/quick-messages";
import { QuickMessagePanel } from "@/components/messages/quick-message";

/** Whether this person may message customers from templates, asked once a page (src/lib/quick-messages). */
let mayMessage: Promise<boolean> | null = null;
const canMessage = () => (mayMessage ??= mayQuickMessage().catch(() => ((mayMessage = null), false)));

type NumberOption = Awaited<ReturnType<typeof listCompanyNumbers>>[number];
type Ring = { id: string; phone: string; pushed: boolean; state: Awaited<ReturnType<typeof ringState>> };
type LineCall = { id: string; state: "REQUESTED" | "LIVE" | "ENDED"; logged: boolean; callLogId: string | null; outcome: string | null };

/** What a call placed through the business line has got to, in words (owner, 26 Oct 2026 — src/lib/telephony). */
function lineWords(call: LineCall, line: string): string {
  if (call.logged) return call.outcome === "CONNECTED" ? "Logged with its length — say how it went below." : "They didn't pick up. Logged as no answer.";
  if (call.state === "REQUESTED") return `${line} is ringing your phone — pick up, and it rings the customer from the business number.`;
  if (call.state === "LIVE") return "On the call. It logs itself when it ends.";
  return `Over — waiting for ${line} to report it. It logs itself in a few minutes.`;
}

/** What a ring sent to the caller's phone has got to, in words (owner, 18 Oct 2026). */
function ringWords(ring: Ring): string {
  if (ring.state === "WAITING") return ring.pushed ? `Sent to your ${ring.phone} — it will offer to dial in a moment.` : `Sent to your ${ring.phone}. Open the Deskzo app on it to dial.`;
  if (ring.state === "TAKEN") return `Your ${ring.phone} has it — dial from the app. The call logs itself here when it ends.`;
  if (ring.state === "LOGGED") return "Logged from your phone.";
  return `Your ${ring.phone} didn't pick it up. Ring it again, or call and log it here.`;
}

/**
 * Whether calls may be logged here, asked once a page however many icons it has (a list of contacts
 * has one per row): Calls switched on, and View calls this person's. Forgotten on a failed answer, so
 * the next icon asks again; the server refuses a call whatever this says.
 */
let allowed: Promise<boolean> | null = null;

function useCallsAllowed(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let live = true;
    allowed ??= callsAllowed();
    allowed.then(
      (yes) => live && setOk(yes),
      () => {
        allowed = null;
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return ok;
}

/**
 * The phone icon, and everything behind it.
 *
 * The sequence is the one a caller actually goes through: pick who you're ringing, start the timer,
 * talk, then say what happened. The call itself is placed on a phone — this times it, so the
 * duration is measured rather than remembered, and the log form stays open throughout, because a
 * caller who has to go and find the record again after hanging up will not log the call.
 */
export function CallButton({
  companyId,
  companyName,
  leadId,
  ticketId,
  companyProductId,
  /** Skips the picker: the caller is already looking at one person, so there is nobody else. */
  contact,
  /** Preselects somebody but keeps the picker — see the type below for why. */
  preferContact,
  size = "md",
  variant = "secondary",
  label,
  className,
}: {
  companyId: string;
  companyName: string;
  leadId?: string;
  ticketId?: string;
  companyProductId?: string;
  contact?: { id: string; name: string; phone: string | null };
  /**
   * Preselects somebody but keeps the picker.
   *
   * The right shape when the *company* is the subject rather than a person. A renewal call may
   * need the purchase manager rather than whoever happens to be primary, and locking the caller
   * to one name is worse than defaulting to the likely one and letting them change it.
   */
  preferContact?: { id: string; name: string; phone: string | null };
  size?: "sm" | "md" | "icon";
  variant?: "primary" | "secondary" | "ghost" | "subtle";
  label?: string;
  /** Sizing for a tight row — a contact's line, say. */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // Not drawn where nobody may log a call: Calls switched off, or no View calls.
  const allowedHere = useCallsAllowed();
  if (!allowedHere) return null;
  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={className}
        onClick={() => setOpen(true)}
        title={`Call ${contact?.name ?? companyName}`}
        aria-label={`Log a call to ${contact?.name ?? companyName}`}
      >
        <Phone className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} />
        {label ?? (size === "icon" ? null : "Call")}
      </Button>
      {open && (
        <CallDialog
          companyId={companyId}
          companyName={companyName}
          leadId={leadId}
          ticketId={ticketId}
          companyProductId={companyProductId}
          presetContact={contact}
          preferContact={preferContact}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function CallDialog({
  companyId,
  companyName,
  leadId,
  ticketId,
  companyProductId,
  presetContact,
  preferContact,
  onClose,
}: {
  companyId: string;
  companyName: string;
  leadId?: string;
  ticketId?: string;
  companyProductId?: string;
  presetContact?: { id: string; name: string; phone: string | null };
  preferContact?: { id: string; name: string; phone: string | null };
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Once the call is logged: a ready-written email or WhatsApp to follow it, sent by hand (owner, 11 Nov 2026).
  const [followUp, setFollowUp] = useState<QuickAsk | null>(null);

  const [numbers, setNumbers] = useState<NumberOption[] | null>(null);
  const [contactId, setContactId] = useState(presetContact?.id ?? preferContact?.id ?? "");
  const [phoneNumber, setPhoneNumber] = useState(presetContact?.phone ?? preferContact?.phone ?? "");
  // A masked number (owner, 3 Nov 2026) is dialled by the server from the contact chosen (src/lib/contacts/masking.ts).
  const canDial = hasDialableNumber(phoneNumber) || (String(phoneNumber).includes("*") && !!contactId);

  const [startedAt, setStartedAt] = useState<Date | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [running, setRunning] = useState(false);

  const [outcome, setOutcome] = useState("CONNECTED");
  const [direction, setDirection] = useState("OUTBOUND");
  const [notes, setNotes] = useState("");
  const [followUpAt, setFollowUpAt] = useState("");

  // "Ring my phone": the caller's own phone with the Deskzo app and call sync on, if they have one.
  const [phone, setPhone] = useState<{ id: string; name: string } | null>(null);
  const [ring, setRing] = useState<Ring | null>(null);
  useEffect(() => {
    let live = true;
    myCallingPhone().then(
      (p) => live && setPhone(p),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  // Watching a ring every two seconds until the call is logged or nobody picked it up — three minutes at most.
  const ringId = ring?.id ?? null;
  const ringDone = ring?.state === "LOGGED" || ring?.state === "EXPIRED";
  useEffect(() => {
    if (!ringId || ringDone) return;
    let live = true;
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      void ringState(ringId).then((state) => {
        if (!live) return;
        setRing((r) => (r && r.id === ringId ? { ...r, state: ticks >= 90 && state !== "LOGGED" ? "EXPIRED" : state } : r));
        if (state === "LOGGED") router.refresh();
      });
    }, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [ringId, ringDone, router]);

  // "Call through CallerDesk": the business's cloud telephony, where this person is a member on it.
  const [line, setLine] = useState<{ name: string; deskphone: string } | null>(null);
  const [lineCall, setLineCall] = useState<LineCall | null>(null);
  useEffect(() => {
    let live = true;
    myLine().then(
      (l) => live && setLine(l),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  // Watching it every three seconds until it's logged — ten minutes at most; the heartbeat logs it anyway.
  const lineCallId = lineCall?.id ?? null;
  const lineDone = !!lineCall?.logged;
  useEffect(() => {
    if (!lineCallId || lineDone) return;
    let live = true;
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      if (ticks > 200) return clearInterval(timer);
      void lineCallState(lineCallId).then((s) => {
        if (!live || !s) return;
        setLineCall((c) => (c && c.id === lineCallId ? { ...c, ...s } : c));
        if (s.logged) router.refresh();
      });
    }, 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [lineCallId, lineDone, router]);

  function callThrough() {
    setError(null);
    startTransition(async () => {
      // Anything going wrong with the business line stays a message here: the dialog still logs a call by hand.
      const result = await callThroughLine({ companyId, contactId: contactId || undefined, phoneNumber, leadId, ticketId, companyProductId }).catch(() => ({
        ok: false as const,
        error: `${line?.name ?? "The business line"} couldn't place the call just now. Call from your phone and log it here.`,
      }));
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setLineCall({ id: result.data.id, state: "REQUESTED", logged: false, callLogId: null, outcome: null });
    });
  }

  function ringPhone() {
    setError(null);
    startTransition(async () => {
      const result = await ringMyPhone({ companyId, contactId: contactId || undefined, phoneNumber, leadId, ticketId, companyProductId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setRing({ ...result.data, state: "WAITING" });
    });
  }

  useEffect(() => {
    if (presetContact) return;
    let cancelled = false;
    listCompanyNumbers(companyId).then((rows) => {
      if (cancelled) return;
      setNumbers(rows);
      // Somebody preferred is already chosen — otherwise the list landing would overwrite the
      // sensible default with whoever happens to sort first.
      if (preferContact) return;
      const first = rows.find((r) => hasDialableNumber(r.phone));
      if (first) {
        setContactId(first.id);
        setPhoneNumber(first.phone ?? "");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [companyId, presetContact, preferContact]);

  // A plain interval rather than a timestamp diff on render: the number on screen has to tick, and
  // recomputing it during render would be an impure read of the clock.
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!running) return;
    tickRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [running]);

  function startTimer() {
    // Only the first start resets the clock — stopping and starting again resumes, so a pause to
    // look something up doesn't throw away the minutes already on it.
    if (!startedAt) {
      setStartedAt(new Date());
      setElapsed(0);
    }
    setRunning(true);
  }

  function resetTimer() {
    setRunning(false);
    setStartedAt(null);
    setElapsed(0);
  }

  /** The call is on record: offer the follow-up message to whoever may send one, else close. */
  async function logged(callId: string | null) {
    router.refresh();
    if (await canMessage()) setFollowUp({ moment: "AFTER_CALL", companyId, leadId: leadId ?? null, contactId: contactId || null, phone: contactId ? null : phoneNumber || null, outcome, callId });
    else onClose();
  }

  function save() {
    setError(null);
    // A call through the business line logged itself: this is the word on it, never a second log.
    if (lineCall) {
      const callLogId = lineCall.callLogId;
      if (!callLogId) return;
      startTransition(async () => {
        const result = await reviewCloudCall(callLogId, { outcome, notes, followUpAt }).catch(() => ({ ok: false as const, error: "Couldn't save that just now — try again." }));
        if (!result.ok) {
          setError(result.error);
          return;
        }
        await logged(callLogId);
      });
      return;
    }
    startTransition(async () => {
      const result = await logCall({
        companyId,
        contactId: contactId || undefined,
        phoneNumber,
        outcome,
        direction,
        startedAt: (startedAt ?? new Date()).toISOString(),
        durationSeconds: elapsed,
        notes,
        followUpAt: followUpAt || undefined,
        leadId,
        ticketId,
        companyProductId,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      await logged(result.data.id);
    });
  }

  const selectable = numbers ?? [];
  const noNumbers = !presetContact && numbers !== null && selectable.filter((n) => hasDialableNumber(n.phone)).length === 0;
  // A promised callback with no time on it is a promise nobody will keep.
  const needsFollowUp = outcome === "CALLBACK_REQUESTED";

  if (followUp) {
    return (
      <Dialog open onClose={onClose} title={`Follow up with ${companyName}`}>
        <QuickMessagePanel ask={followUp} onClose={onClose} intro="The call is logged. Send a follow-up if you like — nothing goes until you press Send." />
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={onClose} title={`Call ${companyName}`}>
      <div className="space-y-4">
        {presetContact ? (
          <div className="rounded-base border border-line bg-surface-sunken px-3 py-2 text-sm">
            <span className="font-medium text-text">{presetContact.name}</span>
            <span className="ml-2 font-mono text-xs text-muted">{presetContact.phone ?? "no number on file"}</span>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="callContact">Who are you calling?</Label>
            <SearchSelect
              id="callContact"
              value={contactId}
              onChange={(e) => {
                setContactId(e.target.value);
                const match = selectable.find((n) => n.id === e.target.value);
                if (match?.phone) setPhoneNumber(match.phone);
              }}
              disabled={numbers === null}
              searchPlaceholder="Search contacts…"
            >
              <option value="">Someone else at this company</option>
              {selectable.map((n) => (
                <option key={n.id} value={n.id} disabled={!hasDialableNumber(n.phone)}>
                  {n.name} · {n.designation.replaceAll("_", " ").toLowerCase()}
                  {n.phone ? ` · ${n.phone}` : " · no number"}
                </option>
              ))}
            </SearchSelect>
            {noNumbers && (
              <p className="text-xs text-warning">
                No contact here has a phone number on file. Type one below and it will be logged against the company.
              </p>
            )}
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="callNumber">Number</Label>
          <div className="flex gap-2">
            <PhoneInput
              id="callNumber"
              value={phoneNumber}
              onChange={(v) => setPhoneNumber(v)}
              placeholder="98765 43210"
            />
            {running ? (
              <Button variant="danger" onClick={() => setRunning(false)} title="Stop the timer">
                <Square className="mr-1.5 h-3.5 w-3.5" />
                {formatDuration(elapsed)}
              </Button>
            ) : (
              <Button onClick={startTimer} title="Start timing the call">
                <Play className="mr-1.5 h-3.5 w-3.5" />
                {startedAt ? `Resume · ${formatDuration(elapsed)}` : "Start timer"}
              </Button>
            )}
          </div>
          {startedAt && !running && elapsed > 0 && (
            <p className="text-xs text-muted">
              {formatDuration(elapsed)} on the call.{" "}
              <button type="button" onClick={resetTimer} className="underline hover:text-text">
                Reset
              </button>
            </p>
          )}
        </div>

        {phone && (
          <div className="rounded-base border border-line bg-surface-sunken px-3 py-2 text-sm">
            {ring && ring.state !== "EXPIRED" ? (
              <p className="text-text">{ringWords(ring)}</p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={ringPhone} disabled={pending || !canDial}>
                  <Smartphone className="mr-1.5 h-3.5 w-3.5" />
                  {ring ? "Ring it again" : `Ring my ${phone.name}`}
                </Button>
                <span className="text-xs text-muted">{ring ? ringWords(ring) : "Dials from your phone — the call logs itself when it ends, no form to fill."}</span>
              </div>
            )}
          </div>
        )}

        {line && (
          <div className="rounded-base border border-line bg-surface-sunken px-3 py-2 text-sm">
            {lineCall ? (
              <div className="space-y-1">
                <p className="text-text">{lineWords(lineCall, line.name)}</p>
                {lineCall.logged && (
                  <Button size="sm" variant="secondary" onClick={onClose}>
                    Close
                  </Button>
                )}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={callThrough} disabled={pending || !canDial}>
                  <PhoneCall className="mr-1.5 h-3.5 w-3.5" />
                  Call through {line.name}
                </Button>
                <span className="text-xs text-muted">Rings your phone, then them — they see {line.deskphone}. Logs itself, no form to fill.</span>
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="callOutcome">How did it go?</Label>
            <Select id="callOutcome" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              {callOutcomeValues.map((o) => (
                <option key={o} value={o}>
                  {callOutcomeLabels[o]}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="callDirection">Direction</Label>
            <Select id="callDirection" value={direction} onChange={(e) => setDirection(e.target.value)}>
              <option value="OUTBOUND">We called them</option>
              <option value="INBOUND">They called us</option>
            </Select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="callNotes">Notes</Label>
          <Textarea
            id="callNotes"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="What was said, and what happens next"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="callFollowUp">
            Call back on{needsFollowUp && <span className="ml-1 text-danger">*</span>}
          </Label>
          <Input
            id="callFollowUp"
            type="datetime-local"
            value={followUpAt}
            onChange={(e) => setFollowUpAt(e.target.value)}
          />
          <p className="text-xs text-subtle">
            {needsFollowUp
              ? "They asked to be called back — set when, and it lands on the callbacks list."
              : "Optional. Anything set here shows up under Calls as a due callback."}
          </p>
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex gap-2">
          <Button disabled={pending || (needsFollowUp && !followUpAt) || (!!lineCall && !lineCall.callLogId)} onClick={save}>
            {pending ? "Saving…" : !lineCall ? "Log call" : lineCall.callLogId ? "Save how it went" : "Waiting for the call to end…"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
