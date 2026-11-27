import type { SplashScope, TargetMetric } from "@prisma/client";
import type { MetricKey } from "@/lib/targets/metrics";
import { baseLocale, basePrefix } from "@/lib/currency";

/**
 * The words on a sales celebration — pure, so every one of them can be read in a test before anybody
 * reads it on a splash.
 *
 * Amounts are the whole figure — ₹12,50,000 — since 12 Nov 2026 (owner: "wins TV also in full numbers", as the
 * charts are), with paise only where there are some. They used to be said in lakh and crore ("₹12.5 lakh"), which is
 * where the function's name comes from; a win already celebrated keeps the words it was written with.
 */

export function inrSpoken(n: number): string {
  return `${n < 0 ? "-" : ""}${basePrefix()}${Math.abs(n).toLocaleString(baseLocale(), { maximumFractionDigits: 2 })}`;
}

export const METRIC_WORDS: Partial<Record<MetricKey, { noun: string; money: boolean }>> = {
  INVOICED_VALUE: { noun: "invoicing", money: true },
  COLLECTED_VALUE: { noun: "collections", money: true },
  ORDER_VALUE: { noun: "order value", money: true },
  ORDER_MARGIN: { noun: "margin", money: true },
  ADDON_VALUE: { noun: "add-on sales", money: true },
  LEADS_WON: { noun: "deals won", money: false },
  LEAD_VALUE_WON: { noun: "value won", money: true },
  NEW_CUSTOMERS: { noun: "new customers", money: false },
  PURCHASE_SAVINGS: { noun: "purchase savings", money: true },
};

export type WinCopy = { title: string; message: string };

export function dealWonCopy(input: { owner: string | null; company: string; deal: string; value: number }): WinCopy {
  return {
    title: `${inrSpoken(input.value)} won — ${input.company}`,
    message: `${input.owner ?? "The team"} closed “${input.deal}”.`,
  };
}

export function targetHitCopy(input: {
  who: string;
  metric: TargetMetric;
  periodLabel: string;
  achieved: number;
  target: number;
}): WinCopy {
  const words = METRIC_WORDS[input.metric] ?? { noun: input.metric.toLowerCase().replaceAll("_", " "), money: false };
  const pct = input.target > 0 ? Math.round((input.achieved / input.target) * 100) : 100;
  const fmt = (n: number) => (words.money ? inrSpoken(n) : String(Math.round(n)));
  return {
    title: `${input.who} hit the ${input.periodLabel} ${words.noun} target`,
    message: `${fmt(input.achieved)} against ${fmt(input.target)} — ${pct}%.`,
  };
}

export function firstOrderCopy(input: { owner: string | null; company: string; value: number }): WinCopy {
  return {
    title: `New customer: ${input.company}`,
    message: `${input.owner ?? "The team"} booked their first order${input.value > 0 ? ` — ${inrSpoken(input.value)}` : ""}. Welcome aboard.`,
  };
}

/** `prize` is what that place wins, when a prize is set for it — see src/lib/wins/prizes.ts. */
export function topPerformerCopy(input: { monthLabel: string; ranking: { name: string; value: number; prize?: string | null }[] }): WinCopy {
  const [first, ...rest] = input.ranking;
  const runnersUp = rest.map((r) => `${r.name} (${inrSpoken(r.value)}${r.prize ? `, ${r.prize}` : ""})`).join(", ");
  return {
    title: `Top performer, ${input.monthLabel}: ${first?.name ?? "—"}`,
    message: `${first ? `${inrSpoken(first.value)} booked${first.prize ? ` — wins ${first.prize}` : ""}.` : ""}${runnersUp ? ` Runners-up: ${runnersUp}.` : ""}`.trim(),
  };
}

/** Whether the person looking gets the full-screen splash, or the strip. */
export function splashes(scope: SplashScope, aboutViewer: boolean): boolean {
  return scope === "EVERYONE" || aboutViewer;
}
