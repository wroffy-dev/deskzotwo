"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser, refuseWhileViewingAs } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { toPlain } from "@/lib/serialize";
import { notMigratedYet } from "@/lib/not-migrated";
import type { ActionResult } from "@/actions/company";
import { QUICK_MOMENTS, type QuickMoment } from "@/lib/quick-messages/fields";
import {
  attachTemplateFile,
  deleteQuickTemplate,
  removeTemplateFile,
  listQuickTemplates,
  quickContext,
  quickContextForScreen,
  saveQuickTemplate,
  sendQuickEmail,
  sendQuickWhatsApp,
  type QuickContext,
  type QuickTemplateInput,
  type QuickTemplateRow,
} from "@/lib/quick-messages/server";
import { dismissNotice, pendingNotice } from "@/lib/quick-messages/notices";
import { checkedOwnFiles, marketingEmailsForQuick, type OwnFile, type QuickMarketingEmail } from "@/lib/quick-messages/extras";
import { isModuleEnabled } from "@/actions/module";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { TEXT_MAX, tooMany } from "@/lib/validation/text";

/**
 * Messages sent by hand from a template (owner, 11 Nov 2026 — src/lib/quick-messages): the send dialog's actions, the
 * new account manager's introduction, and Settings › Message templates.
 *
 * Sending takes "Message customers from templates" and a customer the person can open; the templates are changed by
 * whoever may change organisation settings. Nothing is sent while viewing the app as somebody else.
 */

const NO_RIGHT = "You don't have permission to message customers from templates.";
const asMoment = (v: unknown): QuickMoment => ((QUICK_MOMENTS as readonly string[]).includes(String(v)) ? (String(v) as QuickMoment) : "ANY");

export type QuickAsk = { moment: string; companyId: string; leadId?: string | null; contactId?: string | null; phone?: string | null; outcome?: string | null; callId?: string | null };
/** `marketing`: Marketing's designed emails, for whoever has Marketing open to them (owner, 16 Nov 2026). */
export type QuickDialogData = { context: QuickContext; templates: QuickTemplateRow[]; marketing: QuickMarketingEmail[] };

/** Whether this person may send these at all — for the buttons that open the dialog. */
export async function mayQuickMessage(): Promise<boolean> {
  const user = await requireUser();
  return can(user.id, "messages.send");
}

/** What the dialog opens with: who it can go to and from, and the templates for the moment. */
export async function openQuickMessage(ask: QuickAsk): Promise<ActionResult<QuickDialogData>> {
  const user = await requireUser();
  if (!(await can(user.id, "messages.send"))) return { ok: false, error: NO_RIGHT };
  const moment = asMoment(ask?.moment);
  const context = await quickContext(user.id, { moment, companyId: String(ask?.companyId ?? ""), leadId: ask?.leadId || null, contactId: ask?.contactId || null, phone: ask?.phone || null });
  if (!context) return { ok: false, error: "That customer no longer exists." };
  if ("error" in context) return { ok: false, error: context.error };
  const templates = await listQuickTemplates({ moment, outcome: ask?.outcome ?? null, activeOnly: true });
  // Not for a new account manager's introduction, which goes as its own template says.
  const marketing = moment !== "MANAGER_CHANGED" && (await isModuleEnabled("marketing")) ? await marketingEmailsForQuick(await tenantOrigin()) : [];
  return { ok: true, data: toPlain({ context: await quickContextForScreen(user.id, context), templates, marketing }) };
}

type Sent = { sent: number; skipped: { name: string; why: string }[]; note?: string };

type EmailInput = QuickAsk & { templateId?: string | null; marketingTemplateId?: string | null; contactIds: string[]; subject: string; body: string; attach?: boolean; cc?: string };

export async function sendQuickMessageEmail(input: EmailInput): Promise<ActionResult<Sent>> {
  return sendEmail(input, []);
}

/**
 * The same, with the sender's own files (owner, 16 Nov 2026: "no attachment option?"): `payload` the fields above as
 * JSON, `file` each file. Checked in src/lib/quick-messages/extras.ts — the kinds allowed, 3 MB at most in all.
 */
export async function sendQuickMessageEmailWithFiles(form: FormData): Promise<ActionResult<Sent>> {
  let input: EmailInput;
  try {
    input = JSON.parse(String(form.get("payload") ?? "")) as EmailInput;
  } catch {
    return { ok: false, error: "That didn't arrive whole — try again." };
  }
  const raw = form.getAll("file").filter((f): f is File => f instanceof File);
  const checked = checkedOwnFiles(await Promise.all(raw.map(async (f) => ({ name: f.name, bytes: Buffer.from(await f.arrayBuffer()) }))));
  if (!checked.ok) return checked;
  return sendEmail(input, checked.files);
}

