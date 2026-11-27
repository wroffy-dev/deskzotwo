import { timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { digestSecret } from "@/lib/crypto";
import { notMigratedYet } from "@/lib/not-migrated";
import { getOrganisation } from "@/lib/organisation";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { workspaceClock } from "@/lib/time/workspace";
import { escapeHtml } from "@/lib/marketing/html";
import { deliverNow } from "@/lib/marketing/pipeline";
import { TOPICS } from "@/lib/marketing/topics";

/**
 * Double opt-in (owner, 1 Nov 2026). A form's sign-up is recorded as PENDING — anybody can type somebody else's address
 * into a form (src/actions/marketing-public.ts) — and marketing withholds anything not SUBSCRIBED. This emails the
 * address a link; pressing the button on its page makes the consent SUBSCRIBED, with the confirmation as its evidence.
 *
 * The page asks for a press rather than confirming on opening: mail scanners (Outlook's Safe Links among them) open the
 * links in an email by themselves, and would otherwise confirm for the person.
 */

const RESEND_AFTER_MS = 24 * 60 * 60 * 1000;

async function mac(consentId: string): Promise<string> {
  return (await digestSecret(`consent-confirm:${consentId}`)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 22);
}

export async function confirmationToken(consentId: string): Promise<string> {
  return `${consentId}.${await mac(consentId)}`;
}

/** The consent a confirmation link names, when its MAC is right. */
export async function consentOfToken(token: string): Promise<string | null> {
  const [id, given, extra] = token.split(".");
  if (extra !== undefined || !id || !given || !/^[a-z0-9]{10,40}$/.test(id)) return null;
  const expected = Buffer.from(await mac(id));
  const got = Buffer.from(given);
  return expected.length === got.length && timingSafeEqual(expected, got) ? id : null;
}

/**
 * Emails the confirmation for a pending consent — once, and again at most once a day however often the form is sent,
 * so the form can't be used to flood somebody's inbox. Says why it didn't send rather than throwing.
 */
export async function sendConfirmation(consentId: string, formName: string, opts: { resubscribe?: boolean } = {}): Promise<{ sent: boolean; reason?: string }> {
  const consent = await db.contactConsent.findUnique({ where: { id: consentId }, select: { id: true, status: true, topic: true, channel: true, contactId: true, contact: { select: { name: true, email: true } } } });
  const to = consent?.contact.email?.trim();
  if (!consent || consent.status !== "PENDING" || consent.channel !== "EMAIL" || !to) return { sent: false, reason: "nothing pending" };
  let previous;
  try {
    previous = await db.consentConfirmation.findUnique({ where: { consentId } });
  } catch (err) {
    if (notMigratedYet(err)) return { sent: false, reason: "not migrated" };
    throw err;
  }
  // A re-subscribe after unsubscribing from everything asks afresh, whatever an older sign-up confirmed.
  if (previous?.confirmedAt && !opts.resubscribe) return { sent: false, reason: "confirmed already" };
  if (previous && Date.now() - previous.sentAt.getTime() < RESEND_AFTER_MS) return { sent: false, reason: "sent in the last day" };

  const [org, origin] = await Promise.all([getOrganisation(), tenantOrigin()]);
  const ours = org.tradeName || org.legalName || "us";
  // A re-subscribe names every topic asked for again — one email confirms them all (`confirmConsent`).
  const askedAgain = opts.resubscribe
    ? (await db.contactConsent.findMany({ where: { contactId: consent.contactId, channel: "EMAIL", status: "PENDING", source: "PREFERENCE_CENTRE" }, select: { topic: true } })).map((c) => c.topic)
    : [consent.topic];
  const topic = askedAgain.map((key) => TOPICS.find((t) => t.key === key)?.label.toLowerCase() ?? "our updates").join(", ") || "our updates";
  const link = `${origin}/preferences/confirm/${await confirmationToken(consentId)}`;
  const first = consent.contact.name.trim().split(/\s+/)[0] ?? "";
  const asked = opts.resubscribe
    ? `Somebody asked, from the link in one of our emails, for this address to hear from ${escapeHtml(ours)} again after unsubscribing from everything. Would you like to hear from us about ${escapeHtml(topic)}?`
    : `You filled in “${escapeHtml(formName)}”. Would you like to hear from ${escapeHtml(ours)} about ${escapeHtml(topic)}?`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#111;max-width:520px">
<p>Hi${first ? ` ${escapeHtml(first)}` : ""},</p>
<p>${asked}</p>
<p style="margin:24px 0"><a href="${link}" style="background:#0249fe;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold">Yes, keep me posted</a></p>
<p style="color:#555;font-size:13px">If you didn't ask, ignore this email — you won't hear from us. You can always change your mind from the link at the foot of every email we send.</p>
</div>`;
  const question = opts.resubscribe
    ? `Somebody asked, from the link in one of our emails, for this address to hear from ${ours} again after unsubscribing from everything. Would you like to hear from us about ${topic}?`
    : `You filled in "${formName}". Would you like to hear from ${ours} about ${topic}?`;
  const text = `Hi${first ? ` ${first}` : ""},\n\n${question}\n\nConfirm: ${link}\n\nIf you didn't ask, ignore this email — you won't hear from us.`;
  const sent = await deliverNow({ to, toName: consent.contact.name, subject: `Please confirm — ${ours}`, html, text }, "TRANSACTIONAL", { delivering: true });
  if (!sent.ok) return { sent: false, reason: sent.error };
  const now = new Date();
  await db.consentConfirmation.upsert({
    where: { consentId },
    create: { consentId, sentAt: now, sentTo: to.toLowerCase() },
    update: { sentAt: now, sentTo: to.toLowerCase(), sends: { increment: 1 }, ...(opts.resubscribe ? { confirmedAt: null } : {}) },
  });
  return { sent: true };
}

/** What a confirmation link's page shows: whose, about what, and whether it's still to confirm. */
export async function confirmationState(token: string): Promise<{ state: "pending" | "confirmed" | "withdrawn"; ours: string; topic: string; email: string } | null> {
  const consentId = await consentOfToken(token);
  if (!consentId) return null;
  const consent = await db.contactConsent.findUnique({ where: { id: consentId }, select: { status: true, topic: true, contact: { select: { email: true } } } });
  if (!consent) return null;
  const org = await getOrganisation();
  return {
    state: consent.status === "SUBSCRIBED" ? "confirmed" : consent.status === "UNSUBSCRIBED" ? "withdrawn" : "pending",
    ours: org.tradeName || org.legalName || "us",
    topic: TOPICS.find((t) => t.key === consent.topic)?.label ?? consent.topic,
    email: consent.contact.email ?? "",
  };
}

/**
 * The button pressed: a pending consent becomes SUBSCRIBED, the confirmation its evidence. One somebody has since
 * withdrawn stays withdrawn — an old link never turns an unsubscribe back on.
 */
export async function confirmConsent(token: string): Promise<boolean> {
  const consentId = await consentOfToken(token);
  if (!consentId) return false;
  const consent = await db.contactConsent.findUnique({ where: { id: consentId }, select: { status: true, evidence: true, source: true, contactId: true, contact: { select: { email: true } } } });
  if (!consent || consent.status === "UNSUBSCRIBED") return false;
  if (consent.status === "SUBSCRIBED") return true;
  const now = new Date();
  const day = (await workspaceClock()).date(now);
  const evidence = `${consent.evidence ?? "Signed up on a form"} Confirmed from the link emailed to ${consent.contact.email ?? "their address"} on ${day}.`.slice(0, 1000);
  const changed = await db.contactConsent.updateMany({ where: { id: consentId, status: "PENDING" }, data: { status: "SUBSCRIBED", evidence, capturedAt: now, withdrawnAt: null } });
  await db.consentConfirmation.updateMany({ where: { consentId }, data: { confirmedAt: now } }).catch(() => undefined);
  /**
   * A re-subscribe asked for in the preference centre after unsubscribing from everything (security audit round three,
   * 14 Nov 2026 — R3-22; src/actions/marketing-public.ts `updatePreferences`): confirmed from the mailbox itself, every
   * topic asked for with it is subscribed, and the blanket unsubscribe on the address is lifted — only now.
   */
  if (changed.count > 0 && consent.source === "PREFERENCE_CENTRE") {
    const others = await db.contactConsent.findMany({ where: { contactId: consent.contactId, channel: "EMAIL", status: "PENDING", source: "PREFERENCE_CENTRE" }, select: { id: true, evidence: true } });
    for (const o of others) {
      const said = `${o.evidence ?? "Asked for in the preference centre."} Confirmed from the link emailed to ${consent.contact.email ?? "their address"} on ${day}.`.slice(0, 1000);
      await db.contactConsent.updateMany({ where: { id: o.id, status: "PENDING" }, data: { status: "SUBSCRIBED", evidence: said, capturedAt: now, withdrawnAt: null } });
    }
    const address = consent.contact.email?.trim().toLowerCase();
    if (address) await db.suppression.deleteMany({ where: { scope: "EMAIL", value: address, reason: "UNSUBSCRIBED" } }).catch(() => undefined);
  }
  return changed.count > 0;
}
