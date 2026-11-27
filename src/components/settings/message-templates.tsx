"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Mail, MessageCircle, Paperclip, Plus } from "lucide-react";
import { attachMessageTemplateFile, deleteMessageTemplate, removeMessageTemplateFile, saveMessageTemplate } from "@/actions/quick-messages";
import type { QuickTemplateRow } from "@/lib/quick-messages/server";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { CALL_RESULTS, CALL_RESULT_LABELS, QUICK_FIELDS, QUICK_MOMENTS, QUICK_MOMENT_LABELS, fieldsInOrder, fill, metaText, templateRefusal, type QuickMoment } from "@/lib/quick-messages/fields";

type Draft = { id?: string; name: string; moment: QuickMoment; callResult: string; emailSubject: string; emailBody: string; whatsappBody: string; whatsappTemplateName: string; active: boolean; starter: boolean; attachment: { name: string; size: number } | null; wantsFile: boolean };

const fileSize = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

const blank: Draft = { name: "", moment: "AFTER_CALL", callResult: "ANY", emailSubject: "", emailBody: "", whatsappBody: "", whatsappTemplateName: "", active: true, starter: false, attachment: null, wantsFile: false };
const EXAMPLE = Object.fromEntries(QUICK_FIELDS.map((f) => [f.key, f.example]));

/**
 * Settings › Message templates (owner, 11 Nov 2026): the list, and one template's editor — its email, its WhatsApp
 * text, and the name Meta approved that text under. The editor shows the text to submit to Meta, numbered as WhatsApp
 * wants it, so what is approved and what is sent can't differ.
 */
