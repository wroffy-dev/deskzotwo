import { parseEmailAddress } from "@/lib/email-verification";

/**
 * Cc on the emails a person writes and sends from Deskzo (owner, 16 Nov 2026: "where ever there is mail button and
 * person is sending mail add cc"): documents, quick messages, statements and payment reminders. One rule for all of
 * them, client-safe so the dialogs read typed addresses the way the server does; the server half — the workspace's
 * block rules — is src/lib/mail/cc-server.ts.
 */

/** At most this many copied on one email. */
export const CC_MAX = 10;

/** What was typed into a Cc box: split on commas, semicolons and spaces. */
export function splitCc(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((a) => a.trim())
    .filter(Boolean);
}

/**
 * The typed addresses, each checked and lower-cased, without repeats or anybody already on the To line — or the
 * first one that isn't an address.
 */
export function parseCc(raw: unknown, alreadyTo: string[] = []): { ok: true; cc: string[] } | { ok: false; error: string } {
  const typed = (Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? splitCc(raw) : []).slice(0, 50);
  const taken = new Set(alreadyTo.map((a) => a.trim().toLowerCase()));
  const cc: string[] = [];
  for (const value of typed) {
    const text = value.trim();
    if (!text) continue;
    const parsed = parseEmailAddress(text);
    if (!parsed) return { ok: false, error: `"${text.slice(0, 80)}" isn't an email address.` };
    const address = `${parsed.local}@${parsed.domain}`;
    if (taken.has(address)) continue;
    taken.add(address);
    cc.push(address);
  }
  if (cc.length > CC_MAX) return { ok: false, error: `Copy ${CC_MAX} people at most.` };
  return { ok: true, cc };
}
