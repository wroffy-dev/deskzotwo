"use server";

import type { MarketingTopic } from "@prisma/client";
import { requireUser, refuseWhileViewingAs } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { contactScope } from "@/lib/authz/contact-access";
import { orderAccess } from "@/lib/authz/access";
import { isModuleEntitled } from "@/lib/modules-access";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { STILL_THERE } from "@/lib/contacts/left";
import { contactMasker, maskedInLists } from "@/lib/contacts/masking";
import { creditsText } from "@/lib/ai/catalogue";
import { readDesign, type Design } from "@/lib/marketing/email-design";
import { designEmailWithAI as design, designProvider, DesignRefusal, designUnavailable } from "@/lib/marketing/ai-design";
import { libraryBrand } from "@/lib/marketing/library-brand";
import { composeEmail, escapeHtml, sanitizeEmailHtml } from "@/lib/marketing/html";
import { previewValues, render, type MergeValues } from "@/lib/marketing/merge";
import { deliverNow, marketingSettings, mergeValuesFor, subscriptionMergeValues, type Recipient } from "@/lib/marketing/pipeline";
import { daysLeftPhrase } from "@/lib/marketing/customer-notices";
import { tagHtmlLinks, tagTextLinks } from "@/lib/marketing/utm";
import { formatOrderId } from "@/lib/order-id";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import type { ActionResult } from "@/actions/company";

/**
 * The email builder's helpers (owner, 1 Nov 2026): designing an email with Deskzo AI, and sending a saved template to
 * oneself — with sample values, or a real contact's own, their company's soonest subscription included — to see it
 * in a real inbox before anybody else does. For whoever may manage marketing.
 */

async function gate(): Promise<{ userId: string } | { error: string }> {
  const user = await requireUser();
  if (!(await isModuleEntitled("marketing"))) return { error: "Marketing isn't part of this workspace's plan." };
  if (!(await can(user.id, "marketing.manage"))) return { error: "You can't design marketing emails." };
  return { userId: user.id };
}

/** Whether AI can design for this person now, and where their words go — shown before they type. */
export async function emailAiStatus(): Promise<{ unavailable: string | null; provider: string }> {
  const g = await gate();
  if ("error" in g) return { unavailable: g.error, provider: "Deskzo AI" };
  const [unavailable, provider] = await Promise.all([designUnavailable(g.userId), designProvider()]);
  return { unavailable, provider };
}

export type AiDesignResult = { name: string; subjects: string[]; preheader: string; topic: MarketingTopic; design: Design; notes: string[]; credits: string };

/** A new email from a description — or `current` changed as it says. Nothing is saved; the builder opens it. */
export async function designEmailWithAI(input: { description: string; current?: unknown }): Promise<ActionResult<AiDesignResult>> {
  const g = await gate();
  if ("error" in g) return { ok: false, error: g.error };
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  try {
    const out = await design({ userId: g.userId, description: String(input?.description ?? ""), brand: await libraryBrand(), current: input?.current ? readDesign(input.current) : null });
    await recordAudit({ userId: g.userId, action: "CREATE", entityType: "MarketingTemplate", entityId: "ai-design", entityLabel: `Email designed with Deskzo AI: ${out.name} (${creditsText(out.usage.credits)})` });
    return { ok: true, data: { name: out.name, subjects: out.subjects, preheader: out.preheader, topic: out.topic, design: out.design, notes: out.notes, credits: creditsText(out.usage.credits) } };
  } catch (err) {
    if (err instanceof DesignRefusal) return { ok: false, error: err.message };
    throw err;
  }
}

