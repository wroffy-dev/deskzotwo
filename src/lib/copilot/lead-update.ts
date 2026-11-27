import { z } from "zod";
import { db } from "@/lib/db";
import { mayAccess } from "@/lib/authz/access";
import { getLead } from "@/actions/lead";
import { isModuleEnabled } from "@/actions/module";
import { hasEffectivePermission } from "@/actions/permission";
import { baseLocale, formatMoney, formatMoneyWhole } from "@/lib/currency";
import { listLeadMasker, maskLead } from "@/lib/leads/masking";
import { formatLeadId } from "@/lib/order-id";
import { formatCalendarDay } from "@/lib/time/zone";
import type { ProposalChange } from "@/lib/copilot/types";

/**
 * A change to one existing lead, drafted in the chat (`propose_lead_update`, ./tools.ts) and saved only once the person
 * presses the card's button (`confirmCopilotProposal`, src/actions/copilot.ts).
 *
 *   · One lead, by its LEAD- reference, as `getLead` shows it to the person, and only one they may edit. One line of
 *     its products for a quantity: several that fit are listed for the person to choose from, never guessed between.
 *   · The proposal keeps what each field held when the card was drawn. Confirming compares it with what it holds then
 *     (`changedSince`), so a card never overwrites something nobody has seen on it.
 *   · What this person sees masked, whole or in part, they can't change from here — as on the lead's page. The real
 *     value never leaves this file except back to the lead's own actions, for the fields nobody asked to change.
 *
 * Server only.
 */

export const LEAD_UPDATE_FIELDS = ["title", "description", "estimatedValue", "expectedCloseDate", "quantity"] as const;
export type LeadUpdateField = (typeof LEAD_UPDATE_FIELDS)[number];

const changeSchema = z.object({
  field: z.enum(LEAD_UPDATE_FIELDS),
  from: z.union([z.string(), z.number(), z.null()]),
  to: z.union([z.string(), z.number()]),
  /** A quantity's: the line of the lead's products it is on, and that product's name for the card. */
  requirementId: z.string().optional(),
  product: z.string().optional(),
});
export type LeadChange = z.infer<typeof changeSchema>;

const payloadSchema = z.object({ leadId: z.string().min(1), changes: z.array(changeSchema).min(1).max(LEAD_UPDATE_FIELDS.length) });
export type LeadUpdatePayload = z.infer<typeof payloadSchema>;

/** A stored proposal's payload, or null when it isn't one. */
export function leadUpdatePayload(value: unknown): LeadUpdatePayload | null {
  const parsed = payloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const LABELS: Record<LeadUpdateField, string> = {
  title: "Title",
  description: "Description",
  estimatedValue: "Estimated value",
  expectedCloseDate: "Expected close date",
  quantity: "Quantity",
};

/** "Quantity — Dell Latitude 5450". */
export const changeLabel = (c: Pick<LeadChange, "field" | "product">): string => (c.field === "quantity" && c.product ? `${LABELS.quantity} — ${c.product}` : LABELS[c.field]);

function shownValue(field: LeadUpdateField, value: string | number | null): string {
  if (value === null || value === "") return field === "description" ? "None" : "Not set";
  if (field === "estimatedValue") return Number.isInteger(Number(value)) ? formatMoneyWhole(Number(value)) : formatMoney(Number(value));
  if (field === "expectedCloseDate") return formatCalendarDay(String(value));
  return field === "quantity" ? Number(value).toLocaleString(baseLocale()) : String(value);
}

/** The card's rows, old to new — read from the stored proposal, the very thing confirming acts on. */
export function changeRows(payload: unknown): ProposalChange[] {
  return (leadUpdatePayload(payload)?.changes ?? []).map((c) => ({ label: changeLabel(c), from: shownValue(c.field, c.from), to: shownValue(c.field, c.to) }));
}

// ─── The lead as it is ───────────────────────────────────────────────────────

const dayOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");

/**
 * A lead this person may open: what it really holds, and which of its words they see only in part. Null when it isn't
 * there or isn't theirs to open — `getLead` answers both the same.
 */
export async function leadNow(leadId: string) {
  if (!(await isModuleEnabled("leads"))) return null;
  const shown = await getLead(leadId);
  if (!shown) return null;
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    select: {
      id: true,
      leadSeq: true,
      title: true,
      description: true,
      status: true,
      estimatedValue: true,
      expectedCloseDate: true,
      contactId: true,
      company: { select: { name: true } },
      requirements: { orderBy: { createdAt: "asc" }, select: { id: true, quantity: true, notes: true, renewalDate: true, item: { select: { name: true } } } },
    },
  });
  if (!lead) return null;
  return {
    id: lead.id,
    leadSeq: lead.leadSeq,
    companyName: lead.company.name,
    won: lead.status === "WON",
    title: lead.title,
    description: lead.description ?? "",
    estimatedValue: lead.estimatedValue === null ? null : Number(lead.estimatedValue),
    expectedCloseDate: dayOf(lead.expectedCloseDate),
    contactId: lead.contactId ?? "",
    requirements: lead.requirements.map((r) => ({ id: r.id, product: r.item.name, quantity: r.quantity, notes: r.notes ?? "", renewalDate: dayOf(r.renewalDate) })),
    /** Masked, restricted, or with a masked value inside it ("call ********"): not seen whole, so not theirs to replace. */
    hidden: {
      title: shown.masking.concealed.includes("title") || shown.title !== lead.title,
      description: shown.masking.concealed.includes("description") || (shown.description ?? "") !== (lead.description ?? ""),
    },
  };
}
export type LeadNow = NonNullable<Awaited<ReturnType<typeof leadNow>>>;

