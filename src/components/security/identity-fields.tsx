"use client";

import { Input } from "@/components/ui/input";
import { SecretConfirmFields, useSecretConfirmation } from "@/components/security/secret-confirmation";

type Confirmation = ReturnType<typeof useSecretConfirmation>;

/**
 * "Confirm it's you" before something that can't be taken back — a restore, a workspace reset (owner,
 * 22 Oct 2026; checked on the server by src/lib/security/confirm-identity.ts). The person's own password, or
 * signing in again where there isn't one, and their two-factor code once the server says they have it on (`showCode`).
 */
export function IdentityFields({
  idPrefix,
  password,
  onPassword,
  code,
  onCode,
  showCode,
  confirmation,
}: {
  confirmation: Confirmation;
  idPrefix: string;
  password: string;
  onPassword: (value: string) => void;
  code: string;
  onCode: (value: string) => void;
  showCode: boolean;
}) {
  return (
    <div className="space-y-3">
      {/* Password managers fill the text box just before a password with the sign-in email — even one marked
          autoComplete="off", like the reset's "type the workspace's address". This decoy takes that fill. */}
      <input type="text" autoComplete="username" tabIndex={-1} aria-hidden="true" className="sr-only" defaultValue="" />
      <SecretConfirmFields confirmation={confirmation} id={`${idPrefix}-password`} password={password} onPassword={onPassword} hint="To confirm it's you — the one you sign in with." />
      {showCode && (
        <div>
          <label htmlFor={`${idPrefix}-code`} className="text-xs font-medium text-text">
            Two-factor code
          </label>
          <Input
            id={`${idPrefix}-code`}
            value={code}
            onChange={(e) => onCode(e.target.value)}
            className="mt-1 font-mono"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={8}
          />
        </div>
      )}
    </div>
  );
}
