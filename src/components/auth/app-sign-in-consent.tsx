"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { allowAppSignIn } from "@/actions/app-devices";

/** Where "Cancel" goes: back to the app, which says it wasn't signed in. */
const CANCELLED = "deskzo://signed-in?error=cancelled";

/**
 * "Allow" or "Cancel" for the Deskzo app that opened this page (src/app/(auth)/app-sign-in). Allowing sends a
 * one-time code back to the app; the browser hands over to it, and the page says so in case it doesn't.
 */
export function AppSignInConsent({
  kind,
  signInKind,
  challenge,
  workspace,
  person,
  deviceName = null,
  refusal,
}: {
  kind: "phone" | "tablet";
  /** The page's own kind segment as the app sent it — "phone.link" asks for the code on an App Link (R2-12). */
  signInKind?: string;
  challenge: string;
  workspace: string;
  person: { name: string; email: string };
  /** What the app says the phone is called — the app's own word, shown as such (R2-12). */
  deviceName?: string | null;
  refusal: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  if (refusal) {
    return (
      <div className="space-y-4 text-sm">
        <h1 className="text-lg font-semibold text-text">{"The Deskzo app can't sign in"}</h1>
        <p className="text-text">{refusal}</p>
        <a href={CANCELLED} className="inline-block text-brand hover:underline">
          Back to the app
        </a>
      </div>
    );
  }

  if (link) {
    return (
      <div className="space-y-4 text-sm">
        <h1 className="text-lg font-semibold text-text">Back to the app</h1>
        <p className="text-muted">{"The Deskzo app is finishing signing you in. If it didn't open, tap below — within two minutes."}</p>
        <a href={link} className="inline-block font-medium text-brand hover:underline">
          Open the Deskzo app
        </a>
      </div>
    );
  }

  function allow() {
    setError(null);
    startTransition(async () => {
      const result = await allowAppSignIn(signInKind ?? kind, challenge);
      if (!result.ok) {
        setError(result.error ?? "That didn't work. Start again from the app.");
        return;
      }
      setLink(result.data.link);
      window.location.href = result.data.link;
    });
  }

  return (
    <div className="space-y-4 text-sm">
      <h1 className="text-lg font-semibold text-text">Sign in to the Deskzo app?</h1>
      <p className="text-text">
        The Deskzo app on this {kind} will be signed in to <span className="font-medium">{workspace}</span> as you:
      </p>
      <div className="rounded-lg border border-line bg-surface-sunken px-3 py-2">
        <p className="font-medium text-text">{person.name}</p>
        <p className="text-muted">{person.email}</p>
      </div>
      {deviceName && (
        <p className="text-text">
          The app says this {kind} is: <span className="font-medium">{deviceName}</span>
        </p>
      )}
      {/* Security audit round two, 13 Nov 2026 (R2-12): another app on the phone can open this page too, and the code
          goes back over deskzo://, so the warning is plain and comes before the button. */}
      <div className="rounded-lg border border-warning/30 bg-warning-bg px-3 py-2 text-text">
        <p className="font-medium">Only allow if you just tapped Sign in in the Deskzo app on this {kind}.</p>
        <p className="mt-1 text-muted">
          {"If you didn't — a link, another app or somebody else opened this page — tap Cancel. You'll get an email about every phone signed in to your account, and you can sign one out in Settings › Deskzo app."}
        </p>
      </div>
      <p className="text-muted">Your administrators see the {kind} in Security › Devices and can sign it out.</p>
      {error && <p className="text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={allow} disabled={pending} className="flex-1">
          {pending ? "Signing in…" : "Allow"}
        </Button>
        <a href={CANCELLED} className="inline-flex h-9 items-center rounded-md border border-line-strong bg-surface px-3.5 text-sm text-text shadow-sm hover:bg-surface-sunken">
          Cancel
        </a>
      </div>
    </div>
  );
}
