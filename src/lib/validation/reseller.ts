import { z } from "zod";
import { tooLong, tooMany } from "@/lib/validation/text";
import { resellerTierValues, resellerStatusValues } from "@/lib/reseller-onboarding";

const optionalMoney = z.preprocess(
  (v) => (v === "" || v === undefined || v === null ? undefined : Number(v)),
  z.number().nonnegative("Must be zero or more").optional(),
);

export const resellerProfileSchema = z.object({
  agreementSignedOn: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  agreementReference: z.string().trim().max(200, tooLong(200)).optional().or(z.literal("")),
  agreementApprovedByUserId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  creditLimit: optionalMoney,
  tier: z.enum(resellerTierValues).optional().or(z.literal("")),
  discountPercent: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : Number(v)),
    z.number().min(0).max(100, "Discount can't exceed 100%").optional(),
  ),
  notes: z.string().trim().max(20000, tooLong(20000)).optional().or(z.literal("")),
});

export type ResellerProfileInput = z.infer<typeof resellerProfileSchema>;

export const resellerItemPriceSchema = z.object({
  itemId: z.string().max(100, tooLong(100)).min(1, "Pick a product"),
  price: z.preprocess(
    (v) => (v === "" || v === undefined ? undefined : Number(v)),
    z.number().positive("Price must be greater than 0"),
  ),
  notes: z.string().trim().max(20000, tooLong(20000)).optional().or(z.literal("")),
});

export type ResellerItemPriceInput = z.infer<typeof resellerItemPriceSchema>;

export const bulkUpdateResellersSchema = z.object({
  companyIds: z.array(z.string().max(100, tooLong(100)).min(1)).min(1, "Select at least one reseller").max(1000, tooMany(1000)),
  status: z.enum(resellerStatusValues).optional().or(z.literal("")),
  tier: z.enum(resellerTierValues).optional().or(z.literal("")),
});
