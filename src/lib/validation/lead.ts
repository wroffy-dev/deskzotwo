import { z } from "zod";
import { tooLong, tooMany } from "@/lib/validation/text";
import { LEAD_SOURCE_VALUES } from "@/lib/leads/source";

export const leadStatusValues = [
  "NEW",
  "CONTACTED",
  "QUALIFYING",
  "QUALIFIED",
  "PROPOSAL_SENT",
  "NEGOTIATION",
  "WON",
  "LOST",
  "DISQUALIFIED",
] as const;

export const activityTypeValues = ["CALL", "EMAIL", "NOTE", "MEETING", "STAGE_CHANGE"] as const;

/**
 * A renewal date as a date input sends it — `YYYY-MM-DD` — or blank.
 *
 * Checked as a real calendar day, not just the shape: "2026-02-30" has the right digits and is not a
 * date, and `new Date()` would quietly roll it into March.
 */
const renewalDateField = z
  .string()
  .trim()
  .max(100, tooLong(100))
  .refine((v) => {
    if (v === "") return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Pick a valid renewal date")
  .optional()
  .or(z.literal(""));

/** Remarks on a product line — typically the reference of the subscription it concerns. */
const remarksField = z.string().trim().max(500, "Keep remarks under 500 characters").optional().or(z.literal(""));

export const leadRequirementInputSchema = z.object({
  itemId: z.string().max(100, tooLong(100)).min(1, "Select a product"),
  quantity: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? 1 : Number(v)),
    z.number().int().positive("Quantity must be at least 1"),
  ),
  notes: remarksField,
  renewalDate: renewalDateField,
});

export type LeadRequirementInput = z.infer<typeof leadRequirementInputSchema>;

export const createLeadSchema = z.object({
  companyId: z.string().max(100, tooLong(100)).min(1),
  contactId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  title: z.string().trim().max(500, tooLong(500)).min(2, "Title is required"),
  description: z.string().trim().max(20000, tooLong(20000)).optional().or(z.literal("")),
  estimatedValue: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : Number(v)),
    z.number({ error: "Enter the value as a number" }).nonnegative("A value can't be negative").max(9_999_999_999, "That value is too large").optional(),
  ),
  expectedCloseDate: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  /** Blank means "let the assignment rules decide" — see `chooseOwner`. */
  ownerUserId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  source: z.enum(LEAD_SOURCE_VALUES).default("OTHER"),
  sourceDetail: z.string().trim().max(300, "Keep the source detail under 300 characters").optional().or(z.literal("")),
  requirements: z.array(leadRequirementInputSchema).max(200, tooMany(200, "requirements")).default([]),
  /** The workspace's own fields (src/lib/custom-fields) — checked by the action against its definitions. */
  customFields: z.record(z.string().max(100, tooLong(100)), z.unknown()).optional(),
  /** The team pipeline it starts in (src/lib/pipeline); the main one when not given. */
  pipelineId: z.string().max(40).optional().or(z.literal("")),
  /**
   * The request's own token — the form's, made once when it opens, or an Idempotency-Key — so the
   * same request sent twice makes one lead (createLead, src/actions/lead.ts). Not a field anybody fills.
   */
  requestId: z.string().trim().min(8).max(100).optional(),
});

export type CreateLeadInput = z.infer<typeof createLeadSchema>;

export const addLeadRequirementSchema = z.object({
  leadId: z.string().max(100, tooLong(100)).min(1),
  ...leadRequirementInputSchema.shape,
});

export type AddLeadRequirementInput = z.infer<typeof addLeadRequirementSchema>;

export const updateLeadRequirementSchema = z.object({
  id: z.string().max(100, tooLong(100)).min(1),
  quantity: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? 1 : Number(v)),
    z.number().int().positive("Quantity must be at least 1"),
  ),
  notes: remarksField,
  renewalDate: renewalDateField,
});

/** A renewal date field's value to store — UTC midnight of the day, or null. See `LeadRequirement.renewalDate`. */
export function renewalDateToStore(value: string | undefined): Date | null {
  return value ? new Date(`${value}T00:00:00Z`) : null;
}

export type UpdateLeadRequirementInput = z.infer<typeof updateLeadRequirementSchema>;

export const updateLeadStatusSchema = z
  .object({
    leadId: z.string().max(100, tooLong(100)).min(1),
    /** The workspace's own stage to move to (Settings → Pipeline, src/lib/pipeline). */
    stageId: z.string().max(100, tooLong(100)).min(1).optional(),
    /** Instead of a stage, for a caller that still names a status: the first stage with that meaning. */
    status: z.enum(leadStatusValues).optional(),
    lostReason: z.string().trim().max(5000, tooLong(5000)).optional().or(z.literal("")),
  })
  .refine((v) => v.stageId || v.status, { message: "Choose a stage." });

export type UpdateLeadStatusInput = z.infer<typeof updateLeadStatusSchema>;

/**
 * A lead's own details, edited on its page — what a stage's rule may ask for before a lead moves on
 * (src/lib/pipeline/rules.ts). The owner is changed by assigning; the stage by moving.
 */
export const updateLeadDetailsSchema = z.object({
  leadId: z.string().max(100, tooLong(100)).min(1),
  title: z.string().trim().min(2, "Title is required").max(200, "Keep the title under 200 characters"),
  description: z.string().trim().max(5000, "Keep the description under 5,000 characters").optional().or(z.literal("")),
  estimatedValue: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : Number(v)),
    z.number().nonnegative("A value can't be negative").max(9_999_999_999, "That value is too large").optional(),
  ),
  expectedCloseDate: z.string().max(100, tooLong(100)).regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date").optional().or(z.literal("")),
  contactId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
});

export type UpdateLeadDetailsInput = z.infer<typeof updateLeadDetailsSchema>;

/** A lead moved to another team pipeline — to its first stage, or one of its open stages. */
export const moveLeadToPipelineSchema = z.object({
  leadId: z.string().max(100, tooLong(100)).min(1),
  pipelineId: z.string().max(100, tooLong(100)).min(1),
  stageId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
});

export const logActivitySchema = z.object({
  leadId: z.string().max(100, tooLong(100)).min(1),
  // Not a stage change: those are written by a move alone, and the forecast and wins read them as fact.
  type: z.enum(activityTypeValues).refine((t) => t !== "STAGE_CHANGE", { message: "Move the lead to change its stage." }),
  notes: z.string().trim().max(20000, tooLong(20000)).min(1, "Notes are required"),
});

export type LogActivityInput = z.infer<typeof logActivitySchema>;

/** The most leads one bulk edit takes. */
export const MAX_BULK_LEADS = 500;

export const bulkUpdateLeadsSchema = z.object({
  // At most 500 at once (owner, 12 Nov 2026 — Phase 4 lead limits, audit D.5): a reassign is one transaction now.
  leadIds: z.array(z.string().max(100, tooLong(100)).min(1)).min(1, "Select at least one lead").max(MAX_BULK_LEADS, `Select at most ${MAX_BULK_LEADS} leads at a time.`),
  /** "" leaves the field alone; "unassign" clears the owner. */
  ownerUserId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  status: z.enum(leadStatusValues).optional().or(z.literal("")),
  /** The workspace's own stage to move them to — what the bulk bar sends now; `status` is the older form. */
  stageId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  lostReason: z.string().trim().max(5000, tooLong(5000)).optional().or(z.literal("")),
});
