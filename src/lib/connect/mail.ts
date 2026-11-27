import { getOrganisation } from "@/lib/organisation";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { INVITE_DAYS } from "@/lib/connect/guest-auth";

/**
 * Deskzo Connect's two emails (owner, 20 Nov 2026 — src/lib/connect): the invitation and the sign-in code, in the
 * wording of the `account.guest-invite` and `account.guest-code` templates. As the portal's code: the company's own
 * mail when it has a route for such mail, else Deskzo's as "<business> via Deskzo". Neither names a customer.
 */

async function business(): Promise<string> {
  const org = await getOrganisation();
  return org.tradeName || org.legalName || "us";
}

async function deliver(key: "account.guest-invite" | "account.guest-code" | "account.guest-list-shared" | "account.guest-comments" | "account.guest-suggestion-decided", to: string, name: string, values: Record<string, string>, logSubject: string) {
  const [{ deliverNow, emailRouteFor }, { textToHtml }, { sendPlatformMail }, { renderPlatformMail, templateMail }] = await Promise.all([
    import("@/lib/marketing/pipeline"),
    import("@/lib/marketing/html"),
    import("@/lib/platform/mailer"),
    import("@/lib/platform/mail/templates"),
  ]);
  if (await emailRouteFor("TRANSACTIONAL").catch(() => null)) {
    const { subject, text } = await renderPlatformMail(key, values);
    const sent = await deliverNow({ to, toName: name, fromName: values.business ?? "", replyTo: null, subject, html: textToHtml(text), text }, "TRANSACTIONAL", { delivering: true });
    if (sent.ok) return;
  }
  await sendPlatformMail({ type: "ACCOUNT", to, ...(await templateMail(key, values, { workspace: values.business })), logSubject });
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";

/** Where a guest signs in: this workspace's own address, /connect. */
export async function connectLink(): Promise<string> {
  return `${await tenantOrigin()}/connect`;
}

export async function mailGuestInvite(guest: { email: string; name: string }, inviter: string): Promise<void> {
  const values = { firstName: firstName(guest.name), business: await business(), inviter: inviter || "Somebody", link: await connectLink(), days: String(INVITE_DAYS) };
  await deliver("account.guest-invite", guest.email, guest.name, values, "A Deskzo Connect invitation");
}

export async function mailGuestCode(guest: { email: string; name: string }, code: string, minutes: number): Promise<void> {
  const values = { firstName: firstName(guest.name), business: await business(), code, minutes: String(minutes) };
  await deliver("account.guest-code", guest.email, guest.name, values, "A Deskzo Connect sign-in code");
}

// ─── When something changes for a guest (owner, 20 Nov 2026 — src/lib/connect/notices.ts) ─────────────────────────

export async function mailGuestListShared(guest: { email: string; name: string }, list: string, sharer: string): Promise<void> {
  const values = { firstName: firstName(guest.name), business: await business(), sharer: sharer || "Somebody", list, link: await connectLink() };
  await deliver("account.guest-list-shared", guest.email, guest.name, values, "Deskzo Connect: a list shared");
}

export async function mailGuestComments(guest: { email: string; name: string }, list: string, author: string): Promise<void> {
  const values = { firstName: firstName(guest.name), business: await business(), author: author || "Somebody", list, link: await connectLink() };
  await deliver("account.guest-comments", guest.email, guest.name, values, "Deskzo Connect: comments for a guest");
}

export async function mailGuestSuggestionDecided(guest: { email: string; name: string }, list: string, outcome: string): Promise<void> {
  const values = { firstName: firstName(guest.name), business: await business(), list, outcome, link: await connectLink() };
  await deliver("account.guest-suggestion-decided", guest.email, guest.name, values, "Deskzo Connect: a suggestion decided");
}
