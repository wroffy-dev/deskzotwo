"use client";

import { useEffect, useState, useTransition } from "react";
import { reconfirmForSecret, secretConfirmation } from "@/actions/profile";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

type Confirmation = Awaited<ReturnType<typeof secretConfirmation>>;

/**
 * How this person proves it's them before a stored password opens, or a restore or reset goes ahead (owner, 4 Nov 2026 —
 * "what if sso login is enabled how do user put password here"): their Deskzo password, or signing in again with
 * Microsoft, Google or Zoho. `what` picks how long that sign-in counts: see `secretConfirmation`.
 */
export function useSecretConfirmation(what: "open" | "act", enabled = true): Confirmation | null {
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    void secretConfirmation(what).then((answer) => {
      if (current) setConfirmation(answer);
    });
    return () => {
      current = false;
    };
  }, [what, enabled]);
  return confirmation;
}

/** Whether the button this confirms can go. */
export function secretConfirmed(confirmation: Confirmation | null, password: string): boolean {
  return !!confirmation && (confirmation.justConfirmed || (confirmation.hasPassword && password.length > 0));
}

/** The confirming part of a form: a sign-in just made, the password box, or the button to sign in again. */
export function SecretConfirmFields({
  confirmation,
  id,
  password,
  onPassword,
  onEnter,
  hint,
}: {
  confirmation: Confirmation | null;
  id: string;
  password: string;
  onPassword: (value: string) => void;
  onEnter?: () => void;
  hint?: string;
}) {
  const [pending, startTransition] = useTransition();
  if (!confirmation) return <p className="text-sm text-subtle">Checking how you signed in…</p>;
  const name = confirmation.providerName ?? "Microsoft";

  function reconfirm() {
    const provider = confirmation?.provider;
    if (!provider) return;
    startTransition(async () => {
      await reconfirmForSecret(provider, `${window.location.pathname}${window.location.search}`);
    });
  }

  if (confirmation.justConfirmed) {
    return <p className="rounded-base bg-surface-sunken px-3 py-2 text-sm text-muted">You just signed in with {name}, which confirms it&apos;s you.</p>;
  }
  if (!confirmation.hasPassword) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted">
          You sign in with {name}, so this account has no Deskzo password. Sign in with {name} again to confirm it&apos;s you. You&apos;ll come straight back here, then open this again.
        </p>
        {confirmation.mayReconfirm ? (
          <Button type="button" variant="secondary" size="sm" onClick={reconfirm} disabled={pending}>
            Confirm with {name}
          </Button>
        ) : (
          <p className="text-sm text-danger">Ask an admin: no way of signing in is switched on that could confirm this.</p>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Your password</Label>
      <Input
        id={id}
        type="password"
        value={password}
        autoComplete="current-password"
        onChange={(e) => onPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && password) onEnter?.();
        }}
      />
      {hint && <p className="text-xs text-subtle">{hint}</p>}
      {confirmation.mayReconfirm && (
        <button type="button" className="text-xs text-brand hover:underline" onClick={reconfirm} disabled={pending}>
          Or confirm with {name}
        </button>
      )}
    </div>
  );
}
