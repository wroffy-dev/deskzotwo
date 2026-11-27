"use server";

import { createHash } from "node:crypto";
import { customInput, fieldRuleRefusal, leadRecord } from "@/lib/field-rules/server";
import { revalidatePath } from "next/cache";
import Papa from "papaparse";
import { Prisma, type LeadSource, type LeadStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { isCustomerSide } from "@/lib/companies/roles";
import { leadChanges } from "@/lib/activity/fields";
import { CATEGORY_SELECT } from "@/lib/customers/categories";
// Leads are a module of their own (owner, 14 Oct 2026): sold with Deskzo Pipeline, CRM and One.
import { requireModuleAccess, requireModuleUser } from "@/lib/modules-access";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { documentAccess, leadAccess, mayAccess, timelineAccess, type AccessAction } from "@/lib/authz/access";
import { toPlain } from "@/lib/serialize";
import { isModuleEnabled } from "@/actions/module";
import { hasEffectivePermission } from "@/actions/permission";
import { logActivity as logSecurityActivity } from "@/lib/activity";
import { getSecurityPolicy } from "@/lib/security/store";
import { exportDecision } from "@/lib/security/policy";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { notMigratedYet as columnNotThereYet } from "@/lib/not-migrated";
import { changedLabel, customFieldsForCreate, customSearchWhere, definitionsFor, notMigratedYet, saveCustomFields } from "@/lib/custom-fields/server";
import { customFilterWhere, type CustomFilterInputs } from "@/lib/custom-fields/filters";
import { exportCells } from "@/lib/custom-fields/sheets";
import { leadMasker } from "@/lib/authz/fields";
import { customLeftBlank } from "@/lib/portability/exporters/field-export";
import { inPipelineWhere, inStageWhere, leadStages, newLeadStage, stageWrite, stagesOfLeads } from "@/lib/pipeline/server";
import { MAIN_PIPELINE_ID, kindOf, pipelineById, stageChangeNote, stageForStatus } from "@/lib/pipeline/rules";
import { emitLeadCreated, emitLeadMoved } from "@/lib/automate/emit-leads";
import { afterStageMove, planStageMove, ruleStops, writeStageMove } from "@/lib/leads/stage-move";
import { sanitizeCsvCell, csvFilename } from "@/lib/csv";
import { workspaceClock } from "@/lib/time/workspace";
import { calendarDayRange } from "@/lib/time/zone";
import { pageSlice } from "@/lib/pagination";
import { LEAD_SORTS, resolveSort, type LeadSortKey } from "@/lib/tables/sort-options";
import { dayValue, inIdOrder, pageOfRanked, readInChunks } from "@/lib/tables/sorted-page";
import { lastActivityOfLeads, nextFollowUpOfLeads } from "@/lib/tables/list-extras";
import {
  createLeadSchema,
  updateLeadStatusSchema,
  updateLeadDetailsSchema,
  moveLeadToPipelineSchema,
  bulkUpdateLeadsSchema,
  logActivitySchema,
  addLeadRequirementSchema,
  updateLeadRequirementSchema,
  renewalDateToStore,
} from "@/lib/validation/lead";
import type { ActionResult } from "@/actions/company";
import { decideOwner, whoCouldOpen, type AssignmentSignals } from "@/lib/leads/assign";
import { CLOSED_LEAD_STATUSES, claimLeadCapacity, LeadCapacityFull, leadCapacityError, markLeadWrite } from "@/lib/leads/limits";
import { notifyLeadOverflow } from "@/lib/leads/overflow-notify";
import { apiActor } from "@/lib/api/actor";
import { ApiError } from "@/lib/api/handler";
import { auth } from "@/lib/auth";
import { resolveViewAs } from "@/lib/impersonation";
import { mayChangeLeadOwner, mayLeaveUnassigned, reassignRights } from "@/lib/authz/reassign";
import { refreshLeadScore } from "@/lib/leads/score-store";
import { leadQuoteWhere, type QuoteFilter } from "@/lib/leads/quotes";
import { leadQuotes, seesLeadQuotes } from "@/lib/leads/quote-status";
import { leadBoardExtras } from "@/lib/leads/board-extras";
import { BOARD_COLUMN_SIZE } from "@/lib/leads/board";
import { leadPath } from "@/lib/record-links";
import { detailLeadMasker, leadAccountView, leadRedactor, leadSecrets, listLeadMasker, maskLead, maskLeads, maskLeadsForList, maskLeadTitle } from "@/lib/leads/masking";
import { customFieldKey } from "@/lib/authz/field-policy";
import { seqSearchTerm } from "@/lib/order-id";
import { assignRefusal } from "@/lib/companies/assign-teams";

/** A person's name for the activity log — or "nobody". */
async function ownerName(userId: string | null | undefined): Promise<string> {
  if (!userId) return "nobody";
  return (await db.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ?? "a removed user";
}

/**
 * `leads.view` — whether this person sees the pipeline at all, before any question of which account.
 *
 * Leads live in a core module, so `isModuleEnabled` can't carry this the way it carries orders or
 * projects; every action below asks it first instead. `leadInScope` and `leadListWhere` ask it too,
 * so a lead action added later that scopes through either is covered even if it forgets.
 */
const NO_LEADS = "You don't have access to leads.";
async function canViewLeads(userId: string): Promise<boolean> {
  return hasEffectivePermission(userId, "leads.view");
}

/**
 * Whether this user may change a lead — its edit level in the access engine. With no level stored
 * that is the line the lead page draws; an edit level an admin sets may be narrower than view.
 *
 * Which leads that is, the access engine answers (`mayAccess`, src/lib/authz/access.ts). The page
 * already refused a lead outside it; these actions did not, so a lead's products could be added to,
 * edited or removed by id from any account. Out of scope and missing answer the same.
 */
async function leadInScope(userId: string, leadId: string, action: AccessAction = "edit"): Promise<boolean> {
  if (!(await canViewLeads(userId))) return false;
  return mayAccess(userId, "leads", action, leadId);
}

/**
 * Who a new lead belongs to, and a note saying why.
 *
 *   · A person chosen on the form — yourself freely, anybody else only with `leads.assign`.
 *   · Nobody chosen — the assignment rules (`chooseOwner`). Except that a salesperson who cannot
 *     assign keeps their own lead: somebody who found the business should not watch the rules
 *     hand it to a colleague.
 *   · No rule matches — a salesperson's own; otherwise unassigned, which the list shows as such.
 *
 * Owner, 12 Nov 2026 — Phase 4 lead limits, audit H.6: this only says how. The rules themselves run inside the
 * create's transaction (`ownerInside`), so a choice and its lead commit or roll back together, and the owner's room
 * is taken there too (`claimLeadCapacity`). What reads through the global client — who could open the lead (M-15) —
 * is worked out here, before it.
 */
type OwnerPlan =
  | { ok: true; byRules: false; userId: string | null; note: string | null }
  | { ok: true; byRules: true; signals: AssignmentSignals; mayOpen: Set<string> | null; fallback: string | null }
  | { ok: false; error: string };

async function resolveOwner(
  user: { id: string; role: string },
  data: { ownerUserId?: string; contactId?: string; source: LeadSource },
  companyId: string,
  companyOwnerId: string | null,
  itemIds: string[],
): Promise<OwnerPlan> {
  // Choosing the owner of a new lead is assigning it — so either permission that assigns will do.
  const mayAssign =
    (await hasEffectivePermission(user.id, "leads.assign")) || (await hasEffectivePermission(user.id, "accounts.reassign"));

  if (data.ownerUserId) {
    if (data.ownerUserId !== user.id && !mayAssign) {
      return { ok: false, error: "You can't assign leads to other people." };
    }
    const target = await db.user.findUnique({ where: { id: data.ownerUserId }, select: { active: true, name: true } });
    if (!target?.active) return { ok: false, error: "That person can't take leads — they may have been deactivated." };
    // Only who may own a lead (Settings › Departments); somebody keeping their own new lead always may.
    if (data.ownerUserId !== user.id) {
      const refusal = await assignRefusal("leadOwner", data.ownerUserId);
      if (refusal) return { ok: false, error: refusal };
    }
    return { ok: true, byRules: false, userId: data.ownerUserId, note: data.ownerUserId === user.id ? null : "Assigned when the lead was created" };
  }

  // The role, not a key (kept in Phase 2, audit L-7): a default, not a gate — anybody may already choose themselves
  // above, so nothing is opened by it — and no key says "a salesperson keeps what they find".
  if (!mayAssign && user.role === "SALES") return { ok: true, byRules: false, userId: user.id, note: null };

  const [items, contact, location] = await Promise.all([
    itemIds.length ? db.item.findMany({ where: { id: { in: itemIds } }, select: { brandId: true, type: true } }) : [],
    data.contactId ? db.contact.findUnique({ where: { id: data.contactId }, select: { designation: true } }) : null,
    db.companyLocation.findFirst({ where: { companyId, isPrimary: true }, select: { state: true } }),
  ]);
  const signals: AssignmentSignals = {
    brandIds: [...new Set(items.map((i) => i.brandId).filter((b): b is string => !!b))],
    itemTypes: [...new Set(items.map((i) => i.type))],
    designation: contact?.designation ?? null,
    source: data.source,
    state: location?.state ?? null,
    companyOwnerId,
    // The customer's category, city, PIN… are read from the company by the rules themselves.
    companyId,
    itemIds: [...new Set(itemIds)],
  };
  // No rule matches: the same default as above, by role for the same reason.
  return { ok: true, byRules: true, signals, mayOpen: await whoCouldOpen(signals), fallback: user.role === "SALES" ? user.id : null };
}

/** A rule that refuses a lead when its people are all full (LeadOverflowMode REFUSE): its reason is the answer. */
class RuleRefused extends Error {}

/**
 * The owner, inside the create's transaction: the rules chosen here, on `tx` (owner, 12 Nov 2026 — Phase 4 lead limits,
 * audit H.6.3). `overflow`: every matching rule's people were full, so the lead is kept with nobody and says why.
 */
async function ownerInside(tx: Prisma.TransactionClient, plan: Extract<OwnerPlan, { ok: true }>): Promise<{ userId: string | null; note: string | null; overflow: boolean }> {
  if (!plan.byRules) return { userId: plan.userId, note: plan.note, overflow: false };
  const decided = await decideOwner(plan.signals, { db: tx, mayOpen: plan.mayOpen });
  switch (decided.kind) {
    case "chosen":
      return { userId: decided.userId, note: decided.note, overflow: false };
    case "overflow":
      return { userId: null, note: decided.note, overflow: true };
    case "refused":
      throw new RuleRefused(decided.reason);
    case "none":
      return { userId: plan.fallback, note: null, overflow: false };
  }
}

export async function createLead(input: unknown): Promise<ActionResult<{ id: string; leadSeq: number; overflow?: true }>> {
  const user = await requireModuleUser("leads");
  // Only somebody who may open Leads: the Create menu and the form are hidden otherwise, and this
  // is the same rule for a caller who posts anyway (decideModuleAccess, src/lib/navigation.ts).
  if (!(await isModuleEnabled("leads"))) return { ok: false, error: "You don't have access to Leads." };
  if (!(await canViewLeads(user.id))) return { ok: false, error: NO_LEADS };
  // Its own permission since 1 Nov 2026 — a role may see the pipeline without adding to it.
  if (!(await hasEffectivePermission(user.id, "leads.create"))) return { ok: false, error: "You can't create leads." };
  const parsed = createLeadSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;
  /**
   * The same request again — a double click, a retry after an answer that never arrived, the form sent
   * from two tabs — is the lead it already made, not a second one (Lead.idempotencyKey). Scoped to the
   * person, so a token can neither collide with somebody else's nor turn up their lead.
   *
   * Owner, 12 Nov 2026 — Phase 4, audit D.6.6: for a day, and for the same request only. A token older than
   * `REQUEST_KEY_HOURS` no longer matches (the new lead takes it over), and the same token with a different body is
   * refused — a 409 in the API — rather than answered with a lead that isn't what was asked for.
   */
  const requestKey = data.requestId ? `lead:${user.id}:${data.requestId}` : null;
  const requestHash = requestKey ? requestHashOf(data) : null;
  const already = requestKey ? await leadByRequest(requestKey, requestHash) : null;
  if (already?.conflict) return reusedRequest();
  if (already) return { ok: true, data: already.lead };

  const company = await db.company.findUnique({ where: { id: data.companyId } });
  // Scoped: a lead can only be opened on an account this person could open.
  if (!company || !(await canSeeCompany(user.id, company))) {
    return { ok: false, error: "Company not found." };
  }
  // A lead is with a customer — a client, a reseller, or a vendor that's also a customer — never a vendor alone (owner, 19 Oct 2026).
  if (!(await isCustomerSide(company))) {
    return { ok: false, error: "A lead is with a customer — choose a client or a reseller, not a vendor." };
  }
  /**
   * The contact has to work at the company. The form only offers that company's people, but the
   * action took any contact id — so a lead could name somebody from another customer entirely, and
   * every call and email logged against it would go to the wrong person.
   */
  if (data.contactId) {
    const contact = await db.contact.findUnique({ where: { id: data.contactId }, select: { companyId: true } });
    if (!contact || contact.companyId !== company.id) {
      return { ok: false, error: "That contact isn't at this company." };
    }
  }

  const itemsEnabled = await isModuleEnabled("items");
  const requirements = itemsEnabled ? data.requirements : [];

  const owner = await resolveOwner(user, data, company.id, company.ownerUserId, requirements.map((r) => r.itemId));
  if (!owner.ok) return { ok: false, error: owner.error };

  // The workspace's own fields (src/lib/custom-fields), required ones included — nothing to write
  // when it has none.
  const custom = await customFieldsForCreate("LEAD", user.id, data.customFields, { checkRequired: true });
  if (!custom.ok) return { ok: false, error: custom.error };
  // The workspace's field rules (src/lib/field-rules).
  const leadRuled = await fieldRuleRefusal("LEAD", { ...data, ...customInput(data.customFields).record });
  if (leadRuled) return { ok: false, error: leadRuled };

  // Where it starts: the first stage that means new of the pipeline chosen — the main one when none was
  // (src/lib/pipeline). A pipeline retired meanwhile, or not there, is refused rather than guessed at.
  if (data.pipelineId) {
    const chosen = (await leadStages()).pipelines.find((p) => p.id === data.pipelineId);
    if (!chosen || chosen.archived) return { ok: false, error: "That pipeline is no longer in use. Choose another." };
  }
  const entry = await newLeadStage(undefined, data.pipelineId || null);
  /**
   * The owner is chosen, and their room taken, in the transaction that writes the lead (owner, 12 Nov 2026 — Phase 4
   * lead limits, audit H.6): a create that fails gives nobody a turn, and twenty at once can't all take somebody's last
   * place. Its locks can be waited on, so it is given longer than Prisma's five seconds.
   */
  const write = (key: string | null, hash: string | null = null) => db.$transaction(async (tx) => {
    await markLeadWrite(tx, "createLead");
    // A token from more than a day ago no longer matches: the lead that had it lets it go (raw, so its updatedAt stands).
    if (key) await tx.$executeRaw`UPDATE "leads" SET "idempotencyKey" = NULL WHERE "idempotencyKey" = ${key} AND "createdAt" < ${requestKeyCutoff()}`;
    const chosen = await ownerInside(tx, owner);
    await claimLeadCapacity(tx, [chosen.userId], { creating: true });
    const created = await tx.lead.create({
      data: {
        ...entry,
        ...(key ? { idempotencyKey: key, ...(hash ? { idempotencyHash: hash } : {}) } : {}),
        companyId: data.companyId,
        contactId: data.contactId || null,
        title: data.title,
        description: data.description || null,
        estimatedValue: data.estimatedValue ?? null,
        expectedCloseDate: data.expectedCloseDate ? new Date(data.expectedCloseDate) : null,
        sourcedByUserId: company.createdById,
        ownerUserId: chosen.userId,
        assignmentNote: chosen.note,
        source: data.source,
        sourceDetail: data.sourceDetail || null,
        createdByUserId: user.id,
        ...custom.data,
        requirements: {
          create: requirements.map((r) => ({
            itemId: r.itemId,
            quantity: r.quantity,
            notes: r.notes || null,
            renewalDate: renewalDateToStore(r.renewalDate),
          })),
        },
      },
    });

    if (company.stage === "PROSPECT") {
      await tx.company.update({ where: { id: company.id }, data: { stage: "LEAD" } });
    }

    // For Automate's workflows (src/lib/automate), with the lead: no lead, no event.
    await emitLeadCreated(tx, created.id, user.id, "person");
    return { ...created, chosen };
  }, { maxWait: 10_000, timeout: 20_000 });
  let lead: Awaited<ReturnType<typeof write>>;
  try {
    lead = await write(requestKey, requestHash);
  } catch (err) {
    // A full owner, a rule that refuses, or the plan's cap: refused in words (API v1 and the app answer 422).
    const full = leadCapacityError(err);
    if (full) return { ok: false, error: full.message };
    if (err instanceof RuleRefused) return { ok: false, error: err.message };
    // The same request twice at once: the second finds the first's token taken — it's the same lead,
    // and the first is the one that notifies and records it.
    if (requestKey && err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const same = await leadByRequest(requestKey, requestHash);
      if (same?.conflict) return reusedRequest();
      if (same) return { ok: true, data: same.lead };
    }
    // A workspace not migrated to 20261213100000_lead_intake_guards yet: the token without its hash. Not migrated to
    // 20261127200000_lead_idempotency_key either: the lead, without its token.
    if (!requestKey || !columnNotThereYet(err)) throw err;
    try {
      lead = await write(requestKey).catch((still) => {
        if (columnNotThereYet(still)) return write(null);
        throw still;
      });
    } catch (again) {
      const full = leadCapacityError(again);
      if (full) return { ok: false, error: full.message };
      if (again instanceof RuleRefused) return { ok: false, error: again.message };
      throw again;
    }
  }
  const resolvedOwnerId = lead.chosen.userId;

  if (resolvedOwnerId && resolvedOwnerId !== user.id) {
    await notifyUser({
      userId: resolvedOwnerId,
      type: "LEAD_ASSIGNED",
      title: "A lead was assigned to you",
      message: data.title,
      link: leadPath(lead.leadSeq),
    });
  }
  /**
   * Kept with nobody because everybody the rules would choose is at their lead limit (owner, 12 Nov 2026 — Phase 4 lead
   * limits, audit H.6.5): the people who hand out leads are told, batched with any others arriving with nobody free.
   * After the commit — it reads and writes through the global client.
   */
  if (lead.chosen.overflow) {
    await notifyLeadOverflow([lead.id], `“${data.title}”: ${(lead.chosen.note ?? "everybody the assignment rules would choose is at their lead limit").replace(/^Left with nobody — /, "")}.`);
  }

  await recordAudit({ userId: user.id, action: "CREATE", entityType: "Lead", entityId: lead.id, entityLabel: data.title });
  await refreshLeadScore(lead.id);

  revalidatePath("/leads");
  revalidatePath(`/companies/${data.companyId}`);
  // `overflow`: kept with nobody because everybody the rules would choose is at their lead limit — for whoever tells the managers.
  return { ok: true, data: { id: lead.id, leadSeq: lead.leadSeq, ...(lead.chosen.overflow ? { overflow: true as const } : {}) } };
}

/** How long a request's token stands for the lead it made (owner, 12 Nov 2026 — Phase 4, audit D.6.6). */
const REQUEST_KEY_HOURS = 24;
const requestKeyCutoff = () => new Date(Date.now() - REQUEST_KEY_HOURS * 3_600_000);

/** What a create asked for, as one hash: its fields, keys sorted, the token itself left out. */
function requestHashOf(data: Record<string, unknown>): string {
  const body = { ...data };
  delete body.requestId;
  const stable = (v: unknown): string =>
    Array.isArray(v)
      ? `[${v.map(stable).join(",")}]`
      : v && typeof v === "object"
        ? `{${Object.keys(v as object)
            .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
            .join(",")}}`
        : JSON.stringify(v ?? null);
  return createHash("sha256").update(stable(body)).digest("hex");
}

const REUSED_REQUEST = "That request id was used for a different lead in the last day. Send a new id for a new lead.";

/** The same token with a different body: a 409 in the API (src/lib/api/handler.ts answers an ApiError as itself), words on screen. */
function reusedRequest(): { ok: false; error: string } {
  if (apiActor()) throw new ApiError(409, "idempotency_key_reused", REUSED_REQUEST);
  return { ok: false, error: REUSED_REQUEST };
}

/**
 * The lead a request already made in the last day, if any, and whether it was asked for with a different body (a lead
 * made before the hash was kept matches on its token alone) — none where the workspace has no such column yet.
 */
async function leadByRequest(key: string, hash: string | null): Promise<{ lead: { id: string; leadSeq: number }; conflict: boolean } | null> {
  let found: { id: string; leadSeq: number; createdAt: Date; idempotencyHash?: string | null } | null;
  try {
    found = await db.lead.findUnique({ where: { idempotencyKey: key }, select: { id: true, leadSeq: true, createdAt: true, idempotencyHash: true } });
  } catch (err) {
    if (!columnNotThereYet(err)) throw err;
    try {
      found = await db.lead.findUnique({ where: { idempotencyKey: key }, select: { id: true, leadSeq: true, createdAt: true } });
    } catch (again) {
      if (columnNotThereYet(again)) return null;
      throw again;
    }
  }
  if (!found || found.createdAt < requestKeyCutoff()) return null;
  return { lead: { id: found.id, leadSeq: found.leadSeq }, conflict: !!hash && !!found.idempotencyHash && found.idempotencyHash !== hash };
}

export async function addLeadRequirement(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleAccess("leads");
  if (!(await canViewLeads(user.id))) return { ok: false, error: NO_LEADS };
  const itemsEnabled = await isModuleEnabled("items");
  if (!itemsEnabled) {
    return { ok: false, error: "The Items & Inventory module is disabled." };
  }
  const parsed = addLeadRequirementSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { leadId, itemId, quantity, notes, renewalDate } = parsed.data;

  if (!(await leadInScope(user.id, leadId))) {
    return { ok: false, error: "Lead not found." };
  }

  const requirement = await db.leadRequirement.create({
    data: { leadId, itemId, quantity, notes: notes || null, renewalDate: renewalDateToStore(renewalDate) },
  });

  await refreshLeadScore(leadId);
  revalidatePath(`/leads/${leadId}`);
  return { ok: true, data: { id: requirement.id } };
}

export async function updateLeadRequirement(input: unknown): Promise<ActionResult<{ id: string }>> {
  // Deskzo AI's chat saves through this too, on any page — so the section is asked after here, as `createLead` does.
  const user = await requireModuleUser("leads");
  if (!(await isModuleEnabled("leads"))) return { ok: false, error: "You don't have access to Leads." };
  if (!(await canViewLeads(user.id))) return { ok: false, error: NO_LEADS };
  if (!(await hasEffectivePermission(user.id, "products.edit"))) {
    return { ok: false, error: "You don't have permission to edit products." };
  }
  const parsed = updateLeadRequirementSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, quantity, notes, renewalDate } = parsed.data;

  const requirement = await db.leadRequirement.findUnique({ where: { id } });
  if (!requirement || !(await leadInScope(user.id, requirement.leadId))) {
    return { ok: false, error: "Requirement not found." };
  }

  await db.leadRequirement.update({
    where: { id },
    data: { quantity, notes: notes || null, renewalDate: renewalDateToStore(renewalDate) },
  });

  await refreshLeadScore(requirement.leadId);
  revalidatePath(`/leads/${requirement.leadId}`);
  return { ok: true, data: { id } };
}

export async function removeLeadRequirement(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("leads");
  if (!(await canViewLeads(user.id))) return { ok: false, error: NO_LEADS };
  if (!(await hasEffectivePermission(user.id, "products.delete"))) {
    return { ok: false, error: "You don't have permission to delete products." };
  }
  const requirement = await db.leadRequirement.findUnique({ where: { id } });
  if (!requirement || !(await leadInScope(user.id, requirement.leadId))) {
    return { ok: false, error: "Requirement not found." };
  }

  await db.leadRequirement.delete({ where: { id } });

  await refreshLeadScore(requirement.leadId);
  revalidatePath(`/leads/${requirement.leadId}`);
  return { ok: true, data: null };
}

export type LeadListParams = {
  status?: LeadStatus;
  search?: string;
  ownerUserId?: string;
  /** The account manager of the lead's company (owner, 30 Oct 2026) — not the lead's own owner; "unassigned" for none. */
  accountManagerId?: string;
  closeFrom?: string;
  closeTo?: string;
  source?: LeadSource;
  /** Hot, warm or cold — ranges of the stored score, the same cut-offs as `gradeFor`. */
  grade?: "HOT" | "WARM" | "COLD";
  /** The Sort control's choice (src/lib/tables/sort-options.ts LEAD_SORTS) and its direction. */
  sort?: string;
  dir?: string;
  /** The workspace's own lead fields filtered on, as the page read them (src/lib/custom-fields/filters.ts). */
  customFilters?: CustomFilterInputs;
  /** A stage of the pipeline shown, by its key (Settings → Pipeline). `status` filters by meaning. */
  stage?: string;
  /** The team pipeline shown, by its key — the main one when not given. "all" shows every pipeline's leads. */
  pipeline?: string;
  /** Has had a quotation sent, hasn't, or hasn't though it is at "Proposal sent" or past it (src/lib/leads/quotes.ts). */
  quote?: QuoteFilter;
  /** One company's leads — its Leads tab, which shows them as the Leads list does (owner, 27 Oct 2026). */
  companyId?: string;
};

const GRADE_RANGES = {
  HOT: { gte: 70 },
  WARM: { gte: 40, lt: 70 },
  COLD: { lt: 40 },
} as const;

/** The leads list's sorts that are worked out beyond the lead's own columns — the list ranks them across every match. */
const RANKED_LEAD_SORTS = new Set<LeadSortKey>(["lastActivity", "nextFollowUp", "stageChanged"]);

/**
 * The order asked for (owner, 31 Oct 2026): recently updated unless another is chosen, and a lead with nothing to sort
 * by (no score, no value, no close date) last either way round. A sort worked out from other records keeps the board
 * and the export in the default order — only the paged list ranks those (`listLeadsPaged`).
 */
function leadListOrder(params?: LeadListParams): Prisma.LeadOrderByWithRelationInput[] {
  const s = resolveSort(LEAD_SORTS, params?.sort, params?.dir);
  const last = { sort: s.dir, nulls: "last" } as const;
  const first: Prisma.LeadOrderByWithRelationInput | null =
    s.key === "score" ? { score: last }
    : s.key === "value" ? { estimatedValue: last }
    : s.key === "close" ? { expectedCloseDate: last }
    : s.key === "added" ? { createdAt: s.dir }
    : s.key === "updated" ? { updatedAt: s.dir }
    : null;
  return first && s.key !== "updated" ? [first, { updatedAt: "desc" }, { id: "asc" }] : [first ?? { updatedAt: "desc" }, { id: "asc" }];
}

/** Each lead's value for a ranked sort, read for every lead the filters match. */
async function leadSortValues(key: LeadSortKey, where: Prisma.LeadWhereInput, ids: string[]): Promise<Map<string, number | null>> {
  if (key === "lastActivity") return new Map([...(await readInChunks(ids, lastActivityOfLeads))].map(([id, at]) => [id, at.getTime()]));
  if (key === "nextFollowUp") return new Map([...(await readInChunks(ids, (chunk) => nextFollowUpOfLeads(chunk)))].map(([id, at]) => [id, at.getTime()]));
  // When it last moved stage — its creation where it never has, or where the column isn't there yet.
  try {
    const rows = await db.lead.findMany({ where, select: { id: true, stageChangedAt: true, createdAt: true } });
    return new Map(rows.map((l) => [l.id, dayValue(l.stageChangedAt ?? l.createdAt)]));
  } catch (err) {
    if (!columnNotThereYet(err)) throw err;
    const rows = await db.lead.findMany({ where, select: { id: true, createdAt: true } });
    return new Map(rows.map((l) => [l.id, dayValue(l.createdAt)]));
  }
}

/**
 * Shared by the board (a page of cards a column), the paginated list view and the CSV export.
 *
 * ## Which key the account scope hangs off
 *
 * The access engine answers it (`leadAccess`); with no level stored, that is the company — not
 * `Lead.ownerUserId`. `Lead.companyId` is required in the schema, so "a lead with no company yet"
 * does not exist here and needs no second rule; every lead has an account behind it and
 * `Company.ownerUserId` is who that account is for.
 *
 * Until 26 Nov 2026 `ownerUserId` was deliberately *not* OR'd in on top of that, for the reasons below. The owner
 * reversed it ("if head creates a lead and assigned lead owner is xyz then the lead should show to him"): a lead now
 * shows to its owner and their line, to see and to work (src/lib/authz/access.ts `leadsFollowing`). The reasoning, as
 * it stood:
 *
 * `ownerUserId` was deliberately *not* OR'd in on top of that. It answers a different question —
 * `getLead` already notes that a rep can be working a deal on an account somebody else manages —
 * and it is a field anybody with the bulk-edit bar can set, so an OR on it would let assignment
 * quietly widen the account scope. It would also reverse the one decision `company-scope.ts` makes
 * explicitly: a company with no account manager is nobody's and stays hidden, and since every lead
 * in the database has an owner, an owner branch would publish exactly those leads again.
 *
 * The cost of that choice, stated plainly: a lead assigned to someone outside the account
 * manager's line is invisible to them. That is the account-manager rule working, and the manager's
 * downline is what makes a team's leads visible to the team.
 */
async function leadListWhere(userId: string, params?: LeadListParams): Promise<Prisma.LeadWhereInput> {
  // No pipeline at all: a `where` nothing matches, so the list, the pager's count and the export
  // all come back empty from the one place rather than each needing to remember.
  if (!(await canViewLeads(userId))) return { id: { in: [] } };
  // A close date is a calendar day, typed and kept as its midnight UTC — so the From and To are days
  // too, both ends in, whatever the zone.
  const expectedCloseDate = calendarDayRange(params?.closeFrom, params?.closeTo);
  // The workspace's own fields this person may see, searched too (src/lib/custom-fields/server.ts),
  // and filtered on — a clause each, in an `AND` of their own beside the search's `OR`.
  const [customBranches, fieldFilters] = await Promise.all([
    customSearchWhere("LEAD", userId, params?.search) as Promise<Prisma.LeadWhereInput[]>,
    customFilterWhere("LEAD", userId, params?.customFilters) as Promise<Prisma.LeadWhereInput[]>,
  ]);
  // The pipeline shown (`inPipelineWhere`) and the leads a stage of it shows (`inStageWhere`): each an
  // `OR` of its own, so they join the `AND` rather than meeting the search's. A pipeline key there isn't
  // shows nothing; a stage key the pipeline doesn't have narrows nothing. Without a pipeline asked for,
  // every pipeline's leads are listed — what search, the export and other callers have always had.
  // Only what this person sees in the clear in a list is searched or filtered on: a search that matched
  // a masked or restricted field would tell them what it holds ("Redwo" finding the leads whose
  // masked company is Redwood). Unmasking a lead on its page doesn't change what lists match.
  const masker = await listLeadMasker(userId);
  const readable = (field: string) => masker.visibility(field) === "clear";
  const pipeline = params?.stage || params?.pipeline ? await leadStages() : null;
  const shown = pipeline && params?.pipeline && params.pipeline !== "all" ? (pipeline.pipelines.find((p) => p.key === params.pipeline) ?? null) : undefined;
  const stage = pipeline?.stages.find((s) => s.key === params?.stage && s.pipelineId === (shown?.id ?? MAIN_PIPELINE_ID));
  // The Quotation filter (owner, 19 Oct 2026): by the quotations this person may see, as the column shows
  // them — and only for somebody who sees quotations at all, as the column is.
  const quoteWhere = params?.quote && (await seesLeadQuotes(userId)) ? leadQuoteWhere(params.quote, await documentAccess(userId, "view")) : null;
  const narrowing = [
    ...fieldFilters,
    ...(quoteWhere ? [quoteWhere] : []),
    ...(shown === null ? [{ id: { in: [] } }] : pipeline && shown ? [inPipelineWhere(pipeline, shown.id)] : []),
    ...(pipeline && stage ? [inStageWhere(pipeline, stage)] : []),
  ];
  return {
    ...(params?.companyId ? { companyId: params.companyId } : {}),
    ...(params?.status ? { status: params.status } : {}),
    ...(params?.search
      ? {
          OR: [
            ...(readable("title") ? [{ title: { contains: params.search, mode: "insensitive" as const } }] : []),
            ...(readable("companyName") ? [{ company: { name: { contains: params.search, mode: "insensitive" as const } } }] : []),
            ...customBranches,
            // Its number, as the list shows it — "LEAD-000123", "123" (owner, 1 Nov 2026).
            ...seqSearchTerm(params.search, "leadSeq"),
            // Nothing left to search in: no match, rather than no condition.
            ...(!readable("title") && !readable("companyName") && customBranches.length === 0 ? [{ id: { in: [] as string[] } }] : []),
          ],
        }
      : {}),
    ...(params?.ownerUserId
      ? params.ownerUserId === "unassigned"
        ? { ownerUserId: null }
        : { ownerUserId: params.ownerUserId }
      : {}),
    ...(params?.accountManagerId ? { company: { ownerUserId: params.accountManagerId === "unassigned" ? null : params.accountManagerId } } : {}),
    ...(expectedCloseDate ? { expectedCloseDate } : {}),
    ...(params?.source && readable("source") ? { source: params.source } : {}),
    ...(params?.grade && GRADE_RANGES[params.grade] ? { score: GRADE_RANGES[params.grade] } : {}),
    AND: [await leadAccess(userId, "view"), ...narrowing],
  };
}

const leadListInclude = {
  company: { select: { id: true, name: true, companySeq: true } },
  contact: { select: { id: true, name: true } },
  owner: { select: { id: true, name: true } },
} as const;

export async function listLeads(params?: LeadListParams) {
  const user = await requireModuleAccess("leads");
  const [rows, masker] = await Promise.all([
    db.lead.findMany({
      where: await leadListWhere(user.id, params),
      orderBy: leadListOrder(params),
      include: leadListInclude,
    }),
    listLeadMasker(user.id),
  ]);
  return maskLeads(masker, rows);
}

/** The board's columns: the shown pipeline's stages in use — the first in use when none is named. */
function boardColumns(pipeline: Awaited<ReturnType<typeof leadStages>>, key: string | undefined) {
  const inUse = pipeline.pipelines.filter((p) => !p.archived);
  const shown = inUse.find((p) => p.key === key) ?? inUse[0] ?? pipeline.pipelines[0]!;
  return { shown, stages: pipeline.stages.filter((s) => !s.archived && s.pipelineId === shown.id) };
}

/** Board cards as the client takes them: the stage each sits in, the value as text, and each card's extras and quotation. */
async function boardCards<T extends { id: string; status: LeadStatus; ownerUserId: string | null; estimatedValue: Prisma.Decimal | null }>(userId: string, rows: T[], sales: boolean) {
  const [stageOf, extras, quotes] = await Promise.all([
    stagesOfLeads(rows),
    leadBoardExtras(rows.map((l) => ({ id: l.id, ownerUserId: l.ownerUserId }))),
    sales && (await seesLeadQuotes(userId)) ? leadQuotes(userId, rows.map((l) => l.id)) : Promise.resolve(null),
  ]);
  const cards = rows.map((lead) => ({ ...lead, estimatedValue: lead.estimatedValue?.toString() ?? null, stage: stageOf.get(lead.id)! }));
  return { cards, extras, quotes };
}

/**
 * The board: each column's first cards, and how many it holds. It used to load every lead — a kanban with
 * a hidden page 2 would misrepresent the pipeline — until a workspace of 53,000 leads couldn't be drawn,
 * and naming them all in one query failed outright (the large-workspace load test, 23 Oct 2026). The
 * counts still tell the whole pipeline; "Show more" brings a column's next cards (`listLeadBoardColumn`).
 */
export async function listLeadBoard(params: LeadListParams) {
  const user = await requireModuleAccess("leads");
  const [where, pipeline, masker] = await Promise.all([leadListWhere(user.id, params), leadStages(), listLeadMasker(user.id)]);
  const { shown, stages } = boardColumns(pipeline, params.pipeline);
  const [total, columns] = await Promise.all([
    db.lead.count({ where }),
    Promise.all(
      stages.map(async (stage) => {
        const inColumn = { AND: [where, inStageWhere(pipeline, stage)] };
        const [rows, count] = await Promise.all([
          db.lead.findMany({ where: inColumn, orderBy: leadListOrder(params), include: leadListInclude, take: BOARD_COLUMN_SIZE }),
          db.lead.count({ where: inColumn }),
        ]);
        return { stageId: stage.id, rows, count };
      }),
    ),
  ]);
  const rows = await maskLeads(masker, columns.flatMap((c) => c.rows));
  return { ...(await boardCards(user.id, rows, shown.sales)), counts: Object.fromEntries(columns.map((c) => [c.stageId, c.count])), total };
}

/** A column's next cards on the board, after the `skip` it already shows — the same filters, the same order. */
export async function listLeadBoardColumn(params: LeadListParams, stageId: string, skip: number) {
  const user = await requireModuleAccess("leads");
  const [where, pipeline, masker] = await Promise.all([leadListWhere(user.id, params), leadStages(), listLeadMasker(user.id)]);
  const { shown, stages } = boardColumns(pipeline, params.pipeline);
  const stage = stages.find((s) => s.id === stageId);
  const from = Number.isInteger(skip) && skip >= 0 ? skip : 0;
  if (!stage) return { cards: [], extras: {}, quotes: null };
  const rows = await db.lead.findMany({
    where: { AND: [where, inStageWhere(pipeline, stage)] },
    orderBy: leadListOrder(params),
    include: leadListInclude,
    skip: from,
    take: BOARD_COLUMN_SIZE,
  });
  return boardCards(user.id, await maskLeads(masker, rows), shown.sales);
}

/**
 * The list view's page of leads.
 *
 * Its Email and Phone columns are the lead contact's, as on the lead's own page: how to reach somebody
 * is `contacts.view`'s to give, so without it they aren't read at all (`contactDetails` is false and
 * the columns aren't drawn) — and with it they are masked as the list masks them for this person.
 */
export async function listLeadsPaged(params: LeadListParams & { page: number; pageSize: number }) {
  const user = await requireModuleUser("leads");
  // One `where` for both queries: the count has to be the count of the rows this viewer can see,
  // or the pager offers a page 9 that comes back empty.
  const [where, contactDetails] = await Promise.all([leadListWhere(user.id, params), hasEffectivePermission(user.id, "contacts.view")]);
  const include = {
    ...leadListInclude,
    contact: { select: contactDetails ? { id: true, name: true, email: true, phone: true } : { id: true, name: true } },
    // The company's account manager and caller, and who added the lead — the list's columns (owner, 30 Oct 2026).
    company: { select: { id: true, name: true, companySeq: true, owner: { select: { id: true, name: true } }, assignedTo: { select: { id: true, name: true } } } },
    createdBy: { select: { id: true, name: true } },
  } satisfies Prisma.LeadInclude;
  // Last activity, next follow-up and moved stage are ranked across every lead the filters match, then the page cut.
  const s = resolveSort(LEAD_SORTS, params.sort, params.dir);
  const page = async () => {
    if (!RANKED_LEAD_SORTS.has(s.key)) return db.lead.findMany({ where, orderBy: leadListOrder(params), include, ...pageSlice(params.page, params.pageSize) });
    const ids = (await db.lead.findMany({ where, select: { id: true }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }] })).map((l) => l.id);
    const pageIds = pageOfRanked(ids, await leadSortValues(s.key, where, ids), s.dir, params.page, params.pageSize);
    return inIdOrder(await db.lead.findMany({ where: { id: { in: pageIds } }, include }), pageIds);
  };
  const [rows, total] = await Promise.all([page(), db.lead.count({ where })]);
  // As a list masks them, with any lead "Show"n today in the clear and a "Show" on the rest (src/lib/leads/masking.ts).
  return { rows: await maskLeadsForList(user.id, rows), total, contactDetails };
}

