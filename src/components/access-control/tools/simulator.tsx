"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Ban, Check, CheckCircle2, ChevronRight, ExternalLink, Eye, EyeOff, Gauge, Lock, Minus, Pencil, Trash2, UserPlus, type LucideIcon } from "lucide-react";
import type { SimStep, SimTry, SimulatorView } from "@/actions/access-control-tools";
import type { AccessAction } from "@/lib/authz/access";
import { LEVEL_WORDS } from "@/lib/authz/level-order";
import { STANDING_WORDS, type ModuleStanding } from "@/lib/staff/access-modules";
import { acPath } from "@/lib/access-control/nav";
import { SearchSelect } from "@/components/ui/search-select";
import { HintNote, InitialsAvatar, Panel, PanelHeader, Pill, acInput, type PillTone } from "@/components/access-control/ui";
import { ToolModuleIcon } from "@/components/access-control/tools/module-icon";
import { cn } from "@/lib/utils";

type Subject = { kind: "user" | "role"; id: string };
type FieldTry = Extract<SimTry, { kind: "field" }>;
type RecordTry = Extract<SimTry, { kind: "record" }>;

/** A simulation's address: who, which module, and the question open — so one can be sent to somebody. */
function simHref(subject: Subject, moduleKey: string, tryId?: string | null) {
  const base = acPath.simulator(subject.kind === "user" ? subject.id : undefined);
  const sp = new URLSearchParams();
  if (subject.kind === "role") sp.set("role", subject.id);
  sp.set("module", moduleKey);
  if (tryId) sp.set("q", tryId);
  return `${base}${base.includes("?") ? "&" : "?"}${sp.toString()}`;
}

const STANDING_TONE: Record<ModuleStanding, PillTone> = { full: "green", limited: "amber", none: "red" };
const ACTION_ICON: Record<AccessAction, LucideIcon> = { view: Eye, edit: Pencil, delete: Trash2, assign: UserPlus };
const subhead = "text-[10.5px] font-bold uppercase tracking-[0.06em] text-subtle";

/**
 * The Permission Simulator: pick a person (or a role on its own) and a module, and see what they get
 * and why — the module as they see it, every question it offers already answered, and the trace behind
 * the one that is open, in the order the app itself asks.
 *
 * Read-only by construction: the server answered every question before this drew (src/actions/
 * access-control-tools.ts), and nothing here calls an action. "Reveal" shows whether a reveal would be
 * allowed and what it would cost; it never reveals a value and never uses a unit of the daily limit.
 */
