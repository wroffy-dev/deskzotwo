"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { deleteDeskSettings, saveDeskSettings } from "@/actions/desks";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { confirmAction } from "@/components/ui/confirm";
import { Input, Label, Select } from "@/components/ui/input";
import { APPROVALS, APPROVAL_LABELS, DEFAULT_TIMES, deskLabel, LEVELS, LEVEL_LABELS, ROUTINGS, ROUTING_LABELS, type Level, type Span, type Times, type TypeApproval } from "@/lib/desks/rules";
import type { DeskSetting } from "@/lib/desks/server";
import { cn } from "@/lib/utils";

type DepartmentView = { id: string; name: string; members: { id: string; name: string }[] };
type TypeDraft = { id?: string; name: string; asksAsset: boolean; approval: TypeApproval; active: boolean; used: boolean };
type Draft = { id?: string; name: string; description: string; departmentId: string; routing: string; personId: string; leadId: string; times: Times; active: boolean; types: TypeDraft[] };

const draftOf = (d: DeskSetting): Draft => ({ id: d.id, name: d.name, description: d.description, departmentId: d.departmentId ?? "", routing: d.routing, personId: d.personId ?? "", leadId: d.leadId ?? "", times: d.times, active: d.active, types: d.types.map((t) => ({ ...t })) });
const fresh = (): Draft => ({ name: "", description: "", departmentId: "", routing: "POOL", personId: "", leadId: "", times: DEFAULT_TIMES, active: true, types: [{ name: "Something else", asksAsset: false, approval: "NONE", active: true, used: false }] });

/** Settings › Help desk: one desk at a time, on the right of the list of them. */
export function DeskSettings({ desks, departments }: { desks: DeskSetting[]; departments: DepartmentView[] }) {
  const [chosen, setChosen] = useState<string | null>(desks[0]?.id ?? null);
  const desk = desks.find((d) => d.id === chosen);
  const adding = chosen === "new" || desks.length === 0;
  return (
    <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
      <Card className="p-2">
        {desks.map((d) => (
          <button key={d.id} type="button" aria-pressed={!adding && d.id === chosen} onClick={() => setChosen(d.id)} className={cn("block w-full rounded-base px-3.5 py-2 text-left", !adding && d.id === chosen ? "bg-brand-subtle text-brand" : "text-text hover:bg-surface-sunken")}>
            <span className="flex items-center justify-between gap-2 text-sm font-medium">
              {d.name}
              {!d.active && <Badge>Off</Badge>}
            </span>
            <span className="block text-xs text-muted">{!d.departmentId ? "No department" : `${d.people.length} ${d.people.length === 1 ? "person" : "people"}`}</span>
          </button>
        ))}
        <Button variant="ghost" className="mt-1 w-full" onClick={() => setChosen("new")}>
          Add a desk
        </Button>
      </Card>
      {departments.length === 0 ? (
        <Card className="px-5 py-8 text-center text-sm text-muted">
          A desk is one of your departments, and you have none yet.{" "}
          <Link href="/settings/departments" className="text-brand hover:underline">
            Add a department
          </Link>
        </Card>
      ) : (
        <DeskForm key={adding ? "new" : chosen} start={adding || !desk ? fresh() : draftOf(desk)} requests={adding ? 0 : (desk?.requests ?? 0)} departments={departments} onSaved={setChosen} />
      )}
    </div>
  );
}