export async function getLead(id: string) {
  const user = await requireModuleUser("leads");
  if (!(await canViewLeads(user.id))) return null;
  // The timeline shows their own and their team's activity, or everybody's with "See everyone's calls,
  // notes & meetings" (owner, 8 Oct 2026) — as on the customer's Activity pane (`getCompany`). The
  // calls, notes & meetings rule (src/lib/authz/access.ts, "activities") answers it.
  const activityWhere = await timelineAccess(user.id, "view");
  const lead = await db.lead.findUnique({
    where: { id },
    include: {
      // What the lead's page shows of its account, and nothing else: this is a server action, so
      // whatever it selects can be asked for directly — the account's bank and tax details included,
      // when it selected the whole row.
      company: {
        select: {
          id: true,
          name: true,
          companySeq: true,
          stage: true,
          website: true,
          linkedinUrl: true,
          // The account's own sales rep, which is not the same as the lead's owner: a rep can be
          // working a deal on an account somebody else manages, and both are worth showing.
          owner: { select: { id: true, name: true } },
          assignedTo: { select: { id: true, name: true } },
          industry: { select: { id: true, name: true } },
          customerCategory: { select: CATEGORY_SELECT },
          locations: {
            orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
            select: { id: true, isPrimary: true, address: true, city: true, state: true, pincode: true, country: true },
          },
        },
      },
      contact: true,
      owner: { select: { id: true, name: true } },
      sourcedBy: { select: { id: true, name: true } },
      qualifiedBy: { select: { id: true, name: true } },
      // Who opened it — "Raised by" on the page, and whose incentive a win passed on pays (owner, 1 Nov 2026).
      createdBy: { select: { id: true, name: true } },
      activities: {
        where: activityWhere,
        orderBy: { occurredAt: "desc" },
        include: { user: { select: { id: true, name: true } } },
      },
      proposals: { orderBy: { createdAt: "desc" } },
      requirements: { orderBy: { createdAt: "asc" }, include: { item: true } },
    },
  });
  if (!lead) return null;
  /**
   * The detail view refuses rather than filters, and refuses the same way it answers a lead id
   * that does not exist — so an id cannot be used to find out which accounts are real.
   *
   * This is the leak the list scope does not close on its own: the page is reachable by typing a
   * `/leads/<id>` URL, and everything the include pulls in beside the lead — the account's full
   * record and locations, the contact, the whole activity trail — comes with it.
   */
  if (!(await mayAccess(user.id, "leads", "view", lead.id))) return null;
  // The lead names its contact either way; how to reach them is `contacts.view`'s to give — and the
  // address last checked is how to reach them too.
  const contact =
    lead.contact && !(await hasEffectivePermission(user.id, "contacts.view"))
      ? { ...lead.contact, email: null, phone: null, linkedinUrl: null, emailCheckedValue: null, emailCheckDetail: null }
      : lead.contact;

  // Field access, on the lead's own page (src/lib/leads/masking.ts): masked fields stay masked until
  // the lead is unmasked today, restricted ones are never sent. The account's address is sent as the
  // two lines the page shows, never as its locations.
  const masker = await detailLeadMasker(user.id, lead.id);
  // Its company's website and address follow the companies policy as well — masked if either policy masks them, with
  // today's reveal of the company (its own "Show", or this lead's) honoured (owner, 5 Nov 2026 — Phase 3 masking fixes,
  // audit H.4.1). The company's name stays the lead's `companyName` rule.
  const account = await leadAccountView(user.id, masker, lead.company.id);
  const { locations, ...company } = lead.company;
  const primary = locations.find((l) => l.isPrimary) ?? locations[0] ?? null;
  const address = account.address(primary);
  // What people wrote about the lead — activity notes, why it was lost — quotes its fields too: the address as the
  // address line shows it.
  const redact = leadRedactor(account.masker, leadSecrets(lead));
  return toPlain({
    ...maskLead(masker, { ...lead, company: { ...company, website: account.website(company.website) }, contact, activities: redact.deep(lead.activities), lostReason: redact(lead.lostReason) }),
    address,
    masking: { concealed: masker.concealed, revealable: masker.revealable, revealed: masker.revealed },
  });
}

