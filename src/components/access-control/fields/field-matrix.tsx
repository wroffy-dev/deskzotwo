"use client";

import Link from "next/link";
import { AtSign, ChevronDown, ChevronRight, ListChecks, Lock, LockOpen, MapPin, Phone, Plus, RotateCcw, TriangleAlert, Type, type LucideIcon } from "lucide-react";
import type { FieldAccessRow } from "@/actions/field-access";
import { EXPORT_MODE_LABELS, EXPORT_MODES, FIELD_ENTITY_REVEALS, FIELD_ENTITY_WORDS, MASK_FORMAT_LABELS, maskValue, type ExportMode, type FieldEntity, type FieldKind, type FieldPolicy, type MaskFormat } from "@/lib/authz/field-policy";
import { cn } from "@/lib/utils";
import { EmptyNote, Panel } from "@/components/access-control/ui";
import { ExportControl, PolicySwitch } from "@/components/access-control/fields/policy-switch";
import { exportWords, FORMAT_SHORT, KIND_LABEL, sampleValue, type RowModel } from "@/components/access-control/fields/model";

const KIND_ICON: Record<FieldKind, LucideIcon> = { text: Type, email: AtSign, phone: Phone, address: MapPin, choice: ListChecks };

export type BulkColumn = "view" | "maskInList" | "maskInDetail" | "unmask";

const opTh = "border-b border-line bg-surface-sunken/60 px-1 pb-1 pt-1.5 text-center align-bottom text-[11px] font-semibold uppercase leading-[1.25] tracking-[0.04em] text-muted";
const opTd = "border-b border-line/70 px-1 py-1 text-center align-middle";
const iconButton = "inline-flex h-[26px] w-[26px] items-center justify-center rounded-md align-middle text-muted transition-colors hover:bg-surface-sunken disabled:pointer-events-none disabled:opacity-35";

/**
 * The field matrix: one row per field the record type has — the built-in ones, then the workspace's own
 * custom fields, with the same controls — and one column per answer a field policy holds
 * (src/lib/authz/field-policy.ts): View, Mask in list, Mask on record, the mask's format, Unmask, Export.
 *
 * Nothing here is saved: every press stages a change the parent holds, and Save sends them together.
 */
