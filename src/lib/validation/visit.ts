import { z } from "zod";
import { tooLong } from "@/lib/validation/text";
import { visitPurposeValues, visitStatusValues } from "@/lib/visits";

export const createVisitSchema = z.object({
  companyId: z.string().max(100, tooLong(100)).min(1, "Select a company"),
  contactId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  leadId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  locationId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  purpose: z.enum(visitPurposeValues).default("INTRO_MEETING"),
  agenda: z.string().trim().max(5000, tooLong(5000)).optional().or(z.literal("")),
  scheduledFor: z.string().max(100, tooLong(100)).min(1, "Pick a date and time"),
  address: z.string().trim().max(5000, tooLong(5000)).optional().or(z.literal("")),
  /** Planned round-trip distance; the mileage claim is raised separately as an expense. */
  distanceKm: z
    .preprocess((v) => (v === "" || v === undefined || v === null ? undefined : Number(v)), z.number().min(0).optional()),
  /** Blank means "me" — a manager can plan a visit for someone in their team. */
  userId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
});

export type CreateVisitInput = z.infer<typeof createVisitSchema>;

export const updateVisitSchema = createVisitSchema.extend({
  id: z.string().max(100, tooLong(100)).min(1),
});

export const completeVisitSchema = z.object({
  id: z.string().max(100, tooLong(100)).min(1),
  outcome: z.string().trim().max(5000, tooLong(5000)).min(1, "Write up what came of the visit"),
  /** Left blank when someone forgot to check in or out on the day. */
  checkInAt: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  checkOutAt: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  distanceKm: z
    .preprocess((v) => (v === "" || v === undefined || v === null ? undefined : Number(v)), z.number().min(0).optional()),
});

export const setVisitStatusSchema = z.object({
  id: z.string().max(100, tooLong(100)).min(1),
  status: z.enum(visitStatusValues),
  /** Required when cancelling or marking a no-show, so the log says why. */
  note: z.string().trim().max(20000, tooLong(20000)).optional().or(z.literal("")),
});