/**
 * What a new document needs to know when it is being raised from a lead.
 *
 * The point of quoting from a deal rather than from a blank form is that the requirement has
 * already been captured — item and quantity, agreed on a call — so the proposal starts as a priced
 * version of that conversation instead of being typed out a second time. Prices come from the
 * catalogue at the moment of quoting, which is deliberately a snapshot: the document owns its own
 * numbers once created, and a later price rise must not silently rewrite a quotation already sent.
 */
export async function leadDocumentDraft(leadId: string) {
  const user = await requireModuleUser("leads");
  if (!(await canViewLeads(user.id))) return null;
  // Scoped in the `where` rather than checked after the fetch, so the `select` stays exactly the
  // shape the document form expects — a lead out of scope is simply not found, as in `getLead`.
  const lead = await db.lead.findFirst({
    where: { AND: [{ id: leadId }, await leadAccess(user.id, "view")] },
    select: {
      id: true,
      leadSeq: true,
      title: true,
      companyId: true,
      ownerUserId: true,
      requirements: {
        orderBy: { createdAt: "asc" },
        select: {
          quantity: true,
          notes: true,
          item: {
            select: {
              id: true, name: true, sku: true, unit: true, hsnCode: true,
              sellingPrice: true, taxRatePercent: true, description: true,
              // Whether the line starts with a service period, and which (src/lib/documents/service-period.ts).
              type: true,
            },
          },
        },
      },
    },
  });
  if (!lead) return null;
  // The title goes into the new document's reference: as the person sees it on the lead's page.
  const masker = await detailLeadMasker(user.id, lead.id);
  return toPlain({ ...lead, title: maskLeadTitle(masker, lead.title) });
}

