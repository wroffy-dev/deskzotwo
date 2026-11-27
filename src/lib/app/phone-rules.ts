/**
 * How a paired phone is doing, in one line (owner, 31 Oct 2026: "when did the user's calls last sync from his device
 * and what's the device"). Pure, for Settings › Security › Access › Phones and scripts/check-phones.ts.
 *
 * The app sends its calls after every call, every quarter of an hour and when it is opened — but only when its call
 * log has something new (mobile/modules/deskzo-calls CallSync.kt). So a phone quiet for days has either made no
 * calls or stopped sending; the words say so rather than guess.
 */

/** Days without any calls from a phone with call sync on before it is worth a look. */
export const QUIET_DAYS = 2;

const DAY = 86_400_000;

export type PhoneFacts = {
  /** The device row's standing: approved to sign in, waiting, or signed out (rejected, revoked). */
  status: "PENDING" | "APPROVED" | "REJECTED" | "REVOKED";
  callSync: boolean;
  pairedAt: Date;
  lastCallSyncAt: Date | null;
};

export type PhoneHealth = { label: string; tone: "ok" | "warn" | "muted" };

export function phoneHealth(p: PhoneFacts, now: Date): PhoneHealth {
  if (p.status === "REJECTED" || p.status === "REVOKED") return { label: "Signed out", tone: "muted" };
  if (p.status === "PENDING") return { label: "Waiting for approval", tone: "warn" };
  if (!p.callSync) return { label: "Call sync off", tone: "warn" };
  const since = p.lastCallSyncAt ?? p.pairedAt;
  const days = Math.floor((now.getTime() - since.getTime()) / DAY);
  if (days < QUIET_DAYS) return { label: p.lastCallSyncAt ? "Sending calls" : "On — no calls yet", tone: p.lastCallSyncAt ? "ok" : "muted" };
  return { label: p.lastCallSyncAt ? `No calls for ${days} days` : `No calls since pairing, ${days} days`, tone: "warn" };
}

/** "Samsung SM-S918B · Android · app 0.4.1", from what the phone says of itself. */
export function phoneDescription(p: { model: string | null; platform: string; appVersion: string | null }): string {
  const os = p.platform === "ios" ? "iPhone" : p.platform === "android" ? "Android" : p.platform;
  return [p.model?.trim() || null, os, p.appVersion ? `app ${p.appVersion}` : null].filter(Boolean).join(" · ");
}
