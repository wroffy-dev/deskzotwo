"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowRightLeft } from "lucide-react";
import { moveEmployeeRecord, moveTargets, previewEmployeeMove } from "@/actions/move-employee";
import type { MovePlan } from "@/lib/hr/move-employee";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/bulk-select";
import { PersonCombobox, type PersonOption } from "@/components/ui/person-combobox";
import { formatCalendarDay } from "@/lib/time/zone";

/**
 * "Move to another account" (owner, 31 Oct 2026): for a record that landed on the wrong login — the
 * Kredily import's `jitender.kumar@…` when the person signs in as `jitender@…`. Pick the account, read
 * what moves and what doesn't, type its email, move. The work itself is src/lib/hr/move-employee.ts.
 */
export function MoveEmployeeDialog({ userId, name }: { userId: string; name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<PersonOption[] | null>(null);
  const [target, setTarget] = useState<PersonOption | null>(null);
  const [plan, setPlan] = useState<MovePlan | null>(null);
  const [switchOff, setSwitchOff] = useState(true);
  const [handOver, setHandOver] = useState(true);
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();
  const [moving, startMoving] = useTransition();

  function show() {
    setOpen(true);
    setError(null);
    if (!people) startLoading(async () => setPeople(await moveTargets(userId)));
  }

  function pick(person: PersonOption | null) {
    setTarget(person);
    setPlan(null);
    setConfirm("");
    setError(null);
    if (!person) return;
    startLoading(async () => {
      const result = await previewEmployeeMove(userId, person.id);
      if (result.ok) setPlan(result.data);
      else setError(result.error);
    });
  }

  function move() {
    if (!plan) return;
    setError(null);
    startMoving(async () => {
      const result = await moveEmployeeRecord({ fromUserId: userId, toUserId: plan.to.id, confirmEmail: confirm, switchOffSource: switchOff && !plan.from.isSuperAdmin, handOverReportees: handOver });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.push(result.data.path);
      router.refresh();
    });
  }

  const areas = plan ? [...new Set(plan.lines.map((l) => l.area))] : [];
  const confirmed = plan ? confirm.trim().toLowerCase() === plan.to.email.toLowerCase() : false;

  return (
    <>
      <Button variant="secondary" onClick={show}>
        <ArrowRightLeft className="mr-1.5 h-3.5 w-3.5" />
        Move to another account
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} title={`Move ${name}'s employee record`} wide>
        <div className="space-y-4">
          <p className="text-sm text-muted">
            For a record that is on the wrong login. Everything of the person&apos;s HR life moves with it — attendance, leave, payroll, claims, their
            file and the assets they hold. What this account did as a login — leads, approvals, its sign-ins and audit — stays with it.
          </p>

          <div className="space-y-1.5">
            <Label htmlFor="move-target">The account they really sign in with</Label>
            <PersonCombobox
              id="move-target"
              people={people ?? []}
              value={target?.id ?? ""}
              onSelect={pick}
              disabled={!people}
              placeholder={people ? "Search by name or email…" : "Loading…"}
              emptyText="Nobody matches — only switched-on accounts without an employee record (or with a blank one) are offered."
            />
          </div>

          {loading && target && !plan && <p className="text-sm text-muted">Working out what moves…</p>}

          {plan && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {areas.map((area) => {
                  const rows = plan.lines.filter((l) => l.area === area && (l.moving > 0 || l.dropped > 0));
                  return (
                    <div key={area} className="rounded-base border border-line px-3 py-2">
                      <p className="text-xs font-medium text-text">{area}</p>
                      {rows.length === 0 ? (
                        <p className="text-xs text-subtle">Nothing to move</p>
                      ) : (
                        <ul className="mt-1 space-y-0.5 text-xs text-muted">
                          {rows.map((l) => (
                            <li key={l.key} className="flex justify-between gap-2">
                              <span>{l.label}</span>
                              <span className="tabular-nums">
                                {l.moving}
                                {l.dropped > 0 && <span className="text-warning"> · {l.dropped} dropped</span>}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>

              {plan.dropped.length > 0 && (
                <div className="rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-xs text-warning">
                  <p className="font-medium">Both accounts have these days — the new account&apos;s stand, the old account&apos;s are dropped:</p>
                  <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto">
                    {plan.dropped.map((d) => (
                      <li key={`${d.kind}-${d.date}`}>
                        {d.kind} {formatCalendarDay(d.date)}: keeps {d.kept.toLowerCase().replaceAll("_", " ")}, drops {d.source.toLowerCase().replaceAll("_", " ")}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {plan.replaced.length > 0 && (
                <p className="text-xs text-muted">Giving way to the old account&apos;s: {plan.replaced.join("; ")}.</p>
              )}
              {plan.carried.length > 0 && (
                <p className="text-xs text-muted">
                  The new account takes {plan.carried.map((c) => `${c.label.toLowerCase()} ${c.value}`).join(", ")} — it has none of its own.
                </p>
              )}
              {plan.lockedMonths.length > 0 && (
                <p className="text-xs text-muted">
                  Payslips from locked or paid months ({plan.lockedMonths.join(", ")}) move with their figures untouched — only whose they are changes.
                </p>
              )}

              {plan.blockers.length > 0 && (
                <div className="rounded-base border border-danger/40 px-3 py-2 text-xs text-danger">
                  <p className="font-medium">This can&apos;t move yet:</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {plan.blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </div>
              )}

              <label className="flex items-start gap-2 rounded-base border border-line px-3 py-2.5">
                <Checkbox checked={switchOff} onChange={() => setSwitchOff((v) => !v)} aria-label="Switch off the old account" disabled={plan.from.isSuperAdmin} />
                <span className="text-sm">
                  <span className="block text-text">Switch off the old account ({plan.from.email})</span>
                  <span className="block text-xs text-muted">
                    {plan.from.isSuperAdmin
                      ? "It is the super admin's, so it stays on."
                      : "It is never deleted — what it did stays attributed to it, and it can be switched back on."}
                  </span>
                </span>
              </label>

              {(plan.reportees.length > 0 || plan.pendingApprovals > 0) && (
                <label className="flex items-start gap-2 rounded-base border border-line px-3 py-2.5">
                  <Checkbox checked={handOver} onChange={() => setHandOver((v) => !v)} aria-label="Hand over reportees" />
                  <span className="text-sm">
                    <span className="block text-text">
                      Also make {plan.to.name} the manager of the {plan.reportees.length} {plan.reportees.length === 1 ? "person" : "people"} who report to the old account
                    </span>
                    <span className="block text-xs text-muted">
                      {plan.reportees.map((r) => r.name).join(", ")}
                      {plan.pendingApprovals > 0 && `${plan.reportees.length ? " — and " : ""}${plan.pendingApprovals} leave, short leave or regularisation request${plan.pendingApprovals === 1 ? "" : "s"} waiting on it`}
                    </span>
                  </span>
                </label>
              )}
              {plan.reporteesLooping.length > 0 && (
                <p className="text-xs text-muted">
                  {plan.reporteesLooping.map((r) => r.name).join(", ")} stay{plan.reporteesLooping.length === 1 ? "s" : ""} with the old account: {plan.to.name} reports to them.
                </p>
              )}
              {/* Reportees the mover may not hand over (src/lib/hr/move-employee.ts `reporteesRefused`, Phase 2 permission fixes). */}
              {plan.reporteesRefused.map((r) => (
                <p key={r.id} className="text-xs text-muted">
                  {r.name} stays with the old account: {r.reason}
                </p>
              ))}

              <div className="space-y-1.5">
                <Label htmlFor="move-confirm">Type {plan.to.email} to confirm</Label>
                <Input id="move-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" spellCheck={false} />
              </div>
            </div>
          )}

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex gap-2">
            <Button variant="danger" disabled={!plan || plan.blockers.length > 0 || !confirmed || moving} onClick={move}>
              {moving ? "Moving…" : "Move"}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
