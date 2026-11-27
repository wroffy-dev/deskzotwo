"use server";

import { revalidatePath } from "next/cache";
import { requireModuleUser } from "@/lib/modules-access";
import { recordAudit } from "@/lib/audit";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { assignRequest, createLink, declineRequest, requestLinkUrl, revokeLink } from "@/lib/quote-requests";
import { emailRequestLink } from "@/lib/quote-request-mail";

/**
 * A reseller's quote requests, worked from their page (src/lib/quote-requests.ts): their link sent or switched off,
 * a request given to somebody or declined. Each asks the library who may.
 */

type Result<T = null> = { ok: true; data: T } | { ok: false; error: string };

/** A new link for one person at the reseller: emailed to them, or handed back to copy. Shown once either way. */
export async function sendQuoteRequestLink(input: { resellerId: string; contactId: string; email: boolean; note?: string }): Promise<Result<{ url: string; emailed: boolean }>> {
  const user = await requireModuleUser("resellers");
  const made = await createLink(user.id, input?.resellerId, input?.contactId);
  if (!made.ok) return made;
  const url = requestLinkUrl(await tenantOrigin(), made.token);
  await recordAudit({ userId: user.id, action: "CREATE", entityType: "QuoteRequestLink", entityId: input.resellerId, entityLabel: `Quote request link for ${made.contact.name}` });
  if (input.email) {
    if (!made.contact.email) return { ok: true, data: { url, emailed: false } };
    const sent = await emailRequestLink({ senderId: user.id, resellerId: input.resellerId, contact: { id: made.contact.id, name: made.contact.name, email: made.contact.email }, link: url, note: typeof input.note === "string" ? input.note.slice(0, 2000) : "" });
    if (!sent.ok) return { ok: true, data: { url, emailed: false } };
  }
  revalidatePath("/companies");
  return { ok: true, data: { url, emailed: input.email && !!made.contact.email } };
}

export async function revokeQuoteRequestLink(linkId: string): Promise<Result> {
  const user = await requireModuleUser("resellers");
  const out = await revokeLink(user.id, linkId);
  if (!out.ok) return out;
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "QuoteRequestLink", entityId: String(linkId), entityLabel: "Quote request link switched off" });
  revalidatePath("/companies");
  return { ok: true, data: null };
}

export async function assignQuoteRequest(requestId: string, userId: string): Promise<Result> {
  const user = await requireModuleUser("resellers");
  const out = await assignRequest(user.id, requestId, userId);
  if (!out.ok) return out;
  revalidatePath("/companies");
  return { ok: true, data: null };
}

export async function declineQuoteRequest(requestId: string, reason: string): Promise<Result> {
  const user = await requireModuleUser("resellers");
  const out = await declineRequest(user.id, requestId, reason);
  if (!out.ok) return out;
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "QuoteRequest", entityId: String(requestId), entityLabel: `Quote request declined: ${String(reason).slice(0, 120)}` });
  revalidatePath("/companies");
  return { ok: true, data: null };
}
