"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Building2, ChevronRight, Contact, Eye, EyeOff, Gauge, PanelRight, Save, Search, Shield, ShieldCheck, Target, TriangleAlert, User, type LucideIcon } from "lucide-react";
import { setPersonFieldAccess, setRoleFieldAccess, type FieldAccessRow } from "@/actions/field-access";
import { describePolicy, FIELD_ENTITY_WORDS, type ExportMode, type FieldEntity, type FieldPolicy } from "@/lib/authz/field-policy";
import { acPath } from "@/lib/access-control/nav";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/toast";
import { confirmAction } from "@/components/ui/confirm";
import { Dialog } from "@/components/ui/dialog";
import { AcPage, HintNote, Panel, Pill, acButton, acInput } from "@/components/access-control/ui";
import { FieldMatrix, type BulkColumn } from "@/components/access-control/fields/field-matrix";
import { PreviewPanel, type PreviewTab, type StagedItem } from "@/components/access-control/fields/preview-panel";
import {
  buildRows,
  emptyDraft,
  FIELD_ENTITIES,
  limitWords,
  nextChoice,
  samePolicy,
  type Choice,
  type Draft,
  type EntityAccess,
  type FieldChange,
  type FieldSubject,
  type LimitSummary,
  type MaskingBanner,
  type OwnCaps,
  type RowModel,
  type SubjectOption,
} from "@/components/access-control/fields/model";

const ENTITY_ICON: Record<FieldEntity, LucideIcon> = { leads: Target, contacts: Contact, companies: Building2 };

type Filter = "all" | "pii" | "custom" | "masked" | "restricted" | "own" | "changed";

/** What each record type's "Mask on record" means, and what field access leaves alone — the old editors' notes. */
const ENTITY_HINT: Record<FieldEntity, string | null> = {
  leads: null,
  contacts: "“Mask on record” is a customer's own Contacts tab; “Show” beside a contact unmasks it for the day. Calling and WhatsApp still work on a masked phone: the number is dialled, not shown.",
  companies:
    "“Mask on record” is the company's own page; “Show” there unmasks it for the day. A company's name is never masked: it is the record's identity, the label on every order, ticket, invoice and payment. Invoices and other documents print the address as issued.",
};

/**
 * Settings › Access Control › Field Permissions: pick a role or an employee, pick a record type, and set
 * each answer of each field on its own — View, Mask in list, Mask on record, the mask's format, Unmask and
 * Export — with a live preview of what that subject would then see.
 *
 * Every press stages a change; nothing is written until Save, which sends each record type's changes
 * through the same actions the old editors used (src/actions/field-access.ts). Those check everything
 * again — who may change what, and that nobody gives more of a field than they have themselves.
 */
