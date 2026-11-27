"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { previewPhoneRepair, runPhoneRepair } from "@/actions/phone-repair";
import type { PhoneRepairPlan, PhoneRepairResult } from "@/lib/leads/phone-repair";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatLeadId } from "@/lib/order-id";

/** A server action takes 6 MB, and a file grows by a third as base64 (as src/components/settings/import-dialog.tsx). */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Upload the original file, see what it puts right, then put it right (src/lib/leads/phone-repair.ts). The file is
 * read again on apply, so what changes is exactly what the preview said.
 */
export function PhoneRepair({ broken }: { broken: number }) {
  const router = useRouter();
  const [file, setFile] = useState<{ filename: string; base64: string } | null>(null);
  const [plan, setPlan] = useState<PhoneRepairPlan | null>(null);
  const [clearUnfixed, setClearUnfixed] = useState(false);
  const [result, setResult] = useState<PhoneRepairResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function choose(f: File | undefined) {
    setPlan(null);
    setResult(null);
    setError(null);
    if (!f) return;
    if (f.size > MAX_BYTES) {
      setError("The file is over 4 MB. Keep only the Old system ID, email and phone columns, and upload that.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const upload = { filename: f.name, base64: String(reader.result).split(",")[1] ?? "" };
      setFile(upload);
      startTransition(async () => {
        const r = await previewPhoneRepair(upload);
        if (r.ok) setPlan(r.data);
        else setError(r.error);
      });
    };
    reader.readAsDataURL(f);
  }

  function apply() {
    if (!file) return;
    startTransition(async () => {
      const r = await runPhoneRepair({ ...file, clearUnfixed });
      if (r.ok) {
        setResult(r.data);
        setPlan(null);
        router.refresh();
      } else setError(r.error);
    });
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4 text-sm">
        <p className="text-text">
          <span className="font-semibold">{broken.toLocaleString("en-IN")}</span> contact phone{broken === 1 ? " is" : "s are"} shortened
          like 9.20E+11 now.
        </p>
        <label className="block space-y-1.5">
          <span className="text-muted">The original file — CSV or Excel, with an Old system ID or email column and the phone column</span>
          <input
            type="file"
            accept=".csv,.xlsx"
            disabled={pending}
            onChange={(e) => choose(e.target.files?.[0])}
            className="block text-sm text-muted file:mr-3 file:rounded-md file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-sm file:text-text"
          />
        </label>
        {pending && !plan && <p className="text-xs text-subtle">Reading the file…</p>}
        {error && <p className="text-sm text-danger">{error}</p>}
      </Card>

      {plan && (
        <Card className="space-y-3 p-4 text-sm">
          <div className="flex flex-wrap gap-2">
            <Badge tone="green">{plan.fixable.toLocaleString("en-IN")} put back</Badge>
            <Badge tone={plan.unmatched ? "amber" : "default"}>{plan.unmatched.toLocaleString("en-IN")} not in the file</Badge>
            {plan.ambiguous > 0 && <Badge tone="amber">{plan.ambiguous} with two phones for one email — left</Badge>}
          </div>
          <p className="text-xs text-subtle">
            Matched by {[plan.columns.oldId && `“${plan.columns.oldId}”`, plan.columns.email && `“${plan.columns.email}”`].filter(Boolean).join(", then ")}; phones
            from “{plan.columns.phone}”. Only a phone still shortened changes.
          </p>
          {plan.sample.length > 0 && (
            <div className="overflow-x-auto rounded-md border border-line">
              <table className="w-full text-xs">
                <thead className="bg-surface-sunken text-left text-muted">
                  <tr>
                    <th className="px-3 py-2">Lead</th>
                    <th className="px-3 py-2">Contact</th>
                    <th className="px-3 py-2">Now</th>
                    <th className="px-3 py-2">Becomes</th>
                    <th className="px-3 py-2">Matched by</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.sample.map((f) => (
                    <tr key={f.contactId} className="border-t border-line">
                      <td className="px-3 py-1.5 font-mono text-muted">{f.lead ? formatLeadId(f.lead) : "—"}</td>
                      <td className="px-3 py-1.5 text-text">{f.name}</td>
                      <td className="px-3 py-1.5 text-danger">{f.from}</td>
                      <td className="px-3 py-1.5 text-text">{f.to}</td>
                      <td className="px-3 py-1.5 text-muted">{f.by}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {plan.fixable > plan.sample.length && (
                <p className="border-t border-line px-3 py-1.5 text-xs text-subtle">…and {(plan.fixable - plan.sample.length).toLocaleString("en-IN")} more.</p>
              )}
            </div>
          )}
          {plan.unmatched > 0 && (
            <label className="flex items-start gap-2 text-sm text-text">
              <input type="checkbox" checked={clearUnfixed} onChange={(e) => setClearUnfixed(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--brand)]" />
              <span>
                Also clear the {plan.unmatched.toLocaleString("en-IN")} the file can&apos;t fix
                <span className="block text-xs text-subtle">A shortened number isn&apos;t one anybody can ring; cleared, the phone shows as missing.</span>
              </span>
            </label>
          )}
          <Button onClick={apply} disabled={pending || (plan.fixable === 0 && !clearUnfixed)}>
            {pending ? "Putting them back…" : `Put back ${plan.fixable.toLocaleString("en-IN")} phone${plan.fixable === 1 ? "" : "s"}`}
          </Button>
        </Card>
      )}

      {result && (
        <Card className="p-4 text-sm text-text">
          {result.fixed.toLocaleString("en-IN")} phone{result.fixed === 1 ? "" : "s"} put back
          {result.cleared ? `, ${result.cleared.toLocaleString("en-IN")} cleared` : ""}
          {result.unmatched ? `; ${result.unmatched.toLocaleString("en-IN")} still shortened` : ""}. Written to the audit log.
        </Card>
      )}
    </div>
  );
}