export function FieldMatrix({
  entity,
  subjectType,
  rows,
  total,
  query,
  selected,
  editable,
  collapsed,
  onCollapse,
  onSelect,
  onEdit,
  onReset,
  onBulk,
  onBulkExport,
}: {
  entity: FieldEntity;
  subjectType: "role" | "user";
  /** The fields that pass the search and the filter. */
  rows: RowModel[];
  /** How many the record type has in all. */
  total: number;
  query: string;
  selected: string | null;
  editable: boolean;
  collapsed: Record<string, boolean>;
  onCollapse: (group: string) => void;
  onSelect: (key: string) => void;
  onEdit: (row: FieldAccessRow, current: FieldPolicy, patch: Partial<FieldPolicy>) => void;
  onReset: (row: FieldAccessRow) => void;
  onBulk: (column: BulkColumn, on: boolean) => void;
  onBulkExport: (mode: ExportMode | null) => void;
}) {
  const words = FIELD_ENTITY_WORDS[entity];
  const reveals = FIELD_ENTITY_REVEALS[entity];
  const here = subjectType === "role" ? "this role" : "this employee";
  const groups = [
    { key: "builtin", name: "Built-in fields", custom: false, rows: rows.filter((m) => !m.row.custom) },
    { key: "custom", name: "Custom fields", custom: true, rows: rows.filter((m) => m.row.custom) },
  ].filter((g) => g.rows.length > 0);

  const columns: { key: BulkColumn; label: string; title: string; width: string }[] = [
    { key: "view", label: "View", title: "May the value be read at all. Off: only the word “Restricted” leaves the server.", width: "w-[54px]" },
    { key: "maskInList", label: "Mask in list", title: "Shown masked wherever many records are listed: tables, boards, pickers, search, dashboards and reports.", width: "w-[62px]" },
    {
      key: "maskInDetail",
      label: "Mask on record",
      title:
        entity === "contacts"
          ? "Shown masked on a customer's own Contacts tab until it is unmasked."
          : `Shown masked on the ${words.one}'s own page until it is unmasked.`,
      width: "w-[66px]",
    },
  ];
  const bulk = (column: BulkColumn) =>
    editable && (
      <div className="mt-[3px] flex justify-center gap-0.5 normal-case tracking-normal">
        <button type="button" title="Switch on for all listed fields" onClick={() => onBulk(column, true)} className="h-4 rounded-[3px] px-[3px] text-[10px] font-bold text-success hover:bg-success-bg">
          on
        </button>
        <button type="button" title="Switch off for all listed fields" onClick={() => onBulk(column, false)} className="h-4 rounded-[3px] px-[3px] text-[10px] font-bold text-danger hover:bg-danger-bg">
          off
        </button>
      </div>
    );

  return (
    <Panel className="min-w-0">
      <div className="overflow-auto">
        <table className="w-full min-w-[680px] border-collapse">
          <thead>
            <tr>
              <th className="min-w-[160px] border-b border-line bg-surface-sunken/60 px-3 py-2 text-left align-bottom text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">
                Field
                {editable && <div className="mt-[3px] text-[10px] font-medium normal-case tracking-normal text-subtle">all listed:</div>}
              </th>
              {columns.map((c) => (
                <th key={c.key} title={c.title} className={cn(opTh, c.width)}>
                  {c.label}
                  {bulk(c.key)}
                </th>
              ))}
              <th title="How a masked value is drawn. Used wherever the field is masked." className={cn(opTh, "w-[108px]")}>
                Mask format
                {editable && <div className="mt-[3px] h-4" />}
              </th>
              <th
                title="May a masked value be revealed on the record's own page. Each record revealed counts once a day against the daily unmask limit, and is logged."
                className={cn(opTh, "w-[58px]")}
              >
                Unmask
                {reveals ? bulk("unmask") : editable && <div className="mt-[3px] h-4" />}
              </th>
              <th title="How the field leaves in a file or through the API's lists. Nothing chosen: as the list shows it." className={cn(opTh, "w-[112px]")}>
                Export
                {editable && (
                  <div className="mt-[3px] flex justify-center normal-case tracking-normal">
                    <select
                      aria-label="Set export for all listed fields"
                      value=""
                      onChange={(e) => {
                        if (e.target.value) onBulkExport(e.target.value === "list" ? null : (e.target.value as ExportMode));
                      }}
                      className="h-4 cursor-pointer rounded-[3px] bg-transparent text-[10px] font-bold text-brand outline-none hover:bg-brand-subtle"
                    >
                      <option value="">set all…</option>
                      <option value="list">{EXPORT_MODE_LABELS.list}</option>
                      {EXPORT_MODES.map((m) => (
                        <option key={m} value={m}>
                          {EXPORT_MODE_LABELS[m]}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </th>
              <th className="w-[70px] border-b border-line bg-surface-sunken/60 px-2.5 py-2 text-right align-bottom text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">Actions</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const open = !collapsed[g.key];
              return [
                <tr key={`group:${g.key}`}>
                  <td colSpan={8} className="border-b border-line/70 bg-surface-sunken/60 p-0">
                    <button type="button" aria-expanded={open} onClick={() => onCollapse(g.key)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left">
                      {open ? <ChevronDown className="h-[18px] w-[18px] text-subtle" aria-hidden /> : <ChevronRight className="h-[18px] w-[18px] text-subtle" aria-hidden />}
                      <span className="text-xs font-bold text-text/80">{g.name}</span>
                      <span className="text-[11px] text-subtle">
                        {g.rows.length} {g.rows.length === 1 ? "field" : "fields"}
                      </span>
                      {g.custom && (
                        <>
                          <span className="inline-flex h-[18px] items-center rounded-full bg-brand-subtle px-[7px] text-[10px] font-bold tracking-[0.04em] text-brand">CUSTOM</span>
                          <span className="hidden text-[11px] text-subtle sm:inline">Same controls as built-in fields</span>
                        </>
                      )}
                    </button>
                  </td>
                </tr>,
                ...(open
                  ? g.rows.map((m) => {
                      const { row, policy: p } = m;
                      const Icon = KIND_ICON[row.kind];
                      const isSelected = row.key === selected;
                      const masked = p.view && (p.maskInList || p.maskInDetail);
                      const locked = !editable;
                      const edit = (patch: Partial<FieldPolicy>) => onEdit(row, p, patch);
                      const changed = (k: keyof FieldPolicy) => m.staged && p[k] !== m.saved[k];
                      const source = m.staged ? "Staged" : m.own ? (subjectType === "role" ? "Set on this role" : "Own override") : subjectType === "role" ? "Nothing set" : "As their role";
                      return (
                        <tr key={row.key} className={cn("transition-colors hover:bg-surface-sunken/60", !p.view ? "bg-danger-bg/50" : isSelected && "bg-brand-subtle")}>
                          <td className="border-b border-line/70 px-3 py-[5px]">
                            <button type="button" onClick={() => onSelect(row.key)} title={`${row.description} Open its details.`} className="flex w-full items-center gap-2 text-left">
                              <Icon className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
                              <span className="min-w-0 flex-1">
                                <span className={cn("flex flex-wrap items-center gap-x-[5px] gap-y-0.5", isSelected ? "font-bold" : "font-medium", p.view ? "text-text" : "text-muted")}>
                                  {row.label}
                                  {m.restrictedCustom && (
                                    <span title="A restricted custom field — also needs “See restricted fields”.">
                                      <Lock className="h-[13px] w-[13px] text-warning" aria-label="Restricted custom field" />
                                    </span>
                                  )}
                                  {m.pii && (
                                    <span title="Personal data: an email address or a phone number." className="inline-flex h-4 items-center rounded-full bg-brand-subtle px-1.5 text-[9px] font-bold tracking-[0.04em] text-brand">
                                      PII
                                    </span>
                                  )}
                                  {!p.view && <span className="inline-flex h-4 items-center rounded-full bg-danger px-1.5 text-[9px] font-bold tracking-[0.04em] text-white">RESTRICTED</span>}
                                  {m.exceeds && (
                                    <span title={`More open than your own access to ${row.label}. Nobody gives more than they have themselves, so this can't be saved.`}>
                                      <TriangleAlert className="h-[14px] w-[14px] text-warning" aria-label="More open than your own access" />
                                    </span>
                                  )}
                                </span>
                                <span className={cn("block truncate text-[11px]", m.staged ? "text-brand" : "text-subtle")}>
                                  {KIND_LABEL[row.kind]} · {source}
                                </span>
                              </span>
                            </button>
                          </td>
                          <td className={opTd}>
                            <PolicySwitch
                              tone="view"
                              on={p.view}
                              own={m.own}
                              staged={changed("view")}
                              disabled={locked}
                              label={`${row.label}: may be read`}
                              title={p.view ? `View: allowed${m.own ? ` — set on ${here}` : " — inherited"}` : `View: restricted${m.own ? ` — set on ${here}` : " — inherited"}`}
                              onChange={(v) => edit({ view: v })}
                            />
                          </td>
                          <td className={opTd}>
                            <PolicySwitch
                              tone="mask"
                              on={p.maskInList}
                              own={m.own}
                              staged={changed("maskInList")}
                              disabled={locked || !p.view}
                              label={`${row.label}: masked in lists`}
                              title={!p.view ? "Restricted — there is nothing to mask" : p.maskInList ? "Masked in lists" : "In the clear in lists"}
                              onChange={(v) => edit({ maskInList: v })}
                            />
                          </td>
                          <td className={opTd}>
                            <PolicySwitch
                              tone="mask"
                              on={p.maskInDetail}
                              own={m.own}
                              staged={changed("maskInDetail")}
                              disabled={locked || !p.view}
                              label={`${row.label}: masked on the ${entity === "contacts" ? "customer's page" : words.one}`}
                              title={!p.view ? "Restricted — there is nothing to mask" : p.maskInDetail ? `Masked on the ${words.one}` : `In the clear on the ${words.one}`}
                              onChange={(v) => edit({ maskInDetail: v })}
                            />
                          </td>
                          <td className={opTd}>
                            <select
                              aria-label={`${row.label}: mask format`}
                              title={p.view ? `${MASK_FORMAT_LABELS[p.format]}${masked ? "" : " — used once the field is masked"}` : "Restricted — there is nothing to mask"}
                              value={p.format}
                              disabled={locked || !p.view}
                              onChange={(e) => edit({ format: e.target.value as MaskFormat })}
                              className={cn(
                                "h-[26px] w-[100px] rounded-md border bg-surface px-1 font-mono text-[11px] outline-none focus:border-brand disabled:cursor-not-allowed disabled:opacity-40",
                                m.own ? "border-line-strong" : "border-dashed border-line-strong",
                                masked ? "text-text" : "text-subtle",
                                changed("format") && "ring-2 ring-brand/40",
                              )}
                            >
                              {row.formats.map((f) => (
                                <option key={f} value={f}>
                                  {maskValue(sampleValue(entity, row, 0), f)} · {FORMAT_SHORT[f]}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className={opTd}>
                            {reveals ? (
                              <PolicySwitch
                                tone="reveal"
                                on={p.unmask}
                                own={m.own}
                                staged={changed("unmask")}
                                disabled={locked || !masked}
                                label={`${row.label}: may unmask`}
                                title={!p.view ? "Restricted — there is nothing to unmask" : !masked ? "Not masked anywhere, so there is nothing to unmask" : p.unmask ? "May unmask — each record counts once a day against the daily limit" : "May not unmask"}
                                onChange={(v) => edit({ unmask: v })}
                              />
                            ) : (
                              <span className="text-sm text-subtle" title={`${words.title} can't be unmasked yet`}>
                                –
                              </span>
                            )}
                          </td>
                          <td className={opTd}>
                            <ExportControl value={p.view ? p.export : null} staged={changed("export")} disabled={locked || !p.view} label={`${row.label}: in exports`} onChange={(v) => edit({ export: v })} />
                            <span className={cn("mt-0.5 block text-[10px] leading-tight", p.view ? "text-subtle" : "text-danger")}>{exportWords(p)}</span>
                          </td>
                          <td className="whitespace-nowrap border-b border-line/70 px-2 py-1 text-right">
                            <button
                              type="button"
                              disabled={locked}
                              onClick={() => edit({ view: !p.view })}
                              title={p.view ? "Restrict this field: only the word “Restricted” is shown, everywhere" : "Lift the restriction"}
                              aria-label={p.view ? `Restrict ${row.label}` : `Lift the restriction on ${row.label}`}
                              aria-pressed={!p.view}
                              className={cn(iconButton, !p.view ? "bg-danger-bg text-danger" : "hover:bg-danger-bg hover:text-danger")}
                            >
                              {p.view ? <LockOpen className="h-[17px] w-[17px]" aria-hidden /> : <Lock className="h-[17px] w-[17px]" aria-hidden />}
                            </button>
                            <button
                              type="button"
                              disabled={locked || (!m.own && !m.staged)}
                              onClick={() => onReset(row)}
                              title={subjectType === "role" ? "Reset to nothing set — visible and unmasked" : "Reset to their role's answer"}
                              aria-label={`Reset ${row.label}`}
                              className={iconButton}
                            >
                              <RotateCcw className="h-[17px] w-[17px]" aria-hidden />
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  : []),
              ];
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8}>
                  <EmptyNote className="py-8">{total === 0 ? `${words.title} have no fields that field access covers.` : query ? `No field matches “${query}”.` : "No fields match"}</EmptyNote>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-t border-line/70 px-3 py-2.5 text-[11px] text-muted">
        <span className="inline-flex items-center gap-[5px]">
          <PolicySwitch demo tone="view" on own label="" />
          Set on {here}
        </span>
        <span className="inline-flex items-center gap-[5px]">
          <PolicySwitch demo tone="view" on own={false} label="" />
          {subjectType === "role" ? "Nothing set (visible, unmasked)" : "Inherited from their role"}
        </span>
        <span className="inline-flex items-center gap-[5px]">
          <PolicySwitch demo tone="mask" on own label="" />
          Masking on
        </span>
        <span className="inline-flex items-center gap-[5px]">
          <PolicySwitch demo tone="view" on={false} own label="" />
          Restricted here
        </span>
        <span className="inline-flex items-center gap-[5px]">
          <span className="inline-block h-3.5 w-3.5 rounded-full ring-2 ring-brand/40" aria-hidden />
          Staged, not saved
        </span>
        <span className="inline-flex items-center gap-[5px]">
          <TriangleAlert className="h-3.5 w-3.5 text-warning" aria-hidden />
          Wider than your own access
        </span>
        <span className="flex-1" />
        <Link href="/settings/custom-fields" className="inline-flex items-center gap-1 font-semibold text-brand hover:underline">
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Add custom field
        </Link>
      </div>
    </Panel>
  );
}
