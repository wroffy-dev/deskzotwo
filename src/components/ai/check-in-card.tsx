"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarClock, Clock, Send, SkipForward } from "lucide-react";
import { draftReengage, sendReengage, skipReengage } from "@/actions/reengage";
import { REENGAGE_STATUS_LABELS } from "@/lib/reengage/rules";
import type { CheckInCard as CheckInCardData } from "@/lib/reengage/server";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { useClock } from "@/components/time/clock-provider";
import { TeammateAvatar, useTeammate } from "@/components/ai/teammate-avatar";
import { FeedbackButtons } from "@/components/ai/feedback-buttons";

type Result = { ok: true; data?: unknown } | { ok: false; error: string };

/**
 * Tara's check-in with a quiet customer, on the customer's page (owner, 20 Nov 2026 — AI team step 4, src/lib/reengage):
 * ask for one, and — for the account manager — read it, change anything, and approve it for their working hours or
 * send it now. What came of the last one: sent, replied, the lead it opened.
 */
export function CheckInCard({ data }: { data: CheckInCardData }) {
  const router = useRouter();
  const clock = useClock();
  const tara = useTeammate("tara");
  const e = data.latest;
  const open = e && (e.status === "WAITING" || e.status === "SCHEDULED") ? e : null;
  const [subject, setSubject] = useState(open?.subject ?? "");
  const [body, setBody] = useState(open?.body ?? "");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [, start] = useTransition();

  const act = (key: string, fn: () => Promise<Result>, done: string) =>
    start(async () => {
      setBusy(key);
      setError(null);
      setNotice(null);
      const r = await fn();
      setBusy(null);
      if (!r.ok) return setError(r.error);
      setNotice(done);
      router.refresh();
    });

  if (!e && !data.mayDraft && !data.note) return null;

  return (
    <Card id="check-in" className="scroll-mt-20">
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-text">
          <TeammateAvatar teammate="tara" size="sm" />
          <span>
            Check-in <span className="font-normal text-muted">· {tara.name}</span>
          </span>
          {e && <Badge tone={open ? "brand" : e.status === "SENT" ? "green" : "default"}>{e.repliedAt ? (e.replyLabel ?? "Replied") : (REENGAGE_STATUS_LABELS[e.status] ?? e.status)}</Badge>}
        </div>
        {open && data.isOwner && <FeedbackButtons teammate="tara" kind="reengage.email" refId={open.id} initial={data.thumb} />}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {open ? (
          open.status === "SCHEDULED" ? (
            <div className="flex flex-wrap items-center gap-2 rounded-base border border-line bg-surface-sunken p-3 text-xs">
              <Clock className="h-3.5 w-3.5 text-muted" aria-hidden="true" />
              <span className="min-w-0 flex-1 text-text">
                Approved — goes to {open.contactName} {open.sendAt ? clock.dateTimeShort(new Date(open.sendAt)) : "on the next working morning"}, in working hours.
              </span>
              {data.isOwner && (
                <>
                  <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => act("now", () => sendReengage({ id: open.id, subject: open.subject, body: open.body, when: "now" }), "Sent from your mailbox.")}>
                    {busy === "now" ? "Sending…" : "Send now"}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => act("skip", () => skipReengage(open.id), "Set aside — it won't go.")}>
                    Don&apos;t send
                  </Button>
                </>
              )}
            </div>
          ) : (
            <div className="space-y-2 rounded-base border border-brand/30 bg-brand-subtle/40 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-subtle">
                To {open.contactName} — {data.isOwner ? "check it, change anything, then send" : `waiting for ${open.ownerName ?? "the account manager"} to send`}
              </p>
              {data.isOwner ? (
                <>
                  <Input aria-label="Subject" value={subject} onChange={(ev) => setSubject(ev.target.value)} />
                  <Textarea aria-label="Email" rows={Math.min(14, body.split("\n").length + 2)} value={body} onChange={(ev) => setBody(ev.target.value)} className="text-sm" />
                  <p className="text-[11px] text-subtle">
                    {"{{firstName}}"} becomes the contact&apos;s first name and {"{{senderName}}"} yours. It goes from your mailbox, with a &ldquo;manage what we send you&rdquo;
                    line below.{!data.repliesCaught && " Replies come straight to your mailbox."}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {data.holdUntil ? (
                      <>
                        <Button size="sm" disabled={busy !== null} onClick={() => act("send", () => sendReengage({ id: open.id, subject, body, when: "working-hours" }), `Approved — it goes ${data.holdUntil}.`)}>
                          <CalendarClock className="mr-1.5 h-3.5 w-3.5" />
                          {busy === "send" ? "Approving…" : `Approve — goes ${data.holdUntil}`}
                        </Button>
                        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => act("now", () => sendReengage({ id: open.id, subject, body, when: "now" }), "Sent from your mailbox.")}>
                          <Send className="mr-1.5 h-3.5 w-3.5" />
                          {busy === "now" ? "Sending…" : "Send now"}
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" disabled={busy !== null} onClick={() => act("send", () => sendReengage({ id: open.id, subject, body, when: "now" }), "Sent from your mailbox.")}>
                        <Send className="mr-1.5 h-3.5 w-3.5" />
                        {busy === "send" ? "Sending…" : "Approve & send"}
                      </Button>
                    )}
                    <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => act("skip", () => skipReengage(open.id), "Set aside — Tara won't offer one again for a while.")}>
                      <SkipForward className="mr-1.5 h-3.5 w-3.5" />
                      Don&apos;t send
                    </Button>
                  </div>
                  {open.error && <p className="text-xs text-danger">Last try: {open.error}</p>}
                </>
              ) : (
                <p className="text-text">
                  <span className="text-muted">Subject:</span> {open.subject}
                </p>
              )}
            </div>
          )
        ) : (
          <>
            {e && (
              <p className="text-muted">
                {e.status === "SENT" && e.sentAt
                  ? `Sent to ${e.contactName} ${clock.dateTimeShort(new Date(e.sentAt))}: “${e.subject}”.`
                  : `Not sent${e.error ? ` — ${e.error}` : ""}.`}
                {e.repliedAt && ` They replied${e.replySummary ? `: ${e.replySummary}` : "."}`}{" "}
                {e.leadHref && (
                  <Link href={e.leadHref} className="text-brand hover:underline">
                    Open the lead it started
                  </Link>
                )}
              </p>
            )}
            {!e && (
              <p className="text-muted">
                {tara.name} can write one short check-in to this customer — about what they bought from you, and something else they might find useful — for their account
                manager to read and send. For customers with no order in {data.months} months.
              </p>
            )}
            {data.note && <p className="text-xs text-subtle">{data.note}.</p>}
            {data.mayDraft && (
              <Button size="sm" disabled={busy !== null} onClick={() => act("draft", () => draftReengage(data.companyId), "Drafted — it waits for the account manager.")}>
                {busy === "draft" ? `${tara.name} is writing…` : `Ask ${tara.name} for a check-in`}
              </Button>
            )}
          </>
        )}
        {notice && <p className="text-xs text-success">{notice}</p>}
        {error && <p className="text-xs text-danger">{error}</p>}
      </CardContent>
    </Card>
  );
}
