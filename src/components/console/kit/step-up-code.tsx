"use client";

import { useId } from "react";

/**
 * The fresh authenticator code a dangerous console change asks of the owner making it (security audit
 * round two, 13 Nov 2026, R2-08 — src/lib/platform/step-up.ts). Each code works once: after signing in,
 * or after another such change, wait for the app to show the next one.
 */
export function StepUpCodeField({ value, onChange, disabled, optionalNote }: { value: string; onChange: (value: string) => void; disabled?: boolean; optionalNote?: string }) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-xs font-medium text-text">
        Code from your authenticator
      </label>
      <input
        id={id}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
        className="w-32 rounded-base border border-line bg-surface px-2.5 py-1.5 font-mono text-sm tracking-widest text-text"
        placeholder="123456"
      />
      <p className="text-[11px] text-muted">{optionalNote ?? "A fresh code — each one works once. Every other owner is told of this change."}</p>
    </div>
  );
}
