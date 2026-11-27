import { z } from "zod";
import { tooLong } from "@/lib/validation/text";

export const createIndustrySchema = z.object({
  name: z.string().trim().max(200, tooLong(200)).min(2, "Name is required"),
});

export type CreateIndustryInput = z.infer<typeof createIndustrySchema>;

export const updateIndustrySchema = z.object({
  id: z.string().max(100, tooLong(100)).min(1),
  name: z.string().trim().max(200, tooLong(200)).min(2, "Name is required"),
});

export type UpdateIndustryInput = z.infer<typeof updateIndustrySchema>;
