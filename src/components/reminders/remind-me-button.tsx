"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BellPlus, BellRing } from "lucide-react";
import { clearRenewalReminder, setRenewalReminder } from "@/actions/renewal-reminder";
import { clearLeadReminder, setLeadReminder } from "@/actions/lead-reminder";
import { clearPaymentReminder, setPaymentReminder } from "@/actions/payment-reminder";
import { clearCollectionReminder, setCollectionReminder } from "@/actions/collection-reminder";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const shortDay = (day: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));

type Target =
  | { kind: "renewal"; orderId: string; endDate: string | Date | null }
  | { kind: "lead"; leadId: string }
  // An order still owing money (owner, 3 Nov 2026 — src/lib/payment-reminders.ts).
  | { kind: "payment"; orderId: string }
  // A customer who owes money, on Receivables (owner, 3 Nov 2026 — src/lib/collection-reminders.ts).
  | { kind: "collection"; companyId: string };

/**
 * "Remind me" on a renewal or a lead (owner, 31 Oct 2026): a day and a note, for the person pressing it — their task for
 * that day (src/lib/renewal-reminders.ts, src/lib/lead-reminders.ts), so the bell rings then. Once set, the button
 * shows the day; pressing it again changes it or marks it done. `look`: an icon in a row, or a button on a record's page.
 */
export function RemindMeButton({ target, label, reminder, look = "icon" }: { target: Target; label: string; reminder: { remindOn: string | null; note: string | null } | null; look?: "icon" | "button" }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const id = target.kind === "lead" ? target.leadId : target.kind === "collection" ? target.companyId : target.orderId;

  const today = new Date();
  const end = target.kind === "renewal" && target.endDate ? new Date(target.endDate) : null;
  const quick: { label: string; day: string }[] = [
    { label: "Tomorrow", day: ymd(addDays(today, 1)) },
    ...(target.kind !== "renewal" ? [{ label: "In 3 days", day: ymd(addDays(today, 3)) }] : []),
    { label: "In a week", day: ymd(addDays(today, 7)) },
    ...(target.kind === "lead" ? [{ label: "In 2 weeks", day: ymd(addDays(today, 14)) }] : []),
    ...(end && addDays(end, -30) > today ? [{ label: "30 days before it ends", day: ymd(addDays(end, -30)) }] : []),
    ...(end && addDays(end, -7) > today ? [{ label: "A week before it ends", day: ymd(addDays(end, -7)) }] : []),
  ];

  function show() {
    setError(null);
    setDay(reminder?.remindOn ?? ymd(addDays(today, target.kind === "renewal" ? 7 : 3)));
    setNote(reminder?.note ?? "");
    setOpen(true);
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const done =
        target.kind === "renewal"
          ? await setRenewalReminder({ orderId: target.orderId, remindOn: day, note })
          : target.kind === "payment"
            ? await setPaymentReminder({ orderId: target.orderId, remindOn: day, note })
            : target.kind === "collection"
              ? await setCollectionReminder({ companyId: target.companyId, remindOn: day, note })
              : await setLeadReminder({ leadId: target.leadId, remindOn: day, note });
      if (!done.ok) return setError(done.error);
      setOpen(false);
      router.refresh();
    });
  }

  function clear() {
    setError(null);
    startTransition(async () => {
      const done =
        target.kind === "renewal"
          ? await clearRenewalReminder(target.orderId)
          : target.kind === "payment"
            ? await clearPaymentReminder(target.orderId)
            : target.kind === "collection"
              ? await clearCollectionReminder(target.companyId)
              : await clearLeadReminder(target.leadId);
      if (!done.ok) return setError(done.error);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      {reminder?.remindOn ? (
        <button
          type="button"
          onClick={show}
          title={reminder.note ? `Your reminder: ${reminder.note}` : "Your reminder"}
          className={`inline-flex items-center gap-1 rounded-base bg-brand-subtle font-medium text-brand hover:bg-brand/15 ${look === "button" ? "h-9 px-3 text-sm" : "h-8 px-2 text-xs"}`}
        >
          <BellRing className="h-3.5 w-3.5" />
          {look === "button" ? `Reminder ${shortDay(reminder.remindOn)}` : shortDay(reminder.remindOn)}
        </button>
      ) : look === "button" ? (
        <Button type="button" variant="secondary" onClick={show}>
          <BellPlus className="mr-1.5 h-3.5 w-3.5" />
          Remind me
        </Button>
      ) : (
        <Button type="button" variant="ghost" size="icon" onClick={show} title="Remind me" aria-label={`Remind me about ${label}`}>
          <BellPlus className="h-4 w-4" />
        </Button>
      )}
      <Dialog open={open} onClose={() => setOpen(false)} title="Remind me">
        <div className="space-y-3">
          <p className="text-sm text-muted">{label}</p>
          <div className="flex flex-wrap gap-1.5">
            {quick.map((q) => (
              <button
                key={q.label}
                type="button"
                onClick={() => setDay(q.day)}
                className={`rounded-full border px-2.5 py-1 text-xs ${day === q.day ? "border-brand bg-brand-subtle text-brand" : "border-line text-muted hover:text-text"}`}
              >
                {q.label}
              </button>
            ))}
          </div>
          <div>
            <Label htmlFor={`remind-day-${id}`}>On</Label>
            <Input id={`remind-day-${id}`} type="date" value={day} min={ymd(today)} onChange={(e) => setDay(e.target.value)} className="w-44" />
          </div>
          <div>
            <Label htmlFor={`remind-note-${id}`}>Note</Label>
            <Textarea id={`remind-note-${id}`} rows={3} value={note} placeholder={target.kind === "lead" ? "Follow up on the quote they asked for" : "Call Ravi after their budget meeting"} onChange={(e) => setNote(e.target.value)} />
          </div>
          <p className="text-xs text-subtle">On that day it rings your bell and sits in My tasks.</p>
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
          <div className="flex items-center justify-between gap-2">
            <div>
              {reminder && (
                <Button type="button" variant="ghost" size="sm" onClick={clear} disabled={pending}>
                  Done — clear it
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </Button>
              <Button type="button" size="sm" onClick={save} disabled={pending || !day}>
                {pending ? "Saving…" : reminder ? "Change reminder" : "Remind me"}
              </Button>
            </div>
          </div>
        </div>
      </Dialog>
    </>
  );
}
