import { z } from "zod";
import { db } from "@/lib/db";
import { formatLeadId } from "@/lib/order-id";
import { intakeLead, leadPayloadSchema, type IntakeResult } from "@/lib/lead-capture/intake";
import { LEAD_SOURCE_VALUES } from "@/lib/leads/source";
import { ActionError, causedBy, defineAction } from "@/lib/automate/action-types";
import { priorOutput, recordEffect, recordedAlready } from "@/lib/automate/effects";
import { activePerson, personField } from "@/lib/automate/actions/shared";
import { can } from "@/lib/authz/resolve";
import { leadCapacityError } from "@/lib/leads/limits";
import { LeadRuleRefused } from "@/lib/leads/intake-owner";

/**
 * Create a lead, with its company and contact (Deskzo Automate, Phase 2) — through the same door as a
 * website enquiry (src/lib/lead-capture/intake.ts), so its rules hold here too: no second company of the
 * same name, no second contact with the same email or phone, nothing for a reseller's customer, and the
 * assignment rules choose the owner unless the step names one.
 *
 * Retried safely: the step's record is written in the transaction that makes the lead, so a retry finds
 * it and hands back the same lead rather than making another.
 *
 * Owner, 12 Nov 2026 — Phase 4 lead limits (audit M-14, H.6.5):
 *   · Naming somebody else as the owner is assigning the lead, so it asks what New lead asks (`resolveOwner`,
 *     src/actions/lead.ts): the workflow's owner holds `leads.assign` or `accounts.reassign`. Themselves, freely.
 *   · Whoever it's for being at their lead limit leaves the lead with nobody, saying why, and the managers are told
 *     (`ownerAssigned` false). The plan's cap, and a rule that refuses a lead when its people are all full, fail the
 *     step — permanently, in their own words: trying again a minute later would meet the same limit.
 */

type Output =
  | { status: "created"; leadId: string; reference: string; ownerAssigned: boolean }
  | { status: "contact"; companyId: string; contactId: string }
  | { status: "reseller" };

const text = (max: number) => z.string().trim().max(max).optional();

const input = z
  .object({
    /** The person: their name, and an email or a phone. */
    name: z.string().trim().min(1, "Give the person's name.").max(120),
    email: text(200),
    phone: text(20),
    company: text(160),
    designation: text(80),
    /** What they want, kept on the lead's description. */
    message: text(5000),
    /** The lead's title; "<interest> — <company>" when not given. */
    title: text(200),
    interest: text(200),
    value: z.number().nonnegative().max(1_000_000_000).optional(),
    source: z.enum(LEAD_SOURCE_VALUES).default("OTHER"),
    /** "rules" (the assignment rules), "owner" (the workflow's owner), or a person's id. */
    owner: personField.default("rules"),
    /** A team pipeline to start in; the main one when not given. */
    pipelineId: z.string().trim().min(1).max(60).optional(),
  })
  .strict()
  .refine((i) => !!i.email || !!i.phone, { message: "Give an email or a phone number.", path: ["email"] });

export const leadCreate = defineAction({
  key: "lead.create",
  label: "Create a lead",
  description: "Creates a lead, with its company and contact unless they are already on file.",
  module: "leads",
  // The workflow's owner must be allowed to open leads themselves (owner, 1 Nov 2026).
  permission: "leads.create",
  risk: "change",
  input,
  outputs: ["status", "leadId", "reference", "ownerAssigned", "companyId", "contactId"],
  preview: (i) => `Would create a lead for ${i.name}${i.company ? ` at ${i.company}` : ""}.`,
  async run(ctx, i): Promise<Output> {
    const done = await priorOutput<Output>(ctx);
    if (done) return done.output;

    const payload = leadPayloadSchema.safeParse({
      name: i.name,
      email: i.email ?? "",
      phone: i.phone ?? "",
      company: i.company ?? "",
      designation: i.designation ?? "",
      message: i.message ?? "",
      product_interest: i.interest ?? "",
      budget: i.value,
      source: i.source,
    });
    if (!payload.success) throw new ActionError(payload.error.issues.map((issue) => issue.message).join("; "), "PERMANENT");
    const ownerUserId = i.owner === "rules" ? undefined : (await activePerson(ctx, i.owner, "lead's owner")).id;
    if (ownerUserId && ownerUserId !== ctx.actorId && !((await can(ctx.actorId, "leads.assign")) || (await can(ctx.actorId, "accounts.reassign")))) {
      throw new ActionError("The workflow's owner can't assign leads to other people. Leave the owner to the assignment rules, or choose the workflow's owner.", "PERMANENT");
    }

    // The step's record is written by intake inside its transaction, with what it made.
    let result: IntakeResult;
    try {
      result = await intakeLead(
        { id: null, name: "workflow", sourceLabel: `Workflow “${ctx.workflowName}”`, createdById: ctx.actorId },
        payload.data,
        {
          ownerUserId,
          leadTitle: i.title,
          notifyTitle: "A lead from a workflow was assigned to you",
          // The workflow's owner made it; they need no telling that it is theirs.
          notify: ownerUserId !== ctx.actorId,
          pipelineId: i.pipelineId ?? null,
          cause: causedBy(ctx),
          // A workflow made it, not its owner: nobody raised it (src/lib/lead-capture/intake.ts).
          raisedBy: null,
          path: "automate",
          inTransaction: async (tx, made) => {
            const lead = made.leadId ? await tx.lead.findUnique({ where: { id: made.leadId }, select: { leadSeq: true, ownerUserId: true } }) : null;
            const output: Output =
              made.leadId && lead
                ? { status: "created", leadId: made.leadId, reference: formatLeadId(lead.leadSeq), ownerAssigned: !!lead.ownerUserId }
                : { status: "contact", companyId: made.companyId, contactId: made.contactId };
            await recordEffect(tx, ctx, { output, recordType: made.leadId ? "lead" : "contact", recordId: made.leadId ?? made.contactId });
          },
        },
      );
    } catch (err) {
      if (recordedAlready(err)) {
        const again = await priorOutput<Output>(ctx);
        if (again) return again.output;
      }
      const full = leadCapacityError(err);
      if (full) throw new ActionError(full.message, "PERMANENT");
      if (err instanceof LeadRuleRefused) throw new ActionError(err.message, "PERMANENT");
      throw err;
    }
    if (result.status !== "reseller") return (await priorOutput<Output>(ctx))!.output;

    // A reseller's customer: nothing made, and whoever manages the reseller told. Recorded so a retry
    // doesn't tell them again.
    const output: Output = { status: "reseller" };
    await db.automationEffect.create({ data: { key: ctx.key, runId: ctx.runId, output } }).catch((err) => {
      if (!recordedAlready(err)) throw err;
    });
    return output;
  },
});