/** What the lead holds now in a change's field; undefined when its line of products is gone. */
function heldIn(lead: LeadNow, c: LeadChange): string | number | null | undefined {
  if (c.field === "quantity") return lead.requirements.find((r) => r.id === c.requirementId)?.quantity;
  if (c.field === "expectedCloseDate" || c.field === "description") return lead[c.field] || null;
  return lead[c.field];
}

/** The first change whose field no longer holds what the card showed. */
export function changedSince(lead: LeadNow, changes: LeadChange[]): LeadChange | null {
  return changes.find((c) => heldIn(lead, c) !== c.from) ?? null;
}

/** The first change to words this person doesn't see whole. */
export function hiddenChange(lead: LeadNow, changes: LeadChange[]): LeadChange | null {
  return changes.find((c) => (c.field === "title" || c.field === "description") && lead.hidden[c.field]) ?? null;
}

/** Whether this person may change the quantities of a lead's products, as its page offers it. */
export async function mayChangeProducts(userId: string): Promise<boolean> {
  return (await isModuleEnabled("items")) && (await hasEffectivePermission(userId, "products.edit"));
}

// ─── Drafting one ────────────────────────────────────────────────────────────

export type LeadUpdateInput = {
  leadRef: string;
  quantity?: number;
  quantityNow?: number;
  product?: string;
  title?: string;
  description?: string;
  estimatedValue?: number;
  expectedCloseDate?: string;
};

type Draft = { payload: LeadUpdatePayload; summary: string } | { error: string; products?: { product: string; quantity: number }[] };

/** A placeholder the model made up or misremembered (src/lib/ai/mask.ts gives the real ones their values back first). */
const LEFT_MASKED = /\b(?:COMPANY|PERSON|ADDRESS|EMAIL|PHONE|GSTIN|PAN|AADHAAR|IFSC|ACCOUNT|CARD)_[A-Z2-7]{5,10}\b/;

/** LEAD-000123, and nothing looser: a bare "50" is a quantity as often as a lead, and ORD-000050 is another record. */
export function leadSeqOf(ref: string): number | null {
  const match = /^LEAD[-\s]*0*(\d{1,9})$/i.exec(ref.trim());
  return match ? Number(match[1]) : null;
}

/** A name's words, without a plural's s: "laptops" finds "Dell Laptop". */
const wordsOf = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => (w.length > 3 ? w.replace(/s$/, "") : w));