export async function updateLeadStatus(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("leads");
  if (!(await canViewLeads(user.id))) return { ok: false, error: NO_LEADS };
  const parsed = updateLeadStatusSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { leadId, stageId, status, lostReason } = parsed.data;

  // Scoped like the lead page: moving another account's lead through the pipeline by id was open.
  if (!(await leadInScope(user.id, leadId))) return { ok: false, error: "Lead not found." };

  // What a move is — where to, the stage's rule, what it writes and what follows — is shared with
  // Automate's workflows (src/lib/leads/stage-move.ts).
  const planned = await planStageMove({ leadId, stageId, status, lostReason });
  if (!planned.ok) return planned;
  const move = planned.move;
  if (!move) return { ok: true, data: { id: leadId } };
  // Security audit round three, 14 Nov 2026 (low): a closed lead (won, lost, disqualified) moved back to an open stage
  // is an open lead on its owner again, so it takes room under their open-leads limit as a new one would — it skipped
  // the limit before. Only the open count: reopening isn't an assignment, so the day's and month's limits don't apply.
  const reopening = !!move.lead.ownerUserId && CLOSED_LEAD_STATUSES.includes(move.lead.status) && !CLOSED_LEAD_STATUSES.includes(move.status);
  try {
    await db.$transaction(async (tx) => {
      if (reopening) {
        await markLeadWrite(tx, "updateLeadStatus");
        try {
          await claimLeadCapacity(tx, [move.lead.ownerUserId], { creating: false, count: 1, open: 1 });
        } catch (err) {
          if (!(err instanceof LeadCapacityFull && err.limit !== "open")) throw err;
        }
      }
      await writeStageMove(tx, move, user.id);
    });
  } catch (err) {
    const full = leadCapacityError(err);
    if (full) return { ok: false, error: full.message };
    throw err;
  }
  await afterStageMove(move, user.id);
  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  revalidatePath(`/companies/${move.lead.companyId}`);
  return { ok: true, data: { id: leadId } };
}

