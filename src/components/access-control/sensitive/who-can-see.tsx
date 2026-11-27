"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { Building2, ChevronDown, ChevronRight, Contact, FileDown, KeyRound, Target } from "lucide-react";
import type { SensitiveExportRow, SensitiveFieldRow, SensitivePerson } from "@/actions/access-control-sensitive";
import type { FieldEntity } from "@/lib/authz/field-policy";
import { acPath } from "@/lib/access-control/nav";
import { InitialsAvatar, Panel, Pill, rowHoverClass } from "@/components/access-control/ui";
import { cn } from "@/lib/utils";

/**
 * Sensitive Data Access, one panel per record type: each sensitive field, how many people see it in
 * the clear, masked or not at all, who may unmask it, and — opened — exactly who, and which roles carry
 * a rule for it. Read-only on purpose: a field's rule is set in Field Permissions, for a role or one
 * person, and every row links there.
 */

const ENTITY_ICON = { leads: Target, contacts: Contact, companies: Building2 } as const;

const th = "whitespace-nowrap border-b border-line/70 px-3 py-[7px] text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-muted";
const td = "border-b border-line/70 px-3 py-2 align-middle";

/** How many of a group's people are listed before "Show all". */
const SHOWN = 12;

function people(count: number): string {
  return `${count} ${count === 1 ? "person" : "people"}`;
}

/** Overlapping initials, then "N of M people". */
function Holders({ ids, all, total }: { ids: number[]; all: SensitivePerson[]; total: number }) {
  return (
    <div className="flex items-center gap-1.5">
      {ids.length > 0 && (
        <span className="flex pl-1.5">
          {ids.slice(0, 4).map((i) => {
            const p = all[i]!;
            return <InitialsAvatar key={p.id} name={p.name} seed={p.id} size={22} className="-ml-1.5 border-2 border-surface" />;
          })}
        </span>
      )}
      <span className="whitespace-nowrap text-[11.5px] text-muted">{ids.length === 0 ? "Nobody" : `${ids.length} of ${total} people`}</span>
    </div>
  );
}

