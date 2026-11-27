"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Target, Trash2 } from "lucide-react";
import { deleteElsewhere, saveElsewhere } from "@/actions/elsewhere";
import { ELSEWHERE_SOURCES, REMIND_CHOICES, categoryLabel, sourceLabel, type ElsewhereCategoryOption } from "@/lib/customers/elsewhere-rules";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { confirmAction } from "@/components/ui/confirm";

/**
 * A customer's "Installed elsewhere" tab (owner, 2 Nov 2026 — src/lib/customers/elsewhere.ts): what it uses that it
 * didn't buy from us, soonest renewal first, each with "Make a lead"; added and changed in a dialog by whoever may
 * change the customer.
 */

export type ElsewhereRow = {
  id: string;
  productName: string;
  category: string | null;
  quantity: number | null;
  boughtFrom: string | null;
  renewsOn: string | null;
  yearlyValue: string | null;
  valueText: string | null;
  source: string;
  notes: string | null;
  remindDays: number | null;
};

type Form = { productName: string; category: string; quantity: string; boughtFrom: string; renewsOn: string; yearlyValue: string; source: string; notes: string; remindDays: string };
const EMPTY: Form = { productName: "", category: "", quantity: "", boughtFrom: "", renewsOn: "", yearlyValue: "", source: "CUSTOMER_SAID", notes: "", remindDays: "90" };

const formOf = (r: ElsewhereRow): Form => ({
  productName: r.productName,
  category: r.category ?? "",
  quantity: r.quantity ? String(r.quantity) : "",
  boughtFrom: r.boughtFrom ?? "",
  renewsOn: r.renewsOn ? r.renewsOn.slice(0, 10) : "",
  yearlyValue: r.yearlyValue ? String(Number(r.yearlyValue)) : "",
  source: r.source,
  notes: r.notes ?? "",
  remindDays: r.remindDays ? String(r.remindDays) : "",
});

/** "12 Mar 2027", read as the day it is (a @db.Date, midnight UTC). */
const dayText = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");

/** How soon, as a badge: past, within 90 days, later. */
function soon(iso: string | null, today: string) {
  if (!iso) return null;
  const days = Math.round((Date.parse(iso.slice(0, 10)) - Date.parse(today)) / 86_400_000);
  if (days < 0) return { tone: "default" as const, text: "Date passed" };
  if (days <= 90) return { tone: "amber" as const, text: days === 0 ? "Renews today" : `In ${days} day${days === 1 ? "" : "s"}` };
  return { tone: "blue" as const, text: `In ${Math.round(days / 30)} months` };
}

