"use client";

import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ClipboardList, Copy, ExternalLink, Globe, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { confirmAction } from "@/components/ui/confirm";
import type { BoardProperty } from "@/actions/smart-list-board";
import { answersWaiting, decidePublicAnswer, deleteListForm, listForms, saveListForm, savePublicLink, sendListForm, type ListForm } from "@/actions/smart-list-team";
import { sendPublicListForm } from "@/actions/smart-list-public";
import type { FormQuestion } from "@/lib/smart-lists/forms";
import type { WaitingAnswer } from "@/lib/smart-lists/public-forms";
import { CONSENT_MAX, DEFAULT_CONSENT, publicFormPath } from "@/lib/smart-lists/public-form-words";
import { CellEditor, CellValue, OptionChip } from "@/components/smart-lists/cells";

/**
 * Forms that add rows (owner, 20 Nov 2026 — Smart Lists phase 3): the builder makes one from the list's columns — which
 * to ask, which must be answered — and shares its link inside the company; whoever fills it in adds a row without
 * opening the list (src/lib/smart-lists/forms.ts). Phase 4: a form may also have a public link, for people outside the
 * company, whose answers wait here to be accepted (src/lib/smart-lists/public-forms.ts).
 */

const FORM_KINDS = ["TEXT", "NUMBER", "MONEY", "DATE", "SELECT", "MULTI_SELECT", "CHECKBOX", "LINK", "PERSON", "RATING", "EMAIL", "PHONE"];

/** `waiting`: answers to the list's public forms waiting to be accepted; `startOnAnswers`: open on them (?answers=1). */
const noSubscribe = () => () => {};

export function FormsButton({ workbookId, properties, waiting = 0, startOnAnswers = false }: { workbookId: string; properties: BoardProperty[]; waiting?: number; startOnAnswers?: boolean }) {
  const [open, setOpen] = useState(startOnAnswers && waiting > 0);
  // Opened from a notification's link, it opens once in the browser — a dialog is drawn into the page's body, which the server hasn't got.
  const inBrowser = useSyncExternalStore(noSubscribe, () => true, () => false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <ClipboardList className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        Forms
        {waiting > 0 && (
          <span className="ml-1.5 rounded-full bg-brand px-1.5 text-xs font-semibold text-white" aria-label={`${waiting} answer${waiting === 1 ? "" : "s"} waiting`}>
            {waiting}
          </span>
        )}
      </Button>
      {open && inBrowser && <FormsDialog workbookId={workbookId} properties={properties} startOnAnswers={startOnAnswers && waiting > 0} onClose={() => setOpen(false)} />}
    </>
  );
}

const origin = () => (typeof window === "undefined" ? "" : window.location.origin);

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Link copied.");
  } catch {
    toast.error("Couldn't copy — open the form and copy its address.");
  }
}

