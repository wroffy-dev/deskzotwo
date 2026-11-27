import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { indiaClock, type Clock } from "@/lib/time/zone";

/**
 * Deskzo AI's switches in this workspace — the copilot's, Automate drafting's — and how many credits one
 * person may use in a day. Since 17 Oct 2026 that is all a workspace sets: the models, where they run and
 * what they cost are Deskzo's (src/lib/ai), paid for from the workspace's credits (src/lib/ai/credits.ts).
 */

export type CopilotConfig = {
  enabled: boolean;
  draftingEnabled: boolean;
  /** Whole credits a person may use in a day, as it applies now; null: no cap of the workspace's own. */
  dailyCreditLimit: number | null;
};

/**
 * Security audit, 13 Nov 2026 (A5): a person's daily cap when the admin hasn't set one. Before this a
 * workspace that never opened the settings had no cap at all, so one person (or a stolen session) could
 * spend the month's credits in an afternoon. The admin can still raise it, lower it, or turn it off.
 *
 * Stored as `CopilotSettings.dailyCreditLimit`: null — not set, this default applies; NO_DAILY_CAP — the admin
 * chose no cap; anything else — that many credits. The column's check (20261117100000_deskzo_ai_credits) holds it
 * above 0, so "none" is kept as the old ceiling, 1,00,000, rather than a new column; a cap the admin types is held
 * below it (src/actions/copilot.ts). Everywhere outside this file, "none" is 0.
 */
export const DEFAULT_DAILY_CREDIT_LIMIT = 200;
export const NO_DAILY_CAP = 100_000;

/** The cap a stored value means: null — the default; NO_DAILY_CAP (or anything not above 0) — none; otherwise itself. */
export function effectiveDailyLimit(stored: number | null | undefined): number | null {
  if (stored === null || stored === undefined) return DEFAULT_DAILY_CREDIT_LIMIT;
  return stored <= 0 || stored >= NO_DAILY_CAP ? null : stored;
}

/** What to store for a cap as the screen says it: null — the default; 0 — none; otherwise itself. */
export function storedFor(cap: number | null): number | null {
  return cap === 0 ? NO_DAILY_CAP : cap;
}

/** The cap as the admin left it, for the settings screen: null — not set (the default), 0 — none, otherwise itself. */
export async function storedDailyLimit(): Promise<number | null> {
  try {
    const stored = (await db.copilotSettings.findUnique({ where: { id: "global" }, select: { dailyCreditLimit: true } }))?.dailyCreditLimit ?? null;
    return stored !== null && stored >= NO_DAILY_CAP ? 0 : stored;
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
    return null;
  }
}

/**
 * Set only by the check suites, so their turns run on a made-up configuration instead of rewriting the
 * real one under somebody who is using the copilot at the time.
 */
let testSettings: CopilotConfig | null = null;
export function setTestSettings(settings: CopilotConfig | null) {
  testSettings = settings;
}

/**
 * Today on a clock, as the calendar day a `@db.Date` column holds — the platform's daily snapshots (revenue,
 * usage) pass the console's (`consoleClock`). India's is only the default, for a caller with no clock to hand.
 */
export function usageDay(now = new Date(), clock: Clock = indiaClock): Date {
  return clock.calendarDate(now);
}

export async function copilotConfig(): Promise<CopilotConfig> {
  if (testSettings) return testSettings;
  try {
    const r = await db.copilotSettings.findUnique({ where: { id: "global" }, select: { enabled: true, draftingEnabled: true, dailyCreditLimit: true } });
    return { enabled: r?.enabled ?? false, draftingEnabled: r?.draftingEnabled ?? false, dailyCreditLimit: effectiveDailyLimit(r?.dailyCreditLimit) };
  } catch (err) {
    // Before 20261117100000_deskzo_ai_credits: drafting went with the copilot, and there was no cap in credits.
    if (!notMigratedYet(err)) throw err;
    const r = await db.copilotSettings.findUnique({ where: { id: "global" }, select: { enabled: true } });
    return { enabled: r?.enabled ?? false, draftingEnabled: r?.enabled ?? false, dailyCreditLimit: DEFAULT_DAILY_CREDIT_LIMIT };
  }
}
