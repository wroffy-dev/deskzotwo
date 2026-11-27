"use server";

import { db } from "@/lib/db";
import { refuseWhileViewingAs, requireUser, viewAsContext } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { mayAttachTo } from "@/lib/authz/attachments";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { isModuleEnabled } from "@/actions/module";
import { createTask } from "@/actions/task";
import { createNote } from "@/actions/note";
import { createLead, updateLeadDetails, updateLeadRequirement } from "@/actions/lead";
import { addContact, createCompany } from "@/actions/company";
import { formatLeadId } from "@/lib/order-id";
import { AI_FEATURES, MILLI, type AiFeature } from "@/lib/ai/catalogue";
import { creditStanding, monthOf, usageBreakdown, usedTodayBy } from "@/lib/ai/credits";
import { aiService } from "@/lib/ai/gateway";
import { DEFAULT_DAILY_CREDIT_LIMIT, NO_DAILY_CAP, copilotConfig, storedDailyLimit, storedFor } from "@/lib/copilot/settings";
import { unavailableBecause } from "@/lib/copilot/agent";
import { currentTenant } from "@/lib/tenancy/resolve";
import { workspaceClock } from "@/lib/time/workspace";
import { chatItemsOf, hideConversation, ownConversation, ownConversations, type ChatItem } from "@/lib/copilot/review";
import { changeLabel, changedSince, hiddenChange, leadNow, leadUpdatePayload, mayChangeProducts } from "@/lib/copilot/lead-update";
import { updateLeadDetailsSchema, updateLeadRequirementSchema } from "@/lib/validation/lead";
import type { ProposalBlock } from "@/lib/copilot/types";
import type { ActionResult } from "@/actions/company";

/**
 * The copilot's screens: the person's own conversations and the drafts they confirm, and the admin's
 * Deskzo AI settings — the switches, a daily cap, and who used how many credits. The chat itself streams
 * from src/app/api/copilot/chat/route.ts; the models, where they run and their rates are Deskzo's (src/lib/ai).
 *
 * Conversations are private — every read here is filtered to the person's own — and none of it
 * works while "viewing as" somebody, which would otherwise open their chats.
 */

async function me() {
  const user = await requireUser();
  return (await viewAsContext()) ? null : user;
}

export type CopilotAvailability = {
  available: boolean;
  reason: string | null;
  /** Who runs it and where, in words: "Deskzo AI · India (Mumbai and Hyderabad)". */
  provider: string;
  model: string;
  /** Customer data is masked before it is sent (src/lib/ai/mask.ts). */
  masked: boolean;
  /** Credits the person used today, and their daily cap (null: none), in thousandths. */
  usedToday: number;
  limit: number | null;
};

/** Whether the copilot button shows, and what it says underneath. */
export async function getCopilotAvailability(): Promise<CopilotAvailability | null> {
  const user = await me();
  if (!user || !(await can(user.id, "copilot.use"))) return null;
  const config = await copilotConfig();
  if (!config.enabled) return null;
  const [reason, service, usedToday] = await Promise.all([unavailableBecause(user.id), aiService("copilot.chat"), usedTodayBy(user.id)]);
  return {
    available: !reason,
    reason,
    provider: service ? `Deskzo AI · ${service.residency}` : "Deskzo AI",
    model: service?.model ?? "",
    masked: service?.masked ?? false,
    usedToday,
    limit: config.dailyCreditLimit === null ? null : config.dailyCreditLimit * MILLI,
  };
}

export async function listCopilotConversations() {
  const user = await me();
  if (!user) return [];
  return ownConversations(user.id);
}

export type { ChatItem, ChatSegment } from "@/lib/copilot/review";

/** A conversation as the chat shows it, with each confirmation card's current state. */
export async function getCopilotConversation(id: string): Promise<{ id: string; title: string; items: ChatItem[] } | null> {
  const user = await me();
  if (!user || typeof id !== "string") return null;
  const conversation = await ownConversation(id, user.id);
  if (!conversation) return null;
  return toPlain({ id: conversation.id, title: conversation.title, items: await chatItemsOf(conversation.id, user.id) });
}

/**
 * Deleting a chat hides it from its owner (owner, 23 Nov 2026 — "proper history"): whoever may review Deskzo AI's
 * chats still sees it, marked as deleted (src/lib/copilot/review.ts).
 */
export async function deleteCopilotConversation(id: string): Promise<ActionResult<null>> {
  const user = await me();
  if (!user) return { ok: false, error: "Switch back to your own account first." };
  if (typeof id === "string") await hideConversation(id, user.id);
  return { ok: true, data: null };
}

// ─── The drafts ──────────────────────────────────────────────────────────────

const noteFor = (conversationId: string, text: string) =>
  db.copilotMessage.create({ data: { conversationId, role: "note", content: { text } } });

