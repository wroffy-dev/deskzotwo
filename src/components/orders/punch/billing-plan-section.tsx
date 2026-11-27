"use client";

import { useWatch } from "react-hook-form";
import { Label, Select } from "@/components/ui/input";
import { FieldError, Section } from "./parts";
import { invalidProps, type PunchErrors, type PunchForm } from "./types";

/**
 * How a subscription is billed, asked as it is punched (owner, 16 Nov 2026: "ask for billing plan when punching
 * subscription order"). Its term above is the commitment; this says how that term is billed — by hand, the whole term
 * when it renews, or in monthly, quarterly, half-yearly or yearly parts — and whether it keeps renewing on the plan.
 * Saved with the order by the billing card's own rules (src/actions/recurring-billing.ts); billing starts once the
 * order is approved.
 */
export function BillingPlanSection({ form, errors }: { form: PunchForm; errors: PunchErrors }) {
  const { control, register } = form;
  const [kind, cycle, startDate, endDate] = useWatch({ control, name: ["billingPlan.kind", "billingPlan.cycle", "startDate", "endDate"] });
  const planErrors = (errors as { billingPlan?: { kind?: { message?: string } } }).billingPlan;

  const hint =
    kind === "NONE"
      ? "Invoiced and renewed by hand. Renewals › Billing check will list it while it isn't invoiced."
      : kind === "WHOLE"
        ? "The term's invoice is raised as a draft when it renews. Invoice this first term by hand. For month to month, or a monthly order billed a quarter at a time, use a one- or three-month term and keep renewing."
        : kind === "PARTS"
          ? `The term's price split into ${cycle === "QUARTERLY" ? "quarterly" : cycle === "HALF_YEARLY" ? "half-yearly" : cycle === "ANNUAL" ? "yearly" : "monthly"} parts from its start${startDate ? ` (${startDate})` : ""}, each a draft on its day — right for an annual commitment paid as it goes.`
          : "Required for a subscription, so nothing goes unbilled.";

  return (
    <Section title="Billing plan" className="sm:grid-cols-1">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="billingPlanKind">How it&apos;s billed</Label>
          <Select id="billingPlanKind" {...register("billingPlan.kind")} {...invalidProps("billingPlan.kind", planErrors?.kind?.message)}>
            <option value="">Choose…</option>
            <option value="PARTS">The term in parts</option>
            <option value="WHOLE">The whole term, when it renews</option>
            <option value="NONE">No plan — by hand</option>
          </Select>
          <FieldError id="billingPlan.kind" message={planErrors?.kind?.message} />
        </div>
        {kind === "PARTS" && (
          <div className="space-y-1.5">
            <Label htmlFor="billingPlanCycle">Every</Label>
            <Select id="billingPlanCycle" {...register("billingPlan.cycle")}>
              <option value="MONTHLY">Month</option>
              <option value="QUARTERLY">Quarter</option>
              <option value="HALF_YEARLY">Six months</option>
              <option value="ANNUAL">Year</option>
            </Select>
          </div>
        )}
      </div>
      {(kind === "PARTS" || kind === "WHOLE") && (
        <label className="flex items-start gap-2 text-sm text-text">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--color-brand)]" {...register("billingPlan.keepRenewing")} />
          <span>
            Keep renewing on this plan
            <span className="block text-xs text-subtle">At the end of the term the renewal is punched for approval with the same plan.</span>
          </span>
        </label>
      )}
      <p className="text-xs text-subtle">
        {hint}
        {(kind === "PARTS" || kind === "WHOLE") && !endDate ? " Give it an end date above — a plan needs the term." : ""}
      </p>
    </Section>
  );
}