/**
 * A lead's own details, from "Edit" on its page: title, description, value, expected close date and
 * contact — what a stage's rule may ask for before the lead moves on. The same line as every change to a
 * lead (`leadInScope`); the contact must work at the lead's company, as when the lead was made.
 */
export async function updateLeadDetails(input: unknown): Promise<ActionResult<null>> {
  const user = await requireModuleUser("leads");
  if (!(await canViewLeads(user.id))) return { ok: false, error: NO_LEADS };
  const parsed = updateLeadDetailsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the details." };
  const data = parsed.data;
  const lead = await db.lead.findUnique({
    where: { id: data.leadId },
    select: { id: true, title: true, description: true, estimatedValue: true, expectedCloseDate: true, contactId: true, companyId: true, status: true },
  });
  if (!lead || !(await leadInScope(user.id, lead.id))) return { ok: false, error: "Lead not found." };
  // Security audit, 11 Nov 2026 (SEC-36): a won deal's value is what targets, wins and incentives were
  // counted on. Changing it afterwards rewrites a result already reported; reopen the lead first, which
  // leaves a stage-change note saying so.
  const sentValue = data.estimatedValue ?? null;
  const heldValue = lead.estimatedValue === null ? null : Number(lead.estimatedValue);
  if (lead.status === "WON" && sentValue !== heldValue) {
    return { ok: false, error: "This lead is won, so its value is locked. Reopen it to change the value." };
  }
  const masker = await detailLeadMasker(user.id, lead.id);
  // Choosing a contact by a name one can't see would be choosing blind; the lead keeps its contact.
  const contactId = masker.locked("contactName") ? lead.contactId : data.contactId || null;
  if (contactId && contactId !== lead.contactId) {
    const contact = await db.contact.findUnique({ where: { id: contactId }, select: { companyId: true } });
    if (!contact || contact.companyId !== lead.companyId) return { ok: false, error: "That contact isn't at this company." };
  }
  // A field this person sees masked or not at all is one they can't change: what the form sent back for
  // it is the mask, never the value. It keeps what it holds (src/lib/leads/masking.ts `locked`).
  const next = {
    title: masker.locked("title") ? lead.title : data.title,
    description: masker.locked("description") ? lead.description : data.description || null,
    estimatedValue: data.estimatedValue ?? null,
    // A calendar day, kept as its midnight UTC, as the new-lead form keeps it.
    expectedCloseDate: data.expectedCloseDate ? new Date(`${data.expectedCloseDate}T00:00:00Z`) : null,
    contactId,
  };
  // The workspace's field rules (src/lib/field-rules), on what this save sends — not on fields kept as they are.
  {
    const sent: Record<string, unknown> = { estimatedValue: next.estimatedValue, expectedCloseDate: data.expectedCloseDate || null };
    if (!masker.locked("title")) sent.title = next.title;
    if (!masker.locked("description")) sent.description = next.description;
    if (!masker.locked("contactName")) sent.contactId = next.contactId;
    const ruled = await fieldRuleRefusal("LEAD", { ...(await leadRecord(lead.id)), ...sent }, { id: lead.id, touched: Object.keys(sent) });
    if (ruled) return { ok: false, error: ruled };
  }
  const changed = [
    lead.title !== next.title ? "title" : null,
    (lead.description ?? null) !== next.description ? "description" : null,
    (lead.estimatedValue === null ? null : Number(lead.estimatedValue)) !== next.estimatedValue ? "value" : null,
    (lead.expectedCloseDate?.getTime() ?? null) !== (next.expectedCloseDate?.getTime() ?? null) ? "expected close date" : null,
    lead.contactId !== next.contactId ? "contact" : null,
  ].filter((c): c is string => !!c);
  if (changed.length === 0) return { ok: true, data: null };
  await db.lead.update({ where: { id: lead.id }, data: next, select: { id: true } });
  // What changed, for the lead's Activity (src/lib/activity/fields.ts).
  const changes = await leadChanges(lead as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Lead", entityId: lead.id, entityLabel: `${next.title} — ${changed.join(", ")} changed`, changes });
  await refreshLeadScore(lead.id);
  revalidatePath("/leads");
  revalidatePath(`/leads/${lead.id}`);
  return { ok: true, data: null };
}

/**
 * Moves a lead to another team pipeline — a sales lead that turned out to be a partner, say — to that
 * pipeline's first stage, or an open stage of it chosen. Its status becomes that stage's meaning, with a
 * stage-change note as any move leaves, naming both pipelines. A closed lead stays where it was won or
 * lost; it is reopened first. The rule and automations of the stage it lands in apply as they would.
 */
export async function moveLeadToPipeline(input: unknown): Promise<ActionResult<{ stageId: string }>> {
  const user = await requireModuleAccess("leads");
  if (!(await canViewLeads(user.id))) return { ok: false, error: NO_LEADS };
  const parsed = moveLeadToPipelineSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Choose a pipeline." };
  const { leadId, pipelineId, stageId } = parsed.data;
  const pipeline = await leadStages();
  if (!pipeline.multi) return { ok: false, error: "This workspace is still being updated. Try again in a minute." };
  const lead = await db.lead.findUnique({ where: { id: leadId } });
  if (!lead || !(await leadInScope(user.id, leadId))) return { ok: false, error: "Lead not found." };
  const into = pipeline.pipelines.find((p) => p.id === pipelineId && !p.archived);
  if (!into) return { ok: false, error: "That pipeline is no longer in use." };
  const from = (await stagesOfLeads([{ id: leadId, status: lead.status }])).get(leadId)!;
  if (from.pipelineId === into.id) return { ok: false, error: `It is already in ${into.name}.` };
  if (kindOf(lead.status) !== "OPEN") return { ok: false, error: "A won or lost lead stays where it closed. Reopen it first." };
  const open = pipeline.stages.filter((s) => s.pipelineId === into.id && !s.archived && kindOf(s.status) === "OPEN");
  const target = stageId ? open.find((s) => s.id === stageId) : stageForStatus(open, "NEW", into.id);
  if (!target) return { ok: false, error: `Choose one of ${into.name}'s open stages.` };
  const stop = await ruleStops(target, lead);
  if (stop) return { ok: false, error: stop };

  const now = new Date();
  const was = pipelineById(pipeline.pipelines, from.pipelineId);
  await db.$transaction(async (tx) => {
    await tx.lead.update({ where: { id: leadId }, data: { status: target.status, ...stageWrite(pipeline, target, now) } });
    await tx.activity.create({
      data: {
        leadId,
        userId: user.id,
        type: "STAGE_CHANGE",
        notes: stageChangeNote({ status: from.status, label: `${was.name}: ${from.label}` }, { status: target.status, label: `${into.name}: ${target.label}` }, `moved from ${was.name} to ${into.name}`),
      },
    });
    await emitLeadMoved(tx, leadId, user.id, { stageId: from.id, status: from.status, pipelineId: from.pipelineId }, { stageId: target.id, status: target.status, pipelineId: into.id });
  });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Lead", entityId: leadId, entityLabel: `${lead.title} — moved from ${was.name} to ${into.name}` });
  await refreshLeadScore(leadId);
  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  return { ok: true, data: { stageId: target.id } };
}

/** The pipeline a lead is in, and the leads it carried on from or into (connected pipelines) — for its page. */
export async function leadConnections(leadId: string): Promise<{
  pipeline: { id: string; key: string; name: string; sales: boolean };
  multi: boolean;
  from: { id: string; leadSeq: number; title: string; pipeline: string } | null;
  into: { id: string; leadSeq: number; title: string; pipeline: string }[];
} | null> {
  const user = await requireModuleAccess("leads");
  if (!(await canViewLeads(user.id)) || !(await mayAccess(user.id, "leads", "view", leadId))) return null;
  const pipeline = await leadStages();
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { id: true, status: true } });
  if (!lead) return null;
  const stage = (await stagesOfLeads([lead])).get(lead.id)!;
  const own = pipelineById(pipeline.pipelines, stage.pipelineId);
  const name = (id: string | null) => pipelineById(pipeline.pipelines, id).name;
  let from: { id: string; leadSeq: number; title: string; pipeline: string } | null = null;
  let into: { id: string; leadSeq: number; title: string; pipeline: string }[] = [];
  if (pipeline.multi) {
    try {
      const row = await db.lead.findUnique({
        where: { id: leadId },
        select: {
          fromLead: { select: { id: true, leadSeq: true, title: true, pipelineId: true } },
          carriedOnAs: { select: { id: true, leadSeq: true, title: true, pipelineId: true }, orderBy: { createdAt: "asc" } },
        },
      });
      const masker = await listLeadMasker(user.id);
      from = row?.fromLead ? { ...row.fromLead, title: maskLeadTitle(masker, row.fromLead.title), pipeline: name(row.fromLead.pipelineId) } : null;
      into = (row?.carriedOnAs ?? []).map((l) => ({ ...l, title: maskLeadTitle(masker, l.title), pipeline: name(l.pipelineId) }));
    } catch (err) {
      if (!notMigratedYet(err)) throw err;
    }
  }
  return { pipeline: { id: own.id, key: own.key, name: own.name, sales: own.sales }, multi: pipeline.multi && pipeline.pipelines.filter((p) => !p.archived).length > 1, from, into };
}

