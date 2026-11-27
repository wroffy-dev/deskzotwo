"use client";

import { Fragment, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowLeftRight, ArrowRight, Check, Equal, Shield, X } from "lucide-react";
import type { CompareAnswer, CompareRow, CompareSide, Comparison } from "@/actions/access-control-tools";
import { acPath } from "@/lib/access-control/nav";
import { SearchSelect } from "@/components/ui/search-select";
import { InitialsAvatar, Panel, PanelHeader, Pill, acInput, acToneOf, rowHoverClass, thClass } from "@/components/access-control/ui";
import { ToolModuleIcon } from "@/components/access-control/tools/module-icon";
import { cn } from "@/lib/utils";

type Filter = "diff" | "a" | "b" | "both" | "all";
type Section = CompareRow["section"];

const SECTIONS: { key: Section; title: string; hint: string; column: string }[] = [
  { key: "permission", title: "Permissions", hint: "What each may do", column: "Permission" },
  { key: "reach", title: "Record reach", hint: "Which records each reaches, by action", column: "Record type › action" },
  { key: "field", title: "Field permissions", hint: "What each sees of the sensitive fields, and the daily unmask limit", column: "Field" },
];

const FILTERS: [Filter, string][] = [
  ["diff", "Differences"],
  ["a", "Only left"],
  ["b", "Only right"],
  ["both", "Both allow"],
  ["all", "Everything"],
];

const segment = (on: boolean) => cn("border-r border-line px-3 text-xs font-semibold transition-colors last:border-r-0", on ? "bg-brand-subtle text-brand" : "bg-surface text-text/80 hover:bg-surface-sunken");

/**
 * Permission Comparison: two subjects — a role or a person on each side — and every answer they differ
 * on, in the three questions the model asks: what may you do, which records, which fields.
 *
 * The server resolved both sides in full (src/actions/access-control-tools.ts); this only filters and
 * counts. "Only left" and "Only right" are answers one side has and the other doesn't; a row both have
 * at different widths (Team against All, masked against visible) is a difference that is neither.
 */
