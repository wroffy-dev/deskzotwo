/**
 * Loyalty tiers (owner, 31 Oct 2026): what a customer's history with us says about them, worked out from its cached
 * figures (CustomerStats, src/lib/customers/stats.ts). Pure, so check:customer-loyalty pins every rule. The numbers are
 * the workspace's own, from Settings › Customer loyalty (LoyaltySettings); these are the defaults.
 *
 * Asked in this order, the first that fits wins — a customer who started last month is New even if they bought a lot:
 *
 *   · NEW       first order within the last 90 days.
 *   · CHAMPION  a customer 3+ years, renewing 90%+ (or nothing due for renewal yet), bought in the last 6 months, and in
 *               the top 10% of customers by lifetime value.
 *   · LOYAL     a customer 2+ years, renewing 75%+, bought in the last 12 months.
 *   · GROWING   a customer under 2 years whose last 12 months beat the 12 before.
 *   · AT_RISK   bought before but nothing for 6–12 months, or a renewal lost in the last 90 days.
 *   · LAPSED    nothing for 12+ months and no subscription running.
 *   · otherwise none — just a customer.
 */

export const LOYALTY_TIERS = ["NEW", "CHAMPION", "LOYAL", "GROWING", "AT_RISK", "LAPSED"] as const;
export type LoyaltyTier = (typeof LOYALTY_TIERS)[number];

export const TIER_LABEL: Record<LoyaltyTier, string> = {
  NEW: "New",
  CHAMPION: "Champion",
  LOYAL: "Loyal",
  GROWING: "Growing",
  AT_RISK: "At risk",
  LAPSED: "Lapsed",
};

/** The badge's tone, as the app's Badge takes it. */
export const TIER_TONE: Record<LoyaltyTier, "default" | "green" | "blue" | "red" | "amber" | "brand"> = {
  NEW: "blue",
  CHAMPION: "brand",
  LOYAL: "green",
  GROWING: "blue",
  AT_RISK: "amber",
  LAPSED: "red",
};

export const isLoyaltyTier = (v: unknown): v is LoyaltyTier => typeof v === "string" && (LOYALTY_TIERS as readonly string[]).includes(v);

export type LoyaltyRules = {
  newWithinDays: number;
  championYears: number;
  /** Percent, 0–100. */
  championRenewalRate: number;
  championBoughtMonths: number;
  /** The top this percent of customers by lifetime value. */
  championTopPercent: number;
  loyalYears: number;
  loyalRenewalRate: number;
  loyalBoughtMonths: number;
  growingUnderYears: number;
  /** Nothing bought for this many months (and fewer than `lapsedAfterMonths`): at risk. */
  atRiskFromMonths: number;
  /** A renewal marked Lost that ended within this many days: at risk. */
  atRiskLostDays: number;
  lapsedAfterMonths: number;
};

export const DEFAULT_LOYALTY_RULES: LoyaltyRules = {
  newWithinDays: 90,
  championYears: 3,
  championRenewalRate: 90,
  championBoughtMonths: 6,
  championTopPercent: 10,
  loyalYears: 2,
  loyalRenewalRate: 75,
  loyalBoughtMonths: 12,
  growingUnderYears: 2,
  atRiskFromMonths: 6,
  atRiskLostDays: 90,
  lapsedAfterMonths: 12,
};

/** Each rule number's bounds, for the settings screen and its action. */
export const RULE_BOUNDS: Record<keyof LoyaltyRules, { min: number; max: number }> = {
  newWithinDays: { min: 1, max: 730 },
  championYears: { min: 0, max: 50 },
  championRenewalRate: { min: 0, max: 100 },
  championBoughtMonths: { min: 1, max: 120 },
  championTopPercent: { min: 1, max: 100 },
  loyalYears: { min: 0, max: 50 },
  loyalRenewalRate: { min: 0, max: 100 },
  loyalBoughtMonths: { min: 1, max: 120 },
  growingUnderYears: { min: 1, max: 50 },
  atRiskFromMonths: { min: 1, max: 120 },
  atRiskLostDays: { min: 1, max: 730 },
  lapsedAfterMonths: { min: 1, max: 240 },
};

