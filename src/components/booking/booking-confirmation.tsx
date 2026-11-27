"use client";

import { useState, useTransition } from "react";
import { CalendarDays, Clock, UserPlus, Video } from "lucide-react";
import { inviteToMyBooking } from "@/actions/booking-public";
import type { BookedView } from "@/lib/booking/server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * "Your meeting is confirmed" (owner, 18 Nov 2026 — Dreamteam's confirmation): who with, when in the guest's zone, the
 * meeting link once the calendar made one, who is coming, and the guest's own Reschedule, Cancel and Invite a colleague
 * — the last three through the booking's manage link (src/lib/booking/manage.ts), when it has one.
 */
export function BookingConfirmation({
  booked,
  title,
  ourName,
  guest,
  zone,
  guests: initialGuests = [],
  onReschedule,
  onCancel,
  cancelled = false,
}: {
  booked: BookedView;
  title: string;
  ourName: string;
  guest: { name: string; email: string };
  zone: string;
  guests?: { email: string; name: string | null }[];
  /** On the manage page: move it there. Elsewhere the button opens the manage page. */
  onReschedule?: () => void;
  onCancel?: () => void;
  cancelled?: boolean;
}) {
  const [guests, setGuests] = useState(initialGuests);
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // A robot's booking, thanked and dropped, has no time to show.
  if (!booked.startsAt) {
    return (
      <div className="py-6 text-center">
        <h1 className="text-lg font-semibold text-text">Thank you</h1>
      </div>
    );
  }
  const startsAt = new Date(booked.startsAt);
  const endsAt = new Date(booked.endsAt ?? booked.startsAt);
  const day = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: zone }).format(startsAt);
  const weekday = new Intl.DateTimeFormat("en-IN", { weekday: "long", timeZone: zone }).format(startsAt);
  const time = (d: Date) => new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: zone }).format(d);
  const manageHref = booked.manage ? `/book/manage/${booked.manage}` : null;
  const initial = (booked.host || ourName).trim().charAt(0).toUpperCase() || "?";
  const people = [{ name: booked.host, email: null as string | null }, { name: guest.name, email: guest.email }, ...guests.map((g) => ({ name: g.name ?? g.email, email: g.email }))];

  function invite() {
    if (!booked.manage) return;
    setError(null);
    start(async () => {
      try {
        const r = await inviteToMyBooking(booked.manage!, { email });
        if (!r.ok) return void setError(r.error);
        setGuests(r.data.guests);
        setEmail("");
        setAdding(false);
      } catch {
        setError("That didn't go through — try again.");
      }
    });
  }

  return (
    <div className="space-y-5">
      <div className="overflow-hidden rounded-xl border border-line">
        <div className="grid sm:grid-cols-2">
          <div className="flex flex-col items-center justify-center gap-2 border-b border-dashed border-line px-6 py-7 text-center sm:border-b-0 sm:border-r">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-brand text-2xl font-semibold text-white">{initial}</span>
            <p className="text-sm text-muted">{cancelled ? "Your meeting was cancelled with" : "Your meeting is confirmed with"}</p>
            <p className="text-base font-semibold text-text">{booked.host}</p>
          </div>
          <div className="space-y-4 px-6 py-7">
            <p className="flex items-start gap-2.5">
              <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
              <span>
                <span className={`block font-semibold text-text ${cancelled ? "line-through" : ""}`}>{day}</span>
                <span className="text-sm text-muted">{weekday}</span>
              </span>
            </p>
            <p className="flex items-start gap-2.5">
              <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
              <span>
                <span className={`block font-semibold tabular-nums text-text ${cancelled ? "line-through" : ""}`}>
                  {time(startsAt)} – {time(endsAt)}
                </span>
                <span className="text-sm text-muted">{zone.replace(/_/g, " ")}</span>
              </span>
            </p>
            {!cancelled && manageHref && (
              <div className="flex flex-wrap gap-2">
                {onReschedule ? (
                  <Button size="sm" variant="secondary" onClick={onReschedule}>
                    Reschedule
                  </Button>
                ) : (
                  <a href={`${manageHref}?move=1`} className="inline-flex h-8 items-center rounded-base bg-surface-sunken px-3 text-sm font-medium text-text hover:bg-line">
                    Reschedule
                  </a>
                )}
                {onCancel ? (
                  <Button size="sm" variant="ghost" onClick={onCancel}>
                    Cancel
                  </Button>
                ) : (
                  <a href={`${manageHref}?cancel=1`} className="inline-flex h-8 items-center rounded-base px-3 text-sm text-muted hover:text-danger">
                    Cancel
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
        {!cancelled && (
          <div className="flex items-center justify-center gap-2 border-t border-line bg-surface-sunken px-4 py-2.5 text-sm text-muted">
            <Video className="h-4 w-4" aria-hidden="true" />
            {booked.joinUrl ? (
              <a href={booked.joinUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-brand hover:underline">
                Join the meeting
              </a>
            ) : booked.invited ? (
              <span>{title} — the invitation is on its way to {guest.email}.</span>
            ) : (
              <span>{title} — it&apos;s in {booked.host}&apos;s calendar.</span>
            )}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-subtle">Participants</p>
        <div className="flex flex-wrap gap-2">
          {people.map((p, i) => (
            <span key={`${p.email ?? p.name}:${i}`} className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-1 py-1 pr-3 text-sm">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-subtle text-xs font-semibold text-brand">{(p.name || "?").charAt(0).toUpperCase()}</span>
              <span className="font-medium text-text">{p.name}</span>
              {p.email && <span className="text-muted">{p.email}</span>}
            </span>
          ))}
          {!cancelled && booked.manage && guests.length < 3 && !adding && (
            <button type="button" onClick={() => setAdding(true)} className="inline-flex items-center gap-1.5 rounded-full bg-surface-sunken px-3 py-1.5 text-sm font-medium text-text hover:bg-line">
              <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
              Invite a colleague
            </button>
          )}
        </div>
        {adding && (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              invite();
            }}
          >
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="colleague@company.com" aria-label="Colleague's email" className="w-64 max-w-full" />
            <Button type="submit" size="sm" disabled={pending || !email.trim()}>
              {pending ? "Inviting…" : "Invite"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Not now
            </Button>
          </form>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
