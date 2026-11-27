"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MailCheck } from "lucide-react";
import { sendPortalCode, verifyPortalCode, type PortalView } from "@/actions/portal-public";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

/**
 * A new browser opening a portal link where the workspace asks for a code (owner, 29 Oct 2026 — src/lib/portal/
 * device.ts): a code to the link's own address first, then the account. Nothing of the account is on this page; the
 * server sent none.
 */
export function PortalCodeGate({ token, view }: { token: string; view: PortalView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const send = () =>
    start(async () => {
      setError(null);
      const r = await sendPortalCode(token);
      if (!r.ok) return setError(r.error);
      setSentTo(r.to);
      setCode("");
    });
  const verify = () =>
    start(async () => {
      setError(null);
      const r = await verifyPortalCode(token, code);
      if (!r.ok) return setError(r.error);
      router.refresh();
    });

  return (
    <div className="mx-auto max-w-md px-4 py-12 sm:px-6">
      <Card className="space-y-4 px-6 py-8">
        <div>
          {view.ourName && <p className="text-sm text-muted">{view.ourName}</p>}
          <h1 className="mt-0.5 text-xl font-semibold text-text">Hello {view.personName}</h1>
          <p className="mt-1 text-sm text-muted">
            To keep {view.companyName}&apos;s account private, we check it&apos;s you the first time this link is opened on a device.
          </p>
        </div>
        {!view.codeTo ? (
          <p className="text-sm text-text">This link has no email address to send a code to — reply to any email you&apos;ve had from us and we&apos;ll send a new one.</p>
        ) : !sentTo ? (
          <div className="space-y-3">
            <p className="text-sm text-text">We&apos;ll email an 8-digit code to {view.codeTo}.</p>
            <Button type="button" disabled={pending} onClick={send}>
              <MailCheck className="h-4 w-4" aria-hidden="true" />
              Email me a code
            </Button>
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              verify();
            }}
          >
            <p className="text-sm text-text">We&apos;ve sent a code to {sentTo}. It works for 10 minutes.</p>
            <div className="space-y-1.5">
              <Label htmlFor="portal-code">Code</Label>
              <Input
                id="portal-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={9}
                className="w-48 text-lg tracking-widest"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={pending || code.replace(/\D/g, "").length !== 8}>
                Open my account
              </Button>
              <Button type="button" variant="ghost" disabled={pending} onClick={send}>
                Send a new code
              </Button>
            </div>
            <p className="text-xs text-muted">This device is then remembered for 30 days.</p>
          </form>
        )}
        {error && <p className="rounded-base border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}
      </Card>
    </div>
  );
}
