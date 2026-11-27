import { z } from "zod";
import { tooLong } from "@/lib/validation/text";
import { gstTreatmentValues } from "@/lib/gst";
import { postalCodeField, refinePostalCode } from "@/lib/geo/postal";
import { workspacePack } from "@/lib/country-pack";
import { readTrn } from "@/lib/vat/rules";

/** In the UAE the field is the TRN (src/lib/vat/rules.ts): 15 digits, when given. India's GSTIN is checked where it is used. */
function refineTrn(value: { gstNumber?: string }, ctx: z.RefinementCtx) {
  if (workspacePack().country !== "AE") return;
  const trn = readTrn(value.gstNumber);
  if (!trn.ok) ctx.addIssue({ code: "custom", path: ["gstNumber"], message: trn.error });
}

export const companyLocationFieldsSchema = z.object({
  label: z.string().trim().max(200, tooLong(200)).min(1, "Location label is required").default("Head Office"),
  address: z.string().trim().max(5000, tooLong(5000)).optional().or(z.literal("")),
  city: z.string().trim().max(200, tooLong(200)).optional().or(z.literal("")),
  state: z.string().trim().max(200, tooLong(200)).optional().or(z.literal("")),
  country: z.string().trim().max(200, tooLong(200)).optional().or(z.literal("")),
  // Six digits in India, any postal code elsewhere — the rule is `refinePostalCode`, on the object.
  pincode: postalCodeField,
  gstNumber: z.string().trim().max(100, tooLong(100)).optional().or(z.literal("")),
  /** Marks this as the address invoices are billed to, and/or the one goods are sent to. */
  isBilling: z.boolean().default(false),
  isShipping: z.boolean().default(false),
  gstTreatment: z.enum(gstTreatmentValues).default("UNREGISTERED"),
}).superRefine(refinePostalCode).superRefine(refineTrn);

// Re-applied: spreading `.shape` copies the fields and leaves the object-level postal rule behind.
export const addCompanyLocationSchema = z
  .object({
    companyId: z.string().max(100, tooLong(100)).min(1),
    ...companyLocationFieldsSchema.shape,
  })
  .superRefine(refinePostalCode)
  .superRefine(refineTrn);

export const updateCompanyLocationSchema = z
  .object({
    id: z.string().max(100, tooLong(100)).min(1),
    ...companyLocationFieldsSchema.shape,
  })
  .superRefine(refinePostalCode)
  .superRefine(refineTrn);

export type AddCompanyLocationInput = z.infer<typeof addCompanyLocationSchema>;
export type UpdateCompanyLocationInput = z.infer<typeof updateCompanyLocationSchema>;
