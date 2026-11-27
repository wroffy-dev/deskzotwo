"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Banknote,
  Building2,
  Contact,
  FileText,
  FolderKanban,
  LifeBuoy,
  ListChecks,
  MapPin,
  MessageSquareQuote,
  PhoneCall,
  Receipt,
  ShoppingBag,
  Target,
  TriangleAlert,
  Truck,
  type LucideIcon,
} from "lucide-react";
import type { AccessLevel } from "@prisma/client";
import { setRoleAccessLevels } from "@/actions/access-levels";
import { setPersonAccessLevels } from "@/actions/person-access";
import type { AccessAction } from "@/lib/authz/access";
import { LEVEL_WORDS } from "@/lib/authz/level-order";
import { ACCESS_MODULES } from "@/lib/staff/access-modules";
import { acPath } from "@/lib/access-control/nav";
import { toast } from "@/components/ui/toast";
import { AcPage, EmptyNote, HintNote, Panel, PanelHeader, Pill, acButton, panelLinkClass, tdClass, thClass } from "@/components/access-control/ui";
import { ChoiceMenu, LevelChip, LevelTag, LockNote, ReachLegend, type Choice, type OpenMenu } from "@/components/access-control/scope/chips";
import { inheritLabel, levelChoices, widerThanWhy } from "@/components/access-control/scope/level-choices";
import { ACTION_LABEL, LEVEL_ORDER, REACH_ACTIONS, levelMeans, reachSentence, type ReachRow, type SaveOptions, type Subject } from "@/components/access-control/scope/reach";
import { OverrideDialog, StagedActions, StickySaveBar, useLeaveGuard } from "@/components/access-control/scope/save-bar";
import { SubjectBar, type PersonOption, type RoleOption } from "@/components/access-control/scope/subject-bar";
import { useReachDraft } from "@/components/access-control/scope/use-reach-draft";
import { cn } from "@/lib/utils";
import { LeadReachBox } from "@/components/access-control/scope/lead-reach-box";
import type { LeadReachView } from "@/lib/authz/lead-reach-words";

const RECORD_ICON: Record<string, LucideIcon> = {
  companies: Building2,
  vendors: Truck,
  contacts: Contact,
  leads: Target,
  orders: ShoppingBag,
  documents: FileText,
  payments: Banknote,
  tickets: LifeBuoy,
  projects: FolderKanban,
  visits: MapPin,
  activities: PhoneCall,
  tasks: ListChecks,
  expenses: Receipt,
};

/** The permission that opens a record type's pages at all, and whether the subject holds it. */
export type OpensWith = { label: string; held: boolean };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Settings › Access Control › Data Scope: for a role or one person, which records each action reaches
 * — per record type, View, Edit, Delete and Assign each at one of the levels that record type offers.
 *
 * The design's scope-type tiles are Deskzo's levels (None, Own, Team, Branch, All, As the account) and
 * "follow what is underneath": a role's permissions, a person's role. What is stored and what is
 * derived are shown side by side, and the sentence says the choice in plain words. Staged, then saved
 * through `setRoleAccessLevels` / `setPersonAccessLevels`, which hold every rule: only the levels a
 * record offers, nothing wider than the admin reaches, edit never wider than view.
 */
