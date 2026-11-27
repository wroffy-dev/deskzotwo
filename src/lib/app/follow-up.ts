import { z } from "zod";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { isModuleEnabled } from "@/actions/module";
import { requireModuleUser } from "@/lib/modules-access";
import { ApiError } from "@/lib/api/handler";
import { listQuickTemplates, quickContext, quickContextForScreen, sendQuickEmail, sendQuickWhatsApp } from "@/lib/quick-messages/server";

/**
 * The follow-up after a call, from the phone (owner, 11 Nov 2026 — src/lib/quick-messages): the same ready-written
 * email or WhatsApp the web's call dialog offers, for one of the person's own calls. GET is what the screen shows —
 * who it can go to and from, the templates for how the call went; POST sends the one chosen. Nothing goes on its own.
 *
 * "Message customers from templates" and a call of theirs to a customer they can open; anything else is a 403 or a
 * 404 the app takes as "no follow-up to offer" and simply doesn't show the step.
 */

const CALL_DAYS = 14;

async function callOf(callId: string) {
  const user = await requireModuleUser("calls");
  if (!(await isModuleEnabled("calls"))) throw new ApiError(403, "calls_unavailable", "You can't use Calls in Deskzo.");
  if (!(await can(user.id, "messages.send"))) throw new ApiError(403, "forbidden", "You don't have permission to message customers from templates.");
  const call = await db.callLog.findFirst({
    where: { id: String(callId), userId: user.id, startedAt: { gte: new Date(Date.now() - CALL_DAYS * 86_400_000) } },
    select: { id: true, companyId: true, contactId: true, leadId: true, phoneNumber: true, outcome: true, company: { select: { ownerUserId: true, relationshipType: true } } },
  });
  if (!call || !(await canSeeCompany(user.id, call.company))) throw new ApiError(404, "not_found", "No call of yours by that id.");
  const asked = { moment: "AFTER_CALL" as const, companyId: call.companyId, leadId: call.leadId, contactId: call.contactId, phone: call.contactId ? null : call.phoneNumber };
  return { user, call, asked };
}

export async function followUpFor(callId: string) {
  const { user, call, asked } = await callOf(callId);
  const found = await quickContext(user.id, asked);
  if (!found || "error" in found) throw new ApiError(404, "not_found", found && "error" in found ? found.error : "That customer no longer exists.");
  // Masked as the person's field access says, as on the web (security audit SEC-08).
  const context = await quickContextForScreen(user.id, found);
  const templates = await listQuickTemplates({ moment: "AFTER_CALL", outcome: call.outcome, activeOnly: true });
  return {
    company: context.company.name,
    from: context.sender.name,
    email: context.emailRoute.via === "none" ? { ready: false, note: context.emailRoute.why } : { ready: true, note: context.emailRoute.via === "mailbox" ? `From ${context.emailRoute.from}` : "Through the company's mail server; replies come to you" },
    whatsapp: context.whatsapp.ready ? { ready: true, note: `From ${context.whatsapp.from}` } : { ready: false, note: context.whatsapp.why },
    // The person the call was to comes first (quickContext puts them there).
    contacts: context.contacts.map((c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone, primary: c.primary, email_stopped: c.emailStopped, whatsapp_open: c.whatsappOpen })),
    loose: context.loose ? { phone: context.loose.phone, whatsapp_open: context.loose.whatsappOpen } : null,
    values: context.values,
    templates: templates.map((t) => ({
      id: t.id,
      name: t.name,
      email_subject: t.emailSubject,
      email_body: t.emailBody,
      whatsapp_body: t.whatsappBody,
      whatsapp_approved: !!t.whatsappTemplateName,
      attachment: t.attachment,
    })),
  };
}

const sendBody = z.discriminatedUnion("channel", [
  z.object({
    channel: z.literal("email"),
    template_id: z.string().trim().min(1).max(60),
    contact_ids: z.array(z.string().trim().min(1).max(60)).min(1).max(25),
    subject: z.string().trim().min(1).max(300),
    body: z.string().trim().min(1).max(20_000),
    attach: z.boolean().optional(),
  }),
  z.object({
    channel: z.literal("whatsapp"),
    template_id: z.string().trim().min(1).max(60),
    /** A contact's id; left out for the number that was dialled with nobody behind it. */
    contact_id: z.string().trim().min(1).max(60).nullable().optional(),
    /** The words as typed — used only within WhatsApp's 24 hours. */
    body: z.string().trim().max(4000).nullable().optional(),
    attach: z.boolean().optional(),
  }),
]);

export async function sendFollowUp(callId: string, body: unknown) {
  const { user, call, asked } = await callOf(callId);
  const input = sendBody.parse(body);
  const result =
    input.channel === "email"
      ? await sendQuickEmail(user.id, { ...asked, callId: call.id, templateId: input.template_id, contactIds: input.contact_ids, subject: input.subject, body: input.body, attach: input.attach !== false })
      : await sendQuickWhatsApp(user.id, { ...asked, contactId: input.contact_id ?? null, phone: input.contact_id ? null : call.phoneNumber, callId: call.id, templateId: input.template_id, body: input.body ?? null, attach: input.attach !== false });
  if (!result.ok) throw new ApiError(422, "refused", result.error);
  return { sent: result.sent, skipped: result.skipped, note: result.note ?? null };
}