async function sendEmail(input: EmailInput, files: OwnFile[]): Promise<ActionResult<Sent>> {
  const user = await requireUser();
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  if (!(await can(user.id, "messages.send"))) return { ok: false, error: NO_RIGHT };
  // Security audit, 13 Nov 2026 (SEC-30 follow-up): the people ticked, at most 50 ids, each a short string.
  const contactIds: unknown = input?.contactIds ?? [];
  if (!Array.isArray(contactIds) || contactIds.some((c) => typeof c !== "string" || c.length > TEXT_MAX.id)) return { ok: false, error: "Those recipients aren't valid." };
  if (contactIds.length > 50) return { ok: false, error: tooMany(50, "people") };
  // A designed email only for somebody Marketing is open to, and never as a new account manager's introduction.
  const designed = typeof input?.marketingTemplateId === "string" && input.marketingTemplateId ? input.marketingTemplateId.slice(0, TEXT_MAX.id) : null;
  if (designed && (asMoment(input?.moment) === "MANAGER_CHANGED" || !(await isModuleEnabled("marketing")))) return { ok: false, error: "Marketing's emails aren't open to you here." };
  const result = await sendQuickEmail(user.id, {
    moment: asMoment(input?.moment),
    companyId: String(input?.companyId ?? ""),
    leadId: input?.leadId || null,
    contactId: input?.contactId || null,
    templateId: input?.templateId || null,
    callId: input?.callId || null,
    contactIds: contactIds as string[],
    subject: String(input?.subject ?? ""),
    body: String(input?.body ?? ""),
    attach: input?.attach !== false,
    cc: typeof input?.cc === "string" ? input.cc.slice(0, 1000) : "",
    marketingTemplateId: designed,
    files,
  });
  if (!result.ok) return result;
  revalidatePath(`/companies/${input.companyId}`);
  if (input.leadId) revalidatePath(`/leads/${input.leadId}`);
  return { ok: true, data: { sent: result.sent, skipped: result.skipped, ...(result.note ? { note: result.note } : {}) } };
}

export async function sendQuickMessageWhatsApp(input: QuickAsk & { templateId: string; body?: string | null; attach?: boolean }): Promise<ActionResult<Sent>> {
  const user = await requireUser();
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  if (!(await can(user.id, "messages.send"))) return { ok: false, error: NO_RIGHT };
  const result = await sendQuickWhatsApp(user.id, {
    moment: asMoment(input?.moment),
    companyId: String(input?.companyId ?? ""),
    leadId: input?.leadId || null,
    contactId: input?.contactId || null,
    phone: input?.phone || null,
    callId: input?.callId || null,
    templateId: String(input?.templateId ?? ""),
    body: input?.body ?? null,
    attach: input?.attach !== false,
  });
  if (!result.ok) return result;
  revalidatePath(`/companies/${input.companyId}`);
  if (input.leadId) revalidatePath(`/leads/${input.leadId}`);
  return { ok: true, data: { sent: result.sent, skipped: result.skipped, ...(result.note ? { note: result.note } : {}) } };
}

// ─── The new account manager ─────────────────────────────────────────────────────────────────────

export type ManagerNotice = { companyId: string; fromName: string | null; toName: string; changedAt: string };

/** The change this customer hasn't been told of, for whoever may tell them; null otherwise. */
export async function managerNoticeFor(companyId: string): Promise<ManagerNotice | null> {
  const user = await requireUser();
  if (!(await can(user.id, "messages.send"))) return null;
  const company = await db.company.findUnique({ where: { id: String(companyId ?? "") }, select: { id: true, ownerUserId: true, relationshipType: true } });
  if (!company || !(await canSeeCompany(user.id, company))) return null;
  const n = await pendingNotice(company.id);
  return n ? { companyId: n.companyId, fromName: n.fromName, toName: n.toName, changedAt: n.changedAt.toISOString() } : null;
}

export async function dismissManagerNotice(companyId: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  if (!(await can(user.id, "messages.send"))) return { ok: false, error: NO_RIGHT };
  const company = await db.company.findUnique({ where: { id: String(companyId ?? "") }, select: { id: true, ownerUserId: true, relationshipType: true } });
  if (!company || !(await canSeeCompany(user.id, company))) return { ok: false, error: "That customer no longer exists." };
  await dismissNotice(user.id, company.id);
  revalidatePath(`/companies/${company.id}`);
  revalidatePath("/companies/manager-changes");
  return { ok: true, data: null };
}

export type WaitingNotice = { companyId: string; companySeq: number; companyName: string; fromName: string | null; toName: string; changedAt: string; contact: string | null; hasEmail: boolean };