export function DataScope({
  subject,
  roles,
  people,
  meta,
  reach,
  reachLock,
  opens,
  initialRecord,
  leadReach = null,
}: {
  subject: Subject;
  roles: RoleOption[];
  people: PersonOption[];
  meta: string;
  reach: ReachRow[];
  /** Why the grid can't be changed by this viewer — the server's own reason — or null. */
  reachLock: string | null;
  opens: Record<string, OpensWith>;
  initialRecord?: string;
  /** Data Scope's two ticks under Leads "as the account" (src/lib/authz/lead-reach.ts). */
  leadReach?: LeadReachView | null;
}) {
  const router = useRouter();
  const isUser = subject.type === "user";
  const [recordKey, setRecordKey] = useState<string>(() => (reach.some((r) => r.key === initialRecord) ? initialRecord! : (reach.find((r) => r.key === "leads")?.key ?? reach[0]?.key ?? "")));
  const [picked, setPicked] = useState<AccessAction>("view");
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  /** Saving for a person asks for a reason first: everything staged, or one record's changes. */
  const [asking, setAsking] = useState<{ record?: string } | null>(null);
  const [saving, start] = useTransition();
  const draft = useReachDraft(reach);

  const rowOf = useMemo(() => new Map(reach.map((r) => [r.key as string, r])), [reach]);
  // The record types module by module, as the rest of Access Control groups them; anything unfiled last.
  const groups = useMemo(() => {
    const filed = new Set<string>();
    const out = ACCESS_MODULES.flatMap((m) => {
      const rows = m.records.flatMap((r) => (rowOf.has(r) ? [rowOf.get(r)!] : []));
      rows.forEach((r) => filed.add(r.key));
      return rows.length ? [{ name: m.label, rows }] : [];
    });
    const rest = reach.filter((r) => !filed.has(r.key));
    return rest.length ? [...out, { name: "Other", rows: rest }] : out;
  }, [reach, rowOf]);

  const staged = draft.changes.length;
  useLeaveGuard(staged > 0);
  const saveLabel = isUser ? "Save as overrides" : "Save changes";
  const who = subject.type === "role" ? `People in ${subject.name}` : subject.name;
  const subjectParams = subject.type === "role" ? { role: subject.key } : { user: subject.id };
  const stagedOn = (record: string) => draft.changes.filter((c) => c.record === record).length;

  const save = (options: SaveOptions = {}, record?: string) =>
    start(async () => {
      const changes = record ? draft.changes.filter((c) => c.record === record) : draft.changes;
      if (changes.length === 0) return;
      const r = subject.type === "role" ? await setRoleAccessLevels(subject.key, changes) : await setPersonAccessLevels(subject.id, changes, options);
      if (!r.ok) {
        toast.error(r.error);
        router.refresh();
        return;
      }
      toast.success(record ? `Scope for ${rowOf.get(record)?.label ?? record} saved${subject.type === "user" ? ` as overrides for ${subject.name}` : ""}` : `${plural(changes.length, "change")} saved${subject.type === "user" ? ` as overrides for ${subject.name}` : ""}`);
      start(() => {
        setAsking(null);
        draft.reset(record);
        router.refresh();
      });
    });
  const onSave = (record?: string) => (isUser ? setAsking({ record }) : save({}, record));

  const openMenu = (anchor: HTMLElement, title: string, choices: Choice[]) => setMenu((m) => (m?.anchor === anchor ? null : { anchor, title, choices }));

  const row = rowOf.get(recordKey) ?? reach[0];
  const action: AccessAction = row && row.actions.includes(picked) ? picked : "view";

  return (
    <AcPage
      crumb="Data Scope"
      title="Data Scope Management"
      description="Permissions decide what a role can do. Scope decides which records it can do it on."
      actions={<StagedActions count={staged} saving={saving} saveLabel={saveLabel} canSave={reachLock === null} onReset={() => draft.reset()} onSave={() => onSave()} />}
    >
      <div className="flex flex-col gap-3.5">
        <SubjectBar subject={subject} roles={roles} people={people} hrefFor={acPath.scope} staged={staged} meta={meta}>
          <ReachLegend inheritedMeans={isUser ? "Nothing set for them alone: it comes from their role." : "No level set on the role: it follows the role's permissions."} />
        </SubjectBar>

        {reachLock && <LockNote>{reachLock}</LockNote>}

        {!row ? (
          <Panel>
            <EmptyNote>{isUser ? "This person's record access can't be read." : "This role's records can't be read."}</EmptyNote>
          </Panel>
        ) : (
          <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[260px_minmax(0,1fr)]">
            {/* Record types, module by module */}
            <Panel>
              {groups.map((g) => (
                <div key={g.name}>
                  <div className="px-3 pb-1 pt-2 text-[11px] font-bold uppercase tracking-[0.04em] text-subtle">{g.name}</div>
                  {g.rows.map((r) => {
                    const Icon = RECORD_ICON[r.key] ?? FileText;
                    const active = r.key === row.key;
                    const dirty = stagedOn(r.key) > 0;
                    const view = draft.levelOf(r, "view");
                    const closed = view === "NONE" || opens[r.key]?.held === false;
                    const source = draft.setOf(r, "view") !== null ? (isUser ? " · their own" : "") : isUser ? " · from role" : " · from permissions";
                    return (
                      <button
                        key={r.key}
                        type="button"
                        aria-current={active ? "true" : undefined}
                        onClick={() => {
                          setRecordKey(r.key);
                          setMenu(null);
                        }}
                        className={cn(
                          "flex w-full items-center gap-2.5 border-l-[3px] px-3 py-2 text-left transition-colors",
                          active ? "border-brand bg-brand-subtle" : "border-transparent hover:bg-surface-sunken",
                          closed && "opacity-55",
                        )}
                      >
                        <Icon className="h-[18px] w-[18px] shrink-0 text-muted" strokeWidth={1.75} aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-semibold text-text">{r.label}</span>
                          <span className={cn("block truncate text-[11.5px]", dirty ? "text-brand" : "text-subtle")}>
                            {LEVEL_WORDS[view]}
                            {source}
                          </span>
                        </span>
                        {dirty && <span className="h-2 w-2 shrink-0 rounded-full bg-brand" title="Staged changes" />}
                      </button>
                    );
                  })}
                </div>
              ))}
            </Panel>

            <div className="flex min-w-0 flex-col gap-3.5">
              <RecordScope
                key={row.key}
                row={row}
                action={action}
                onAction={setPicked}
                subject={subject}
                who={who}
                opens={opens[row.key] ?? null}
                modulesHref={acPath.modules(subjectParams)}
                draft={draft}
                locked={reachLock !== null}
                saving={saving}
                staged={stagedOn(row.key)}
                onReset={() => draft.reset(row.key)}
                onSave={() => onSave(row.key)}
                leadReach={leadReach}
              />

              {/* Stored against derived, action by action */}
              <Panel>
                <PanelHeader title={`${row.label} · what is stored, and what is underneath`} />
                <div className="overflow-auto">
                  <table className="w-full min-w-[640px] border-collapse">
                    <thead>
                      <tr>
                        {["Action", "Applies", isUser ? "Set for them" : "Set on this role", isUser ? "Their role's" : "From its permissions", "Why"].map((h) => (
                          <th key={h} className={thClass}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {row.actions.map((a) => {
                        const cell = row.cells[a];
                        const set = draft.setOf(row, a);
                        const changed = draft.isChanged(row, a);
                        return (
                          <tr key={a} onClick={() => setPicked(a)} className={cn("cursor-pointer transition-colors", a === action ? "bg-brand-subtle" : "hover:bg-surface-sunken/60")}>
                            <td className={cn(tdClass, "font-medium text-text")}>{ACTION_LABEL[a]}</td>
                            <td className={tdClass}>
                              <LevelTag level={draft.levelOf(row, a)} dashed={set === null} staged={changed} />
                            </td>
                            <td className={tdClass}>{set === null ? <span className="text-subtle">—</span> : <LevelTag level={set} />}</td>
                            <td className={tdClass}>
                              <LevelTag level={cell.base} dashed />
                            </td>
                            <td className={cn(tdClass, "text-xs text-muted")}>{changed ? "After you save." : cell.why}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Panel>

              {/* Every record type at once */}
              <Panel>
                <PanelHeader title="All record types" meta={<span className="text-xs text-subtle">Click a cell to open it above; right-click to pick a level</span>} />
                <div className="overflow-auto">
                  <table className="w-full min-w-[640px] border-collapse">
                    <thead>
                      <tr>
                        <th className={thClass}>Records</th>
                        {REACH_ACTIONS.map((a) => (
                          <th key={a} className={cn(thClass, "text-center")}>
                            {ACTION_LABEL[a]}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {reach.map((r) => (
                        <tr key={r.key} className={cn("transition-colors", r.key === row.key ? "bg-surface-sunken/60" : "hover:bg-surface-sunken/60")}>
                          <td className={tdClass}>
                            <span className="block font-medium text-text">{r.label}</span>
                            <span className="block text-[11.5px] text-subtle">{r.ownMeans.startsWith("—") ? r.ownMeans.replace(/^—\s*/, "") : `Own: ${r.ownMeans}`}</span>
                          </td>
                          {REACH_ACTIONS.map((a) => {
                            const cell = r.cells[a];
                            if (cell.absent || !r.actions.includes(a)) {
                              return (
                                <td key={a} className={cn(tdClass, "text-center text-subtle")} title="Not an action this record has.">
                                  —
                                </td>
                              );
                            }
                            const level = draft.levelOf(r, a);
                            const changed = draft.isChanged(r, a);
                            return (
                              <td key={a} className={cn(tdClass, "text-center")}>
                                <LevelChip
                                  level={level}
                                  dashed={draft.setOf(r, a) === null}
                                  staged={changed}
                                  className={cn(r.key === row.key && a === action && "outline outline-2 outline-offset-1 outline-brand")}
                                  ariaLabel={`${r.label}, ${ACTION_LABEL[a]}: ${LEVEL_WORDS[level]}`}
                                  title={`${LEVEL_WORDS[level]} — ${levelMeans(level, r.ownMeans)} · ${changed ? "After you save." : cell.why}`}
                                  onClick={() => {
                                    setRecordKey(r.key);
                                    setPicked(a);
                                  }}
                                  onMenu={reachLock === null ? (anchor) => openMenu(anchor, `${r.label} › ${ACTION_LABEL[a]}`, levelChoices(draft, r, a, isUser)) : undefined}
                                />
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>

              <HintNote>
                Scope is checked after the permission: somebody allowed to edit leads edits only the leads their Edit scope reaches, and never more than they can view. Until a level is set, every
                answer is the one {isUser ? "their role gives" : "the role's permissions have always given"} — dashed on this screen.
              </HintNote>
            </div>
          </div>
        )}
      </div>

      <StickySaveBar count={staged} saving={saving} saveLabel={saveLabel} onDiscard={() => draft.reset()} onSave={() => onSave()} />
      <ChoiceMenu menu={menu} onClose={() => setMenu(null)} />
      {subject.type === "user" && (
        <OverrideDialog
          open={asking !== null}
          count={asking?.record ? stagedOn(asking.record) : staged}
          name={subject.name}
          saving={saving}
          onClose={() => setAsking(null)}
          onConfirm={(options) => save(options, asking?.record)}
        />
      )}
    </AcPage>
  );
}

/** One record type: the action being set, its scope as tiles, and the choice said as a sentence. */
function RecordScope({
  row,
  action,
  onAction,
  subject,
  who,
  opens,
  modulesHref,
  draft,
  locked,
  saving,
  staged,
  onReset,
  onSave,
  leadReach,
}: {
  row: ReachRow;
  action: AccessAction;
  onAction: (action: AccessAction) => void;
  subject: Subject;
  who: string;
  opens: OpensWith | null;
  modulesHref: string;
  draft: ReturnType<typeof useReachDraft>;
  locked: boolean;
  saving: boolean;
  staged: number;
  onReset: () => void;
  onSave: () => void;
  leadReach: LeadReachView | null;
}) {
  const isUser = subject.type === "user";
  const Icon = RECORD_ICON[row.key] ?? FileText;
  const cell = row.cells[action];
  const set = draft.setOf(row, action);
  const level = draft.levelOf(row, action);
  const changed = draft.isChanged(row, action);
  const viewLevel = draft.levelOf(row, "view");
  const closedByPermission = opens !== null && !opens.held;

  const tiles: { key: string; label: string; desc: string; on: boolean; choice: AccessLevel | null; corner?: React.ReactNode }[] = [
    {
      key: "inherit",
      label: inheritLabel(row, action, isUser).split(" — ")[0]!,
      desc: `${cell.baseWhy} Nothing is stored here: it follows ${isUser ? "their role" : "the role's permissions"}, and moves when they do.`,
      on: set === null,
      choice: null,
      corner: <LevelTag level={cell.base} dashed />,
    },
    ...LEVEL_ORDER.filter((l) => row.levels.includes(l)).map((l) => ({ key: l as string, label: LEVEL_WORDS[l], desc: levelMeans(l, row.ownMeans), on: set === l, choice: l as AccessLevel | null })),
  ];

  const sentence = [
    reachSentence({ who, action, level, row, leadReach: row.key === "leads" && (action === "view" || action === "edit") ? leadReach?.effective : null }),
    action !== "view" ? "Edit, delete and assign never reach wider than view." : null,
    closedByPermission ? `The pages stay closed until ${isUser ? "they hold" : "the role holds"} “${opens.label}”.` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-[18px] py-3.5">
        <Icon className="h-[22px] w-[22px] shrink-0 text-text/80" strokeWidth={1.75} aria-hidden />
        <div className="min-w-[200px] flex-1">
          <div className="text-[15px] font-bold text-text">
            {row.label} · scope for {subject.name}
          </div>
          <div className="text-xs text-muted">
            {ACTION_LABEL[action]}: {changed ? "staged — applies after you save." : cell.why}
          </div>
        </div>
        {closedByPermission ? (
          <Link href={modulesHref} title="Give the permission in Module Matrix">
            <Pill tone="amber" className="h-6 text-[11.5px]">
              <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
              Doesn&apos;t hold “{opens.label}”
            </Pill>
          </Link>
        ) : viewLevel === "NONE" ? (
          <Pill tone="amber" className="h-6 text-[11.5px]">
            <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
            {isUser ? "Reaches none of these" : "Role reaches none of these"}
          </Pill>
        ) : null}
      </div>

      {/* Per-action scope */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line/70 px-[18px] py-3" role="tablist" aria-label="Action">
        {row.actions.map((a) => (
          <button
            key={a}
            type="button"
            role="tab"
            aria-selected={a === action}
            onClick={() => onAction(a)}
            className={cn("inline-flex h-9 items-center gap-2 rounded-md border px-2.5 text-[13px] transition-colors", a === action ? "border-brand bg-brand-subtle font-semibold text-brand" : "border-line font-medium text-text/80 hover:bg-surface-sunken")}
          >
            {ACTION_LABEL[a]}
            <LevelTag level={draft.levelOf(row, a)} dashed={draft.setOf(row, a) === null} staged={draft.isChanged(row, a)} />
          </button>
        ))}
        {REACH_ACTIONS.filter((a) => !row.actions.includes(a)).length > 0 && (
          <span className="text-xs text-subtle">
            No{" "}
            {REACH_ACTIONS.filter((a) => !row.actions.includes(a))
              .map((a) => ACTION_LABEL[a].toLowerCase())
              .join(" or ")}{" "}
            scope: not an action this record has.
          </span>
        )}
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2 px-[18px] py-4" role="radiogroup" aria-label={`${ACTION_LABEL[action]} scope`}>
        {tiles.map((t) => {
          const blocked = t.on ? null : widerThanWhy(draft, row, action, t.choice);
          const disabled = locked || blocked !== null;
          return (
            <button
              key={t.key}
              type="button"
              role="radio"
              aria-checked={t.on}
              aria-disabled={disabled || undefined}
              title={blocked ?? undefined}
              onClick={disabled ? undefined : () => draft.choose([{ record: row.key, action, level: t.choice }])}
              className={cn(
                "flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors",
                t.on ? "border-brand bg-brand-subtle" : "border-line bg-surface",
                disabled ? "cursor-not-allowed" : "cursor-pointer",
                !t.on && !disabled && "hover:border-line-strong",
                blocked !== null && "opacity-55",
              )}
            >
              <span className="flex items-center gap-2">
                <span className={cn("inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2", t.on ? "border-brand" : "border-line-strong")}>
                  {t.on && <span className="h-2 w-2 rounded-full bg-brand" />}
                </span>
                <span className="flex-1 font-semibold text-text">{t.label}</span>
                {t.corner}
              </span>
              <span className="pl-6 text-xs leading-[1.45] text-muted">{t.desc}</span>
              {blocked && <span className="pl-6 text-[11px] font-medium text-warning">{blocked}</span>}
            </button>
          );
        })}
      </div>

      {/* Leads "as the account": also the ones they own and made — saved as ticked, apart from the staged levels. */}
      {row.key === "leads" && leadReach && (action === "view" || action === "edit") && level === "FOLLOW" && <LeadReachBox subject={subject} view={leadReach} locked={locked} />}

      <div className="flex flex-wrap items-center gap-3 border-t border-line/70 bg-surface-sunken/60 px-[18px] py-3">
        <MessageSquareQuote className="h-[18px] w-[18px] shrink-0 text-brand" aria-hidden />
        <span className="min-w-[220px] flex-1 text-[12.5px] leading-[1.5] text-text/80">{sentence}</span>
        {!locked && (
          <>
            <button type="button" className={cn(acButton.secondary, "h-[30px] px-2.5 text-xs font-semibold")} disabled={staged === 0 || saving} onClick={onReset}>
              Reset
            </button>
            <button type="button" className={cn(acButton.primary, "h-[30px] text-xs")} disabled={staged === 0 || saving} onClick={onSave}>
              {saving ? "Saving…" : "Save scope"}
            </button>
          </>
        )}
        {closedByPermission && (
          <Link href={modulesHref} className={panelLinkClass}>
            Open Module Matrix
          </Link>
        )}
      </div>
    </Panel>
  );
}
