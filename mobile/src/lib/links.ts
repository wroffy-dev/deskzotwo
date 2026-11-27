import { Linking } from "react-native";

/**
 * Security audit round two, 13 Nov 2026 (Lows): where the app lets a link take the person.
 *
 *   · `safeAppPath` — a page of the workspace for the app's page view (deskzo://web?path=…): the server's own rule
 *     (src/lib/app/paths.ts) word for word — one leading slash, no backslash, no space or control character, and
 *     nothing that signs in again or is an API. Anything else opens the dashboard.
 *   · `openOutside` — a link handed to another app: only https, a phone number, an email or a map. Any other scheme
 *     (intent:, file:, content:, another app's own) is dropped, so a page or a meeting's link can't start an app with
 *     whatever it likes.
 */

export function safeAppPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 300) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if ([...value].some((ch) => ch === "\\" || ch.charCodeAt(0) <= 32 || ch.charCodeAt(0) === 127)) return null;
  if (/^\/(api|handoff|login|switch|link)(\/|\?|#|$)/.test(value)) return null;
  return value;
}

const OUTSIDE = /^(https:\/\/|tel:|mailto:|geo:)/i;

/** Whether a link may be handed to another app on the phone. */
export const mayOpenOutside = (url: string) => OUTSIDE.test(url.trim());

/** Opens a link in the app made for it — when its scheme is one of those allowed; otherwise nothing. */
export async function openOutside(url: string): Promise<boolean> {
  if (!mayOpenOutside(url)) return false;
  try {
    await Linking.openURL(url.trim());
    return true;
  } catch {
    return false;
  }
}