/**
 * The lead's own fields (src/lib/custom-fields), from the "More details" card on its page — bound to
 * the lead there. A lead has no general edit, so the line is the one every change to it draws
 * (`updateLeadStatus`, `logActivity`, `addLeadRequirement`): `leads.view`, and the lead's account in
 * this person's scope (`leadInScope`). With no level stored, those are the checks that open the lead
 * page; an edit level an admin sets may be narrower.
 */
export async function updateLeadCustomFields(leadId: string, input: unknown): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("leads");
  if (!(await canViewLeads(user.id))) return { ok: false, error: NO_LEADS };
  if (typeof leadId !== "string" || !leadId) return { ok: false, error: "Lead not found." };

  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { id: true, title: true } });
  // Scoped like the lead page; out of scope and missing answer the same.
  if (!lead || !(await leadInScope(user.id, lead.id))) {
    return { ok: false, error: "Lead not found." };
  }

  // Masked fields not unmasked today keep what they hold — the form never had their values.
  const masker = await detailLeadMasker(user.id, lead.id);
  const locked = (await definitionsFor("LEAD")).filter((d) => masker.locked(customFieldKey(d.key))).map((d) => d.key);
  {
    const asked = customInput(input);
    const ruled = await fieldRuleRefusal("LEAD", { ...(await leadRecord(lead.id)), ...asked.record }, { id: lead.id, touched: asked.touched.filter((k) => !locked.includes(k.slice(3))) });
    if (ruled) return { ok: false, error: ruled };
  }
  const saved = await saveCustomFields("LEAD", lead.id, user.id, input, { skip: locked });
  if (!saved.ok) return saved;
  if (saved.changed.length > 0) {
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Lead", entityId: lead.id, entityLabel: `${lead.title}${changedLabel(saved.changed)}` });
    revalidatePath("/leads");
    revalidatePath(`/leads/${lead.id}`);
  }
  return { ok: true, data: null };
}

