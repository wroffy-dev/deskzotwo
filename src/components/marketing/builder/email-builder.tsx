"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Columns3,
  Copy,
  Eye,
  GripVertical,
  Heading,
  Image as ImageIcon,
  LayoutPanelTop,
  ListChecks,
  Minus,
  Monitor,
  MoveVertical,
  PenLine,
  Redo2,
  Share2,
  Smartphone,
  Square,
  Table2,
  Trash2,
  Type,
  Undo2,
  Code2,
  BadgeCheck,
  Send,
  Sparkles,
  Bookmark,
  Users,
} from "lucide-react";
import { saveDesignedTemplate } from "@/actions/marketing-library";
import { audienceLabel, BLOCK_KINDS, FONTS, newBlock, newBlockId, renderBlockAlone, renderDesign, type Block, type BlockType, type BuilderBrand, type Design } from "@/lib/marketing/email-design";
import type { SavedBlock } from "@/lib/marketing/saved-blocks";
import { SaveBlocksDialog, SavedBlockList } from "@/components/marketing/builder/saved-blocks";
import { previewValues, render } from "@/lib/marketing/merge";
import { TOPICS } from "@/lib/marketing/topics";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { confirmAction } from "@/components/ui/confirm";
import { BlockInspector, ColorField } from "@/components/marketing/builder/block-inspector";
import { AiDesignDialog, TestSendDialog } from "@/components/marketing/builder/builder-dialogs";
import type { AiDesignResult } from "@/actions/email-builder-tools";

/**
 * Marketing › Templates › Email builder (owner, 1 Nov 2026: a drag-and-drop template creator, "easy to use, Elementor
 * type"). Blocks on the left, dragged — or clicked — onto the email in the middle; the chosen block's settings on the
 * right, drawn at once; the page's colours and font under "Page". Undo and redo, a phone-sized view, a preview with
 * sample values, and Save — which keeps the design and the HTML it sends (src/actions/marketing-library.ts).
 *
 * Each block on the canvas is drawn in its own frame from the same code that writes the email
 * (src/lib/marketing/email-design.ts), sandboxed so nothing in it runs, with a layer above it to choose and drag it.
 */

const ICONS: Record<BlockType, typeof Type> = {
  logo: BadgeCheck,
  heading: Heading,
  text: Type,
  image: ImageIcon,
  button: Square,
  banner: LayoutPanelTop,
  details: Table2,
  checklist: ListChecks,
  columns: Columns3,
  social: Share2,
  signature: PenLine,
  divider: Minus,
  spacer: MoveVertical,
  html: Code2,
};

const HISTORY = 60;
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

type Initial = { id: string | null; name: string; topic: string; subject: string; preheader: string; design: Design };

/**
 * The logo's own colour (owner, 1 Nov 2026: headings came out in the app's default purple beside a blue logo): the
 * most common strong colour in it — not white, black or grey — as #rrggbb; null for a logo with none.
 */
function logoColor(src: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const size = 48;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(null);
      ctx.drawImage(img, 0, 0, size, size);
      const data = ctx.getImageData(0, 0, size, size).data;
      const counts = new Map<string, { n: number; r: number; g: number; b: number }>();
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b, a] = [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        // Transparent, too light, too dark or too grey to be the brand's colour.
        if (a < 200 || max > 245 || max < 40 || max - min < 40) continue;
        const key = `${r >> 4},${g >> 4},${b >> 4}`;
        const c = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
        counts.set(key, { n: c.n + 1, r: c.r + r, g: c.g + g, b: c.b + b });
      }
      const top = [...counts.values()].sort((x, y) => y.n - x.n)[0];
      if (!top) return resolve(null);
      const hex = (v: number) => Math.round(v / top.n).toString(16).padStart(2, "0");
      resolve(`#${hex(top.r)}${hex(top.g)}${hex(top.b)}`);
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/**
 * Drawn with sample values — Rajesh, Microsoft 365, 9 Aug 2027 — as the email reads; the fields themselves are edited on
 * the right. `viewer`: who it's seen as — a customer in Pune, Maharashtra unless the preview says otherwise — for blocks
 * kept to some people.
 */
