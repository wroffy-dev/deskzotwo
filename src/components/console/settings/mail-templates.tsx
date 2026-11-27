"use client";

import { useMemo, useRef, useState } from "react";
import { consoleResetMailTemplate, consoleSaveMailTemplate, consoleSendTemplateTest } from "@/actions/platform/console-mail";
import { Panel } from "@/components/console/kit/panel";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { StatusPill } from "@/components/console/kit/status";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { fillTemplate, sampleValues, templateProblem } from "@/lib/console-shared/mail-template-engine";
import { MAIL_TEMPLATE_GROUPS, type MailTemplateDef } from "@/lib/console-shared/mail-templates";

export type TemplateRow = { key: string; subject: string; text: string; edited: boolean; updatedAt: string | null; updatedByName: string | null };

/**
 * Settings › Mail › Templates (owner, 1 Nov 2026): the wording of every email Deskzo itself sends. Pick one,
 * change its subject and text with its fields, see it filled in with sample values, send yourself a test,
 * or go back to Deskzo's wording. The server checks again (src/lib/platform/mail/templates.ts).
 */
export function MailTemplatesEditor({ defs, rows, canEdit, testTo }: { defs: MailTemplateDef[]; rows: TemplateRow[]; canEdit: boolean; testTo: string }) {
  const [selected, setSelected] = useState(defs[0]?.key ?? "");
  const def = defs.find((d) => d.key === selected) ?? defs[0];
  const row = rows.find((r) => r.key === def?.key);
  if (!def || !row) return null;
  return (
    <div className="grid gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <nav aria-label="Emails" className="space-y-4">
        {MAIL_TEMPLATE_GROUPS.map((group) => {
          const inGroup = defs.filter((d) => d.group === group);
          if (!inGroup.length) return null;
          return (
            <div key={group}>
              <p className="px-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">{group}</p>
              <ul className="mt-1 space-y-0.5">
                {inGroup.map((d) => {
                  const r = rows.find((x) => x.key === d.key);
                  return (
                    <li key={d.key}>
                      <button
                        type="button"
                        onClick={() => setSelected(d.key)}
                        aria-current={d.key === def.key ? "true" : undefined}
                        className={`flex w-full items-center justify-between gap-2 rounded-base px-2 py-1.5 text-left text-[13px] ${d.key === def.key ? "bg-brand/10 font-medium text-text" : "text-muted hover:bg-surface-sunken hover:text-text"}`}
                      >
                        <span>{d.label}</span>
                        {r?.edited && <span className="shrink-0 text-[11px] text-brand">Edited</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>
      <TemplateForm key={`${def.key}|${row.updatedAt ?? ""}`} def={def} row={row} canEdit={canEdit} testTo={testTo} />
    </div>
  );
}

function TemplateForm({ def, row, canEdit, testTo }: { def: MailTemplateDef; row: TemplateRow; canEdit: boolean; testTo: string }) {
  const [subject, setSubject] = useState(row.subject);
  const [text, setText] = useState(row.text);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const save = useConsoleAction<null>();
  const reset = useConsoleAction<null>();
  const test = useConsoleAction<{ to: string }>();
  const samples = useMemo(() => sampleValues(def.fields), [def.fields]);
  const problem = templateProblem({ subject, text }, def.fields, def.required);
  const changed = subject !== row.subject || text !== row.text;

  const insert = (name: string) => {
    const el = textRef.current;
    const token = `{${name}}`;
    if (!el) return setText((t) => t + token);
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    setText(text.slice(0, start) + token + text.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <Panel
      title={def.label}
      description={def.when}
      actions={row.edited ? <StatusPill tone="info">Edited{row.updatedByName ? ` by ${row.updatedByName}` : ""}</StatusPill> : <StatusPill tone="neutral">Deskzo&apos;s wording</StatusPill>}
    >
      <div className="grid gap-5 xl:grid-cols-2">
        <div className="space-y-3">
          <p className="text-xs text-subtle">
            Goes from {def.fromWorkspace ? <strong className="text-text">“&lt;Workspace&gt; via Deskzo”</strong> : <strong className="text-text">Deskzo</strong>}, as {def.type.toLowerCase()} mail.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-subject">Subject</Label>
            <Input id="tpl-subject" value={subject} onChange={(e) => setSubject(e.target.value)} disabled={!canEdit || save.pending} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-text">Email</Label>
            <Textarea id="tpl-text" ref={textRef} rows={14} value={text} onChange={(e) => setText(e.target.value)} disabled={!canEdit || save.pending} className="font-mono text-[13px]" />
            <p className="text-xs text-subtle">
              Put a field in braces, like {"{name}"}. Wrap a part in [[ … ]] to leave it out when a field inside it is empty.
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-text">Fields — click to insert</p>
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {def.fields.map((f) => (
                <li key={f.name}>
                  <button
                    type="button"
                    title={f.about}
                    disabled={!canEdit}
                    onClick={() => insert(f.name)}
                    className={`rounded-full border px-2 py-0.5 font-mono text-[12px] ${def.required.includes(f.name) ? "border-brand/40 text-brand" : "border-line text-muted"} hover:bg-surface-sunken disabled:opacity-60`}
                  >
                    {`{${f.name}}`}
                    {def.required.includes(f.name) && " *"}
                  </button>
                </li>
              ))}
            </ul>
            {def.required.length > 0 && <p className="mt-1 text-[11px] text-subtle">* the email can&apos;t work without it.</p>}
          </div>
          {problem && <p className="text-sm text-danger">{problem}</p>}
          {save.error && <p className="text-sm text-danger">{save.error}</p>}
          {reset.error && <p className="text-sm text-danger">{reset.error}</p>}
          {test.error && <p className="text-sm text-danger">{test.error}</p>}
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={!changed || !!problem || save.pending} onClick={() => save.run(() => consoleSaveMailTemplate({ key: def.key, subject, text }), { success: "Saved — emails go with this wording from now on." })}>
                {save.pending ? "Saving…" : "Save"}
              </Button>
              <Button type="button" variant="secondary" disabled={test.pending || changed} title={changed ? "Save first — the test goes as saved" : undefined} onClick={() => test.run(() => consoleSendTemplateTest(def.key), { success: (d) => `A test is on its way to ${d.to}.` })}>
                {test.pending ? "Sending…" : `Send a test to ${testTo}`}
              </Button>
              {row.edited && (
                <Button type="button" variant="ghost" disabled={reset.pending} onClick={() => reset.run(() => consoleResetMailTemplate(def.key), { success: "Back to Deskzo's wording." })}>
                  Back to Deskzo&apos;s wording
                </Button>
              )}
            </div>
          )}
        </div>
        <div>
          <p className="text-xs font-medium text-text">Preview, with sample values</p>
          <div className="mt-1.5 rounded-lg border border-line bg-surface-sunken p-4">
            <p className="text-[13px] font-semibold text-text">{fillTemplate(subject, samples) || "—"}</p>
            <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-[13px] leading-6 text-muted">{fillTemplate(text, samples)}</pre>
          </div>
        </div>
      </div>
    </Panel>
  );
}