function FormsDialog({ workbookId, properties, startOnAnswers, onClose }: { workbookId: string; properties: BoardProperty[]; startOnAnswers: boolean; onClose: () => void }) {
  const [forms, setForms] = useState<ListForm[] | null>(null);
  const [editing, setEditing] = useState<ListForm | "new" | null>(null);
  const [answers, setAnswers] = useState<WaitingAnswer[] | null>(null);
  const [tab, setTab] = useState<"forms" | "answers">(startOnAnswers ? "answers" : "forms");
  const load = () => {
    void listForms(workbookId).then((f) => setForms(f ?? []));
    void answersWaiting(workbookId).then((a) => setAnswers(a ?? []));
  };
  useEffect(() => {
    let live = true;
    void listForms(workbookId).then((f) => live && setForms(f ?? []));
    void answersWaiting(workbookId).then((a) => live && setAnswers(a ?? []));
    return () => {
      live = false;
    };
  }, [workbookId]);
  const link = (id: string) => `${origin()}/smart-lists/forms/${id}`;

  if (editing)
    return (
      <FormEditor workbookId={workbookId} properties={properties} form={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => {
          setEditing(null);
          load();
        }}
      />
    );

  const waiting = answers?.length ?? 0;
  return (
    <Dialog open onClose={onClose} title="Forms that add rows">
      <div className="space-y-4">
        <div role="tablist" className="flex gap-1 border-b border-line">
          {(["forms", "answers"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${tab === t ? "border-brand font-medium text-text" : "border-transparent text-muted hover:text-text"}`}
              onClick={() => setTab(t)}
            >
              {t === "forms" ? "Forms" : `Answers waiting${waiting ? ` (${waiting})` : ""}`}
            </button>
          ))}
        </div>

        {tab === "answers" ? (
          <AnswersWaiting workbookId={workbookId} answers={answers} onDecided={(id) => setAnswers((a) => (a ?? []).filter((x) => x.id !== id))} />
        ) : (
          <>
            <p className="text-sm text-muted">Share a form&apos;s link with teammates: whoever fills it in adds a row here — without opening this list. Give it a public link for people outside the company.</p>
            <ul className="space-y-2">
              {(forms ?? []).map((f) => (
                <li key={f.id} className="flex flex-wrap items-center gap-2 rounded-base border border-line px-3 py-2">
                  <button type="button" className="min-w-0 flex-1 truncate text-left text-sm font-medium text-text hover:underline" onClick={() => setEditing(f)}>
                    {f.name}
                  </button>
                  {!f.active && <span className="rounded bg-surface-sunken px-1.5 text-xs text-muted">closed</span>}
                  {f.active && f.publicLink?.active && (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded bg-brand-subtle px-1.5 text-xs text-brand hover:underline"
                      aria-label={`Copy the public link to ${f.name}`}
                      onClick={() => void copy(`${origin()}${publicFormPath(f.publicLink!.slug)}`)}
                    >
                      <Globe className="h-3 w-3" aria-hidden="true" />
                      public
                    </button>
                  )}
                  <span className="text-xs text-subtle">
                    {f.fields.length} question{f.fields.length === 1 ? "" : "s"}
                  </span>
                  <button type="button" aria-label={`Copy the link to ${f.name}`} className="rounded p-1 text-subtle hover:text-text" onClick={() => void copy(link(f.id))}>
                    <Copy className="h-4 w-4" />
                  </button>
                  <Link href={`/smart-lists/forms/${f.id}`} target="_blank" aria-label={`Open ${f.name}`} className="rounded p-1 text-subtle hover:text-text">
                    <ExternalLink className="h-4 w-4" />
                  </Link>
                  <button
                    type="button"
                    aria-label={`Delete ${f.name}`}
                    className="rounded p-1 text-subtle hover:text-danger"
                    onClick={async () => {
                      if (!(await confirmAction({ title: `Delete the form "${f.name}"?`, message: "Its links stop working, and answers waiting are dropped. Rows it added stay.", confirmLabel: "Delete form", danger: true }))) return;
                      const r = await deleteListForm(f.id);
                      if (!r.ok) return void toast.error(r.error);
                      load();
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
              {forms && forms.length === 0 && <li className="text-sm text-subtle">No forms yet.</li>}
            </ul>
          </>
        )}
        <div className="flex justify-between border-t border-line pt-4">
          {tab === "forms" ? (
            <Button variant="secondary" onClick={() => setEditing("new")}>
              <Plus className="h-3.5 w-3.5" />
              New form
            </Button>
          ) : (
            <span />
          )}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Answers to the public forms, oldest first: accept one and it becomes a row; decline it and it's forgotten. */
function AnswersWaiting({ workbookId, answers, onDecided }: { workbookId: string; answers: WaitingAnswer[] | null; onDecided: (id: string) => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  if (!answers) return <p className="text-sm text-subtle">Loading…</p>;
  if (!answers.length) return <p className="text-sm text-subtle">Nothing waiting. Answers to a public form that waits for you show here.</p>;
  const decide = async (a: WaitingAnswer, accept: boolean) => {
    setBusy(a.id);
    const r = await decidePublicAnswer({ workbookId, submissionId: a.id, accept });
    setBusy(null);
    if (!r.ok) return void toast.error(r.error);
    toast.success(accept ? `"${a.title}" added as a row.` : "Declined — the answer is forgotten.");
    onDecided(a.id);
    if (accept) router.refresh();
  };
  return (
    <ul className="max-h-[60vh] space-y-2 overflow-y-auto">
      {answers.map((a) => (
        <li key={a.id} className="space-y-1.5 rounded-base border border-line px-3 py-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <p className="min-w-0 flex-1 truncate text-sm font-medium text-text">{a.title}</p>
            <span className="text-xs text-subtle">
              {a.formName} · {new Date(a.at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
            </span>
          </div>
          {a.lines.length > 0 && (
            <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-3 gap-y-0.5 text-xs">
              {a.lines.map((l) => (
                <div key={l.name} className="contents">
                  <dt className="truncate text-muted">{l.name}</dt>
                  <dd className="break-words text-text">{l.text}</dd>
                </div>
              ))}
            </dl>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={busy === a.id} onClick={() => void decide(a, false)}>
              <X className="h-3.5 w-3.5" />
              Decline
            </Button>
            <Button size="sm" disabled={busy === a.id} onClick={() => void decide(a, true)}>
              <Check className="h-3.5 w-3.5" />
              Accept
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function FormEditor({ workbookId, properties, form, onClose, onSaved }: { workbookId: string; properties: BoardProperty[]; form: ListForm | null; onClose: () => void; onSaved: () => void }) {
  const askable = properties.filter((p) => FORM_KINDS.includes(p.kind));
  const [name, setName] = useState(form?.name ?? "");
  const [intro, setIntro] = useState(form?.intro ?? "");
  const [active, setActive] = useState(form?.active ?? true);
  const [fields, setFields] = useState(form?.fields ?? askable.slice(0, 6).map((p) => ({ propertyId: p.id, required: false })));
  // Its public link (phase 4).
  const [publicOn, setPublicOn] = useState(form?.publicLink?.active ?? false);
  const [consent, setConsent] = useState(form?.publicLink?.consent ?? "");
  const [approve, setApprove] = useState(form?.publicLink?.approve ?? true);
  const [newLink, setNewLink] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const has = (id: string) => fields.find((f) => f.propertyId === id);
  const asksPerson = fields.some((f) => properties.find((p) => p.id === f.propertyId)?.kind === "PERSON");
  return (
    <Dialog open onClose={onClose} title={form ? `Form · ${form.name}` : "New form"}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await saveListForm({ workbookId, id: form?.id ?? null, name, intro, fields, active });
            if (!r.ok) return setError(r.error);
            if (publicOn || form?.publicLink) {
              const l = await savePublicLink({ formId: r.data.id, on: publicOn, consent, approve, newLink });
              if (!l.ok) return setError(l.error);
            }
            toast.success("Form saved.");
            onSaved();
          });
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="form-name">Name</Label>
          <Input id="form-name" autoFocus value={name} maxLength={80} placeholder="Request a site survey" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="form-intro">What it&apos;s for</Label>
          <Textarea id="form-intro" rows={2} maxLength={1000} value={intro} placeholder="Shown at the top of the form" onChange={(e) => setIntro(e.target.value)} />
        </div>
        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-sm font-medium text-text">Questions</legend>
          <p className="text-xs text-subtle">The row&apos;s title is always asked. Links, files and counts aren&apos;t asked on a form.</p>
          <ul className="max-h-64 space-y-1 overflow-y-auto">
            {askable.map((p) => {
              const f = has(p.id);
              return (
                <li key={p.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    aria-label={`Ask ${p.name}`}
                    checked={!!f}
                    onChange={(e) => setFields((all) => (e.target.checked ? [...all, { propertyId: p.id, required: false }] : all.filter((x) => x.propertyId !== p.id)))}
                  />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {f && (
                    <label className="flex items-center gap-1 text-xs text-muted">
                      <input type="checkbox" checked={f.required} onChange={(e) => setFields((all) => all.map((x) => (x.propertyId === p.id ? { ...x, required: e.target.checked } : x)))} />
                      must be answered
                    </label>
                  )}
                </li>
              );
            })}
          </ul>
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Open — its link takes answers
        </label>

        <fieldset className="space-y-2 rounded-base border border-line p-3">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={publicOn} onChange={(e) => setPublicOn(e.target.checked)} />
            <span>
              <span className="font-medium text-text">Public link</span>
              <span className="block text-xs text-muted">Anybody with the link can answer, without signing in — customers, visitors, applicants. They see the form, never this list.</span>
            </span>
          </label>
          {publicOn && (
            <div className="space-y-2 pl-6">
              <div className="space-y-1">
                <Label htmlFor="form-consent">What they agree to</Label>
                <Textarea id="form-consent" rows={2} maxLength={CONSENT_MAX} value={consent} placeholder={DEFAULT_CONSENT} onChange={(e) => setConsent(e.target.value)} />
                <p className="text-xs text-subtle">Shown beside a box they must tick. {"{company}"} becomes your company&apos;s name.</p>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={approve} onChange={(e) => setApprove(e.target.checked)} />
                Answers wait for me to accept them before they become rows
              </label>
              {asksPerson && <p className="text-xs text-warning">A Person question isn&apos;t asked on the public link — your team&apos;s names aren&apos;t shown outside.</p>}
              {form?.publicLink && (
                <label className="flex items-center gap-2 text-xs text-muted">
                  <input type="checkbox" checked={newLink} onChange={(e) => setNewLink(e.target.checked)} />
                  Give it a new address — the old link stops working
                </label>
              )}
            </div>
          )}
        </fieldset>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Back
          </Button>
          <Button type="submit" disabled={pending || !name.trim()}>
            {pending ? "Saving…" : "Save form"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** One question of a form, as it's answered. */
function QuestionField({ q, value, people, onChange }: { q: FormQuestion; value: unknown; people: { id: string; name: string }[]; onChange: (v: unknown) => void }) {
  const [editing, setEditing] = useState(false);
  const prop: BoardProperty = { id: q.propertyId, name: q.name, kind: q.kind, options: q.options };
  const set = (v: unknown) => onChange(v === "" ? null : v);
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium text-text">
        {q.name} {q.required && <span className="text-danger">*</span>}
      </p>
      {q.kind === "CHECKBOX" ? (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={value === true} onChange={(e) => set(e.target.checked || null)} />
          Yes
        </label>
      ) : q.kind === "SELECT" ? (
        <Select aria-label={q.name} value={String(value ?? "")} onChange={(e) => set(e.target.value)}>
          <option value="">—</option>
          {q.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
      ) : q.kind === "MULTI_SELECT" ? (
        <div className="flex flex-wrap gap-1.5">
          {q.options.map((o) => {
            const chosen = Array.isArray(value) && value.includes(o.id);
            return (
              <label key={o.id} className="inline-flex cursor-pointer items-center gap-1 text-sm">
                <input type="checkbox" checked={chosen} onChange={(e) => set(e.target.checked ? [...(Array.isArray(value) ? value : []), o.id] : (Array.isArray(value) ? value : []).filter((x) => x !== o.id))} />
                <OptionChip option={o} />
              </label>
            );
          })}
        </div>
      ) : q.kind === "RATING" ? (
        editing ? (
          <CellEditor
            property={prop}
            value={value}
            people={people}
            onSave={(raw) => {
              set(raw);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <button type="button" className="rounded-base border border-line px-2 py-1" onClick={() => setEditing(true)}>
            <CellValue property={prop} value={value} people={new Map(people.map((p) => [p.id, p.name]))} />
          </button>
        )
      ) : q.kind === "PERSON" ? (
        <Select aria-label={q.name} value={String(value ?? "")} onChange={(e) => set(e.target.value)}>
          <option value="">—</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          aria-label={q.name}
          type={q.kind === "DATE" ? "date" : q.kind === "NUMBER" || q.kind === "MONEY" ? "number" : q.kind === "EMAIL" ? "email" : q.kind === "PHONE" ? "tel" : q.kind === "LINK" ? "url" : "text"}
          step="any"
          value={String(value ?? "")}
          onChange={(e) => set(e.target.value)}
        />
      )}
    </div>
  );
}

/** The form itself, as a teammate fills it in. */
export function FormFiller({ form }: { form: { id: string; name: string; intro: string | null; listName: string; titleName: string; questions: FormQuestion[]; people: { id: string; name: string }[] } }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, start] = useTransition();

  if (sent)
    return (
      <div className="space-y-3 rounded-card border border-line bg-surface p-6 text-center">
        <p className="text-base font-semibold text-text">Sent — thank you.</p>
        <p className="text-sm text-muted">A row was added to &ldquo;{form.listName}&rdquo;.</p>
        <Button
          variant="secondary"
          onClick={() => {
            setSent(false);
            setTitle("");
            setAnswers({});
            router.refresh();
          }}
        >
          Fill it in again
        </Button>
      </div>
    );

  return (
    <form
      className="space-y-4 rounded-card border border-line bg-surface p-5"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          setError(null);
          const r = await sendListForm({ formId: form.id, title, answers });
          if (!r.ok) return setError(r.error);
          setSent(true);
        });
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="ff-title">
          {form.titleName} <span className="text-danger">*</span>
        </Label>
        <Input id="ff-title" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
      </div>
      {form.questions.map((q) => (
        <QuestionField key={q.propertyId} q={q} value={answers[q.propertyId] ?? null} people={form.people} onChange={(v) => setAnswers((a) => ({ ...a, [q.propertyId]: v }))} />
      ))}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end border-t border-line pt-4">
        <Button type="submit" disabled={pending || !title.trim()}>
          {pending ? "Sending…" : "Send"}
        </Button>
      </div>
    </form>
  );
}

/**
 * A public form, as somebody outside the company answers it (phase 4): the questions, a box to agree to, and a field a
 * person never sees — filled in, it's a bot.
 */
export function PublicFormFiller({ form }: { form: { slug: string; name: string; titleName: string; questions: FormQuestion[]; consent: string } }) {
  const shownAt = useRef<number>(0);
  const [title, setTitle] = useState("");
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [agreed, setAgreed] = useState(false);
  const [website, setWebsite] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [thanks, setThanks] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    shownAt.current = Date.now();
  }, []);

  if (thanks)
    return (
      <div className="space-y-2 rounded-card border border-line bg-surface p-6 text-center">
        <p className="text-base font-semibold text-text">{thanks}</p>
      </div>
    );

  return (
    <form
      className="space-y-4 rounded-card border border-line bg-surface p-5"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          setError(null);
          const r = await sendPublicListForm({ slug: form.slug, title, answers, consent: agreed, website, elapsedMs: shownAt.current ? Date.now() - shownAt.current : undefined });
          if (!r.ok) return setError(r.error);
          setThanks(r.thankYou);
        });
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="pf-title">
          {form.titleName} <span className="text-danger">*</span>
        </Label>
        <Input id="pf-title" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
      </div>
      {form.questions.map((q) => (
        <QuestionField key={q.propertyId} q={q} value={answers[q.propertyId] ?? null} people={[]} onChange={(v) => setAnswers((a) => ({ ...a, [q.propertyId]: v }))} />
      ))}
      {/* Never shown to a person: only a bot fills it in. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="pf-website">Website</label>
        <input id="pf-website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
      </div>
      <label className="flex items-start gap-2 text-sm text-text">
        <input type="checkbox" className="mt-0.5" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        <span>{form.consent}</span>
      </label>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end border-t border-line pt-4">
        <Button type="submit" disabled={pending || !title.trim() || !agreed}>
          {pending ? "Sending…" : "Send"}
        </Button>
      </div>
    </form>
  );
}
