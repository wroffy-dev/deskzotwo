"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CcField } from "@/components/mail/cc-field";
import { Mail, MessageCircle, Paperclip, X } from "lucide-react";
import { openQuickMessage, sendQuickMessageEmail, sendQuickMessageEmailWithFiles, sendQuickMessageWhatsApp, type QuickAsk, type QuickDialogData } from "@/actions/quick-messages";
import { EmailFrame } from "@/components/marketing/email-frame";
import { OWN_FILE_ACCEPT, OWN_FILES } from "@/lib/quick-messages/own-files";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { fieldLabel, fill, type QuickValues } from "@/lib/quick-messages/fields";

type Channel = "EMAIL" | "WHATSAPP";

const fileSize = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const valuesFor = (base: QuickValues, name: string | null): QuickValues => ({ ...base, fullName: name, firstName: name ? name.trim().split(/\s+/)[0]! : null });

/**
 * A ready-written email or WhatsApp to a customer, sent by hand (owner, 11 Nov 2026 — src/lib/quick-messages): pick
 * the template, see it as the customer will, change it, press Send. Nothing goes until Send is pressed.
 *
 * Email: to any of the customer's contacts who can be emailed, each with their own name filled in. WhatsApp: to one
 * person, from the company's number — free text while WhatsApp's 24 hours are open, the approved template after.
 */
