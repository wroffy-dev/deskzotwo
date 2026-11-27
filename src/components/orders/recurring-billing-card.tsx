"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { setRecurringBilling, type RecurringBillingView } from "@/actions/recurring-billing";
import { documentPath } from "@/lib/trade-documents";
import { useWording } from "@/components/terms/wording-provider";
import { slot } from "@/lib/terms/dictionary";
import { INSTALMENT_CYCLES, cycleWords, type InstalmentCycle } from "@/lib/recurring-billing/periods";

type Choice = "OFF" | "AUTO_RENEW" | "INSTALMENTS";

const CYCLE_LABELS: Record<InstalmentCycle, string> = { MONTHLY: "Monthly", QUARTERLY: "Quarterly", HALF_YEARLY: "Half-yearly", ANNUAL: "Yearly" };

/**
 * The billing plan on one subscription (owner, 16 Nov 2026 — "monthly with an annual commitment, month to month,
 * every six months…, so nothing gets missed"): the term is the commitment (the order's dates); it is billed whole when
 * it renews, or in monthly, quarterly, half-yearly or yearly parts; and it renews once, or keeps renewing on the same
 * plan. Every period it has raised is listed with its draft. Nothing it raises is issued: the drafts wait on the
 * invoice list for somebody to check and issue.
 */
