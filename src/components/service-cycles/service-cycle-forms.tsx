"use client";

import Link from "next/link";
import { CompanyLink } from "@/components/companies/company-link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveTemplate, setCycleStopped, setTemplateActive, skipJob, startCycle, startOptions, updateCycle, type TemplateDetail } from "@/actions/service-cycles";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { confirmAction } from "@/components/ui/confirm";
import { CompanyCombobox, type CompanyComboOption } from "@/components/ui/company-combobox";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { PersonCombobox, type PersonOption } from "@/components/ui/person-combobox";
import { cadenceWords, STATE_WORDS, type JobState } from "@/lib/service-cycles/rules";
import type { JobRow } from "@/lib/service-cycles/server";
import { companyPath } from "@/lib/record-links";
import { formatCalendarDay } from "@/lib/time/zone";

/** Service cycles' forms (owner, 9 Nov 2026 — src/actions/service-cycles.ts). */

type StepDraft = { id?: string; name: string; firstAfterMonths: string; everyMonths: string; showDaysBefore: string; checklist: string; used?: boolean };
const blankStep = (): StepDraft => ({ name: "", firstAfterMonths: "0", everyMonths: "", showDaysBefore: "14", checklist: "" });

/** A plan: its name and length, and its steps — when each first comes, how often after, how early it's a task, its checklist. */
export function TemplateForm({ template }: { template: TemplateDetail | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(template?.name ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [months, setMonths] = useState(String(template?.months ?? 12));
  const [steps, setSteps] = useState<StepDraft[]>(
    template?.steps.map((s) => ({ id: s.id, name: s.name, firstAfterMonths: String(s.firstAfterMonths), everyMonths: s.everyMonths === null ? "" : String(s.everyMonths), showDaysBefore: String(s.showDaysBefore), checklist: s.checklist.join("\n"), used: s.used })) ?? [blankStep()],
  );
  const change = (i: number, patch: Partial<StepDraft>) => setSteps((all) => all.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, by: number) => setSteps((all) => {
    const next = [...all];
    const [s] = next.splice(i, 1);
    next.splice(Math.max(0, Math.min(next.length, i + by)), 0, s!);
    return next;
  });

  const save = () =>
    start(async () => {
      const r = await saveTemplate({
        id: template?.id,
        name,
        description,
        months: Number(months),
        steps: steps.map((s) => ({ id: s.id, name: s.name, firstAfterMonths: Number(s.firstAfterMonths || 0), everyMonths: s.everyMonths.trim() === "" ? null : Number(s.everyMonths), showDaysBefore: Number(s.showDaysBefore || 0), checklist: s.checklist.split("\n") })),
      });
      if (!r.ok) return setError(r.error);
      setError(null);
      router.push(`/service-cycles/templates/${r.data.seq}`);
      router.refresh();
    });

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
          <div>
            <Label htmlFor="sc-name">Name</Label>
            <Input id="sc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Lift AMC, ISO 9001 certification, GST compliance…" />
          </div>
          <div>
            <Label htmlFor="sc-months">Runs for (months)</Label>
            <Input id="sc-months" type="number" min={1} max={120} value={months} onChange={(e) => setMonths(e.target.value)} />
          </div>
        </div>
        <div>
          <Label htmlFor="sc-about">What it&apos;s for (optional)</Label>
          <Textarea id="sc-about" rows={2} value={description ?? ""} onChange={(e) => setDescription(e.target.value)} />
        </div>
      </Card>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-text">Steps</h2>
        {steps.map((s, i) => (
          <Card key={s.id ?? `new-${i}`} className="space-y-3 p-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[14rem] flex-1">
                <Label htmlFor={`sc-step-${i}`}>Step</Label>
                <Input id={`sc-step-${i}`} value={s.name} onChange={(e) => change(i, { name: e.target.value })} placeholder="Preventive visit, Surveillance audit, GSTR-3B…" />
              </div>
              <div className="w-32">
                <Label htmlFor={`sc-first-${i}`}>First, month</Label>
                <Input id={`sc-first-${i}`} type="number" min={0} value={s.firstAfterMonths} onChange={(e) => change(i, { firstAfterMonths: e.target.value })} />
              </div>
              <div className="w-36">
                <Label htmlFor={`sc-every-${i}`}>Then every (months)</Label>
                <Input id={`sc-every-${i}`} type="number" min={1} value={s.everyMonths} placeholder="Once" onChange={(e) => change(i, { everyMonths: e.target.value })} />
              </div>
              <div className="w-36">
                <Label htmlFor={`sc-lead-${i}`}>A task, days ahead</Label>
                <Input id={`sc-lead-${i}`} type="number" min={0} value={s.showDaysBefore} onChange={(e) => change(i, { showDaysBefore: e.target.value })} />
              </div>
            </div>
            <div>
              <Label htmlFor={`sc-check-${i}`}>Checklist, a line each (optional)</Label>
              <Textarea id={`sc-check-${i}`} rows={3} value={s.checklist} onChange={(e) => change(i, { checklist: e.target.value })} />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
              <span>
                {cadenceWords({ firstAfterMonths: Number(s.firstAfterMonths || 0), everyMonths: s.everyMonths.trim() === "" ? null : Number(s.everyMonths) })}
                {s.used && " · cycles have jobs for it, so it can't be removed"}
              </span>
              <span className="flex gap-1">
                <Button type="button" size="sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)}>Up</Button>
                <Button type="button" size="sm" variant="ghost" disabled={i === steps.length - 1} onClick={() => move(i, 1)}>Down</Button>
                <Button type="button" size="sm" variant="ghost" disabled={s.used || steps.length === 1} onClick={() => setSteps((all) => all.filter((_, j) => j !== i))}>Remove</Button>
              </span>
            </div>
          </Card>
        ))}
        <Button type="button" size="sm" variant="secondary" onClick={() => setSteps((all) => [...all, blankStep()])}>Add a step</Button>
      </div>

      {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" disabled={pending} onClick={save}>{pending ? "Saving…" : template ? "Save the plan" : "Make the plan"}</Button>
        {template && (
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await setTemplateActive(template.id, !template.active);
                if (!r.ok) return setError(r.error);
                router.refresh();
              })
            }
          >
            {template.active ? "Put it away" : "Use it again"}
          </Button>
        )}
        {template?.inUse && <span className="text-xs text-muted">Saving brings every running cycle of this plan in step. Jobs already tasks stay as they are.</span>}
      </div>
    </div>
  );
}

