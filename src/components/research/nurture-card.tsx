"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Check, Clock, Reply, Send, SkipForward, Square } from "lucide-react";
import { answerNurtureReply, sendNurtureEmail, skipNurtureEmail, startNurture, stopLeadNurture } from "@/actions/nurture";
import { updateLeadStatus } from "@/actions/lead";
import { NURTURE_STATUS_LABELS, TOUCHES } from "@/lib/nurture/rules";
import { SUGGESTED_STAGE_LABELS } from "@/lib/nurture/replies";
import type { NurtureCard as NurtureCardData } from "@/lib/nurture/view";
import type { NurtureReplyView } from "@/lib/nurture/server";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { useClock } from "@/components/time/clock-provider";
import { TeammateAvatar, useTeammate } from "@/components/ai/teammate-avatar";
import { FeedbackButtons } from "@/components/ai/feedback-buttons";

type Result = { ok: true; data?: unknown } | { ok: false; error: string };

/**
 * Deskzo AI nurturing a lead (owner, 18 Nov 2026 — phase 3, src/lib/nurture): four emails over two weeks from the
 * owner's own mailbox, each waiting here for them to read, change and send. A reply, a call or meeting somebody logs,
 * or the lead closing ends it. Phase 4 (20 Nov 2026): approved for the working morning ("Send now" still there), the
 * owner's booking link in each email, and each reply read — what it means, what was done, the answer drafted.
 */
