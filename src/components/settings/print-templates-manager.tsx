"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { TradeDocumentType } from "@prisma/client";
import { Copy, Pencil, Plus, Star, Trash2 } from "lucide-react";
import {
  createPrintTemplate,
  deletePrintTemplate,
  duplicatePrintTemplate,
  setDefaultPrintTemplate,
  type PrintTemplateRow,
} from "@/actions/print-template";
import { BUILT_IN_TEMPLATE_NAME, PRINT_LAYOUTS, printLayoutInfo, type PrintLayout } from "@/lib/documents/print-template";
import { tradeDocumentLabels } from "@/lib/trade-documents";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { ActionNotice } from "@/components/ui/action-notice";
import { confirmAction } from "@/components/ui/confirm";

const TYPES = Object.keys(tradeDocumentLabels) as TradeDocumentType[];
const editorHref = (id: string) => `/settings/document-templates/${id}`;
/** "tax invoices", "vendor bills" — how a type is named in a sentence. */
const plural = (docType: TradeDocumentType) => `${tradeDocumentLabels[docType].toLowerCase()}s`;

type Notice = { tone: "success" | "error"; text: string } | null;

/**
 * Settings › Document templates: a card per kind of document with its templates, the built-in Standard always among
 * them — the default wherever no template is, and what a type falls back to when its default is deleted.
 */
