"use client";

import { useState, useTransition } from "react";
import { confirmSignup } from "@/actions/consent-confirm";
import { Button } from "@/components/ui/button";

/** Double opt-in's button: a press, not the page opening, confirms — mail scanners open links by themselves. */
export function ConfirmSignup({ token, topic, ours }: { token: string; topic: string; ours: string }) {
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState<boolean | null>(null);
  if (done) return <p className="text-sm text-success">Thanks — you&apos;re on the list for {topic.toLowerCase()} from {ours}.</p>;
  return (
    <div className="space-y-2">
      <Button type="button" disabled={pending} onClick={() => startTransition(async () => setDone((await confirmSignup(token)).ok))}>
        {pending ? "Confirming…" : "Yes, keep me posted"}
      </Button>
      {done === false && <p className="text-sm text-danger">That link doesn&apos;t work any more — fill in the form again and we&apos;ll send a new one.</p>}
    </div>
  );
}
