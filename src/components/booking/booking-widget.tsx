"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { ChevronLeft, ChevronRight, Clock, Globe2, Video } from "lucide-react";
import { makeBooking } from "@/actions/booking-public";
import type { BookedView, PublicBookingPage } from "@/lib/booking/server";
import type { AnswerValue, Answers } from "@/lib/projects/questionnaire";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { PhoneInput } from "@/components/ui/phone-input";
import { QuestionField } from "@/components/forms/question-field";
import { BookingConfirmation } from "@/components/booking/booking-confirmation";
import { SlotPicker } from "@/components/booking/slot-picker";
import { canonicalZone } from "@/lib/time/zones";

const noSubscribe = () => () => {};
function ownZone(): string | null {
  try {
    // Under its current name — a browser may say "Asia/Calcutta" for "Asia/Kolkata".
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone ? canonicalZone(zone) : null;
  } catch {
    return null;
  }
}

/**
 * The public side of a booking page (src/lib/booking), in three steps (owner, 18 Nov 2026 — Dreamteam's scheduler):
 * pick a slot, in the visitor's own time zone; who you are, with the page's own questions; then the confirmation, with
 * Reschedule, Cancel and Invite a colleague. A field no person sees, and how long the page was open, are sent so a robot
 * is thanked and dropped (src/actions/booking-public.ts). In a website's pop-up (`embedded`) it tells the page it was
 * booked; `prefill` is what that page already knew — the email typed in its hero.
 */