export function FieldManager({
  subject,
  roles,
  people,
  initialEntity,
  access,
  editable,
  why,
  caps,
  masking,
  limit,
  history,
}: {
  subject: FieldSubject;
  roles: SubjectOption[];
  people: SubjectOption[];
  initialEntity: FieldEntity;
  /** Leads, contacts and companies, in that order. */
  access: EntityAccess[];
  editable: boolean;
  /** Why nothing can be changed, in the server's words. */
  why: string | null;
  caps: OwnCaps;
  masking: MaskingBanner;
  limit: LimitSummary;
  history: FieldChange[];
}) {
  const router = useRouter();
  const [entity, setEntityState] = useState<FieldEntity>(initialEntity);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [tab, setTab] = useState<PreviewTab>("preview");
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [showPreview, setShowPreview] = useState(true);
  const [saveOpen, setSaveOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const [pending, start] = useTransition();

  /**
   * What was just saved, until the page brings it back: the stored answers are read on the server, and a
   * saved switch would otherwise flick back to its old place while the refresh is on its way. Tied to the
   * answers it was saved over, so it is dropped the moment different ones arrive.
   */
  const version = useMemo(() => JSON.stringify(access.map((a) => a.rows.map((r) => r.stored))), [access]);
  const [committed, setCommitted] = useState<{ version: string; values: Draft } | null>(null);
  const current = useMemo(() => {
    const live = committed && committed.version === version ? committed.values : null;
    const byEntity = {} as Record<FieldEntity, EntityAccess>;
    for (const a of access) {
      const done = live?.[a.entity] ?? {};
      byEntity[a.entity] = {
        ...a,
        rows: a.rows.map((r): FieldAccessRow => (Object.prototype.hasOwnProperty.call(done, r.key) ? { ...r, stored: done[r.key]!, why: "Saved just now." } : r)),
      };
    }
    return byEntity;
  }, [access, committed, version]);

  const superAdmin = subject.type === "user" && subject.superAdmin;
  const canEdit = editable && !superAdmin;
  const models = useMemo(() => {
    const out = {} as Record<FieldEntity, RowModel[]>;
    for (const e of FIELD_ENTITIES) out[e] = current[e] ? buildRows(current[e], draft[e], caps, superAdmin) : [];
    return out;
  }, [current, draft, caps, superAdmin]);

  const rows = models[entity];
  const words = FIELD_ENTITY_WORDS[entity];
  const stagedByEntity = FIELD_ENTITIES.map((e) => ({ entity: e, rows: models[e].filter((m) => m.staged) }));
  const stagedCount = stagedByEntity.reduce((n, s) => n + s.rows.length, 0);
  const exceeding = stagedByEntity.reduce((n, s) => n + s.rows.filter((m) => m.exceeds).length, 0);
  const clean = stagedCount === 0;
  const subjectLink = subject.type === "role" ? { role: subject.id } : { user: subject.id };

  // Leaving the page with staged changes: the browser asks first.
  useEffect(() => {
    if (clean) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [clean]);

  const setEntity = (next: FieldEntity) => {
    setEntityState(next);
    setSelected(null);
    // The address follows, so a refresh or a copied link opens the same record type; nothing is fetched.
    window.history.replaceState(null, "", acPath.fields({ ...subjectLink, entity: next }));
  };

  /** Another role or person is another page: staged changes don't follow, so it asks first. */
  const leave = async (href: string) => {
    if (
      !clean &&
      !(await confirmAction({
        title: "Discard staged changes?",
        message: `Switching subject drops the ${stagedCount} unsaved ${stagedCount === 1 ? "change" : "changes"} on this screen.`,
        confirmLabel: "Discard",
        danger: true,
      }))
    )
      return;
    router.push(href);
  };

  const stage = (changes: { row: FieldAccessRow; choice: Choice }[]) => {
    if (changes.length === 0) return;
    setDraft((prev) => {
      const next = { ...prev[entity] };
      for (const { row, choice } of changes) {
        if (samePolicy(choice, row.stored)) delete next[row.key];
        else next[row.key] = choice;
      }
      return { ...prev, [entity]: next };
    });
  };
  const edit = (row: FieldAccessRow, policy: FieldPolicy, patch: Partial<FieldPolicy>) => stage([{ row, choice: nextChoice(row, policy, patch) }]);
  const undo = (e: FieldEntity, key: string) =>
    setDraft((prev) => {
      const next = { ...prev[e] };
      delete next[key];
      return { ...prev, [e]: next };
    });

  // ─── Search and filters ───────────────────────────────────────────────────────────────────────

  const passes: Record<Filter, (m: RowModel) => boolean> = {
    all: () => true,
    pii: (m) => m.pii,
    custom: (m) => m.row.custom,
    masked: (m) => m.policy.view && (m.policy.maskInList || m.policy.maskInDetail),
    restricted: (m) => !m.policy.view,
    own: (m) => m.own,
    changed: (m) => m.staged,
  };
  const filters: [Filter, string][] = [
    ["all", "All"],
    ["pii", "PII"],
    ["custom", "Custom"],
    ["masked", "Masked"],
    ["restricted", "Restricted"],
    ["own", subject.type === "role" ? "Set on role" : "Overridden"],
    ["changed", "Changed"],
  ];
  const query = q.trim().toLowerCase();
  const visible = rows.filter((m) => passes[filter](m) && (!query || m.row.label.toLowerCase().includes(query) || m.row.key.toLowerCase().includes(query) || m.row.description.toLowerCase().includes(query)));

  // ─── Whole-column actions, on the fields listed ───────────────────────────────────────────────

  const bulk = (column: BulkColumn, on: boolean) => {
    const changes: { row: FieldAccessRow; choice: Choice }[] = [];
    let skipped = 0;
    for (const m of visible) {
      const p = m.policy;
      if (column === "view") {
        if (p.view !== on) changes.push({ row: m.row, choice: nextChoice(m.row, p, { view: on }) });
        continue;
      }
      // Nothing to mask on a field that can't be read, and nothing to unmask on one that isn't masked.
      const applies = p.view && (column !== "unmask" || !on || p.maskInList || p.maskInDetail);
      if (!applies) {
        if (on) skipped += 1;
        continue;
      }
      if (p[column] !== on) changes.push({ row: m.row, choice: nextChoice(m.row, p, { [column]: on }) });
    }
    stage(changes);
    if (skipped) toast.info(column === "unmask" ? `${skipped} ${skipped === 1 ? "field" : "fields"} skipped: nothing is masked on ${skipped === 1 ? "it" : "them"}.` : `${skipped} ${skipped === 1 ? "field" : "fields"} skipped: restricted, so there is nothing to mask.`);
  };
  const bulkExport = (mode: ExportMode | null) => {
    const readable = visible.filter((m) => m.policy.view);
    stage(readable.filter((m) => m.policy.export !== mode).map((m) => ({ row: m.row, choice: nextChoice(m.row, m.policy, { export: mode }) })));
    if (readable.length < visible.length) toast.info(`${visible.length - readable.length} restricted ${visible.length - readable.length === 1 ? "field" : "fields"} skipped.`);
  };

  // ─── Saving ───────────────────────────────────────────────────────────────────────────────────

  const nothingSet = (e: FieldEntity, m: RowModel) => (subject.type === "role" ? "visible (nothing set)" : `as their role: ${describePolicy(m.row.inherited, e)}`);
  const staged: StagedItem[] = stagedByEntity.flatMap((s) =>
    s.rows.map((m) => ({
      entity: s.entity,
      key: m.row.key,
      label: m.row.label,
      from: m.row.stored ? describePolicy(m.row.stored, s.entity) : nothingSet(s.entity, m),
      to: m.choice ? describePolicy(m.choice, s.entity) : nothingSet(s.entity, m),
      exceeds: m.exceeds,
    })),
  );

  const save = (options: { reason?: string; expiresAt?: string | null } = {}) =>
    start(async () => {
      let changed = 0;
      const errors: string[] = [];
      const done = emptyDraft();
      for (const s of stagedByEntity) {
        if (s.rows.length === 0) continue;
        const changes = s.rows.map((m) => ({ field: m.row.key, policy: m.choice }));
        const result = subject.type === "role" ? await setRoleFieldAccess(subject.id, changes, s.entity) : await setPersonFieldAccess(subject.id, changes, options, s.entity);
        if (!result.ok) {
          errors.push(`${FIELD_ENTITY_WORDS[s.entity].title}: ${result.error}`);
          continue;
        }
        changed += result.data.changed;
        for (const c of changes) done[s.entity][c.field] = c.policy;
      }
      setCommitted((prev) => {
        const base = prev && prev.version === version ? prev.values : emptyDraft();
        return { version, values: { leads: { ...base.leads, ...done.leads }, contacts: { ...base.contacts, ...done.contacts }, companies: { ...base.companies, ...done.companies } } };
      });
      setDraft((prev) => {
        const next = emptyDraft();
        for (const e of FIELD_ENTITIES) for (const [key, choice] of Object.entries(prev[e])) if (!Object.prototype.hasOwnProperty.call(done[e], key)) next[e][key] = choice;
        return next;
      });
      for (const error of errors) toast.error(error);
      if (errors.length === 0) {
        setSaveOpen(false);
        setReason("");
        setUntil("");
        if (changed > 0) toast.success(`${changed} field ${changed === 1 ? "permission" : "permissions"} saved for ${subject.name}.`);
        else toast.info("Nothing to save.");
      } else if (changed > 0) {
        toast.info(`${changed} field ${changed === 1 ? "permission" : "permissions"} saved; the rest are still staged.`);
      }
      router.refresh();
    });

  const pressSave = () => {
    if (clean || pending) return;
    if (exceeding > 0) {
      toast.error(
        `${exceeding} staged ${exceeding === 1 ? "change gives" : "changes give"} more of a field than you have yourself. Narrow ${exceeding === 1 ? "it" : "them"} or undo ${exceeding === 1 ? "it" : "them"} first.`,
      );
      setTab("summary");
      return;
    }
    if (subject.type === "user") setSaveOpen(true);
    else save();
  };
  const saveLabel = subject.type === "role" ? "Save changes" : "Save as overrides";

  const limitSaid = limitWords(limit);
  const limitTone = limit.kind === "user" && limit.remaining !== null ? (limit.remaining === 0 ? "bg-danger-bg text-danger" : limit.limit && limit.used / limit.limit >= 0.8 ? "bg-warning-bg text-warning" : "bg-success-bg text-success") : "bg-surface-sunken text-text/80";

  return (
    <AcPage
      crumb="Field Permissions"
      title="Field-Level Permission Manager"
      description="Control View, Mask, Unmask and Export for every field, independently. Works the same for built-in and custom fields."
      actions={
        canEdit ? (
          <>
            {!clean && (
              <button type="button" onClick={() => setTab("summary")} title="See what is staged" className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-subtle px-2.5 text-xs font-semibold text-brand">
                <span className="h-2 w-2 rounded-full bg-surface ring-2 ring-brand/40" aria-hidden />
                {stagedCount} staged
              </button>
            )}
            <button type="button" onClick={() => setDraft(emptyDraft())} disabled={clean || pending} className={acButton.secondary}>
              Reset
            </button>
            <button type="button" onClick={pressSave} disabled={clean || pending} className={acButton.primary}>
              <Save className="h-[18px] w-[18px]" aria-hidden />
              {pending ? "Saving…" : saveLabel}
            </button>
          </>
        ) : (
          <Pill>
            <Eye className="h-3.5 w-3.5" aria-hidden />
            Read-only
          </Pill>
        )
      }
    >
      <div className="@container flex flex-col gap-3.5">
        {/* The workspace's master switch: these rules mask nothing while it is off. */}
        <div className={cn("flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-lg border px-3.5 py-2.5 text-[12.5px] leading-[1.5]", masking.enabled ? "border-line bg-surface text-text/80" : "border-warning/40 bg-warning-bg text-warning")}>
          {masking.enabled ? <ShieldCheck className="h-[18px] w-[18px] shrink-0 text-success" aria-hidden /> : <EyeOff className="h-5 w-5 shrink-0" aria-hidden />}
          <span className="min-w-[220px] flex-1">
            {masking.enabled ? (
              <>
                <b className="font-semibold text-text">Field masking is on.</b> The rules here apply across the workspace: a masked value stays masked until it is unmasked, within each person&apos;s daily limit.
              </>
            ) : (
              <>
                <b className="font-bold">Field masking is switched off for the whole workspace.</b> Masked fields show in the clear and there is nothing to unmask; fields somebody may not see at all stay hidden. The rules here are
                kept and apply again when it is switched back on.
              </>
            )}
            {masking.changedAtText && (
              <span className={cn("ml-1.5 text-[11.5px]", masking.enabled ? "text-subtle" : "opacity-80")}>
                Last changed {masking.changedBy ? `by ${masking.changedBy}, ` : ""}
                {masking.changedAtText}.
              </span>
            )}
          </span>
          <Link
            href={acPath.masking()}
            className={cn("inline-flex h-7 items-center whitespace-nowrap rounded-md border bg-surface px-2.5 text-xs font-semibold", masking.enabled ? "border-line-strong text-text hover:bg-surface-sunken" : "border-warning/60 text-warning")}
          >
            Global PII Masking
          </Link>
        </div>

        <Panel className="flex flex-wrap items-center gap-2 overflow-visible px-3 py-2.5">
          <div className="inline-flex overflow-hidden rounded-md border border-line-strong">
            <button
              type="button"
              aria-pressed={subject.type === "role"}
              disabled={roles.length === 0}
              onClick={() => subject.type !== "role" && roles[0] && leave(acPath.fields({ role: (roles.find((r) => r.id === subject.roleKey) ?? roles[0]).id, entity }))}
              className={cn("inline-flex h-[30px] items-center gap-[5px] px-2.5 text-xs font-semibold", subject.type === "role" ? "bg-brand-subtle text-brand" : "bg-surface text-text/80 hover:bg-surface-sunken")}
            >
              <Shield className="h-4 w-4" aria-hidden />
              Role
            </button>
            <button
              type="button"
              aria-pressed={subject.type === "user"}
              disabled={people.length === 0}
              onClick={() => subject.type !== "user" && people[0] && leave(acPath.fields({ user: (subject.holders[0] ?? people[0]).id, entity }))}
              className={cn("inline-flex h-[30px] items-center gap-[5px] border-l border-line-strong px-2.5 text-xs font-semibold", subject.type === "user" ? "bg-brand-subtle text-brand" : "bg-surface text-text/80 hover:bg-surface-sunken")}
            >
              <User className="h-4 w-4" aria-hidden />
              Employee
            </button>
          </div>
          <select
            aria-label={subject.type === "role" ? "Role" : "Employee"}
            value={subject.id}
            onChange={(e) => leave(acPath.fields(subject.type === "role" ? { role: e.target.value, entity } : { user: e.target.value, entity }))}
            className="h-8 min-w-[190px] max-w-[260px] rounded-md border border-line-strong bg-surface px-2 text-[13px] font-semibold outline-none focus:border-brand"
          >
            {(subject.type === "role" ? roles : people).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
                {o.hint ? ` · ${o.hint}` : ""}
              </option>
            ))}
          </select>
          <ChevronRight className="h-[18px] w-[18px] text-subtle" aria-hidden />
          <span className="text-[13px] font-semibold">{words.title}</span>
          <label className="relative">
            <span className="sr-only">Find a field</span>
            <Search className="pointer-events-none absolute left-2 top-[7px] h-[18px] w-[18px] text-subtle" aria-hidden />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a field" className={cn(acInput, "w-[170px] pl-[30px]")} />
          </label>
          <div className="flex flex-wrap gap-1">
            {filters.map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
                className={cn(
                  "inline-flex h-[26px] items-center gap-1 rounded-full border px-2.5 text-xs font-semibold transition-colors",
                  filter === key ? "border-brand bg-brand-subtle text-brand" : "border-line-strong bg-surface text-text/80 hover:bg-surface-sunken",
                )}
              >
                {label}
                <span className="font-medium opacity-70">{rows.filter(passes[key]).length}</span>
              </button>
            ))}
          </div>
          <div className="flex-1" />
          <Link href={acPath.limits()} title={`Daily unmask limit. ${limitSaid.full}`} className={cn("inline-flex h-[26px] items-center gap-1 whitespace-nowrap rounded-full px-2.5 text-[11px] font-bold", limitTone)}>
            <Gauge className="h-[13px] w-[13px]" aria-hidden />
            {limitSaid.short}
          </Link>
          <button
            type="button"
            aria-pressed={showPreview}
            title={showPreview ? "Hide the preview" : "Show the preview"}
            aria-label={showPreview ? "Hide the preview" : "Show the preview"}
            onClick={() => setShowPreview((v) => !v)}
            className={cn("inline-flex h-[30px] w-8 items-center justify-center rounded-md border border-line-strong", showPreview ? "bg-brand-subtle text-brand" : "bg-surface text-text/80 hover:bg-surface-sunken")}
          >
            <PanelRight className="h-[18px] w-[18px]" aria-hidden />
          </button>
        </Panel>

        {!canEdit && (
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-sunken/60 px-3.5 py-2.5 text-[12.5px] text-muted">
            <Eye className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
            {why ?? (superAdmin ? "A super admin sees every field and has no limit; there is nothing to set." : "You can review field permissions but not change them.")}
          </div>
        )}
        {subject.type === "user" && subject.inactive && !superAdmin && (
          <div className="flex items-start gap-2.5 rounded-lg bg-warning-bg px-3.5 py-2.5 text-[12.5px] leading-[1.5] text-warning">
            <TriangleAlert className="mt-px h-5 w-5 shrink-0" aria-hidden />
            <span>
              <b className="font-bold">{subject.name}</b>&apos;s account or role is switched off, so nothing is readable for them right now. The field rules are kept and apply as soon as it is switched back on.
            </span>
          </div>
        )}
        {current[entity]?.warnings.length ? (
          <div className="flex items-start gap-2.5 rounded-lg bg-warning-bg px-3.5 py-2.5 text-[12.5px] leading-[1.5] text-warning">
            <TriangleAlert className="mt-px h-5 w-5 shrink-0" aria-hidden />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {current[entity].warnings.map((w) => (
                <p key={w}>{w}</p>
              ))}
            </div>
            <Link href={acPath.scope(subjectLink)} className="inline-flex h-7 items-center whitespace-nowrap rounded-md border border-warning/60 bg-surface px-2.5 text-xs font-semibold text-warning">
              Open Data Scope
            </Link>
          </div>
        ) : null}
        {ENTITY_HINT[entity] && <HintNote>{ENTITY_HINT[entity]}</HintNote>}

        <div
          className={cn(
            "grid grid-cols-1 items-start gap-4",
            showPreview ? "@min-[960px]:grid-cols-[minmax(0,1fr)_280px] @min-[1300px]:grid-cols-[176px_minmax(0,1fr)_320px]" : "@min-[1300px]:grid-cols-[176px_minmax(0,1fr)]",
          )}
        >
          <nav aria-label="Record type" className={cn("flex min-w-0 gap-2 @min-[1300px]:flex-col", showPreview && "@min-[960px]:col-span-2 @min-[1300px]:col-span-1")}>
            {FIELD_ENTITIES.map((e) => {
              const Icon = ENTITY_ICON[e];
              const list = models[e];
              const on = e === entity;
              const maskedCount = list.filter(passes.masked).length;
              const restrictedCount = list.filter(passes.restricted).length;
              const stagedHere = list.filter(passes.changed).length;
              return (
                <button
                  key={e}
                  type="button"
                  aria-current={on ? "true" : undefined}
                  onClick={() => setEntity(e)}
                  className={cn(
                    "flex min-w-0 flex-1 items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors @min-[1300px]:flex-none",
                    on ? "border-brand bg-brand-subtle" : "border-line bg-surface hover:border-line-strong",
                  )}
                >
                  <Icon className={cn("mt-px h-[18px] w-[18px] shrink-0", on ? "text-brand" : "text-muted")} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className={cn("flex items-center gap-1.5 font-semibold", on ? "text-brand" : "text-text")}>
                      <span className="truncate">{FIELD_ENTITY_WORDS[e].title}</span>
                      {stagedHere > 0 && (
                        <span title={`${stagedHere} staged`} className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold text-brand-contrast">
                          {stagedHere}
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-[11px] text-muted">
                      {list.length} {list.length === 1 ? "field" : "fields"}
                      {maskedCount ? ` · ${maskedCount} masked` : ""}
                      {restrictedCount ? ` · ${restrictedCount} restricted` : ""}
                    </span>
                  </span>
                </button>
              );
            })}
          </nav>

          <FieldMatrix
            entity={entity}
            subjectType={subject.type}
            rows={visible}
            total={rows.length}
            query={q.trim()}
            selected={selected}
            editable={canEdit}
            collapsed={collapsed}
            onCollapse={(g) => setCollapsed((c) => ({ ...c, [g]: !c[g] }))}
            onSelect={(key) => {
              setSelected(key);
              setTab("field");
              setShowPreview(true);
            }}
            onEdit={edit}
            onReset={(row) => stage([{ row, choice: null }])}
            onBulk={bulk}
            onBulkExport={bulkExport}
          />

          {showPreview && (
            <PreviewPanel
              className="min-w-0 @min-[960px]:sticky @min-[960px]:top-[4.5rem]"
              entity={entity}
              subject={subject}
              rows={rows}
              selected={selected}
              tab={tab}
              onTab={setTab}
              onSelect={(key) => {
                setSelected(key);
                setTab("field");
              }}
              maskingOn={masking.enabled}
              limit={limit}
              history={history.filter((h) => h.entity === entity)}
              staged={staged}
              onUndo={undo}
            />
          )}
        </div>

        {/* Staged changes follow the page down: a long matrix never hides Save. */}
        {canEdit && !clean && (
          <div className="sticky bottom-3 z-10 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line-strong bg-surface px-3.5 py-2.5 shadow-lg">
            <span className="h-2 w-2 shrink-0 rounded-full bg-brand ring-2 ring-brand/30" aria-hidden />
            <span className="min-w-[200px] flex-1 text-[12.5px]">
              <b className="font-semibold">
                {stagedCount} staged {stagedCount === 1 ? "change" : "changes"}
              </b>{" "}
              <span className="text-muted">
                for {subject.name} ·{" "}
                {stagedByEntity
                  .filter((s) => s.rows.length > 0)
                  .map((s) => `${FIELD_ENTITY_WORDS[s.entity].title} ${s.rows.length}`)
                  .join(" · ")}
                . Nothing applies until you save.
              </span>
              {exceeding > 0 && (
                <span className="mt-0.5 flex items-center gap-1 text-xs font-medium text-warning">
                  <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  {exceeding} {exceeding === 1 ? "gives" : "give"} more of a field than you have yourself and can&apos;t be saved.
                </span>
              )}
            </span>
            <button type="button" onClick={() => setDraft(emptyDraft())} disabled={pending} className={acButton.secondary}>
              Discard
            </button>
            <button type="button" onClick={pressSave} disabled={pending} className={acButton.primary}>
              <Save className="h-[18px] w-[18px]" aria-hidden />
              {pending ? "Saving…" : saveLabel}
            </button>
          </div>
        )}
      </div>

      {saveOpen && subject.type === "user" && (
        <Dialog open onClose={() => !pending && setSaveOpen(false)} title="Save as employee overrides">
          <div className="flex flex-col gap-3 text-[13px]">
            <p className="text-xs leading-[1.5] text-muted">
              {stagedCount === 1 ? "This change applies" : `These ${stagedCount} changes apply`} only to {subject.name}, on top of their role ({subject.roleName}). Each is written to the permission history with your reason. An end
              date makes them temporary.
            </p>
            <div className="flex flex-col gap-1">
              <label htmlFor="field-override-reason" className="text-xs font-semibold text-text/80">
                Reason (optional)
              </label>
              <textarea
                id="field-override-reason"
                rows={2}
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why does this person need an exception?"
                className="resize-y rounded-md border border-line-strong bg-surface px-2.5 py-2 text-[13px] leading-[1.5] text-text outline-none placeholder:text-subtle focus:border-brand"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="field-override-until" className="text-xs font-semibold text-text/80">
                Until (optional)
              </label>
              <input id="field-override-until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} className={cn(acInput, "w-48")} />
              <span className="text-[11px] text-subtle">{until ? "Their own answers end after that day; their role's apply again." : "No end date: a permanent exception."} Fields put back to their role need neither.</span>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setSaveOpen(false)} disabled={pending} className={acButton.secondary}>
                Cancel
              </button>
              <button type="button" onClick={() => save({ reason: reason.trim() || undefined, expiresAt: until || null })} disabled={pending} className={acButton.primary}>
                {pending ? "Saving…" : "Save overrides"}
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </AcPage>
  );
}
