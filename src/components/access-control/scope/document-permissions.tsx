"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, MoreHorizontal, ShoppingBag, ShoppingCart, ToggleLeft } from "lucide-react";
import { setRolePermissions } from "@/actions/permission";
import { setRoleAccessLevels } from "@/actions/access-levels";
import { setPersonAccessLevels, setPersonPermissions, type PermissionState } from "@/actions/person-access";
import { DOC_ACTIONS, DOC_ACTION_LABELS, docKeyOf } from "@/lib/documents/permission-keys";
import { LEVEL_WORDS } from "@/lib/authz/level-order";
import { acPath } from "@/lib/access-control/nav";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { AcPage, HintNote, Panel, Pill, StateTag, panelLinkClass } from "@/components/access-control/ui";
import { Chip, ChoiceMenu, LegendTag, LevelChip, LockNote, ReachLegend, type Choice, type OpenMenu } from "@/components/access-control/scope/chips";
import { DOC_AREAS, DOCUMENT_RECORD, docKeysOfArea, type DocArea } from "@/components/access-control/scope/doc-areas";
import { cycleLevel, levelChoices } from "@/components/access-control/scope/level-choices";
import { ACTION_LABEL, REACH_ACTIONS, levelMeans, type ReachRow, type SaveOptions, type Subject } from "@/components/access-control/scope/reach";
import { OverrideDialog, StagedActions, StickySaveBar, useLeaveGuard } from "@/components/access-control/scope/save-bar";
import { SubjectBar, type PersonOption, type RoleOption } from "@/components/access-control/scope/subject-bar";
import { useReachDraft } from "@/components/access-control/scope/use-reach-draft";
import { cn } from "@/lib/utils";

/** One permission as the screen reads it: the role's answer, a person's own exception, and what applies. */
export type PermRow = {
  key: string;
  label: string;
  description: string;
  tier: string;
  superAdminOnly: boolean;
  selfExcluded: boolean;
  /** The role gives it (for a role subject: the role itself). */
  role: boolean;
  /** A person's own exception, if any. */
  own: { allowed: boolean; reason: string | null; expiresAt: string | null; expired: boolean } | null;
  held: boolean;
  why: string;
};

export type ScreenViewer = {
  isSuperAdmin: boolean;
  /** The keys the viewer holds — the ones they may grant or take away. */
  holds: string[];
  role: string;
  /** Of the two keys that open these screens, the ones the viewer holds through their role. */
  ownAccessThroughRole: string[];
};

const AREA_ICON: Record<string, typeof ShoppingBag> = { sales: ShoppingBag, purchases: ShoppingCart };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Settings › Access Control › Document Permissions: per area, how far each record action reaches, who
 * may create, edit, issue, delete, cancel and approve each kind of document, and the area's other
 * permissions — for a role, or for one person as exceptions to theirs.
 *
 * The design's reach chips are drawn where Deskzo keeps a reach — the record levels
 * (RoleAccessLevel / UserAccessLevel). A document type's own actions are permissions, allowed or not;
 * how far they reach is the "Sales & purchase documents" row above them. Everything is staged and saved
 * together, through the actions that always saved it (`setRolePermissions`, `setRoleAccessLevels`,
 * `setPersonPermissions`, `setPersonAccessLevels`), with every rule they apply.
 */
