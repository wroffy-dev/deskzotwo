"use client";

import { useState } from "react";
import { Check, ExternalLink, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * "What you pay today" beside Deskzo One — the comparison pages' calculator (owner, 26 Oct 2026). The visitor
 * ticks the tools they use, sets how many people, and may type over any price with what they really pay; the
 * totals follow. Deskzo One's price is the live plan's, read by the block (stack-savings.tsx).
 *
 * Fair by construction: list prices before GST from each vendor's own page, each with its source and the day it
 * was read; every one changeable; and where Deskzo One comes out dearer, it says so rather than hiding it.
 */

export type StackTool = {
  name: string;
  replaces: string;
  /** Rupees a month billed monthly, and billed yearly; 0: not listed in rupees — the visitor types theirs. */
  price: number;
  priceYearly: number | null;
  per: "user" | "org";
  /** A company price: the people it includes, and each person past them. */
  included: number | null;
  extra: number | null;
  extraYearly: number | null;
  basis: string | null;
  source: { href: string; name: string } | null;
  selected: boolean;
  logoUrl: string | null;
};

/** One tool's cost a month for this many people — the visitor's own price, when they typed one, either way. */
export function toolMonth(t: StackTool, people: number, yearly: boolean, own: number | null): number {
  const unit = own ?? (yearly ? (t.priceYearly ?? t.price) : t.price);
  if (t.per === "user") return unit * people;
  const extra = yearly ? (t.extraYearly ?? t.extra ?? 0) : (t.extra ?? 0);
  return unit + (t.included === null ? 0 : Math.max(0, people - t.included) * extra);
}

export type StackSavingsData = {
  heading: string;
  eyebrow: string | null;
  intro: string | null;
  anchor: string | undefined;
  siteName: string;
  /** "Deskzo One", as the product list names it. */
  suiteName: string;
  people: number;
  asOf: string;
  disclaimer: string;
  tools: StackTool[];
  /** Deskzo One for each person, in rupees: a month billed monthly, and a year billed yearly — null where not on sale. */
  suite: { month: number | null; year: number | null };
  signup: { href: string; label: string };
  pricingHref: string;
};

const rupees = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

export function StackSavingsView({ data }: { data: StackSavingsData }) {
  const [interval, setInterval] = useState<"MONTH" | "YEAR">("MONTH");
  const [people, setPeople] = useState(data.people);
  const [picked, setPicked] = useState<boolean[]>(() => data.tools.map((t) => t.selected));
  // What the visitor typed over a price — null: the list price, monthly or yearly as the switch says.
  const [own, setOwn] = useState<(number | null)[]>(() => data.tools.map(() => null));

  const months = interval === "YEAR" ? 12 : 1;
  const yearly = interval === "YEAR";
  const chosen = data.tools.map((t, i) => ({ ...t, i, on: !!picked[i] })).filter((t) => t.on);
  const toolsTotal = chosen.reduce((sum, t) => sum + toolMonth(t, people, yearly, own[t.i] ?? null), 0) * months;
  // A tool chosen with no price — not listed in rupees, and none typed — is left out of the total, and said.
  const unpriced = chosen.filter((t) => (own[t.i] ?? (yearly ? (t.priceYearly ?? t.price) : t.price)) === 0);
  const perSeat = interval === "YEAR" ? data.suite.year : data.suite.month;
  const suiteTotal = perSeat === null ? null : perSeat * people;
  const saving = suiteTotal === null ? null : toolsTotal - suiteTotal;
  const per = interval === "YEAR" ? "year" : "month";
  // A year is ten months' price (src/lib/billing): what that is worth, said once.
  const yearlyOff = data.suite.month && data.suite.year ? Math.round((1 - data.suite.year / (data.suite.month * 12)) * 100) : null;
  const areas = [...new Set(chosen.map((t) => t.replaces))];

  return (
    <div className="mt-10">
      <div className="mb-6 flex flex-wrap items-center justify-center gap-4">
        <div role="radiogroup" aria-label="Billing" className="inline-flex rounded-full border border-line bg-surface p-1 text-sm">
          {(["MONTH", "YEAR"] as const).map((i) => (
            <button
              key={i}
              type="button"
              role="radio"
              aria-checked={interval === i}
              onClick={() => setInterval(i)}
              className={cn("rounded-full px-4 py-1.5 font-medium", interval === i ? "bg-text text-surface" : "text-muted hover:text-text")}
            >
              {i === "MONTH" ? "Monthly" : "Yearly"}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-muted">
          People in your company
          <input
            type="number"
            min={1}
            max={10000}
            value={people}
            onChange={(e) => setPeople(Math.max(1, Math.min(10000, Math.round(Number(e.target.value) || 1))))}
            className="w-24 rounded-lg border border-line bg-surface px-3 py-1.5 text-text tabular-nums"
          />
        </label>
        {yearlyOff !== null && yearlyOff > 0 && <span className="text-xs text-muted">Yearly: {yearlyOff}% off {data.suiteName}</span>}
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[1fr_auto_1fr]">
        {/* What they pay today. */}
        <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-danger/30 bg-danger-bg px-3 py-1 text-xs font-semibold uppercase tracking-wide text-danger">
              <TriangleAlert aria-hidden="true" className="h-3.5 w-3.5" />
              What you pay today
            </span>
            <span className="text-xs font-medium uppercase tracking-wide text-subtle">{chosen.length} tools</span>
          </div>
          <p className="mt-4 text-sm font-medium text-text">Which tools do you use?</p>
          <ul className="mt-3 divide-y divide-line">
            {data.tools.map((t, i) => {
              const on = !!picked[i];
              return (
                <li key={`${t.name}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    aria-label={`${t.name} — ${t.replaces}`}
                    onClick={() => setPicked((p) => p.map((v, j) => (j === i ? !v : v)))}
                    className={cn("relative grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-xl border text-xs font-semibold", on ? "border-success bg-success-bg text-text" : "border-line bg-surface-sunken text-subtle")}
                  >
                    {t.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={t.logoUrl} alt="" className={cn("h-6 w-6 object-contain", !on && "opacity-40 grayscale")} />
                    ) : (
                      initials(t.name)
                    )}
                    {on && (
                      <span className="absolute -right-0.5 -top-0.5 grid h-4 w-4 place-items-center rounded-full bg-text text-surface">
                        <Check aria-hidden="true" className="h-3 w-3" />
                      </span>
                    )}
                  </button>
                  <span className={cn("min-w-0 flex-1 basis-48", !on && "opacity-60")}>
                    <span className="block text-sm font-medium text-text">{t.name}</span>
                    <span className="block text-xs text-muted">
                      {t.replaces}
                      {t.basis ? ` · ${t.basis}` : ""}
                      {t.per === "org" && t.included !== null ? ` · ${t.included} people included${t.extra ? `, then ₹${(yearly ? (t.extraYearly ?? t.extra) : t.extra).toLocaleString("en-IN")} each` : ""}` : ""}
                      {t.source && (
                        <>
                          {" · "}
                          <a href={t.source.href} rel="nofollow noopener noreferrer" target="_blank" className="inline-flex items-center gap-0.5 underline decoration-line-strong underline-offset-2 hover:text-text">
                            {t.source.name}
                            <ExternalLink aria-hidden="true" className="h-3 w-3" />
                          </a>
                        </>
                      )}
                    </span>
                  </span>
                  <label className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted">
                    <span className="sr-only">{t.name}: rupees a month {t.per === "user" ? "for each person" : "for the company"}</span>₹
                    <input
                      type="number"
                      min={0}
                      value={own[i] ?? ((yearly ? (t.priceYearly ?? t.price) : t.price) || "")}
                      placeholder="Your price"
                      disabled={!on}
                      onChange={(e) => setOwn((p) => p.map((v, j) => (j === i ? (e.target.value === "" ? null : Math.max(0, Number(e.target.value) || 0)) : v)))}
                      className="w-20 rounded-md border border-line bg-surface px-2 py-1 text-right text-sm text-text tabular-nums disabled:opacity-50"
                    />
                    <span className="w-16">{t.per === "user" ? "/person/mo" : "/mo"}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="mt-4 rounded-xl border border-danger/20 bg-danger-bg/40 p-4">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-text">Total</p>
                <p className="text-xs text-muted">
                  {chosen.length} separate login{chosen.length === 1 ? "" : "s"} · {chosen.length} bill{chosen.length === 1 ? "" : "s"} to track
                </p>
              </div>
              <p className="text-2xl font-bold tabular-nums text-danger">
                {rupees(toolsTotal)}
                <span className="text-sm font-medium text-muted">/{per}</span>
              </p>
            </div>
            {unpriced.length > 0 && (
              <p className="mt-2 text-xs text-muted">
                Not counted until you type its price: {unpriced.map((t) => t.name).join(", ")}.
              </p>
            )}
          </div>
        </div>

        <div className="hidden self-center lg:grid">
          <span className="grid h-10 w-10 place-items-center rounded-full bg-brand text-xs font-bold text-brand-contrast">VS</span>
        </div>

        {/* Deskzo One. */}
        <div className="rounded-2xl border-2 border-brand/40 bg-surface p-5 shadow-sm">
          <p className="text-lg font-semibold text-text">{data.suiteName}</p>
          {perSeat === null ? (
            <p className="mt-2 text-sm text-muted">
              See the price on{" "}
              <a href={data.pricingHref} className="underline">
                the pricing page
              </a>
              .
            </p>
          ) : (
            <>
              <p className="mt-2 text-3xl font-bold tabular-nums text-text">
                {rupees(perSeat)}
                <span className="text-sm font-medium text-muted"> a person/{per}</span>
              </p>
              <p className="text-xs text-muted">{interval === "YEAR" ? "Billed yearly" : "Billed monthly"} · before GST</p>
              <div className="mt-4 rounded-xl bg-surface-sunken p-4">
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-text">
                      For {people.toLocaleString("en-IN")} {people === 1 ? "person" : "people"}
                    </p>
                    <p className="text-xs text-muted">One login · one bill</p>
                  </div>
                  <p className="text-2xl font-bold tabular-nums text-text">
                    {rupees(suiteTotal!)}
                    <span className="text-sm font-medium text-muted">/{per}</span>
                  </p>
                </div>
              </div>
              {saving !== null && chosen.length > 0 && (
                <p className={cn("mt-4 rounded-xl px-4 py-3 text-sm font-semibold", saving > 0 ? "bg-success-bg text-success" : "bg-surface-sunken text-text")} aria-live="polite">
                  {saving > 0
                    ? `You'd save ${rupees(saving)} a ${per} — ${Math.round((saving / toolsTotal) * 100)}% less`
                    : `${data.suiteName} costs ${rupees(-saving)} more a ${per} here — for everything below, not just ${chosen.length === 1 ? "this tool" : "these tools"}`}
                </p>
              )}
            </>
          )}
          <ul className="mt-5 space-y-2 text-sm text-text">
            {(areas.length ? areas : data.tools.map((t) => t.replaces).filter((v, i, a) => a.indexOf(v) === i)).map((a) => (
              <li key={a} className="flex items-center gap-2">
                <Check aria-hidden="true" className="h-4 w-4 text-success" />
                {a}
              </li>
            ))}
            <li className="flex items-center gap-2 text-muted">
              <Check aria-hidden="true" className="h-4 w-4 text-success" />
              …and every other {data.siteName} product, on one set of records
            </li>
          </ul>
          <a href={data.signup.href} className="mt-6 inline-flex w-full items-center justify-center rounded-xl bg-text px-4 py-3 text-sm font-semibold text-surface hover:opacity-90">
            {data.signup.label}
          </a>
        </div>
      </div>

      <p className="mx-auto mt-6 max-w-3xl text-center text-xs leading-5 text-subtle">
        Prices of other tools are their list prices before GST, from each vendor&apos;s own website as of {data.asOf} — change any of them to what you pay. {data.disclaimer}
      </p>
    </div>
  );
}