/** Contacts to fill a test with: still at their company, with an email address — by name, email or company. */
export async function searchTestContacts(query: string): Promise<{ id: string; name: string; email: string; company: string }[]> {
  const g = await gate();
  if ("error" in g) return [];
  const q = String(query ?? "").trim().slice(0, 80);
  if (q.length < 2) return [];
  const has = { contains: q, mode: "insensitive" as const };
  // As the contacts policy shows them in a list, and no match on an address this person sees masked (owner, 5 Nov 2026 —
  // Phase 3 masking fixes, audit H.4.3; src/lib/contacts/masking.ts), as the Contacts list's own search.
  const hidden = await maskedInLists(g.userId);
  const rows = await db.contact.findMany({
    // Only contacts this person may see (owner, 3 Nov 2026 — Phase 2 permission fixes): `contacts.view` and the Contacts
    // record level (`contactScope`), as the company's Contacts tab asks — it listed every contact to anybody with the key.
    // Not a name masked in lists, nor sorted by one (security audit round three, 14 Nov 2026 — R3-21).
    where: { AND: [{ email: { not: null }, ...STILL_THERE, OR: [...(hidden.name ? [] : [{ name: has }]), ...(hidden.email ? [] : [{ email: has }]), { company: { name: has } }] }, await contactScope(g.userId)] },
    orderBy: hidden.name ? [{ company: { name: "asc" } }, { id: "asc" }] : [{ name: "asc" }],
    take: 10,
    select: { id: true, name: true, email: true, company: { select: { name: true } } },
  });
  const people = await contactMasker(g.userId, "list", rows.map((r) => r.id));
  return rows.map((r) => ({ id: r.id, name: people.present(r.id, "name", r.name) ?? "", email: people.present(r.id, "email", r.email) ?? "", company: r.company.name }));
}

/**
 * A contact as a test's recipient: their own merge values, and their company's soonest subscription's — only a contact
 * `userId` may see, and only a subscription they reach at their Orders level (owner, 3 Nov 2026 — Phase 2 permission
 * fixes, check:record-scope: any contact's details and their account's subscription were mailed to whoever asked).
 */
async function contactValues(userId: string, contactId: string): Promise<{ values: MergeValues; who: string } | null> {
  const contact = await db.contact.findFirst({
    where: { AND: [{ id: contactId, ...STILL_THERE }, await contactScope(userId)] },
    select: { id: true, name: true, email: true, phone: true, companyId: true, company: { select: { name: true, owner: { select: { name: true, email: true } } } } },
  });
  if (!contact) return null;
  // The contact's name, email and phone as this person sees them in a list (owner, 5 Nov 2026 — Phase 3 masking fixes,
  // audit H.4.3; src/lib/contacts/masking.ts): a test goes to the tester's own inbox, and filled in full it mailed them
  // what the screen masks. Their merge values are what the tester would see of them anywhere else.
  const people = await contactMasker(userId, "list", [contact.id]);
  const name = people.present(contact.id, "name", contact.name) ?? "";
  const email = contact.email === null ? null : people.present(contact.id, "email", contact.email);
  const phone = contact.phone === null ? null : people.present(contact.id, "phone", contact.phone);
  const recipient = { contactId: contact.id, companyId: contact.companyId, companyName: contact.company.name, name, email, phone, ownerName: contact.company.owner?.name ?? null, ownerEmail: contact.company.owner?.email ?? null, state: {} } as unknown as Recipient;
  const today = new Date(new Date().toISOString().slice(0, 10));
  const sub = await db.companyProduct.findFirst({
    where: { AND: [{ companyId: contact.companyId, parentId: null, item: { type: "SUBSCRIPTION" }, endDate: { gte: today }, orderStatus: { notIn: ["CANCELLED", "REJECTED"] } }, await orderAccess(userId, "view")] },
    orderBy: { endDate: "asc" },
    select: { orderSeq: true, quantity: true, endDate: true, fullTermUnitPrice: true, poNumber: true, item: { select: { name: true } } },
  });
  const order = sub
    ? (() => {
        const v = subscriptionMergeValues(sub);
        return { ...v, daysLeftPhrase: daysLeftPhrase(typeof v.daysLeft === "number" ? v.daysLeft : null), orderId: formatOrderId(sub.orderSeq), poNumber: sub.poNumber };
      })()
    : {};
  const settings = await marketingSettings();
  return { values: mergeValuesFor(recipient, settings, order), who: `${name} (${contact.company.name})` };
}

