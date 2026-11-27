"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Lock } from "lucide-react";
import { updatePrintTemplate, type PrintTemplateRow } from "@/actions/print-template";
import {
  DEFAULT_ACCENT,
  PRINT_FONTS,
  PRINT_LABEL_DEFAULTS,
  PRINT_LABEL_KEYS,
  PRINT_LAYOUTS,
  PRINT_PAPERS,
  PRINT_SHOW_GROUPS,
  encodePrintDraft,
  optionsFor,
  partyLabelDefault,
  printFontLabels,
  printLayoutInfo,
  printOptionsSchema,
  type PrintLabelKey,
  type PrintOptions,
  type PrintShowKey,
} from "@/lib/documents/print-template";
import { documentDirection, tradeDocumentLabels } from "@/lib/trade-documents";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ActionNotice } from "@/components/ui/action-notice";
import { confirmAction } from "@/components/ui/confirm";
import { useUnsavedGuard } from "@/components/cms/common/use-unsaved-guard";
import { cn } from "@/lib/utils";

type Preview = { id: string; docNumber: string; label: string; sameType: boolean } | null;

const HEX = /^#[0-9a-fA-F]{6}$/;
/** The print page's width (max-w-[820px] and its margin), drawn whole and scaled to the column. */
const PAGE_WIDTH = 860;
const snapshot = (name: string, options: PrintOptions) => JSON.stringify({ name: name.trim(), options });

const LABEL_NAMES: Record<PrintLabelKey, string> = {
  billTo: "Bill to box",
  shipTo: "Ship to box",
  details: "Details box",
  amountInWords: "Amount in words",
  bankDetails: "Bank details",
  terms: "Terms",
  signatory: "Signatory line",
};

/**
 * The template editor: what it looks like, what it says and what it shows on the left; on the right the real print
 * page of a real document with the unsaved options applied (`?draft=`, src/lib/documents/print-template-server.ts),
 * redrawn a moment after each change. Below the form on a phone.
 */