function DeskForm({ start, requests, departments, onSaved }: { start: Draft; requests: number; departments: DepartmentView[]; onSaved: (id: string | null) => void }) {
  const router = useRouter();
  const [busy, go] = useTransition();
  const [d, setD] = useState<Draft>(start);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const set = (change: Partial<Draft>) => {
    setSaved(false);
    setD((x) => ({ ...x, ...change }));
  };
  const people = departments.find((x) => x.id === d.departmentId)?.members ?? [];
  const setType = (i: number, change: Partial<TypeDraft>) => set({ types: d.types.map((t, j) => (j === i ? { ...t, ...change } : t)) });
  const setTime = (l: Level, key: "reply" | "fix", change: Partial<Span>) => set({ times: { ...d.times, [l]: { ...d.times[l], [key]: { ...d.times[l][key], ...change } } } });

  function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    go(async () => {
      const r = await saveDeskSettings({ ...d, personId: d.personId || null, leadId: d.leadId || null, types: d.types.map(({ id, name, asksAsset, approval, active }) => ({ id, name, asksAsset, approval, active })) });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setSaved(true);
      onSaved(r.data.id);
      router.refresh();
    });
  }

  async function remove() {
    if (!d.id || !(await confirmAction(`Delete ${deskLabel(d.name)}? Nobody has asked it anything, so nothing else goes.`))) return;
    setError(null);
    go(async () => {
      const r = await deleteDeskSettings(d.id!);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onSaved(null);
      router.refresh();
    });
  }

  return (
    <Card>
      <CardContent>
        <form onSubmit={save} className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="desk-name">Name people see</Label>
              <Input id="desk-name" value={d.name} onChange={(e) => set({ name: e.target.value })} maxLength={60} placeholder="IT" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="desk-department">Department that answers</Label>
              <Select id="desk-department" value={d.departmentId} onChange={(e) => set({ departmentId: e.target.value, personId: "", leadId: "" })} required>
                <option value="">Choose a department</option>
                {departments.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name} ({x.members.length})
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="desk-about">What to ask it for</Label>
              <Input id="desk-about" value={d.description} onChange={(e) => set({ description: e.target.value })} maxLength={160} placeholder="Laptop, email, software, passwords" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="desk-routing">New requests go to</Label>
              <Select id="desk-routing" value={d.routing} onChange={(e) => set({ routing: e.target.value })}>
                {ROUTINGS.map((r) => (
                  <option key={r} value={r}>
                    {ROUTING_LABELS[r]}
                  </option>
                ))}
              </Select>
            </div>
            {d.routing === "PERSON" && (
              <div className="space-y-1.5">
                <Label htmlFor="desk-person">Who</Label>
                <Select id="desk-person" value={d.personId} onChange={(e) => set({ personId: e.target.value })} required>
                  <option value="">Choose a person</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="desk-lead">Also told when one is overdue</Label>
              <Select id="desk-lead" value={d.leadId} onChange={(e) => set({ leadId: e.target.value })}>
                <option value="">Nobody else</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {d.departmentId && people.length === 0 && <p className="text-sm text-warning">Nobody is in that department, so employees won&apos;t see this desk until somebody is.</p>}

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-text">What people can ask for</legend>
            {d.types.map((t, i) => (
              <div key={t.id ?? `new-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-base border border-line px-3 py-2.5">
                <Input aria-label={`Type ${i + 1}`} value={t.name} onChange={(e) => setType(i, { name: e.target.value })} maxLength={60} className="w-64" />
                <label className="flex items-center gap-1.5 text-[13px] text-muted">
                  <input type="checkbox" checked={t.asksAsset} onChange={(e) => setType(i, { asksAsset: e.target.checked })} /> Asks which asset
                </label>
                <Select aria-label={`Approval for ${t.name || `type ${i + 1}`}`} value={t.approval} onChange={(e) => setType(i, { approval: e.target.value as TypeApproval })} className="w-64">
                  {APPROVALS.map((a) => (
                    <option key={a} value={a}>
                      {APPROVAL_LABELS[a]}
                    </option>
                  ))}
                </Select>
                {t.used && (
                  <label className="flex items-center gap-1.5 text-[13px] text-muted">
                    <input type="checkbox" checked={t.active} onChange={(e) => setType(i, { active: e.target.checked })} /> Offered
                  </label>
                )}
                {!t.used && (
                  <button type="button" aria-label={`Remove ${t.name || `type ${i + 1}`}`} onClick={() => set({ types: d.types.filter((_, j) => j !== i) })} className="rounded p-1 text-muted hover:text-text">
                    <X aria-hidden="true" className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
            <Button type="button" variant="ghost" size="sm" onClick={() => set({ types: [...d.types, { name: "", asksAsset: false, approval: "NONE", active: true, used: false }] })}>
              Add a type
            </Button>
          </fieldset>

          <div className="space-y-2">
            <h2 className="text-sm font-medium text-text">Times</h2>
            <div className="overflow-x-auto rounded-base border border-line">
              <table className="w-full min-w-[520px] text-[13px]">
                <thead className="bg-surface-sunken text-left text-muted">
                  <tr>
                    <th className="px-3.5 py-2 font-medium">How much it holds them up</th>
                    <th className="px-3 py-2 font-medium">First reply within</th>
                    <th className="px-3.5 py-2 font-medium">Put right within</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {LEVELS.map((l) => (
                    <tr key={l}>
                      <td className="px-3.5 py-2 font-medium text-text">{LEVEL_LABELS[l]}</td>
                      {(["reply", "fix"] as const).map((key) => (
                        <td key={key} className="px-3 py-2">
                          <span className="flex gap-2">
                            <Input type="number" min={1} max={90} aria-label={`${LEVEL_LABELS[l]}: ${key === "reply" ? "first reply" : "put right"} within`} value={d.times[l][key].n} onChange={(e) => setTime(l, key, { n: Number(e.target.value) })} className="w-20" />
                            <Select aria-label={`${LEVEL_LABELS[l]}: ${key === "reply" ? "first reply" : "put right"} in hours or days`} value={d.times[l][key].unit} onChange={(e) => setTime(l, key, { unit: e.target.value as Span["unit"] })} className="w-28">
                              <option value="hours">hours</option>
                              <option value="days">days</option>
                            </Select>
                          </span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[13px] text-muted">Counted on your office hours, Monday to Saturday, with holidays off — or by the clock, while no office hours are set in Attendance. The clock stops while a request is on hold or waiting for whoever asked.</p>
          </div>

          <label className="flex items-center gap-2 text-sm text-text">
            <input type="checkbox" checked={d.active} onChange={(e) => set({ active: e.target.checked })} /> Taking new requests
          </label>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : d.id ? "Save desk" : "Add desk"}
            </Button>
            {d.id && requests === 0 && (
              <Button type="button" variant="ghost" disabled={busy} onClick={() => void remove()}>
                Delete
              </Button>
            )}
            {saved && (
              <span role="status" className="text-[13px] text-success">
                Saved
              </span>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
