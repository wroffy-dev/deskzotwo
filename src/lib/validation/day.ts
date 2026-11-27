import { z } from "zod";

/**
 * A day something happened — money received or paid, an expense spent (security audit, 11 Nov 2026 — SEC-67, SEC-68).
 *
 * These were any string: a payment dated 1 January 1900 was accepted on a 2026 invoice and posted into a financial
 * year "1899-00", and a far-future date would sit in a year nobody has reached. A day here is `yyyy-mm-dd`, no earlier
 * than 2000 and no later than tomorrow — a day's slack, so a payment typed just after midnight in a time zone ahead of
 * the server's isn't refused. Whether it falls in an open period is still the books lock's to say
 * (src/lib/ledger/books-lock.ts).
 */
export const EARLIEST_DAY = "2000-01-01";

export function happenedOnProblem(value: string, now: Date = new Date()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Pick a date.";
  const day = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value) return "That isn't a real date.";
  if (value < EARLIEST_DAY) return "That date is too far in the past.";
  const tomorrow = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  if (value > tomorrow) return "That date hasn't happened yet.";
  return null;
}

/** A schema for such a day, with the message the form shows when it's missing. */
export const happenedOn = (missing: string) =>
  z
    .string()
    .trim()
    .min(1, missing)
    .superRefine((value, ctx) => {
      const problem = happenedOnProblem(value);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    });

/** An amount of money a person types: more than zero, at most a hundred crore, and no more than two decimals. */
export const MAX_AMOUNT = 1_000_000_000;
export const typedAmount = (message: string) =>
  z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? undefined : Number(v)),
    z
      .number()
      .positive(message)
      .max(MAX_AMOUNT, "That amount is too large.")
      .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, "Use at most two decimal places."),
  );
