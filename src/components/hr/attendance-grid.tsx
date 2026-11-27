"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  AlarmClock,
  Check,
  ChevronLeft,
  ChevronRight,
  ClockArrowDown,
  ClockArrowUp,
  Coffee,
  Flag,
  Hourglass,
  House,
  Timer,
  Umbrella,
  X,
  type LucideIcon,
} from "lucide-react";
import type { attendanceMonth } from "@/actions/attendance";
import { markAttendance, saveOfficeHours } from "@/actions/attendance";
import { dayExtras, recordRestrictedHoliday, recordShortLeave, removeShortLeave, type DayExtras } from "@/actions/attendance-day";
import { isRestrictedHolidayType } from "@/lib/hr/restricted-holiday";
import { deleteAttendanceDay } from "@/actions/super-admin-delete";
import { attendanceLocations } from "@/actions/attendance-location";
import { ClockButtons } from "@/components/hr/clock-buttons";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollX } from "@/components/ui/scroll-x";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { Avatar } from "@/components/ui/avatar";
import { useClock } from "@/components/time/clock-provider";
import { attendanceStatusLabels, attendanceStatusValues } from "@/lib/validation/hr";
import { personPath } from "@/lib/record-links";
import { MONTH_NAMES, monthLabel } from "@/lib/hr/calendar";
import { clockWordsOfMinute, timeOfMinute, type OfficeHours } from "@/lib/hr/office-hours-rules";

type Month = Awaited<ReturnType<typeof attendanceMonth>>;
type Cell = Month["rows"][number]["cells"][number];
/** Whatever `myToday` hands back — dates arrive as Date or string depending on serialisation. */
type TodayRow = { status: string; checkInAt: Date | string | null; checkOutAt: Date | string | null } | null;

/** What a day shows (owner, 16 Oct 2026): one mark for its status, small ones for its timing. */
type Mark = { icon: LucideIcon | null; text?: string; className: string; label: string };
const MARKS = {
  PRESENT: { icon: Check, className: "text-success", label: "Present" },
  WORK_FROM_HOME: { icon: House, className: "text-info", label: "Work from home" },
  HALF_DAY: { icon: null, text: "½", className: "text-warning", label: "Half day" },
  ON_LEAVE: { icon: Flag, className: "text-danger", label: "On leave" },
  // A restricted holiday taken from the RH allowance (owner, 26 Nov 2026).
  RH: { icon: null, text: "RH", className: "text-warning", label: "Restricted holiday" },
  ABSENT: { icon: X, className: "text-danger", label: "Absent" },
  HOLIDAY: { icon: Umbrella, className: "text-warning", label: "Holiday" },
  WEEK_OFF: { icon: Coffee, className: "text-subtle", label: "Week off" },
} satisfies Record<string, Mark>;
const TIMING = {
  pending: { icon: Hourglass, className: "text-subtle", label: "Correction pending" },
  late: { icon: AlarmClock, className: "text-danger", label: "Late" },
  early: { icon: ClockArrowDown, className: "text-warning", label: "Left early" },
  overtime: { icon: ClockArrowUp, className: "text-info", label: "Overtime" },
} as const;
/** A short leave on the day (owner, 18 Oct 2026): solid once approved, faint while it waits. */
const SHORT_LEAVE = { icon: Timer, approved: "text-brand", waiting: "text-subtle", label: "Short leave" } as const;
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/** The day's main mark: its status, else its day off, else nothing (the future, or not recorded). */
function markOf(cell: Cell): Mark | null {
  if (cell.status === "ON_LEAVE" && cell.leaveCode && isRestrictedHolidayType({ code: cell.leaveCode })) return MARKS.RH;
  if (cell.status) return MARKS[cell.status as keyof typeof MARKS] ?? null;
  if (cell.offDay === "holiday") return MARKS.HOLIDAY;
  if (cell.offDay === "week off") return MARKS.WEEK_OFF;
  return null;
}

function MarkIcon({ mark, size = "h-4 w-4" }: { mark: Mark; size?: string }) {
  if (mark.icon) {
    const Icon = mark.icon;
    return <Icon className={`${size} ${mark.className}`} strokeWidth={2.25} aria-hidden />;
  }
  return <span className={`text-sm font-semibold leading-none ${mark.className}`}>{mark.text}</span>;
}