export function Simulator({ view, initialTry }: { view: SimulatorView; initialTry: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const { subject, tries } = view;
  const [tryId, setTryId] = useState(() => (tries.some((t) => t.id === initialTry) ? initialTry! : (tries[0]?.id ?? "")));

  const active = tries.find((t) => t.id === tryId) ?? tries[0] ?? null;
  const recordTries = tries.filter((t): t is RecordTry => t.kind === "record");
  const permissionTries = tries.filter((t) => t.kind === "permission");
  const fieldTries = tries.filter((t): t is FieldTry => t.kind === "field");
  const fieldKey = (t: FieldTry) => `${t.entity}:${t.field}`;
  const [fieldPick, setFieldPick] = useState(() => {
    const open = fieldTries.find((t) => t.id === tryId);
    const email = fieldTries.find((t) => t.field === "email");
    return open ? fieldKey(open) : email ? fieldKey(email) : fieldTries[0] ? fieldKey(fieldTries[0]) : "";
  });
  const pickedField = active?.kind === "field" ? fieldKey(active) : fieldPick;

  const go = (next: Subject, moduleKey: string) => start(() => router.push(simHref(next, moduleKey)));
  function pick(id: string) {
    setTryId(id);
    const t = fieldTries.find((x) => x.id === id);
    if (t) setFieldPick(fieldKey(t));
    // The address follows the question, so the link in the bar is this simulation.
    window.history.replaceState(null, "", simHref(subject, view.module.key, id));
  }

  const everythingDenied = tries.length > 0 && tries.every((t) => t.trace.verdict === "denied");
  const quota = subject.quota;
  const quotaTone: PillTone = !quota || quota.limit === null ? "green" : quota.remaining === 0 ? "red" : quota.used / quota.limit >= 0.8 ? "amber" : "green";

  return (
    <div className={cn("flex flex-col gap-3.5 transition-opacity", pending && "opacity-60")}>
      <Panel className="flex flex-wrap items-center gap-2 overflow-visible px-3 py-2.5">
        <span className="text-xs text-muted">Simulate as</span>
        <SearchSelect
          aria-label="Simulate as"
          searchPlaceholder="Search people and roles…"
          value={`${subject.kind}:${subject.id}`}
          onChange={(e) => {
            const [kind, ...rest] = e.target.value.split(":");
            go({ kind: kind === "role" ? "role" : "user", id: rest.join(":") }, view.module.key);
          }}
          className="h-8 w-[260px] rounded-md px-2.5 text-[13px] font-semibold shadow-none"
        >
          <optgroup label="People">
            {view.people.map((p) => (
              <option key={p.id} value={`user:${p.id}`}>
                {p.name} · {p.roleName}
                {p.active ? "" : " (deactivated)"}
              </option>
            ))}
          </optgroup>
          <optgroup label="Roles, with no exceptions">
            {view.roles.map((r) => (
              <option key={r.key} value={`role:${r.key}`}>
                {r.name} (role)
              </option>
            ))}
          </optgroup>
        </SearchSelect>
        <ChevronRight className="h-[18px] w-[18px] text-subtle" aria-hidden />
        <select aria-label="Module" value={view.module.key} onChange={(e) => go(subject, e.target.value)} className={cn(acInput, "min-w-[150px] font-semibold")}>
          {view.modules.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
            </option>
          ))}
        </select>
        <div className="flex-1" />
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          {subject.kind === "user" ? <InitialsAvatar name={subject.name} seed={subject.id} size={24} /> : null}
          <span>{subject.kind === "user" ? subject.roleName : "Role, with no exceptions"}</span>
          {subject.isSuperAdmin && <Pill tone="brand">Super admin</Pill>}
          {!subject.active && <Pill tone="red">{subject.kind === "user" ? "Deactivated" : "Switched off"}</Pill>}
          {quota && (
            <Link href={acPath.limits()} title="Records unmasked today against the daily unmask limit">
              <Pill tone={quotaTone} className="h-[22px] font-bold">
                <Gauge className="h-[13px] w-[13px]" aria-hidden />
                {quota.limit === null ? `${quota.used} unmasked today · no limit` : `${quota.remaining} of ${quota.limit} unmasks left today`}
              </Pill>
            </Link>
          )}
          {subject.kind === "user" && subject.overrides > 0 && (
            <Link href={acPath.employee(subject.id, "overrides")} className="font-semibold text-brand hover:underline">
              · {subject.overrides} {subject.overrides === 1 ? "override" : "overrides"}
            </Link>
          )}
        </div>
      </Panel>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Panel>
            <PanelHeader title={`${view.module.label} as ${subject.who} sees it`} action={<Pill tone={STANDING_TONE[view.module.standing]}>{STANDING_WORDS[view.module.standing]}</Pill>} />
            {everythingDenied ? (
              <div className="px-5 py-9 text-center">
                <Lock className="mx-auto h-9 w-9 text-subtle" aria-hidden />
                <div className="mt-2 font-semibold">
                  {cap(subject.who)} cannot open {view.module.label}
                </div>
                <div className="mx-auto mt-1 max-w-[460px] text-[12.5px] leading-[1.5] text-muted">{tries[0]?.trace.reason}</div>
              </div>
            ) : (
              <div className="flex flex-col gap-4 px-4 py-3.5">
                {view.records.map((record) => {
                  const mine = recordTries.filter((t) => t.record === record.key);
                  return (
                    <div key={record.key} className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                      <span className="text-[15px] font-bold tracking-[-0.01em]">{record.label}</span>
                      <span className="text-[11.5px] text-subtle">own = {record.ownMeans}</span>
                      <div className="flex-1" />
                      <div className="flex flex-wrap items-center gap-1">
                        {mine.map((t) => {
                          const ok = t.trace.verdict === "allowed";
                          const Icon = ACTION_ICON[t.action];
                          return (
                            <button
                              key={t.id}
                              type="button"
                              onClick={() => pick(t.id)}
                              title={t.trace.reason}
                              className={cn(
                                "inline-flex h-[26px] items-center gap-1 rounded-md border px-2 text-xs font-semibold transition-colors",
                                ok ? "border-line-strong bg-surface text-text hover:bg-surface-sunken" : "border-line/70 bg-surface-sunken/60 text-subtle line-through",
                                t.id === active?.id && "border-brand",
                              )}
                            >
                              <Icon className="h-[15px] w-[15px]" aria-hidden />
                              {cap(t.action)}
                              {ok && <span className="font-medium text-muted">· {LEVEL_WORDS[t.level]}</span>}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}

                {view.entities.map((entity) => {
                  const viewTry = recordTries.find((t) => t.record === entity.entity && t.action === "view");
                  const shown = entity.fields.filter((f) => f.detailSeen !== "restricted" || f.listSeen !== "restricted");
                  const hidden = entity.fields.filter((f) => !shown.includes(f));
                  return (
                    <div key={entity.entity}>
                      <div className={cn(subhead, "grid grid-cols-[minmax(96px,1fr)_minmax(0,1.3fr)_minmax(0,1.3fr)_22px] gap-2 border-b border-line/70 pb-1.5 pt-1")}>
                        <span>{entity.title} · fields</span>
                        <span>In lists</span>
                        <span>On the {entity.one}</span>
                        <span />
                      </div>
                      {viewTry && viewTry.trace.verdict === "denied" ? (
                        <p className="py-2 text-xs text-subtle">
                          {cap(subject.who)} can&apos;t open {entity.title.toLowerCase()}, so sees none of their fields.
                        </p>
                      ) : (
                        <>
                          {shown.map((f) => {
                            const masked = f.listSeen === "masked" || f.detailSeen === "masked";
                            const reveal = fieldTries.find((t) => t.entity === entity.entity && t.field === f.key && t.op === "reveal");
                            return (
                              <div key={f.key} title={f.why} className="grid grid-cols-[minmax(96px,1fr)_minmax(0,1.3fr)_minmax(0,1.3fr)_22px] items-center gap-2 py-1">
                                <span className="truncate text-xs text-muted">{f.label}</span>
                                <span className={cn("truncate text-[12.5px] font-medium", f.listSeen === "clear" ? "text-text" : "font-mono text-muted")}>{f.list}</span>
                                <span className={cn("truncate text-[12.5px] font-medium", f.detailSeen === "clear" ? "text-text" : "font-mono text-muted")}>{f.detail}</span>
                                {masked && reveal ? (
                                  <button
                                    type="button"
                                    onClick={() => pick(reveal.id)}
                                    title={f.mayUnmask ? "Masked · may reveal (counts against the daily limit). Open the trace." : "Masked · may not reveal. Open the trace."}
                                    aria-label={`Would a reveal of ${f.label} be allowed?`}
                                    className={cn("inline-flex h-[22px] w-[22px] items-center justify-center rounded transition-colors hover:bg-brand-subtle", f.mayUnmask ? "text-brand" : "text-subtle")}
                                  >
                                    {f.mayUnmask ? <Eye className="h-[15px] w-[15px]" aria-hidden /> : <EyeOff className="h-[15px] w-[15px]" aria-hidden />}
                                  </button>
                                ) : (
                                  <span />
                                )}
                              </div>
                            );
                          })}
                          {hidden.length > 0 && (
                            <div className="mt-1.5 flex items-start gap-2 rounded-md bg-surface-sunken px-2.5 py-2 text-xs leading-[1.5] text-muted">
                              <EyeOff className="mt-px h-4 w-4 shrink-0" aria-hidden />
                              <span>
                                <b className="font-semibold text-text/80">
                                  {hidden.length} {hidden.length === 1 ? "field" : "fields"} hidden from {subject.who}:
                                </b>{" "}
                                {hidden.map((f) => f.label).join(", ")}
                              </span>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
                {view.entities.length > 0 && (
                  <p className="text-[11.5px] text-subtle">
                    Sample values, masked the way {subject.who} would see them. No record is opened and nothing is revealed.
                    {!view.maskingOn && " Field masking is switched off for the workspace, so masked fields show in the clear."}
                  </p>
                )}

                {permissionTries.length > 0 && (
                  <div>
                    <div className={cn(subhead, "border-b border-line/70 pb-1.5 pt-1")}>{view.records.length > 0 ? "Other actions" : "Actions"}</div>
                    <div className="flex flex-wrap gap-1 pt-2">
                      {permissionTries.map((t) => {
                        const ok = t.trace.verdict === "allowed";
                        return (
                          <button
                            key={t.id}
                            type="button"
                            onClick={() => pick(t.id)}
                            title={t.trace.reason}
                            className={cn(
                              "inline-flex h-[26px] items-center gap-1 rounded-md border px-2 text-xs font-semibold transition-colors",
                              ok ? "border-line-strong bg-surface text-text hover:bg-surface-sunken" : "border-line/70 bg-surface-sunken/60 text-subtle line-through",
                              t.id === active?.id && "border-brand",
                            )}
                          >
                            {t.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {tries.length === 0 && <p className="py-4 text-center text-subtle">Nothing to grant in this module.</p>}
              </div>
            )}
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Panel>
            <PanelHeader title="Try an action" />
            <div className="flex flex-col gap-2.5 px-4 py-2.5">
              {recordTries.length > 0 && <TryGroup title="Records" tries={recordTries} activeId={active?.id} onPick={pick} />}
              {permissionTries.length > 0 && <TryGroup title="Permissions" tries={permissionTries} activeId={active?.id} onPick={pick} scroll />}
              {fieldTries.length > 0 && (
                <div>
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className={subhead}>Sensitive field</span>
                    <select aria-label="Field" value={pickedField} onChange={(e) => setFieldPick(e.target.value)} className={cn(acInput, "h-7 min-w-0 flex-1 text-xs")}>
                      {view.entities.map((entity) => (
                        <optgroup key={entity.entity} label={entity.title}>
                          {entity.fields.map((f) => (
                            <option key={f.key} value={`${entity.entity}:${f.key}`}>
                              {cap(entity.one)} · {f.label}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {fieldTries
                      .filter((t) => fieldKey(t) === pickedField)
                      .map((t) => (
                        <TryPill key={t.id} t={t} on={t.id === active?.id} onPick={pick} label={t.op === "view" ? "View" : t.op === "reveal" ? "Reveal" : "Export"} />
                      ))}
                  </div>
                </div>
              )}
            </div>
            {active ? (
              <div className="flex flex-col gap-2.5 px-4 pb-3.5">
                <div className={cn("flex items-center gap-2.5 rounded-lg p-3", active.trace.verdict === "allowed" ? "bg-success-bg" : "bg-danger-bg")}>
                  {active.trace.verdict === "allowed" ? <CheckCircle2 className="h-[26px] w-[26px] shrink-0 text-success" aria-hidden /> : <Ban className="h-[26px] w-[26px] shrink-0 text-danger" aria-hidden />}
                  <div className="min-w-0 flex-1">
                    <div className={cn("font-bold", active.trace.verdict === "allowed" ? "text-success" : "text-danger")}>{active.trace.title}</div>
                    <div className="mt-0.5 text-[12.5px] leading-[1.5] text-text/80">{active.trace.reason}</div>
                  </div>
                </div>
                <div>
                  <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.04em] text-subtle">Resolution trace · {tryTitle(active, view)}</div>
                  <ol className="flex flex-col">
                    {active.trace.steps.map((s, i) => (
                      <TraceStep key={`${s.label}:${i}`} step={s} final={i === active.trace.steps.length - 1} />
                    ))}
                  </ol>
                </div>
                {active.trace.fix && (
                  <Link
                    href={active.trace.fix.href}
                    className="inline-flex h-[30px] items-center gap-1.5 self-start rounded-md border border-line-strong bg-surface px-3 text-xs font-semibold text-text transition-colors hover:bg-surface-sunken"
                  >
                    <ExternalLink className="h-4 w-4" aria-hidden />
                    {active.trace.fix.label}
                  </Link>
                )}
                {active.kind === "field" && active.op === "reveal" && <HintNote>A simulation never reveals a value and never uses a unit of the daily limit. A real reveal happens on the record&apos;s own page, and is logged.</HintNote>}
              </div>
            ) : (
              <p className="px-4 pb-4 text-xs text-subtle">This module has nothing to simulate.</p>
            )}
          </Panel>

          <Panel>
            <PanelHeader title={`Module summary for ${subject.who}`} />
            <div className="flex flex-col gap-1 px-4 pb-3 pt-2">
              {view.summary.map((m) => {
                const open = m.standing !== "none";
                return (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => go(subject, m.key)}
                    className={cn("flex w-full items-center gap-2 rounded-md px-1.5 py-[5px] text-left transition-colors hover:bg-surface-sunken", m.key === view.module.key && "bg-brand-subtle")}
                  >
                    <ToolModuleIcon icon={m.icon} className={cn("h-4 w-4 shrink-0", open ? "text-text/80" : "text-subtle")} />
                    <span className={cn("flex-1 truncate text-[12.5px] font-medium", open ? "text-text" : "text-subtle")}>{m.label}</span>
                    <span className="whitespace-nowrap text-[11.5px] text-subtle">{open ? `${m.allowed}/${m.total} · ${STANDING_WORDS[m.standing]}` : "No access"}</span>
                  </button>
                );
              })}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** What the trace is about, in full: a field's question names its record type and field. */
function tryTitle(t: SimTry, view: SimulatorView): string {
  if (t.kind !== "field") return t.label;
  const entity = view.entities.find((e) => e.entity === t.entity);
  const field = entity?.fields.find((f) => f.key === t.field);
  return `${t.op === "view" ? "View" : t.op === "reveal" ? "Reveal" : "Export"} ${entity?.one ?? ""} ${(field?.label ?? t.field).toLowerCase()}`.replace(/\s+/g, " ");
}

function TryGroup({ title, tries, activeId, onPick, scroll }: { title: string; tries: SimTry[]; activeId: string | undefined; onPick: (id: string) => void; scroll?: boolean }) {
  return (
    <div>
      <div className={cn(subhead, "mb-1.5")}>{title}</div>
      <div className={cn("flex flex-wrap gap-1", scroll && "max-h-[132px] overflow-y-auto")}>
        {tries.map((t) => (
          <TryPill key={t.id} t={t} on={t.id === activeId} onPick={onPick} />
        ))}
      </div>
    </div>
  );
}

/** One question: the dot already says how it ends. */
function TryPill({ t, on, onPick, label }: { t: SimTry; on: boolean; onPick: (id: string) => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={() => onPick(t.id)}
      aria-pressed={on}
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-semibold transition-colors",
        on ? "border-brand bg-brand-subtle text-brand" : "border-line-strong bg-surface text-text/80 hover:bg-surface-sunken",
      )}
    >
      <span className={cn("h-[7px] w-[7px] rounded-full", t.trace.verdict === "allowed" ? "bg-success" : "bg-danger")} aria-hidden />
      {label ?? t.label}
    </button>
  );
}

function TraceStep({ step, final }: { step: SimStep; final: boolean }) {
  const tone = step.verdict === "allowed" ? "text-success" : step.verdict === "denied" ? "text-danger" : "text-subtle";
  const disc = final
    ? step.verdict === "allowed"
      ? "bg-success text-white"
      : "bg-danger text-white"
    : step.verdict === "allowed"
      ? "bg-success-bg text-success"
      : step.verdict === "denied"
        ? "bg-danger-bg text-danger"
        : "bg-surface-sunken text-subtle";
  const Icon = step.verdict === "allowed" ? Check : step.verdict === "denied" ? Ban : Minus;
  return (
    <li className="flex items-start gap-2.5 py-[5px]">
      <span className={cn("mt-px inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full", disc)}>
        <Icon className="h-3 w-3" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className={cn("text-[12.5px]", final ? "font-bold text-text" : step.verdict === "info" ? "text-text/80" : "font-semibold text-text")}>{step.label}</div>
        {step.detail && <div className="text-[11.5px] leading-[1.45] text-subtle">{step.detail}</div>}
      </div>
      {step.value && <span className={cn("whitespace-nowrap pt-0.5 font-mono text-[10.5px] font-semibold", tone)}>{step.value}</span>}
    </li>
  );
}