/**
 * Creates — or changes — what the copilot drafted, through the same action the app's own form uses, as
 * the person, so every check that form makes is made here too. Claimed in one step first, so two clicks
 * create one task.
 */
export async function confirmCopilotProposal(id: string): Promise<ActionResult<{ recordId: string }>> {
  const user = await me();
  if (!user) return { ok: false, error: "Switch back to your own account first." };
  const proposal = await db.copilotProposal.findFirst({ where: { id, userId: user.id } });
  if (!proposal) return { ok: false, error: "That draft isn't there any more." };
  if (proposal.status !== "PENDING") return { ok: false, error: proposal.status === "DONE" ? "That's already been done." : "That draft was cancelled." };

  const payload = proposal.payload as Record<string, string>;
  const noun = NOUN[proposal.kind];
  const moduleKey = proposal.kind === "TASK" ? "tasks" : proposal.kind === "NOTE" ? "notes" : "leads";
  if (!(await isModuleEnabled(moduleKey))) return { ok: false, error: `The ${moduleKey} module isn't available to you.` };
  // Checked again now: access can change between the draft and the click. A lead's company is checked by createLead, and
  // a change to a lead by the lead's own actions (`saveLeadUpdate`).
  if ((proposal.kind === "TASK" || proposal.kind === "NOTE") && !(await mayAttachTo(user.id, { companyId: payload.companyId || null, leadId: payload.leadId || null, ticketId: payload.ticketId || null }))) {
    return { ok: false, error: "You no longer have access to the record this was linked to." };
  }

  const claimed = await db.copilotProposal.updateMany({ where: { id, userId: user.id, status: "PENDING" }, data: { status: "DONE", decidedAt: new Date() } });
  if (claimed.count === 0) return { ok: false, error: "That's already been done." };

  const result =
    proposal.kind === "TASK"
      ? await createTask(payload)
      : proposal.kind === "NOTE"
        ? await createNote({ ...payload, pinned: false })
        : proposal.kind === "LEAD"
          ? await createDraftedLead(id, proposal.payload as unknown as LeadDraft)
          : await saveLeadUpdate(user.id, proposal.payload);
  if (!result.ok) {
    await db.copilotProposal.update({ where: { id }, data: { status: "FAILED", error: result.error } });
    await noteFor(proposal.conversationId, `The user pressed confirm, but the ${noun} “${proposal.summary}” couldn't be saved: ${result.error}`);
    return { ok: false, error: result.error };
  }
  await db.copilotProposal.update({ where: { id }, data: { recordId: result.data.id } });
  const ref = "ref" in result.data && result.data.ref ? ` as ${result.data.ref}` : "";
  await noteFor(proposal.conversationId, `The user confirmed the ${noun} “${proposal.summary}” and it was saved${ref}.`);
  return { ok: true, data: { recordId: result.data.id } };
}

export async function cancelCopilotProposal(id: string): Promise<ActionResult<null>> {
  const user = await me();
  if (!user) return { ok: false, error: "Switch back to your own account first." };
  const proposal = await db.copilotProposal.findFirst({ where: { id, userId: user.id }, select: { conversationId: true, kind: true, summary: true } });
  const changed = await db.copilotProposal.updateMany({ where: { id, userId: user.id, status: "PENDING" }, data: { status: "CANCELLED", decidedAt: new Date() } });
  if (proposal && changed.count) await noteFor(proposal.conversationId, `The user cancelled the drafted ${NOUN[proposal.kind]} “${proposal.summary}”.`);
  return { ok: true, data: null };
}

const NOUN: Record<ProposalBlock["kind"], string> = { TASK: "task", NOTE: "note", LEAD: "lead", LEAD_UPDATE: "change to a lead" };

/** What propose_lead saved (src/lib/copilot/tools.ts). */
type LeadDraft = {
  companyId: string;
  newCompanyName: string;
  title: string;
  description: string;
  estimatedValue: number | null;
  expectedCloseDate: string;
  contact: { name: string; phone: string; email: string } | null;
};

/**
 * A drafted lead, made through the app's own actions as the person — createCompany and addContact when it needs them,
 * then createLead — so every check those forms make is made here too. The proposal's id is the lead's request id, so
 * a retry can never make a second lead.
 */