/** Starting a plan for a customer: the plan, the customer, an order to tie it to, the days, and whose tasks the jobs are. */
export function StartCycleForm({
  templates,
  companies,
  people,
  preset,
}: {
  templates: { id: string; name: string; months: number }[];
  companies: CompanyComboOption[];
  people: PersonOption[];
  preset: { companyId?: string; orderId?: string; templateId?: string };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState(preset.templateId ?? templates[0]?.id ?? "");
  const [companyId, setCompanyId] = useState(preset.companyId ?? "");
  const [orders, setOrders] = useState<{ id: string; label: string; start: string | null; end: string | null }[]>([]);
  const [orderId, setOrderId] = useState(preset.orderId ?? "");
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState("");
  const [ownerId, setOwnerId] = useState("");

  const loadOrders = (id: string) =>
    start(async () => {
      const r = await startOptions(id);
      setOrders(r?.orders ?? []);
      const chosen = r?.orders.find((o) => o.id === (preset.orderId ?? ""));
      if (chosen?.start) setStartDate(chosen.start);
      if (chosen?.end) setEndDate(chosen.end);
    });
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  if (companyId && loadedFor !== companyId) {
    setLoadedFor(companyId);
    loadOrders(companyId);
  }

  const submit = () =>
    start(async () => {
      const r = await startCycle({ templateId, companyId, orderId: orderId || null, startDate, endDate: endDate || null, ownerUserId: ownerId || null });
      if (!r.ok) return setError(r.error);
      router.push(`/service-cycles/${r.data.seq}`);
      router.refresh();
    });

  if (templates.length === 0) {
    return (
      <Card className="p-4 text-sm text-muted">
        There&apos;s no plan to start yet. <Link href="/service-cycles/templates/new" className="text-brand hover:underline">Make one first</Link>.
      </Card>
    );
  }
  const months = templates.find((t) => t.id === templateId)?.months;
  return (
    <Card className="max-w-2xl space-y-3 p-4">
      <div>
        <Label htmlFor="sc-plan">Plan</Label>
        <Select id="sc-plan" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>{t.name} ({t.months} months)</option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="sc-customer">Customer</Label>
        <CompanyCombobox id="sc-customer" companies={companies} value={companyId} onSelect={(c) => { setCompanyId(c?.id ?? ""); setOrderId(""); }} />
      </div>
      {orders.length > 0 && (
        <div>
          <Label htmlFor="sc-order">For an order (optional)</Label>
          <Select
            id="sc-order"
            value={orderId}
            onChange={(e) => {
              setOrderId(e.target.value);
              const o = orders.find((x) => x.id === e.target.value);
              if (o?.start) setStartDate(o.start);
              if (o?.end) setEndDate(o.end);
            }}
          >
            <option value="">None</option>
            {orders.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </Select>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="sc-start">Starts</Label>
          <Input id="sc-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="sc-end">Ends</Label>
          <Input id="sc-end" type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />
          {!endDate && months && <p className="mt-1 text-xs text-muted">Empty: {months} months from the start.</p>}
        </div>
      </div>
      <div>
        <Label htmlFor="sc-owner">Each job is a task for</Label>
        <PersonCombobox id="sc-owner" people={people} value={ownerId} onSelect={(p) => setOwnerId(p?.id ?? "")} placeholder="Nobody yet — the task waits unassigned" />
      </div>
      {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}
      <Button type="button" disabled={pending || !companyId || !templateId} onClick={submit}>{pending ? "Starting…" : "Start the cycle"}</Button>
    </Card>
  );
}

const STATE_TONE: Record<JobState, "default" | "green" | "blue" | "red" | "amber"> = { PLANNED: "default", OPEN: "blue", OVERDUE: "red", DONE: "green", SKIPPED: "amber" };

/** Jobs as a table: due, the customer and cycle (unless one cycle's own), the step, who has it, where it stands. */
export function JobTable({ rows, mayManage, showCycle }: { rows: JobRow[]; mayManage: boolean; showCycle: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const skip = (row: JobRow) =>
    start(async () => {
      const reason = row.state === "SKIPPED" ? "" : window.prompt(`Why won't "${row.stepName}" for ${row.company.name} happen?`)?.trim();
      if (row.state !== "SKIPPED" && !reason) return;
      const r = await skipJob(row.id, row.state !== "SKIPPED", reason || undefined);
      if (!r.ok) return setError(r.error);
      setError(null);
      router.refresh();
    });
  if (rows.length === 0) return <Card className="p-6 text-center text-sm text-muted">Nothing here.</Card>;
  return (
    <div className="space-y-2">
      {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface-sunken text-left text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Due</th>
              {showCycle && <th className="px-3 py-2 font-medium">Customer</th>}
              <th className="px-3 py-2 font-medium">Step</th>
              {showCycle && <th className="px-3 py-2 font-medium">Cycle</th>}
              <th className="px-3 py-2 font-medium">Who</th>
              <th className="px-3 py-2 font-medium">Where it stands</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-line align-top">
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">{formatCalendarDay(r.due)}</td>
                {showCycle && (
                  <td className="px-3 py-2">
                    <CompanyLink href={companyPath(r.company.companySeq)} className="text-brand hover:underline">{r.company.name}</CompanyLink>
                  </td>
                )}
                <td className="px-3 py-2">
                  {r.stepName} <span className="text-xs text-muted">#{r.seq}</span>
                  {r.skippedReason && <div className="text-xs text-muted">{r.skippedReason}</div>}
                </td>
                {showCycle && (
                  <td className="px-3 py-2">
                    <Link href={`/service-cycles/${r.cycle.seq}`} className="text-brand hover:underline">{r.cycle.templateName}</Link>
                  </td>
                )}
                <td className="px-3 py-2">{r.assignee?.name ?? <span className="text-muted">Nobody</span>}</td>
                <td className="px-3 py-2"><Badge tone={STATE_TONE[r.state]}>{STATE_WORDS[r.state]}</Badge></td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {r.taskId && <Link href={`/tasks?task=${r.taskId}`} className="mr-2 text-brand hover:underline">Task</Link>}
                  {mayManage && r.state !== "DONE" && (
                    <button type="button" disabled={pending} onClick={() => skip(r)} className="text-xs text-muted hover:text-text">
                      {r.state === "SKIPPED" ? "Bring back" : "Skip"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

/** A cycle's own controls: its dates and owner, and stopping or starting it again. */
export function CycleControls({ cycle, people }: { cycle: { id: string; start: string; end: string; ownerUserId: string | null; stopped: boolean }; people: PersonOption[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [startDate, setStartDate] = useState(cycle.start);
  const [endDate, setEndDate] = useState(cycle.end);
  const [ownerId, setOwnerId] = useState(cycle.ownerUserId ?? "");
  const run = (work: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const r = await work();
      if (!r.ok) return setError(r.error ?? "That didn't go through.");
      setError(null);
      router.refresh();
    });
  return (
    <Card className="space-y-3 p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <Label htmlFor="cc-start">Starts</Label>
          <Input id="cc-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="cc-end">Ends</Label>
          <Input id="cc-end" type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="cc-owner">Jobs go to</Label>
          <PersonCombobox id="cc-owner" people={people} value={ownerId} onSelect={(p) => setOwnerId(p?.id ?? "")} placeholder="Nobody" />
        </div>
      </div>
      <p className="text-xs text-muted">Jobs not yet tasks follow new dates and owner. Tasks already made keep theirs.</p>
      {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={pending} onClick={() => run(() => updateCycle({ id: cycle.id, startDate, endDate, ownerUserId: ownerId || null }))}>Save</Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={async () => {
            if (!cycle.stopped && !(await confirmAction({ title: "Stop this cycle?", message: "Nothing more becomes a task. Tasks already made stay with whoever has them.", confirmLabel: "Stop the cycle", danger: true }))) return;
            run(() => setCycleStopped(cycle.id, !cycle.stopped));
          }}
        >
          {cycle.stopped ? "Start it again" : "Stop the cycle"}
        </Button>
      </div>
    </Card>
  );
}
