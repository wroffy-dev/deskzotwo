"use client";

import { useState, useTransition } from "react";
import { RotateCcw } from "lucide-react";
import type { NotificationType } from "@prisma/client";
import { saveNotificationEmailFrame, saveNotificationEmailWording } from "@/actions/notification";
import {
  DEFAULT_PARTS,
  NOTIFICATION_FIELDS,
  PART_FIELDS,
  composeNotificationEmail,
  partProblem,
  type NotificationEmailFrame,
  type NotificationEmailWords,
  type NotificationPart,
} from "@/lib/notifications/email-template";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";

/**
 * Notification emails as templates (owner, 16 Nov 2026: "make notification emails editable template") — the frame
 * every one goes in, and each kind's own subject and body. The preview is built by the function that sends them
 * (src/lib/notifications/email-template.ts), with sample words.
 */

export type PreviewSample = { name: string; company: string; title: string; message: string; customer?: string };

function Fields({ part }: { part: NotificationPart }) {
  return (
    <p className="mt-1 text-[11px] text-muted">
      {PART_FIELDS[part].map((f, i) => (
        <span key={f}>
          {i > 0 && " · "}
          <code className="text-text">{`{${f}}`}</code> {NOTIFICATION_FIELDS[f].about}
        </span>
      ))}
      <span> · [[ … ]] is left out when a field inside it is empty</span>
    </p>
  );
}

function Preview({ words, frame, sample }: { words?: NotificationEmailWords; frame?: NotificationEmailFrame; sample: PreviewSample }) {
  const mail = composeNotificationEmail({ words, frame, values: { ...sample, reason: NOTIFICATION_FIELDS.reason.sample }, url: "https://example.deskzo.com/" });
  return (
    <div className="rounded-base border border-line bg-surface">
      <div className="border-b border-line px-3 py-2 text-xs">
        <span className="text-muted">Subject </span>
        <span className="font-medium text-text">{mail.subject}</span>
      </div>
      {/* Built by composeNotificationEmail, which escapes every value it puts in. */}
      <div className="px-3 py-1 text-sm [&_p]:my-3" dangerouslySetInnerHTML={{ __html: mail.html }} />
    </div>
  );
}

const problemOf = (part: NotificationPart, value: string) => partProblem(part, value);

/** The greeting, sign-off and footer every notification email goes in. */
export function NotificationFrameEditor({ initial, sample }: { initial: NotificationEmailFrame | null; sample: PreviewSample }) {
  const [frame, setFrame] = useState({ subject: initial?.subject ?? "", body: initial?.body ?? "", greeting: initial?.greeting ?? "", signOff: initial?.signOff ?? "", footer: initial?.footer ?? "" });
  const [saved, setSaved] = useState(frame);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const parts: { part: "subject" | "body" | "greeting" | "signOff" | "footer"; label: string; hint?: string }[] = [
    { part: "subject", label: "Subject", hint: "For every notification without its own subject — set one under Edit email." },
    { part: "greeting", label: "Greeting" },
    { part: "body", label: "Message", hint: "For every notification without its own message — set one under Edit email." },
    { part: "signOff", label: "Sign-off" },
    { part: "footer", label: "Footer" },
  ];
  const problem = parts.map(({ part }) => frame[part] && problemOf(part, frame[part])).find(Boolean) || null;
  const dirty = JSON.stringify(frame) !== JSON.stringify(saved);

  const save = (next: typeof frame) =>
    start(async () => {
      const result = await saveNotificationEmailFrame(next);
      if (!result.ok) return setMessage({ ok: false, text: result.error });
      setFrame(next);
      setSaved(next);
      setMessage({ ok: true, text: "Saved. Every notification email goes in it from now on." });
    });

  return (
    <Card>
      <CardHeader>
        <div className="text-sm font-medium text-text">How every email looks</div>
        <div className="mt-0.5 text-xs text-muted">The subject, greeting, message, sign-off and footer of each notification. Leave one blank to keep Deskzo&apos;s.</div>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          {parts.map(({ part, label, hint }) => (
            <div key={part}>
              <Label htmlFor={`nf-${part}`}>{label}</Label>
              {part === "footer" || part === "body" ? (
                <Textarea id={`nf-${part}`} rows={3} className="mt-1" value={frame[part]} placeholder={DEFAULT_PARTS[part]} onChange={(e) => setFrame({ ...frame, [part]: e.target.value })} />
              ) : (
                <Input id={`nf-${part}`} className="mt-1" value={frame[part]} placeholder={DEFAULT_PARTS[part]} onChange={(e) => setFrame({ ...frame, [part]: e.target.value })} />
              )}
              <Fields part={part} />
              {hint && <p className="mt-0.5 text-[11px] text-muted">{hint}</p>}
            </div>
          ))}
          {(problem || message) && <p className={problem || !message?.ok ? "text-xs text-danger" : "text-xs text-success"}>{problem ?? message?.text}</p>}
          <div className="flex gap-2">
            <Button size="sm" disabled={pending || !dirty || !!problem} onClick={() => save(frame)}>
              Save
            </Button>
            {(saved.subject || saved.body || saved.greeting || saved.signOff || saved.footer) && (
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => save({ subject: "", body: "", greeting: "", signOff: "", footer: "" })}>
                <RotateCcw className="h-3.5 w-3.5" />
                Use Deskzo&apos;s
              </Button>
            )}
          </div>
        </div>
        <div>
          <div className="mb-1 text-xs text-muted">Preview</div>
          <Preview frame={frame} sample={sample} />
        </div>
      </CardContent>
    </Card>
  );
}