export function DocumentPermissions({
  subject,
  roles,
  people,
  meta,
  permissions,
  reach,
  viewer,
  permissionLock,
  reachLock,
  initialArea,
}: {
  subject: Subject;
  roles: RoleOption[];
  people: PersonOption[];
  meta: string;
  permissions: PermRow[];
  reach: ReachRow[];
  viewer: ScreenViewer;
  /** Why no permission of this subject can be changed by this viewer, or null. */
  permissionLock: string | null;
  /** Why no record level can — the server's own reason (`roleAccessLevels().why`). */
  reachLock: string | null;
  initialArea?: string;
}) {
  const router = useRouter();
  const isUser = subject.type === "user";
  const [areaKey, setAreaKey] = useState(() => (DOC_AREAS.some((a) => a.key === initialArea) ? initialArea! : (DOC_AREAS[0]?.key ?? "")));
  const [states, setStates] = useState<Map<string, PermissionState>>(() => new Map());
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [asking, setAsking] = useState(false);
  const [saving, start] = useTransition();
  const draft = useReachDraft(reach);

  const byKey = useMemo(() => new Map(permissions.map((p) => [p.key, p])), [permissions]);
  const viewerHolds = useMemo(() => new Set(viewer.holds), [viewer.holds]);
  const rowOf = useMemo(() => new Map(reach.map((r) => [r.key as string, r])), [reach]);

  // ─── Permissions: what is stored, what is staged, what would apply ─────────────────────────────
  const savedState = (p: PermRow): PermissionState => (isUser ? (p.own && !p.own.expired ? (p.own.allowed ? "allow" : "deny") : "inherit") : p.role ? "allow" : "deny");
  const stateOf = (key: string): PermissionState => {
    const p = byKey.get(key);
    return states.get(key) ?? (p ? savedState(p) : "inherit");
  };
  const holds = (key: string): boolean => {
    const p = byKey.get(key);
    if (!p) return false;
    if (!states.has(key)) return p.held;
    const s = states.get(key)!;
    return s === "inherit" ? p.role : s === "allow";
  };
  /** The answer that turns a permission on or off with the fewest exceptions: a person follows their role where that is enough. */
  const want = (key: string, on: boolean): PermissionState => {
    if (!isUser) return on ? "allow" : "deny";
    const givenByRole = byKey.get(key)?.role ?? false;
    return on ? (givenByRole ? "inherit" : "allow") : givenByRole ? "deny" : "inherit";
  };
  const stage = (changes: [string, PermissionState][]) =>
    setStates((prev) => {
      const next = new Map(prev);
      for (const [key, state] of changes) {
        const p = byKey.get(key);
        if (!p) continue;
        if (state === savedState(p)) next.delete(key);
        else next.set(key, state);
      }
      return next;
    });

  /** Why this viewer can't change one permission here — the rules `setRolePermissions` and the grant guards apply. */
  const keyLock = (key: string): string | null => {
    if (permissionLock) return permissionLock;
    if (viewer.isSuperAdmin) return null;
    const p = byKey.get(key);
    if (p?.superAdminOnly) return "Only a super admin can grant this permission.";
    if (!viewerHolds.has(key)) return `You don't hold this yourself, so you can't change it for ${isUser ? "anybody" : "a role"}.`;
    if (!isUser && subject.key === viewer.role && viewer.ownAccessThroughRole.includes(key) && p?.role) {
      return "You hold this through this role. Taking it away would lock you out of putting it back.";
    }
    return null;
  };

  const openMenu = (anchor: HTMLElement, title: string, choices: Choice[]) => setMenu((m) => (m?.anchor === anchor ? null : { anchor, title, choices }));

  /** The answers a permission (or many at once) can be given: Allow or not for a role; Allow, Deny or their role's for a person. */
  const permissionChoices = (keys: string[]): Choice[] => {
    const set = (state: PermissionState) => () => {
      const free = keys.filter((k) => keyLock(k) === null);
      if (free.length === 0) return void toast.info("None of these is yours to change.");
      stage(free.map((k) => [k, state]));
    };
    if (!isUser) {
      return [
        { key: "allow", label: "Allow", hint: "People in this role may do it.", tone: "ALLOW", onPick: set("allow") },
        { key: "none", label: "None", hint: "Not allowed for this role.", tone: "NONE", onPick: set("deny") },
      ];
    }
    const one = keys.length === 1 ? byKey.get(keys[0]!) : null;
    return [
      { key: "allow", label: "Allow", hint: "For them alone, whatever their role says.", tone: "ALLOW", onPick: set("allow") },
      { key: "deny", label: "Deny", hint: "For them alone, even where their role allows it.", tone: "DENY", onPick: set("deny") },
      {
        key: "inherit",
        label: one ? `Their role's — ${one.role ? "Allow" : "None"}` : "Their role's",
        hint: "Inherit: remove the exception set for them alone.",
        tone: one ? (one.role ? "ALLOW" : "NONE") : "NONE",
        dashed: true,
        onPick: set("inherit"),
      },
    ];
  };

  /** A click moves a document cell on: on and off for a role; their role's, Allow, Deny for a person. */
  const cyclePermission = (key: string) => {
    if (!isUser) return stage([[key, holds(key) ? "deny" : "allow"]]);
    const order: PermissionState[] = ["inherit", "allow", "deny"];
    stage([[key, order[(order.indexOf(stateOf(key)) + 1) % order.length]!]]);
  };

  const titleOf = (p: PermRow, lock: string | null) =>
    [lock, p.description, p.selfExcluded ? "Never on a document they raised themselves." : null, p.tier === "sensitive" ? "Sensitive." : p.tier === "critical" ? "Critical." : null, isUser && !states.has(p.key) ? p.why : null]
      .filter(Boolean)
      .join(" · ");

  // ─── The open area ────────────────────────────────────────────────────────────────────────────
  const area: DocArea | undefined = DOC_AREAS.find((a) => a.key === areaKey) ?? DOC_AREAS[0];
  const sectionsOf = (a: DocArea) => a.sections.filter((k) => byKey.has(k));
  const moduleOn = (a: DocArea) => sectionsOf(a).length === 0 || sectionsOf(a).some(holds);

  // ─── Saving ───────────────────────────────────────────────────────────────────────────────────
  const permissionChanges = [...states];
  const staged = permissionChanges.length + draft.changes.length;
  useLeaveGuard(staged > 0);
  const canSave = !(permissionLock && reachLock);
  const saveLabel = isUser ? "Save as overrides" : "Save changes";
  const reset = () => {
    setStates(new Map());
    draft.reset();
  };

  const save = (options: SaveOptions = {}) =>
    start(async () => {
      let saved = 0;
      if (permissionChanges.length) {
        const r =
          subject.type === "role"
            ? await setRolePermissions(
                subject.key,
                permissionChanges.map(([key, state]) => ({ key, allowed: state === "allow" })),
              )
            : await setPersonPermissions(
                subject.id,
                permissionChanges.map(([key, state]) => ({ key, state })),
                options,
              );
        if (!r.ok) {
          toast.error(r.error);
          router.refresh();
          return;
        }
        saved = permissionChanges.length;
      }
      if (draft.changes.length) {
        const r = subject.type === "role" ? await setRoleAccessLevels(subject.key, draft.changes) : await setPersonAccessLevels(subject.id, draft.changes, options);
        if (!r.ok) {
          toast.error(saved ? `${plural(saved, "permission change")} saved, then: ${r.error}` : r.error);
          start(() => {
            if (saved) setStates(new Map());
            router.refresh();
          });
          return;
        }
        saved += draft.changes.length;
      }
      toast.success(`${plural(saved, "change")} saved${subject.type === "user" ? ` as overrides for ${subject.name}` : ""}`);
      start(() => {
        setAsking(false);
        reset();
        router.refresh();
      });
    });
  const onSave = () => (isUser ? setAsking(true) : save());

  const locks = [...new Set([permissionLock, reachLock].filter((w): w is string => !!w))];
  const subjectParams = subject.type === "role" ? { role: subject.key } : { user: subject.id };

  return (
    <AcPage
      crumb="Document Permissions"
      title="Document Permissions"
      description="Per area: how far each record action reaches — None, Own, Team, Branch, As the account or All — and who may create, edit, issue, delete, cancel and approve each kind of document. Click a chip to cycle."
      actions={<StagedActions count={staged} saving={saving} saveLabel={saveLabel} canSave={canSave} onReset={reset} onSave={onSave} />}
    >
      <div className="flex flex-col gap-3.5">
        <SubjectBar subject={subject} roles={roles} people={people} hrefFor={acPath.documents} staged={staged} meta={meta}>
          <ReachLegend
            inheritedMeans={isUser ? "Nothing set for them alone: it comes from their role." : "No level set on the role: it follows the role's permissions."}
            extra={<LegendTag tone="ALLOW" label="Allow" title="A document action or permission that is allowed." />}
          />
        </SubjectBar>

        {locks.map((why) => (
          <LockNote key={why}>{why}</LockNote>
        ))}

        {!area ? (
          <Panel>
            <p className="px-4 py-6 text-center text-subtle">No module has document types with permissions of their own.</p>
          </Panel>
        ) : (
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
            {/* The areas */}
            <Panel className="lg:sticky lg:top-20">
              <div className="px-3.5 pb-1.5 pt-2.5 text-[11px] font-bold uppercase tracking-[0.06em] text-subtle">Document areas</div>
              {DOC_AREAS.map((a) => {
                const Icon = AREA_ICON[a.key] ?? ShoppingBag;
                const active = a.key === area.key;
                const on = moduleOn(a);
                const keys = docKeysOfArea(a);
                const dirty = keys.some((k) => states.has(k)) || a.sections.some((k) => states.has(k)) || a.other.some((k) => states.has(k)) || draft.changes.some((c) => (a.records as string[]).includes(c.record));
                return (
                  <button
                    key={a.key}
                    type="button"
                    aria-current={active ? "true" : undefined}
                    onClick={() => {
                      setAreaKey(a.key);
                      setMenu(null);
                    }}
                    className={cn("flex w-full items-center gap-2.5 border-l-[3px] px-3.5 py-[9px] text-left transition-colors", active ? "border-brand bg-brand-subtle" : "border-transparent hover:bg-surface-sunken")}
                  >
                    <Icon className={cn("h-[18px] w-[18px] shrink-0", active ? "text-brand" : "text-muted")} strokeWidth={1.75} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className={cn("block", active ? "font-bold text-brand" : "font-medium text-text")}>{a.label}</span>
                      <span className="block text-[11.5px] text-subtle">{on ? `${keys.filter(holds).length} of ${keys.length} document actions` : "Module off"}</span>
                    </span>
                    {dirty && <span className="h-2 w-2 shrink-0 rounded-full bg-brand" title="Staged changes" />}
                    {!on && (
                      <span title="Module off">
                        <ToggleLeft className="h-[15px] w-[15px] text-subtle" aria-hidden />
                      </span>
                    )}
                  </button>
                );
              })}
            </Panel>

            {/* The open area */}
            <Panel className="min-w-0">
              <AreaHeader
                area={area}
                on={moduleOn(area)}
                sections={sectionsOf(area)}
                holds={holds}
                staged={sectionsOf(area).some((k) => states.has(k))}
                lock={
                  sectionsOf(area)
                    .map(keyLock)
                    .find((w) => w !== null) ?? null
                }
                isUser={isUser}
                saving={saving}
                modulesHref={acPath.modules(subjectParams)}
                onToggle={(on) => stage(sectionsOf(area).map((k) => [k, want(k, on)]))}
              />

              <div className={cn("px-5 pb-1 pt-3.5 transition-opacity", !moduleOn(area) && "opacity-50")}>
                {/* Records */}
                <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2">
                  <span className="font-bold text-text">Records</span>
                  <span className="font-medium text-muted">— how far each action reaches</span>
                  <span className="flex-1" />
                  <Link href={acPath.scope(subjectParams)} className={panelLinkClass}>
                    Every record type in Data Scope
                  </Link>
                </div>
                <div className="overflow-auto">
                  <table className="w-full min-w-[620px] border-collapse">
                    <thead>
                      <tr>
                        <th className="w-[230px] border-b border-line/70 py-1.5 text-left text-xs font-medium text-muted">Record</th>
                        {REACH_ACTIONS.map((a) => (
                          <th key={a} className="border-b border-line/70 px-1 py-1.5 text-center text-xs font-medium text-muted" title={`${ACTION_LABEL[a]} ${area.label.toLowerCase()} records`}>
                            {ACTION_LABEL[a]}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {area.records.map((record) => {
                        const row = rowOf.get(record);
                        if (!row) return null;
                        return (
                          <tr key={record}>
                            <td className="border-b border-line/70 py-[9px] pr-2 align-middle">
                              <span className="block font-medium text-text">{row.label}</span>
                              <span className="block text-[11.5px] text-subtle">
                                {record === DOCUMENT_RECORD ? "How far the document permissions below reach" : row.ownMeans.startsWith("—") ? row.ownMeans.replace(/^—\s*/, "") : `Own: ${row.ownMeans}`}
                              </span>
                            </td>
                            {REACH_ACTIONS.map((action) => {
                              const cell = row.cells[action];
                              if (cell.absent || !row.actions.includes(action)) {
                                return (
                                  <td key={action} className="border-b border-line/70 px-1 py-[9px] text-center text-subtle" title="Not an action this record has.">
                                    —
                                  </td>
                                );
                              }
                              const level = draft.levelOf(row, action);
                              const changed = draft.isChanged(row, action);
                              return (
                                <td key={action} className="border-b border-line/70 px-1 py-[9px] text-center">
                                  <LevelChip
                                    level={level}
                                    dashed={draft.setOf(row, action) === null}
                                    staged={changed}
                                    locked={reachLock !== null}
                                    ariaLabel={`${row.label}, ${ACTION_LABEL[action]}: ${LEVEL_WORDS[level]}`}
                                    title={[reachLock, `${LEVEL_WORDS[level]} — ${levelMeans(level, row.ownMeans)}`, changed ? "After you save." : cell.why].filter(Boolean).join(" · ")}
                                    onClick={() => cycleLevel(draft, row, action)}
                                    onMenu={(anchor) => openMenu(anchor, `${row.label} › ${ACTION_LABEL[action]}`, levelChoices(draft, row, action, isUser))}
                                  />
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="mt-1.5 text-[11.5px] text-subtle">Edit, delete and assign can&apos;t reach wider than view. Dashed follows {isUser ? "their role" : "the role's permissions"} until a level is set.</p>

                {/* Documents */}
                <div className="mb-1.5 mt-[18px] font-bold text-text">Documents</div>
                <div className="overflow-auto">
                  <table className="w-full min-w-[720px] border-collapse">
                    <thead>
                      <tr>
                        <th className="w-[230px] border-b border-line/70 py-1.5 text-left text-xs font-medium text-muted">Document</th>
                        {DOC_ACTIONS.map((action) => (
                          <th key={action} className="border-b border-line/70 px-1 py-1.5 text-center text-xs font-medium text-muted">
                            <button
                              type="button"
                              title="Set the whole column"
                              className="hover:text-brand"
                              onClick={(e) =>
                                openMenu(
                                  e.currentTarget,
                                  `${DOC_ACTION_LABELS[action]} · every document in ${area.label}`,
                                  permissionChoices(area.kinds.map((k) => docKeyOf(k.slug, action))),
                                )
                              }
                            >
                              {DOC_ACTION_LABELS[action]}
                            </button>
                          </th>
                        ))}
                        <th className="w-[34px] border-b border-line/70" />
                      </tr>
                    </thead>
                    <tbody>
                      {area.kinds.map((kind) => {
                        const keys = DOC_ACTIONS.map((a) => docKeyOf(kind.slug, a));
                        const on = keys.filter(holds).length;
                        return (
                          <tr key={kind.slug} className="transition-colors hover:bg-surface-sunken/60">
                            <td className="border-b border-line/70 py-[9px] pr-2 font-medium text-text">
                              {kind.label}
                              {on > 0 && (
                                <span className="ml-1.5 text-[11px] font-medium text-subtle">
                                  {on}/{keys.length}
                                </span>
                              )}
                            </td>
                            {DOC_ACTIONS.map((action) => {
                              const key = docKeyOf(kind.slug, action);
                              const p = byKey.get(key);
                              if (!p) {
                                return (
                                  <td key={action} className="border-b border-line/70 px-1 py-[9px] text-center text-subtle">
                                    —
                                  </td>
                                );
                              }
                              const lock = keyLock(key);
                              const held = holds(key);
                              const state = stateOf(key);
                              const denied = isUser && !held && state === "deny";
                              return (
                                <td key={action} className="border-b border-line/70 px-1 py-[9px] text-center">
                                  <Chip
                                    tone={held ? "ALLOW" : denied ? "DENY" : "NONE"}
                                    label={held ? "Allow" : denied ? "Deny" : "None"}
                                    dashed={isUser && state === "inherit"}
                                    staged={states.has(key)}
                                    locked={lock !== null}
                                    ariaLabel={`${p.label}: ${held ? "allowed" : denied ? "denied" : "not allowed"}`}
                                    title={titleOf(p, lock)}
                                    onClick={() => cyclePermission(key)}
                                    onMenu={(anchor) => openMenu(anchor, `${kind.label} › ${DOC_ACTION_LABELS[action]}`, permissionChoices([key]))}
                                  />
                                </td>
                              );
                            })}
                            <td className="border-b border-line/70 py-[9px] pl-1 text-right">
                              <button
                                type="button"
                                title="Set the whole row"
                                aria-label={`${kind.label}: set every action`}
                                className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-md text-subtle transition-colors hover:bg-surface-sunken hover:text-text"
                                onClick={(e) => openMenu(e.currentTarget, `${kind.label} · every action`, permissionChoices(keys))}
                              >
                                <MoreHorizontal className="h-4 w-4" aria-hidden />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="mt-1.5 text-[11.5px] text-subtle">
                  Approve signs off a document waiting for approval, where Settings › Document approvals asks for it — never one&apos;s own. An issued document stays locked for everyone; Cancel reverses
                  it with a reason.
                </p>
                <HintNote className="mt-2.5">
                  A document action is allowed or not — it has no reach of its own. Which documents it applies to is the “{rowOf.get(DOCUMENT_RECORD)?.label ?? "Sales & purchase documents"}” row
                  under Records. A column heading or a row&apos;s menu sets many at once; right-click a chip to pick an answer directly.
                </HintNote>

                {/* Other permissions */}
                <div className="mb-2 mt-[18px] font-bold text-text">Other permissions</div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-x-6 gap-y-2 pb-[18px]">
                  {area.other.map((key) => {
                    const p = byKey.get(key);
                    if (!p) return null;
                    const lock = keyLock(key);
                    const on = holds(key);
                    const state = stateOf(key);
                    const denied = isUser && state === "deny";
                    return (
                      <button
                        key={key}
                        type="button"
                        role="checkbox"
                        aria-checked={on}
                        aria-disabled={lock !== null || undefined}
                        title={titleOf(p, lock)}
                        onClick={lock ? undefined : () => stage([[key, want(key, !on)]])}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          if (!lock) openMenu(e.currentTarget, p.label, permissionChoices([key]));
                        }}
                        className={cn("flex items-center gap-[9px] py-1 text-left text-[13px] text-text", lock ? "cursor-not-allowed" : "cursor-pointer")}
                      >
                        <span
                          className={cn(
                            "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px]",
                            on ? "border border-brand bg-brand text-brand-contrast" : isUser && state === "inherit" ? "border-[1.5px] border-dashed border-line-strong bg-surface" : denied ? "border border-danger bg-surface" : "border border-line-strong bg-surface",
                            states.has(key) && "ring-2 ring-brand/40",
                          )}
                        >
                          {on && <Check className="h-3 w-3" strokeWidth={3} aria-hidden />}
                        </span>
                        <span className="min-w-0">{p.label}</span>
                        {denied && <StateTag tone="red">Deny</StateTag>}
                        {p.tier === "sensitive" && <Pill tone="amber">Sensitive</Pill>}
                        {p.tier === "critical" && <Pill tone="red">Critical</Pill>}
                      </button>
                    );
                  })}
                </div>
              </div>
            </Panel>
          </div>
        )}
      </div>

      <StickySaveBar count={staged} saving={saving} saveLabel={saveLabel} onDiscard={reset} onSave={onSave} />
      <ChoiceMenu menu={menu} onClose={() => setMenu(null)} />
      {subject.type === "user" && <OverrideDialog open={asking} count={staged} name={subject.name} saving={saving} onClose={() => setAsking(false)} onConfirm={save} />}
    </AcPage>
  );
}

/** The open area's title strip: its name, what it holds, and "Module on" — its place in the menu. */
function AreaHeader({
  area,
  on,
  sections,
  holds,
  staged,
  lock,
  isUser,
  saving,
  modulesHref,
  onToggle,
}: {
  area: DocArea;
  on: boolean;
  sections: string[];
  holds: (key: string) => boolean;
  staged: boolean;
  lock: string | null;
  isUser: boolean;
  saving: boolean;
  modulesHref: string;
  onToggle: (on: boolean) => void;
}) {
  const shown = sections.filter(holds).length;
  const who = isUser ? "They see" : "People in this role see";
  return (
    <div className="flex flex-wrap items-start gap-3 border-b border-line/70 px-5 pb-3 pt-4">
      <div className="min-w-[200px] flex-1">
        <div className="text-[17px] font-bold tracking-[-0.01em] text-text">{area.label}</div>
        <div className="mt-0.5 text-[12.5px] text-muted">{area.description}</div>
      </div>
      {sections.length > 0 && (
        <div className="flex flex-col items-end gap-0.5">
          <label className="inline-flex h-8 items-center gap-2 font-semibold text-text" title={lock ?? (on ? `Module on · ${who} ${area.label} in the menu and can open its pages` : `Module off · ${area.label} is out of the menu and its pages don't open, whatever is allowed below`)}>
            <Switch size="sm" aria-label={`${area.label} module on`} checked={on} disabled={saving || lock !== null} className={cn(staged && "ring-2 ring-brand/40")} onChange={onToggle} />
            Module on
          </label>
          <span className="text-[11.5px] text-subtle">
            In the menu: {shown} of {sections.length} {sections.length === 1 ? "section" : "sections"} ·{" "}
            <Link href={modulesHref} className="font-semibold text-brand hover:underline">
              Choose in Module Matrix
            </Link>
          </span>
        </div>
      )}
    </div>
  );
}