export function RecurringBillingCard({ view }: { view: RecurringBillingView }) {
  const router = useRouter();
  const wording = useWording();
  const current: Choice = view.setting?.mode ?? "OFF";
  const [choice, setChoice] = useState<Choice>(current);
  const [cycle, setCycle] = useState<InstalmentCycle>(
    view.setting?.cycle && (INSTALMENT_CYCLES as readonly string[]).includes(view.setting.cycle) ? (view.setting.cycle as InstalmentCycle) : "MONTHLY",
  );
  const [keep, setKeep] = useState(view.setting?.keepRenewing ?? false);
  const [billFrom, setBillFrom] = useState(view.setting?.billFrom ?? view.suggestedFrom.MONTHLY ?? view.term.start ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();

  const changed =
    choice !== current ||
    (choice !== "OFF" && keep !== (view.setting?.keepRenewing ?? false)) ||
    (choice === "INSTALMENTS" && (cycle !== (view.setting?.cycle ?? null) || billFrom !== (view.setting?.billFrom ?? null)));
  const unavailable = choice === "OFF" ? null : view.why[choice];

  function pickCycle(next: InstalmentCycle) {
    setCycle(next);
    // Follow the cycle's own next part, unless a day has already been chosen and saved.
    if (!view.setting?.billFrom) setBillFrom(view.suggestedFrom[next] ?? view.term.start ?? "");
  }

  function save() {
    setError(null);
    startSave(async () => {
      const result = await setRecurringBilling(
        view.orderId,
        choice === "OFF" ? null : choice === "AUTO_RENEW" ? { mode: "AUTO_RENEW", keepRenewing: keep } : { mode: "INSTALMENTS", cycle, billFrom, keepRenewing: keep },
      );
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Recurring billing</CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted">
          {current === "OFF"
            ? "No plan — this subscription is invoiced and renewed by hand."
            : current === "AUTO_RENEW"
              ? view.setting?.keepRenewing
                ? "Billed a whole term at a time, renewing term after term: on the first day of each new term the renewal order is punched for approval, keeping this plan, and its invoice raised as a draft. Never for a renewal marked Lost or On hold."
                : "Renews itself once: on the first day of the next term, the renewal order is punched for approval and its invoice raised as a draft. The new term starts with this off. Never for a renewal marked Lost or On hold."
              : `Billed ${cycleWords[(view.setting?.cycle as InstalmentCycle) ?? "MONTHLY"]} from ${view.setting?.billFrom}: each part is raised as a draft on the day it begins.${view.setting?.keepRenewing ? " At the end of the term it renews on the same plan, and the parts go on." : " At the end of the term it stops — the renewals list takes it up."}`}
          {current !== "OFF" && view.setting && <span className="text-subtle"> Set by {view.setting.setBy}.</span>}
        </p>

        {view.canManage && (
          <div className="space-y-2 rounded-base border border-line p-3">
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="recurring-mode" className="text-muted">
                Billing
              </label>
              <select
                id="recurring-mode"
                className="h-8 rounded-base border border-line bg-surface px-2 text-sm text-text"
                value={choice}
                disabled={saving}
                onChange={(e) => setChoice(e.target.value as Choice)}
              >
                <option value="OFF">No plan — by hand</option>
                <option value="AUTO_RENEW">The whole term, when it renews</option>
                <option value="INSTALMENTS">The term in parts</option>
              </select>
              {choice === "INSTALMENTS" && (
                <>
                  <select
                    aria-label="How often"
                    className="h-8 rounded-base border border-line bg-surface px-2 text-sm text-text"
                    value={cycle}
                    disabled={saving}
                    onChange={(e) => pickCycle(e.target.value as InstalmentCycle)}
                  >
                    {INSTALMENT_CYCLES.map((c) => (
                      <option key={c} value={c}>
                        {CYCLE_LABELS[c]}
                      </option>
                    ))}
                  </select>
                  <label htmlFor="recurring-from" className="text-muted">
                    from
                  </label>
                  <Input
                    id="recurring-from"
                    type="date"
                    className="h-8 w-36 border-line px-2"
                    value={billFrom}
                    min={view.term.start ?? undefined}
                    max={view.term.end ?? undefined}
                    disabled={saving}
                    onChange={(e) => setBillFrom(e.target.value)}
                  />
                </>
              )}
            </div>
            {choice === "INSTALMENTS" && !unavailable && (
              <p className="text-xs text-subtle">
                Parts that began before this day are not raised — they are taken to be invoiced already. The price is split
                evenly across every part of the term, the last part taking any paisa left over.
              </p>
            )}
            {choice !== "OFF" && (
              <label className={`flex items-start gap-2 text-sm ${view.whyNotKeep ? "text-subtle" : "text-text"}`} title={view.whyNotKeep ?? undefined}>
                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--color-brand)]" checked={keep} disabled={saving || !!view.whyNotKeep} onChange={(e) => setKeep(e.target.checked)} />
                <span>
                  Keep renewing on this plan
                  <span className="block text-xs text-subtle">
                    {view.whyNotKeep ??
                      (choice === "INSTALMENTS"
                        ? "At the end of the term the renewal is punched for approval with the same parts — monthly goes on monthly. Right for a monthly payment on an annual commitment."
                        : "Each term renews into the next, its invoice drafted when it does. Right for month to month, or a monthly order billed a quarter at a time (a three-month term).")}
                  </span>
                </span>
              </label>
            )}
            {unavailable && <p className="text-xs text-warning">{unavailable}</p>}
            <div className="flex justify-end">
              <Button type="button" size="sm" onClick={save} disabled={saving || !changed || !!unavailable}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        )}

        <div aria-live="polite">{error && <ActionNotice tone="error">{error}</ActionNotice>}</div>

        {view.raised.length > 0 && (
          <ul className="divide-y divide-line rounded-base border border-line">
            {view.raised.map((p) => (
              <li key={p.start} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="text-text">
                  {p.start} to {p.end}
                  {p.renewal && (
                    <>
                      {" "}
                      · renewed as{" "}
                      <Link href={p.renewal.path} className="text-brand hover:underline">
                        {slot(wording, "the new order", "order", "the new {one:lower}")}
                      </Link>
                    </>
                  )}
                </span>
                {p.documentId ? (
                  <Link href={documentPath(p.documentId)} className="text-brand hover:underline">
                    {p.docNumber} · {p.status?.toLowerCase().replaceAll("_", " ")}
                  </Link>
                ) : (
                  <span className="text-subtle">{p.renewal ? "no invoice raised" : "skipped — its draft was deleted"}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