export function QuickMessagePanel({ ask, onClose, intro, start = "EMAIL" }: { ask: QuickAsk; onClose: () => void; intro?: string; start?: Channel }) {
  const router = useRouter();
  const [data, setData] = useState<QuickDialogData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<Channel>(start);
  const [templateId, setTemplateId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [toEmail, setToEmail] = useState<string[]>([]);
  // Copied, typed in (owner, 16 Nov 2026: "add cc").
  const [cc, setCc] = useState("");
  // WhatsApp goes to one person: a contact's id, or "loose" for a number with nobody behind it.
  const [toWhatsApp, setToWhatsApp] = useState("");
  const [done, setDone] = useState<string | null>(null);
  // The template's PDF goes with it unless unticked.
  const [attach, setAttach] = useState(true);
  // The sender's own files, for an email (owner, 16 Nov 2026: "no attachment option?").
  const [files, setFiles] = useState<File[]>([]);
  const [sending, startSending] = useTransition();

  /** A channel and a template chosen: its words go in the boxes — the channel's first template when none is named. */
  const choose = (from: QuickDialogData, to: Channel, id?: string) => {
    // One of Marketing's designed emails ("mk:" and its id): its subject in the box, its body as designed.
    const designedPick =
      to !== "EMAIL"
        ? null
        : id?.startsWith("mk:")
          ? from.marketing.find((m) => m.id === id.slice(3))
          : // No message template with an email at all: the first designed one.
            !id && !from.templates.some((t) => t.emailBody)
            ? from.marketing[0]
            : null;
    if (designedPick) {
      setChannel(to);
      setTemplateId(`mk:${designedPick.id}`);
      setSubject(designedPick.subject);
      setBody("");
      setDone(null);
      setError(null);
      return;
    }
    const list = from.templates.filter((t) => (to === "EMAIL" ? t.emailBody : t.whatsappBody));
    const pick = list.find((t) => t.id === id) ?? list[0] ?? null;
    setChannel(to);
    setTemplateId(pick?.id ?? "");
    setSubject(to === "EMAIL" ? (pick?.emailSubject ?? "") : "");
    setBody(to === "EMAIL" ? (pick?.emailBody ?? "") : (pick?.whatsappBody ?? ""));
    setDone(null);
    setError(null);
    setAttach(true);
  };

  useEffect(() => {
    let live = true;
    openQuickMessage(ask)
      .then((r) => {
        if (!live) return;
        if (!r.ok) return setError(r.error);
        setData(r.data);
        choose(r.data, start);
        const c = r.data.context;
        const firstMail = c.contacts.find((p) => p.email && !p.emailStopped);
        setToEmail(firstMail ? [firstMail.id] : []);
        setToWhatsApp(c.loose ? "loose" : (c.contacts.find((p) => p.phone)?.id ?? ""));
      })
      .catch(() => live && setError("Couldn't open that just now — try again."));
    return () => {
      live = false;
    };
    // The ask is what the dialog was opened for; it doesn't change while it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const templates = useMemo(() => (data?.templates ?? []).filter((t) => (channel === "EMAIL" ? t.emailBody : t.whatsappBody)), [data, channel]);
  const template = templates.find((t) => t.id === templateId) ?? null;
  const designed = channel === "EMAIL" && templateId.startsWith("mk:") ? (data?.marketing.find((m) => m.id === templateId.slice(3)) ?? null) : null;
  const designedList = channel === "EMAIL" ? (data?.marketing ?? []) : [];
  const anyTemplate = templates.length > 0 || designedList.length > 0;
  const filesBytes = files.reduce((n, f) => n + f.size, 0);
  const filesProblem = files.length > OWN_FILES.maxFiles ? `Attach ${OWN_FILES.maxFiles} files at most.` : filesBytes > OWN_FILES.maxBytes ? "The files come to more than 3 MB together — attach smaller copies." : null;


  if (error && !data) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-danger">{error}</p>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    );
  }
  if (!data) return <p className="py-6 text-center text-sm text-muted">Loading…</p>;

  const c = data.context;
  const person = channel === "EMAIL" ? (c.contacts.find((p) => p.id === toEmail[0]) ?? null) : toWhatsApp === "loose" ? null : (c.contacts.find((p) => p.id === toWhatsApp) ?? null);
  const values = valuesFor(c.values, person?.name ?? null);
  const windowOpen = channel === "WHATSAPP" && (toWhatsApp === "loose" ? !!c.loose?.whatsappOpen : !!person?.whatsappOpen);
  // Outside WhatsApp's 24 hours the approved words are what goes: shown, not edited.
  const fixedWords = channel === "WHATSAPP" && !windowOpen;
  const shownBody = fixedWords ? (template?.whatsappBody ?? "") : body;
  const preview = { subject: fill(subject, values), body: fill(shownBody, values) };
  // A designed email is filled in by Marketing's own fields when it goes; these checks are the message templates'.
  const missing = designed ? [] : [...new Set([...(channel === "EMAIL" ? preview.subject.missing : []), ...preview.body.missing])];
  const unknown = designed ? [] : [...new Set([...(channel === "EMAIL" ? preview.subject.unknown : []), ...preview.body.unknown])];

  const blocked =
    channel === "EMAIL"
      ? c.emailRoute.via === "none"
        ? c.emailRoute.why
        : toEmail.length === 0
          ? "Tick who to send it to."
          : filesProblem
      : !c.whatsapp.ready
        ? c.whatsapp.why
        : !toWhatsApp
          ? "Nobody here has a phone number."
          : fixedWords && template && !template.whatsappTemplateName
            ? `WhatsApp only lets a company write first with a message it has approved. Ask an admin to get "${template.name}" approved at Meta and add its name in Settings › Message templates.`
            : null;

  const send = () => {
    if (!template && !designed) return;
    setError(null);
    startSending(async () => {
      const email = { ...ask, templateId: designed ? null : (template?.id ?? null), marketingTemplateId: designed?.id ?? null, contactIds: toEmail, subject, body, attach, cc };
      const withFiles = () => {
        const form = new FormData();
        form.set("payload", JSON.stringify(email));
        for (const f of files) form.append("file", f);
        return sendQuickMessageEmailWithFiles(form);
      };
      const result =
        channel === "EMAIL"
          ? files.length
            ? await withFiles()
            : await sendQuickMessageEmail(email)
          : await sendQuickMessageWhatsApp({ ...ask, templateId: template!.id, contactId: toWhatsApp === "loose" ? null : toWhatsApp, phone: toWhatsApp === "loose" ? (c.loose?.phone ?? null) : null, body: windowOpen ? body : null, attach });
      if (!result.ok) return setError(result.error);
      const skipped = result.data.skipped.map((s) => `${s.name}: ${s.why}`).join(" ");
      setDone(`${channel === "EMAIL" ? `Sent to ${result.data.sent} ${result.data.sent === 1 ? "person" : "people"}.` : "Sent on WhatsApp."}${skipped ? ` Not sent — ${skipped}` : ""}${result.data.note ? ` ${result.data.note}` : ""}`);
      router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      {intro && <p className="text-sm text-muted">{intro}</p>}

      <div className="flex gap-2">
        {(["EMAIL", "WHATSAPP"] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => data && choose(data, k)}
            aria-pressed={channel === k}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors ${channel === k ? "border-brand bg-brand/10 font-medium text-brand" : "border-line-strong text-muted hover:text-text"}`}
          >
            {k === "EMAIL" ? <Mail className="h-3.5 w-3.5" /> : <MessageCircle className="h-3.5 w-3.5" />}
            {k === "EMAIL" ? "Email" : "WhatsApp"}
          </button>
        ))}
      </div>

      {!anyTemplate ? (
        <p className="rounded-base border border-line bg-surface-sunken px-3 py-2 text-sm text-muted">No template has {channel === "EMAIL" ? "an email" : "a WhatsApp message"} for this. An admin can add one in Settings › Message templates.</p>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="qmTemplate">Template</Label>
            <Select id="qmTemplate" value={templateId} onChange={(e) => choose(data, channel, e.target.value)}>
              {designedList.length > 0 ? (
                <>
                  {templates.length > 0 && (
                    <optgroup label="Message templates">
                      {templates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  <optgroup label="Marketing emails">
                    {designedList.map((m) => (
                      <option key={m.id} value={`mk:${m.id}`}>
                        {m.name}
                      </option>
                    ))}
                  </optgroup>
                </>
              ) : (
                templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))
              )}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>To</Label>
            {channel === "EMAIL" ? (
              <div className="max-h-36 space-y-1 overflow-y-auto rounded-base border border-line p-2">
                {c.contacts.filter((p) => p.email).length === 0 && <p className="text-sm text-muted">Nobody at {c.company.name} has an email address.</p>}
                {c.contacts
                  .filter((p) => p.email)
                  .map((p) => (
                    <label key={p.id} className={`flex items-start gap-2 text-sm ${p.emailStopped ? "text-subtle" : "text-text"}`} title={p.emailStopped ?? undefined}>
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 accent-[var(--color-brand)]"
                        checked={toEmail.includes(p.id)}
                        disabled={!!p.emailStopped}
                        onChange={(e) => setToEmail((list) => (e.target.checked ? [...list, p.id] : list.filter((id) => id !== p.id)))}
                      />
                      <span>
                        {p.name} <span className="text-xs text-muted">{p.email}</span>
                        {p.primary && <span className="ml-1 text-xs text-subtle">primary</span>}
                        {p.emailStopped && <span className="block text-xs text-subtle">{p.emailStopped}</span>}
                      </span>
                    </label>
                  ))}
              </div>
            ) : (
              <Select value={toWhatsApp} onChange={(e) => setToWhatsApp(e.target.value)} aria-label="WhatsApp to">
                {c.loose && <option value="loose">{c.loose.phone}</option>}
                {c.contacts
                  .filter((p) => p.phone)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {p.phone}
                    </option>
                  ))}
                {!c.loose && c.contacts.every((p) => !p.phone) && <option value="">Nobody has a phone number</option>}
              </Select>
            )}
            <p className="text-xs text-subtle">
              {channel === "EMAIL"
                ? c.emailRoute.via === "mailbox"
                  ? `From ${c.sender.name} — ${c.emailRoute.from}.`
                  : c.emailRoute.via === "company"
                    ? `From ${c.sender.name}, through the company's mail server; replies go to them.`
                    : ""
                : c.whatsapp.ready
                  ? `From ${c.whatsapp.from}.`
                  : ""}
              {channel === "EMAIL" && c.copied ? ` ${c.copied} is copied.` : ""}
            </p>
          </div>

          {channel === "EMAIL" && <CcField id="qmCc" value={cc} onChange={setCc} disabled={sending} note={toEmail.length > 1 ? "Each person gets an email of their own, and each is copied." : undefined} />}

          {channel === "EMAIL" && (
            <div className="space-y-1.5">
              <Label htmlFor="qmSubject">Subject</Label>
              <Input id="qmSubject" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
          )}

          {designed ? (
            <div className="space-y-1.5">
              <Label>Message</Label>
              {designed.html ? <EmailFrame html={designed.html} title={designed.name} height={360} /> : <p className="text-sm text-muted">This email can&apos;t be shown — open it in Marketing › Templates.</p>}
              <p className="text-xs text-subtle">
                Marketing&apos;s email as designed, with each person&apos;s own details and an unsubscribe link filled in when it goes. Change its wording in
                Marketing › Templates.
              </p>
            </div>
          ) : (
          <div className="space-y-1.5">
            <Label htmlFor="qmBody">Message</Label>
            {fixedWords ? (
              <p className="rounded-base border border-line bg-surface-sunken px-3 py-2 text-xs text-muted">
                {template?.whatsappTemplateName
                  ? "WhatsApp sends the wording Meta approved for this template, with the names filled in — it can't be changed here. Once the customer replies, you can write freely for 24 hours."
                  : "This customer hasn't written to you on WhatsApp in the last 24 hours."}
              </p>
            ) : (
              <Textarea id="qmBody" rows={channel === "EMAIL" ? 9 : 4} value={body} onChange={(e) => setBody(e.target.value)} />
            )}
          </div>
          )}

          {!designed && (
          <div className="rounded-base border border-line bg-surface-sunken p-3">
            <div className="text-xs font-medium uppercase tracking-wide text-subtle">As {person?.name ?? (channel === "WHATSAPP" && c.loose ? c.loose.phone : "they")} will see it</div>
            {channel === "EMAIL" && <div className="mt-1.5 text-sm font-medium text-text">{preview.subject.text}</div>}
            <div className="mt-1.5 whitespace-pre-wrap text-sm text-text">{preview.body.text}</div>
          </div>
          )}

          {channel === "EMAIL" && (
            <div className="space-y-1.5">
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-brand hover:underline">
                <Paperclip className="h-3.5 w-3.5" aria-hidden />
                Attach PDFs
                <input
                  type="file"
                  multiple
                  accept={OWN_FILE_ACCEPT}
                  className="sr-only"
                  disabled={sending}
                  onChange={(e) => {
                    const picked = Array.from(e.target.files ?? []);
                    setFiles((list) => [...list, ...picked.filter((p) => !list.some((f) => f.name === p.name && f.size === p.size))]);
                    e.target.value = "";
                  }}
                />
              </label>
              {files.length > 0 && (
                <ul className="space-y-1">
                  {files.map((f) => (
                    <li key={`${f.name}-${f.size}`} className="flex items-center gap-2 text-sm text-text">
                      <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
                      <span className="min-w-0 truncate">{f.name}</span>
                      <span className="shrink-0 text-xs text-muted">{fileSize(f.size)}</span>
                      <button type="button" onClick={() => setFiles((list) => list.filter((x) => x !== f))} className="shrink-0 text-muted hover:text-danger" aria-label={`Remove ${f.name}`} disabled={sending}>
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-subtle">PDFs only — up to {OWN_FILES.maxFiles} files, 3 MB together.</p>
            </div>
          )}

          {!designed && template?.attachment && (
            <label className="flex items-start gap-2 text-sm text-text">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--color-brand)]" checked={attach} onChange={(e) => setAttach(e.target.checked)} />
              <span>
                <Paperclip className="mr-1 inline h-3.5 w-3.5 text-muted" aria-hidden />
                Attach {template.attachment.name} <span className="text-xs text-muted">({fileSize(template.attachment.size)})</span>
                {channel === "WHATSAPP" && fixedWords && <span className="block text-xs text-subtle">On WhatsApp it goes in the template&apos;s header, so the template at Meta needs a Document header.</span>}
              </span>
            </label>
          )}
          {!designed && template?.wantsFile && <p className="text-xs text-warning">This template is written to go with your company profile, and no PDF is attached to it yet. An admin can attach one in Settings › Message templates.</p>}

          {(missing.length > 0 || unknown.length > 0) && (
            <p className="text-sm text-danger">
              {missing.length > 0 && `Nothing to fill in for ${missing.map(fieldLabel).join(", ")}${fixedWords ? "." : " — type the words in instead, or give the field a fallback like {{firstName|there}}."} `}
              {unknown.length > 0 && `${unknown.map((u) => `{{${u}}}`).join(", ")} ${unknown.length === 1 ? "isn't a field" : "aren't fields"}.`}
            </p>
          )}
          {blocked && <p className="text-sm text-warning">{blocked}</p>}
        </>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}
      {done && <p className="text-sm text-success">{done}</p>}

      <div className="flex gap-2">
        {anyTemplate && !done && (
          <Button disabled={sending || !!blocked || missing.length > 0 || unknown.length > 0 || (!template && !designed)} onClick={send}>
            {sending ? "Sending…" : channel === "EMAIL" ? "Send email" : "Send on WhatsApp"}
          </Button>
        )}
        <Button variant="secondary" onClick={onClose}>
          {done ? "Done" : "Not now"}
        </Button>
      </div>
    </div>
  );
}

/** A button that opens the panel in a dialog of its own — on a customer, a lead, a call in the list. */
export function QuickMessageButton({
  ask,
  title,
  label = "Message",
  intro,
  start,
  variant = "secondary",
  size = "md",
  className,
}: {
  ask: QuickAsk;
  title: string;
  label?: string;
  intro?: string;
  start?: Channel;
  variant?: "primary" | "secondary" | "subtle" | "ghost";
  size?: "sm" | "md";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size={size} className={className} onClick={() => setOpen(true)}>
        {start === "WHATSAPP" ? <MessageCircle className="mr-1.5 h-3.5 w-3.5" /> : <Mail className="mr-1.5 h-3.5 w-3.5" />}
        {label}
      </Button>
      {open && (
        <Dialog open onClose={() => setOpen(false)} title={title}>
          <QuickMessagePanel ask={ask} intro={intro} start={start} onClose={() => setOpen(false)} />
        </Dialog>
      )}
    </>
  );
}
