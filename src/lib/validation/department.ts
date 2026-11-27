import { z } from "zod";
import { tooLong } from "@/lib/validation/text";

export const createDepartmentSchema = z.object({
  name: z.string().trim().max(200, tooLong(200)).min(2, "Name is required"),
});

export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;

export const updateDepartmentSchema = z.object({
  id: z.string().max(100, tooLong(100)).min(1),
  name: z.string().trim().max(200, tooLong(200)).min(2, "Name is required"),
});

export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>;