export async function exportLeadsCsv(): Promise<ActionResult<{ csv: string; filename: string }>> {
  const user = await requireModuleAccess("leads");
  if (!(await canViewLeads(user.id))) return { ok: false, error: NO_LEADS };
  /**
   * The same rules as every other CRM export (security review, 23 Oct 2026): "Export CRM data", the workspace's row
   * limit, and a line in the security log — this one skipped all three, so anybody who could see leads could take
   * the file away, unrecorded.
   */
  if (!(await hasEffectivePermission(user.id, "data.exportCrm"))) {
    await logSecurityActivity({ kind: "PERMISSION_DENIED", severity: "WARNING", summary: `${user.name} tried to export leads without the export permission`, metadata: { area: "leads" } });
    return { ok: false, error: "You can't export leads. Ask an administrator for \"Export CRM data\"." };
  }
  const where = await leadListWhere(user.id);
  const verdict = exportDecision(await db.lead.count({ where }), await getSecurityPolicy());
  if (!verdict.allowed) return { ok: false, error: verdict.reason };

  const leads = await db.lead.findMany({
    // The export is the list with no screen in front of it, and it is the worse leak of the two:
    // a file of every deal, its value and its customer contact, kept after the session ends.
    where,
    orderBy: { updatedAt: "desc" },
    include: {
      company: { select: { name: true } },
      contact: { select: { name: true } },
      owner: { select: { name: true } },
      sourcedBy: { select: { name: true } },
      qualifiedBy: { select: { name: true } },
      requirements: { include: { item: { select: { name: true } } } },
    },
  });

  const clock = await workspaceClock();
  // An export is a list that leaves the building: masked as the list is, never unmasked — with each field's export
  // answer on top (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.4: left out, masked though the list shows it, or
  // in the clear where the person sees it so somewhere). Never read back in, so the export's mask goes out as it is.
  const masker = await leadMasker(user.id, "export");
  const rows = (await maskLeads(masker, leads)).map((lead) => ({
    title: sanitizeCsvCell(lead.title),
    company: sanitizeCsvCell(lead.company.name),
    contact: sanitizeCsvCell(lead.contact?.name ?? ""),
    status: lead.status,
    owner: sanitizeCsvCell(lead.owner?.name ?? ""),
    estimatedValue: lead.estimatedValue?.toString() ?? "",
    // A calendar day held as midnight UTC, so its UTC date is the day typed.
    expectedCloseDate: lead.expectedCloseDate ? lead.expectedCloseDate.toISOString().slice(0, 10) : "",
    products: sanitizeCsvCell(
      lead.requirements.map((r) => `${r.item.name} x${r.quantity}`).join("; "),
    ),
    sourcedBy: sanitizeCsvCell(lead.sourcedBy?.name ?? ""),
    qualifiedBy: sanitizeCsvCell(lead.qualifiedBy?.name ?? ""),
    lostReason: sanitizeCsvCell(lead.lostReason ?? ""),
    description: sanitizeCsvCell(lead.description ?? ""),
    // A moment: the day it falls on in the workspace (its UTC date was the day before for a lead
    // added in India before 05:30).
    createdAt: clock.dateKey(lead.createdAt),
  }));

  // The workspace's own lead fields this person may see, as the last columns — every row carries every
  // one, since the file's header is its first row's keys (src/lib/custom-fields/sheets.ts) — blank where the export
  // answer leaves one out, or masks it though the list doesn't (`customLeftBlank`: those cells are masked as the list is).
  const blank = await customLeftBlank(user.id, "leads");
  const custom = await exportCells("LEAD", user.id, leads.map((l) => l.id), Object.keys(rows[0] ?? {}), { sanitize: sanitizeCsvCell, hiddenFor: () => (blank.size ? blank : undefined) });
  const csv = Papa.unparse(rows.map((row, i) => ({ ...row, ...custom(leads[i]!.id) })));
  await logSecurityActivity({ kind: "EXPORT", severity: "NOTICE", summary: `${user.name} exported ${rows.length} lead(s)`, metadata: { area: "leads", rows: rows.length } });
  return { ok: true, data: { csv, filename: csvFilename("leads-export", new Date(), clock) } };
}

