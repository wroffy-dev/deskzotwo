"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LayoutTemplate } from "lucide-react";
import { addLibraryTemplate } from "@/actions/marketing-library";
import { LIBRARY_CATEGORIES, TEMPLATE_LIBRARY, type LibraryBrand, type LibraryCategory } from "@/lib/marketing/template-library";
import { previewValues, render } from "@/lib/marketing/merge";

// Not src/lib/marketing/html.ts's: that brings the HTML cleaner into the browser for one small function.
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { ActionNotice } from "@/components/ui/action-notice";

/**
 * Marketing › Templates › Template library (owner, 1 Nov 2026): the ready-made templates
 * (src/lib/marketing/template-library.ts), previewed in this workspace's own look with sample values, and saved as
 * one of its templates with "Use this template" (src/actions/marketing-library.ts).
 */
export function TemplateLibrary({ brand }: { brand: LibraryBrand }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<LibraryCategory | "All">("All");
  const [chosen, setChosen] = useState(TEMPLATE_LIBRARY[0]!.key);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();

  const shown = TEMPLATE_LIBRARY.filter((t) => category === "All" || t.category === category);
  const template = TEMPLATE_LIBRARY.find((t) => t.key === chosen) ?? shown[0]!;
  // The sample values a template is previewed with, as the editor's preview shows them.
  const html = template.html(brand);
  const filled = render(html, previewValues(), { escape: escapeHtml });
  const preview = filled.ok ? filled.text : html;
  const filledSubject = render(template.subject, previewValues());
  const subject = filledSubject.ok ? filledSubject.text : template.subject;

  const use = () =>
    start(async () => {
      setNotice(null);
      const result = await addLibraryTemplate(template.key);
      if (!result.ok) return setNotice({ tone: "error", text: result.error });
      setNotice({
        tone: "success",
        text: `"${result.data.name}" is saved to your templates — open it with "Edit in builder" to change the words in [brackets] before sending.${result.data.warnings.length ? ` ${result.data.warnings.join(" ")}` : ""}`,
      });
      router.refresh();
    });

  return (
    <>
      <Button type="button" variant="secondary" onClick={() => (setNotice(null), setOpen(true))}>
        <LayoutTemplate className="mr-1.5 h-4 w-4" aria-hidden />
        Template library
      </Button>
      <Dialog open={open} onClose={() => !pending && setOpen(false)} title="Template library" large>
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Ready-made emails in your own look — your logo, colour and contact details. Use one and it&apos;s saved to your templates, to edit and send like any
            other.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {(["All", ...LIBRARY_CATEGORIES] as const).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                className={`rounded-full border px-3 py-1 text-xs ${category === c ? "border-brand bg-brand text-white" : "border-line text-muted hover:text-text"}`}
              >
                {c}
              </button>
            ))}
          </div>
          <div className="grid gap-3 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
            <ul className="max-h-[60vh] space-y-1.5 overflow-y-auto">
              {shown.map((t) => (
                <li key={t.key}>
                  <button
                    type="button"
                    onClick={() => (setChosen(t.key), setNotice(null))}
                    className={`block w-full rounded-base border px-3 py-2 text-left ${t.key === template.key ? "border-brand bg-brand/5" : "border-line hover:bg-surface-sunken"}`}
                  >
                    <span className="block text-sm font-medium text-text">{t.name}</span>
                    <span className="mt-0.5 block text-xs text-muted">{t.description}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="default">{template.category}</Badge>
                <span className="min-w-0 truncate text-xs text-muted">Subject: {subject}</span>
              </div>
              <iframe title={`Preview of ${template.name}`} srcDoc={preview} sandbox="" className="h-[52vh] w-full rounded-base border border-line bg-white" />
              <p className="text-xs text-subtle">Shown with sample values. Words in [brackets] are yours to fill in; the unsubscribe link and your address are added when it&apos;s sent.</p>
              {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
                  Close
                </Button>
                <Button type="button" variant="secondary" onClick={use} disabled={pending}>
                  {pending ? "Saving…" : "Save as is"}
                </Button>
                <Link href={`/marketing/templates/builder?start=${template.key}`} className="inline-flex h-9 items-center rounded-base bg-brand px-3.5 text-sm font-medium text-brand-contrast shadow-sm hover:brightness-110">
                  Customise in builder
                </Link>
              </div>
            </div>
          </div>
        </div>
      </Dialog>
    </>
  );
}