type Viewer = { customer: boolean; city: string; state: string };
function sampled(html: string, viewer?: Viewer): string {
  const values = { ...previewValues(), ...(viewer ? { isCustomer: viewer.customer ? "yes" : "", city: viewer.city, state: viewer.state } : {}) };
  const filled = render(html, values, { escape: escapeHtml });
  return filled.ok ? filled.text : html;
}

/** One block on the canvas: its own sandboxed frame, as tall as what it holds. */
function BlockFrame({ html }: { html: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(40);
  // As tall as its content, watched as it lays out — a picture arriving, a font settling — not measured once on load.
  useEffect(() => {
    const f = frame.current;
    if (!f) return;
    let watch: ResizeObserver | null = null;
    const measure = () => {
      const body = f.contentDocument?.body;
      if (body) setHeight(Math.max(8, Math.ceil(body.getBoundingClientRect().height)));
    };
    const hook = () => {
      const body = f.contentDocument?.body;
      if (!body) return;
      measure();
      watch?.disconnect();
      watch = new ResizeObserver(measure);
      watch.observe(body);
    };
    f.addEventListener("load", hook);
    hook();
    return () => {
      f.removeEventListener("load", hook);
      watch?.disconnect();
    };
  }, [html]);
  return <iframe ref={frame} title="Block" srcDoc={html} sandbox="allow-same-origin" scrolling="no" style={{ height }} className="pointer-events-none block w-full border-0" />;
}

/** `openAi`: open "Design with AI" as the builder opens (Templates › Design with AI). */
export function EmailBuilder({ brand, initial, openAi = false, saved: savedAtStart = [] }: { brand: BuilderBrand; initial: Initial; openAi?: boolean; saved?: SavedBlock[] }) {
  const router = useRouter();
  const [id, setId] = useState(initial.id);
  const [name, setName] = useState(initial.name);
  const [topic, setTopic] = useState(initial.topic);
  const [subject, setSubject] = useState(initial.subject);
  const [preheader, setPreheader] = useState(initial.preheader);
  const [design, setDesign] = useState<Design>(initial.design);
  const [past, setPast] = useState<Design[]>([]);
  const [future, setFuture] = useState<Design[]>([]);
  const [selected, setSelected] = useState<string | null>(initial.design.blocks[0]?.id ?? null);
  const [panel, setPanel] = useState<"blocks" | "page">("blocks");
  const [device, setDevice] = useState<"desktop" | "phone">("desktop");
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [aiOpen, setAiOpen] = useState(openAi);
  const [testing, setTesting] = useState(false);
  const [subjectIdeas, setSubjectIdeas] = useState<string[]>([]);
  const [aiNotes, setAiNotes] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [saving, startSave] = useTransition();
  const [dragging, setDragging] = useState<{ kind: "new"; type: BlockType } | { kind: "move"; id: string } | { kind: "saved"; saved: SavedBlock } | null>(null);
  const [saved, setSaved] = useState<SavedBlock[]>(savedAtStart);
  const [savingBlocks, setSavingBlocks] = useState(false);
  const [viewer, setViewer] = useState<Viewer>({ customer: true, city: "Pune", state: "Maharashtra" });

  /** Every change goes through here: kept for undo, the page marked as changed. */
  const commit = useCallback(
    (next: Design) => {
      setPast((p) => [...p.slice(-HISTORY + 1), design]);
      setFuture([]);
      setDesign(next);
      setDirty(true);
    },
    [design],
  );
  const undo = () => {
    const prev = past[past.length - 1];
    if (!prev) return;
    setPast(past.slice(0, -1));
    setFuture([design, ...future]);
    setDesign(prev);
    setDirty(true);
  };
  const redo = () => {
    const next = future[0];
    if (!next) return;
    setFuture(future.slice(1));
    setPast([...past, design]);
    setDesign(next);
    setDirty(true);
  };

  const blocks = design.blocks;
  const at = (blockId: string) => blocks.findIndex((b) => b.id === blockId);
  const setBlocks = (next: Block[]) => commit({ ...design, blocks: next });
  const insert = (type: BlockType, index: number) => {
    const b = newBlock(type);
    const next = [...blocks];
    next.splice(index, 0, b);
    setBlocks(next);
    setSelected(b.id);
    setPanel("blocks");
  };
  const move = (blockId: string, to: number) => {
    const from = at(blockId);
    if (from < 0) return;
    const next = [...blocks];
    const [b] = next.splice(from, 1);
    next.splice(to > from ? to - 1 : to, 0, b!);
    setBlocks(next);
  };
  const remove = (blockId: string) => {
    const i = at(blockId);
    setBlocks(blocks.filter((b) => b.id !== blockId));
    setSelected(blocks[i + 1]?.id ?? blocks[i - 1]?.id ?? null);
  };
  const duplicate = (blockId: string) => {
    const i = at(blockId);
    const copy = { ...structuredClone(blocks[i]!), id: newBlockId() } as Block;
    const next = [...blocks];
    next.splice(i + 1, 0, copy);
    setBlocks(next);
    setSelected(copy.id);
  };
  const update = (b: Block) => setBlocks(blocks.map((x) => (x.id === b.id ? b : x)));
  // A saved block dropped in: copies with ids of their own, so the same footer can go in twice.
  const insertSaved = (s: SavedBlock, index: number) => {
    const copies = s.blocks.map((b) => ({ ...structuredClone(b), id: newBlockId() }) as Block);
    const next = [...blocks];
    next.splice(index, 0, ...copies);
    setBlocks(next);
    setSelected(copies[0]?.id ?? null);
    setPanel("blocks");
  };

  // Undo, redo and delete from the keyboard — not while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName));
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !typing) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y" && !typing) {
        e.preventDefault();
        redo();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selected && !typing) {
        e.preventDefault();
        remove(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Leaving with changes not saved asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const save = () =>
    startSave(async () => {
      setNotice(null);
      const result = await saveDesignedTemplate({ id: id ?? undefined, name, topic, subject, preheader, design });
      if (!result.ok) return setNotice({ tone: "error", text: result.error });
      setDirty(false);
      setNotice({ tone: "success", text: `Saved.${result.data.warnings.length ? ` ${result.data.warnings.join(" ")}` : ""}` });
      if (!id) {
        setId(result.data.id);
        router.replace(`/marketing/templates/builder?id=${result.data.id}`);
      }
    });

  // What AI designed: the email replaced (undoable), and the words around it filled — a new design's always, a
  // changed one's only where nothing was written.
  const designed = (r: AiDesignResult, fresh: boolean) => {
    commit(r.design);
    setSelected(null);
    setSubjectIdeas(r.subjects);
    if (fresh || !subject.trim()) setSubject(r.subjects[0] ?? subject);
    if (fresh || !preheader.trim()) setPreheader(r.preheader || preheader);
    if (fresh) setTopic(r.topic);
    if (fresh && (!id || name === "New email")) setName(r.name);
    setAiNotes([...r.notes, `Used ${r.credits} Deskzo AI credit${r.credits === "1" ? "" : "s"}. Undo (Ctrl+Z) puts the email back as it was.`].join(" "));
  };

  // Dropping on the canvas: a new block from the left, or one moved.
  const drop = (index: number) => {
    const d = dragging;
    setDragging(null);
    setDropAt(null);
    if (!d) return;
    if (d.kind === "new") insert(d.type, index);
    else if (d.kind === "saved") insertSaved(d.saved, index);
    else move(d.id, index);
  };
  const dropZone = (index: number) => (
    <div
      key={`drop-${index}`}
      onDragOver={(e) => {
        if (!dragging) return;
        e.preventDefault();
        setDropAt(index);
      }}
      onDragLeave={() => setDropAt((v) => (v === index ? null : v))}
      onDrop={(e) => {
        e.preventDefault();
        drop(index);
      }}
      className={`transition-all ${dropAt === index ? "my-1 h-10 rounded-base border-2 border-dashed border-brand bg-brand/10" : "h-2"}`}
    />
  );

  const chosen = blocks.find((b) => b.id === selected) ?? null;
  const look = design.settings;
  const previewHtml = sampled(renderDesign(design, brand, name), viewer);
  const keptBlocks = blocks.some((b) => audienceLabel(b.show));

  return (
    <div className="flex h-[calc(100vh-4rem)] min-h-[560px] flex-col overflow-hidden rounded-card border border-line bg-surface">
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <Link href="/marketing/templates" className="flex items-center gap-1 text-sm text-muted hover:text-text" onClick={async (e) => {
            if (!dirty) return;
            e.preventDefault();
            if (await confirmAction({ title: "Leave without saving?", message: "Your changes to this email haven't been saved.", confirmLabel: "Leave", danger: true })) {
              setDirty(false);
              router.push("/marketing/templates");
            }
          }}>
          <ArrowLeft className="h-4 w-4" /> Templates
        </Link>
        <Input value={name} onChange={(e) => (setName(e.target.value), setDirty(true))} placeholder="Template name" aria-label="Template name" className="h-8 w-56 text-sm font-medium" />
        <div className="ml-auto flex items-center gap-1">
          <button type="button" title="Undo (Ctrl+Z)" onClick={undo} disabled={!past.length} className="flex h-8 w-8 items-center justify-center rounded-base text-muted hover:bg-surface-sunken disabled:opacity-40">
            <Undo2 className="h-4 w-4" />
          </button>
          <button type="button" title="Redo (Ctrl+Y)" onClick={redo} disabled={!future.length} className="flex h-8 w-8 items-center justify-center rounded-base text-muted hover:bg-surface-sunken disabled:opacity-40">
            <Redo2 className="h-4 w-4" />
          </button>
          <div className="mx-1 inline-flex rounded-base border border-line">
            <button type="button" title="Desktop" onClick={() => setDevice("desktop")} className={`flex h-8 w-9 items-center justify-center ${device === "desktop" ? "bg-brand text-white" : "text-muted"}`}>
              <Monitor className="h-4 w-4" />
            </button>
            <button type="button" title="Phone" onClick={() => setDevice("phone")} className={`flex h-8 w-9 items-center justify-center ${device === "phone" ? "bg-brand text-white" : "text-muted"}`}>
              <Smartphone className="h-4 w-4" />
            </button>
          </div>
          <Button type="button" variant="secondary" size="sm" onClick={() => setAiOpen(true)}>
            <Sparkles className="mr-1.5 h-4 w-4" /> Design with AI
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => setPreviewing(true)}>
            <Eye className="mr-1.5 h-4 w-4" /> Preview
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            title={!id || dirty ? "Save first — a test sends the saved email" : "Send a test to me"}
            disabled={!id || dirty}
            onClick={() => setTesting(true)}
          >
            <Send className="mr-1.5 h-4 w-4" /> Send test
          </Button>
          <Button type="button" size="sm" onClick={save} disabled={saving}>
            {saving ? "Saving…" : dirty || !id ? "Save" : "Saved"}
          </Button>
        </div>
        {notice && (
          <div className="w-full">
            <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>
          </div>
        )}
        {aiNotes && (
          <div className="flex w-full items-start justify-between gap-2 rounded-base bg-brand/5 px-3 py-2 text-xs text-text">
            <span>
              <Sparkles className="mr-1 inline h-3.5 w-3.5 text-brand" />
              {aiNotes}
            </span>
            <button type="button" onClick={() => setAiNotes(null)} className="text-muted hover:text-text">
              Dismiss
            </button>
          </div>
        )}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[15rem_minmax(0,1fr)_19rem]">
        {/* Left: blocks and page settings */}
        <aside className="flex min-h-0 flex-col border-r border-line">
          <div className="flex border-b border-line text-sm">
            {(["blocks", "page"] as const).map((p) => (
              <button key={p} type="button" onClick={() => setPanel(p)} className={`flex-1 py-2 ${panel === p ? "border-b-2 border-brand font-medium text-text" : "text-muted"}`}>
                {p === "blocks" ? "Blocks" : "Page & email"}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {panel === "blocks" ? (
              <>
                <p className="mb-2 text-[11px] text-subtle">Drag onto the email, or click to add below the one chosen.</p>
                <div className="grid grid-cols-2 gap-2">
                  {BLOCK_KINDS.map((k) => {
                    const Icon = ICONS[k.type];
                    return (
                      <button
                        key={k.type}
                        type="button"
                        draggable
                        title={k.hint}
                        onDragStart={(e) => {
                          setDragging({ kind: "new", type: k.type });
                          e.dataTransfer.effectAllowed = "copy";
                          e.dataTransfer.setData("text/plain", k.type);
                        }}
                        onDragEnd={() => (setDragging(null), setDropAt(null))}
                        onClick={() => insert(k.type, chosen ? at(chosen.id) + 1 : blocks.length)}
                        className="flex cursor-grab flex-col items-center gap-1 rounded-base border border-line px-2 py-3 text-xs text-text hover:border-brand hover:text-brand active:cursor-grabbing"
                      >
                        <Icon className="h-5 w-5" />
                        {k.label}
                      </button>
                    );
                  })}
                </div>
                <SavedBlockList
                  saved={saved}
                  onPick={(s) => insertSaved(s, chosen ? at(chosen.id) + 1 : blocks.length)}
                  onDragStart={(s) => setDragging({ kind: "saved", saved: s })}
                  onDragEnd={() => (setDragging(null), setDropAt(null))}
                  onDeleted={(gone) => setSaved((list) => list.filter((s) => s.id !== gone))}
                />
              </>
            ) : (
              <div className="space-y-3">
                <div className="space-y-1">
                  <Label className="text-xs">Subject</Label>
                  <Input value={subject} onChange={(e) => (setSubject(e.target.value), setDirty(true))} placeholder="{{firstName|Hello}}, …" className="h-8 text-sm" />
                  {subjectIdeas.length > 1 && (
                    <div className="space-y-1 pt-1">
                      <p className="text-[11px] text-subtle">AI&apos;s other ideas — click to use:</p>
                      {subjectIdeas
                        .filter((s) => s !== subject)
                        .map((s) => (
                          <button key={s} type="button" onClick={() => (setSubject(s), setDirty(true))} className="block w-full rounded-base border border-line px-2 py-1 text-left text-xs text-text hover:border-brand">
                            {s}
                          </button>
                        ))}
                    </div>
                  )}
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Preview line</Label>
                  <Input value={preheader} onChange={(e) => (setPreheader(e.target.value), setDirty(true))} placeholder="The grey line after the subject" className="h-8 text-sm" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Topic</Label>
                  <Select value={topic} onChange={(e) => (setTopic(e.target.value), setDirty(true))} className="h-8 text-sm">
                    {TOPICS.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.label}
                      </option>
                    ))}
                  </Select>
                  <p className="text-[11px] text-subtle">Only contacts who agreed to hear about it receive it.</p>
                </div>
                <hr className="border-line" />
                <div className="space-y-1">
                  <Label className="text-xs">Font</Label>
                  <Select value={look.font} onChange={(e) => commit({ ...design, settings: { ...look, font: e.target.value as keyof typeof FONTS } })} className="h-8 text-sm">
                    <option value="arial">Arial</option>
                    <option value="verdana">Verdana</option>
                    <option value="trebuchet">Trebuchet</option>
                    <option value="georgia">Georgia</option>
                  </Select>
                </div>
                <ColorField label="Brand colour" value={look.brandColor} onChange={(v) => commit({ ...design, settings: { ...look, brandColor: v } })} auto="From Settings › Branding" fallback={brand.color} />
                {brand.logo && (
                  <button
                    type="button"
                    onClick={async () => {
                      const found = await logoColor(brand.logo!);
                      if (found) commit({ ...design, settings: { ...look, brandColor: found } });
                    }}
                    className="-mt-1 text-xs text-brand hover:underline"
                  >
                    Use my logo&apos;s colour
                  </button>
                )}
                <ColorField label="Heading colour" value={look.headingColor} onChange={(v) => commit({ ...design, settings: { ...look, headingColor: v } })} auto="Brand colour" fallback={look.brandColor ?? brand.color} />
                <ColorField label="Link colour" value={look.linkColor} onChange={(v) => commit({ ...design, settings: { ...look, linkColor: v } })} auto="Brand colour" fallback={look.brandColor ?? brand.color} />
                <ColorField label="Text colour" value={look.textColor} onChange={(v) => commit({ ...design, settings: { ...look, textColor: v } })} auto="Dark grey" fallback="#1f2937" />
                <ColorField label="Email background" value={look.contentBackground} onChange={(v) => commit({ ...design, settings: { ...look, contentBackground: v } })} auto="White" fallback="#ffffff" />
                <ColorField label="Page background" value={look.background} onChange={(v) => commit({ ...design, settings: { ...look, background: v } })} auto="Light grey" fallback="#f3f4f6" />
                <div className="space-y-1">
                  <Label className="text-xs">Email width — {look.width ?? 600}px</Label>
                  <input type="range" min={480} max={720} step={20} value={look.width ?? 600} onChange={(e) => commit({ ...design, settings: { ...look, width: Number(e.target.value) } })} className="w-full" />
                  <p className="text-[11px] text-subtle">600 suits most inboxes; phones always fit it to the screen.</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Rounded corners — {look.radius ?? 10}px</Label>
                  <input type="range" min={0} max={24} step={2} value={look.radius ?? 10} onChange={(e) => commit({ ...design, settings: { ...look, radius: Number(e.target.value) } })} className="w-full" />
                </div>
              </div>
            )}
          </div>
        </aside>

        {/* Middle: the email */}
        <main className="min-h-0 overflow-y-auto p-6" style={{ background: look.background ?? "#f3f4f6" }} onClick={() => setSelected(null)}>
          <div className="mx-auto overflow-hidden border border-line shadow-sm transition-all" style={{ maxWidth: device === "phone" ? 375 : (look.width ?? 600), borderRadius: look.radius ?? 10, background: look.contentBackground ?? "#ffffff" }}>
            {blocks.length === 0 && (
              <div
                onDragOver={(e) => (e.preventDefault(), setDropAt(0))}
                onDrop={(e) => (e.preventDefault(), drop(0))}
                className="m-4 rounded-base border-2 border-dashed border-line-strong p-10 text-center text-sm text-muted"
              >
                Drag a block here to start.
              </div>
            )}
            {blocks.map((b, i) => {
              const isChosen = b.id === selected;
              return (
                <div key={b.id}>
                  {dropZone(i)}
                  <div
                    draggable
                    onDragStart={(e) => {
                      setDragging({ kind: "move", id: b.id });
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", b.id);
                    }}
                    onDragEnd={() => (setDragging(null), setDropAt(null))}
                    onClick={(e) => (e.stopPropagation(), setSelected(b.id), setPanel("blocks"))}
                    className={`group relative cursor-pointer outline-offset-0 ${isChosen ? "outline outline-2 outline-brand" : "hover:outline hover:outline-1 hover:outline-brand/50"}`}
                  >
                    <BlockFrame html={sampled(renderBlockAlone(b, design, brand))} />
                    {audienceLabel(b.show) && (
                      <span className="absolute -top-2.5 left-2 z-10 inline-flex items-center gap-1 rounded-full border border-brand/40 bg-surface/95 px-2 py-0.5 text-[10px] font-medium text-brand shadow-sm" title="Only these people see this block">
                        <Users className="h-3 w-3" />
                        {audienceLabel(b.show)}
                      </span>
                    )}
                    <div className={`absolute -top-3 right-2 z-10 items-center gap-0.5 rounded-base border border-line bg-surface px-1 py-0.5 shadow-sm ${isChosen ? "flex" : "hidden group-hover:flex"}`}>
                      <span className="flex cursor-grab items-center px-1 text-[11px] text-muted" title="Drag to move">
                        <GripVertical className="h-3.5 w-3.5" />
                        {BLOCK_KINDS.find((k) => k.type === b.type)?.label}
                      </span>
                      <button type="button" title="Move up" disabled={i === 0} onClick={(e) => (e.stopPropagation(), move(b.id, i - 1))} className="p-1 text-muted hover:text-text disabled:opacity-30">
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" title="Move down" disabled={i === blocks.length - 1} onClick={(e) => (e.stopPropagation(), move(b.id, i + 2))} className="p-1 text-muted hover:text-text disabled:opacity-30">
                        <ArrowDown className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" title="Save for any email" onClick={(e) => (e.stopPropagation(), setSelected(b.id), setSavingBlocks(true))} className="p-1 text-muted hover:text-text">
                        <Bookmark className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" title="Duplicate" onClick={(e) => (e.stopPropagation(), duplicate(b.id))} className="p-1 text-muted hover:text-text">
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" title="Delete" onClick={(e) => (e.stopPropagation(), remove(b.id))} className="p-1 text-muted hover:text-danger">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
            {blocks.length > 0 && dropZone(blocks.length)}
          </div>
          <p className="mx-auto mt-3 text-center text-[11px] text-subtle" style={{ maxWidth: 600 }}>
            The unsubscribe link and your address are added at the bottom when it&apos;s sent.
          </p>
        </main>

        {/* Right: the chosen block */}
        <aside className="min-h-0 overflow-y-auto border-l border-line p-3">
          {chosen ? (
            <>
              <div className="mb-3 flex items-center justify-between">
                <p className="text-sm font-medium text-text">{BLOCK_KINDS.find((k) => k.type === chosen.type)?.label}</p>
                <button type="button" onClick={() => remove(chosen.id)} className="flex items-center gap-1 text-xs text-muted hover:text-danger">
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </button>
              </div>
              <BlockInspector key={chosen.id} block={chosen} onChange={update} accent={look.brandColor ?? brand.color} />
            </>
          ) : (
            <div className="space-y-2 text-sm text-muted">
              <p className="font-medium text-text">Nothing chosen</p>
              <p>Click a block in the email to change it, or drag a new one in from the left.</p>
              <p className="text-xs">Subject, preview line, topic, colours and font are under &ldquo;Page &amp; email&rdquo;.</p>
            </div>
          )}
        </aside>
      </div>

      <AiDesignDialog open={aiOpen} onClose={() => setAiOpen(false)} current={design} onDesigned={designed} />
      <TestSendDialog open={testing} onClose={() => setTesting(false)} templateId={id} />
      <SaveBlocksDialog
        open={savingBlocks}
        onClose={() => setSavingBlocks(false)}
        blocks={blocks}
        chosenId={selected}
        saved={saved}
        onSaved={(s) => {
          setSaved((list) => [s, ...list.filter((x) => x.id !== s.id)]);
          setNotice({ tone: "success", text: `Saved “${s.name}” — it's under Saved blocks on the left, for any email.` });
        }}
      />

      <Dialog open={previewing} onClose={() => setPreviewing(false)} title="Preview" large>
        <div className="space-y-2">
          <p className="text-xs text-muted">With sample values — each customer sees their own name, product and dates.</p>
          {keptBlocks && (
            <div className="flex flex-wrap items-center gap-2 rounded-base bg-surface-sunken px-3 py-2 text-xs text-text">
              <Users className="h-3.5 w-3.5 text-brand" />
              <span>Some blocks are only for some people. See it as</span>
              <Select value={viewer.customer ? "customer" : "prospect"} onChange={(e) => setViewer({ ...viewer, customer: e.target.value === "customer" })} className="h-7 w-32 text-xs">
                <option value="customer">a customer</option>
                <option value="prospect">a prospect</option>
              </Select>
              <span>in</span>
              <Input value={viewer.city} onChange={(e) => setViewer({ ...viewer, city: e.target.value })} placeholder="City" aria-label="City" className="h-7 w-28 text-xs" />
              <Input value={viewer.state} onChange={(e) => setViewer({ ...viewer, state: e.target.value })} placeholder="State" aria-label="State" className="h-7 w-32 text-xs" />
            </div>
          )}
          <iframe title="Email preview" srcDoc={previewHtml} sandbox="" className="h-[70vh] w-full rounded-base border border-line bg-white" />
        </div>
      </Dialog>
    </div>
  );
}
