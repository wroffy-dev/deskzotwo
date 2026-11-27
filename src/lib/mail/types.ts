import type { WorkplaceProvider } from "@/lib/workplace/providers";

/** A message sent as a person from their own mailbox — Outlook, Gmail or Zoho Mail (src/lib/mail/mailbox.ts). */
export type OutgoingMail = {
  subject: string;
  html: string;
  to: { name: string | null; email: string }[];
  /** Copied in, as people the mail is also for. */
  cc?: { name: string | null; email: string }[];
  /**
   * Where a reply goes instead of the mailbox it was sent from (owner, 18 Nov 2026 — a nurture email's Deskzo reply-to
   * address, src/lib/nurture). Gmail and Outlook set it; Zoho Mail's sending API has no such field, so its replies come
   * back to the mailbox as usual.
   */
  replyTo?: { name: string | null; email: string };
  attachments: { name: string; contentType: string; bytes: Buffer }[];
  /**
   * Its place in an email thread (src/lib/documents/mail-thread.ts). Gmail takes the headers as written; Outlook's and
   * Zoho's sending APIs write their own, and the shared subject keeps the thread there.
   */
  thread?: { messageId: string; inReplyTo?: string; references?: string[] };
};

export type SendOutcome = { ok: true; mailbox: string; provider: WorkplaceProvider } | { ok: false; error: string; reconnect: boolean };

/** What a provider's token endpoint gave back. */
export type TokenSet = { accessToken: string; refreshToken: string | null; expiresAt: Date; scope: string };
export type TokenOutcome = { ok: true; tokens: TokenSet } | { ok: false; error: string; revoked: boolean };

/** One attempt at a send through a provider's API. A 401 is the caller's to retry with a fresh token. */
export type ProviderSend = { ok: true } | { ok: false; status: number; error: string };