export function AttendanceGrid({
  month,
  today,
  canMark,
  year,
  monthNumber,
  canSetHours = false,
  canDelete = false,
}: {
  month: Month;
  today: TodayRow;
  canMark: boolean;
  year: number;
  monthNumber: number;
  canSetHours?: boolean;
  /** The super admin: a recorded day can be deleted from its dialog (src/actions/super-admin-delete.ts). */
  canDelete?: boolean;
}) {
  const clock = useClock();
  const [editing, setEditing] = useState<{ userId: string; name: string; date: string; cell: Cell } | null>(null);
  const hours = month.officeHours;
  const legend: { key: string; node: ReactNode; label: string }[] = [
    ...(["PRESENT", "ABSENT", "HALF_DAY", "ON_LEAVE", "RH", "HOLIDAY", "WEEK_OFF", "WORK_FROM_HOME"] as const).map((k) => ({
      key: k,
      node: <MarkIcon mark={MARKS[k]} size="h-3.5 w-3.5" />,
      label: MARKS[k].label,
    })),
    { key: "future", node: <span className="h-2.5 w-2.5 rounded-full border border-line-strong" />, label: "Future" },
    { key: "unrecorded", node: <span className="h-3.5 w-3.5 rounded border border-dashed border-line-strong" />, label: "Not recorded" },
    ...(["pending", ...(hours ? (["late", "early", "overtime"] as const) : [])] as const).map((k) => {
      const t = TIMING[k];
      const Icon = t.icon;
      return { key: k, node: <Icon className={`h-3.5 w-3.5 ${t.className}`} aria-hidden />, label: t.label };
    }),
    { key: "short", node: <SHORT_LEAVE.icon className={`h-3.5 w-3.5 ${SHORT_LEAVE.approved}`} aria-hidden />, label: SHORT_LEAVE.label },
  ];

  return (
    <div className="space-y-4">
      <ClockCard today={today} />

      <Card className="overflow-clip p-0">
        <div className="space-y-3 border-b border-line px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-success">Attendance report: {monthLabel(monthNumber, year).toUpperCase()}</h2>
            <MonthControls year={year} month={monthNumber} />
          </div>
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted">
            {legend.map((l) => (
              <li key={l.key} className="flex items-center gap-1.5">
                {l.node}
                {l.label}
              </li>
            ))}
          </ul>
          <OfficeHoursLine hours={hours} canSet={canSetHours} />
        </div>

        {/* A scrollbar above the table as well as below (owner, 26 Nov 2026: "scroller above also so it is easy to scroll"). */}
        <ScrollX>
          <table className="w-full border-collapse text-sm">
            <thead className="bg-surface-sunken">
              <tr>
                <th className="fixed-col sticky left-0 z-10 min-w-56 border-b border-r border-line bg-surface-sunken px-3 py-2 text-left text-xs font-medium text-muted">
                  Employee
                </th>
                {month.days.map((d) => (
                  <th key={d} className="min-w-11 border-b border-r border-line px-0.5 py-1.5 text-center font-normal">
                    <div className="text-sm font-semibold text-text">{Number(d.slice(8))}</div>
                    <div className="text-[10px] tracking-wide text-subtle">{WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()]}</div>
                  </th>
                ))}
                <th className="min-w-28 border-b border-line px-3 py-2 text-right text-xs font-medium text-muted">Total</th>
              </tr>
            </thead>
            <tbody>
              {month.rows.map((row) => (
                <tr key={row.userId} className="group">
                  <td className="fixed-col sticky left-0 z-10 border-b border-r border-line bg-surface px-3 py-2 group-hover:bg-surface-sunken">
                    <Link href={personPath(row.userSeq)} className="flex items-center gap-2.5">
                      <Avatar user={{ id: row.userId, name: row.name, photoUpdatedAt: row.photoUpdatedAt }} size="md" />
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-text hover:underline">{row.name}</span>
                        {row.designation && <span className="block truncate text-[11px] text-subtle">{row.designation}</span>}
                      </span>
                    </Link>
                  </td>
                  {row.cells.map((cell) => (
                    <td key={cell.date} className="border-b border-r border-line p-0 text-center group-hover:bg-surface-sunken/60">
                      <DayCell
                        cell={cell}
                        // A day still to come isn't marked (owner, 18 Nov 2026) — the action refuses it too.
                        canMark={canMark && !cell.future}
                        time={(at) => clock.time(at)}
                        onOpen={() => canMark && !cell.future && setEditing({ userId: row.userId, name: row.name, date: cell.date, cell })}
                      />
                    </td>
                  ))}
                  <td className="whitespace-nowrap border-b border-line px-3 py-2 text-right" title={`${row.present} present · ${row.leave} on leave · ${row.absent} absent · ${row.unrecorded} not recorded`}>
                    {row.workedHours !== null && row.expectedHours !== null ? (
                      <>
                        <div className="font-semibold tabular-nums text-success">{row.workedHours.toFixed(1)}</div>
                        <div className="text-[11px] tabular-nums text-subtle">/{row.expectedHours.toFixed(1)} h</div>
                      </>
                    ) : (
                      <>
                        <div className="font-semibold tabular-nums text-success">{row.present}</div>
                        <div className="text-[11px] tabular-nums text-subtle">/{row.workingDays} days</div>
                      </>
                    )}
                    {row.unrecorded > 0 && <div className="text-[10px] text-warning">{row.unrecorded} not recorded</div>}
                  </td>
                </tr>
              ))}
              {month.rows.length === 0 && (
                <tr>
                  <td colSpan={month.days.length + 2} className="px-4 py-8 text-center text-subtle">
                    Nobody to show for this month.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </ScrollX>
      </Card>

      {editing && <MarkDialog key={`${editing.userId}:${editing.date}`} editing={editing} canDelete={canDelete} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** One person's day: its mark, the timing beside it, and a hover saying it in words. */
function DayCell({ cell, canMark, time, onOpen }: { cell: Cell; canMark: boolean; time: (at: string) => string; onOpen: () => void }) {
  const mark = markOf(cell);
  const timing = (["late", "early", "overtime"] as const).filter((k) => cell[k]);
  const words = [
    `${cell.date} — ${mark ? mark.label : cell.future ? "Still to come" : "Not recorded"}`,
    cell.shiftCode ? `shift ${cell.shiftCode}` : null,
    cell.checkInAt ? `in ${time(cell.checkInAt)}${cell.checkOutAt ? `, out ${time(cell.checkOutAt)}` : ""}` : null,
    ...timing.map((k) => TIMING[k].label.toLowerCase()),
    cell.pending ? "a correction is waiting" : null,
    cell.shortLeave
      ? `short leave ${cell.shortLeave.words}${cell.shortLeave.approved ? (cell.shortLeave.excused ? ", excused the mark" : "") : ", waiting for approval"}`
      : null,
    cell.note,
    cell.regularised ? "corrected" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      type="button"
      disabled={!canMark}
      onClick={onOpen}
      title={words}
      aria-label={words}
      className={`flex h-12 w-full flex-col items-center justify-center gap-0.5 ${canMark ? "hover:bg-brand-subtle/60" : "cursor-default"}`}
    >
      <span className="flex items-center gap-0.5">
        {mark ? (
          <MarkIcon mark={mark} />
        ) : cell.future ? (
          <span className="h-2.5 w-2.5 rounded-full border border-line-strong" />
        ) : (
          <span className="h-4 w-4 rounded border border-dashed border-line-strong" />
        )}
        {timing.map((k) => {
          const t = TIMING[k];
          const Icon = t.icon;
          return <Icon key={k} className={`h-3 w-3 ${t.className}`} aria-hidden />;
        })}
      </span>
      {(cell.pending || cell.shortLeave) && (
        <span className="flex items-center gap-0.5">
          {cell.pending && <Hourglass className="h-3 w-3 text-subtle" aria-hidden />}
          {cell.shortLeave && (
            <SHORT_LEAVE.icon className={`h-3 w-3 ${cell.shortLeave.approved ? SHORT_LEAVE.approved : SHORT_LEAVE.waiting}`} aria-hidden />
          )}
        </span>
      )}
    </button>
  );
}

/** The month and year to show, and a step either way — the page's other filters kept. */
function MonthControls({ year, month }: { year: number; month: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const go = (m: number, y: number) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    next.set("month", String(m));
    next.set("year", String(y));
    router.push(`${pathname}?${next.toString()}`);
  };
  const step = (by: number) => {
    const index = year * 12 + (month - 1) + by;
    go((index % 12) + 1, Math.floor(index / 12));
  };
  const years = Array.from({ length: 6 }, (_, i) => year - 4 + i);

  return (
    <div className="flex items-center gap-2">
      <Select aria-label="Month" value={String(month)} onChange={(e) => go(Number(e.target.value), year)} className="w-36">
        {MONTH_NAMES.map((name, i) => (
          <option key={name} value={i + 1}>
            {name}
          </option>
        ))}
      </Select>
      <Select aria-label="Year" value={String(year)} onChange={(e) => go(month, Number(e.target.value))} className="w-28">
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </Select>
      <Button type="button" variant="secondary" size="sm" aria-label="Previous month" onClick={() => step(-1)}>
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <Button type="button" variant="secondary" size="sm" aria-label="Next month" onClick={() => step(1)}>
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}

/** The office hours the grid measures against, and — for whoever manages HR — the way to set them. */
function OfficeHoursLine({ hours, canSet }: { hours: OfficeHours | null; canSet: boolean }) {
  const [open, setOpen] = useState(false);
  if (!hours && !canSet) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
      {hours ? (
        <span>
          Office hours {clockWordsOfMinute(hours.startMinute)} – {clockWordsOfMinute(hours.endMinute)}, {hours.graceMinutes} minutes&apos; grace.
          Late, left early and overtime are measured against them; the total is hours worked of hours expected.
        </span>
      ) : (
        <span>Set the office hours to mark late, left early and overtime, and to total hours worked.</span>
      )}
      {canSet && (
        <button type="button" onClick={() => setOpen(true)} className="font-medium text-brand hover:underline">
          {hours ? "Change" : "Set office hours"}
        </button>
      )}
      {open && <OfficeHoursDialog hours={hours} onClose={() => setOpen(false)} />}
    </div>
  );
}

function OfficeHoursDialog({ hours, onClose }: { hours: OfficeHours | null; onClose: () => void }) {
  const router = useRouter();
  const [start, setStart] = useState(hours ? timeOfMinute(hours.startMinute) : "09:30");
  const [end, setEnd] = useState(hours ? timeOfMinute(hours.endMinute) : "18:30");
  const [grace, setGrace] = useState(String(hours?.graceMinutes ?? 15));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = (clear: boolean) =>
    startTransition(async () => {
      setError(null);
      const result = await saveOfficeHours(clear ? null : { start, end, grace: Number(grace) });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      router.refresh();
    });

  return (
    <Dialog open onClose={onClose} title="Office hours">
      <div className="space-y-4">
        <p className="text-sm text-muted">On the workspace&apos;s own clock. The grace is how late someone can be in, or early out, before it&apos;s marked.</p>
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="office-start">Starts</Label>
            <Input id="office-start" type="time" value={start} onChange={(e) => setStart(e.target.value)} disabled={pending} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="office-end">Ends</Label>
            <Input id="office-end" type="time" value={end} onChange={(e) => setEnd(e.target.value)} disabled={pending} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="office-grace">Grace (minutes)</Label>
            <Input id="office-grace" type="number" min={0} max={120} value={grace} onChange={(e) => setGrace(e.target.value)} disabled={pending} />
          </div>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <Button disabled={pending} onClick={() => save(false)}>
            {pending ? "Saving…" : "Save"}
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          {hours && (
            <Button variant="ghost" className="ml-auto text-danger" onClick={() => save(true)} disabled={pending}>
              Clear office hours
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** Today's clock, for the signed-in user. */
function ClockCard({ today }: { today: TodayRow }) {
  const clock = useClock();

  // The workspace's time of day, not the browser's.
  const time = (value: Date | string | null) => (value ? clock.time(value) : null);

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="text-sm">
          {today?.checkInAt ? (
            <span className="text-text">
              In at <span className="font-medium">{time(today.checkInAt)}</span>
              {today.checkOutAt && (
                <>
                  , out at <span className="font-medium">{time(today.checkOutAt)}</span>
                </>
              )}
            </span>
          ) : today?.status === "ON_LEAVE" || today?.status === "HALF_DAY" ? (
            <span className="text-muted">You&apos;re on approved leave today.</span>
          ) : (
            <span className="text-muted">You haven&apos;t clocked in today.</span>
          )}
        </div>

        <div className="flex gap-2">
          <ClockButtons today={today} />
        </div>
      </CardContent>
    </Card>
  );
}

function MarkDialog({
  editing,
  canDelete,
  onClose,
}: {
  editing: { userId: string; name: string; date: string; cell: Cell };
  canDelete: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [status, setStatus] = useState<string>(
    editing.cell.status ?? (editing.cell.offDay === "week off" ? "WEEK_OFF" : editing.cell.offDay ? "HOLIDAY" : "PRESENT"),
  );
  const [note, setNote] = useState(editing.cell.note ?? "");
  // Asked twice: the first press only asks.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // A restricted holiday and a short leave (owner, 26 Nov 2026): what the day offers besides its status.
  const [extras, setExtras] = useState<DayExtras | null>(null);
  const [shortOpen, setShortOpen] = useState(false);
  const [shortFrom, setShortFrom] = useState("");
  const [shortTo, setShortTo] = useState("");
  const [shortReason, setShortReason] = useState("");
  useEffect(() => {
    let live = true;
    dayExtras({ userId: editing.userId, date: editing.date }).then((r) => {
      if (live && r.ok) setExtras(r.data);
    });
    return () => {
      live = false;
    };
  }, [editing.userId, editing.date]);
  const rh = extras?.rh && "typeId" in extras.rh ? extras.rh : null;
  const offerRh = !!extras?.restricted && !!rh && !extras.rhTaken && rh.left >= 1;

  function remove() {
    if (!confirmingDelete) return setConfirmingDelete(true);
    setError(null);
    startTransition(async () => {
      const result = await deleteAttendanceDay({ userId: editing.userId, date: editing.date });
      if (!result.ok) {
        setError(result.error);
        setConfirmingDelete(false);
        return;
      }
      onClose();
      router.refresh();
    });
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const result =
        status === "RH"
          ? await recordRestrictedHoliday({ userId: editing.userId, date: editing.date, note })
          : await markAttendance({ userId: editing.userId, date: editing.date, status, note });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      router.refresh();
    });
  }

  function addShortLeave() {
    setError(null);
    startTransition(async () => {
      const result = await recordShortLeave({ userId: editing.userId, date: editing.date, from: shortFrom, to: shortTo, reason: shortReason });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      router.refresh();
    });
  }

  function dropShortLeave(id: string) {
    setError(null);
    startTransition(async () => {
      const result = await removeShortLeave({ userId: editing.userId, date: editing.date, id });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      router.refresh();
    });
  }

  return (
    <Dialog open onClose={onClose} title={`${editing.name} — ${editing.date}`}>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="attStatus">Status</Label>
          <Select id="attStatus" value={status} onChange={(e) => setStatus(e.target.value)}>
            {attendanceStatusValues.map((s) => (
              <option key={s} value={s}>
                {attendanceStatusLabels[s]}
              </option>
            ))}
            {offerRh && (
              <option value="RH">
                Restricted holiday (RH) — {rh.left} {rh.left === 1 ? "day" : "days"} left
              </option>
            )}
          </Select>
          {extras?.restricted && (
            <p className="text-xs text-subtle">
              {extras.rhTaken
                ? `Taken as a restricted holiday (${extras.restricted}). To undo it, cancel the leave under Leave.`
                : offerRh
                  ? `${extras.restricted} is a restricted holiday — RH takes one day from ${editing.name}'s ${rh.name}.`
                  : rh
                    ? `${extras.restricted} is a restricted holiday, but ${editing.name} has no ${rh.name} left this year.`
                    : `${extras.restricted} is a restricted holiday. ${extras.rh && "missing" in extras.rh ? extras.rh.missing : ""}`}
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="attNote">Note</Label>
          <Input id="attNote" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why it was corrected" />
        </div>

        {extras?.shortLeaveOn && (
          <div className="space-y-2 rounded-base border border-line px-3 py-2.5">
            {extras.shortLeave ? (
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-1.5 text-text">
                  <Timer className={`h-3.5 w-3.5 ${extras.shortLeave.approved ? "text-brand" : "text-subtle"}`} aria-hidden />
                  Short leave {extras.shortLeave.words}
                  <span className="text-xs text-subtle">{extras.shortLeave.approved ? "approved" : "waiting for approval"}</span>
                </span>
                <Button type="button" variant="ghost" size="sm" className="text-danger" disabled={pending} onClick={() => dropShortLeave(extras.shortLeave!.id)}>
                  Remove
                </Button>
              </div>
            ) : shortOpen ? (
              <div className="space-y-2">
                <p className="text-sm font-medium text-text">Short leave</p>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="shortFrom">From</Label>
                    <Input id="shortFrom" type="time" value={shortFrom} onChange={(e) => setShortFrom(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="shortTo">To</Label>
                    <Input id="shortTo" type="time" value={shortTo} onChange={(e) => setShortTo(e.target.value)} />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="shortReason">Reason</Label>
                  <Input id="shortReason" value={shortReason} maxLength={500} onChange={(e) => setShortReason(e.target.value)} placeholder="Doctor's appointment" />
                </div>
                <p className="text-xs text-subtle">Recorded as approved. It clears a Late or Left early mark it covers, and counts towards their short leaves this month.</p>
                <div className="flex gap-2">
                  <Button type="button" size="sm" disabled={pending || !shortFrom || !shortTo || !shortReason.trim()} onClick={addShortLeave}>
                    {pending ? "Saving…" : "Record short leave"}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setShortOpen(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setShortOpen(true)} className="flex items-center gap-1.5 text-sm font-medium text-brand hover:underline">
                <Timer className="h-3.5 w-3.5" aria-hidden />
                Add a short leave
              </button>
            )}
          </div>
        )}

        <ClockedFrom userId={editing.userId} date={editing.date} />

        <p className="text-xs text-subtle">
          Corrections are stamped with your name, so anyone asking later can see who changed it.
        </p>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex gap-2">
          <Button disabled={pending} onClick={submit}>
            {pending ? "Saving…" : status === "RH" ? "Record RH" : "Save"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {canDelete && editing.cell.status && (
            <Button variant={confirmingDelete ? "danger" : "ghost"} className={confirmingDelete ? "ml-auto" : "ml-auto text-danger"} disabled={pending} onClick={remove}>
              {confirmingDelete ? "Delete — sure?" : "Delete day"}
            </Button>
          )}
        </div>
        {confirmingDelete && (
          <p className="text-xs text-muted">
            The day goes back to not recorded, with where they clocked in from. A biometric terminal&apos;s own punches stay; reprocessing them writes the day again.
          </p>
        )}
      </div>
    </Dialog>
  );
}

function ClockedFrom({ userId, date }: { userId: string; date: string }) {
  const clock = useClock();
  const [places, setPlaces] = useState<Awaited<ReturnType<typeof attendanceLocations>> | null>(null);
  useEffect(() => {
    let live = true;
    attendanceLocations(userId, date).then(
      (rows) => live && setPlaces(rows),
      () => live && setPlaces([]),
    );
    return () => {
      live = false;
    };
  }, [userId, date]);
  if (!places || places.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium text-text">Where they clocked</p>
      <ul className="space-y-1 text-sm text-muted">
        {places.map((p) => (
          <li key={`${p.kind}-${p.at}`}>
            Clocked {p.kind === "IN" ? "in" : "out"} at {clock.time(p.at)}
            {p.accuracyM !== null ? ` (within ${p.accuracyM} m)` : ""}
            {p.latitude === null && p.check !== "EXCEPTION" ? " — no location shared" : ""}
            {p.latitude !== null && p.longitude !== null && (
              <>
                {" "}—{" "}
                <a className="text-brand hover:underline" href={`https://www.google.com/maps?q=${p.latitude},${p.longitude}`} target="_blank" rel="noopener noreferrer">
                  see on a map
                </a>
              </>
            )}
            {/* How it was checked against the office (src/lib/hr/clock.ts) — an exception is said as one, never as "at the office". */}
            {p.check === "INSIDE" && (
              <span className="ml-1 text-success">· at {p.office ?? "the office"}{p.distanceM !== null ? `, ${p.distanceM} m from its point` : ""}</span>
            )}
            {p.check === "EXCEPTION" && (
              <span className="ml-1 text-warning">
                · under an approved exception{p.exceptionReason ? ` (${p.exceptionReason})` : ""}
                {p.distanceM !== null ? `, ${p.distanceM} m from ${p.office ?? "the office"}` : ", no location"}
              </span>
            )}
            {p.check === "NOT_ENFORCED" && p.distanceM !== null && <span className="ml-1">· {p.distanceM} m from {p.office ?? "the office"}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
