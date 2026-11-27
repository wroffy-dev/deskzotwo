import type { Metadata } from "next";
import { Card } from "@/components/ui/card";
import { ConfirmSignup } from "@/components/marketing/confirm-signup";
import { confirmationState } from "@/lib/marketing/double-opt-in";

export const metadata: Metadata = { title: "Confirm your subscription", referrer: "no-referrer", robots: { index: false, follow: false } };

/**
 * Where double opt-in's link lands (owner, 1 Nov 2026 — src/lib/marketing/double-opt-in.ts): whose sign-up, about what,
 * and a button to confirm it. Opening the page changes nothing — mail scanners open links by themselves.
 */
export default async function ConfirmSubscriptionPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const state = await confirmationState(token);
  if (!state) {
    return (
      <Card className="mx-auto max-w-lg px-6 py-12 text-center">
        <h1 className="text-lg font-semibold text-text">This link is no longer valid</h1>
        <p className="mt-2 text-sm text-muted">Fill in the form again and we&apos;ll send a new one.</p>
      </Card>
    );
  }
  return (
    <Card className="mx-auto max-w-lg space-y-3 px-6 py-10 text-center">
      <h1 className="text-lg font-semibold text-text">{state.state === "confirmed" ? "You're subscribed" : state.state === "withdrawn" ? "You've unsubscribed" : "Confirm your subscription"}</h1>
      {state.state === "pending" && (
        <>
          <p className="text-sm text-muted">
            Hear from {state.ours} about {state.topic.toLowerCase()} at {state.email}?
          </p>
          <div className="flex justify-center">
            <ConfirmSignup token={token} topic={state.topic} ours={state.ours} />
          </div>
        </>
      )}
      {state.state === "confirmed" && <p className="text-sm text-muted">{state.email} is on the list for {state.topic.toLowerCase()} from {state.ours}.</p>}
      {state.state === "withdrawn" && <p className="text-sm text-muted">You asked us to stop, so this link won&apos;t sign you up again. Fill in the form if you&apos;ve changed your mind.</p>}
    </Card>
  );
}
