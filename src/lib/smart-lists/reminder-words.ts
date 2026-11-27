/**
 * Who a Smart List's Date column can remind, in words (owner, 20 Nov 2026 — Smart Lists phase 2). Pure and client-safe:
 * the column dialog offers these, src/lib/smart-lists/reminders.ts sends them.
 */

export const NOTIFY_WHO = ["PERSON", "ADDER", "BUILDER", "ACCOUNT_OWNER"] as const;
export type NotifyWho = (typeof NOTIFY_WHO)[number];
export const NOTIFY_LABELS: Record<NotifyWho, string> = {
  PERSON: "The person in a Person column",
  ADDER: "Whoever added the row",
  BUILDER: "The list's builder",
  ACCOUNT_OWNER: "The company's account owner",
};
export const MAX_DAYS_BEFORE = 365;

/** "in 3 days", "tomorrow", "today". */
export function whenWords(day: string, today: string): string {
  const days = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
}
