import { z } from "zod";
import { tooLong, tooMany } from "@/lib/validation/text";
import { expenseCategoryValues, expensePaymentModeValues, expenseStatusValues } from "@/lib/expenses";
import { happenedOn, typedAmount } from "@/lib/validation/day";

const expenseFields = z.object({
  category: z.enum(expenseCategoryValues).default("TRAVEL"),
  amount: typedAmount("Amount must be greater than 0"),
  taxAmount: z
    .preprocess((v) => (v === "" || v === undefined || v === null ? undefined : Number(v)), z.number().min(0).optional()),
  spentOn: happenedOn("Pick the date it was spent"),
  description: z.string().trim().min(1, "Say what this was for").max(2000, "Keep it under 2,000 characters."),
  paymentMode: z.enum(expensePaymentModeValues).default("CASH"),
  reimbursable: z.boolean().default(true),
  visitId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  companyId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  leadId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  receiptDataUrl: z.string().max(1000000, tooLong(1000000)).optional().or(z.literal("")),
  receiptName: z.string().trim().max(200, tooLong(200)).optional().or(z.literal("")),
  /** Blank means the claim is the current user's; only an admin can raise one on someone's behalf. */
  userId: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
  /** Submit straight away rather than parking it in draft. */
  submit: z.boolean().default(false),
});

/** The tax in a bill is part of it (security audit SEC-68): ₹5,000 of tax on a ₹100 expense was claimable. */
const taxWithinAmount = (val: { amount: number; taxAmount?: number }, ctx: z.RefinementCtx) => {
  if ((val.taxAmount ?? 0) > val.amount) ctx.addIssue({ code: "custom", path: ["taxAmount"], message: "The tax can't be more than the amount." });
};

export const createExpenseSchema = expenseFields.superRefine(taxWithinAmount);

export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;

export const updateExpenseSchema = expenseFields
  .omit({ submit: true })
  .extend({ id: z.string().max(100, tooLong(100)).min(1) })
  .superRefine(taxWithinAmount);

export const decideExpenseSchema = z.object({
  id: z.string().max(100, tooLong(100)).min(1),
  approved: z.boolean(),
  /** A rejection has to say why — otherwise the claimant has nothing to act on. */
  note: z.string().trim().max(20000, tooLong(20000)).optional().or(z.literal("")),
});

export const reimburseExpenseSchema = z.object({
  expenseIds: z.array(z.string().max(100, tooLong(100)).min(1)).min(1, "Select at least one expense").max(1000, tooMany(1000)),
  reimbursementRef: z.string().trim().max(200, tooLong(200)).optional().or(z.literal("")),
  reimbursedOn: z.string().max(100, tooLong(100)).optional().or(z.literal("")),
});

export const expenseFilterSchema = z.object({
  status: z.enum(expenseStatusValues).optional(),
  category: z.enum(expenseCategoryValues).optional(),
  userId: z.string().max(100, tooLong(100)).optional(),
  companyId: z.string().max(100, tooLong(100)).optional(),
  reimbursable: z.enum(["yes", "no"]).optional(),
  from: z.string().max(100, tooLong(100)).optional(),
  to: z.string().max(100, tooLong(100)).optional(),
  search: z.string().max(500, tooLong(500)).optional(),
});
