import { z } from "zod";
import { tooLong } from "@/lib/validation/text";
import { paymentMethodValues } from "@/lib/gst";
import { happenedOn, typedAmount } from "@/lib/validation/day";

export const recordInvoicePaymentSchema = z.object({
  invoiceId: z.string().max(100, tooLong(100)).min(1),
  amount: typedAmount("Enter an amount greater than 0"),
  paidOn: happenedOn("Pick the date it was received"),
  method: z.enum(paymentMethodValues).default("BANK_TRANSFER"),
  reference: z.string().trim().max(200, tooLong(200)).optional().or(z.literal("")),
  notes: z.string().trim().max(20000, tooLong(20000)).optional().or(z.literal("")),
  /**
   * "Rate on the day (₹ per USD)", for an invoice in another currency: what the money actually came in
   * at. Left out, it is the invoice's own rate. A rupee invoice ignores it — its rate is 1. Checked in
   * the action (posting.ts `settlementRateError`), which knows the invoice's currency.
   */
  exchangeRate: z.preprocess((v) => (v === "" || v === undefined || v === null ? undefined : Number(v)), z.number({ error: "Enter the rate as a number, such as 84.10." }).optional()),
  /** The bank account it came into (owner, 30 Oct 2026); left out, the default. A foreign one takes only its own currency. */
  bankAccountId: z.string().trim().max(100, tooLong(100)).optional().or(z.literal("")),
  /** Paid by another company in the invoice's customer group (src/lib/companies/groups.ts); left out, the customer itself. */
  paidByCompanyId: z.string().trim().max(100, tooLong(100)).optional().or(z.literal("")),
});

export const applyCreditNoteSchema = z.object({
  creditNoteId: z.string().max(100, tooLong(100)).min(1),
  invoiceId: z.string().max(100, tooLong(100)).min(1, "Pick the invoice to apply it to"),
  amount: typedAmount("Enter an amount greater than 0"),
});