async function createDraftedLead(proposalId: string, d: LeadDraft): Promise<ActionResult<{ id: string; ref: string }>> {
  let companyId = d.companyId;
  let contactId = "";
  if (!companyId) {
    const company = await createCompany({ name: d.newCompanyName, contacts: d.contact ? [{ ...d.contact, isPrimary: true }] : [] });
    if (!company.ok) return { ok: false, error: company.error };
    companyId = company.data.id;
    contactId = company.data.contacts[0]?.id ?? "";
  } else if (d.contact) {
    // The same person already on the company is used, not added twice.
    const same = await db.contact.findFirst({
      where: {
        companyId,
        OR: [...(d.contact.email ? [{ email: d.contact.email }] : []), ...(d.contact.phone ? [{ phone: d.contact.phone }] : []), { name: { equals: d.contact.name, mode: "insensitive" as const } }],
      },
      select: { id: true },
    });
    if (same) contactId = same.id;
    else {
      const added = await addContact(companyId, { ...d.contact, isPrimary: false });
      if (!added.ok) return { ok: false, error: added.error };
      contactId = added.data.id;
    }
  }
  const lead = await createLead({
    companyId,
    contactId,
    title: d.title,
    description: d.description,
    estimatedValue: d.estimatedValue ?? "",
    expectedCloseDate: d.expectedCloseDate,
    source: "OTHER",
    requestId: `copilot:${proposalId}`,
  });
  if (!lead.ok) return { ok: false, error: lead.error };
  return { ok: true, data: { id: lead.data.id, ref: formatLeadId(lead.data.leadSeq) } };
}

/**
 * A drafted change to one lead (src/lib/copilot/lead-update.ts), saved through the lead's own actions as the person —
 * `updateLeadDetails` and `updateLeadRequirement` — so scope, products.edit, masking, the field rules and the won lead's
 * locked value all hold. Refused when any field no longer holds what the card showed. Both actions take their whole set,
 * so what nobody asked to change is sent back as it is. Everything that can be checked is checked before the first save;
 * the second can still be refused, and then what was saved is said.
 */
async function saveLeadUpdate(userId: string, stored: unknown): Promise<ActionResult<{ id: string }>> {
  const payload = leadUpdatePayload(stored);
  if (!payload) return { ok: false, error: "That draft can't be read any more. Ask again." };
  const lead = await leadNow(payload.leadId);
  if (!lead) return { ok: false, error: "Lead not found." };
  const hidden = hiddenChange(lead, payload.changes);
  if (hidden) return { ok: false, error: `You don't see the lead's ${changeLabel(hidden).toLowerCase()} in full, so you can't change it.` };
  const stale = changedSince(lead, payload.changes);
  if (stale) return { ok: false, error: `${changeLabel(stale)} has changed since this card was drawn, so nothing was saved. Ask again to see it as it is now.` };

  const to = new Map(payload.changes.map((c) => [c.field, c.to]));
  const details = payload.changes.some((c) => c.field !== "quantity")
    ? {
        leadId: lead.id,
        title: to.get("title") ?? lead.title,
        description: to.get("description") ?? lead.description,
        estimatedValue: to.get("estimatedValue") ?? lead.estimatedValue,
        expectedCloseDate: to.get("expectedCloseDate") ?? lead.expectedCloseDate,
        contactId: lead.contactId,
      }
    : null;
  const quantity = payload.changes.find((c) => c.field === "quantity");
  const line = quantity && lead.requirements.find((r) => r.id === quantity.requirementId);
  const product = quantity && line ? { id: line.id, quantity: quantity.to, notes: line.notes, renewalDate: line.renewalDate } : null;

  if (product && !(await mayChangeProducts(userId))) return { ok: false, error: "You don't have permission to edit products." };
  const misfit = (details && updateLeadDetailsSchema.safeParse(details).error) || (product && updateLeadRequirementSchema.safeParse(product).error);
  if (misfit) return { ok: false, error: misfit.issues[0]?.message ?? "Check the details." };

  if (details) {
    const saved = await updateLeadDetails(details);
    if (!saved.ok) return { ok: false, error: saved.error };
  }
  if (product) {
    const saved = await updateLeadRequirement(product);
    if (!saved.ok) return { ok: false, error: details ? `The quantity wasn't changed: ${saved.error} The lead's other changes were saved.` : saved.error };
  }
  return { ok: true, data: { id: lead.id } };
}

// ─── Settings (admins) ───────────────────────────────────────────────────────

export type DeskzoAiSettings = {
  enabled: boolean;
  draftingEnabled: boolean;
  /** The cap as set: null — not set, so `defaultDailyCreditLimit` applies; 0 — no cap; otherwise whole credits. */
  dailyCreditLimit: number | null;
  defaultDailyCreditLimit: number;
  /** Each feature: what it sends, the model it runs on and where — null when Deskzo hasn't set it up. */
  services: { feature: AiFeature; label: string; sends: string; model: string | null; residency: string | null; noTraining: boolean }[];
  /** This month's credits, in thousandths. `metered` false: no limit, and no ledger. */
  credits: { metered: boolean; allowance: number | null; allowanceUsed: number; packsUsed: number; packsRemaining: number; available: number | null; renewsAt: string };
  /** Whether this admin may buy credits (`billing.manage`) — the page then links to billing. */
  canBuy: boolean;
  /** This month, by person: credits for each feature, all together, and today. Thousandths. */
  usage: { userId: string; name: string; byFeature: Record<string, number>; month: number; today: number; turns: number }[];
};

