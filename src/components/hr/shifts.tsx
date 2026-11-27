"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Pencil, Plus } from "lucide-react";
import { archiveShift, assignShift, saveShift, setRosterDay, type RosterRow, type ShiftRow } from "@/actions/shifts";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { clockWordsOfMinute, timeOfMinute } from "@/lib/hr/office-hours-rules";
import { crossesMidnight, shiftMinutes } from "@/lib/hr/shift-rules";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
type Result = { ok: true } | { ok: false; error: string };

function useAct() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<Result>, after?: () => void) => {
    setError(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) return setError(r.error);
      after?.();
      router.refresh();
    });
  };
  return { pending, error, run };
}

export const shiftTimes = (s: { startMinute: number; endMinute: number }) =>
  `${clockWordsOfMinute(s.startMinute)} – ${clockWordsOfMinute(s.endMinute)}${crossesMidnight(s) ? " (next day)" : ""}`;

function ShiftForm({ shift, onDone }: { shift?: ShiftRow; onDone: () => void }) {
  const { pending, error, run } = useAct();
  const [f, setF] = useState({
    name: shift?.name ?? "",
    code: shift?.code ?? "",
    start: shift ? timeOfMinute(shift.startMinute) : "09:30",
    end: shift ? timeOfMinute(shift.endMinute) : "18:30",
    grace: String(shift?.graceMinutes ?? 15),
    weekOffs: shift?.weekOffs ?? [0, 6],
  });
  const set = (k: "name" | "code" | "start" | "end" | "grace") => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const toggle = (d: number) => setF({ ...f, weekOffs: f.weekOffs.includes(d) ? f.weekOffs.filter((x) => x !== d) : [...f.weekOffs, d] });
  return (
    <div className="space-y-3 rounded-base border border-line p-3">
      <div className="grid gap-3 sm:grid-cols-5">
        <div className="sm:col-span-2">
          <Label>Name</Label>
          <Input value={f.name} onChange={set("name")} placeholder="General" />
        </div>
        <div>
          <Label>Code</Label>
          <Input value={f.code} onChange={set("code")} placeholder="G" maxLength={4} />
        </div>
        <div>
          <Label>Starts</Label>
          <Input type="time" value={f.start} onChange={set("start")} />
        </div>
        <div>
          <Label>Ends</Label>
          <Input type="time" value={f.end} onChange={set("end")} />
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <Label>Grace (minutes)</Label>
          <Input type="number" min={0} max={120} value={f.grace} onChange={set("grace")} className="w-24" />
        </div>
        <div>
          <Label>Week off</Label>
          <div className="flex flex-wrap gap-1">
            {WEEKDAYS.map((w, d) => (
              <button
                key={w}
                type="button"
                onClick={() => toggle(d)}
                className={`rounded-base border px-2 py-1 text-xs ${f.weekOffs.includes(d) ? "border-brand bg-brand-subtle text-brand" : "border-line text-muted"}`}
              >
                {w}
              </button>
            ))}
          </div>
        </div>
      </div>
      <p className="text-xs text-muted">An end before the start is a night shift, ending the next morning.</p>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" disabled={pending} onClick={() => run(() => saveShift({ id: shift?.id, ...f }), onDone)}>
          Save shift
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function ShiftsList({ shifts, canEdit }: { shifts: ShiftRow[]; canEdit: boolean }) {
  const { pending, error, run } = useAct();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-text">Shifts</h2>
        {canEdit && editing !== "new" && (
          <Button size="sm" variant="secondary" onClick={() => setEditing("new")}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            New shift
          </Button>
        )}
      </div>
      {shifts.length === 0 && editing !== "new" && (
        <p className="text-sm text-muted">No shifts yet — everybody works the office hours, Monday to Friday. Add shifts when people work different hours or days.</p>
      )}
      <ul className="space-y-2">
        {shifts.map((s) =>
          editing === s.id ? (
            <li key={s.id}>
              <ShiftForm shift={s} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <li key={s.id} className={`flex flex-wrap items-center justify-between gap-2 rounded-base border border-line px-3 py-2 ${s.archived ? "opacity-60" : ""}`}>
              <div className="flex min-w-0 items-center gap-3">
                <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-base bg-brand-subtle px-1.5 text-xs font-semibold text-brand">{s.code}</span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text">
                    {s.name} {s.archived && <Badge>Archived</Badge>}
                  </p>
                  <p className="text-xs text-muted">
                    {shiftTimes(s)} · {Math.round((shiftMinutes(s) / 60) * 10) / 10} h · {s.graceMinutes} min grace · off {s.weekOffs.length ? s.weekOffs.map((d) => WEEKDAYS[d]).join(", ") : "none"} · {s.people} assigned
                  </p>
                </div>
              </div>
              {canEdit && (
                <div className="flex items-center gap-1">
                  <Button size="icon" variant="ghost" aria-label="Edit shift" onClick={() => setEditing(s.id)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => archiveShift(s.id, !s.archived))}>
                    {s.archived ? "Bring back" : "Archive"}
                  </Button>
                </div>
              )}
            </li>
          ),
        )}
        {editing === "new" && (
          <li>
            <ShiftForm onDone={() => setEditing(null)} />
          </li>
        )}
      </ul>
      {error && <p className="text-sm text-danger">{error}</p>}
    </Card>
  );
}

