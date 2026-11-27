"use client";

import { useState, useTransition } from "react";
import { CompanyLink } from "@/components/companies/company-link";
import { useRouter } from "next/navigation";
import { AlarmClock, Pencil, Send, SkipForward } from "lucide-react";
import { sendAwaitingReminder, skipAwaitingReminder, snoozeAwaitingReminder, type AwaitingReminder } from "@/actions/payment-reminders";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { CcField } from "@/components/mail/cc-field";
import { ActionNotice } from "@/components/ui/action-notice";
import { companyPath } from "@/lib/record-links";

/**
 * Receivables › Reminders to send (owner, 3 Nov 2026 — src/actions/payment-reminders.ts): the steps marked "Review first",
 * each with Send, Edit then send, Skip and Snooze a week. The words are the step's own — {{fields}} filled as it goes.
 */
export function RemindersQueue({ rows }: { rows: AwaitingReminder[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<AwaitingReminder | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [cc, setCc] = useState("");
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();

  const act = (fn: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, done: string) =>
    start(async () => {
      const r = await fn();
      setNotice(r.ok ? { tone: "success", text: done } : { tone: "error", text: r.error });
      if (r.ok) {
        setEditing(null);
        router.refresh();
      }
    });

  if (rows.length === 0) return <Card className="p-8 text-center text-sm text-subtle">Nothing waiting. Steps marked &ldquo;Review first&rdquo; in Settings › Payment collection come here instead of going by themselves.</Card>;

  return (
    <div className="space-y-3">
      {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[880px] text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs font-medium text-muted">
            <tr>
              <th className="px-4 py-2">Customer · invoice</th>
              <th className="px-4 py-2">Step</th>
              <th className="px-4 py-2">Overdue</th>
              <th className="px-4 py-2 text-right">Still to pay</th>
              <th className="px-4 py-2">Subject</th>
              <th className="px-4 py-2 text-right">Decide</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const snoozed = r.snoozedNow;
              return (
                <tr key={r.key} className={`border-b border-line align-top last:border-0 ${snoozed ? "opacity-60" : ""}`}>
                  <td className="px-4 py-2.5">
                    <CompanyLink href={`${companyPath(r.companySeq)}?tab=statement`} className="font-medium text-text hover:underline">
                      {r.companyName}
                    </CompanyLink>
                    <span className="block text-xs text-subtle">
                      {r.docNumber ?? "Invoice"} · due {r.dueDate}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="text-text">{r.stepLabel}</span>
                    <span className="mt-0.5 block">
                      <Badge tone={r.tone === "final" ? "red" : r.tone === "firm" ? "amber" : "default"}>{r.tone === "final" ? "Final" : r.tone === "firm" ? "Firm" : "Friendly"}</Badge>
                      {r.edited && <Badge className="ml-1">Edited</Badge>}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-muted">{r.daysOverdue > 0 ? `${r.daysOverdue} days` : r.daysOverdue === 0 ? "Due today" : `Due in ${-r.daysOverdue} days`}</td>
                  <td className="px-4 py-2.5 text-right font-medium text-text">{r.balance}</td>
                  <td className="max-w-xs px-4 py-2.5 text-xs text-muted">
                    {r.preview}
                    {snoozed && <span className="mt-0.5 block text-[11px] text-subtle">Snoozed till {new Date(r.snoozedUntil!).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right">
                    <div className="inline-flex items-center gap-1">
                      <Button size="sm" disabled={pending} onClick={() => act(() => sendAwaitingReminder(r.key), `Sent to ${r.companyName}.`)}>
                        <Send className="mr-1 h-3.5 w-3.5" /> Send
                      </Button>
                      <Button size="sm" variant="secondary" disabled={pending} onClick={() => (setEditing(r), setSubject(r.subject), setBody(r.body), setCc(""), setNotice(null))} title="Edit then send">
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="secondary" disabled={pending} onClick={() => act(() => snoozeAwaitingReminder(r.key), "Snoozed a week.")} title="Snooze a week">
                        <AlarmClock className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="secondary" disabled={pending} onClick={() => act(() => skipAwaitingReminder(r.key), "Skipped — later steps will still go.")} title="Skip this step for this invoice">
                        <SkipForward className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <Dialog open={!!editing} onClose={() => setEditing(null)} title={editing ? `Reminder to ${editing.companyName}` : "Reminder"} large>
        {editing && (
          <div className="space-y-3">
            <CcField id="rq-cc" value={cc} onChange={setCc} disabled={pending} />
            <div className="space-y-1">
              <Label htmlFor="rq-subject">Subject</Label>
              <Input id="rq-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rq-body">Message</Label>
              <Textarea id="rq-body" rows={12} value={body} onChange={(e) => setBody(e.target.value)} className="font-mono text-xs" />
              <p className="text-[11px] text-subtle">The {"{{fields}}"} — the invoice, what&apos;s left, the pay-now link — are filled in as it goes, with the invoice attached.</p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button disabled={pending || !subject.trim() || !body.trim()} onClick={() => act(() => sendAwaitingReminder(editing.key, { subject, body, cc }), `Sent to ${editing.companyName}.`)}>
                {pending ? "Sending…" : "Send"}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
