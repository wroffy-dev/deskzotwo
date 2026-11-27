"use client";

import { useState, useTransition } from "react";
import { BellRing } from "lucide-react";
import { remindCustomerNow } from "@/actions/payment-reminders";
import { confirmAction } from "@/components/ui/confirm";

/**
 * "Remind now" beside a customer on Receivables (owner, 3 Nov 2026 — src/actions/payment-reminders.ts): their overdue
 * invoices reminded there and then, each with the step whose day has come, from whoever the settings say.
 */
export function RemindNowButton({ companyId, name }: { companyId: string; name: string }) {
  const [said, setSaid] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const go = async () => {
    if (!(await confirmAction({ title: `Remind ${name} now?`, message: "Each of their overdue invoices gets its reminder by email now, from whoever Settings › Payment collection says — once a day at most.", confirmLabel: "Send reminders" }))) return;
    start(async () => {
      const r = await remindCustomerNow(companyId);
      if (!r.ok) return setSaid({ tone: "bad", text: r.error });
      const { sent, failed } = r.data;
      setSaid({ tone: failed.length && !sent ? "bad" : "ok", text: `${sent ? `Sent ${sent}.` : "None sent."}${failed.length ? ` ${failed.slice(0, 2).join("; ")}${failed.length > 2 ? ` and ${failed.length - 2} more` : ""}` : ""}` });
    });
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <button type="button" onClick={go} disabled={pending} className="inline-flex items-center gap-1 rounded-base px-1.5 py-0.5 text-xs text-brand hover:bg-brand/10 disabled:opacity-50" title="Send their overdue invoices' reminders now">
        <BellRing className="h-3.5 w-3.5" /> {pending ? "Sending…" : "Remind now"}
      </button>
      {said && <span className={`text-[11px] ${said.tone === "bad" ? "text-danger" : "text-success"}`}>{said.text}</span>}
    </span>
  );
}
