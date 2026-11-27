"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cancelMyBooking, moveMyBooking } from "@/actions/booking-public";
import type { ManagedBooking } from "@/lib/booking/manage";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { BookingConfirmation } from "@/components/booking/booking-confirmation";
import { SlotPicker } from "@/components/booking/slot-picker";
import { Shell } from "@/components/booking/booking-widget";

/**
 * The guest's own booking (src/lib/booking/manage.ts): the confirmation as it stands, and from it a new time with the
 * same host, a cancellation with a reason if they give one, or a colleague invited.
 */
export function ManageBooking({ token, booking, start }: { token: string; booking: ManagedBooking; start: "move" | "cancel" | null }) {
  const router = useRouter();
  const open = booking.status === "CONFIRMED" && !booking.past;
  const [mode, setMode] = useState<"view" | "move" | "cancel">(open && start ? start : "view");
  const [zone, setZone] = useState(booking.guestZone);
  const [slot, setSlot] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, run] = useTransition();
  const slots = booking.days.flatMap((d) => d.slots);
  const when = (iso: string) =>
    new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", timeZone: zone }).format(new Date(iso));

  function move() {
    if (!slot) return;
    setError(null);
    run(async () => {
      try {
        const r = await moveMyBooking(token, slot);
        if (!r.ok) return void setError(r.error);
        setMode("view");
        setSlot(null);
        router.refresh();
      } catch {
        setError("That didn't go through — try again.");
      }
    });
  }

  function cancel() {
    setError(null);
    run(async () => {
      try {
        const r = await cancelMyBooking(token, reason);
        if (!r.ok) return void setError(r.error);
        setMode("view");
        router.refresh();
      } catch {
        setError("That didn't go through — try again.");
      }
    });
  }

  return (
    <Shell embedded={false}>
      <header className="space-y-1">
        {booking.ourName && <p className="text-sm font-medium text-muted">{booking.ourName}</p>}
        <h1 className="text-2xl font-semibold tracking-tight text-text">{mode === "move" ? "Pick a new time" : mode === "cancel" ? "Cancel this meeting?" : booking.title}</h1>
        {booking.past && booking.status === "CONFIRMED" && <p className="text-sm text-muted">This meeting has already happened.</p>}
      </header>

      {error && (
        <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {mode === "view" && (
        <BookingConfirmation
          booked={booking}
          title={booking.title}
          ourName={booking.ourName}
          guest={{ name: booking.guestName, email: booking.guestEmail }}
          zone={zone}
          guests={booking.guests}
          cancelled={booking.status === "CANCELLED"}
          onReschedule={open ? () => setMode("move") : undefined}
          onCancel={open ? () => setMode("cancel") : undefined}
        />
      )}

      {mode === "move" && (
        <div className="space-y-4">
          {slots.length === 0 ? (
            <p className="rounded-md bg-surface-sunken px-3 py-4 text-sm text-muted">No other times are free with {booking.host} just now. Reply to the invitation to find one.</p>
          ) : (
            <SlotPicker slots={slots} zone={zone} onZone={setZone} onPick={setSlot} picked={slot} />
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {slot && <span className="mr-auto text-sm text-text">{when(slot)}</span>}
            <Button variant="ghost" disabled={pending} onClick={() => setMode("view")}>
              Keep the current time
            </Button>
            <Button disabled={pending || !slot} onClick={move}>
              {pending ? "Moving…" : "Move it here"}
            </Button>
          </div>
        </div>
      )}

      {mode === "cancel" && (
        <div className="space-y-3">
          <p className="text-sm text-text">
            {booking.title} with {booking.host}, {when(booking.startsAt!)}. {booking.host} is told, and it comes out of their calendar.
          </p>
          <Textarea rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="A reason, if you'd like to give one" aria-label="Reason" />
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" disabled={pending} onClick={() => setMode("view")}>
              Keep it
            </Button>
            <Button variant="danger" disabled={pending} onClick={cancel}>
              {pending ? "Cancelling…" : "Cancel the meeting"}
            </Button>
          </div>
        </div>
      )}
    </Shell>
  );
}
