import { z } from "zod";
import { tooLong } from "@/lib/validation/text";

export const addCompanyProductSchema = z.object({
  companyId: z.string().max(100, tooLong(100)).min(1),
  locationId: z.string().max(100, tooLong(100)).min(1, "Select a location"),
  itemId: z.string().max(100, tooLong(100)).min(1, "Select a product"),
  vendorId: z.string().max(100, tooLong(100)).min(1, "Select which vendor this was purchased from"),
  quantity: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? 1 : Number(v)),
    z.number().int().positive("Quantity must be at least 1"),
  ),
  poNumber: z.string().trim().max(200, tooLong(200)).optional().or(z.literal("")),
  startDate: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  endDate: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  notes: z.string().trim().max(20000, tooLong(20000)).optional().or(z.literal("")),
});

export type AddCompanyProductInput = z.infer<typeof addCompanyProductSchema>;

export const updateCompanyProductSchema = z.object({
  id: z.string().max(100, tooLong(100)).min(1),
  locationId: z.string().max(100, tooLong(100)).min(1, "Select a location"),
  quantity: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? 1 : Number(v)),
    z.number().int().positive("Quantity must be at least 1"),
  ),
  poNumber: z.string().trim().max(200, tooLong(200)).optional().or(z.literal("")),
  startDate: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  endDate: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  notes: z.string().trim().max(20000, tooLong(20000)).optional().or(z.literal("")),
});

export type UpdateCompanyProductInput = z.infer<typeof updateCompanyProductSchema>;

/**
 * An order past approval keeps its quantity and term (owner, 2 Nov 2026 — "why is he able to edit the order which is
 * live?"): what was approved, bought and billed doesn't change from the Edit pencil. Seats added mid-term and renewals
 * have their own steps; notes, the PO number and the location stay editable.
 */
export const TERMS_LOCKED_STATUSES: readonly string[] = ["APPROVED", "PROCESSING", "FULFILLED", "CANCELLED"];

export function termsLocked(orderStatus: string | null | undefined): boolean {
  return !!orderStatus && TERMS_LOCKED_STATUSES.includes(orderStatus);
}