/** Every customer this person can open who hasn't been told of their new account manager, newest change first. */
export async function listManagerNotices(): Promise<ActionResult<WaitingNotice[]>> {
  const user = await requireUser();
  if (!(await can(user.id, "messages.send"))) return { ok: false, error: NO_RIGHT };
  try {
    const rows = await db.accountManagerNotice.findMany({ where: { toldAt: null, dismissedAt: null }, orderBy: { changedAt: "desc" }, take: 500 });
    const companies = await db.company.findMany({
      where: { id: { in: rows.map((r) => r.companyId) } },
      select: { id: true, companySeq: true, name: true, ownerUserId: true, relationshipType: true, contacts: { where: { leftAt: null }, select: { name: true, email: true, isPrimary: true }, orderBy: [{ isPrimary: "desc" }, { name: "asc" }], take: 5 } },
    });
    const names = new Map((await db.user.findMany({ where: { id: { in: rows.flatMap((r) => [r.toUserId, ...(r.fromUserId ? [r.fromUserId] : [])]) } }, select: { id: true, name: true, active: true } })).map((u) => [u.id, u]));
    const out: WaitingNotice[] = [];
    for (const r of rows) {
      const c = companies.find((x) => x.id === r.companyId);
      const to = names.get(r.toUserId);
      // Moved on again, or the new manager has left: nothing to tell.
      if (!c || c.ownerUserId !== r.toUserId || !to?.active) continue;
      if (!(await canSeeCompany(user.id, c))) continue;
      const first = c.contacts.find((p) => p.email) ?? c.contacts[0] ?? null;
      out.push({ companyId: c.id, companySeq: c.companySeq, companyName: c.name, fromName: (r.fromUserId ? names.get(r.fromUserId)?.name : null) ?? null, toName: to.name, changedAt: r.changedAt.toISOString(), contact: first?.name ?? null, hasEmail: c.contacts.some((p) => p.email) });
    }
    return { ok: true, data: out };
  } catch (err) {
    if (notMigratedYet(err)) return { ok: true, data: [] };
    throw err;
  }
}

/**
 * The same introduction to several customers at once, by email — the template as it stands, to each one's primary
 * contact (else the first who can be emailed), from each one's own new account manager. WhatsApp goes one at a time.
 */
export async function sendManagerNoticesByEmail(input: { companyIds: string[]; templateId: string }): Promise<ActionResult<{ sent: number; failed: { name: string; why: string }[] }>> {
  const user = await requireUser();
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  if (!(await can(user.id, "messages.send"))) return { ok: false, error: NO_RIGHT };
  const template = (await listQuickTemplates({ moment: "MANAGER_CHANGED", activeOnly: true })).find((t) => t.id === String(input?.templateId ?? ""));
  if (!template?.emailSubject || !template.emailBody) return { ok: false, error: "Pick a template with an email." };
  const ids = [...new Set((input?.companyIds ?? []).map(String))].slice(0, 100);
  if (ids.length === 0) return { ok: false, error: "Tick the customers to tell." };
  let sent = 0;
  const failed: { name: string; why: string }[] = [];
  for (const companyId of ids) {
    const context = await quickContext(user.id, { moment: "MANAGER_CHANGED", companyId });
    if (!context || "error" in context) {
      failed.push({ name: "A customer", why: context && "error" in context ? context.error : "No longer there." });
      continue;
    }
    const to = context.contacts.find((c) => c.email && !c.emailStopped);
    if (!to) {
      failed.push({ name: context.company.name, why: "Nobody there can be emailed." });
      continue;
    }
    const result = await sendQuickEmail(user.id, { moment: "MANAGER_CHANGED", companyId, templateId: template.id, contactIds: [to.id], subject: template.emailSubject, body: template.emailBody });
    if (result.ok && result.sent > 0) sent += 1;
    else failed.push({ name: context.company.name, why: result.ok ? (result.skipped[0]?.why ?? "It didn't go.") : result.error });
  }
  revalidatePath("/companies/manager-changes");
  return { ok: true, data: { sent, failed } };
}

// ─── Settings › Message templates ────────────────────────────────────────────────────────────────

const NO_SETTINGS = "You can't change these settings.";

export async function listMessageTemplates(): Promise<ActionResult<QuickTemplateRow[]>> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: NO_SETTINGS };
  return { ok: true, data: toPlain(await listQuickTemplates()) };
}

export async function saveMessageTemplate(input: QuickTemplateInput): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: NO_SETTINGS };
  const saved = await saveQuickTemplate(user.id, input);
  if (!saved.ok) return saved;
  revalidatePath("/settings/message-templates");
  return { ok: true, data: { id: saved.id } };
}

/** A template's PDF — the company profile, a brochure — attached or replaced. The form carries `templateId` and `file`. */
export async function attachMessageTemplateFile(form: FormData): Promise<ActionResult<{ name: string; size: number }>> {
  const user = await requireUser();
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: NO_SETTINGS };
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a PDF." };
  if (file.size > 5 * 1024 * 1024) return { ok: false, error: "That PDF is over 5 MB — save a smaller copy and try again." };
  const kept = await attachTemplateFile(user.id, String(form.get("templateId") ?? ""), { bytes: Buffer.from(await file.arrayBuffer()), name: file.name });
  if (!kept.ok) return kept;
  revalidatePath("/settings/message-templates");
  return { ok: true, data: { name: kept.name, size: kept.size } };
}

export async function removeMessageTemplateFile(templateId: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: NO_SETTINGS };
  await removeTemplateFile(user.id, String(templateId ?? ""));
  revalidatePath("/settings/message-templates");
  return { ok: true, data: null };
}

export async function deleteMessageTemplate(id: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: NO_SETTINGS };
  await deleteQuickTemplate(user.id, String(id ?? ""));
  revalidatePath("/settings/message-templates");
  return { ok: true, data: null };
}
