"use client";

import { useState, useTransition } from "react";
import { submitPollAnswer } from "@/actions/email-poll";
import { Button } from "@/components/ui/button";

/** A poll's answer, counted on a press rather than on the page opening — mail scanners open links by themselves. */
export function PollAnswer({ token, question, answer, ours }: { token: string; question: string; answer: string; ours: string }) {
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState<boolean | null>(null);
  if (done) return <p className="text-sm text-success">Thanks — {ours} has your answer.</p>;
  return (
    <div className="space-y-2">
      <Button type="button" disabled={pending} onClick={() => startTransition(async () => setDone((await submitPollAnswer(token, question, answer)).ok))}>
        {pending ? "Sending…" : `Send “${answer}”`}
      </Button>
      {done === false && <p className="text-sm text-danger">That answer couldn&apos;t be counted — the link may be out of date.</p>}
    </div>
  );
}
