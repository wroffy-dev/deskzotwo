"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, AtSign, ChevronRight, Eye, EyeOff, Gauge, History, ListChecks, Lock, MapPin, Pencil, Phone, Shield, TriangleAlert, Type, Undo2, User, type LucideIcon } from "lucide-react";
import {
  FIELD_ENTITY_WORDS,
  MASK_FORMAT_LABELS,
  presentValue,
  visibility,
  type FieldContext,
  type FieldEntity,
  type FieldKind,
} from "@/lib/authz/field-policy";
import { acPath } from "@/lib/access-control/nav";
import { cn } from "@/lib/utils";
import { Ago } from "@/components/ui/ago";
import { InitialsAvatar, Meter, Panel, Pill, type PillTone } from "@/components/access-control/ui";
import { exportWords, KIND_LABEL, limitWords, SAMPLE_COUNT, sampleValue, standing, type FieldChange, type FieldSubject, type LimitSummary, type RowModel } from "@/components/access-control/fields/model";

const KIND_ICON: Record<FieldKind, LucideIcon> = { text: Type, email: AtSign, phone: Phone, address: MapPin, choice: ListChecks };

export type PreviewTab = "preview" | "summary" | "field";
export type StagedItem = { entity: FieldEntity; key: string; label: string; from: string; to: string; exceeds: boolean };

const heading = "mb-1.5 text-[11px] font-bold uppercase tracking-[0.04em] text-subtle";

/**
 * The right-hand panel: what the subject would see with the staged answers (on a record, in a list, in an
 * export), a summary of the record type, and one field's details.
 *
 * The preview is drawn on made-up sample records with the server's own `presentValue`, so a mask here is
 * the mask the app shows. "Show" in the preview reveals the sample only: nothing is logged or counted.
 */
export function PreviewPanel({
  entity,
  subject,
  rows,
  selected,
  tab,
  onTab,
  onSelect,
  maskingOn,
  limit,
  history,
  staged,
  onUndo,
  className,
}: {
  entity: FieldEntity;
  subject: FieldSubject;
  /** Every field of the record type, staged answers applied. */
  rows: RowModel[];
  selected: string | null;
  tab: PreviewTab;
  onTab: (tab: PreviewTab) => void;
  onSelect: (key: string) => void;
  maskingOn: boolean;
  limit: LimitSummary;
  history: FieldChange[];
  /** Staged changes across all three record types. */
  staged: StagedItem[];
  onUndo: (entity: FieldEntity, key: string) => void;
  className?: string;
}) {
  const tabs: [PreviewTab, string][] = [
    ["preview", "Preview"],
    ["summary", "Summary"],
    ["field", "Field"],
  ];
  return (
    <Panel className={className}>
      <div role="tablist" className="flex border-b border-line bg-surface-sunken/60">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => onTab(key)}
            className={cn("-mb-px h-[38px] flex-1 border-b-2 text-[12.5px] font-semibold transition-colors", tab === key ? "border-brand text-brand" : "border-transparent text-muted hover:text-text")}
          >
            {label}
            {key === "summary" && staged.length > 0 && <span className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold text-brand-contrast">{staged.length}</span>}
          </button>
        ))}
      </div>
      {tab === "preview" && <PreviewTabBody entity={entity} subject={subject} rows={rows} selected={selected} maskingOn={maskingOn} />}
      {tab === "summary" && <SummaryTabBody entity={entity} subject={subject} rows={rows} limit={limit} staged={staged} onUndo={onUndo} onSelect={onSelect} />}
      {tab === "field" && <FieldTabBody entity={entity} subject={subject} model={rows.find((m) => m.row.key === selected) ?? null} history={history} limit={limit} />}
    </Panel>
  );
}

// ─── Preview ──────────────────────────────────────────────────────────────────────────────────────

const CONTEXTS: [FieldContext, string][] = [
  ["detail", "On record"],
  ["list", "In list"],
  ["export", "Export"],
];

