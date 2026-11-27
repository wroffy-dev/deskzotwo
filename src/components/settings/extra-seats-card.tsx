"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { askForExtraSeats, type BillingView } from "@/actions/billing";
import { useClock } from "@/components/time/clock-provider";
import { ActionNotice } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { EXTRA_SEATS_MAX, extraSeatPrice } from "@/lib/billing/extra-seat-price";
import { formatMoney } from "@/lib/billing/money";

/**
 * Settings → Plan & billing: more people before the renewal (src/lib/billing/extra-seats.ts), priced for the days left as
 * the number is typed, then paid on Razorpay's page or by a bank transfer against a proforma.
 */
export function ExtraSeatsCard({ offer, running, justPaid }: { offer: BillingView["extraSeats"]; running: BillingView["extraSeatsRunning"]; justPaid: boolean }) {
  const clock = useClock();
  const router = useRouter();
  const [planKey, setPlanKey] = useState(offer.plans[0]?.planKey ?? "");
  const [quantity, setQuantity] = useState("1");
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const plan = offer.plans.find((p) => p.planKey === planKey) ?? offer.plans[0];
  const count = Number(quantity);
  const valid = Number.isInteger(count) && count >= 1 && count <= EXTRA_SEATS_MAX;
  const price = plan && valid ? extraSeatPrice({ unitPrice: plan.unitPrice, interval: plan.interval, daysLeft: plan.daysLeft, quantity: count }) : null;

  function buy() {
    if (!plan) return;
    setNotice(null);
    start(async () => {
      const r = await askForExtraSeats({ planKey: plan.planKey, quantity: count });
      if (!r.ok) return setNotice({ tone: "bad", text: r.error });
      if (r.data.kind === "pay") return window.location.assign(r.data.url);
      setNotice({ tone: "ok", text: `Proforma ${r.data.number} is on its way by email, for ${formatMoney(r.data.total, "INR")}. The people are added when your transfer is recorded.` });
      router.refresh();
    });
  }

  if (!offer.open && !offer.reason && running.length === 0) return null;

  return (
    <Card id="more-people">
      <CardHeader className="text-sm font-medium text-text">More people before you renew</CardHeader>
      <CardContent className="space-y-3 text-sm">
        {justPaid && <p className="rounded-base border border-info/30 bg-info-bg px-3 py-2 text-info">Thank you. The people are added as soon as Razorpay confirms the payment, usually within a minute.</p>}
        {running.length > 0 && (
          <ul className="space-y-0.5 text-text">
            {running.map((r, i) => (
              <li key={i}>
                {r.quantity} extra {r.quantity === 1 ? "person" : "people"} until {clock.date(new Date(new Date(r.endsAt).getTime() - 86_400_000))}.
              </li>
            ))}
          </ul>
        )}
        {running.length > 0 && <p className="text-xs text-warning">These end when the period does. To keep them, renew for the higher number: the renewal form below starts there.</p>}
        {!offer.open && offer.reason && <p className="text-muted">{offer.reason}</p>}
        {offer.open && plan && (
          <>
            <p className="text-muted">
              You pay for the days left, at your plan&apos;s price per person. They end with the period, on {clock.date(new Date(new Date(plan.endsAt).getTime() - 86_400_000))}.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              {offer.plans.length > 1 && (
                <div className="space-y-1">
                  <Label htmlFor="xs-plan">Plan</Label>
                  <Select id="xs-plan" value={planKey} onChange={(e) => setPlanKey(e.target.value)}>
                    {offer.plans.map((p) => (
                      <option key={p.planKey} value={p.planKey}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
              <div className="w-28 space-y-1">
                <Label htmlFor="xs-quantity">How many</Label>
                <Input id="xs-quantity" type="number" min={1} max={EXTRA_SEATS_MAX} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
              </div>
              <Button size="sm" disabled={pending || !price} onClick={buy}>
                {pending ? "One moment…" : offer.gateway === "RAZORPAY" ? "Pay now" : "Get a proforma"}
              </Button>
            </div>
            {price && (
              <p className="text-text">
                {count} × {formatMoney(price.perPerson, "INR")} for {plan.daysLeft} {plan.daysLeft === 1 ? "day" : "days"} = {formatMoney(price.subtotal, "INR")}, plus GST {formatMoney(price.gst, "INR")}:{" "}
                <span className="font-semibold">{formatMoney(price.total, "INR")}</span>
              </p>
            )}
          </>
        )}
        {notice && <ActionNotice tone={notice.tone === "ok" ? "success" : "error"}>{notice.text}</ActionNotice>}
      </CardContent>
    </Card>
  );
}
