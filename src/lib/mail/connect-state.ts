import { randomBytes } from "crypto";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { safeAppPath } from "@/lib/app/paths";

/**
 * The half of a mailbox connection that has to survive the trip to the provider and back: who
 * started it, with which provider, the PKCE verifier, the state the provider must return, and where
 * to land afterwards. Kept in an encrypted, short-lived cookie scoped to the routes that use it
 * (src/app/api/mail/[provider]).
 */

export const CONNECT_COOKIE = "deskzo.mail-connect";
export const CONNECT_COOKIE_PATH = "/api/mail";
export const CONNECT_TTL_SECONDS = 600;

/** `provider`: the URL segment it was started for — absent on one started before Gmail and Zoho, which was Outlook. */
/**
 * `purpose`: "signatures" for a Zoho Mail administrator's grant for the company's signatures
 * (src/lib/signatures/connect.ts), which comes back through the same callback as a person's mailbox.
 */
export type ConnectState = { state: string; verifier: string; userId: string; expires: number; next: string; provider?: string; purpose?: "signatures" };

export function newState(): string {
  return randomBytes(24).toString("base64url");
}

export async function sealState(s: ConnectState): Promise<string> {
  return await encryptSecret(JSON.stringify(s));
}

export async function openState(sealed: string | undefined): Promise<ConnectState | null> {
  if (!sealed) return null;
  try {
    const s = JSON.parse(await decryptSecret(sealed)) as ConnectState;
    if (typeof s.state !== "string" || typeof s.verifier !== "string" || typeof s.userId !== "string") return null;
    return s.expires > Date.now() ? s : null;
  } catch {
    return null;
  }
}

/**
 * Only a path inside this app — never an address that would carry somebody off-site after connecting. Security
 * audit, Nov 2026: this refused only a leading "//" or "/\", and the URL parser drops tab, CR and LF, so
 * "/%09/evil.example" became "//evil.example". It now asks safeAppPath (src/lib/app/paths.ts), which refuses any
 * backslash, space or control character.
 */
export function safeNext(next: string | null | undefined): string {
  return safeAppPath(next) ?? "/profile";
}

/** The redirect after connecting: on this origin, or Profile — whatever `next` turned into once parsed. */
export function sameOriginRedirect(path: string, origin: string): URL {
  const url = new URL(path, origin);
  return url.origin === new URL(origin).origin ? url : new URL("/profile", origin);
}

/**
 * The workspace's public address, which Microsoft must see in the redirect exactly as it is
 * registered — see src/lib/tenancy/resolve.ts tenantOrigin().
 */
export async function publicOrigin(): Promise<string> {
  return tenantOrigin();
}
