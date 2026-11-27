"use client";

import { useState, useTransition } from "react";
import { Mail, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { toast } from "@/components/ui/toast";
import { setMailReadingOn, setPersonMailReaders } from "@/actions/mail-reading";
import { MAIL_READERS, type MailReader } from "@/lib/mail-reading/agents";
import type { MailReadingView } from "@/lib/mail-reading/server";

/**
 * Settings › Deskzo AI › Reading mailboxes (owner, 23 Nov 2026: "lets give agent access to read mails ! this will be admin
 * based if he wants to give access or not" — src/lib/mail-reading). One switch for the workspace, then, mailbox by
 * mailbox, which agent may read it. Only mail with customers, vendors and leads already in Deskzo is ever kept.
 */

const PROVIDER: Record<string, string> = { MICROSOFT: "Outlook", GOOGLE: "Gmail", ZOHO: "Zoho Mail" };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : null);

export function MailReadingSettings({ view }: { view: MailReadingView }) {
  const [enabled, setEnabled] = useState(view.enabled);
  const [people, setPeople] = useState(view.people);
  const [pending, start] = useTransition();

  const toggleAll = (on: boolean) =>
    start(async () => {
      const r = await setMailReadingOn(on);
      if (!r.ok) return void toast.error(r.error);
      setEnabled(on);
      toast.success(on ? "The AI teammates may read the mailboxes ticked below." : "No mailbox is read now.");
    });

  const toggle = (userId: string, agent: MailReader, on: boolean) =>
    start(async () => {
      const person = people.find((p) => p.userId === userId)!;
      const agents = on ? [...new Set([...person.agents, agent])] : person.agents.filter((a) => a !== agent);
      const r = await setPersonMailReaders(userId, agents);
      if (!r.ok) return void toast.error(r.error);
      setPeople((ps) => ps.map((p) => (p.userId === userId ? { ...p, agents } : p)));
    });

  return (
    <Card id="mail-reading">
      <CardHeader className="flex items-center gap-2 text-sm font-medium text-text">
        <Mail className="h-4 w-4 text-muted" aria-hidden="true" />
        Reading mailboxes
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted">
          Let the AI teammates read the mailboxes people connected. Only emails to or from a customer, vendor, lead or contact already in Deskzo are kept; internal,
          personal and unknown mail is never kept. Every read by an agent is logged.
        </p>
        <label className="flex items-start justify-between gap-3 rounded-base border border-line px-3 py-2.5 text-sm">
          <span>
            <span className="font-medium text-text">Read connected mailboxes</span>
            <span className="mt-0.5 block text-xs text-muted">Off: no mailbox is read. On: only the mailboxes and agents ticked below. Reading starts from the moment a mailbox is ticked — no history.</span>
          </span>
          <input type="checkbox" className="mt-1 h-4 w-4 shrink-0" checked={enabled} disabled={pending} onChange={(e) => toggleAll(e.target.checked)} />
        </label>

        <div className="grid gap-1 text-xs text-muted sm:grid-cols-2">
          {MAIL_READERS.map((r) => (
            <p key={r.key}>
              <span className="font-medium text-text">{r.name}</span> — {r.does}
            </p>
          ))}
        </div>

        {people.length === 0 ? (
          <p className="text-sm text-subtle">Nobody has connected a mailbox yet (My profile → Email).</p>
        ) : (
          <div className={enabled ? "overflow-x-auto" : "pointer-events-none overflow-x-auto opacity-50"} aria-disabled={!enabled}>
            <table className="w-full min-w-[620px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="py-2 pr-3 font-medium">Mailbox</th>
                  {MAIL_READERS.map((r) => (
                    <th key={r.key} className="px-2 py-2 text-center font-medium">
                      {r.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.userId} className="border-b border-line last:border-0">
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-1.5 font-medium text-text">
                        <Mail className="h-3.5 w-3.5 text-subtle" aria-hidden="true" />
                        {p.name}
                      </div>
                      <div className="text-xs text-muted">
                        {p.mailbox} · {PROVIDER[p.provider] ?? p.provider}
                        {p.agents.length > 0 && p.kept > 0 && ` · ${p.kept.toLocaleString("en-IN")} kept`}
                        {p.agents.length > 0 && when(p.lastRunAt) && ` · read ${when(p.lastRunAt)}`}
                      </div>
                      {p.agents.length > 0 && (p.broken || !p.canRead) && (
                        <div className="mt-0.5 flex items-center gap-1 text-xs text-warning">
                          <TriangleAlert className="h-3 w-3" aria-hidden="true" />
                          {p.broken ? "Their mailbox connection stopped working — they connect it again on My profile." : "Waiting for them to connect their mailbox again on My profile, to allow reading."}
                        </div>
                      )}
                      {p.lastError && <div className="mt-0.5 text-xs text-danger">{p.lastError}</div>}
                    </td>
                    {MAIL_READERS.map((r) => (
                      <td key={r.key} className="px-2 py-2 text-center">
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          aria-label={`${r.name} reads ${p.name}'s mailbox`}
                          checked={p.agents.includes(r.key)}
                          disabled={pending || !enabled}
                          onChange={(e) => toggle(p.userId, r.key, e.target.checked)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-subtle">
          Each person ticked is asked, on My profile, to connect their mailbox once more so Outlook, Gmail or Zoho allows reading. They&apos;re told which teammates read it.
        </p>
      </CardContent>
    </Card>
  );
}