export function InstalledElsewhere({
  companyId,
  rows,
  canEdit,
  canMakeLead,
  productNames,
  sellers,
  categories,
  canEditCategories,
  today,
  ready,
}: {
  companyId: string;
  rows: ElsewhereRow[];
  canEdit: boolean;
  canMakeLead: boolean;
  /** Our own items' names, offered as they type — what's typed is kept either way. */
  productNames: string[];
  /** Resellers already typed on other customers, offered the same way. */
  sellers: string[];
  /** The workspace's categories (Settings › Lists), and whether this person may change that list. */
  categories: ElsewhereCategoryOption[];
  canEditCategories: boolean;
  today: string;
  ready: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<{ id: string | null; form: Form } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const set = (patch: Partial<Form>) => setEditing((e) => (e ? { ...e, form: { ...e.form, ...patch } } : e));
  const save = () =>
    start(async () => {
      if (!editing) return;
      const f = editing.form;
      const result = await saveElsewhere({
        id: editing.id,
        companyId,
        productName: f.productName,
        category: (f.category || null) as never,
        quantity: f.quantity ? Number(f.quantity) : null,
        boughtFrom: f.boughtFrom || null,
        renewsOn: f.renewsOn || null,
        yearlyValue: f.yearlyValue ? Number(f.yearlyValue) : null,
        source: f.source as never,
        notes: f.notes || null,
        remindDays: f.remindDays ? Number(f.remindDays) : null,
      });
      if (!result.ok) return setError(result.error);
      setEditing(null);
      setError(null);
      router.refresh();
    });
  const remove = async (r: ElsewhereRow) => {
    if (!(await confirmAction({ title: `Remove ${r.productName}?`, message: "It comes off this customer's Installed elsewhere list. Tasks already raised for it stay.", confirmLabel: "Remove", danger: true }))) return;
    const result = await deleteElsewhere(r.id);
    if (!result.ok) return setError(result.error);
    router.refresh();
  };

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-text">Installed elsewhere</p>
          <p className="text-xs text-muted">What they use that they didn&apos;t buy from us — so the renewal is ours to win. The account manager gets a task before each renews.</p>
        </div>
        {canEdit && ready && (
          <Button type="button" size="sm" onClick={() => (setError(null), setEditing({ id: null, form: EMPTY }))}>
            <Plus className="mr-1.5 h-4 w-4" /> Add
          </Button>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {!ready ? (
          <p className="px-4 py-6 text-sm text-subtle">This workspace can keep these after its next update.</p>
        ) : rows.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-subtle">
            Nothing noted yet. When you learn they use, say, a Sophos firewall from another reseller renewing in March, add it here — you&apos;ll be reminded before it renews.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2.5">Product</th>
                  <th className="px-4 py-2.5">Qty</th>
                  <th className="px-4 py-2.5">Bought from</th>
                  <th className="px-4 py-2.5">Renews</th>
                  <th className="px-4 py-2.5">A year</th>
                  <th className="px-4 py-2.5">How we know</th>
                  <th className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const when = soon(r.renewsOn, today);
                  return (
                    <tr key={r.id} className="border-b border-line align-top last:border-0 hover:bg-surface-sunken">
                      <td className="px-4 py-2.5">
                        <span className="font-medium text-text">{r.productName}</span>
                        {r.category && <span className="block text-[11px] text-subtle">{categoryLabel(r.category, categories)}</span>}
                        {r.notes && <span className="mt-0.5 block max-w-xs whitespace-pre-line text-xs text-muted">{r.notes}</span>}
                      </td>
                      <td className="px-4 py-2.5 text-muted">{r.quantity ?? "—"}</td>
                      <td className="px-4 py-2.5 text-muted">{r.boughtFrom ?? "—"}</td>
                      <td className="px-4 py-2.5 text-muted">
                        {dayText(r.renewsOn)}
                        {when && (
                          <span className="mt-0.5 block">
                            <Badge tone={when.tone}>{when.text}</Badge>
                          </span>
                        )}
                        {r.renewsOn && r.remindDays && <span className="mt-0.5 block text-[11px] text-subtle">Task {r.remindDays} days before</span>}
                      </td>
                      <td className="px-4 py-2.5 text-muted">{r.valueText ?? "—"}</td>
                      <td className="px-4 py-2.5 text-xs text-muted">{sourceLabel(r.source)}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center justify-end gap-1">
                          {canMakeLead && (
                            <Link href={`/leads/new?companyId=${companyId}&elsewhere=${r.id}`} title="Make a lead to win it at renewal" className="inline-flex items-center gap-1 whitespace-nowrap rounded-base px-2 py-1 text-xs text-brand hover:bg-brand/10">
                              <Target className="h-3.5 w-3.5" /> Make a lead
                            </Link>
                          )}
                          {canEdit && (
                            <>
                              <button type="button" title="Change" onClick={() => (setError(null), setEditing({ id: r.id, form: formOf(r) }))} className="p-1.5 text-muted hover:text-text">
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button type="button" title="Remove" onClick={() => remove(r)} className="p-1.5 text-muted hover:text-danger">
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {error && !editing && (
          <div className="p-3">
            <ActionNotice tone="error">{error}</ActionNotice>
          </div>
        )}
      </CardContent>

      <datalist id="elsewhere-products">
        {productNames.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <datalist id="elsewhere-sellers">
        {sellers.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>

      <Dialog open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? "Change what they use" : "Installed elsewhere"}>
        {editing && (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="ie-product">Product</Label>
              <Input id="ie-product" list="elsewhere-products" value={editing.form.productName} onChange={(e) => set({ productName: e.target.value })} placeholder="Sophos XGS firewall, Google Workspace Business Standard…" autoFocus />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="ie-category">Category</Label>
                <Select id="ie-category" value={editing.form.category} onChange={(e) => set({ category: e.target.value })}>
                  <option value="">—</option>
                  {categories.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.name}
                    </option>
                  ))}
                </Select>
                {canEditCategories && (
                  <a href="/settings/lists" target="_blank" rel="noreferrer" className="text-[11px] text-subtle underline underline-offset-2 hover:text-text">
                    Add or remove categories
                  </a>
                )}
              </div>
              <div className="space-y-1">
                <Label htmlFor="ie-qty">Quantity</Label>
                <Input id="ie-qty" type="number" min={1} value={editing.form.quantity} onChange={(e) => set({ quantity: e.target.value })} placeholder="100" />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="ie-from">Bought from</Label>
              <Input id="ie-from" list="elsewhere-sellers" value={editing.form.boughtFrom} onChange={(e) => set({ boughtFrom: e.target.value })} placeholder="The reseller, distributor or maker" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="ie-renews">Renews or ends on</Label>
                <Input id="ie-renews" type="date" value={editing.form.renewsOn} onChange={(e) => set({ renewsOn: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ie-remind">Remind the account manager</Label>
                <Select id="ie-remind" value={editing.form.remindDays} onChange={(e) => set({ remindDays: e.target.value })}>
                  {REMIND_CHOICES.map((d) => (
                    <option key={d} value={String(d)}>
                      {d} days before
                    </option>
                  ))}
                  <option value="">Don&apos;t remind</option>
                </Select>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="ie-value">Roughly what it costs a year</Label>
                <Input id="ie-value" type="number" min={0} value={editing.form.yearlyValue} onChange={(e) => set({ yearlyValue: e.target.value })} placeholder="Optional" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ie-source">How we know</Label>
                <Select id="ie-source" value={editing.form.source} onChange={(e) => set({ source: e.target.value })}>
                  {ELSEWHERE_SOURCES.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="ie-notes">Notes</Label>
              <Textarea id="ie-notes" rows={3} value={editing.form.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="Unhappy with their support, open to switching, decision-maker is the IT head…" />
            </div>
            {error && <ActionNotice tone="error">{error}</ActionNotice>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button type="button" onClick={save} disabled={pending || !editing.form.productName.trim()}>
                {pending ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </Card>
  );
}
