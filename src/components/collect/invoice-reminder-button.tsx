"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Mail } from "lucide-react";
import { invoiceReminderDraft, remindInvoiceNow, type InvoiceReminderDraft } from "@/actions/payment-reminders";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { CcField } from "@/components/mail/cc-field";

/**
 * "Mail reminder" in an open invoice's What's next box (owner, 6 Nov 2026 — "mail button here for payment followup"): the
 * reminder whose day has come, read and changed if need be, then sent there and then with the invoice attached, from
 * whoever Settings › Payment collection says.
 */
export function InvoiceReminderButton({ documentId }: { documentId: string }) {
  const router = useRouter();
  const [draft, setDraft] = useState<InvoiceReminderDraft | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [cc, setCc] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const open = () =>
    start(async () => {
      setError(null);
      setSentTo(null);
      const r = await invoiceReminderDraft(documentId);
      if (!r.ok) return setError(r.error);
      setDraft(r.data);
      setSubject(r.data.subject);
      setBody(r.data.body);
      setCc("");
    });

  const send = () =>
    start(async () => {
      setError(null);
      const r = await remindInvoiceNow(documentId, { subject, body, cc });
      if (!r.ok) return setError(r.error);
      setDraft(null);
      setSentTo(r.data.sentTo);
      router.refresh();
    });

  return (
    <>
      <Button size="sm" variant="secondary" disabled={pending} onClick={open}>
        <Mail className="mr-1.5 h-3.5 w-3.5" aria-hidden /> {pending && !draft ? "Getting it ready…" : "Mail reminder"}
      </Button>
      {sentTo && <span className="text-xs text-success">Sent to {sentTo}.</span>}
      {error && !draft && <p className="w-full text-xs text-danger">{error}</p>}
      <Dialog open={!!draft} onClose={() => setDraft(null)} title="Mail a payment reminder" large>
        {draft && (
          <div className="space-y-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted">From</dt>
              <dd className="text-text">{draft.from}</dd>
              <dt className="text-muted">To</dt>
              <dd className="text-text">{draft.to.length ? draft.to.join(", ") : "Nobody at the customer can be emailed"}</dd>
              <dt className="text-muted">Reminder</dt>
              <dd className="text-text">
                {draft.stepLabel} · {draft.balance} left
              </dd>
            </dl>
            {draft.paused && <p className="rounded-base bg-warning-bg px-3 py-2 text-xs text-warning">Reminders to this customer are paused: {draft.paused}. Sending this goes ahead anyway.</p>}
            <CcField id="ir-cc" value={cc} onChange={setCc} disabled={pending} />
            <div className="space-y-1.5">
              <Label htmlFor="ir-subject">Subject</Label>
              <Input id="ir-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ir-body">Message</Label>
              <Textarea id="ir-body" rows={12} value={body} onChange={(e) => setBody(e.target.value)} className="font-mono text-xs" />
            </div>
            <p className="text-xs text-subtle">The invoice goes attached. Anything in {"{{ }}"} is filled in as it goes: the balance, the days late, and the pay-now link where a gateway is connected.</p>
            {error && <p className="text-sm text-danger">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button disabled={pending || !subject.trim() || !body.trim() || draft.to.length === 0} onClick={send}>
                {pending ? "Sending…" : "Send reminder"}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
