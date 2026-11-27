"use client";

import { useEffect, useState, useTransition } from "react";
import { Send, Sparkles } from "lucide-react";
import { designEmailWithAI, emailAiStatus, searchTestContacts, sendTemplateTest, type AiDesignResult } from "@/actions/email-builder-tools";
import type { Design } from "@/lib/marketing/email-design";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";

/**
 * The email builder's two dialogs (owner, 1 Nov 2026): designing — or changing — the email with Deskzo AI, and sending
 * the saved email to oneself as a test, filled with sample values or a real contact's own.
 */

const IDEAS = [
  "Renewal reminder for Microsoft 365, friendly, with the renewal details and a button to confirm",
  "Diwali greetings to our customers with a 10% festive offer on Adobe licences",
  "Invite customers to a free webinar on Microsoft Copilot next Thursday at 4 pm",
  "Monthly newsletter with three short updates and a tip",
];

export function AiDesignDialog({ open, onClose, current, onDesigned }: { open: boolean; onClose: () => void; current: Design; onDesigned: (result: AiDesignResult, replace: boolean) => void }) {
  const [status, setStatus] = useState<{ unavailable: string | null; provider: string } | null>(null);
  const [description, setDescription] = useState("");
  const [change, setChange] = useState(current.blocks.length > 0);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!open) return;
    let live = true;
    emailAiStatus().then((s) => live && setStatus(s)).catch(() => live && setStatus({ unavailable: "Deskzo AI couldn't be reached.", provider: "Deskzo AI" }));
    return () => {
      live = false;
    };
  }, [open]);

  const run = () =>
    start(async () => {
      setError(null);
      const result = await designEmailWithAI({ description, current: change ? current : null });
      if (!result.ok) return setError(result.error);
      onDesigned(result.data, !change);
      setDescription("");
      onClose();
    });

  return (
    <Dialog open={open} onClose={() => !pending && onClose()} title="Design with AI" wide>
      <div className="space-y-3">
        {current.blocks.length > 0 && (
          <div className="inline-flex rounded-base border border-line text-sm">
            <button type="button" onClick={() => setChange(true)} className={`px-3 py-1.5 ${change ? "bg-brand text-white" : "text-muted"}`}>
              Change this email
            </button>
            <button type="button" onClick={() => setChange(false)} className={`px-3 py-1.5 ${!change ? "bg-brand text-white" : "text-muted"}`}>
              Start a new one
            </button>
          </div>
        )}
        <Textarea
          autoFocus
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={change ? "What should change? e.g. make it shorter and more formal, add a 10% early-renewal offer, write it in Hinglish" : "Describe the email: who it's for, what it should say, and the one thing they should do"}
          maxLength={2000}
        />
        {!change && !description && (
          <div className="flex flex-wrap gap-1.5">
            {IDEAS.map((idea) => (
              <button key={idea} type="button" onClick={() => setDescription(idea)} className="rounded-full border border-line px-2.5 py-1 text-left text-xs text-muted hover:border-brand hover:text-brand">
                {idea}
              </button>
            ))}
          </div>
        )}
        <p className="text-xs text-subtle">
          Sent to {status?.provider ?? "Deskzo AI"}: your words, your company&apos;s name and email{change ? ", and this email" : ""} — never a customer&apos;s details. It uses a few of the
          workspace&apos;s Deskzo AI credits. You can undo what it does.
        </p>
        {status?.unavailable && <ActionNotice tone="error">{status.unavailable}</ActionNotice>}
        {error && <ActionNotice tone="error">{error}</ActionNotice>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" onClick={run} disabled={pending || description.trim().length < 8 || !!status?.unavailable}>
            <Sparkles className="mr-1.5 h-4 w-4" />
            {pending ? "Designing… (about 20 seconds)" : change ? "Change it" : "Design it"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function TestSendDialog({ open, onClose, templateId }: { open: boolean; onClose: () => void; templateId: string | null }) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ id: string; name: string; email: string; company: string }[]>([]);
  const [contact, setContact] = useState<{ id: string; name: string; company: string } | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!open || query.trim().length < 2) return;
    let live = true;
    const timer = setTimeout(() => {
      searchTestContacts(query)
        .then((rows) => live && setFound(rows))
        .catch(() => live && setFound([]));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, query]);

  const send = () =>
    start(async () => {
      setNotice(null);
      const result = await sendTemplateTest({ templateId: templateId ?? "", contactId: contact?.id ?? null });
      setNotice(result.ok ? { tone: "success", text: `Sent to ${result.data.to}, filled with ${result.data.as}. Check your inbox — and your spam folder.` } : { tone: "error", text: result.error });
    });

  return (
    <Dialog open={open} onClose={() => !pending && onClose()} title="Send a test to me">
      <div className="space-y-3 text-sm">
        <p className="text-muted">The saved email goes to your own address only, &ldquo;[Test]&rdquo; before its subject, its links tagged as they will be.</p>
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-text">Fill it in with</p>
          {contact ? (
            <div className="flex items-center justify-between rounded-base border border-line px-3 py-2">
              <span>
                {contact.name} <span className="text-muted">· {contact.company}</span>
              </span>
              <button type="button" onClick={() => setContact(null)} className="text-xs text-brand hover:underline">
                Use sample values
              </button>
            </div>
          ) : (
            <>
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Sample values — or search a contact to use theirs" className="h-9" />
              {query.trim().length >= 2 && found.length > 0 && (
                <ul className="max-h-48 divide-y divide-line overflow-y-auto rounded-base border border-line">
                  {found.map((c) => (
                    <li key={c.id}>
                      <button type="button" onClick={() => (setContact(c), setQuery(""), setFound([]))} className="block w-full px-3 py-2 text-left hover:bg-surface-sunken">
                        {c.name} <span className="text-muted">· {c.company} · {c.email}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[11px] text-subtle">A contact&apos;s name, company, account manager and their company&apos;s next renewal fill the email. Nothing is sent to them.</p>
            </>
          )}
        </div>
        {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
            Close
          </Button>
          <Button type="button" onClick={send} disabled={pending || !templateId}>
            <Send className="mr-1.5 h-4 w-4" />
            {pending ? "Sending…" : "Send test"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