/** One kind's subject and body. */
export function NotificationWordingEditor({
  type,
  initial,
  frame,
  sample,
  onSaved,
}: {
  type: NotificationType;
  initial: NotificationEmailWords | undefined;
  frame: NotificationEmailFrame | null;
  sample: PreviewSample;
  onSaved: (words: NotificationEmailWords) => void;
}) {
  const [words, setWords] = useState({ subject: initial?.subject ?? "", body: initial?.body ?? "" });
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const problem = (words.subject && problemOf("subject", words.subject)) || (words.body && problemOf("body", words.body)) || null;

  const save = (next: typeof words) =>
    start(async () => {
      const result = await saveNotificationEmailWording({ type, ...next });
      if (!result.ok) return setMessage({ ok: false, text: result.error });
      setWords(next);
      onSaved(result.data);
      setMessage({ ok: true, text: next.subject || next.body ? "Saved." : "Back to Deskzo's wording." });
    });

  return (
    <div className="grid gap-4 bg-surface-sunken px-5 py-4 lg:grid-cols-2">
      <div className="space-y-3">
        <div>
          <Label htmlFor={`nw-s-${type}`}>Subject</Label>
          <Input id={`nw-s-${type}`} className="mt-1" value={words.subject} placeholder={frame?.subject || DEFAULT_PARTS.subject} onChange={(e) => setWords({ ...words, subject: e.target.value })} />
          <Fields part="subject" />
        </div>
        <div>
          <Label htmlFor={`nw-b-${type}`}>Message</Label>
          <Textarea id={`nw-b-${type}`} rows={5} className="mt-1" value={words.body} placeholder={frame?.body || DEFAULT_PARTS.body} onChange={(e) => setWords({ ...words, body: e.target.value })} />
          <Fields part="body" />
        </div>
        {(problem || message) && <p className={problem || !message?.ok ? "text-xs text-danger" : "text-xs text-success"}>{problem ?? message?.text}</p>}
        <div className="flex gap-2">
          <Button size="sm" disabled={pending || !!problem} onClick={() => save(words)}>
            Save
          </Button>
          {(initial?.subject || initial?.body) && (
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => save({ subject: "", body: "" })}>
              <RotateCcw className="h-3.5 w-3.5" />
              Use Deskzo&apos;s
            </Button>
          )}
        </div>
      </div>
      <div>
        <div className="mb-1 text-xs text-muted">Preview, with sample words</div>
        <Preview words={words} frame={frame ?? undefined} sample={sample} />
      </div>
    </div>
  );
}
