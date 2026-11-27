"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Building2, CalendarDays, Columns3, FilePlus2, Search, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { createOwnRowList } from "@/actions/smart-list-rows";
import { deleteListTemplate } from "@/actions/smart-list-team";
import { toast } from "@/components/ui/toast";
import { confirmAction } from "@/components/ui/confirm";
import { KIND_LABELS } from "@/lib/smart-lists/values";
import type { ListTemplate, TemplateGroup } from "@/lib/smart-lists/templates";

/**
 * Starting a Smart List (owner, 20 Nov 2026 — "add more smart list templates use cases across industry usage as per the
 * industry template admin choose"): companies from the CRM, narrowed by filters as before; a blank list with rows of its
 * own; or a template — the ones for the workspace's own industry first (the industry template its admin chose), then
 * every other by what it's for. A template gives the columns, choices and views; the rows are the team's to add.
 */
export function NewListChooser({
  industry,
  suggested,
  groups,
  industryNames,
  ready,
  mine = [],
}: {
  /** The company's own templates, made from its lists (Smart Lists phase 3). */
  mine?: (ListTemplate & { canDelete: boolean; by: string | null })[];
  industry: { key: string; name: string } | null;
  suggested: ListTemplate[];
  groups: { key: TemplateGroup; label: string; templates: ListTemplate[] }[];
  industryNames: Record<string, string>;
  /** Whether this workspace has the tables for lists with rows of their own yet. */
  ready: boolean;
}) {
  const [q, setQ] = useState("");
  const [making, setMaking] = useState<{ template: ListTemplate | null } | null>(null);
  const t = q.trim().toLowerCase();
  const matches = (x: ListTemplate) =>
    !t || x.name.toLowerCase().includes(t) || x.description.toLowerCase().includes(t) || x.columns.some((c) => c.name.toLowerCase().includes(t)) || x.industries.some((k) => (industryNames[k] ?? "").toLowerCase().includes(t));
  const router = useRouter();
  const sections = [
    { key: "mine", label: "Your company's templates", note: "Made from your own lists.", templates: mine.filter(matches) },
    { key: "suggested", label: industry ? `For ${industry.name.toLowerCase()}` : "Useful to any company", note: industry ? "Your workspace's industry, as your admin set it." : undefined, templates: suggested.filter(matches) },
    ...groups.map((g) => ({ key: g.key, label: g.label, note: undefined, templates: g.templates.filter(matches) })),
  ].filter((s) => s.templates.length > 0);

  return (
    <div className="space-y-8">
      <div className="grid gap-3 sm:grid-cols-2">
        <Link href="/smart-lists/new?from=companies" className="group flex items-start gap-3 rounded-card border border-line bg-surface p-4 transition-colors hover:border-line-strong">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-base bg-info-bg text-info" aria-hidden="true">
            <Building2 className="h-5 w-5" />
          </span>
          <span>
            <span className="block font-semibold text-text group-hover:text-brand">Companies from your CRM</span>
            <span className="mt-0.5 block text-sm text-muted">A territory, a renewal window, accounts nobody has called in 90 days — narrowed by filters, current as the data moves. Call it, mail it, share it with partners.</span>
          </span>
        </Link>
        <button
          type="button"
          disabled={!ready}
          onClick={() => setMaking({ template: null })}
          className="group flex items-start gap-3 rounded-card border border-line bg-surface p-4 text-left transition-colors hover:border-line-strong disabled:opacity-60"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-base bg-brand-subtle text-brand" aria-hidden="true">
            <FilePlus2 className="h-5 w-5" />
          </span>
          <span>
            <span className="block font-semibold text-text group-hover:text-brand">A blank list of its own rows</span>
            <span className="mt-0.5 block text-sm text-muted">Anything your team keeps in a spreadsheet — type rows in or import a CSV or Excel file, add the columns you need.</span>
          </span>
        </button>
      </div>

      {!ready ? (
        <p className="rounded-card border border-line bg-surface px-4 py-6 text-sm text-muted">Templates and lists of their own rows arrive with this workspace&apos;s next update. Try again in a few minutes.</p>
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-base font-semibold text-text">
                <Sparkles className="h-4 w-4 text-brand" aria-hidden="true" />
                Start from a template
              </h2>
              <p className="mt-0.5 text-sm text-muted">Columns, choices and views ready; the rows are yours. Everything can be changed after.</p>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" aria-hidden="true" />
              <Input type="search" aria-label="Search templates" placeholder="Search templates…" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 w-56 pl-8" />
            </div>
          </div>
          {sections.length === 0 && <p className="rounded-card border border-dashed border-line px-4 py-10 text-center text-sm text-muted">No template matches that. Start with a blank list instead.</p>}
          {sections.map((s) => (
            <section key={s.key} aria-labelledby={`tpl-${s.key}`} className="space-y-3">
              <div>
                <h3 id={`tpl-${s.key}`} className="text-sm font-semibold text-text">
                  {s.label}
                </h3>
                {s.note && <p className="text-xs text-subtle">{s.note}</p>}
              </div>
              <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {s.templates.map((x) => (
                  <li key={x.key} className="relative">
                    {s.key === "mine" && (x as (typeof mine)[number]).canDelete && (
                      <button
                        type="button"
                        aria-label={`Delete the template ${x.name}`}
                        className="absolute right-2 top-2 z-[1] rounded p-1 text-xs text-subtle hover:text-danger"
                        onClick={async () => {
                          if (!(await confirmAction({ title: `Delete the template "${x.name}"?`, message: "Lists made from it stay as they are.", confirmLabel: "Delete template", danger: true }))) return;
                          const r = await deleteListTemplate(x.key);
                          if (!r.ok) return void toast.error(r.error);
                          router.refresh();
                        }}
                      >
                        ✕
                      </button>
                    )}
                    <TemplateCard template={x} industryNames={industryNames} highlight={industry?.key ?? null} onPick={() => setMaking({ template: x })} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {making && <MakeListDialog template={making.template} onClose={() => setMaking(null)} />}
    </div>
  );
}

function TemplateCard({ template: x, industryNames, highlight, onPick }: { template: ListTemplate; industryNames: Record<string, string>; highlight: string | null; onPick: () => void }) {
  const tags = [...x.industries].sort((a, b) => (a === highlight ? -1 : b === highlight ? 1 : 0)).slice(0, 2);
  return (
    <button type="button" onClick={onPick} className="group flex h-full w-full flex-col gap-2 rounded-card border border-line bg-surface p-4 text-left transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-[0_14px_30px_-20px_rgb(15_23_42/0.35)]">
      <span className="font-semibold text-text group-hover:text-brand">{x.name}</span>
      <span className="line-clamp-2 text-sm text-muted">{x.description}</span>
      <span className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-subtle">
        <span>{x.columns.length + 1} columns</span>
        {x.views.some((v) => v.kind === "BOARD") && (
          <span className="inline-flex items-center gap-1">
            <Columns3 className="h-3.5 w-3.5" aria-hidden="true" />
            Board
          </span>
        )}
        {x.views.some((v) => v.kind === "CALENDAR") && (
          <span className="inline-flex items-center gap-1">
            <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
            Calendar
          </span>
        )}
        {tags.map((k) => (
          <span key={k} className={cn("rounded px-1.5 py-0.5", k === highlight ? "bg-brand-subtle text-brand" : "bg-surface-sunken text-muted")}>
            {industryNames[k] ?? k}
          </span>
        ))}
        {x.everyone && tags.length === 0 && <span className="rounded bg-surface-sunken px-1.5 py-0.5 text-muted">Any company</span>}
      </span>
    </button>
  );
}

function MakeListDialog({ template, onClose }: { template: ListTemplate | null; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(template?.name ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [shared, setShared] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const make = () =>
    start(async () => {
      setError(null);
      const r = await createOwnRowList({ name, description, shared, template: template?.key ?? null });
      if (!r.ok) return setError(r.error);
      router.push(`/smart-lists/${r.data.id}`);
    });
  return (
    <Dialog open onClose={onClose} title={template ? template.name : "A blank list"}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          make();
        }}
      >
        {template && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted">Its columns</p>
            <div className="flex flex-wrap gap-1.5">
              <span className="rounded bg-brand-subtle px-1.5 py-0.5 text-xs font-medium text-brand">{template.titleName}</span>
              {template.columns.map((c) => (
                <span key={c.name} className="rounded bg-surface-sunken px-1.5 py-0.5 text-xs text-muted" title={KIND_LABELS[c.kind]}>
                  {c.name}
                </span>
              ))}
            </div>
            {template.views.length > 0 && <p className="text-xs text-subtle">Views: Table, {template.views.map((v) => v.name).join(", ")}</p>}
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="new-list-name">
            List name <span className="text-danger">*</span>
          </Label>
          <Input id="new-list-name" autoFocus value={name} maxLength={120} placeholder="Backlinks — Q4" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-list-what">What it&apos;s for</Label>
          <Textarea id="new-list-what" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Who keeps it, and what for" />
        </div>
        <label className="flex items-center gap-2 text-sm text-text">
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
          Everyone can see and fill in this list
          <span className="text-xs text-subtle">(only you can change its columns)</span>
        </label>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || !name.trim()}>
            {pending ? "Making it…" : "Create list"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