export async function logActivity(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("leads");
  if (!(await canViewLeads(user.id))) return { ok: false, error: NO_LEADS };
  const parsed = logActivitySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { leadId, type, notes } = parsed.data;

  const lead = await db.lead.findUnique({ where: { id: leadId } });
  // Scoped like the lead page: logging a call against another account's lead by id was open.
  if (!lead || !(await leadInScope(user.id, leadId))) {
    return { ok: false, error: "Lead not found." };
  }

  const activity = await db.activity.create({
    data: { leadId, userId: user.id, type, notes },
  });

  if (lead.ownerUserId && lead.ownerUserId !== user.id) {
    await notifyUser({
      userId: lead.ownerUserId,
      type: "LEAD_ACTIVITY",
      title: "New activity on your lead",
      message: `${lead.title} — ${notes}`,
      link: leadPath(lead.leadSeq),
    });
  }

  await refreshLeadScore(leadId);
  revalidatePath(`/leads/${leadId}`);
  return { ok: true, data: { id: activity.id } };
}

/** A bulk reassign whose leads' owners changed between the check and the move (audit D.5): nothing moves. */
class LeadsChangedHands extends Error {}

/**
 * Who an audit row is by, beyond the person — the admin viewing as them, the API key or phone it came through — as
 * recordAudit (src/lib/audit.ts) works it out, for rows written inside a transaction, which recordAudit can't join.
 */
async function auditStamp(): Promise<{ impersonatedByUserId: string | null; via: string }> {
  const api = apiActor();
  const via = api ? ` — via ${api.channel === "app" ? `the Deskzo app on “${api.keyName}”` : `API key “${api.keyName}”`}` : "";
  if (api) return { impersonatedByUserId: null, via };
  try {
    const session = await auth();
    const context = session?.user ? await resolveViewAs(session.user.id) : null;
    return { impersonatedByUserId: context?.actor.id ?? null, via };
  } catch {
    // No request (a script, a job): nobody viewing as anybody.
    return { impersonatedByUserId: null, via };
  }
}

/**
 * Bulk edits from the list view's selection bar. Status is applied one lead at a time rather than
 * with a single `updateMany`, because a status change isn't just a column: it writes an activity
 * entry, can flip the company to CUSTOMER, and notifies the owner. Doing it in bulk must leave the
 * same trail as doing it one by one, or the pipeline history quietly develops holes.
 */
export async function bulkUpdateLeads(input: unknown): Promise<ActionResult<{ count: number }>> {
  const user = await requireModuleUser("leads");
  if (!(await canViewLeads(user.id))) return { ok: false, error: NO_LEADS };
  const parsed = bulkUpdateLeadsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { leadIds, ownerUserId, status, stageId, lostReason } = parsed.data;
  if (!ownerUserId && !status && !stageId) {
    return { ok: false, error: "Pick an owner or a stage to apply." };
  }
  if ((status === "LOST" || status === "DISQUALIFIED") && !lostReason) {
    return { ok: false, error: "A reason is required when marking leads lost or disqualified." };
  }

  if (ownerUserId) {
    const nextOwnerId = ownerUserId === "unassign" ? null : ownerUserId;
    if (nextOwnerId) {
      const owner = await db.user.findUnique({ where: { id: nextOwnerId }, select: { id: true, active: true } });
      if (!owner || !owner.active) return { ok: false, error: "That user can't be assigned leads." };
      const refusal = await assignRefusal("leadOwner", nextOwnerId);
      if (refusal) return { ok: false, error: refusal };
    }
    /**
     * Every selected lead must be one this person can see *and* may hand on — see
     * src/lib/authz/reassign.ts. This took any ids and changed them with no check at all. All or
     * nothing, so a list is never left half-reassigned by rows quietly skipped.
     */
    const rights = await reassignRights(user.id);
    const leads = await db.lead.findMany({
      where: { AND: [{ id: { in: leadIds } }, await leadAccess(user.id, "assign")] },
      select: { id: true, leadSeq: true, title: true, ownerUserId: true, status: true, companyId: true },
    });
    if (leads.length !== new Set(leadIds).size) {
      return { ok: false, error: "Some of the selected leads are not yours to change." };
    }
    const refused = leads.filter((l) => !mayChangeLeadOwner(rights, user.id, l));
    if (refused.length) {
      const masker = await listLeadMasker(user.id);
      return {
        ok: false,
        error: `You can only hand off leads you own — ${refused.length === 1 ? `“${maskLeadTitle(masker, refused[0]!.title)}” isn't yours` : `${refused.length} of these aren't yours`}.`,
      };
    }
    if (!nextOwnerId && !mayLeaveUnassigned(rights)) {
      return { ok: false, error: "Hand them to a colleague — only someone who can reassign leads may leave them with nobody." };
    }
    /**
     * All or nothing, in one transaction (owner, 12 Nov 2026 — Phase 4 lead limits, audit D.5 and H.6.5): room for the
     * new owner for every lead that comes to them, then each old owner's leads moved only while still theirs — the
     * owner the rules above were checked against — then the audit rows. A lead that changed hands since, or a new owner
     * who'd pass a limit, and nothing moves. Names are read first: nothing inside reads through the global client.
     */
    const moving = leads.filter((l) => l.ownerUserId !== nextOwnerId);
    const names = new Map<string | null, string>();
    for (const id of new Set<string | null>([nextOwnerId, ...moving.map((l) => l.ownerUserId)])) names.set(id, await ownerName(id));
    const audit = await auditStamp();
    const byOldOwner = new Map<string | null, string[]>();
    for (const l of moving) byOldOwner.set(l.ownerUserId, [...(byOldOwner.get(l.ownerUserId) ?? []), l.id]);
    try {
      await db.$transaction(async (tx) => {
        await markLeadWrite(tx, "bulkUpdateLeads");
        if (nextOwnerId && moving.length) {
          const open = moving.filter((l) => !CLOSED_LEAD_STATUSES.includes(l.status)).length;
          await claimLeadCapacity(tx, [nextOwnerId], { creating: false, count: moving.length, open });
        }
        for (const [oldOwnerId, ids] of byOldOwner) {
          const moved = await tx.lead.updateMany({ where: { id: { in: ids }, ownerUserId: oldOwnerId }, data: { ownerUserId: nextOwnerId } });
          if (moved.count !== ids.length) throw new LeadsChangedHands();
        }
        if (moving.length) {
          await tx.auditLog.createMany({
            data: moving.map((lead) => ({
              userId: user.id,
              impersonatedByUserId: audit.impersonatedByUserId,
              action: "UPDATE" as const,
              entityType: "Lead",
              entityId: lead.id,
              entityLabel: `${lead.title} — owner: ${names.get(lead.ownerUserId)} → ${names.get(nextOwnerId)}${audit.via}`,
              companyId: lead.companyId,
              leadId: lead.id,
            })),
          });
        }
      }, { maxWait: 10_000, timeout: 20_000 });
    } catch (err) {
      const full = leadCapacityError(err);
      if (full) return { ok: false, error: full.message };
      if (err instanceof LeadsChangedHands) return { ok: false, error: "Some of these leads changed hands while you were choosing — nothing was moved. Refresh and try again." };
      throw err;
    }
    if (nextOwnerId && nextOwnerId !== user.id) {
      await notifyUser({
        userId: nextOwnerId,
        type: "LEAD_ASSIGNED",
        title: `${leads.length === 1 ? "A lead was" : `${leads.length} leads were`} assigned to you`,
        message: leads.length === 1 ? leads[0]!.title : undefined,
        link: leads.length === 1 ? leadPath(leads[0]!.leadSeq) : "/leads?view=list",
      });
    }
  }

  if (stageId || status) {
    for (const leadId of leadIds) {
      const result = await updateLeadStatus({ leadId, ...(stageId ? { stageId } : { status }), lostReason });
      if (!result.ok) return { ok: false, error: result.error };
    }
  }

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Lead",
    entityId: leadIds[0],
    entityLabel: `Bulk updated ${leadIds.length} lead(s)`,
  });
  revalidatePath("/leads");
  return { ok: true, data: { count: leadIds.length } };
}