export function PrintTemplatesManager({ templates }: { templates: PrintTemplateRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<Notice>(null);
  const [creating, setCreating] = useState<TradeDocumentType | null>(null);

  function run<T>(action: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, done?: (data: T) => void) {
    setNotice(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setNotice({ tone: "error", text: result.error });
        return;
      }
      done?.(result.data);
      router.refresh();
    });
  }

  /** An editable copy of the built-in, opened in the editor — the default straight away where the built-in is (it prints the same page until it's changed). */
  function customise(docType: TradeDocumentType, builtInIsDefault: boolean) {
    run(() => createPrintTemplate({ name: "Standard", docType, layout: "standard", makeDefault: builtInIsDefault }), ({ id }) => router.push(editorHref(id)));
  }

  async function remove(t: PrintTemplateRow) {
    const yes = await confirmAction({
      title: `Delete “${t.name}”?`,
      message: t.isDefault
        ? `It's the default for ${plural(t.docType)}: they print with the built-in Standard template until you make another one the default. This can't be undone.`
        : "Documents printed with it print with the default template from now on. This can't be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!yes) return;
    run(
      () => deletePrintTemplate(t.id),
      ({ wasDefault }) =>
        setNotice({
          tone: "success",
          text: wasDefault ? `Deleted. ${tradeDocumentLabels[t.docType]}s print with the built-in Standard template until you choose another default.` : `Deleted “${t.name}”.`,
        }),
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">
          Whatever GST requires on a tax invoice, credit or debit note or delivery challan stays on it — our GSTIN, HSN codes, the tax rates, an
          e-invoice&apos;s QR code — so those switches are locked on there.
        </p>
        <Button onClick={() => setCreating("INVOICE")} disabled={pending}>
          <Plus className="h-4 w-4" /> New template
        </Button>
      </div>

      {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {TYPES.map((docType) => {
          const own = templates.filter((t) => t.docType === docType);
          const builtInIsDefault = !own.some((t) => t.isDefault);
          return (
            <Card key={docType}>
              <CardHeader className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-text">{tradeDocumentLabels[docType]}</h2>
                <Button variant="ghost" size="sm" onClick={() => setCreating(docType)} disabled={pending} aria-label={`New ${tradeDocumentLabels[docType].toLowerCase()} template`}>
                  <Plus className="h-3.5 w-3.5" /> New
                </Button>
              </CardHeader>
              <CardContent className="p-0">
                <ul className="divide-y divide-line">
                  <TemplateRow
                    name={BUILT_IN_TEMPLATE_NAME}
                    layout="standard"
                    isDefault={builtInIsDefault}
                    note={builtInIsDefault ? null : "Used again if the default is deleted."}
                  >
                    <Button variant="ghost" size="sm" disabled={pending} onClick={() => customise(docType, builtInIsDefault)}>
                      <Pencil className="h-3.5 w-3.5" /> Customise
                    </Button>
                    {!builtInIsDefault && (
                      <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => setDefaultPrintTemplate({ docType, id: null }))}>
                        <Star className="h-3.5 w-3.5" /> Set as default
                      </Button>
                    )}
                  </TemplateRow>
                  {own.map((t) => (
                    <TemplateRow key={t.id} name={t.name} href={editorHref(t.id)} layout={t.layout} isDefault={t.isDefault}>
                      <Link
                        href={editorHref(t.id)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-base px-3 text-[13px] font-medium text-muted hover:bg-surface-sunken hover:text-text"
                      >
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </Link>
                      <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => duplicatePrintTemplate(t.id), (copy) => setNotice({ tone: "success", text: `Copied as “${copy.name}”.` }))}>
                        <Copy className="h-3.5 w-3.5" /> Duplicate
                      </Button>
                      {!t.isDefault && (
                        <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => setDefaultPrintTemplate({ docType, id: t.id }))}>
                          <Star className="h-3.5 w-3.5" /> Set as default
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" disabled={pending} onClick={() => remove(t)} className="hover:text-danger">
                        <Trash2 className="h-3.5 w-3.5" /> Delete
                      </Button>
                    </TemplateRow>
                  ))}
                </ul>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {creating && <NewTemplateDialog key={creating} initialType={creating} templates={templates} onClose={() => setCreating(null)} />}
    </div>
  );
}

function TemplateRow({
  name,
  href,
  layout,
  isDefault,
  note,
  children,
}: {
  name: string;
  href?: string;
  layout: PrintLayout;
  isDefault: boolean;
  note?: string | null;
  children: React.ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-5 py-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {href ? (
            <Link href={href} className="truncate text-sm font-medium text-text hover:underline">
              {name}
            </Link>
          ) : (
            <span className="truncate text-sm font-medium text-text">{name}</span>
          )}
          {isDefault && <Badge tone="brand">Default</Badge>}
        </div>
        <p className="mt-0.5 text-xs text-muted">
          {printLayoutInfo[layout].label} layout{note ? ` · ${note}` : ""}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1">{children}</div>
    </li>
  );
}

/** Name, kind of document, and what it starts from — a built-in layout or a copy of a template already made. */
function NewTemplateDialog({ initialType, templates, onClose }: { initialType: TradeDocumentType; templates: PrintTemplateRow[]; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [docType, setDocType] = useState<TradeDocumentType>(initialType);
  const [start, setStart] = useState("layout:standard");
  const [makeDefault, setMakeDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function create() {
    setError(null);
    const [kind, value] = start.split(":") as ["layout" | "copy", string];
    startTransition(async () => {
      const result = await createPrintTemplate({
        name,
        docType,
        ...(kind === "copy" ? { copyOf: value } : { layout: value as PrintLayout }),
        makeDefault,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(editorHref(result.data.id));
    });
  }

  return (
    <Dialog open onClose={onClose} title="New template">
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="tpl-name">Name</Label>
          <Input id="tpl-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Export invoice" autoFocus />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tpl-type">Document type</Label>
          <Select id="tpl-type" value={docType} onChange={(e) => setDocType(e.target.value as TradeDocumentType)}>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {tradeDocumentLabels[t]}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tpl-start">Start from</Label>
          <Select id="tpl-start" value={start} onChange={(e) => setStart(e.target.value)}>
            <optgroup label="A built-in layout">
              {PRINT_LAYOUTS.map((l) => (
                <option key={l} value={`layout:${l}`}>
                  {printLayoutInfo[l].label}
                </option>
              ))}
            </optgroup>
            {templates.length > 0 && (
              <optgroup label="A copy of">
                {templates.map((t) => (
                  <option key={t.id} value={`copy:${t.id}`}>
                    {tradeDocumentLabels[t.docType]} — {t.name}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
          <p className="text-xs text-subtle">
            {start.startsWith("layout:") ? printLayoutInfo[start.slice(7) as PrintLayout].description : "Everything that template says — its layout, colour, wording and switches."}
          </p>
        </div>
        <div className="flex items-start justify-between gap-4 text-sm">
          <div>
            <p id="tpl-default" className="font-medium text-text">
              Make it the default for {plural(docType)}
            </p>
            <p className="mt-0.5 text-xs text-muted">The default is what they print, preview and email with.</p>
          </div>
          <Switch checked={makeDefault} onChange={setMakeDefault} aria-labelledby="tpl-default" className="mt-0.5" />
        </div>
        {error && <ActionNotice tone="error">{error}</ActionNotice>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={create} disabled={pending || !name.trim()}>
            {pending ? "Creating…" : "Create and edit"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
