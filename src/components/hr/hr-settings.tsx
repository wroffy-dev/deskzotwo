"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Trash2 } from "lucide-react";
import type { listHolidays, listLeaveTypes } from "@/actions/hr";
import { deleteHoliday, deleteLeaveType, saveHoliday, saveLeaveType } from "@/actions/hr";
import { confirmAction } from "@/components/ui/confirm";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/bulk-select";
import { formatCalendarDay } from "@/lib/time/zone";
import { leaveAccrualValues } from "@/lib/validation/hr";
import type { LeaveYearState } from "@/actions/leave-year";
import { LeaveYearCard } from "@/components/hr/leave-year-card";

type Holiday = Awaited<ReturnType<typeof listHolidays>>[number];
type LeaveType = Awaited<ReturnType<typeof listLeaveTypes>>[number];

export function HrSettings({
  holidays,
  leaveTypes,
  year,
  leaveYear,
  superAdmin = false,
}: {
  holidays: Holiday[];
  leaveTypes: LeaveType[];
  year: number;
  /** The leave year setting — null for somebody who can't change it. */
  leaveYear?: LeaveYearState | null;
  /** The super admin edits and deletes leave types; HR adds them. */
  superAdmin?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <HolidayCard holidays={holidays} year={year} />
      <div className="space-y-5">
        <LeaveTypeCard leaveTypes={leaveTypes} superAdmin={superAdmin} />
        {leaveYear && <LeaveYearCard state={leaveYear} />}
      </div>
    </div>
  );
}