export function CompareView({ data }: { data: Comparison }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [filter, setFilter] = useState<Filter>("diff");
  const [moduleKey, setModuleKey] = useState("all");
  const [includeFields, setIncludeFields] = useState(true);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const go = (a: string, b: string) => start(() => router.push(acPath.compare(a, b)));

  const scoped = data.rows.filter((r) => (includeFields || r.section !== "field") && (moduleKey === "all" || r.module === moduleKey));
  const differing = scoped.filter((r) => r.status !== "same");
  const onlyA = scoped.filter((r) => r.status === "onlyA");
  const onlyB = scoped.filter((r) => r.status === "onlyB");
  const both = scoped.filter((r) => r.status === "same" && r.a.on);
  const shown = filter === "diff" ? differing : filter === "a" ? onlyA : filter === "b" ? onlyB : filter === "both" ? both : scoped;

  const kpis: { key: Filter; label: string; value: number; hint: string; tone: string }[] = [
    { key: "diff", label: "Differences", value: differing.length, hint: "answers that differ", tone: "text-text" },
    { key: "a", label: `Only ${data.a.name}`, value: onlyA.length, hint: "allowed on the left only", tone: "text-info" },
    { key: "b", label: `Only ${data.b.name}`, value: onlyB.length, hint: "allowed on the right only", tone: "text-chart-5" },
    { key: "both", label: "Both allow", value: both.length, hint: "shared, at the same width", tone: "text-success" },
  ];

  return (
    <div className={cn("flex flex-col gap-3.5 transition-opacity", pending && "opacity-60")}>
      <div className="grid grid-cols-1 items-center gap-3 md:grid-cols-[1fr_auto_1fr]">
        <SideCard side={data.a} data={data} accent="border-t-info" onChange={(ref) => go(ref, data.b.ref)} />
        <button
          type="button"
          onClick={() => go(data.b.ref, data.a.ref)}
          title="Swap"
          aria-label="Swap the two sides"
          className="mx-auto inline-flex h-9 w-9 items-center justify-center rounded-full border border-line-strong bg-surface text-text/80 transition-colors hover:bg-surface-sunken"
        >
          <ArrowLeftRight className="h-[18px] w-[18px]" aria-hidden />
        </button>
        <SideCard side={data.b} data={data} accent="border-t-chart-5" onChange={(ref) => go(data.a.ref, ref)} />
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
        {kpis.map((k) => (
          <button
            key={k.key}
            type="button"
            onClick={() => setFilter(k.key)}
            aria-pressed={filter === k.key}
            className={cn("rounded-lg border bg-surface px-4 py-3 text-left transition-colors", filter === k.key ? "border-brand" : "border-line hover:border-line-strong")}
          >
            <div className="truncate text-xs font-medium text-muted">{k.label}</div>
            <div className={cn("mt-0.5 text-2xl font-bold tracking-[-0.02em]", k.tone)}>{k.value}</div>
            <div className="text-[11.5px] text-subtle">{k.hint}</div>
          </button>
        ))}
      </div>

      <Panel className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <div className="inline-flex h-[30px] overflow-hidden rounded-md border border-line-strong">
          {FILTERS.map(([value, label]) => (
            <button key={value} type="button" onClick={() => setFilter(value)} aria-pressed={filter === value} className={segment(filter === value)}>
              {label}
            </button>
          ))}
        </div>
        <select aria-label="Module" value={moduleKey} onChange={(e) => setModuleKey(e.target.value)} className={cn(acInput, "text-xs")}>
          <option value="all">All modules</option>
          {data.modules.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
            </option>
          ))}
        </select>
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-text/80">
          <input type="checkbox" checked={includeFields} onChange={(e) => setIncludeFields(e.target.checked)} className="accent-brand" />
          Include field permissions
        </label>
        <span className="ml-auto text-xs text-muted">
          {shown.length} {shown.length === 1 ? "answer" : "answers"}
        </span>
      </Panel>

      {shown.length === 0 ? (
        <Panel>
          <p className="p-10 text-center text-subtle">
            {filter === "diff" || filter === "a" || filter === "b" ? "No differences with these filters. The two subjects are effectively identical here." : "Nothing to show with these filters."}
          </p>
        </Panel>
      ) : (
        SECTIONS.map((section) => {
          const rows = shown.filter((r) => r.section === section.key);
          if (rows.length === 0) return null;
          const groups = data.modules.map((m) => ({ ...m, rows: rows.filter((r) => r.module === m.key) })).filter((g) => g.rows.length > 0);
          return (
            <Panel key={section.key}>
              <PanelHeader title={section.title} meta={<span className="text-xs text-subtle">{section.hint}</span>} action={<span className="text-xs text-muted">{rows.length}</span>} />
              <div className="overflow-auto">
                <table className="w-full min-w-[720px] border-collapse">
                  <thead>
                    <tr>
                      <th className={cn(thClass, "w-[40%] px-3.5")}>{section.column}</th>
                      <th className={cn(thClass, "w-[26%] px-3.5")}>{data.a.name}</th>
                      <th className={cn(thClass, "w-10 px-2")} aria-label="Which side has more" />
                      <th className={cn(thClass, "w-[26%] px-3.5")}>{data.b.name}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g) => {
                      const id = `${section.key}:${g.key}`;
                      const open = !collapsed[id];
                      const differ = g.rows.filter((r) => r.status !== "same").length;
                      return (
                        <Fragment key={id}>
                          <tr>
                            <td colSpan={4} className="border-b border-line bg-surface-sunken/60 px-3.5 py-2">
                              <div className="flex items-center gap-2">
                                <ToolModuleIcon icon={g.icon} className="h-[18px] w-[18px] text-text/80" />
                                <span className="text-[12.5px] font-bold">{g.label}</span>
                                <span className="text-[11.5px] text-subtle">
                                  {g.rows.length} {g.rows.length === 1 ? "answer" : "answers"} · {differ} differ
                                </span>
                                <div className="flex-1" />
                                <button type="button" onClick={() => setCollapsed((c) => ({ ...c, [id]: open }))} aria-expanded={open} className="text-xs font-semibold text-brand hover:underline">
                                  {open ? "Collapse" : "Expand"}
                                </button>
                              </div>
                            </td>
                          </tr>
                          {open && g.rows.map((r) => <Row key={r.id} row={r} />)}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Panel>
          );
        })
      )}
    </div>
  );
}

