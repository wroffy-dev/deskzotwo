"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { beginTwoFactorSetup, confirmTwoFactorSetup, disableOwnTwoFactor, reconfirmWithProvider, twoFactorIdentity } from "@/actions/profile";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/card";

export function TwoFactorSetup({ enabled, onEnabled }: { enabled: boolean; /** After an authenticator is confirmed — the onboarding wizard re-checks its step. */ onEnabled?: () => void }) {
  const router = useRouter();
  const [step, setStep] = useState<"idle" | "confirmIdentity" | "setup" | "disable">("idle");
  const [secret, setSecret] = useState<string | null>(null);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // How this person confirms it's them (owner, 3 Nov 2026): their password, or — an account that signs in with
  // Microsoft and has none — a fresh Microsoft sign-in. Asked when a step that needs it opens.
  const [identity, setIdentity] = useState<Awaited<ReturnType<typeof twoFactorIdentity>> | null>(null);

  function open(next: "confirmIdentity" | "disable") {
    setError(null);
    setIdentity(null);
    setStep(next);
    startTransition(async () => setIdentity(await twoFactorIdentity()));
  }

  function reconfirm() {
    if (!identity?.provider) return;
    const provider = identity.provider;
    startTransition(async () => {
      await reconfirmWithProvider(provider, window.location.pathname);
    });
  }

  /** The confirming part of a step: what this account can prove it with. */
  function proof(inputId: string, autoComplete?: string) {
    if (!identity) return <p className="text-sm text-subtle">Checking how you signed in…</p>;
    if (identity.freshSignIn) {
      return <p className="text-sm text-muted">You signed in with {identity.providerName} a moment ago — that confirms it&rsquo;s you.</p>;
    }
    if (!identity.hasPassword) {
      return (
        <div className="space-y-2">
          <p className="text-sm text-muted">
            You sign in with {identity.providerName ?? "Microsoft"}, so this account has no Deskzo password. Confirm with{" "}
            {identity.providerName ?? "Microsoft"} instead — you&rsquo;ll come straight back here.
          </p>
          {identity.provider && (
            <Button type="button" variant="secondary" size="sm" onClick={reconfirm} disabled={isPending}>
              Confirm with {identity.providerName}
            </Button>
          )}
        </div>
      );
    }
    return (
      <div className="space-y-1.5">
        <Label htmlFor={inputId}>Current password</Label>
        <Input id={inputId} type="password" autoComplete={autoComplete} value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoFocus />
        {identity.provider && (
          <button type="button" className="text-xs text-brand hover:underline" onClick={reconfirm} disabled={isPending}>
            Or confirm with {identity.providerName}
          </button>
        )}
      </div>
    );
  }
  /** Whether the step's main button can go: confirmed already, or a password typed. */
  const ready = !!identity && (identity.freshSignIn || (identity.hasPassword && currentPassword.length > 0));

  function startSetup() {
    setError(null);
    startTransition(async () => {
      const result = await beginTwoFactorSetup({ currentPassword });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSecret(result.data.secret);
      setQrCodeDataUrl(result.data.qrCodeDataUrl);
      setCurrentPassword("");
      setStep("setup");
    });
  }

  function confirmSetup() {
    setError(null);
    startTransition(async () => {
      const result = await confirmTwoFactorSetup({ code });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setStep("idle");
      setCode("");
      router.refresh();
      onEnabled?.();
    });
  }

  function disable() {
    setError(null);
    startTransition(async () => {
      const result = await disableOwnTwoFactor({ currentPassword });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setStep("idle");
      setCurrentPassword("");
      router.refresh();
    });
  }

  if (step === "setup") {
    return (
      <div className="space-y-3">
        {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}
        <p className="text-sm text-muted">
          Scan this with Microsoft Authenticator (or any authenticator app), then enter the 6-digit code it shows.
        </p>
        {qrCodeDataUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- a locally-generated data: URI, not a remote image
          <img src={qrCodeDataUrl} alt="Two-factor QR code" className="h-40 w-40 rounded-md border border-line" />
        )}
        <p className="text-xs text-subtle">
          Can&apos;t scan? Enter this key manually: <span className="font-mono">{secret}</span>
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="tfa-code">6-digit code</Label>
          <Input
            id="tfa-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoFocus
          />
        </div>
        <div className="flex gap-2">
          <Button type="button" size="sm" onClick={confirmSetup} disabled={isPending || code.length < 6}>
            {isPending ? "Verifying…" : "Confirm"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setStep("idle")} disabled={isPending}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  if (step === "confirmIdentity") {
    return (
      <div className="space-y-3">
        {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}
        <p className="text-sm text-muted">
          {/*
            Said plainly, because being asked for a password to set up a password-adjacent thing
            looks like a bug unless the reason is given.
          */}
          Confirm it&rsquo;s you before changing how this account signs in. A session on a borrowed or
          stolen machine should not be enough to swap the authenticator.
        </p>
        {proof("tfa-setup-password", "current-password")}
        <div className="flex gap-2">
          <Button type="button" size="sm" onClick={startSetup} disabled={isPending || !ready}>
            {isPending ? "Checking…" : "Continue"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setCurrentPassword("");
              setError(null);
              setStep("idle");
            }}
            disabled={isPending}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  if (step === "disable") {
    return (
      <div className="space-y-3">
        {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}
        {proof("tfa-disable-password")}
        <div className="flex gap-2">
          <Button type="button" variant="danger" size="sm" onClick={disable} disabled={isPending || !ready}>
            {isPending ? "Disabling…" : "Disable two-factor"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setStep("idle")} disabled={isPending}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between">
      <div>
        {enabled ? <Badge tone="green">Enabled</Badge> : <Badge tone="default">Not set up</Badge>}
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      </div>
      {enabled ? (
        <div className="flex gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => open("confirmIdentity")}>
            Replace authenticator
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => open("disable")}>
            Disable
          </Button>
        </div>
      ) : (
        <Button type="button" size="sm" onClick={() => open("confirmIdentity")} disabled={isPending}>
          Set up two-factor
        </Button>
      )}
    </div>
  );
}