function HolidayCard({ holidays, year }: { holidays: Holiday[]; year: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [optional, setOptional] = useState(false);

  function add() {
    setError(null);
    startTransition(async () => {
      const result = await saveHoliday({ name, date, optional });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setName("");
      setDate("");
      setOptional(false);
      router.refresh();
    });
  }

  function remove(id: string) {
    setError(null);
    startTransition(async () => {
      const result = await deleteHoliday(id);
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Holidays in {year}</CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
          {/* The card header names the year; nothing names the two boxes under it. */}
          <Input aria-label="Holiday name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Diwali" />
          <Input aria-label="Holiday date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <Button disabled={pending || !name || !date} onClick={add}>
            Add
          </Button>
        </div>
        <label className="flex items-start gap-2 text-xs text-muted">
          <Checkbox checked={optional} onChange={() => setOptional((v) => !v)} aria-label="Restricted holiday" />
          <span>
            Restricted (optional) holiday — the office stays open, and whoever takes it uses a day of RH: the leave type with the code RH, which can only be taken on these days.
          </span>
        </label>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="space-y-1.5 border-t border-line pt-3">
          {holidays.length === 0 && <p className="text-sm text-subtle">No holidays on the calendar for {year}.</p>}
          {holidays.map((h) => (
            <div key={h.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-text">{h.name}</span>
                {h.optional && <Badge tone="amber">Restricted</Badge>}
              </span>
              <span className="flex items-center gap-2">
                <span className="text-xs text-muted">{formatCalendarDay(h.date)}</span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => remove(h.id)}
                  className="text-subtle hover:text-danger"
                  aria-label={`Remove ${h.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

const BLANK_TYPE = { code: "", name: "", annualQuota: "12", accrual: "ANNUAL", carryForward: false, maxCarryForward: "", paid: true, active: true };

function LeaveTypeCard({ leaveTypes, superAdmin }: { leaveTypes: LeaveType[]; superAdmin: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(BLANK_TYPE);
  // The leave type being edited — the form above fills with it (owner, 26 Nov 2026: the super admin's).
  const [editingId, setEditingId] = useState<string | null>(null);

  function add() {
    setError(null);
    startTransition(async () => {
      const result = await saveLeaveType({
        ...form,
        ...(editingId ? { id: editingId } : {}),
        maxCarryForward: form.maxCarryForward ? Number(form.maxCarryForward) : undefined,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setForm(BLANK_TYPE);
      setEditingId(null);
      router.refresh();
    });
  }

  function startEdit(t: LeaveType) {
    setError(null);
    setEditingId(t.id);
    setForm({
      code: t.code,
      name: t.name,
      annualQuota: String(Number(t.annualQuota)),
      accrual: t.accrual,
      carryForward: t.carryForward,
      maxCarryForward: t.maxCarryForward ? String(Number(t.maxCarryForward)) : "",
      paid: t.paid,
      active: t.active,
    });
  }

  function cancelEdit() {
    setError(null);
    setEditingId(null);
    setForm(BLANK_TYPE);
  }

  async function remove(t: LeaveType) {
    const yes = await confirmAction({
      title: `Delete ${t.name}?`,
      message: "It goes from the list, with the balances credited for it. One that anybody has applied for can't be deleted — untick “Offered to people” instead.",
      confirmLabel: "Delete leave type",
      danger: true,
    });
    if (!yes) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteLeaveType(t.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (editingId === t.id) cancelEdit();
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">{editingId ? `Edit leave type — ${form.code || "…"}` : "Leave types"}</CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ltCode">Code</Label>
            <Input
              id="ltCode"
              value={form.code}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
              placeholder="EL"
              maxLength={10}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ltName">Name</Label>
            <Input
              id="ltName"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Earned leave"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ltQuota">Days a year</Label>
            <Input
              id="ltQuota"
              type="number"
              step="0.5"
              value={form.annualQuota}
              onChange={(e) => setForm((f) => ({ ...f, annualQuota: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ltAccrual">Credited</Label>
            <Select
              id="ltAccrual"
              value={form.accrual}
              onChange={(e) => setForm((f) => ({ ...f, accrual: e.target.value }))}
            >
              {leaveAccrualValues.map((a) => (
                <option key={a} value={a}>
                  {a === "ANNUAL" ? "All at once, at the start of the leave year" : "A twelfth each month"}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-xs text-muted">
            <Checkbox checked={form.paid} onChange={() => setForm((f) => ({ ...f, paid: !f.paid }))} aria-label="Paid leave" />
            Paid
          </label>
          <label className="flex items-center gap-2 text-xs text-muted">
            <Checkbox
              checked={form.carryForward}
              onChange={() => setForm((f) => ({ ...f, carryForward: !f.carryForward }))}
              aria-label="Carries forward"
            />
            Carries into next year
          </label>
          {editingId && (
            <label className="flex items-center gap-2 text-xs text-muted">
              <Checkbox checked={form.active} onChange={() => setForm((f) => ({ ...f, active: !f.active }))} aria-label="Offered to people" />
              Offered to people
            </label>
          )}
          {form.carryForward && (
            <Input
              aria-label="Maximum days carried forward"
              type="number"
              value={form.maxCarryForward}
              onChange={(e) => setForm((f) => ({ ...f, maxCarryForward: e.target.value }))}
              placeholder="Max days"
              className="h-8 w-28 text-xs"
            />
          )}
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex flex-wrap gap-2">
          <Button disabled={pending || !form.code || !form.name} onClick={add}>
            {pending ? "Saving…" : editingId ? "Save changes" : "Add leave type"}
          </Button>
          {editingId && (
            <Button variant="secondary" disabled={pending} onClick={cancelEdit}>
              Cancel
            </Button>
          )}
        </div>

        <div className="space-y-1.5 border-t border-line pt-3">
          {leaveTypes.length === 0 && (
            <p className="text-sm text-subtle">
              None yet. Indian offices usually run Casual, Sick and Earned leave, plus an unpaid type.
            </p>
          )}
          {leaveTypes.map((t) => (
            <div key={t.id} className={`flex flex-wrap items-center justify-between gap-x-3 text-sm ${editingId === t.id ? "rounded-base bg-brand-subtle/50" : ""}`}>
              <span className="flex items-center gap-2">
                <Badge tone="default">{t.code}</Badge>
                <span className={t.active ? "text-text" : "text-subtle line-through"}>{t.name}</span>
                {!t.paid && <Badge tone="amber">Unpaid</Badge>}
                {!t.active && <Badge tone="default">Not offered</Badge>}
              </span>
              <span className="flex items-center gap-1 text-xs text-muted">
                {Number(t.annualQuota)} days · {t.accrual === "MONTHLY" ? "monthly" : "annual"}
                {t.carryForward && ` · carries ${t.maxCarryForward ? `up to ${Number(t.maxCarryForward)}` : "over"}`}
                {superAdmin && (
                  <>
                    <button type="button" aria-label={`Edit ${t.name}`} title="Edit" disabled={pending} onClick={() => startEdit(t)} className="ml-1.5 rounded-base p-1 text-subtle hover:bg-surface-sunken hover:text-brand">
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" aria-label={`Delete ${t.name}`} title="Delete" disabled={pending} onClick={() => remove(t)} className="rounded-base p-1 text-subtle hover:bg-danger-bg hover:text-danger">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
