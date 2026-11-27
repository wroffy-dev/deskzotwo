"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { setLeadLimitTrigger, type LeadLimitTriggerView } from "@/actions/lead-limits";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { confirmAction } from "@/components/ui/confirm";

/**
 * "Hold lead limits on every write path" (owner, 12 Nov 2026 — Phase 4 lead limits, audit H.6.4): the switch over the
 * database's backstop on `leads`, and the latest leads it saw given past somebody's limit. Off ("warn", as shipped) the
 * write goes through and is recorded here; on ("enforce") the database refuses it, whatever path wrote it — an importer,
 * a workflow, a script. The app's own screens check first either way, with a readable reason.
 *
 * The super admin's alone (src/actions/lead-limits.ts `setLeadLimitTrigger`), drawn on Settings › Lead assignment only
 * for them, as field masking's master switch is theirs on Roles & Permissions.
 */
export function LeadLimitTrigger({ state }: { state: LeadLimitTriggerView }) {
  const router = useRouter();
  const [enforce, setEnforce] = useState(state.mode === "enforce");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  async function change(next: boolean) {
    if (
      next &&
      !(await confirmAction({
        title: "Hold lead limits on every write path?",
        message: `From now on the database refuses any lead given to somebody past their open or daily limit, whatever wrote it — an import row, a workflow or a script fails instead of going through.${state.lastMonth ? ` ${state.lastMonth} such ${state.lastMonth === 1 ? "write was" : "writes were"} let through in the last 30 days.` : ""}`,
        confirmLabel: "Switch to enforce",
      }))
    )
      return;
    setError(null);
    setEnforce(next);
    start(async () => {
      const result = await setLeadLimitTrigger(next ? "enforce" : "warn");
      if (!result.ok) {
        setEnforce(!next);
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <Card>
      <CardContent className="space-y-4 pt-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p id="lead-limit-trigger-label" className="flex items-center gap-2 text-sm font-semibold text-text">
              <ShieldCheck aria-hidden="true" className="h-4 w-4 text-subtle" />
              Hold lead limits on every write path
              <span className={enforce ? "text-xs font-medium text-success" : "text-xs font-medium text-warning"}>{enforce ? "Enforce" : "Warn"}</span>
            </p>
            <p id="lead-limit-trigger-help" className="mt-1 max-w-2xl text-sm text-muted">
              {enforce
                ? "Enforce: the database refuses any lead given to somebody past their open or daily limit, whatever path wrote it."
                : "Warn: Deskzo's own screens and forms keep to the limits; anything else that gives somebody a lead past a limit — an import, a workflow, a script — goes through and is listed below. Switch to enforce once the list stays empty."}
            </p>
            {state.changedAtText && (
              <p className="mt-1 text-xs text-subtle">
                Last changed {state.changedBy ? `by ${state.changedBy}, ` : ""}
                {state.changedAtText}
              </p>
            )}
            {error && <p className="mt-1 text-xs text-danger">{error}</p>}
          </div>
          <Switch
            checked={enforce}
            onChange={change}
            disabled={pending}
            aria-labelledby="lead-limit-trigger-label"
            aria-describedby="lead-limit-trigger-help"
            aria-busy={pending || undefined}
            className="mt-0.5"
          />
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted">
            Leads given past a limit{state.lastMonth ? ` — ${state.lastMonth} in the last 30 days, latest first` : ""}
          </p>
          {state.warnings.length === 0 ? (
            <p className="text-sm text-subtle">None — nothing has given anybody a lead past their limit.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] text-sm">
                <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th scope="col" className="py-2 pr-3">When</th>
                    <th scope="col" className="px-3 py-2">Lead</th>
                    <th scope="col" className="px-3 py-2">Given to</th>
                    <th scope="col" className="px-3 py-2">Limit</th>
                    <th scope="col" className="py-2 pl-3">Written by</th>
                  </tr>
                </thead>
                <tbody>
                  {state.warnings.map((w) => (
                    <tr key={w.id} className="border-b border-line last:border-0">
                      <td className="whitespace-nowrap py-2 pr-3 text-muted">{w.atText}</td>
                      <td className="px-3 py-2">
                        {w.lead ? (
                          <Link href={`/leads/${w.lead.id}`} className="text-brand hover:underline">
                            {w.lead.label}
                          </Link>
                        ) : (
                          <span className="text-subtle">Deleted since</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-text">{w.person}</td>
                      <td className="px-3 py-2 tabular-nums text-muted">
                        {w.counted} {w.limit} already, limit {w.maxAllowed}
                      </td>
                      <td className="py-2 pl-3 text-muted">{w.path ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