/** One side: who it is, role or person, and the picker for it. Its top edge carries the side's colour. */
function SideCard({ side, data, accent, onChange }: { side: CompareSide; data: Comparison; accent: string; onChange: (ref: string) => void }) {
  const kinds: { kind: CompareSide["kind"]; label: string; first: string | undefined }[] = [
    { kind: "role", label: "Role", first: data.roles[0]?.key },
    { kind: "user", label: "Employee", first: data.people[0]?.id },
  ];
  return (
    <div className={cn("flex flex-wrap items-center gap-2.5 rounded-lg border border-t-[3px] border-line bg-surface px-3.5 py-3", accent)}>
      {side.kind === "user" ? (
        <InitialsAvatar name={side.name} seed={side.id} size={34} />
      ) : (
        <span className={cn("inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg text-white", acToneOf(side.id))}>
          <Shield className="h-[18px] w-[18px]" aria-hidden />
        </span>
      )}
      <div className="inline-flex h-7 overflow-hidden rounded-md border border-line-strong">
        {kinds.map((k) => (
          <button key={k.kind} type="button" disabled={!k.first} onClick={() => side.kind !== k.kind && k.first && onChange(`${k.kind}:${k.first}`)} aria-pressed={side.kind === k.kind} className={segment(side.kind === k.kind)}>
            {k.label}
          </button>
        ))}
      </div>
      <SearchSelect
        aria-label={side.kind === "user" ? "Employee" : "Role"}
        searchPlaceholder={side.kind === "user" ? "Search people…" : "Search roles…"}
        value={side.id}
        onChange={(e) => onChange(`${side.kind}:${e.target.value}`)}
        className="h-[30px] min-w-[150px] flex-1 rounded-md px-2.5 text-[13px] font-semibold shadow-none"
      >
        {side.kind === "user"
          ? data.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.roleName}
                {p.active ? "" : " (deactivated)"}
              </option>
            ))
          : data.roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.name}
              </option>
            ))}
      </SearchSelect>
      <span className="basis-full text-[11.5px] text-subtle">{side.meta}</span>
    </div>
  );
}

const TINT: Record<CompareRow["status"], string> = { same: "", onlyA: "bg-info-bg/40", onlyB: "bg-chart-5/5", differ: "bg-warning-bg/40" };

function Row({ row }: { row: CompareRow }) {
  return (
    <tr className={cn(rowHoverClass, TINT[row.status])}>
      <td className="border-b border-line/70 px-3.5 py-[7px]">
        <div className="flex flex-wrap items-center gap-1.5 font-medium">
          {row.label}
          {row.note && (
            <Pill title={row.note} className="font-medium">
              {row.note.includes("plan") ? "Not in plan" : "Module off"}
            </Pill>
          )}
        </div>
        {row.sub && <div className="text-[11px] text-subtle">{row.sub}</div>}
      </td>
      <td className="border-b border-line/70 px-3.5 py-[7px]">
        <Answer answer={row.a} />
      </td>
      <td className="border-b border-line/70 px-2 py-[7px] text-center">
        {row.status === "same" ? (
          <Equal className="mx-auto h-4 w-4 text-line-strong" aria-label="The same" />
        ) : row.status === "onlyA" ? (
          <ArrowLeft className="mx-auto h-4 w-4 text-info" aria-label="Only the left" />
        ) : row.status === "onlyB" ? (
          <ArrowRight className="mx-auto h-4 w-4 text-chart-5" aria-label="Only the right" />
        ) : (
          <ArrowLeftRight className="mx-auto h-4 w-4 text-warning" aria-label="Both, differently" />
        )}
      </td>
      <td className="border-b border-line/70 px-3.5 py-[7px]">
        <Answer answer={row.b} />
      </td>
    </tr>
  );
}

/** One side's answer, with where it came from beside it and the full reason on hover. */
function Answer({ answer }: { answer: CompareAnswer }) {
  return (
    <span title={answer.why || undefined} className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <Pill tone={answer.tone} className="h-[22px] font-bold tracking-[0.04em]">
        {answer.tone === "green" && <Check className="h-[13px] w-[13px]" aria-hidden />}
        {answer.tone === "red" && <X className="h-[13px] w-[13px]" aria-hidden />}
        {answer.text}
      </Pill>
      {answer.src && <span className="text-[11px] text-subtle">{answer.src}</span>}
    </span>
  );
}
