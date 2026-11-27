"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MailCheck } from "lucide-react";
import { sendConnectCode, verifyConnectCode } from "@/actions/connect-public";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

/**
 * Deskzo Connect sign-in (owner, 20 Nov 2026 — src/lib/connect/guest-auth.ts): the work email the guest was invited on,
 * then the code mailed to it. The page says the same whatever address is typed, so it tells nobody who is a guest.
 */
export function GuestSignIn({ business }: { business: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const send = () =>
    start(async () => {
      setError(null);
      const r = await sendConnectCode(email);
      if (!r.ok) return setError(r.error);
      setSent(r.message);
      setCode("");
    });
  const verify = () =>
    start(async () => {
      setError(null);
      const r = await verifyConnectCode(email, code);
      if (!r.ok) return setError(r.error);
      router.refresh();
    });

  return (
    <div className="mx-auto max-w-md">
      <p className="mb-4 text-center text-lg font-bold tracking-tight text-brand">
        Deskzo <span className="text-text">Connect</span>
      </p>
      <Card className="space-y-4 p-6">
        <div>
          <h1 className="text-lg font-semibold text-text">Sign in to what {business} shares with you</h1>
          <p className="mt-1 text-sm text-muted">With the work email you were invited on. A code comes to that inbox — there&apos;s no password.</p>
        </div>
        {!sent ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="guest-email">Work email</Label>
              <Input id="guest-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@yourcompany.com" autoFocus />
            </div>
            <Button type="submit" className="w-full" disabled={pending || !email.trim()}>
              {pending ? "Sending…" : "Email me a code"}
            </Button>
          </form>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              verify();
            }}
          >
            <p className="flex items-start gap-2 rounded-base bg-info-bg px-3 py-2 text-sm text-info">
              <MailCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {sent}
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="guest-code">8-digit code</Label>
              <Input
                id="guest-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={12}
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="text-center font-mono text-lg tracking-[0.3em]"
                autoFocus
              />
            </div>
            <Button type="submit" className="w-full" disabled={pending || code.replace(/\D/g, "").length < 8}>
              {pending ? "Checking…" : "Sign in"}
            </Button>
            <div className="flex justify-between text-xs">
              <button type="button" className="text-muted hover:text-text" onClick={() => setSent(null)}>
                Use another address
              </button>
              <button type="button" className="text-brand hover:underline" disabled={pending} onClick={send}>
                Send a new code
              </button>
            </div>
          </form>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </Card>
      <p className="mt-4 text-center text-xs text-subtle">Runs on Deskzo. Signed in for up to 7 days, or 8 hours idle.</p>
    </div>
  );
}
