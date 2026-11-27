"use client";

import { useState } from "react";
import { AlignCenter, AlignLeft, AlignRight, ImagePlus, Plus, Trash2 } from "lucide-react";
import { audienceLabel, type Block, type BlockAudience } from "@/lib/marketing/email-design";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { MergeFieldMenu, RichText } from "@/components/marketing/builder/rich-text";

/**
 * The right-hand panel of the email builder: the chosen block's settings, each change drawn on the canvas at once.
 */

type Change = (next: Block) => void;

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-subtle">{hint}</p>}
    </div>
  );
}

/** A one-line text box with the merge-field menu beside it. */
function Words({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="flex items-center gap-1">
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="h-8 text-sm" />
      <div className="w-24 shrink-0">
        <MergeFieldMenu onPick={(t) => onChange(`${value}${value && !value.endsWith(" ") ? " " : ""}${t}`)} />
      </div>
    </div>
  );
}

function AlignPicker({ value, onChange }: { value: "left" | "center" | "right"; onChange: (v: "left" | "center" | "right") => void }) {
  const items = [
    ["left", AlignLeft],
    ["center", AlignCenter],
    ["right", AlignRight],
  ] as const;
  return (
    <div className="inline-flex rounded-base border border-line">
      {items.map(([v, Icon]) => (
        <button key={v} type="button" title={`Align ${v}`} onClick={() => onChange(v)} className={`flex h-8 w-9 items-center justify-center ${value === v ? "bg-brand text-white" : "text-muted hover:text-text"}`}>
          <Icon className="h-4 w-4" />
        </button>
      ))}
    </div>
  );
}

/** A colour: a swatch to pick, the hex beside it, and a way back to the theme's own. */
export function ColorField({ label, value, onChange, auto = "Theme colour", fallback = "#1d4ed8" }: { label: string; value: string | undefined; onChange: (v: string | undefined) => void; auto?: string; fallback?: string }) {
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <input type="color" value={value ?? fallback} onChange={(e) => onChange(e.target.value)} className="h-8 w-10 cursor-pointer rounded border border-line bg-surface" aria-label={label} />
        <span className="font-mono text-xs text-muted">{value ?? auto}</span>
        {value && (
          <button type="button" onClick={() => onChange(undefined)} className="text-xs text-brand hover:underline">
            Reset
          </button>
        )}
      </div>
    </Field>
  );
}

