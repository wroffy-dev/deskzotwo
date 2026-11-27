import { z } from "zod";
import { tooLong } from "@/lib/validation/text";

export const createBrandSchema = z.object({
  name: z.string().trim().max(200, tooLong(200)).min(1, "Brand name is required"),
});

export const updateBrandSchema = z.object({
  id: z.string().max(100, tooLong(100)).min(1),
  name: z.string().trim().max(200, tooLong(200)).min(1, "Brand name is required"),
});

export const createProductFamilySchema = z.object({
  brandId: z.string().max(100, tooLong(100)).min(1, "Pick a brand"),
  name: z.string().trim().max(200, tooLong(200)).min(1, "Family name is required"),
});

export const updateProductFamilySchema = z.object({
  id: z.string().max(100, tooLong(100)).min(1),
  name: z.string().trim().max(200, tooLong(200)).min(1, "Family name is required"),
});