/** Each rule number as the settings screen names it — for a refusal that says which one, in words. */
export const RULE_LABELS: Record<keyof LoyaltyRules, string> = {
  newWithinDays: "New: first order within (days)",
  championYears: "Champion: customer for at least (years)",
  championRenewalRate: "Champion: renewal rate at least (%)",
  championBoughtMonths: "Champion: bought within (months)",
  championTopPercent: "Champion: top (%) by lifetime value",
  loyalYears: "Loyal: customer for at least (years)",
  loyalRenewalRate: "Loyal: renewal rate at least (%)",
  loyalBoughtMonths: "Loyal: bought within (months)",
  growingUnderYears: "Growing: customer for under (years)",
  atRiskFromMonths: "At risk: nothing bought for (months)",
  atRiskLostDays: "At risk: lost a renewal within (days)",
  lapsedAfterMonths: "Lapsed: nothing bought for (months)",
};

/** The figures a tier is read from — a CustomerStats row's, as numbers. */
export type TierFacts = {
  firstOrderAt: Date | null;
  lastPurchaseAt: Date | null;
  lifetimeValue: number;
  last12Value: number;
  prev12Value: number;
  liveSubscriptions: number;
  renewalsDue: number;
  renewalsRenewed: number;
  renewalsLostRecently: number;
};

const DAY = 86_400_000;
// A month and a year as a calendar averages them: "6 months" is 182.6 days, "3 years" 1,095.75 — near enough for a tier.
const MONTH = 30.4375 * DAY;
const YEAR = 365.25 * DAY;

/** Renewals renewed of those due, 0–1; null when none has come due yet. */
export function renewalRate(f: Pick<TierFacts, "renewalsDue" | "renewalsRenewed">): number | null {
  return f.renewalsDue > 0 ? f.renewalsRenewed / f.renewalsDue : null;
}

/**
 * The lifetime value a customer must reach to be in the top `percent`: the value at that rank, over every customer's.
 * Infinity when there are none, so nobody is a Champion by default.
 */
export function topValueThreshold(values: number[], percent: number): number {
  const positive = values.filter((v) => v > 0).sort((a, b) => b - a);
  if (positive.length === 0) return Infinity;
  const take = Math.max(1, Math.ceil((positive.length * percent) / 100));
  return positive[Math.min(take, positive.length) - 1];
}

/** The tier a customer's figures earn, as of `now`; null for none. `topValue`: `topValueThreshold` over every customer. */
export function loyaltyTier(f: TierFacts, rules: LoyaltyRules, now: Date, topValue: number): LoyaltyTier | null {
  const t = now.getTime();
  const since = f.firstOrderAt ? t - f.firstOrderAt.getTime() : null;
  const quiet = f.lastPurchaseAt ? t - f.lastPurchaseAt.getTime() : null;
  if (since === null) return null;
  const rate = renewalRate(f);
  const boughtWithin = (months: number) => quiet !== null && quiet <= months * MONTH;

  if (since <= rules.newWithinDays * DAY) return "NEW";
  if (
    since >= rules.championYears * YEAR &&
    (rate === null || rate * 100 >= rules.championRenewalRate) &&
    boughtWithin(rules.championBoughtMonths) &&
    f.lifetimeValue > 0 &&
    f.lifetimeValue >= topValue
  )
    return "CHAMPION";
  if (since >= rules.loyalYears * YEAR && (rate === null || rate * 100 >= rules.loyalRenewalRate) && boughtWithin(rules.loyalBoughtMonths)) return "LOYAL";
  if (since < rules.growingUnderYears * YEAR && f.last12Value > f.prev12Value) return "GROWING";
  const quietFor = quiet ?? Infinity;
  if ((quietFor > rules.atRiskFromMonths * MONTH && quietFor <= rules.lapsedAfterMonths * MONTH) || f.renewalsLostRecently > 0) return "AT_RISK";
  if (quietFor > rules.lapsedAfterMonths * MONTH && f.liveSubscriptions === 0) return "LAPSED";
  return null;
}

/** "7 yrs 7 mo", "5 mo", "3 weeks" — how long ago a day was, said as a list cell says it. */
export function spanSince(at: Date | string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(at).getTime();
  if (ms < 0) return "today";
  const days = Math.floor(ms / DAY);
  if (days < 14) return days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"}`;
  if (days < 61) return `${Math.floor(days / 7)} weeks`;
  const months = Math.floor(ms / MONTH);
  const years = Math.floor(months / 12);
  const rest = months % 12;
  if (years === 0) return `${months} mo`;
  return rest ? `${years} yr${years === 1 ? "" : "s"} ${rest} mo` : `${years} yr${years === 1 ? "" : "s"}`;
}