export function NurtureCard({ data }: { data: NurtureCardData }) {
  const router = useRouter();
  const clock = useClock();
  const n = data.nurture;
  const waiting = n?.status === "ACTIVE" ? n.touches.find((t) => t.status === "WAITING") ?? null : null;
  const held = n?.status === "ACTIVE" ? n.touches.find((t) => t.status === "SCHEDULED") ?? null : null;
  const [subject, setSubject] = useState(waiting?.subject ?? "");
  const [body, setBody] = useState(waiting?.body ?? "");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [, start] = useTransition();
  // Tara, the nurture writer (src/lib/ai/teammates.ts).
  const tara = useTeammate("tara");

  const act = (key: string, fn: () => Promise<Result>, done?: string | ((r: Result) => string)) =>
    start(async () => {
      setBusy(key);
      setError(null);
      setNotice(null);
      const r = await fn();
      setBusy(null);
      if (!r.ok) return setError(r.error);
      if (done) setNotice(typeof done === "string" ? done : done(r));
      router.refresh();
    });

  if (!n && !data.mayStart && !data.startNote) return null;
  const latest = n?.replies[0] ?? null;

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-text">
          <TeammateAvatar teammate="tara" size="sm" />
          <span>
            Nurture <span className="font-normal text-muted">· {tara.name}</span>
          </span>
          {n && <Badge tone={n.status === "ACTIVE" ? "brand" : "default"}>{NURTURE_STATUS_LABELS[n.status] ?? n.status}</Badge>}
        </div>
        {data.mayStop && (
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => act("replied", () => stopLeadNurture({ leadId: data.leadId, replied: true }), "Marked as replied — it's yours from here.")}>
              They replied
            </Button>
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => act("stop", () => stopLeadNurture({ leadId: data.leadId, replied: false }), "Stopped.")}>
              <Square className="mr-1 h-3 w-3" />
              Stop
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {latest && <ReplyPanel key={latest.id} reply={latest} leadId={data.leadId} isOwner={data.isOwner} mayMove={data.mayEdit} busy={busy} act={act} thumb={data.thumbs[latest.id] ?? null} />}
        {!n || n.status !== "ACTIVE" ? (
          <>
            {n && (
              <p className="text-muted">
                {n.stopReason ?? "Ended"} · {n.touchesSent} of {TOUCHES} emails sent.
              </p>
            )}
            <p className="text-muted">
              {tara.name}, your AI nurture writer, follows this lead up for you: {TOUCHES} short emails over two weeks to the contact, from the lead owner&apos;s own mailbox. You read,
              change and send each one; nothing goes by itself. A reply, a call or meeting you log, or the lead closing ends it.
            </p>
            {data.startNote && <p className="text-xs text-warning">{data.startNote}</p>}
            {data.mayStart && (
              <Button size="sm" disabled={busy !== null} onClick={() => act("start", () => startNurture(data.leadId), "Started — the first email is waiting for its owner.")}>
                {busy === "start" ? "Starting…" : n ? "Nurture again" : `Let ${tara.name} nurture this lead`}
              </Button>
            )}
          </>
        ) : (
          <>
            <p className="text-muted">
              To {n.contactName}, from {n.ownerName ?? "the lead owner"}&apos;s mailbox · {n.touchesSent} of {TOUCHES} sent
              {!waiting && !held && n.nextAt ? ` · the next is drafted ${clock.dateTimeShort(new Date(n.nextAt))}` : ""}.
              {n.bookingLink && " Each email ends with a link to book a time with them — a booking lands on this lead."}
              {!n.repliesCaught && " Replies come to the owner's mailbox — press “They replied” when one comes."}
            </p>
            <ol className="space-y-1 text-xs">
              {n.touches.map((t) => (
                <li key={t.id} className="flex items-start gap-2">
                  <span className="w-14 shrink-0 text-subtle">Email {t.step + 1}</span>
                  <span className="min-w-0 flex-1 text-text">
                    {t.subject}
                    <span className="ml-1 text-subtle">
                      {t.status === "SENT" && t.sentAt
                        ? `· sent ${clock.dateTimeShort(new Date(t.sentAt))}`
                        : t.status === "SCHEDULED" && t.sendAt
                          ? `· goes ${clock.dateTimeShort(new Date(t.sendAt))}`
                          : t.status === "WAITING"
                            ? "· waiting"
                            : `· ${t.status.toLowerCase()}`}
                    </span>
                    {t.status === "SENT" && <Check className="ml-1 inline h-3 w-3 text-success" aria-label="Sent" />}
                  </span>
                </li>
              ))}
            </ol>
            {held && (
              <div className="flex flex-wrap items-center gap-2 rounded-base border border-line bg-surface-sunken p-3 text-xs">
                <Clock className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
                <span className="min-w-0 flex-1 text-text">
                  Email {held.step + 1} is approved and goes {held.sendAt ? clock.dateTimeShort(new Date(held.sendAt)) : "on the next working morning"} — in their working hours.
                </span>
                {data.isOwner && (
                  <>
                    <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => act("now", () => sendNurtureEmail({ touchId: held.id, subject: held.subject, body: held.body, when: "now" }), "Sent from your mailbox.")}>
                      {busy === "now" ? "Sending…" : "Send now"}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => act("skip", () => skipNurtureEmail(held.id), "Set aside — the next comes on schedule.")}>
                      Don&apos;t send
                    </Button>
                  </>
                )}
              </div>
            )}
            {waiting && (
              <div className="space-y-2 rounded-base border border-brand/30 bg-brand-subtle/40 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-subtle">
                    Email {waiting.step + 1} — {data.isOwner ? "check it, change anything, then send" : `waiting for ${n.ownerName ?? "the lead owner"} to send`}
                  </p>
                  {/* Was this draft good? Read on Tara's scorecard (step 2). */}
                  {data.isOwner && <FeedbackButtons teammate="tara" kind="nurture.email" refId={waiting.id} initial={data.thumbs[waiting.id] ?? null} />}
                </div>
                {data.isOwner ? (
                  <>
                    <Input aria-label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
                    <Textarea aria-label="Email" rows={Math.min(14, body.split("\n").length + 2)} value={body} onChange={(e) => setBody(e.target.value)} className="text-sm" />
                    <p className="text-[11px] text-subtle">
                      {"{{firstName}}"} becomes the contact&apos;s first name and {"{{senderName}}"} yours. A &ldquo;manage what we send you&rdquo; line is added below
                      {n.bookingLink ? ", and your booking link above it" : ""}.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {n.holdUntil ? (
                        <>
                          <Button
                            size="sm"
                            disabled={busy !== null}
                            onClick={() => act("send", () => sendNurtureEmail({ touchId: waiting.id, subject, body, when: "working-hours" }), `Approved — it goes ${n.holdUntil}.`)}
                          >
                            <CalendarClock className="mr-1.5 h-3.5 w-3.5" />
                            {busy === "send" ? "Approving…" : `Approve — goes ${n.holdUntil}`}
                          </Button>
                          <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => act("now", () => sendNurtureEmail({ touchId: waiting.id, subject, body, when: "now" }), "Sent from your mailbox.")}>
                            <Send className="mr-1.5 h-3.5 w-3.5" />
                            {busy === "now" ? "Sending…" : "Send now"}
                          </Button>
                        </>
                      ) : (
                        <Button size="sm" disabled={busy !== null} onClick={() => act("send", () => sendNurtureEmail({ touchId: waiting.id, subject, body, when: "now" }), "Sent from your mailbox.")}>
                          <Send className="mr-1.5 h-3.5 w-3.5" />
                          {busy === "send" ? "Sending…" : "Approve & send"}
                        </Button>
                      )}
                      <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => act("skip", () => skipNurtureEmail(waiting.id), "Skipped — the next comes on schedule.")}>
                        <SkipForward className="mr-1.5 h-3.5 w-3.5" />
                        Skip this one
                      </Button>
                    </div>
                    {waiting.error && <p className="text-xs text-danger">Last try: {waiting.error}</p>}
                  </>
                ) : (
                  <p className="text-text">
                    <span className="text-muted">Subject:</span> {waiting.subject}
                  </p>
                )}
              </div>
            )}
          </>
        )}
        {notice && <p className="text-xs text-success">{notice}</p>}
        {error && <p className="text-xs text-danger">{error}</p>}
      </CardContent>
    </Card>
  );
}

