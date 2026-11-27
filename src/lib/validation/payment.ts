import { z } from "zod";
import { tooLong } from "@/lib/validation/text";
import { paymentMethodValues } from "@/lib/gst";
import { happenedOn, typedAmount } from "@/lib/validation/day";

export const recordPaymentSchema = z.object({
  companyId: z.string().max(100, tooLong(100)).min(1, "Select a company"),
  amount: typedAmount("Amount must be greater than 0"),
  paidOn: happenedOn("Payment date is required"),
  method: z.enum(paymentMethodValues).default("BANK_TRANSFER"),
  reference: z.string().trim().max(200, tooLong(200)).optional().or(z.literal("")),
  notes: z.string().trim().max(20000, tooLong(20000)).optional().or(z.literal("")),
  allocateToOrderId: z.string().trim().max(100, tooLong(100)).optional().or(z.literal("")),
  /** The bank account it came into (owner, 20 Nov 2026 — recorded from a bank statement line, src/lib/bank-match). */
  bankAccountId: z.string().trim().max(100, tooLong(100)).optional().or(z.literal("")),
});

export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

export const allocatePaymentSchema = z.object({
  paymentId: z.string().max(100, tooLong(100)).min(1),
  companyProductId: z.string().max(100, tooLong(100)).min(1, "Select an order"),
  amount: z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : Number(v)),
    z.number().positive("Amount must be greater than 0"),
  ),
});

export type AllocatePaymentInput = z.infer<typeof allocatePaymentSchema>;

/** An advance received against a proforma invoice (owner, 17 Nov 2026 — src/actions/proforma-advance.ts). */
export const recordProformaAdvanceSchema = z.object({
  proformaId: z.string().max(100, tooLong(100)).min(1, "Which proforma?"),
  amount: typedAmount("Amount must be greater than 0"),
  paidOn: happenedOn("Payment date is required"),
  method: z.enum(paymentMethodValues).default("BANK_TRANSFER"),
  reference: z.string().trim().max(200, tooLong(200)).optional().or(z.literal("")),
  notes: z.string().trim().max(20000, tooLong(20000)).optional().or(z.literal("")),
});

export type RecordProformaAdvanceInput = z.infer<typeof recordProformaAdvanceSchema>;