function dayHead(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  return { weekday: WEEKDAYS[d.getUTCDay()], day: d.getUTCDate() };
}

export function RosterGrid({
  rows,
  shifts,
  week,
  canEdit,
  query,
}: {
  rows: RosterRow[];
  shifts: ShiftRow[];
  week: { from: string; days: string[]; today: string; previous: string; next: string };
  canEdit: boolean;
  query: string;
}) {
  const { pending, error, run } = useAct();
  const live = shifts.filter((s) => !s.archived);
  const [chosen, setChosen] = useState<string[]>([]);
  const [assign, setAssign] = useState({ shiftId: live[0]?.id ?? "", fromDate: week.from });
  const href = (w: string) => `/people/shifts?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(query)), week: w }).toString()}`;
  const toggle = (id: string) => setChosen(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-text">Roster</h2>
        <div className="flex items-center gap-1">
          <Link href={href(week.previous)} aria-label="Previous week" className="rounded-base p-1.5 text-muted hover:bg-surface-sunken">
            <ChevronLeft className="h-4 w-4" />
          </Link>
          <span className="text-sm text-text">Week of {week.from}</span>
          <Link href={href(week.next)} aria-label="Next week" className="rounded-base p-1.5 text-muted hover:bg-surface-sunken">
            <ChevronRight className="h-4 w-4" />
          </Link>
        </div>
      </div>

      {canEdit && live.length > 0 && (
        <div className="flex flex-wrap items-end gap-2 rounded-base bg-surface-sunken p-3">
          <div>
            <Label>Put the {chosen.length || "ticked"} people on</Label>
            <Select value={assign.shiftId} onChange={(e) => setAssign({ ...assign, shiftId: e.target.value })} className="w-48">
              {live.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} — {s.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>from</Label>
            <Input type="date" value={assign.fromDate} onChange={(e) => setAssign({ ...assign, fromDate: e.target.value })} />
          </div>
          <Button size="sm" disabled={pending || chosen.length === 0} onClick={() => run(() => assignShift({ userIds: chosen, ...assign }), () => setChosen([]))}>
            Assign
          </Button>
          <p className="w-full text-xs text-muted">Their standing shift from that day on. Change a single day in the grid below.</p>
        </div>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="text-xs text-muted">
              <th className="px-2 py-1.5 text-left font-medium">Person</th>
              {week.days.map((d) => {
                const h = dayHead(d);
                return (
                  <th key={d} className={`px-1 py-1.5 text-center font-medium ${d === week.today ? "text-brand" : ""}`}>
                    {h.weekday} {h.day}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.userId} className="border-t border-line">
                <td className="px-2 py-1.5">
                  <label className="flex items-center gap-2">
                    {canEdit && <input type="checkbox" checked={chosen.includes(r.userId)} onChange={() => toggle(r.userId)} />}
                    <span>
                      <span className="block font-medium text-text">{r.name}</span>
                      <span className="block text-xs text-subtle">
                        {r.standing ? `${r.standing.code} since ${r.standing.fromDate}` : "Office hours"}
                        {r.department ? ` · ${r.department}` : ""}
                      </span>
                    </span>
                  </label>
                </td>
                {r.days.map((c) => {
                  const label = c.weekOff ? "Off" : (c.code ?? "—");
                  const tone = c.weekOff ? "text-subtle" : c.code ? "text-brand font-semibold" : "text-muted";
                  return (
                    <td key={c.date} className={`px-1 py-1 text-center ${c.source === "roster" ? "bg-warning-bg/50" : ""}`}>
                      {canEdit ? (
                        <select
                          aria-label={`${r.name} on ${c.date}`}
                          disabled={pending}
                          value={c.source === "roster" ? (c.weekOff ? "OFF" : (c.shiftId ?? "")) : ""}
                          onChange={(e) => run(() => setRosterDay({ userId: r.userId, date: c.date, value: e.target.value }))}
                          className={`w-full rounded-base border border-transparent bg-transparent px-1 py-1 text-center text-xs hover:border-line ${tone}`}
                        >
                          <option value="">{c.source === "roster" ? "As assigned" : label}</option>
                          {c.source === "roster" && <option value={c.weekOff ? "OFF" : (c.shiftId ?? "")}>{label}</option>}
                          {live
                            .filter((s) => !(c.source === "roster" && s.id === c.shiftId))
                            .map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.code}
                              </option>
                            ))}
                          {!(c.source === "roster" && c.weekOff) && <option value="OFF">Off</option>}
                        </select>
                      ) : (
                        <span className={`text-xs ${tone}`}>{label}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">A shaded day differs from the standing shift. Attendance measures late, early and overtime against each day&apos;s shift.</p>
    </Card>
  );
}
