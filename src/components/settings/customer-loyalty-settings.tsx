"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { refreshCustomerStatsNow, saveLoyaltySettings, type LoyaltyView } from "@/actions/customer-loyalty";
import { DEFAULT_LOYALTY_RULES, RULE_BOUNDS, TIER_LABEL, TIER_TONE, type LoyaltyRules, type LoyaltyTier } from "@/lib/customers/loyalty-rules";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Settings › Customer loyalty (owner, 31 Oct 2026 — src/lib/customers/loyalty-rules.ts): each tier's rule, its numbers
 * editable, in the order the tiers are asked — the first that fits wins. Save refreshes every customer.
 */
export function CustomerLoyaltySettings({ view }: { view: LoyaltyView }) {
  const router = useRouter();
  const [values, setValues] = useState<Record<keyof LoyaltyRules, string>>(
    () => Object.fromEntries(Object.entries(view.rules).map(([k, v]) => [k, String(v)])) as Record<keyof LoyaltyRules, string>,
  );
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!view.migrated) return <p className="text-sm text-muted">This workspace is still being updated for loyalty tiers. Come back in a few minutes.</p>;

  const field = (key: keyof LoyaltyRules) => (
    <Input
      aria-label={key}
      type="number"
      min={RULE_BOUNDS[key].min}
      max={RULE_BOUNDS[key].max}
      value={values[key]}
      onChange={(e) => setValues({ ...values, [key]: e.target.value })}
      className="mx-1 inline-block h-8 w-20"
    />
  );
  const tier = (t: LoyaltyTier) => <Badge tone={TIER_TONE[t]}>{TIER_LABEL[t]}</Badge>;

  function save() {
    setError(null);
    setNotice(null);
    const rules = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Number(v)])) as LoyaltyRules;
    if (Object.values(rules).some((v) => !Number.isInteger(v))) return setError("Whole numbers only.");
    startTransition(async () => {
      const result = await saveLoyaltySettings(rules);
      if (!result.ok) return setError(result.error);
      setNotice(`Saved — ${result.data.customers.toLocaleString("en-IN")} customers given their tier again.`);
      router.refresh();
    });
  }

  function refresh() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await refreshCustomerStatsNow();
      if (!result.ok) return setError(result.error);
      setNotice(`Refreshed ${result.data.customers.toLocaleString("en-IN")} customers in ${(result.data.ms / 1000).toFixed(1)} s.`);
      router.refresh();
    });
  }

  const reset = () => setValues(Object.fromEntries(Object.entries(DEFAULT_LOYALTY_RULES).map(([k, v]) => [k, String(v)])) as Record<keyof LoyaltyRules, string>);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="text-sm font-medium text-text">The tiers, asked in this order — the first that fits</CardHeader>
        <CardContent className="space-y-3 text-sm text-muted">
          <p>
            {tier("NEW")} First order within the last {field("newWithinDays")} days.
          </p>
          <p>
            {tier("CHAMPION")} A customer for {field("championYears")} years or more, renewing at least {field("championRenewalRate")}% (or nothing due for
            renewal yet), bought in the last {field("championBoughtMonths")} months, and in the top {field("championTopPercent")}% of customers by lifetime value.
          </p>
          <p>
            {tier("LOYAL")} A customer for {field("loyalYears")} years or more, renewing at least {field("loyalRenewalRate")}% (or nothing due yet), bought in
            the last {field("loyalBoughtMonths")} months.
          </p>
          <p>
            {tier("GROWING")} A customer for under {field("growingUnderYears")} years whose last 12 months came to more than the 12 before.
          </p>
          <p>
            {tier("AT_RISK")} Bought before but nothing for {field("atRiskFromMonths")} months (up to when Lapsed starts), or a renewal marked Lost that ended in the last{" "}
            {field("atRiskLostDays")} days.
          </p>
          <p>
            {tier("LAPSED")} Nothing bought for {field("lapsedAfterMonths")} months and no subscription running.
          </p>
          <p className="text-xs text-subtle">
            Anybody else is just a customer, with no badge. Lifetime value is invoices and debit notes less credit notes, tax in, in your base currency — with the
            years brought across from Zoho Books. Renewal rate is the subscriptions renewed of those whose term has ended.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Refreshing</CardHeader>
        <CardContent className="space-y-2 text-sm text-muted">
          <p>
            Every customer&apos;s figures are worked out once a day, and again when you save here.{" "}
            {view.refreshedAt
              ? `Last: ${new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(view.refreshedAt))}${view.refreshMs !== null ? `, in ${(view.refreshMs / 1000).toFixed(1)} s` : ""} — ${view.customers.toLocaleString("en-IN")} customers.`
              : "Not yet worked out."}
          </p>
          <Button size="sm" variant="ghost" disabled={pending} onClick={refresh}>
            {pending ? "Working…" : "Refresh now"}
          </Button>
        </CardContent>
      </Card>

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {notice && <p role="status" className="text-sm text-success">{notice}</p>}
      <div className="flex gap-2">
        <Button size="sm" disabled={pending} onClick={save}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={reset}>
          Back to the defaults
        </Button>
      </div>
    </div>
  );
}
