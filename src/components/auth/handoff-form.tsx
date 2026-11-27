"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { handoffAction } from "@/actions/auth";
import { Button } from "@/components/ui/button";

/**
 * Spends the pass when the person says to — never on its own (security audit, Nov 2026). The page used to
 * spend it as soon as it opened, so a link to /handoff?t=… signed in whoever followed it, as whoever made the
 * pass: one click, from another site or a chat message, and their browser was somebody else's session. Now it
 * waits for "Continue", a POST from this page, and the app's passes are also held to the phone's device
 * cookie (src/lib/platform/handoff-sign-in.ts).
 *
 * `next`: where the Deskzo app's pages land (src/lib/app/web-session.ts) — a new owner goes to Getting started.
 */
export function HandoffForm({ ticket, next }: { ticket: string; next?: string }) {
  const [error, setError] = useState<string | null>(ticket ? null : "This sign-in link is incomplete.");
  const [pending, start] = useTransition();

  if (error) {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-text">{error}</p>
        <Link href="/login" className="text-brand hover:underline">
          Go to sign in
        </Link>
      </div>
    );
  }
  return (
    <form
      className="space-y-4"
      action={() =>
        start(async () => {
          const result = await handoffAction(ticket, next);
          if (result?.error) setError(result.error);
        })
      }
    >
      <p className="text-sm text-text">{next ? "Continue to Deskzo, signed in from the app." : "Your workspace is ready. Continue to sign in."}</p>
      <p className="text-xs text-muted">Only continue if you opened this yourself just now.</p>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Signing you in…" : "Continue"}
      </Button>
    </form>
  );
}