/** One answer's people, each a link to their own access page. */
function PeopleGroup({ title, tone, ids, all, marked, note }: { title: string; tone: "green" | "amber" | "red" | "blue"; ids: number[]; all: SensitivePerson[]; marked?: Set<number>; note?: (index: number) => string | undefined }) {
  const [everyone, setEveryone] = useState(false);
  const shown = everyone ? ids : ids.slice(0, SHOWN);
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Pill tone={tone}>{title}</Pill>
        <span className="text-[11.5px] text-subtle">{people(ids.length)}</span>
      </div>
      {ids.length === 0 ? (
        <p className="text-xs text-subtle">Nobody.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {shown.map((i) => {
            const p = all[i]!;
            const why = note?.(i);
            return (
              <Link
                key={p.id}
                href={acPath.employee(p.id, "pii")}
                title={why ?? (p.isSuperAdmin ? "Super admin — sees every field" : p.roleName)}
                className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-line bg-surface pl-0.5 pr-2.5 text-xs text-text transition-colors hover:border-line-strong hover:bg-surface-sunken"
              >
                <InitialsAvatar name={p.name} seed={p.id} size={22} />
                <span className="truncate font-medium">{p.name}</span>
                <span className="truncate text-subtle">{p.isSuperAdmin ? "Super admin" : p.roleName}</span>
                {marked?.has(i) && <KeyRound className="h-3.5 w-3.5 shrink-0 text-info" aria-label="May unmask" />}
              </Link>
            );
          })}
          {ids.length > SHOWN && (
            <button type="button" onClick={() => setEveryone((v) => !v)} className="h-7 rounded-full px-2.5 text-xs font-semibold text-brand hover:underline">
              {everyone ? "Show fewer" : `Show all ${ids.length}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Count({ n, tone }: { n: number; tone: "success" | "warning" | "info" | "danger" }) {
  const colour = tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : tone === "info" ? "text-info" : "text-danger";
  return <span className={cn("font-semibold tabular-nums", n === 0 ? "text-subtle" : colour)}>{n}</span>;
}

export function FieldAccessPanel({ entity, title, fields, people: all }: { entity: FieldEntity; title: string; fields: SensitiveFieldRow[]; people: SensitivePerson[] }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const Icon = ENTITY_ICON[entity];
  const toggle = (key: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <Panel>
      <div className="flex items-center gap-2 border-b border-line bg-surface-sunken/60 px-4 py-2.5">
        <Icon className="h-[18px] w-[18px] text-text/80" aria-hidden />
        <span className="font-bold text-text">{title}</span>
        <span className="text-xs text-subtle">
          {fields.length} {fields.length === 1 ? "item" : "items"}
        </span>
        <div className="flex-1" />
        <Link href={acPath.fields({ entity })} className="text-xs font-semibold text-brand hover:underline">
          Field Permissions
        </Link>
      </div>
      <div className="overflow-auto">
        <table className="w-full min-w-[820px] border-collapse">
          <thead>
            <tr>
              <th className={cn(th, "min-w-[220px] pl-4")}>Item</th>
              <th className={cn(th, "w-[92px] text-right")}>In the clear</th>
              <th className={cn(th, "w-[80px] text-right")}>Masked</th>
              <th className={cn(th, "w-[100px] text-right")} title="Of those it is masked for: who may reveal it, within their daily limit. Every reveal is logged.">
                May unmask
              </th>
              <th className={cn(th, "w-[92px] text-right")}>Restricted</th>
              <th className={cn(th, "min-w-[170px]")}>Who can see it</th>
              <th className={cn(th, "w-9")} />
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => {
              const expanded = open.has(f.key);
              const seen = [...f.clear, ...f.masked];
              return (
                <Fragment key={f.key}>
                  <tr className={cn(rowHoverClass, "cursor-pointer")} onClick={() => toggle(f.key)}>
                    <td className={cn(td, "pl-4")}>
                      <div className="flex items-center gap-1.5 font-semibold text-text">
                        {f.label}
                        {f.custom && <Pill className="h-4 px-1.5 text-[9.5px] uppercase tracking-[0.04em]">Custom</Pill>}
                      </div>
                      <div className="text-[11.5px] text-subtle">
                        {title} ·{" "}
                        <Link href={acPath.fields({ entity })} onClick={(e) => e.stopPropagation()} className="font-semibold text-brand hover:underline">
                          open in field manager
                        </Link>
                      </div>
                    </td>
                    <td className={cn(td, "text-right")}>
                      <Count n={f.clear.length} tone="success" />
                    </td>
                    <td className={cn(td, "text-right")}>
                      <Count n={f.masked.length} tone="warning" />
                    </td>
                    <td className={cn(td, "text-right")}>
                      <Count n={f.unmask.length} tone="info" />
                    </td>
                    <td className={cn(td, "text-right")}>
                      <Count n={f.restricted.length} tone="danger" />
                    </td>
                    <td className={td}>
                      <Holders ids={seen} all={all} total={all.length} />
                    </td>
                    <td className={cn(td, "pr-3 text-right")}>
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-label={`${expanded ? "Hide" : "Show"} who sees ${f.label}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle(f.key);
                        }}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text/80 transition-colors hover:bg-surface-sunken"
                      >
                        {expanded ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
                      </button>
                    </td>
                  </tr>
                  {expanded && (
                    <tr>
                      <td colSpan={7} className="border-b border-line/70 bg-surface-sunken/40 px-4 py-3">
                        <p className="mb-3 max-w-3xl text-xs leading-[1.5] text-muted">{f.description}</p>
                        <div className="grid gap-4 lg:grid-cols-3">
                          <PeopleGroup title="In the clear" tone="green" ids={f.clear} all={all} />
                          <PeopleGroup title="Masked" tone="amber" ids={f.masked} all={all} marked={new Set(f.unmask)} />
                          <PeopleGroup title="Restricted" tone="red" ids={f.restricted} all={all} />
                        </div>
                        {f.unmask.length > 0 && (
                          <p className="mt-2 flex items-center gap-1 text-[11.5px] text-subtle">
                            <KeyRound className="h-3.5 w-3.5 text-info" aria-hidden />
                            may unmask it, within their daily limit — every reveal is logged.
                          </p>
                        )}
                        <div className="mt-3 border-t border-line/70 pt-2.5">
                          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">Rules set on roles</div>
                          {f.roles.length === 0 ? (
                            <p className="text-xs text-subtle">No role has a rule for this field — it is visible and unmasked unless a person has a rule of their own.</p>
                          ) : (
                            <div className="flex flex-wrap gap-1.5">
                              {f.roles.map((r) => (
                                <Link
                                  key={r.key}
                                  href={acPath.fields({ role: r.key, entity })}
                                  className="inline-flex min-h-7 items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1 text-xs transition-colors hover:border-line-strong hover:bg-surface-sunken"
                                >
                                  <span className="font-semibold text-text">{r.name}</span>
                                  <span className="text-muted">{r.rule}</span>
                                </Link>
                              ))}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {fields.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-subtle">
                  No sensitive fields on {title.toLowerCase()}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/** The rights that take data out in a file — who holds each, and why. */
export function ExportHoldersPanel({ rows, people: all }: { rows: SensitiveExportRow[]; people: SensitivePerson[] }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <Panel>
      <div className="flex items-center gap-2 border-b border-line bg-surface-sunken/60 px-4 py-2.5">
        <FileDown className="h-[18px] w-[18px] text-text/80" aria-hidden />
        <span className="font-bold text-text">Data exports</span>
        <span className="text-xs text-subtle">
          {rows.length} {rows.length === 1 ? "item" : "items"}
        </span>
        <div className="flex-1" />
        <Link href={acPath.importExport()} className="text-xs font-semibold text-brand hover:underline">
          Import &amp; Export
        </Link>
      </div>
      <div className="overflow-auto">
        <table className="w-full min-w-[640px] border-collapse">
          <thead>
            <tr>
              <th className={cn(th, "min-w-[260px] pl-4")}>Item</th>
              <th className={cn(th, "min-w-[170px]")}>Who can export it</th>
              <th className={cn(th, "w-9")} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const expanded = open.has(r.key);
              const ids = r.holders.map((h) => h.person);
              const whyOf = new Map(r.holders.map((h) => [h.person, h.why]));
              return (
                <Fragment key={r.key}>
                  <tr className={cn(rowHoverClass, "cursor-pointer")} onClick={() => toggle(r.key)}>
                    <td className={cn(td, "pl-4")}>
                      <div className="font-semibold text-text">{r.label}</div>
                      <div className="text-[11.5px] text-subtle">
                        Leaves the system in a file ·{" "}
                        <Link href={acPath.importExport()} onClick={(e) => e.stopPropagation()} className="font-semibold text-brand hover:underline">
                          open in Import &amp; Export
                        </Link>
                      </div>
                    </td>
                    <td className={td}>
                      <Holders ids={ids} all={all} total={all.length} />
                    </td>
                    <td className={cn(td, "pr-3 text-right")}>
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-label={`${expanded ? "Hide" : "Show"} who holds ${r.label}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle(r.key);
                        }}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text/80 transition-colors hover:bg-surface-sunken"
                      >
                        {expanded ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
                      </button>
                    </td>
                  </tr>
                  {expanded && (
                    <tr>
                      <td colSpan={3} className="border-b border-line/70 bg-surface-sunken/40 px-4 py-3">
                        <p className="mb-3 max-w-3xl text-xs leading-[1.5] text-muted">{r.description}</p>
                        <PeopleGroup title="May export" tone="blue" ids={ids} all={all} note={(i) => whyOf.get(i)} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
