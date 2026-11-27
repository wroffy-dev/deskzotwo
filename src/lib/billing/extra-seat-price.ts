/**
 * What more people cost for the rest of a paid period (src/lib/billing/extra-seats.ts). Pure, and safe in the browser: the
 * number on the screen is the number on the proforma, the payment page and the tax invoice.
 *
 * A year's price is 365 days and a month's is 30, so a person added with 100 days left costs 100/365 of the year's price,
 * which a customer can check with a calculator. A long month or a leap year doesn't cost more: 31 days is one month, not a
 * little over, because the share is never above the nearest whole number of periods.
 */

const GST_PERCENT = 18;
const DAY = 86_400_000;

export const EXTRA_SEATS_MAX = 500;

export type SeatInterval = "MONTH" | "YEAR";

/** Whole days from `today` up to `endsAt`, the first day not paid for. */
export function daysLeftIn(today: Date, endsAt: Date): number {
  return Math.max(0, Math.ceil((endsAt.getTime() - today.getTime()) / DAY));
}

export function extraSeatPrice(input: { unitPrice: number; interval: SeatInterval; daysLeft: number; quantity: number }): { perPerson: number; subtotal: number; gst: number; total: number } {
  const days = input.interval === "YEAR" ? 365 : 30;
  const exact = input.daysLeft / days;
  const share = exact >= 1 ? Math.min(exact, Math.round(exact)) : exact;
  const perPerson = Math.round(input.unitPrice * share);
  const subtotal = perPerson * input.quantity;
  const total = Math.round((subtotal * (100 + GST_PERCENT)) / 100);
  return { perPerson, subtotal, gst: total - subtotal, total };
}
