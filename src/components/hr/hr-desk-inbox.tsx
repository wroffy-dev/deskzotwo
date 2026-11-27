"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { answerHrDeskQuestion } from "@/actions/hr-desk";
import type { InboxItem } from "@/lib/hr-desk/server";
import { personPath } from "@/lib/record-links";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/input";
import { TeammateAvatar, useTeammate } from "@/components/ai/teammate-avatar";
import { useClock } from "@/components/time/clock-provider";

/**
 * People › HR desk (owner, 20 Nov 2026 — src/lib/hr-desk): what Priya passed to HR — waiting first, oldest first — with
 * what she said, and a box to answer. The person who asked sees the answer under their question on My HR, and is told.
 */
export function HrDeskInbox({ items }: { items: InboxItem[] }) {
  const priya = useTeammate("priya");
  const waiting = items.filter((i) => i.status === "WITH_HR");
  const answered = items.filter((i) => i.status !== "WITH_HR");
  return (
    <div className="space-y-5">
      <section aria-label="Waiting for HR" className="space-y-3">
        <h2 className="text-sm font-semibold text-text">Waiting for an answer {waiting.length > 0 && <Badge tone="amber">{waiting.length}</Badge>}</h2>
        {waiting.length === 0 ? (
          <Card className="px-4 py-8 text-center text-sm text-muted">Nothing waiting — {priya.name} has answered everything she was asked, or HR has.</Card>
        ) : (
          waiting.map((i) => <WaitingItem key={i.id} item={i} />)
        )}
      </section>
      {answered.length > 0 && (
        <section aria-label="Answered" className="space-y-2">
          <h2 className="text-sm font-semibold text-text">Answered in the last two weeks</h2>
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {answered.map((i) => (
              <li key={i.id} className="px-4 py-3 text-sm">
                <p className="text-text">
                  <span className="font-medium">{i.askerName}:</span> {i.question}
                </p>
                <p className="mt-1 text-muted">
                  <span className="font-medium text-text">{i.hrAnsweredBy ?? "HR"}:</span> {i.hrAnswer}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function WaitingItem({ item }: { item: InboxItem }) {
  const router = useRouter();
  const clock = useClock();
  const priya = useTeammate("priya");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [, start] = useTransition();
  const send = () =>
    start(async () => {
      setBusy(true);
      setError(null);
      const r = await answerHrDeskQuestion({ id: item.id, answer });
      setBusy(false);
      if (!r.ok) return setError(r.error);
      setDone(true);
      router.refresh();
    });
  if (done) return <Card className="px-4 py-3 text-sm text-muted">Answered — {item.askerName.split(/\s+/)[0]} has been told.</Card>;
  return (
    <Card className="space-y-2 p-4 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        {item.askerSeq !== null ? (
          <Link href={personPath(item.askerSeq)} className="font-medium text-text hover:underline">
            {item.askerName}
          </Link>
        ) : (
          <span className="font-medium text-text">{item.askerName}</span>
        )}
        <span className="text-xs text-subtle">Asked {clock.dateTimeShort(new Date(item.askedAt))}</span>
      </div>
      <p className="text-text">{item.question}</p>
      {item.priyaAnswer && (
        <div className="flex items-start gap-2 text-xs">
          <TeammateAvatar teammate="priya" size="xs" />
          <p className="min-w-0 flex-1 text-muted">
            <span className="font-medium text-text">{priya.name} told them:</span> {item.priyaAnswer}
          </p>
        </div>
      )}
      <Textarea aria-label={`Your answer to ${item.askerName}`} rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Your answer — they'll see it under their question on My HR." />
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={busy || answer.trim().length < 2} onClick={send}>
          {busy ? "Sending…" : "Send answer"}
        </Button>
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    </Card>
  );
}