/**
 * The latest reply, as Deskzo AI read it (phase 4): what it means, what was done by itself, the next step it suggests,
 * and its drafted answer — changed and sent by the lead's owner only.
 */
function ReplyPanel({
  reply,
  leadId,
  isOwner,
  mayMove,
  busy,
  act,
  thumb,
}: {
  reply: NurtureReplyView;
  leadId: string;
  isOwner: boolean;
  mayMove: boolean;
  busy: string | null;
  act: (key: string, fn: () => Promise<Result>, done?: string) => void;
  thumb: boolean | null;
}) {
  const clock = useClock();
  const [subject, setSubject] = useState(reply.answer?.subject ?? "");
  const [body, setBody] = useState(reply.answer?.body ?? "");
  const stage = reply.suggestedStage as keyof typeof SUGGESTED_STAGE_LABELS | null;
  return (
    <div className="space-y-2 rounded-base border border-line p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Reply className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
        <span className="font-medium text-text">{reply.fromName ?? "They"} replied</span>
        <Badge tone={reply.kind === "INTERESTED" || reply.kind === "CALL_ME" ? "green" : reply.kind === "UNSUBSCRIBE" || reply.kind === "NOT_INTERESTED" ? "red" : "default"}>{reply.label}</Badge>
        <span className="text-subtle">{clock.dateTimeShort(new Date(reply.at))}</span>
      </div>
      {reply.summary && <p className="text-text">{reply.summary}</p>}
      {reply.acted && <p className="text-xs text-success">Done by itself: {reply.acted}.</p>}
      {reply.kind === "WRONG_PERSON" && (reply.suggestedName || reply.suggestedEmail) && (
        <p className="text-xs text-muted">
          They point to {[reply.suggestedName, reply.suggestedEmail].filter(Boolean).join(" · ")} — add them to the company&apos;s contacts and start again with them.
        </p>
      )}
      {stage && SUGGESTED_STAGE_LABELS[stage] && mayMove && (
        <Button
          size="sm"
          variant="secondary"
          disabled={busy !== null}
          onClick={() => act("move", () => updateLeadStatus({ leadId, status: stage, ...(stage === "LOST" ? { lostReason: reply.summary ?? "Not interested" } : {}) }), `Moved to ${SUGGESTED_STAGE_LABELS[stage]}.`)}
        >
          {busy === "move" ? "Moving…" : `Move the lead to ${SUGGESTED_STAGE_LABELS[stage]}`}
        </Button>
      )}
      {reply.answeredAt ? (
        <p className="text-xs text-muted">Answered {clock.dateTimeShort(new Date(reply.answeredAt))}.</p>
      ) : reply.answer && isOwner ? (
        reply.canAnswer ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium uppercase tracking-wide text-subtle">An answer, drafted — change anything, then send</p>
              <FeedbackButtons teammate="tara" kind="nurture.answer" refId={reply.id} initial={thumb} />
            </div>
            <Input aria-label="Answer subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
            <Textarea aria-label="Answer" rows={Math.min(10, body.split("\n").length + 2)} value={body} onChange={(e) => setBody(e.target.value)} className="text-sm" />
            <Button size="sm" disabled={busy !== null} onClick={() => act("answer", () => answerNurtureReply({ replyId: reply.id, subject, body }), "Answer sent from your mailbox.")}>
              <Send className="mr-1.5 h-3.5 w-3.5" />
              {busy === "answer" ? "Sending…" : "Send answer"}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-warning">Their mail server didn&apos;t confirm who sent it — answer from your own inbox, where it was forwarded.</p>
        )
      ) : null}
    </div>
  );
}