export async function getCopilotSettings(): Promise<DeskzoAiSettings | null> {
  const user = await requireUser();
  // Security audit round two, 13 Nov 2026 (low, AI): settings are changed as yourself, never while viewing as somebody.
  if (await refuseWhileViewingAs()) return null;
  if (!(await can(user.id, "settings.manage"))) return null;
  const tenant = await currentTenant();
  const now = new Date();
  const month = monthOf(tenant, now);
  const clock = await workspaceClock();
  const todayFrom = clock.startOfDay(clock.dateKey(now))!;
  const [config, storedCap, standing, services, canBuy] = await Promise.all([
    copilotConfig(),
    storedDailyLimit(),
    creditStanding(tenant, now),
    Promise.all(AI_FEATURES.map(async (f) => ({ f, service: await aiService(f.key) }))),
    can(user.id, "billing.manage"),
  ]);
  // A workspace without a ledger (no control plane) has nobody's charges to show.
  const [monthRows, todayRows] = standing.metered ? await Promise.all([usageBreakdown(tenant.id, month.from, month.to), usageBreakdown(tenant.id, todayFrom, month.to)]) : [[], []];
  const people = new Map<string, DeskzoAiSettings["usage"][number]>();
  for (const r of monthRows) {
    const u = people.get(r.userId) ?? { userId: r.userId, name: "", byFeature: {}, month: 0, today: 0, turns: 0 };
    u.byFeature[r.feature] = (u.byFeature[r.feature] ?? 0) + r.credits;
    u.month += r.credits;
    u.turns += r.turns;
    people.set(r.userId, u);
  }
  for (const r of todayRows) {
    const u = people.get(r.userId);
    if (u) u.today += r.credits;
  }
  const names = people.size ? await db.user.findMany({ where: { id: { in: [...people.keys()] } }, select: { id: true, name: true } }) : [];
  for (const n of names) people.get(n.id)!.name = n.name;
  return {
    enabled: config.enabled,
    draftingEnabled: config.draftingEnabled,
    dailyCreditLimit: storedCap,
    defaultDailyCreditLimit: DEFAULT_DAILY_CREDIT_LIMIT,
    services: services.map(({ f, service }) => ({ feature: f.key, label: f.label, sends: f.sends, model: service?.model ?? null, residency: service?.residency ?? null, noTraining: service?.noTraining ?? false })),
    credits: {
      metered: standing.metered,
      allowance: standing.allowance,
      allowanceUsed: standing.allowanceUsed,
      packsUsed: standing.packsUsed,
      packsRemaining: standing.packsRemaining,
      available: standing.available,
      renewsAt: standing.renewsAt.toISOString(),
    },
    canBuy,
    usage: [...people.values()].map((u) => ({ ...u, name: u.name || "Somebody no longer here" })).sort((a, b) => b.month - a.month),
  };
}

export type CopilotSettingsInput = {
  enabled: boolean;
  draftingEnabled: boolean;
  /**
   * Whole credits a person may use in a day. Security audit, 13 Nov 2026 (A5): null (left blank) is the
   * default cap, DEFAULT_DAILY_CREDIT_LIMIT; 0 is the admin choosing no cap of the workspace's own.
   */
  dailyCreditLimit: number | null;
};

export async function saveCopilotSettings(input: CopilotSettingsInput): Promise<ActionResult<null>> {
  const user = await requireUser();
  // Security audit round two, 13 Nov 2026 (low, AI): not while viewing as somebody — it would be recorded as them.
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: "You can't change Deskzo AI's settings." };
  const raw = input?.dailyCreditLimit;
  const limit = raw === null || raw === undefined ? null : Math.round(Number(raw));
  if (limit !== null && (!Number.isFinite(limit) || limit < 0 || limit >= NO_DAILY_CAP)) return { ok: false, error: "Set a daily cap between 1 and 99,999 credits, 0 for none, or leave it blank for the default." };
  const data = { enabled: input.enabled === true, draftingEnabled: input.draftingEnabled === true, dailyCreditLimit: storedFor(limit), updatedById: user.id };
  await db.copilotSettings.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  const said = [`copilot ${data.enabled ? "on" : "off"}`, `drafting with AI ${data.draftingEnabled ? "on" : "off"}`, limit === null ? `the default daily cap (${DEFAULT_DAILY_CREDIT_LIMIT} credits a person)` : limit === 0 ? "no daily cap" : `${limit.toLocaleString("en-IN")} credits a person a day`];
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "CopilotSettings", entityId: "global", entityLabel: `Deskzo AI — ${said.join(", ")}` });
  return { ok: true, data: null };
}