export function BookingWidget({ page, embedded = false, prefill }: { page: PublicBookingPage; embedded?: boolean; prefill?: { name?: string; email?: string; ref?: string } }) {
  const opened = useRef<number | null>(null);
  const [isPending, startTransition] = useTransition();
  // The visitor's own zone once the browser says one; the workspace's before (and on the server).
  const browserZone = useSyncExternalStore(noSubscribe, ownZone, () => null);
  const [picked, setZone] = useState<string | null>(null);
  const zone = picked ?? browserZone ?? page.zone;
  const [slot, setSlot] = useState<string | null>(null);
  const [form, setForm] = useState({ name: prefill?.name ?? "", email: prefill?.email ?? "", phone: "", company: "", notes: "", website: "" });
  const [answers, setAnswers] = useState<Answers>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<BookedView | null>(null);

  useEffect(() => {
    opened.current = Date.now();
  }, []);

  const slots = useMemo(() => page.days.flatMap((d) => d.slots), [page.days]);
  const when = (iso: string) =>
    new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: zone }).format(new Date(iso));

  if (done) {
    return (
      <Shell embedded={embedded}>
        <BookingConfirmation booked={done} title={page.title} ourName={page.ourName} guest={{ name: form.name, email: form.email }} zone={zone} />
      </Shell>
    );
  }

  function book() {
    if (!slot) return;
    setError(null);
    setErrors({});
    startTransition(async () => {
      const result = await makeBooking(page.slug, { start: slot, ...form, answers, zone, elapsedMs: opened.current === null ? undefined : Date.now() - opened.current, ...(prefill?.ref ? { ref: prefill.ref } : {}) });
      if (!result.ok) {
        setError(result.error);
        setErrors(result.errors ?? {});
        return;
      }
      setDone(result.data);
      if (embedded) {
        try {
          window.parent.postMessage({ type: "deskzo-booking-done" }, "*");
        } catch {
          /* not in a frame after all */
        }
      }
    });
  }

  return (
    <Shell embedded={embedded}>
      <header className="space-y-1.5 pr-8">
        {page.ourName && <p className="text-sm font-medium text-muted">{page.ourName}</p>}
        <h1 className="text-xl font-semibold tracking-tight text-text sm:text-2xl">{slot ? "Tell us a little about you" : page.title}</h1>
        {!slot && page.description && <p className="line-clamp-2 whitespace-pre-line text-sm text-muted">{page.description}</p>}
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
          <span className="inline-flex items-center gap-1.5">
            <Clock className="h-4 w-4" aria-hidden="true" />
            {page.durationMinutes} min
          </span>
          {page.online && (
            <span className="inline-flex items-center gap-1.5">
              <Video className="h-4 w-4" aria-hidden="true" />
              Online meeting
            </span>
          )}
        </p>
      </header>

      {!slot ? (
        slots.length === 0 ? (
          <p className="rounded-md bg-surface-sunken px-3 py-4 text-sm text-muted">No times are free just now. Try again in a day or two.</p>
        ) : (
          <SlotPicker slots={slots} zone={zone} onZone={setZone} onPick={setSlot} />
        )
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            book();
          }}
        >
          <div className="flex items-center justify-between gap-3 rounded-lg bg-brand-subtle px-4 py-3">
            <div>
              <p className="text-sm font-medium text-brand">{page.title}</p>
              <p className="text-sm text-text">{when(slot)}</p>
              <p className="inline-flex items-center gap-1 text-xs text-muted">
                <Globe2 className="h-3 w-3" aria-hidden="true" />
                {zone.replace(/_/g, " ")}
              </p>
            </div>
            <button type="button" onClick={() => setSlot(null)} className="inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline">
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              Change
            </button>
          </div>
          {error && (
            <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="booking-name">Your name *</Label>
              <Input id="booking-name" required maxLength={120} autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="booking-email">Work email *</Label>
              <Input id="booking-email" type="email" required maxLength={254} autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="booking-company">Company</Label>
              <Input id="booking-company" maxLength={200} autoComplete="organization" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="booking-phone">Phone</Label>
              <PhoneInput id="booking-phone" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
            </div>
          </div>
          {page.questions.length > 0 && (
            <div className="space-y-4">
              {page.questions.map((q) => (
                <QuestionField
                  key={q.key}
                  q={q}
                  value={answers[q.key]}
                  error={errors[q.key]}
                  onChange={(v: AnswerValue | undefined) => setAnswers((all) => ({ ...all, [q.key]: v as AnswerValue }))}
                  uploading={false}
                  onAttach={() => {}}
                  onRemoveFile={() => {}}
                />
              ))}
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="booking-notes">Anything that would help us prepare?</Label>
            <Textarea id="booking-notes" rows={3} maxLength={1000} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          {/* Left empty by people, who never see it. */}
          <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
            <label htmlFor="booking-website">Website</label>
            <input id="booking-website" tabIndex={-1} autoComplete="off" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={isPending || !form.name.trim() || !form.email.trim()}>
              {isPending ? "Booking…" : "Confirm booking"}
              {!isPending && <ChevronRight className="ml-1 h-4 w-4" aria-hidden="true" />}
            </Button>
          </div>
        </form>
      )}
    </Shell>
  );
}

/** The card it sits in — none in a website's pop-up, whose frame is the card. */
export function Shell({ embedded, children }: { embedded: boolean; children: React.ReactNode }) {
  if (embedded) return <EmbeddedShell>{children}</EmbeddedShell>;
  return <Card className="mx-auto max-w-2xl space-y-5 px-6 py-6 sm:px-8">{children}</Card>;
}

/**
 * In a website's pop-up (src/lib/booking/embed.ts) the frame is the card: the public pages' own padding is left behind,
 * and the page tells the pop-up how tall it is as that changes, so the pop-up is as tall as what it holds — no empty space
 * under a day's times, no scrolling unless the screen is too short (owner, 18 Nov 2026).
 */
function EmbeddedShell({ children }: { children: React.ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = inner.current;
    if (!el || window.parent === window) return;
    const tell = () => window.parent.postMessage({ type: "deskzo-booking-size", height: Math.ceil(el.getBoundingClientRect().height) }, "*");
    tell();
    const watch = new ResizeObserver(tell);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  return (
    <div className="fixed inset-0 overflow-y-auto bg-surface">
      <div ref={inner} className="space-y-4 px-6 py-5 sm:px-8">
        {children}
      </div>
    </div>
  );
}
