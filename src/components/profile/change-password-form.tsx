"use client";

import { useState, useTransition } from "react";
import type { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { changeOwnPassword, emailMyPasswordLink, reconfirmWithProvider, type passwordChange } from "@/actions/profile";
import { changePasswordSchema, type ChangePasswordInput } from "@/lib/validation/profile";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

type FormValues = z.input<typeof changePasswordSchema>;

/** What the card offers this person (src/actions/profile.ts `passwordChange`). */
export type PasswordSetup = Awaited<ReturnType<typeof passwordChange>>;

export function ChangePasswordForm({ setup, onSuccess }: { setup: PasswordSetup; onSuccess?: () => void }) {
  const [reconfirming, startReconfirm] = useTransition();
  // "Type my current password instead", where Microsoft leads but they have one.
  const [usePassword, setUsePassword] = useState(false);
  const [linkSent, setLinkSent] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, ChangePasswordInput>({ resolver: zodResolver(changePasswordSchema) });

  async function onSubmit(values: ChangePasswordInput) {
    setServerError(null);
    setSuccess(false);
    const result = await changeOwnPassword(values);
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    reset();
    setSuccess(true);
    onSuccess?.();
  }

  // Their sign-in rule leaves no password (owner, 3 Nov 2026): nothing to set, and why.
  if (!setup.allowed) {
    return <p className="text-sm text-muted">You sign in with {setup.ways}, as your administrator has set, so there&rsquo;s no Deskzo password to change.</p>;
  }
  const reconfirm = () => {
    if (!setup.provider) return;
    const provider = setup.provider;
    startReconfirm(async () => {
      await reconfirmWithProvider(provider, window.location.pathname);
    });
  };
  const emailLink = () =>
    startReconfirm(async () => {
      setServerError(null);
      const r = await emailMyPasswordLink();
      if (r.ok) setLinkSent(r.data.to);
      else setServerError(r.error);
    });
  /** The way out for somebody who doesn't know their current password. */
  const noCurrent = linkSent ? (
    <p className="text-xs text-success">A link to set a new password is on its way to {linkSent}.</p>
  ) : (
    <button type="button" className="text-xs text-brand hover:underline" onClick={emailLink} disabled={reconfirming}>
      Don&rsquo;t know your current password? Email me a link to set a new one
    </button>
  );

  // Microsoft first (owner, 3 Nov 2026): no password of their own, or one they may never have known.
  if (setup.needsReconfirm && !usePassword) {
    return (
      <div className="space-y-2">
        {serverError && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{serverError}</p>}
        <p className="text-sm text-muted">
          {setup.hasPassword ? "You signed in with " : "You sign in with "}
          {setup.providerName ?? "Microsoft"}
          {setup.hasPassword ? ". " : " and have no Deskzo password yet. "}
          To set a new password, confirm it&rsquo;s you with {setup.providerName ?? "Microsoft"} — you&rsquo;ll come straight back here, and
          won&rsquo;t need a current password.
        </p>
        {setup.provider && (
          <Button type="button" variant="secondary" size="sm" onClick={reconfirm} disabled={reconfirming}>
            Confirm with {setup.providerName}
          </Button>
        )}
        <div className="flex flex-col items-start gap-1">
          {setup.hasPassword && (
            <button type="button" className="text-xs text-brand hover:underline" onClick={() => setUsePassword(true)}>
              I know my current password
            </button>
          )}
          {noCurrent}
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
      {serverError && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{serverError}</p>}
      {success && <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">Password updated.</p>}
      {setup.needsCurrent ? (
        <div className="space-y-1.5">
          <Label htmlFor="currentPassword">Current password</Label>
          <Input id="currentPassword" type="password" autoComplete="current-password" {...register("currentPassword")} />
          {errors.currentPassword && <p className="text-xs text-danger">{errors.currentPassword.message}</p>}
          <div className="flex flex-col items-start gap-1">
            {setup.provider && (
              <button type="button" className="text-xs text-brand hover:underline" onClick={reconfirm} disabled={reconfirming}>
                Or confirm with {setup.providerName} instead
              </button>
            )}
            {noCurrent}
          </div>
        </div>
      ) : (
        <p className="text-xs text-subtle">You signed in with {setup.providerName ?? "Microsoft"} a moment ago, so your current password isn&rsquo;t needed.</p>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="newPassword">New password</Label>
        <Input id="newPassword" type="password" autoComplete="new-password" {...register("newPassword")} />
        {errors.newPassword && <p className="text-xs text-danger">{errors.newPassword.message}</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="confirmPassword">Confirm new password</Label>
        <Input id="confirmPassword" type="password" autoComplete="new-password" {...register("confirmPassword")} />
        {errors.confirmPassword && <p className="text-xs text-danger">{errors.confirmPassword.message}</p>}
      </div>
      <Button type="submit" size="sm" disabled={isSubmitting}>
        {isSubmitting ? "Saving…" : "Update password"}
      </Button>
    </form>
  );
}
