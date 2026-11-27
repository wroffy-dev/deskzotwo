"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { ChevronLeft, ChevronRight, Globe2 } from "lucide-react";
import { Select } from "@/components/ui/input";
import { zoneOptions } from "@/lib/time/zones";

/**
 * Picking a time (owner, 18 Nov 2026 — Dreamteam's scheduler): five days at a time with arrows, the zone the times are
 * shown in — the visitor's own to start with, theirs to change — and the day's times as a grid. Slots are instants; how
 * they fall into days depends on the zone, so they are grouped here.
 */
const PER_ROW = 5;
const noSubscribe = () => () => {};

export function SlotPicker({ slots, zone, onZone, onPick, picked }: { slots: string[]; zone: string; onZone: (zone: string) => void; onPick: (slot: string) => void; picked?: string | null }) {
  const days = useMemo(() => {
    const key = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: zone });
    const map = new Map<string, string[]>();
    for (const s of slots) {
      const k = key.format(new Date(s));
      map.set(k, [...(map.get(k) ?? []), s]);
    }
    return [...map].map(([day, list]) => ({ day, slots: list.sort() }));
  }, [slots, zone]);
  const [from, setFrom] = useState(0);
  const [day, setDay] = useState<string | null>(null);
  const shown = days.slice(from, from + PER_ROW);
  const current = days.find((d) => d.day === day) ?? shown[0] ?? days[0];
  // The full list only in the browser: its zones and names can differ from the server's, which would break hydration.
  const inBrowser = useSyncExternalStore(noSubscribe, () => true, () => false);
  const zones = useMemo(() => {
    const all = inBrowser ? zoneOptions() : [];
    return all.some((z) => z.zone === zone) ? all : [{ zone, label: zone.replace(/_/g, " "), offsetMinutes: 0 }, ...all];
  }, [zone, inBrowser]);

  const weekday = (iso: string) => new Intl.DateTimeFormat("en-IN", { weekday: "short", timeZone: zone }).format(new Date(iso));
  const date = (iso: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", timeZone: zone }).format(new Date(iso));
  const month = (iso: string) => new Intl.DateTimeFormat("en-IN", { month: "short", timeZone: zone }).format(new Date(iso));
  const time = (iso: string) => new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: zone }).format(new Date(iso));

  return (
    <div className="space-y-3.5">
      <h2 className="text-base font-semibold text-text">Pick a slot that suits you</h2>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Earlier days"
          disabled={from === 0}
          onClick={() => setFrom(Math.max(0, from - PER_ROW))}
          className="rounded-full p-1.5 text-muted hover:bg-surface-sunken disabled:opacity-30"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="grid flex-1 grid-cols-5 gap-2">
          {shown.map((d) => {
            const on = d.day === current?.day;
            return (
              <button
                key={d.day}
                type="button"
                aria-pressed={on}
                onClick={() => setDay(d.day)}
                className={`flex flex-col items-center rounded-lg border px-1 py-1.5 text-center ${on ? "border-brand bg-brand text-white" : "border-line bg-surface text-text hover:border-brand"}`}
              >
                <span className={`text-xs ${on ? "text-white/80" : "text-muted"}`}>{weekday(d.slots[0]!)}</span>
                <span className="text-base font-semibold leading-tight">{date(d.slots[0]!)}</span>
                <span className={`text-xs ${on ? "text-white/80" : "text-muted"}`}>{month(d.slots[0]!)}</span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          aria-label="Later days"
          disabled={from + PER_ROW >= days.length}
          onClick={() => setFrom(from + PER_ROW)}
          className="rounded-full p-1.5 text-muted hover:bg-surface-sunken disabled:opacity-30"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>
      <label className="flex items-center gap-2 text-sm text-muted">
        <Globe2 className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="sr-only">Time zone</span>
        <Select value={zone} onChange={(e) => onZone(e.target.value)} className="max-w-full">
          {zones.map((z) => (
            <option key={z.zone} value={z.zone}>
              {z.label}
            </option>
          ))}
        </Select>
      </label>
      {current && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {current.slots.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={s === picked}
              onClick={() => onPick(s)}
              className={`rounded-lg border px-2 py-2 text-sm tabular-nums ${s === picked ? "border-brand bg-brand-subtle font-medium text-brand" : "border-line bg-surface text-text hover:border-brand hover:text-brand"}`}
            >
              {time(s)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