export function MessageTemplatesSettings({ templates }: { templates: QuickTemplateRow[] }) {
  const [editing, setEditing] = useState<Draft | null>(null);
  const open = (t: QuickTemplateRow) =>
    setEditing({ id: t.id, name: t.name, moment: t.moment, callResult: t.callResult, emailSubject: t.emailSubject ?? "", emailBody: t.emailBody ?? "", whatsappBody: t.whatsappBody ?? "", whatsappTemplateName: t.whatsappTemplateName ?? "", active: t.active, starter: t.starter, attachment: t.attachment, wantsFile: t.wantsFile });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setEditing({ ...blank })}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New template
        </Button>
      </div>
      {QUICK_MOMENTS.map((moment) => {
        const rows = templates.filter((t) => t.moment === moment);
        if (rows.length === 0) return null;
        return (
          <Card key={moment} className="overflow-hidden">
            <div className="border-b border-line bg-surface-sunken px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted">{QUICK_MOMENT_LABELS[moment]}</div>
            <ul>
              {rows.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 last:border-0">
                  <div className="min-w-0 flex-1">
                    <div className={`text-sm font-medium ${t.active ? "text-text" : "text-subtle line-through"}`}>{t.name}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                      {moment === "AFTER_CALL" && <span>{CALL_RESULT_LABELS[t.callResult]}</span>}
                      {t.emailBody && (
                        <span className="inline-flex items-center gap-1">
                          <Mail className="h-3 w-3" /> Email
                        </span>
                      )}
                      {t.whatsappBody && (
                        <span className={`inline-flex items-center gap-1 ${t.whatsappTemplateName ? "" : "text-warning"}`}>
                          <MessageCircle className="h-3 w-3" /> {t.whatsappTemplateName ? `WhatsApp · ${t.whatsappTemplateName}` : "WhatsApp · not approved at Meta yet"}
                        </span>
                      )}
                      {t.attachment && (
                        <span className="inline-flex items-center gap-1">
                          <Paperclip className="h-3 w-3" /> {t.attachment.name}
                        </span>
                      )}
                      {t.wantsFile && (
                        <span className="inline-flex items-center gap-1 text-warning">
                          <Paperclip className="h-3 w-3" /> Attach your company profile PDF
                        </span>
                      )}
                      {!t.active && <span>Switched off</span>}
                    </div>
                  </div>
                  <Button variant="secondary" onClick={() => open(t)}>
                    Edit
                  </Button>
                </li>
              ))}
            </ul>
          </Card>
        );
      })}
      <p className="text-xs text-subtle">
        WhatsApp only lets a company write first with a message Meta has approved. For each template, submit its WhatsApp text in Meta Business Manager
        (WhatsApp Manager › Message templates), then put the approved name here. Within 24 hours of a customer writing to you, your team can send any
        text.
      </p>
      {editing && <Editor draft={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function Editor({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const router = useRouter();
  const [d, setD] = useState<Draft>(draft);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // The box last typed in, so a field's button puts it there.
  const last = useRef<"emailSubject" | "emailBody" | "whatsappBody">("emailBody");
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setD((prev) => ({ ...prev, [key]: value }));
  const fields = QUICK_FIELDS.filter((f) => !f.only || f.only === d.moment);
  const refusal = templateRefusal(d);
  const numbered = d.whatsappBody.trim() ? metaText(d.whatsappBody) : "";
  const order = fieldsInOrder(d.whatsappBody);

  const save = () =>
    start(async () => {
      setError(null);
      const result = await saveMessageTemplate(d);
      if (!result.ok) return setError(result.error);
      onClose();
      router.refresh();
    });
  const remove = () =>
    start(async () => {
      if (!d.id) return;
      await deleteMessageTemplate(d.id);
      onClose();
      router.refresh();
    });
  const attach = (file: File | undefined) => {
    if (!file || !d.id) return;
    const form = new FormData();
    form.set("templateId", d.id);
    form.set("file", file);
    start(async () => {
      setError(null);
      const result = await attachMessageTemplateFile(form).catch(() => ({ ok: false as const, error: "That file didn't arrive — it may be over 5 MB." }));
      if (!result.ok) return setError(result.error);
      setD((prev) => ({ ...prev, attachment: result.data, wantsFile: false }));
      router.refresh();
    });
  };
  const detach = () =>
    start(async () => {
      if (!d.id) return;
      await removeMessageTemplateFile(d.id);
      setD((prev) => ({ ...prev, attachment: null }));
      router.refresh();
    });

  return (
    <Dialog open onClose={onClose} title={d.id ? "Edit template" : "New template"}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="mtName">Name</Label>
            <Input id="mtName" value={d.name} onChange={(e) => set("name", e.target.value)} placeholder="Thanks for speaking with us" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mtMoment">Offered</Label>
            <Select id="mtMoment" value={d.moment} onChange={(e) => set("moment", e.target.value as QuickMoment)}>
              {QUICK_MOMENTS.map((m) => (
                <option key={m} value={m}>
                  {QUICK_MOMENT_LABELS[m]}
                </option>
              ))}
            </Select>
          </div>
          {d.moment === "AFTER_CALL" && (
            <div className="space-y-1.5">
              <Label htmlFor="mtResult">After</Label>
              <Select id="mtResult" value={d.callResult} onChange={(e) => set("callResult", e.target.value)}>
                {CALL_RESULTS.map((r) => (
                  <option key={r} value={r}>
                    {CALL_RESULT_LABELS[r]}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>

        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-subtle">Fields — click to add where you were typing</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {fields.map((f) => (
              <button
                key={f.key}
                type="button"
                title={`${f.source} — e.g. ${f.example}`}
                className="rounded-full border border-line-strong px-2 py-0.5 text-xs text-muted hover:text-text"
                onClick={() => set(last.current, `${d[last.current]}{{${f.key}}}`)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-subtle">{"Write {{firstName|there}} to say “there” when a name is missing."}</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="mtSubject">Email subject</Label>
          <Input id="mtSubject" value={d.emailSubject} onFocus={() => (last.current = "emailSubject")} onChange={(e) => set("emailSubject", e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="mtBody">Email message</Label>
          <Textarea id="mtBody" rows={8} value={d.emailBody} onFocus={() => (last.current = "emailBody")} onChange={(e) => set("emailBody", e.target.value)} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="mtWhatsApp">WhatsApp message</Label>
          <Textarea id="mtWhatsApp" rows={4} value={d.whatsappBody} onFocus={() => (last.current = "whatsappBody")} onChange={(e) => set("whatsappBody", e.target.value)} />
        </div>
        {numbered && (
          <div className="rounded-base border border-line bg-surface-sunken p-3 text-xs">
            <div className="font-medium uppercase tracking-wide text-subtle">Submit this to Meta for approval</div>
            <div className="mt-1.5 select-all whitespace-pre-wrap font-mono text-text">{numbered}</div>
            {order.length > 0 && (
              <div className="mt-1.5 text-muted">
                Sample values: {order.map((f, i) => `{{${i + 1}}} ${EXAMPLE[f.key] ?? f.key}`).join(" · ")}
              </div>
            )}
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="mtMeta">Its template name at Meta</Label>
          <Input id="mtMeta" value={d.whatsappTemplateName} onChange={(e) => set("whatsappTemplateName", e.target.value.trim())} placeholder="new_account_manager" />
          <p className="text-xs text-subtle">Leave empty until Meta approves it. Without it, this goes on WhatsApp only within 24 hours of the customer writing to you.</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="mtFile">Attachment</Label>
          {!d.id ? (
            <p className="text-xs text-subtle">Save the template first, then open it again to attach a PDF.</p>
          ) : d.attachment ? (
            <div className="flex flex-wrap items-center gap-2 rounded-base border border-line px-3 py-2 text-sm">
              <Paperclip className="h-3.5 w-3.5 text-muted" aria-hidden />
              <span className="text-text">{d.attachment.name}</span>
              <span className="text-xs text-muted">{fileSize(d.attachment.size)}</span>
              <Button variant="ghost" size="sm" className="ml-auto" disabled={pending} onClick={detach}>
                Remove
              </Button>
            </div>
          ) : null}
          {d.id && <input id="mtFile" type="file" accept="application/pdf,.pdf" disabled={pending} className="block w-full text-sm text-muted file:mr-3 file:rounded-base file:border file:border-line-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm file:text-text" onChange={(e) => attach(e.target.files?.[0])} />}
          <p className="text-xs text-subtle">
            One PDF, up to 5 MB — your company profile, a brochure. It goes with the email, and on WhatsApp as a document; whoever sends can leave it
            off. For WhatsApp outside the 24 hours, the template at Meta needs a Document header.
          </p>
        </div>

        {d.emailBody.trim() && (
          <div className="rounded-base border border-line p-3">
            <div className="text-xs font-medium uppercase tracking-wide text-subtle">Email, with example values</div>
            <div className="mt-1.5 text-sm font-medium text-text">{fill(d.emailSubject, EXAMPLE).text}</div>
            <div className="mt-1.5 whitespace-pre-wrap text-sm text-text">{fill(d.emailBody, EXAMPLE).text}</div>
          </div>
        )}

        <label className="flex items-center gap-2 text-sm text-text">
          <input type="checkbox" className="h-4 w-4 accent-[var(--color-brand)]" checked={d.active} onChange={(e) => set("active", e.target.checked)} />
          Offered to the team
        </label>

        {(error ?? refusal) && <p className="text-sm text-danger">{error ?? refusal}</p>}
        <div className="flex flex-wrap gap-2">
          <Button disabled={pending || !!refusal} onClick={save}>
            {pending ? "Saving…" : "Save"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {d.id && !d.starter && (
            <Button variant="subtle" className="ml-auto text-danger" disabled={pending} onClick={remove}>
              Delete
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