/**
 * A saved template, to the person asking only — "[Test]" before its subject, filled with sample values or `contactId`'s
 * own, its links tagged as they will be. A field with no value and no fallback is said, not sent half-filled.
 */
export async function sendTemplateTest(input: { templateId: string; contactId?: string | null }): Promise<ActionResult<{ to: string; as: string }>> {
  const g = await gate();
  if ("error" in g) return { ok: false, error: g.error };
  const [template, me] = await Promise.all([
    db.marketingTemplate.findUnique({ where: { id: String(input?.templateId ?? "") }, select: { id: true, name: true, channel: true, subject: true, preheader: true, body: true, format: true } }),
    db.user.findUnique({ where: { id: g.userId }, select: { email: true, name: true } }),
  ]);
  if (!template || template.channel !== "EMAIL") return { ok: false, error: "Save the email first — only a saved template can be sent as a test." };
  if (!me?.email) return { ok: false, error: "Your account has no email address to send the test to." };

  let values: MergeValues = previewValues();
  let as = "sample values";
  if (input?.contactId) {
    if (!(await can(g.userId, "contacts.view"))) return { ok: false, error: "You can't see contacts' details, so can't fill a test with one." };
    const found = await contactValues(g.userId, String(input.contactId));
    if (!found) return { ok: false, error: "That contact isn't there any more." };
    values = found.values;
    as = found.who;
  }
  const [settings, origin] = await Promise.all([marketingSettings(), tenantOrigin()]);
  values = { ...values, unsubscribeUrl: `${origin}/preferences/preview` };
  const body = template.format === "HTML" ? sanitizeEmailHtml(template.body) : template.body;
  const subject = render(template.subject ?? "", values);
  const preheader = render(template.preheader ?? "", values);
  const merged = render(body, values, template.format === "HTML" ? { escape: escapeHtml } : undefined);
  const unknown = [...new Set([subject, preheader, merged].flatMap((r) => (r.ok ? [] : r.unknown)))];
  const missing = [...new Set([subject, preheader, merged].flatMap((r) => (r.ok ? [] : r.missing)))];
  const fields = (list: string[]) => list.map((m) => `{{${m}}}`).join(", ");
  if (unknown.length) return { ok: false, error: `There's no merge field ${fields(unknown)} — check its spelling in the email.` };
  if (!subject.ok || !preheader.ok || !merged.ok) return { ok: false, error: `It needs ${fields(missing)}, which ${as === "sample values" ? "has no sample" : `${as} has no value for`} — give it a fallback ({{field|…}}).` };
  if (!subject.text.trim()) return { ok: false, error: "Give the email a subject first." };

  const utm = { campaign: "test", content: template.name };
  const email = composeEmail({
    format: template.format,
    body: template.format === "HTML" ? tagHtmlLinks(merged.text, settings.utm!, utm, origin) : tagTextLinks(merged.text, settings.utm!, utm, origin),
    preheader: preheader.text,
    footer: { senderName: settings.ourName, unsubscribeUrl: `${origin}/preferences/preview`, postalAddress: settings.postalAddress, includeUnsubscribe: !merged.used.includes("unsubscribeUrl"), includeAddress: !merged.used.includes("postalAddress") },
    origin,
  });
  const delivered = await deliverNow({ to: me.email, toName: me.name, subject: `[Test] ${subject.text}`, html: email.html, text: email.text }, "MARKETING");
  if (!delivered.ok) return { ok: false, error: delivered.error };
  await recordAudit({ userId: g.userId, action: "CREATE", entityType: "MarketingTemplate", entityId: template.id, entityLabel: `Test of “${template.name}” sent to ${me.email}, filled with ${as}` });
  return { ok: true, data: { to: me.email, as } };
}