function PreviewTabBody({ entity, subject, rows, selected, maskingOn }: { entity: FieldEntity; subject: FieldSubject; rows: RowModel[]; selected: string | null; maskingOn: boolean }) {
  const words = FIELD_ENTITY_WORDS[entity];
  const [context, setContext] = useState<FieldContext>("detail");
  const [record, setRecord] = useState(0);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const SubjectIcon = subject.type === "role" ? Shield : User;
  const restricted = rows.filter((m) => !m.policy.view);
  const anyRevealed = context === "detail" && rows.some((m) => revealed[`${entity}:${record}:${m.row.key}`] && m.policy.unmask && visibility(m.policy, "detail") === "masked");

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-line/70 px-3.5 py-2.5">
        <span className="text-xs text-muted">Seen by</span>
        <span className="inline-flex h-6 max-w-[150px] items-center gap-[5px] rounded-full bg-surface-sunken px-2 text-xs font-semibold">
          <SubjectIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">{subject.name}</span>
        </span>
        <select
          aria-label="Sample record"
          value={record}
          onChange={(e) => setRecord(Number(e.target.value))}
          className="ml-auto h-[26px] max-w-[150px] rounded-md border border-line-strong bg-surface px-1.5 text-xs outline-none focus:border-brand"
        >
          {Array.from({ length: SAMPLE_COUNT }, (_, i) => (
            <option key={i} value={i}>
              Sample {words.one} {i + 1}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-2 border-b border-line/70 px-3.5 py-2">
        <div role="group" aria-label="Where the values are shown" className="inline-flex overflow-hidden rounded-md border border-line-strong">
          {CONTEXTS.map(([key, label], i) => (
            <button
              key={key}
              type="button"
              aria-pressed={context === key}
              onClick={() => setContext(key)}
              className={cn("h-[26px] px-2.5 text-xs font-semibold transition-colors", i > 0 && "border-l border-line-strong", context === key ? "bg-brand-subtle text-brand" : "bg-surface text-text/80 hover:bg-surface-sunken")}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="min-w-0 flex-1 truncate text-right text-[11px] text-subtle">Made-up sample data</span>
      </div>
      {!maskingOn && (
        <div className="flex items-start gap-2 border-b border-line/70 bg-warning-bg px-3.5 py-2 text-xs leading-[1.45] text-warning">
          <TriangleAlert className="mt-px h-4 w-4 shrink-0" aria-hidden />
          <span>Field masking is switched off for the workspace, so masked values show in the clear right now. This is what these rules do once it is on.</span>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs leading-[1.5] text-subtle">{words.title} have no fields that field access covers.</p>
      ) : context === "detail" ? (
        <div className="flex max-h-[560px] flex-col gap-2.5 overflow-auto px-3.5 pb-3 pt-2">
          {[
            { name: `${words.title} fields`, list: rows.filter((m) => !m.row.custom) },
            { name: "Custom fields", list: rows.filter((m) => m.row.custom) },
          ]
            .filter((g) => g.list.length > 0)
            .map((g) => (
              <div key={g.name}>
                <div className="pb-1 pt-1.5 text-[10.5px] font-bold uppercase tracking-[0.06em] text-subtle">{g.name}</div>
                {g.list.map((m) => {
                  const seen = visibility(m.policy, "detail");
                  const id = `${entity}:${record}:${m.row.key}`;
                  const sample = sampleValue(entity, m.row, record);
                  const open = seen === "masked" && m.policy.unmask && revealed[id];
                  return (
                    <div key={m.row.key} className={cn("flex items-center gap-2 border-b border-dashed border-line/70 py-[5px]", m.row.key === selected && "bg-brand-subtle")}>
                      <span className="w-[104px] shrink-0 truncate text-xs text-muted">{m.row.label}</span>
                      <span className={cn("min-w-0 flex-1 truncate text-[12.5px] font-medium", seen === "restricted" ? "text-danger" : seen === "masked" && !open ? "font-mono text-muted" : "text-text")}>
                        {open ? sample : presentValue(sample, m.policy, "detail")}
                      </span>
                      <span className="flex shrink-0">
                        {seen === "restricted" && (
                          <span title="Restricted — the value never leaves the server" className="inline-flex h-[22px] w-[22px] items-center justify-center text-danger">
                            <Lock className="h-[15px] w-[15px]" aria-hidden />
                          </span>
                        )}
                        {seen === "masked" && m.policy.unmask && (
                          <button
                            type="button"
                            title={open ? "Mask it again" : "Show — in the app this is logged and counts against the daily limit"}
                            aria-label={open ? `Mask ${m.row.label} again` : `Show ${m.row.label}`}
                            onClick={() => setRevealed((r) => ({ ...r, [id]: !r[id] }))}
                            className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-[5px] text-brand hover:bg-brand-subtle"
                          >
                            {open ? <EyeOff className="h-[15px] w-[15px]" aria-hidden /> : <Eye className="h-[15px] w-[15px]" aria-hidden />}
                          </button>
                        )}
                        {seen === "masked" && !m.policy.unmask && (
                          <span title="Masked · unmasking not permitted" className="inline-flex h-[22px] w-[22px] items-center justify-center text-subtle">
                            <EyeOff className="h-[15px] w-[15px]" aria-hidden />
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          {anyRevealed && <p className="text-[11px] leading-[1.45] text-subtle">Shown here as a preview only: nothing is logged and no daily limit is used.</p>}
          {restricted.length > 0 && <RestrictedNote names={restricted.map((m) => m.row.label)} />}
        </div>
      ) : (
        <div className="flex max-h-[560px] flex-col gap-2.5 overflow-auto px-3.5 pb-3 pt-2.5">
          <p className="text-[11px] leading-[1.45] text-subtle">
            {context === "list" ? `As a ${words.many} table, board, picker or search result shows them.` : "As the values leave in an export file or through the API's lists. A field left out goes out blank."}
          </p>
          <div className="overflow-auto rounded-md border border-line">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  {rows.map((m) => (
                    <th
                      key={m.row.key}
                      className={cn(
                        "whitespace-nowrap border-b border-line px-2 py-1.5 text-left text-[10.5px] font-semibold text-muted",
                        context === "export" ? "font-mono" : "uppercase tracking-[0.04em]",
                        m.row.key === selected ? "bg-brand-subtle" : "bg-surface-sunken/60",
                      )}
                    >
                      {m.row.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: SAMPLE_COUNT }, (_, i) => (i + record) % SAMPLE_COUNT).map((r) => (
                  <tr key={r}>
                    {rows.map((m) => {
                      const seen = visibility(m.policy, context);
                      const value = presentValue(sampleValue(entity, m.row, r), m.policy, context);
                      return (
                        <td
                          key={m.row.key}
                          title={value === null ? "Left out — the cell goes out blank" : undefined}
                          className={cn(
                            "max-w-[170px] truncate whitespace-nowrap border-b border-line/70 px-2 py-1.5 text-xs",
                            m.row.key === selected && "bg-brand-subtle",
                            value === null ? "bg-surface-sunken/60 text-subtle" : seen === "restricted" ? "text-danger" : seen === "masked" ? "font-mono text-muted" : "text-text",
                          )}
                        >
                          {value === null ? "" : value}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {context === "export" && rows.some((m) => m.policy.view && m.policy.export === "none") && (
            <p className="text-[11px] leading-[1.45] text-subtle">
              Left out: {rows.filter((m) => m.policy.view && m.policy.export === "none").map((m) => m.row.label).join(", ")}.
            </p>
          )}
          {restricted.length > 0 && <RestrictedNote names={restricted.map((m) => m.row.label)} />}
        </div>
      )}
    </>
  );
}

function RestrictedNote({ names }: { names: string[] }) {
  return (
    <div className="flex items-start gap-2 rounded-md bg-surface-sunken px-2.5 py-2 text-xs leading-[1.5] text-muted">
      <EyeOff className="mt-px h-4 w-4 shrink-0" aria-hidden />
      <span>
        <b className="font-semibold text-text/80">
          {names.length} {names.length === 1 ? "field" : "fields"} restricted:
        </b>{" "}
        {names.slice(0, 8).join(", ")}
        {names.length > 8 ? ` +${names.length - 8} more` : ""}. Only the word “Restricted” is shown.
      </span>
    </div>
  );
}

// ─── Summary ──────────────────────────────────────────────────────────────────────────────────────

function LimitBlock({ limit }: { limit: LimitSummary }) {
  const said = limitWords(limit);
  return (
    <div>
      <div className={heading}>Daily unmask limit</div>
      <Link href={acPath.limits()} className="flex items-start gap-2 rounded-md border border-dashed border-line-strong bg-surface-sunken/60 px-2.5 py-2 text-xs text-text/80 transition-colors hover:bg-surface-sunken">
        <Gauge className="mt-px h-4 w-4 shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-text">{said.short}</span>
          {limit.kind === "user" && limit.limit !== null && <Meter value={limit.used} max={limit.limit} className="my-1.5" />}
          <span className="block leading-[1.45] text-muted">{said.full}</span>
        </span>
        <ChevronRight className="mt-px h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden />
      </Link>
      <p className="mt-1 text-[11px] leading-[1.45] text-subtle">One limit for leads, contacts and companies together. Each record unmasked counts once a day.</p>
    </div>
  );
}

function SummaryTabBody({
  entity,
  subject,
  rows,
  limit,
  staged,
  onUndo,
  onSelect,
}: {
  entity: FieldEntity;
  subject: FieldSubject;
  rows: RowModel[];
  limit: LimitSummary;
  staged: StagedItem[];
  onUndo: (entity: FieldEntity, key: string) => void;
  onSelect: (key: string) => void;
}) {
  const total = rows.length;
  const count = (test: (m: RowModel) => boolean) => rows.filter(test).length;
  const stats: { label: string; value: number; warn?: boolean }[] = [
    { label: "viewable", value: count((m) => m.policy.view) },
    { label: "masked in list", value: count((m) => m.policy.view && m.policy.maskInList), warn: true },
    { label: "masked on record", value: count((m) => m.policy.view && m.policy.maskInDetail), warn: true },
    { label: "can unmask", value: count((m) => m.policy.view && m.policy.unmask), warn: true },
    { label: "exported clear", value: count((m) => visibility(m.policy, "export") === "clear") },
    { label: "restricted", value: count((m) => !m.policy.view) },
  ];
  const restricted = rows.filter((m) => !m.policy.view);
  const subjectLink = subject.type === "role" ? { role: subject.id } : { user: subject.id };
  return (
    <div className="flex flex-col gap-3.5 p-3.5">
      <div className="grid grid-cols-3 gap-2">
        {stats.map((s) => (
          <div key={s.label} className="rounded-md bg-surface-sunken p-2.5">
            <div className={cn("text-lg font-bold leading-tight tracking-[-0.02em]", s.warn && s.value > 0 ? "text-warning" : "text-text")}>
              {s.value}
              <span className="text-[11px] font-medium text-subtle">/{total}</span>
            </div>
            <div className="mt-px text-[11px] text-muted">{s.label}</div>
          </div>
        ))}
      </div>

      <LimitBlock limit={limit} />

      <div>
        <div className={heading}>
          Restricted fields <span className="font-medium text-subtle/80">{restricted.length}</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {restricted.map((m) => (
            <button key={m.row.key} type="button" onClick={() => onSelect(m.row.key)} className="h-[22px] rounded-[5px] bg-danger-bg px-2 text-[11.5px] font-semibold text-danger">
              {m.row.label}
            </button>
          ))}
          {restricted.length === 0 && <span className="text-xs text-subtle">Every field is visible.</span>}
        </div>
      </div>

      <div>
        <div className={heading}>
          Staged changes <span className="font-medium text-subtle/80">{staged.length}</span>
        </div>
        {staged.length === 0 ? (
          <div className="text-xs text-subtle">No unsaved changes.</div>
        ) : (
          <div className="flex max-h-[240px] flex-col gap-[3px] overflow-auto">
            {staged.map((s) => (
              <div key={`${s.entity}:${s.key}`} className="rounded-[5px] bg-surface-sunken px-2 py-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium text-text/80">
                    {s.entity === entity ? "" : `${FIELD_ENTITY_WORDS[s.entity].title} › `}
                    {s.label}
                  </span>
                  {s.exceeds && (
                    <span title="More open than your own access — it can't be saved">
                      <TriangleAlert className="h-3.5 w-3.5 text-warning" aria-label="More open than your own access" />
                    </span>
                  )}
                  <button type="button" title="Undo" aria-label={`Undo the change to ${s.label}`} onClick={() => onUndo(s.entity, s.key)} className="inline-flex h-5 w-5 items-center justify-center rounded text-muted hover:bg-line">
                    <Undo2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
                <div className="mt-0.5 font-mono text-[10.5px] leading-[1.45] text-subtle">
                  {s.from} <ArrowRight className="inline h-3 w-3 align-[-1px]" aria-hidden /> <span className="font-semibold text-brand">{s.to}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <div className={heading}>Also decides what they see</div>
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              ["Module matrix", acPath.modules(subjectLink)],
              ["Data scope", acPath.scope(subjectLink)],
              ["Audit log", acPath.audit(subjectLink)],
            ] as const
          ).map(([label, href]) => (
            <Link key={label} href={href} className="inline-flex h-[26px] items-center rounded-md border border-line-strong bg-surface px-2.5 text-xs font-semibold text-text hover:bg-surface-sunken">
              {label}
            </Link>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] leading-[1.45] text-subtle">Field access narrows what those allow; it never widens them.</p>
      </div>
    </div>
  );
}

// ─── One field ────────────────────────────────────────────────────────────────────────────────────

function FieldTabBody({ entity, subject, model, history, limit }: { entity: FieldEntity; subject: FieldSubject; model: RowModel | null; history: FieldChange[]; limit: LimitSummary }) {
  if (!model) return <p className="px-3 py-6 text-center text-xs leading-[1.5] text-subtle">Pick a field in the matrix to see how each answer resolves.</p>;
  const { row, policy: p } = model;
  const words = FIELD_ENTITY_WORDS[entity];
  const Icon = KIND_ICON[row.kind];
  const state = standing(p);
  const masked = p.view && (p.maskInList || p.maskInDetail);
  const sample = sampleValue(entity, row, 0);
  const resolves: { label: string; pill: string; tone: PillTone; changed: boolean }[] = [
    { label: "View", pill: p.view ? "ALLOW" : "RESTRICTED", tone: p.view ? "green" : "red", changed: p.view !== model.saved.view },
    { label: "In lists", pill: !p.view ? "N/A" : p.maskInList ? "MASKED" : "CLEAR", tone: !p.view ? "neutral" : p.maskInList ? "amber" : "green", changed: p.maskInList !== model.saved.maskInList },
    { label: "On record", pill: !p.view ? "N/A" : p.maskInDetail ? "MASKED" : "CLEAR", tone: !p.view ? "neutral" : p.maskInDetail ? "amber" : "green", changed: p.maskInDetail !== model.saved.maskInDetail },
    { label: "Unmask", pill: !masked ? "N/A" : p.unmask ? "ALLOW" : "DENY", tone: !masked ? "neutral" : p.unmask ? "green" : "red", changed: p.unmask !== model.saved.unmask },
  ];
  const source = model.staged ? "Staged — applies once you save." : row.why;
  const expired = subject.type === "user" && row.override && !row.stored && !model.staged;
  const activity = history.filter((h) => h.field === row.key).slice(0, 5);
  const seenRows: [string, FieldContext][] = [
    ["In a list", "list"],
    [`On the ${words.one}`, "detail"],
    ["In an export", "export"],
  ];

  return (
    <div className="flex flex-col gap-3.5 p-3.5">
      <div className="flex items-start gap-2.5">
        <span className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-text/80">
          <Icon className="h-[19px] w-[19px]" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold">{row.label}</div>
          <div className="mt-0.5 break-all font-mono text-[11.5px] text-muted">
            field:{entity}:{row.key}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            <Pill tone={state.tone} className="h-[18px] text-[10.5px]">
              {state.text}
            </Pill>
            <Pill className="h-[18px] text-[10.5px]">{KIND_LABEL[row.kind]}</Pill>
            {model.pii && (
              <Pill tone="brand" className="h-[18px] text-[10.5px]">
                PII
              </Pill>
            )}
            {row.custom && (
              <Pill tone="brand" className="h-[18px] text-[10.5px]">
                Custom field
              </Pill>
            )}
            {model.restrictedCustom && (
              <Pill tone="amber" className="h-[18px] text-[10.5px]">
                Restricted custom field
              </Pill>
            )}
          </div>
        </div>
      </div>
      <p className="text-xs leading-[1.5] text-muted">{row.description}</p>

      {model.exceeds && (
        <div className="flex items-start gap-2 rounded-md bg-warning-bg px-2.5 py-2 text-xs leading-[1.45] text-warning">
          <TriangleAlert className="mt-px h-4 w-4 shrink-0" aria-hidden />
          <span>
            This is more open than your own access to {row.label}. Nobody gives a {subject.type === "role" ? "role" : "person"} more of a field than they have themselves, so it can&apos;t be saved.
          </span>
        </div>
      )}

      <div>
        <div className={heading}>How each answer resolves</div>
        <div className="flex flex-col gap-1">
          {resolves.map((r) => (
            <div key={r.label} className="flex items-center gap-2 rounded-md bg-surface-sunken px-2 py-1.5 text-xs">
              <span className="w-[68px] font-semibold text-text/80">{r.label}</span>
              <span className={cn("inline-flex h-[18px] shrink-0 items-center rounded-full px-[7px] text-[10px] font-bold tracking-[0.04em]", PILL_TONE[r.tone])}>{r.pill}</span>
              {r.changed && <span className="ml-auto text-[11px] font-semibold text-brand">staged</span>}
            </div>
          ))}
          <div className="flex items-center gap-2 rounded-md bg-surface-sunken px-2 py-1.5 text-xs">
            <span className="w-[68px] shrink-0 font-semibold text-text/80">Format</span>
            <span className={cn("min-w-0 flex-1 truncate", masked ? "text-text/80" : "text-subtle")}>{p.view ? MASK_FORMAT_LABELS[p.format] : "—"}</span>
            {p.format !== model.saved.format && p.view && <span className="text-[11px] font-semibold text-brand">staged</span>}
          </div>
          <div className="flex items-center gap-2 rounded-md bg-surface-sunken px-2 py-1.5 text-xs">
            <span className="w-[68px] shrink-0 font-semibold text-text/80">Export</span>
            <span className="min-w-0 flex-1 text-text/80">{exportWords(p)}</span>
            {p.export !== model.saved.export && p.view && <span className="text-[11px] font-semibold text-brand">staged</span>}
          </div>
        </div>
        <div className={cn("mt-1.5 flex items-start gap-1.5 text-[11.5px] leading-[1.45]", model.staged ? "text-brand" : "text-muted")}>
          {model.staged ? <Pencil className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden /> : subject.type === "role" ? <Shield className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden /> : <User className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />}
          <span>
            {source}
            {!model.staged && row.stored && row.override?.grantedBy ? ` Set by ${row.override.grantedBy}.` : ""}
            {expired ? " Their own answer for this field has expired." : ""}
          </span>
        </div>
      </div>

      <div>
        <div className={heading}>As they see it</div>
        <div className="flex flex-col">
          {seenRows.map(([label, context]) => {
            const seen = visibility(p, context);
            const value = presentValue(sample, p, context);
            return (
              <div key={context} className="flex items-center gap-2 border-b border-dashed border-line/70 py-[5px] text-xs">
                <span className="w-[92px] shrink-0 text-muted">{label}</span>
                <span className={cn("min-w-0 flex-1 truncate font-medium", value === null ? "italic text-subtle" : seen === "restricted" ? "text-danger" : seen === "masked" ? "font-mono text-muted" : "text-text")}>
                  {value === null ? "left out (blank)" : value}
                </span>
              </div>
            );
          })}
        </div>
        {masked && p.unmask && (
          <Link href={acPath.limits()} className="mt-2 flex w-full items-center gap-1.5 rounded-md border border-dashed border-line-strong bg-surface-sunken/60 px-2.5 py-2 text-xs text-text/80 hover:bg-surface-sunken">
            <Gauge className="h-4 w-4 shrink-0 text-muted" aria-hidden />
            <span className="min-w-0 flex-1">Unmasking counts against the daily limit: {limitWords(limit).short.toLowerCase()}</span>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden />
          </Link>
        )}
      </div>

      {subject.type === "role" && (
        <div>
          <div className={heading}>Affects</div>
          <div className="flex items-center gap-1.5">
            {subject.holders.length > 0 && (
              <span className="flex pl-1.5">
                {subject.holders.slice(0, 5).map((h) => (
                  <InitialsAvatar key={h.id} name={h.name} seed={h.id} size={24} className="-ml-1.5 border-2 border-surface" />
                ))}
              </span>
            )}
            <span className="text-xs text-muted">
              {subject.holders.length === 0 ? "Nobody holds this role yet" : `${subject.holders.length} ${subject.holders.length === 1 ? "employee holds" : "employees hold"} this role`}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-[1.45] text-subtle">A person&apos;s own answer for a field, where one is set, comes before their role&apos;s.</p>
        </div>
      )}

      <div>
        <div className={heading}>Recent changes to this field</div>
        {activity.length === 0 ? (
          <div className="text-xs text-subtle">No changes recorded yet.</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {activity.map((a) => (
              <div key={a.id} className="flex gap-2 text-xs leading-[1.45]">
                <History className="mt-px h-[15px] w-[15px] shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1 text-text/80">
                  {a.detail}
                  {a.actor ? ` · ${a.actor}` : ""}
                </span>
                <span className="whitespace-nowrap text-subtle">
                  <Ago at={a.at} />
                </span>
              </div>
            ))}
          </div>
        )}
        <Link href={acPath.audit(subject.type === "role" ? { role: subject.id } : { user: subject.id })} className="mt-2 inline-block text-xs font-semibold text-brand hover:underline">
          Full audit log for {subject.type === "role" ? "this role" : subject.name}
        </Link>
      </div>
    </div>
  );
}

const PILL_TONE: Record<PillTone, string> = {
  neutral: "bg-line text-muted",
  brand: "bg-brand-subtle text-brand",
  green: "bg-success-bg text-success",
  amber: "bg-warning-bg text-warning",
  red: "bg-danger-bg text-danger",
  blue: "bg-info-bg text-info",
};