/** The lines a product's name fits: the one called exactly that, or else every one with all its words. */
function linesNamed(lines: LeadNow["requirements"], product: string): LeadNow["requirements"] {
  const wanted = wordsOf(product);
  const exact = lines.filter((r) => wordsOf(r.product).join(" ") === wanted.join(" "));
  return exact.length ? exact : lines.filter((r) => wanted.length > 0 && wanted.every((w) => wordsOf(r.product).includes(w)));
}

/** The change as it would be saved, or why there can be none — in words the model passes on. Nothing is written. */
export async function draftLeadUpdate(userId: string, input: LeadUpdateInput): Promise<Draft> {
  const seq = leadSeqOf(input.leadRef);
  if (seq === null) return { error: "Give one lead's LEAD- reference, from list_leads or the user. If several leads could be meant, list them and ask which." };
  const ref = formatLeadId(seq);
  const found = await db.lead.findUnique({ where: { leadSeq: seq }, select: { id: true } });
  const lead = found ? await leadNow(found.id) : null;
  if (!lead) return { error: `No lead ${ref} that this person can see. Use list_leads to find it, and ask which if several fit.` };
  if (!(await mayAccess(userId, "leads", "edit", lead.id))) return { error: `This person can see ${ref} but can't change it.` };

  const asked: LeadChange[] = [];
  if (input.title !== undefined) asked.push({ field: "title", from: lead.title, to: input.title });
  if (input.description !== undefined) asked.push({ field: "description", from: lead.description || null, to: input.description });
  if (input.estimatedValue !== undefined) asked.push({ field: "estimatedValue", from: lead.estimatedValue, to: Math.round(input.estimatedValue * 100) / 100 });
  if (input.expectedCloseDate !== undefined) asked.push({ field: "expectedCloseDate", from: lead.expectedCloseDate || null, to: input.expectedCloseDate });

  if (input.quantity !== undefined) {
    if (!(await mayChangeProducts(userId))) {
      return { error: "This person can't change the products on a lead — their role doesn't have the Edit products & subscriptions permission, or Items is switched off here. Tell them to ask their admin." };
    }
    const list = lead.requirements.map((r) => ({ product: r.product, quantity: r.quantity }));
    if (!list.length) return { error: `${ref} has no products on it, so there is no quantity to change. If the number is in its title, ask the user whether to change the title instead.` };
    const named = input.product ? linesNamed(lead.requirements, input.product) : lead.requirements;
    const fits = input.quantityNow === undefined ? named : named.filter((r) => r.quantity === input.quantityNow);
    if (fits.length !== 1) {
      const why = !named.length ? `No product on ${ref} is called that.` : !fits.length ? `No such product on ${ref} has a quantity of ${input.quantityNow}.` : `${fits.length} products on ${ref} fit.`;
      return { error: `${why} Nothing was drafted. List these to the user and ask which one — never choose for them.`, products: list };
    }
    asked.push({ field: "quantity", from: fits[0]!.quantity, to: input.quantity, requirementId: fits[0]!.id, product: fits[0]!.product });
  }
  if (!asked.length) return { error: "Say what to change: quantity, title, description, estimatedValue or expectedCloseDate." };
  if (asked.some((c) => typeof c.to === "string" && LEFT_MASKED.test(c.to))) {
    return { error: "The new text has a placeholder in it that stands for nothing. Use placeholders exactly as they were given, or ask the user for the words." };
  }
  const hidden = hiddenChange(lead, asked);
  if (hidden) return { error: `This person doesn't see ${ref}'s ${LABELS[hidden.field].toLowerCase()} in full, so they can't change it.` };

  const changes = asked.filter((c) => c.to !== c.from);
  if (!changes.length) return { error: `${ref} already holds that — there is nothing to change. Tell the user.` };
  if (lead.won && changes.some((c) => c.field === "estimatedValue")) return { error: `${ref} is won, so its value is locked. It has to be reopened first, on its page.` };

  // The summary is read back to the model in later turns, so the lead is named as a list names it to this person.
  const named = maskLead(await listLeadMasker(userId), { title: lead.title, company: { name: lead.companyName } });
  return { payload: { leadId: lead.id, changes }, summary: `${ref} · ${named.title} — ${named.company.name}: ${changes.map((c) => LABELS[c.field].toLowerCase()).join(", ")}` };
}