export function PrintTemplateEditor({ template, preview }: { template: PrintTemplateRow & { options: PrintOptions }; preview: Preview }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(template.name);
  const [options, setOptions] = useState<PrintOptions>(template.options);
  const [saved, setSaved] = useState(() => snapshot(template.name, template.options));
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const docType = template.docType;
  const typeLabel = tradeDocumentLabels[docType];
  const isSales = documentDirection[docType] === "SALES";
  const rules = useMemo(() => optionsFor(docType), [docType]);
  const dirty = snapshot(name, options) !== saved;
  useUnsavedGuard(dirty);

  // Checked as the save will be: the preview only ever shows options that would save, and a half-typed colour waits.
  const checked = useMemo(() => printOptionsSchema.safeParse(options), [options]);
  const errorAt = (path: string) => (checked.success ? null : (checked.error.issues.find((i) => i.path.join(".") === path)?.message ?? null));

  const [draft, setDraft] = useState(() => encodePrintDraft(template.options));
  useEffect(() => {
    if (!checked.success) return;
    const next = encodePrintDraft(checked.data);
    const timer = setTimeout(() => setDraft(next), 400);
    return () => clearTimeout(timer);
  }, [checked]);

  const set = <K extends keyof PrintOptions>(key: K, value: PrintOptions[K]) => setOptions((o) => ({ ...o, [key]: value }));
  const setLabel = (key: PrintLabelKey, value: string) => setOptions((o) => ({ ...o, labels: { ...o.labels, [key]: value } }));
  const setShow = (key: PrintShowKey, value: boolean) => setOptions((o) => ({ ...o, show: { ...o.show, [key]: value } }));

  function save() {
    setNotice(null);
    if (!checked.success) {
      setNotice({ tone: "error", text: checked.error.issues[0]?.message ?? "Some of these options aren't valid." });
      return;
    }
    startTransition(async () => {
      const result = await updatePrintTemplate({ id: template.id, name, options });
      if (!result.ok) {
        setNotice({ tone: "error", text: result.error });
        return;
      }
      const renamed = result.data.name !== name.trim();
      setName(result.data.name);
      setSaved(snapshot(result.data.name, options));
      setNotice({
        tone: "success",
        text: renamed
          ? `Saved as “${result.data.name}” — another ${typeLabel.toLowerCase()} template is already called that.`
          : "Saved. Everything printed with this template looks like this from now on.",
      });
      router.refresh();
    });
  }

  async function cancel() {
    if (dirty && !(await confirmAction({ title: "Discard your changes?", message: "The template stays as it was last saved.", confirmLabel: "Discard", danger: true }))) return;
    router.push("/settings/document-templates");
  }

  const groups = PRINT_SHOW_GROUPS.map((group) => ({ group, rows: rules.switches.filter((s) => s.group === group) })).filter((g) => g.rows.length > 0);
  const labelKeys = PRINT_LABEL_KEYS.filter((k) => k !== "bankDetails" || isSales);

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-4">
        <Card>
          <CardContent className="space-y-1.5">
            <Label htmlFor="tpl-name">Template name</Label>
            <Input id="tpl-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
            <p className="text-xs text-subtle">Shown in the Template picker above a printed {typeLabel.toLowerCase()}.</p>
          </CardContent>
        </Card>

        <Section title="Layout & style">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Layout">
            {PRINT_LAYOUTS.map((l) => (
              <button
                key={l}
                type="button"
                role="radio"
                aria-checked={options.layout === l}
                onClick={() => set("layout", l)}
                className={cn(
                  "rounded-base border p-3 text-left transition-colors",
                  options.layout === l ? "border-brand bg-brand-subtle" : "border-line hover:bg-surface-sunken",
                )}
              >
                <span className="block text-sm font-medium text-text">{printLayoutInfo[l].label}</span>
                <span className="mt-0.5 block text-xs text-muted">{printLayoutInfo[l].description}</span>
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="tpl-accent">Accent colour</Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label="Pick the accent colour"
                  value={HEX.test(options.accentColor) ? options.accentColor.toLowerCase() : DEFAULT_ACCENT}
                  onChange={(e) => set("accentColor", e.target.value)}
                  className="h-9 w-11 shrink-0 cursor-pointer rounded-base border border-line-strong bg-surface p-1"
                />
                <Input id="tpl-accent" value={options.accentColor} onChange={(e) => set("accentColor", e.target.value)} maxLength={7} className="w-28 font-mono" />
                {options.accentColor.toLowerCase() !== DEFAULT_ACCENT && (
                  <Button variant="ghost" size="sm" onClick={() => set("accentColor", DEFAULT_ACCENT)}>
                    Black
                  </Button>
                )}
              </div>
              <FieldNote error={errorAt("accentColor")}>Standard and Compact colour the title and the total with it; Modern, the band and the table header.</FieldNote>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-font">Font</Label>
              <Select id="tpl-font" value={options.font} onChange={(e) => set("font", e.target.value as PrintOptions["font"])}>
                {PRINT_FONTS.map((f) => (
                  <option key={f} value={f}>
                    {printFontLabels[f]}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        </Section>

        <Section title="Text & labels">
          <div className="space-y-1.5">
            <Label htmlFor="tpl-title">Title</Label>
            <Input
              id="tpl-title"
              value={rules.titleLocked ? "" : options.title}
              onChange={(e) => set("title", e.target.value)}
              disabled={Boolean(rules.titleLocked)}
              maxLength={60}
              placeholder={typeLabel}
            />
            <FieldNote error={errorAt("title")}>{rules.titleLocked ?? `Blank prints “${typeLabel}”.`}</FieldNote>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-header">Line under the letterhead</Label>
            <Input id="tpl-header" value={options.headerNote} onChange={(e) => set("headerNote", e.target.value)} maxLength={200} placeholder="Registered office: … · CIN: …" />
            <FieldNote error={errorAt("headerNote")}>Left blank, nothing is added.</FieldNote>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-footer">Footer</Label>
            <Input
              id="tpl-footer"
              value={options.footerText}
              onChange={(e) => set("footerText", e.target.value)}
              maxLength={300}
              placeholder={`This is a computer-generated ${typeLabel.toLowerCase()}.`}
            />
            <FieldNote error={errorAt("footerText")}>Under the page. Switch the footer line off below to print none.</FieldNote>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-terms">Terms when the document has none</Label>
            <Textarea id="tpl-terms" rows={4} value={options.defaultTerms} onChange={(e) => set("defaultTerms", e.target.value)} maxLength={2000} />
            <FieldNote error={errorAt("defaultTerms")}>A document&apos;s own terms always print in their place.</FieldNote>
          </div>
          <div>
            <p className="text-[13px] font-medium text-muted">Labels</p>
            <div className="mt-1.5 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {labelKeys.map((key) => (
                <div key={key} className="space-y-1">
                  <Label htmlFor={`tpl-label-${key}`} className="text-xs">
                    {key === "billTo" && !isSales ? "Vendor box" : LABEL_NAMES[key]}
                  </Label>
                  <Input
                    id={`tpl-label-${key}`}
                    value={options.labels[key]}
                    onChange={(e) => setLabel(key, e.target.value)}
                    maxLength={40}
                    placeholder={key === "billTo" ? partyLabelDefault(docType) : PRINT_LABEL_DEFAULTS[key]}
                    className="h-8"
                  />
                  {errorAt(`labels.${key}`) && <p className="text-xs text-danger">{errorAt(`labels.${key}`)}</p>}
                </div>
              ))}
            </div>
          </div>
        </Section>

        <Section title="What to show">
          {groups.map(({ group, rows }) => (
            <div key={group}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-subtle">{group}</h3>
              <ul className="mt-1 divide-y divide-line">
                {rows.map((s) => (
                  <li key={s.key} className="flex items-start justify-between gap-4 py-2.5">
                    <div className="min-w-0 text-sm">
                      <p id={`show-${s.key}`} className="font-medium text-text">
                        {s.label}
                      </p>
                      {(s.locked || s.hint) && (
                        <p id={`show-${s.key}-why`} className="mt-0.5 text-xs text-muted">
                          {s.locked ? (
                            <>
                              <Lock className="mr-1 inline h-3 w-3 align-[-1px]" aria-hidden />
                              Always printed on a {typeLabel.toLowerCase()}. {s.locked}
                            </>
                          ) : (
                            s.hint
                          )}
                        </p>
                      )}
                    </div>
                    <Switch
                      checked={s.locked ? true : options.show[s.key]}
                      disabled={Boolean(s.locked)}
                      onChange={(next) => setShow(s.key, next)}
                      aria-labelledby={`show-${s.key}`}
                      aria-describedby={s.locked || s.hint ? `show-${s.key}-why` : undefined}
                      className="mt-0.5"
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Section>

        <Section title="Paper">
          <div className="space-y-1.5">
            <Label htmlFor="tpl-paper">Paper size</Label>
            <Select id="tpl-paper" value={options.paper} onChange={(e) => set("paper", e.target.value as PrintOptions["paper"])} className="sm:w-60">
              {PRINT_PAPERS.map((p) => (
                <option key={p} value={p}>
                  {p === "A4" ? "A4 (210 × 297 mm)" : "US Letter (8.5 × 11 in)"}
                </option>
              ))}
            </Select>
            <p className="text-xs text-subtle">What Print / Save as PDF, and the PDF attached to an email, are sized to.</p>
          </div>
        </Section>

        {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}

        <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t border-line bg-surface/95 py-3 backdrop-blur">
          <Button onClick={save} disabled={pending || !dirty || !name.trim()}>
            {pending ? "Saving…" : "Save template"}
          </Button>
          <Button variant="ghost" onClick={cancel} disabled={pending}>
            Cancel
          </Button>
          {dirty && <span className="text-xs text-subtle">Unsaved changes</span>}
        </div>
      </div>

      <div className="min-w-0 xl:sticky xl:top-4 xl:self-start">
        <Card>
          <CardHeader className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-text">Preview</h2>
              <p className="mt-0.5 text-xs text-muted">
                {!preview
                  ? "There's no document you can see to preview this on yet. The template saves all the same."
                  : preview.sameType
                    ? `Your latest ${preview.label.toLowerCase()}, ${preview.docNumber}.`
                    : `There's no ${typeLabel.toLowerCase()} yet, so this is your latest ${preview.label.toLowerCase()}, ${preview.docNumber}, with the template applied.`}
              </p>
            </div>
            {preview?.sameType && (
              <a
                href={`/documents/${preview.id}/print?template=${encodeURIComponent(template.id)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-brand hover:underline"
              >
                Saved version <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </CardHeader>
          {preview && (
            <CardContent className="p-3">
              <PreviewFrame src={`/documents/${preview.id}/print?embed=1&draft=${draft}`} title={`Preview of ${preview.docNumber}`} />
            </CardContent>
          )}
        </Card>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold text-text">{title}</h2>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

function FieldNote({ error, children }: { error: string | null; children: React.ReactNode }) {
  return error ? <p className="text-xs text-danger">{error}</p> : <p className="text-xs text-subtle">{children}</p>;
}

/** The print page at its own width, scaled to fit the column, as tall as the page it holds. */
function PreviewFrame({ src, title }: { src: string; title: string }) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [scale, setScale] = useState(0.6);
  const [height, setHeight] = useState(1200);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) setScale(Math.min(1, width / PAGE_WIDTH));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  function measure() {
    try {
      const page = frame.current?.contentDocument?.documentElement;
      if (page) setHeight(Math.max(600, page.scrollHeight));
    } catch {
      // Same origin, so it can be read; if it ever can't, the frame keeps its height.
    }
  }

  return (
    <div ref={box} className="overflow-hidden rounded-base border border-line bg-surface-sunken" style={{ height: Math.ceil(height * scale) }}>
      <iframe
        ref={frame}
        src={src}
        title={title}
        onLoad={measure}
        style={{ width: PAGE_WIDTH, height, transform: `scale(${scale})`, transformOrigin: "top left", border: 0 }}
      />
    </div>
  );
}