/** A picture: uploaded and hosted here, or a web address. */
function PictureField({ value, onChange, label = "Picture" }: { value: string; onChange: (v: string) => void; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch("/api/marketing/assets/upload", { method: "POST", body: form });
      const data = (await res.json()) as { ok: boolean; url?: string; error?: string };
      if (!data.ok || !data.url) setError(data.error ?? "The picture couldn't be uploaded.");
      else onChange(data.url);
    } catch {
      setError("The picture couldn't be uploaded.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Field label={label} hint="PNG, JPEG, GIF or WebP, up to 2 MB — made no wider than 1200 pixels. A logo on a transparent background looks best.">
      <label className={`flex cursor-pointer items-center justify-center gap-2 rounded-base border border-dashed border-line-strong px-3 py-4 text-sm text-muted hover:border-brand hover:text-brand ${busy ? "opacity-60" : ""}`}>
        <ImagePlus className="h-4 w-4" />
        {busy ? "Uploading…" : value ? "Replace picture" : "Upload a picture"}
        <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="sr-only" disabled={busy} onChange={(e) => upload(e.target.files?.[0])} />
      </label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="…or paste an image address (https://)" className="h-8 text-xs" />
      {error && <p className="text-xs text-danger">{error}</p>}
    </Field>
  );
}

/** A size in pixels on a slider, with "Reset" back to what the block draws when none is chosen. */
function PxSlider({ label, value, fallback, min, max, step = 1, onChange }: { label: string; value: number | undefined; fallback: number; min: number; max: number; step?: number; onChange: (v: number | undefined) => void }) {
  return (
    <Field label={`${label} — ${value ?? fallback}px${value === undefined ? " (standard)" : ""}`}>
      <div className="flex items-center gap-2">
        <input type="range" min={min} max={max} step={step} value={value ?? fallback} onChange={(e) => onChange(Number(e.target.value))} className="w-full" />
        {value !== undefined && (
          <button type="button" onClick={() => onChange(undefined)} className="shrink-0 text-xs text-brand hover:underline">
            Reset
          </button>
        )}
      </div>
    </Field>
  );
}

/** What every block may set about its own look (owner, 1 Nov 2026): a background, and the space above and below it. */
function StyleSection({ block, onChange }: { block: Block; onChange: Change }) {
  return (
    <div className="space-y-3 border-t border-line pt-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-subtle">Style</p>
      <ColorField label="Background" value={block.bg} onChange={(v) => onChange({ ...block, bg: v })} auto="None — the email's" fallback="#ffffff" />
      <PxSlider label="Space above" value={block.padTop} fallback={0} min={0} max={80} step={4} onChange={(v) => onChange({ ...block, padTop: v })} />
      <PxSlider label="Space below" value={block.padBottom} fallback={0} min={0} max={80} step={4} onChange={(v) => onChange({ ...block, padBottom: v })} />
    </div>
  );
}

/**
 * Who sees the block (owner, 1 Nov 2026): everybody, customers or prospects — and, if need be, only some cities or
 * states. Everybody else gets the email without it.
 */
function AudienceSection({ block, onChange }: { block: Block; onChange: Change }) {
  const show = block.show ?? { who: "everyone" as const, cities: "", states: "" };
  const set = (next: Partial<BlockAudience>) => {
    const merged = { ...show, ...next };
    // Back to everybody everywhere: nothing kept on the block.
    onChange({ ...block, show: merged.who === "everyone" && !merged.cities.trim() && !merged.states.trim() ? undefined : merged });
  };
  const places = (v: string) => v.replace(/[{}|]/g, "");
  return (
    <div className="space-y-3 border-t border-line pt-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-subtle">Who sees it</p>
      <Field label="Show to">
        <Select value={show.who} onChange={(e) => set({ who: e.target.value as BlockAudience["who"] })} className="h-8 text-sm">
          <option value="everyone">Everyone</option>
          <option value="customers">Customers only — have bought from us</option>
          <option value="prospects">Prospects only — haven&apos;t bought yet</option>
        </Select>
      </Field>
      <Field label="Only in these cities" hint="Commas between — Pune, Mumbai. Empty for anywhere.">
        <Input value={show.cities} onChange={(e) => set({ cities: places(e.target.value) })} placeholder="Anywhere" className="h-8 text-sm" />
      </Field>
      <Field label="Only in these states" hint="As written on the company — Maharashtra, Karnataka.">
        <Input value={show.states} onChange={(e) => set({ states: places(e.target.value) })} placeholder="Anywhere" className="h-8 text-sm" />
      </Field>
      {audienceLabel(block.show) && <p className="text-[11px] text-subtle">Everybody else gets the email without this block. Preview shows it as a customer or a prospect sees it.</p>}
    </div>
  );
}

/** `accent`: the email's brand colour, which a block's colour follows until one is chosen. */
export function BlockInspector({ block, onChange, accent }: { block: Block; onChange: Change; accent: string }) {
  return (
    <div className="space-y-4">
      <BlockContent block={block} onChange={onChange} accent={accent} />
      <StyleSection block={block} onChange={onChange} />
      <AudienceSection block={block} onChange={onChange} />
    </div>
  );
}

function BlockContent({ block, onChange, accent }: { block: Block; onChange: Change; accent: string }) {
  switch (block.type) {
    case "logo":
      return (
        <div className="space-y-3">
          <PxSlider label="Logo size" value={block.size} fallback={160} min={60} max={320} step={10} onChange={(v) => onChange({ ...block, size: v })} />
          <Field label="Position" hint={block.partner?.src ? "With a second logo, yours sits on the left and theirs on the right." : undefined}>
            <AlignPicker value={block.align} onChange={(v) => onChange({ ...block, align: v })} />
          </Field>
          <details className="rounded-base border border-line p-2" open={!!block.src}>
            <summary className="cursor-pointer text-xs text-text">Use a different logo for this email</summary>
            <div className="mt-2 space-y-2">
              <p className="text-[11px] text-subtle">Otherwise it&apos;s your logo from Settings › Branding — or your company name, when there&apos;s none.</p>
              <PictureField label="Logo" value={block.src ?? ""} onChange={(v) => onChange({ ...block, src: v || undefined })} />
              {block.src && (
                <button type="button" onClick={() => onChange({ ...block, src: undefined })} className="text-xs text-brand hover:underline">
                  Back to the branding logo
                </button>
              )}
            </div>
          </details>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={block.bar} onChange={(e) => onChange({ ...block, bar: e.target.checked })} />
            Coloured line under it
          </label>
          {block.bar && <ColorField label="Line colour" value={block.barColor} onChange={(v) => onChange({ ...block, barColor: v })} fallback={accent} />}
          <div className="space-y-2 rounded-base border border-line p-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={!!block.partner}
                onChange={(e) => onChange({ ...block, partner: e.target.checked ? { src: "", alt: "", width: 110, link: "" } : undefined })}
              />
              Second logo on the right
            </label>
            <p className="text-[11px] text-subtle">A maker&apos;s or partner&apos;s — Microsoft, Autodesk, Adobe — beside yours. Use it only as your partner agreement allows.</p>
            {block.partner && (
              <div className="space-y-2">
                <PictureField label="Their logo" value={block.partner.src} onChange={(v) => onChange({ ...block, partner: { ...block.partner!, src: v } })} />
                <PxSlider label="Its size" value={block.partner.width} fallback={110} min={40} max={260} step={10} onChange={(v) => onChange({ ...block, partner: { ...block.partner!, width: v ?? 110 } })} />
                <Field label="Name (shown if pictures are blocked)">
                  <Input value={block.partner.alt} onChange={(e) => onChange({ ...block, partner: { ...block.partner!, alt: e.target.value } })} placeholder="Microsoft Solutions Partner" className="h-8 text-sm" />
                </Field>
                <Field label="Link (optional)">
                  <Input value={block.partner.link} onChange={(e) => onChange({ ...block, partner: { ...block.partner!, link: e.target.value } })} placeholder="https://" className="h-8 text-sm" />
                </Field>
              </div>
            )}
          </div>
        </div>
      );
    case "heading":
      return (
        <div className="space-y-3">
          <Field label="Heading">
            <Words value={block.text} onChange={(v) => onChange({ ...block, text: v })} />
          </Field>
          <Field label="Kind">
            <Select value={block.level} onChange={(e) => onChange({ ...block, level: Number(e.target.value) === 2 ? 2 : 1 })} className="h-8 text-sm">
              <option value={1}>Title</option>
              <option value={2}>Section heading</option>
            </Select>
          </Field>
          <PxSlider label="Font size" value={block.size} fallback={block.level === 1 ? 24 : 18} min={14} max={48} onChange={(v) => onChange({ ...block, size: v })} />
          <Field label="Alignment">
            <AlignPicker value={block.align} onChange={(v) => onChange({ ...block, align: v })} />
          </Field>
          <ColorField label="Colour" value={block.color} onChange={(v) => onChange({ ...block, color: v })} fallback={accent} />
        </div>
      );
    case "text":
      return (
        <div className="space-y-3">
          <Field label="Text">
            <RichText key={block.id} value={block.html} onChange={(v) => onChange({ ...block, html: v })} />
          </Field>
          <PxSlider label="Font size" value={block.size === 15 ? undefined : block.size} fallback={15} min={11} max={24} onChange={(v) => onChange({ ...block, size: v ?? 15 })} />
          <Field label="Alignment">
            <AlignPicker value={block.align} onChange={(v) => onChange({ ...block, align: v })} />
          </Field>
          <ColorField label="Colour" value={block.color} onChange={(v) => onChange({ ...block, color: v })} auto="Page text colour" fallback="#1f2937" />
        </div>
      );
    case "image":
      return (
        <div className="space-y-3">
          <PictureField value={block.src} onChange={(v) => onChange({ ...block, src: v })} />
          <Field label="Description" hint="Shown when pictures are blocked, and read out by screen readers.">
            <Input value={block.alt} onChange={(e) => onChange({ ...block, alt: e.target.value })} className="h-8 text-sm" />
          </Field>
          <Field label={`Width — ${block.width}%`}>
            <input type="range" min={10} max={100} step={5} value={block.width} onChange={(e) => onChange({ ...block, width: Number(e.target.value) })} className="w-full" />
          </Field>
          <Field label="Alignment">
            <AlignPicker value={block.align} onChange={(v) => onChange({ ...block, align: v })} />
          </Field>
          <Field label="Link (optional)">
            <Input value={block.link} onChange={(e) => onChange({ ...block, link: e.target.value })} placeholder="https://" className="h-8 text-sm" />
          </Field>
          <PxSlider label="Rounded corners" value={block.radius} fallback={4} min={0} max={40} onChange={(v) => onChange({ ...block, radius: v })} />
        </div>
      );
    case "button":
      return (
        <div className="space-y-3">
          <Field label="Button text">
            <Input value={block.label} onChange={(e) => onChange({ ...block, label: e.target.value })} className="h-8 text-sm" />
          </Field>
          <Field label="Link" hint="A web page (https://), an email (mailto:) or a phone (tel:). {{ownerEmail}} writes to the account manager.">
            <Words value={block.link} onChange={(v) => onChange({ ...block, link: v })} placeholder="https://" />
          </Field>
          <Field label="Alignment">
            <AlignPicker value={block.align} onChange={(v) => onChange({ ...block, align: v })} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={block.full} onChange={(e) => onChange({ ...block, full: e.target.checked })} />
            Full width
          </label>
          <Field label="Size">
            <Select value={block.shape ?? "medium"} onChange={(e) => onChange({ ...block, shape: e.target.value as "small" | "medium" | "large" })} className="h-8 text-sm">
              <option value="small">Small</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
            </Select>
          </Field>
          <PxSlider label="Font size" value={block.fontSize} fallback={15} min={12} max={22} onChange={(v) => onChange({ ...block, fontSize: v })} />
          <PxSlider label="Rounded corners" value={block.radius} fallback={6} min={0} max={30} onChange={(v) => onChange({ ...block, radius: v })} />
          <ColorField label="Button colour" value={block.color} onChange={(v) => onChange({ ...block, color: v })} fallback={accent} />
          <ColorField label="Text colour" value={block.textColor} onChange={(v) => onChange({ ...block, textColor: v })} auto="Automatic" fallback="#ffffff" />
        </div>
      );
    case "banner":
      return (
        <div className="space-y-3">
          <Field label="Small line above">
            <Input value={block.eyebrow} onChange={(e) => onChange({ ...block, eyebrow: e.target.value })} className="h-8 text-sm" />
          </Field>
          <Field label="Headline">
            <Words value={block.title} onChange={(v) => onChange({ ...block, title: v })} />
          </Field>
          <Field label="Line below">
            <Textarea value={block.subtitle} onChange={(e) => onChange({ ...block, subtitle: e.target.value })} rows={2} className="text-sm" />
          </Field>
          <Field label="Alignment">
            <AlignPicker value={block.align} onChange={(v) => onChange({ ...block, align: v })} />
          </Field>
          <PxSlider label="Headline size" value={block.titleSize} fallback={28} min={18} max={48} onChange={(v) => onChange({ ...block, titleSize: v })} />
          <ColorField label="Banner colour" value={block.background} onChange={(v) => onChange({ ...block, background: v })} fallback={accent} />
          <ColorField label="Text colour" value={block.textColor} onChange={(v) => onChange({ ...block, textColor: v })} auto="Automatic" fallback="#ffffff" />
        </div>
      );
    case "details":
      return (
        <div className="space-y-3">
          <Field label="Title">
            <Input value={block.title} onChange={(e) => onChange({ ...block, title: e.target.value })} className="h-8 text-sm" />
          </Field>
          <Field label="Rows" hint="Use fields such as {{productName}} or {{expiryDate}} for each customer's own.">
            <div className="space-y-2">
              {block.rows.map((r, i) => (
                <div key={i} className="space-y-1 rounded-base border border-line p-2">
                  <div className="flex items-center gap-1">
                    <Input value={r.label} onChange={(e) => onChange({ ...block, rows: block.rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} placeholder="Label" className="h-8 text-sm" />
                    <button type="button" title="Remove row" onClick={() => onChange({ ...block, rows: block.rows.filter((_, j) => j !== i) })} className="text-muted hover:text-danger">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <Words value={r.value} onChange={(v) => onChange({ ...block, rows: block.rows.map((x, j) => (j === i ? { ...x, value: v } : x)) })} placeholder="Value" />
                </div>
              ))}
              {block.rows.length < 20 && (
                <button type="button" onClick={() => onChange({ ...block, rows: [...block.rows, { label: "Label", value: "Value" }] })} className="flex items-center gap-1 text-xs text-brand hover:underline">
                  <Plus className="h-3.5 w-3.5" /> Add a row
                </button>
              )}
            </div>
          </Field>
          <ColorField label="Box colour" value={block.background} onChange={(v) => onChange({ ...block, background: v })} auto="A soft brand colour" fallback="#eef2ff" />
          <ColorField label="Label colour" value={block.labelColor} onChange={(v) => onChange({ ...block, labelColor: v })} auto="Grey" fallback="#6b7280" />
        </div>
      );
    case "checklist":
      return (
        <div className="space-y-3">
          <Field label="Title">
            <Input value={block.title} onChange={(e) => onChange({ ...block, title: e.target.value })} className="h-8 text-sm" />
          </Field>
          <Field label="Points">
            <div className="space-y-1.5">
              {block.items.map((item, i) => (
                <div key={i} className="flex items-center gap-1">
                  <Input value={item} onChange={(e) => onChange({ ...block, items: block.items.map((x, j) => (j === i ? e.target.value : x)) })} className="h-8 text-sm" />
                  <button type="button" title="Remove" onClick={() => onChange({ ...block, items: block.items.filter((_, j) => j !== i) })} className="text-muted hover:text-danger">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
              {block.items.length < 12 && (
                <button type="button" onClick={() => onChange({ ...block, items: [...block.items, "Another point"] })} className="flex items-center gap-1 text-xs text-brand hover:underline">
                  <Plus className="h-3.5 w-3.5" /> Add a point
                </button>
              )}
            </div>
          </Field>
        </div>
      );
    case "columns":
      return (
        <div className="space-y-3">
          <Field label="How many">
            <Select
              value={block.columns.length}
              onChange={(e) => {
                const n = Number(e.target.value);
                const cols = block.columns.slice(0, n);
                while (cols.length < n) cols.push({ title: "Title", text: "A line about it." });
                onChange({ ...block, columns: cols });
              }}
              className="h-8 text-sm"
            >
              <option value={2}>Two columns</option>
              <option value={3}>Three columns</option>
            </Select>
          </Field>
          {block.columns.map((c, i) => (
            <div key={i} className="space-y-1 rounded-base border border-line p-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-subtle">Column {i + 1}</p>
              <Input value={c.title} onChange={(e) => onChange({ ...block, columns: block.columns.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })} className="h-8 text-sm" />
              <Textarea value={c.text} onChange={(e) => onChange({ ...block, columns: block.columns.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })} rows={3} className="text-sm" />
            </div>
          ))}
        </div>
      );
    case "social":
      return (
        <div className="space-y-3">
          <Field label="Links">
            <div className="space-y-2">
              {block.links.map((l, i) => (
                <div key={i} className="space-y-1 rounded-base border border-line p-2">
                  <div className="flex items-center gap-1">
                    <Input value={l.label} onChange={(e) => onChange({ ...block, links: block.links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} placeholder="LinkedIn" className="h-8 text-sm" />
                    <button type="button" title="Remove" onClick={() => onChange({ ...block, links: block.links.filter((_, j) => j !== i) })} className="text-muted hover:text-danger">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <Input value={l.url} onChange={(e) => onChange({ ...block, links: block.links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} placeholder="https://" className="h-8 text-xs" />
                </div>
              ))}
              {block.links.length < 8 && (
                <button type="button" onClick={() => onChange({ ...block, links: [...block.links, { label: "Link", url: "https://" }] })} className="flex items-center gap-1 text-xs text-brand hover:underline">
                  <Plus className="h-3.5 w-3.5" /> Add a link
                </button>
              )}
            </div>
          </Field>
          <Field label="Alignment">
            <AlignPicker value={block.align} onChange={(v) => onChange({ ...block, align: v })} />
          </Field>
        </div>
      );
    case "signature":
      return (
        <div className="space-y-3">
          <Field label="Closing line">
            <Input value={block.closing} onChange={(e) => onChange({ ...block, closing: e.target.value })} className="h-8 text-sm" />
          </Field>
          <p className="text-xs text-muted">Signed by each customer&apos;s account manager — or your team, when they have none — with your company name.</p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={block.contacts} onChange={(e) => onChange({ ...block, contacts: e.target.checked })} />
            Show your email and phone
          </label>
        </div>
      );
    case "divider":
      return (
        <div className="space-y-3">
          <Field label="Thickness">
            <Select value={block.thickness} onChange={(e) => onChange({ ...block, thickness: Number(e.target.value) as 1 | 2 | 4 })} className="h-8 text-sm">
              <option value={1}>Thin</option>
              <option value={2}>Medium</option>
              <option value={4}>Thick</option>
            </Select>
          </Field>
          <ColorField label="Colour" value={block.color} onChange={(v) => onChange({ ...block, color: v })} auto="Light grey" fallback="#e5e7eb" />
        </div>
      );
    case "spacer":
      return (
        <Field label={`Height — ${block.height}px`}>
          <input type="range" min={4} max={120} step={4} value={block.height} onChange={(e) => onChange({ ...block, height: Number(e.target.value) })} className="w-full" />
        </Field>
      );
    case "html":
      return (
        <Field label="HTML" hint="Cleaned when you save, as an uploaded template is: scripts, forms and anything that runs are removed.">
          <Textarea value={block.html} onChange={(e) => onChange({ ...block, html: e.target.value })} rows={12} className="font-mono text-xs" />
        </Field>
      );
  }
}
