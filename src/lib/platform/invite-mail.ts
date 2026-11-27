import { controlDb } from "@/lib/platform/control-db";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { templateMail } from "@/lib/platform/mail/templates";
import { consoleClock } from "@/lib/platform/console-clock";
import { PLATFORM_DOMAIN, protocolFor } from "@/lib/tenancy/host";

/**
 * Getting an invitation to its customer (owner, 13 Nov 2026: "the tenant name is held up so console admin should have
 * option to send link on mail or copy"). The code is kept only as its hash, so the console can't show it twice: an
 * invitation is emailed when it's made, or — later — a new code is issued for it (the old one stops working) and that
 * one is emailed or copied. Every email is kept in `signup_invite_sends`, whether it went or not.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** An address to send to, tidied — or null when it isn't one. */
export function inviteAddress(value: unknown): string | null {
  const to = String(value ?? "").trim().toLowerCase();
  return to && to.length <= 254 && EMAIL.test(to) ? to : null;
}

/** Where people sign up: the public site's own address, as the Invitations page shows it. */
export function signupPageUrl(): string {
  const siteHost = `www.${PLATFORM_DOMAIN}${process.env.PLATFORM_PORT ? `:${process.env.PLATFORM_PORT}` : ""}`;
  return `${protocolFor(siteHost)}://${siteHost}/signup`;
}

/** The workspace address an invitation holds, in full: "acme" → "acme.deskzo.com". */
export function heldAddress(slug: string): string {
  return `${slug}.${PLATFORM_DOMAIN}${process.env.PLATFORM_PORT ? `:${process.env.PLATFORM_PORT}` : ""}`;
}

/**
 * The signup link for a code: it carries the code when the invitation holds an address — the signup form then opens
 * with that address filled in and locked — as the console's "Signup link" always has.
 */
export function inviteLink(code: string, heldSlug: string | null): string {
  return heldSlug ? `${signupPageUrl()}?invite=${encodeURIComponent(code)}` : signupPageUrl();
}

export type InviteForMail = { codeHash: string; note: string | null; planKey: string | null; heldSlug: string | null; expiresAt: Date | null };

/** Emails one invitation with its code, and keeps a note of it. Never throws: what went wrong comes back. */
export async function emailInvitation(invite: InviteForMail, code: string, to: string, staffId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const control = controlDb();
  const plan = invite.planKey ? await control.plan.findUnique({ where: { key: invite.planKey }, select: { name: true } }) : null;
  const clock = await consoleClock();
  let error: string | null = null;
  try {
    await sendPlatformMail({
      type: "ACCOUNT",
      to,
      ...(await templateMail("workspaces.invitation", {
        name: invite.note,
        link: inviteLink(code, invite.heldSlug),
        code,
        address: invite.heldSlug ? heldAddress(invite.heldSlug) : null,
        plan: plan?.name ?? null,
        until: invite.expiresAt ? clock.date(invite.expiresAt) : "it's used",
      })),
      logSubject: "Your invitation to set up a Deskzo workspace",
    });
  } catch (err) {
    error = err instanceof Error ? err.message.slice(0, 300) : "It couldn't be sent.";
  }
  await control.signupInviteSend.create({ data: { codeHash: invite.codeHash, to, sentBy: staffId, ok: error === null, error } });
  return error === null ? { ok: true } : { ok: false, error };
}

/** The last email of each invitation, for the list. */
export async function lastSends(codeHashes: string[]): Promise<Map<string, { to: string; sentAt: Date; ok: boolean }>> {
  if (codeHashes.length === 0) return new Map();
  const rows = await controlDb().signupInviteSend.findMany({
    where: { codeHash: { in: codeHashes } },
    orderBy: { sentAt: "desc" },
    select: { codeHash: true, to: true, sentAt: true, ok: true },
  });
  const out = new Map<string, { to: string; sentAt: Date; ok: boolean }>();
  for (const r of rows) if (!out.has(r.codeHash)) out.set(r.codeHash, { to: r.to, sentAt: r.sentAt, ok: r.ok });
  return out;
}
