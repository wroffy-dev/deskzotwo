"use client";

import { Fragment, startTransition, useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Columns3, FileText, Filter, Lock, Save, Search, Shield, Timer, User } from "lucide-react";
import { saveRoleAnswers } from "@/actions/access-control-modules";
import { extendUserPermission } from "@/actions/access";
import { setPersonPermissions } from "@/actions/person-access";
import { setRolePageHidden } from "@/actions/role-pages";
import { acPath } from "@/lib/access-control/nav";
import { isDocKey } from "@/lib/documents/permission-keys";
import { PERMISSIONS, sectionPermission } from "@/lib/permissions";
import { ACCESS_MODULES, FOLDED_KEYS, REACH_KEYS, isSectionKey, permissionsOfModule, sectionsOfModule, type AccessModule } from "@/lib/staff/access-modules";
import { MENU_PAGES, pagesOfSection } from "@/lib/staff/menu-pages";
import { moduleNote } from "@/lib/staff/permission-modules";
import { confirmAction } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { AcPage, EmptyNote, HintNote, Meter, Panel, Pill, acButton, acInput } from "@/components/access-control/ui";
import { cn } from "@/lib/utils";
import { ExceptionEndDialog, SaveExceptionsDialog } from "./exception-dialogs";
import { AnswerPill, BulkPair, MatrixLegend, ModuleGlyph, TriState } from "./matrix-parts";
import { MatrixSummary, type StagedItem, type SummaryLink, type SummaryStat } from "./matrix-summary";
import type { Answer, MatrixData, MatrixPermission } from "./types";

type View = "all" | "allowed" | "denied" | "set" | "sensitive";
const VIEWS: { v: View; label: string }[] = [
  { v: "all", label: "All" },
  { v: "allowed", label: "Allowed" },
  { v: "denied", label: "Not allowed" },
  { v: "set", label: "Set here" },
  { v: "sensitive", label: "Sensitive" },
];

/** A module's rows: its menu sections, its permissions, and the keys another screen draws. */
type ModuleLayout = {
  module: AccessModule;
  sections: string[];
  keys: string[];
  /** Create, edit, issue… for each kind of document — the Document Permissions grid. */
  docKeys: string[];
  /** Keys that only say how far a record reaches — the Data Scope screen's level says the same. */
  folded: string[];
};

/**
 * The matrix laid out by Deskzo's own modules (src/lib/staff/access-modules.ts), as the role and
 * person editors always were. A section switch no module claims lands in Settings, so a key added
 * tomorrow still has a row.
 */
function layoutOf(known: Set<string>): ModuleLayout[] {
  const claimed = new Set(ACCESS_MODULES.flatMap((m) => m.sections));
  const strays = PERMISSIONS.filter((d) => isSectionKey(d.key) && !claimed.has(d.key)).map((d) => d.key);
  return ACCESS_MODULES.map((m) => {
    const own = permissionsOfModule(m.key)
      .map((d) => d.key)
      .filter((k) => known.has(k));
    return {
      module: m,
      sections: [...sectionsOfModule(m.key).map((d) => d.key), ...(m.key === "admin" ? strays : [])].filter((k) => known.has(k)),
      keys: own.filter((k) => !isDocKey(k) && !REACH_KEYS.has(k) && !FOLDED_KEYS.has(k)),
      docKeys: own.filter((k) => isDocKey(k)),
      folded: own.filter((k) => REACH_KEYS.has(k) || FOLDED_KEYS.has(k)),
    };
  });
}

const thBase = "sticky top-0 z-20 whitespace-nowrap border-b border-line bg-surface-sunken text-[11px] font-semibold uppercase tracking-[0.04em] text-muted";
const tdBase = "border-b border-line/70 align-middle";

/**
 * The Module Permission Matrix: every module, and under it every permission, for one role or one
 * person. A cell says what applies and where it comes from; an answer is Default, Allow or Deny.
 *
 * Nothing is saved as it is clicked: changes are staged (the accent ring), counted beside Save, and
 * written together — a role's through `saveRoleAnswers` and `setRolePageHidden`, a person's as
 * exceptions through `setPersonPermissions`, with one reason and end date. The locks are the server's
 * own rules, shown before the click: ADMIN is the super admin's to change, nobody hands out a key they
 * don't hold, a super-admin-only key is the super admin's, and nobody takes away their own way in.
 */
export function ModuleMatrix({ data }: { data: MatrixData }) {
  const { subject, viewer, permissions, moduleStates, scopes } = data;
  const isRole = subject.kind === "role";
  const who = subject.kind === "role" ? { role: subject.key } : { user: subject.id };
  const router = useRouter();

  const [draft, setDraft] = useState<Record<string, Answer>>({});
  /** Menu pages, by address: true to hide. A role's only. */
  const [pageDraft, setPageDraft] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState<Set<string>>(() => new Set([ACCESS_MODULES[0]!.key]));
  const [q, setQ] = useState("");
  const [view, setView] = useState<View>("all");
  const [asking, setAsking] = useState(false);
  const [ending, setEnding] = useState<string | null>(null);
  const [saving, start] = useTransition();

  const byKey = useMemo(() => new Map(permissions.map((p) => [p.key, p])), [permissions]);
  const layout = useMemo(() => layoutOf(new Set(permissions.map((p) => p.key))), [permissions]);
  const viewerHolds = useMemo(() => new Set(viewer.holds), [viewer.holds]);
  const hiddenSaved = useMemo(() => new Set(data.hiddenPages), [data.hiddenPages]);
  const sectionModule = useMemo(() => new Map(Object.keys(moduleStates).map((k) => [sectionPermission(k), k])), [moduleStates]);
  const moduleOfKey = useMemo(() => new Map(layout.flatMap((l) => [...l.sections, ...l.keys].map((k) => [k, l.module.label] as const))), [layout]);

  // ─── The draft ─────────────────────────────────────────────────────────────────────────────────
  // Only what differs from what is stored counts: a save that brings the same answer back drops out.
  const staged = useMemo(() => Object.entries(draft).filter(([k, s]) => byKey.has(k) && byKey.get(k)!.state !== s), [draft, byKey]);
  const stagedPages = useMemo(() => Object.entries(pageDraft).filter(([href, hide]) => hiddenSaved.has(href) !== hide), [pageDraft, hiddenSaved]);
  const stagedCount = staged.length + stagedPages.length;
  const clean = stagedCount === 0;

  const stateOf = (key: string): Answer => draft[key] ?? byKey.get(key)?.state ?? "default";
  const isStaged = (key: string) => draft[key] !== undefined && draft[key] !== byKey.get(key)?.state;
  /** What applies once the draft is saved: an Allow or Deny as set, Default as the registry or their role gives. */
  const allowedOf = (key: string): boolean => {
    const p = byKey.get(key);
    if (!p) return false;
    const d = draft[key];
    if (d === undefined || d === p.state) return p.held;
    return d === "default" ? p.base : d === "allow";
  };
  const pageHidden = (href: string) => pageDraft[href] ?? hiddenSaved.has(href);
  const pageStaged = (href: string) => pageDraft[href] !== undefined && pageDraft[href] !== hiddenSaved.has(href);

  // ─── Who may change what ───────────────────────────────────────────────────────────────────────
  const subjectLock: string | null =
    subject.kind === "role"
      ? !viewer.mayManage
        ? "You can review roles but not change them."
        : subject.key === "ADMIN" && !viewer.isSuperAdmin
          ? "Only a super admin can change what admins can do."
          : null
      : !viewer.mayManage
        ? "You can review access but not change it."
        : subject.isSuperAdmin
          ? "A super admin holds everything and sees every field. There is nothing to set for them."
          : subject.id === viewer.id
            ? "Your own access is changed by another admin."
            : null;

  /** Why this key can't be changed by the person looking, or null — the server's rules, said before the click. */
  const lockOf = (key: string): string | null => {
    if (subjectLock) return subjectLock;
    if (viewer.isSuperAdmin) return null;
    const p = byKey.get(key);
    if (p?.superAdminOnly) return "Only a super admin can grant this permission.";
    if (p?.adminOnly && viewer.role !== "ADMIN") return "Only an admin or the super admin can give this permission.";
    if (!viewerHolds.has(key)) return isRole ? "You don't hold this yourself, so you can't change it for a role." : "You don't hold this yourself, so you can't change it for somebody else.";
    if (subject.kind === "role" && subject.key === viewer.role && viewer.ownAccessThroughRole.includes(key) && p?.held) {
      return "You hold this through this role. Taking it away would lock you out of putting it back.";
    }
    return null;
  };

  /** Why a permission does nothing yet: its module is off for the company, or outside the plan. */
  const noteOf = (key: string): string | null => {
    const modules = isSectionKey(key) ? (sectionModule.has(key) ? [sectionModule.get(key)!] : []) : (byKey.get(key)?.modules ?? []);
    return moduleNote(modules, moduleStates);
  };

  // ─── Changing answers ──────────────────────────────────────────────────────────────────────────
  const setAnswer = (key: string, state: Answer) =>
    setDraft((prev) => {
      const next = { ...prev };
      if (byKey.get(key)?.state === state) delete next[key];
      else next[key] = state;
      return next;
    });

  /**
   * Makes each key allowed, or not — the switch, and the "all / none" and "on / off" pairs. A key that
   * already answers that way is left as it is (a Default that allows stays a Default); one whose stored
   * answer says so goes back to it; the rest get an Allow or a Deny. Locked keys are skipped, and said.
   */
  const flip = (keys: string[], allow: boolean) => {
    const patch: Record<string, Answer | null> = {};
    let skipped = 0;
    for (const key of keys) {
      const p = byKey.get(key);
      if (!p || allowedOf(key) === allow) continue;
      if (lockOf(key)) {
        skipped += 1;
        continue;
      }
      patch[key] = p.held === allow ? null : allow ? "allow" : "deny";
    }
    setDraft((prev) => {
      const next = { ...prev };
      for (const [key, state] of Object.entries(patch)) {
        if (state === null) delete next[key];
        else next[key] = state;
      }
      return next;
    });
    if (skipped) toast.info(`${skipped} ${skipped === 1 ? "permission" : "permissions"} skipped: locked for you`);
  };

  const setPageHidden = (href: string, hide: boolean) =>
    setPageDraft((prev) => {
      const next = { ...prev };
      if (hiddenSaved.has(href) === hide) delete next[href];
      else next[href] = hide;
      return next;
    });

  const reset = () => {
    setDraft({});
    setPageDraft({});
  };

  // ─── Leaving with changes staged ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (clean) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [clean]);

  const guard = async (then: () => void) => {
    if (!clean && !(await confirmAction({ title: "Discard staged changes?", message: `${stagedCount} unsaved ${stagedCount === 1 ? "change" : "changes"} on this screen will be dropped.`, confirmLabel: "Discard", danger: true }))) return;
    then();
  };
  const go = (href: string) => void guard(() => router.push(href));
  const leave = (event: React.MouseEvent, href: string) => {
    if (clean || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    go(href);
  };

  // ─── Saving ────────────────────────────────────────────────────────────────────────────────────
  const saved = (count: number) => {
    toast.success(`${count} module ${count === 1 ? "permission" : "permissions"} saved`);
    startTransition(() => {
      router.refresh();
      reset();
    });
  };

  const commit = (options?: { reason?: string; expiresAt: string | null }) =>
    start(async () => {
      if (subject.kind === "role") {
        if (staged.length) {
          const r = await saveRoleAnswers(
            subject.key,
            staged.map(([key, state]) => ({ key, state })),
          );
          if (!r.ok) {
            toast.error(r.error);
            return;
          }
        }
        for (const [href, hide] of stagedPages) {
          const r = await setRolePageHidden(subject.key, href, hide);
          if (!r.ok) {
            // The answers are in; the pages saved before this one drop out of the draft once the screen has them.
            toast.error(staged.length ? `The permissions were saved, but not every menu page: ${r.error}` : r.error);
            startTransition(() => {
              router.refresh();
              setDraft({});
            });
            return;
          }
        }
        saved(stagedCount);
        return;
      }
      const r = await setPersonPermissions(
        subject.id,
        staged.map(([key, state]) => ({ key, state: state === "default" ? ("inherit" as const) : state })),
        { reason: options?.reason, expiresAt: options?.expiresAt ?? null },
      );
      if (!r.ok) {
        // It saves one at a time and says how far it got; what was saved drops out of the draft.
        toast.error(r.error);
        startTransition(() => router.refresh());
        return;
      }
      setAsking(false);
      saved(staged.length);
    });

  const save = async () => {
    if (clean || saving) return;
    if (subject.kind === "user") {
      // Putting answers back to the role's needs no reason and no end.
      if (staged.every(([, state]) => state === "default")) commit();
      else setAsking(true);
      return;
    }
    if (stagedCount > 20) {
      const people = `${subject.people} ${subject.people === 1 ? "person holds" : "people hold"} this role`;
      if (!(await confirmAction({ title: `Save ${stagedCount} changes to ${subject.name}?`, message: `${people}; the changes apply to them from their next request.`, confirmLabel: "Save changes", danger: false }))) return;
    }
    commit();
  };

  const saveEnd = (expiresAt: string | null) => {
    if (subject.kind !== "user" || !ending) return;
    const permission = ending;
    start(async () => {
      const r = await extendUserPermission({ userId: subject.id, permission, expiresAt });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(expiresAt ? "End date changed" : "End date removed");
      setEnding(null);
      startTransition(() => router.refresh());
    });
  };

  // ─── What is listed ────────────────────────────────────────────────────────────────────────────
  const term = q.trim().toLowerCase();
  const filtering = term !== "" || view !== "all";
  const inView = (key: string) => {
    if (view === "all") return true;
    if (view === "allowed") return allowedOf(key);
    if (view === "denied") return !allowedOf(key);
    if (view === "set") return stateOf(key) !== "default";
    return byKey.get(key)?.tier !== "standard";
  };
  const listed = layout
    .map((l) => {
      const moduleHit = term !== "" && (l.module.label.toLowerCase().includes(term) || l.module.description.toLowerCase().includes(term));
      const hit = (key: string) => {
        if (!inView(key)) return false;
        if (!term || moduleHit) return true;
        const p = byKey.get(key)!;
        return p.label.toLowerCase().includes(term) || p.key.toLowerCase().includes(term) || p.description.toLowerCase().includes(term);
      };
      return { ...l, shownSections: l.sections.filter(hit), shownKeys: l.keys.filter(hit) };
    })
    .filter((l) => !filtering || l.shownSections.length + l.shownKeys.length > 0);
  const listedSections = listed.flatMap((l) => l.shownSections);
  const listedKeys = listed.flatMap((l) => l.shownKeys);
  const allOpen = listed.every((l) => open.has(l.module.key));

  // ─── Words ─────────────────────────────────────────────────────────────────────────────────────
  const defaultWord = isRole ? "Default" : "Role";
  const word = (state: Answer) => (state === "default" ? defaultWord : state === "allow" ? "Allow" : "Deny");
  const labelOf = (p: MatrixPermission) => (isSectionKey(p.key) ? `Menu: ${p.label}` : p.label);

  /** Where an answer comes from, in a line. */
  const sourceOf = (p: MatrixPermission, state: Answer, changed: boolean): string => {
    if (!isRole) {
      if (!changed) return p.why ?? "";
      if (state === "allow") return "Allowed for them alone, once saved.";
      if (state === "deny") return "Denied for them alone, once saved.";
      return `Back to their role, which ${p.base ? "allows it" : "doesn't grant it"}, once saved.`;
    }
    if (state === "allow") return p.base ? "Pinned to Allow — the default allows it too." : "Allowed on this role.";
    if (state === "deny") return p.base ? "Denied on this role — the default would allow it." : "Pinned to Deny — the default doesn't grant it either.";
    if (!p.base) return "Default — not granted to this role.";
    if (isSectionKey(p.key)) return "Default — in every role's menu until it is hidden.";
    return subject.kind === "role" && subject.key === "ADMIN" ? "Default — admins hold everything not taken away." : "Default — comes with this role.";
  };

  // ─── Rows ──────────────────────────────────────────────────────────────────────────────────────
  const keyRow = (key: string, section: boolean) => {
    const p = byKey.get(key)!;
    const state = stateOf(key);
    const on = allowedOf(key);
    const changed = isStaged(key);
    const lock = lockOf(key);
    const note = noteOf(key);
    const source = sourceOf(p, state, changed);
    const label = section ? (p.label.split(" › ").pop() ?? p.label) : p.label;
    const own = !isRole && !changed ? p.own : null;
    const pages = isRole && section && on ? pagesOfSection(key, data.country) : [];
    const pill = (
      <AnswerPill
        on={on}
        explicit={state !== "default"}
        staged={changed}
        blocked={note !== null}
        temp={own !== null && !own.expired && own.expiresAt !== null}
        locked={lock !== null || saving}
        label={`${label}: ${on ? "allowed" : "not allowed"}`}
        title={[`${on ? "Allowed" : "Not allowed"}. ${source}`, note, lock].filter(Boolean).join(" · ")}
        onClick={() => flip([key], !on)}
      />
    );
    return (
      <tr key={key} className="bg-surface hover:bg-surface-sunken">
        <td className={cn(tdBase, "sticky left-0 z-10 bg-inherit py-1.5 pl-[42px] pr-3")}>
          <div className="flex max-w-[460px] flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className={cn("font-medium", on ? "text-text" : "text-text/80")} title={p.key}>
              {label}
            </span>
            {p.tier === "critical" && <Pill tone="red">Critical</Pill>}
            {p.tier === "sensitive" && <Pill tone="amber">Sensitive</Pill>}
            {p.superAdminOnly && (
              <Pill tone="brand" title="Only a super admin can grant this, to anyone.">
                Super admin only
              </Pill>
            )}
            {p.selfExcluded && <Pill title="The holder cannot use this on a record they raised.">Never on own records</Pill>}
          </div>
          <div className="mt-0.5 line-clamp-1 max-w-[460px] text-[11px] text-subtle" title={section ? undefined : p.description}>
            {section ? `Menu section · ${p.label}` : p.description}
          </div>
          {pages.length > 1 && (
            // Its pages, one tick each (src/lib/staff/hidden-pages.ts) — staged and saved with the rest.
            <div className="mt-1 flex max-w-[460px] flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
              <span className="text-subtle">Pages</span>
              {pages.map((page) => {
                const hide = pageHidden(page.href);
                return (
                  <label key={page.href} title={lock ?? undefined} className={cn("inline-flex items-center gap-1 rounded px-0.5", hide ? "text-subtle line-through" : "text-text/80", pageStaged(page.href) && "ring-2 ring-brand/40")}>
                    <input
                      type="checkbox"
                      className="h-3 w-3 accent-[var(--color-brand)]"
                      checked={!hide}
                      disabled={lock !== null || saving}
                      onChange={(e) => setPageHidden(page.href, !e.target.checked)}
                    />
                    {page.label}
                  </label>
                );
              })}
            </div>
          )}
        </td>
        <td className={cn(tdBase, "px-0.5 py-1 text-center")}>{section && pill}</td>
        <td className={cn(tdBase, "px-0.5 py-1 text-center")}>{!section && pill}</td>
        <td className={cn(tdBase, "whitespace-nowrap px-3 py-1")}>
          <span className="inline-flex items-center gap-1.5">
            <TriState value={state} defaultWord={defaultWord} name={`${label}: stored answer`} disabled={lock !== null || saving} title={lock ?? undefined} onChange={(next) => setAnswer(key, next)} />
            {lock !== null && !subjectLock && (
              <span title={lock} className="text-subtle">
                <Lock className="h-3.5 w-3.5" aria-label={lock} />
              </span>
            )}
          </span>
        </td>
        <td className={cn(tdBase, "px-3 py-1.5 text-xs leading-[1.4] text-muted")}>
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            {changed && (
              <Pill tone="brand" title={`Stored now: ${word(p.state)}`}>
                Staged
              </Pill>
            )}
            <span className="min-w-0">{source}</span>
          </div>
          {own && !own.expired && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]">
              {own.until ? (
                <Pill tone="brand">
                  <Timer className="h-3 w-3" aria-hidden />
                  until {own.until}
                </Pill>
              ) : (
                <span className="text-subtle">No end date</span>
              )}
              {!own.allowed && own.reason && <span className="text-subtle">“{own.reason}”</span>}
              {lock === null && (
                <button type="button" onClick={() => setEnding(key)} className="font-semibold text-brand hover:underline">
                  Change end
                </button>
              )}
            </div>
          )}
          {own?.expired && <div className="mt-0.5 text-[11px] text-warning">Their exception here lapsed{own.until ? ` after ${own.until}` : ""}; they are back on their role.</div>}
          {note && <div className="mt-0.5 text-[11px] text-warning">{note}</div>}
        </td>
        <td className={tdBase} />
      </tr>
    );
  };

  const moduleRows = (l: (typeof listed)[number]) => {
    const m = l.module;
    const isOpen = filtering || open.has(m.key);
    const allowed = l.keys.filter(allowedOf).length;
    const inMenu = l.sections.filter(allowedOf).length;
    const menuOn = inMenu > 0;
    const everySectionLocked = l.sections.length > 0 && l.sections.every((k) => lockOf(k) !== null);
    const setHere = [...l.sections, ...l.keys].filter((k) => stateOf(k) !== "default").length;
    const changes = [...l.sections, ...l.keys].filter(isStaged).length + (isRole ? l.sections.flatMap((k) => pagesOfSection(k, data.country)).filter((pg) => pageStaged(pg.href)).length : 0);
    const hiddenCount = isRole ? l.sections.filter(allowedOf).flatMap((k) => pagesOfSection(k, data.country)).filter((pg) => pageHidden(pg.href)).length : 0;
    const off = [...new Set([...l.sections, ...l.keys].map(noteOf).filter((n): n is string => n !== null))];
    const scope = scopes[m.key] ?? [];
    const levels = [...new Set(scope.map((s) => s.level))];
    const docsAllowed = l.docKeys.filter(allowedOf).length;
    const accessible = l.sections.length === 0 ? allowed > 0 : menuOn;
    const toggle = () =>
      setOpen((prev) => {
        const next = new Set(prev);
        if (next.has(m.key)) next.delete(m.key);
        else next.add(m.key);
        return next;
      });
    return (
      <Fragment key={m.key}>
        <tr className={cn(isOpen ? "bg-surface-sunken" : "bg-surface hover:bg-surface-sunken")}>
          <td className={cn(tdBase, "sticky left-0 z-10 bg-inherit px-3 py-1.5")}>
            <div className="flex items-center gap-2">
              <button type="button" onClick={toggle} aria-expanded={isOpen} disabled={filtering} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                {isOpen ? <ChevronDown className="h-[18px] w-[18px] shrink-0 text-subtle" aria-hidden /> : <ChevronRight className="h-[18px] w-[18px] shrink-0 text-subtle" aria-hidden />}
                <ModuleGlyph icon={m.icon} className={cn("h-[18px] w-[18px] shrink-0", accessible ? "text-text/80" : "text-subtle")} />
                <span className="min-w-0 flex-1">
                  <span className={cn("block font-semibold", accessible ? "text-text" : "text-subtle")}>{m.label}</span>
                  <span className="block truncate text-[11px] text-subtle">
                    {l.keys.length > 0 ? `${allowed} of ${l.keys.length} allowed` : "No permissions of its own"} · {m.description}
                  </span>
                </span>
              </button>
              {l.keys.length > 0 && (
                <BulkPair onWord="all" offWord="none" onTitle={`Allow every permission in ${m.label}`} offTitle={`Deny every permission in ${m.label}`} disabled={subjectLock !== null || saving} onPick={(allow) => flip(l.keys, allow)} />
              )}
            </div>
          </td>
          <td className={cn(tdBase, "px-0.5 py-1 text-center")}>
            {l.sections.length > 0 ? (
              <>
                <AnswerPill
                  on={menuOn}
                  explicit={l.sections.some((k) => stateOf(k) !== "default")}
                  staged={l.sections.some(isStaged)}
                  locked={everySectionLocked || saving}
                  label={`${m.label} in the menu`}
                  title={
                    everySectionLocked
                      ? (lockOf(l.sections[0]!) ?? undefined)
                      : `${inMenu} of ${l.sections.length} ${l.sections.length === 1 ? "section" : "sections"} in the menu. ${menuOn ? "Switch off to hide the module and refuse its pages." : "Switch on to show it."}`
                  }
                  onClick={() => flip(l.sections, !menuOn)}
                />
                {menuOn && inMenu < l.sections.length && (
                  <span className="block pt-0.5 font-mono text-[10px] leading-none text-subtle">
                    {inMenu}/{l.sections.length}
                  </span>
                )}
              </>
            ) : (
              <span className="text-subtle" title="This module has no place of its own in the menu.">
                —
              </span>
            )}
          </td>
          <td className={cn(tdBase, "px-2 py-1")}>{l.keys.length > 0 && <Meter value={allowed} max={l.keys.length} tone="green" className="mx-auto h-1.5 w-12" />}</td>
          <td colSpan={2} className={cn(tdBase, "px-3 py-1.5")}>
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-subtle">
              {changes > 0 && <Pill tone="brand">{changes} staged</Pill>}
              {setHere > 0 && <Pill>{isRole ? `${setHere} set on this role` : `${setHere} ${setHere === 1 ? "exception" : "exceptions"}`}</Pill>}
              {hiddenCount > 0 && <Pill>{`${hiddenCount} ${hiddenCount === 1 ? "page" : "pages"} hidden`}</Pill>}
              {off.length > 0 && (
                <Pill tone="amber" title={off.join("\n")}>
                  Partly off for the company
                </Pill>
              )}
              {changes === 0 && setHere === 0 && hiddenCount === 0 && off.length === 0 && <span>{isRole ? "All on the role's defaults" : "All from their role"}</span>}
            </div>
          </td>
          <td className={cn(tdBase, "whitespace-nowrap px-3 py-1.5")}>
            <div className="flex items-center gap-1">
              {scope.length > 0 && (
                <Link
                  href={acPath.scope(who)}
                  onClick={(e) => leave(e, acPath.scope(who))}
                  title={`How far its records reach for View — ${scope.map((s) => `${s.record}: ${s.level}`).join(" · ")}`}
                  className="inline-flex h-[22px] items-center gap-1 rounded-[5px] border border-line bg-surface px-2 text-[11.5px] text-text/80 transition-colors hover:border-line-strong"
                >
                  <Filter className="h-3.5 w-3.5 text-subtle" aria-hidden />
                  {levels.length === 1 ? levels[0] : "Mixed"}
                </Link>
              )}
              {m.key === "crm" && (
                <Link
                  href={acPath.fields({ ...who, entity: "leads" })}
                  onClick={(e) => leave(e, acPath.fields({ ...who, entity: "leads" }))}
                  title="Field permissions"
                  className="inline-flex h-[26px] items-center gap-1 rounded-md px-2 text-xs font-semibold text-brand transition-colors hover:bg-brand-subtle"
                >
                  <Columns3 className="h-4 w-4" aria-hidden />
                  Fields
                </Link>
              )}
              {l.docKeys.length > 0 && (
                <Link
                  href={acPath.documents(who)}
                  onClick={(e) => leave(e, acPath.documents(who))}
                  title={`Document permissions: ${docsAllowed} of ${l.docKeys.length} allowed`}
                  className="inline-flex h-[26px] items-center gap-1 rounded-md px-2 text-xs font-semibold text-brand transition-colors hover:bg-brand-subtle"
                >
                  <FileText className="h-4 w-4" aria-hidden />
                  {docsAllowed}/{l.docKeys.length} docs
                </Link>
              )}
            </div>
          </td>
        </tr>
        {isOpen && l.shownSections.map((k) => keyRow(k, true))}
        {isOpen && l.shownKeys.map((k) => keyRow(k, false))}
        {isOpen && !filtering && l.keys.length === 0 && (
          <tr className="bg-surface">
            <td colSpan={6} className={cn(tdBase, "py-2 pl-[42px] pr-3 text-xs text-subtle")}>
              Nothing to allow in this module beyond its place in the menu.
            </td>
          </tr>
        )}
        {isOpen && !filtering && (l.folded.length > 0 || m.note) && (
          <tr className="bg-surface">
            <td colSpan={6} className={cn(tdBase, "py-2 pl-[42px] pr-3 text-[11px] leading-[1.5] text-subtle")}>
              {l.folded.length > 0 && (
                <span>
                  {l.folded.map((k) => `“${byKey.get(k)?.label ?? k}”`).join(", ")} {l.folded.length === 1 ? "isn't a row" : "aren't rows"} here: how far a record reaches is its level under{" "}
                  <Link href={acPath.scope(who)} onClick={(e) => leave(e, acPath.scope(who))} className="font-semibold text-brand hover:underline">
                    Data Scope
                  </Link>
                  .{" "}
                </span>
              )}
              {m.note}
            </td>
          </tr>
        )}
      </Fragment>
    );
  };

  // ─── Beside the table ──────────────────────────────────────────────────────────────────────────
  const allKeys = layout.flatMap((l) => l.keys);
  const allSections = layout.flatMap((l) => l.sections);
  const sensitive = allKeys.filter((k) => byKey.get(k)?.tier !== "standard");
  const setCount = [...allKeys, ...allSections].filter((k) => stateOf(k) !== "default").length;
  const stats: SummaryStat[] = [
    { label: "Permissions allowed", value: allKeys.filter(allowedOf).length, of: allKeys.length },
    { label: "Menu sections shown", value: allSections.filter(allowedOf).length, of: allSections.length },
    { label: "Sensitive & critical allowed", value: sensitive.filter(allowedOf).length, of: sensitive.length },
    { label: isRole ? "Answers set on this role" : "Exceptions for them alone", value: setCount, hint: isRole ? "Everything else follows the role's defaults." : "Everything else follows their role." },
  ];
  const stagedItems: StagedItem[] = [
    ...staged.map(([key, state]): StagedItem => {
      const p = byKey.get(key)!;
      return { id: key, label: labelOf(p), where: moduleOfKey.get(key) ?? "Settings", from: word(p.state), to: word(state), tone: state === "allow" ? "green" : state === "deny" ? "red" : "neutral", undo: () => setAnswer(key, p.state) };
    }),
    ...stagedPages.map(([href, hide]): StagedItem => ({
      id: `page:${href}`,
      label: MENU_PAGES.find((pg) => pg.href === href)?.label ?? href,
      where: "Menu page",
      from: hide ? "Shown" : "Hidden",
      to: hide ? "Hidden" : "Shown",
      tone: hide ? "red" : "green",
      undo: () => setPageHidden(href, !hide),
    })),
  ];
  const links: SummaryLink[] =
    subject.kind === "role"
      ? [
          { label: "Data scope", href: acPath.scope(who) },
          { label: "Field permissions", href: acPath.fields(who) },
          { label: "Document permissions", href: acPath.documents(who) },
          { label: "Import & export", href: acPath.importExport(subject.key) },
          { label: "This role's audit log", href: acPath.audit({ role: subject.key }) },
          { label: "Compare with another role", href: acPath.compare(subject.key) },
        ]
      : [
          { label: `${subject.name}'s permissions page`, href: acPath.employee(subject.id) },
          { label: `Their role: ${subject.roleName}`, href: acPath.modules({ role: subject.roleKey }) },
          { label: "Data scope", href: acPath.scope(who) },
          { label: "Field permissions", href: acPath.fields(who) },
          { label: "Document permissions", href: acPath.documents(who) },
          { label: "Their audit log", href: acPath.audit({ user: subject.id }) },
          { label: "Simulate what they can do", href: acPath.simulator(subject.id) },
        ];

  const meta =
    subject.kind === "role"
      ? `${subject.isSystem ? "System role" : "Custom role"} · ${subject.people} ${subject.people === 1 ? "person" : "people"}${subject.active ? "" : " · switched off"}`
      : `Role: ${subject.roleName}${subject.active ? "" : " · account switched off"}`;
  const saveLabel = isRole ? "Save changes" : "Save as exceptions";
  const segment = (on: boolean) => cn("inline-flex h-[30px] items-center gap-1.5 px-2.5 text-xs font-semibold transition-colors", on ? "bg-brand-subtle text-brand" : "bg-surface text-text/80 hover:bg-surface-sunken");
  const exceptionCount = staged.filter(([, state]) => state !== "default").length;

  return (
    <AcPage
      crumb="Module Matrix"
      title="Module Permission Matrix"
      description="Every module against every permission. In menu gates the row; each answer is Default, Allow or Deny."
      actions={
        <>
          {stagedCount > 0 && <span className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-subtle px-2.5 text-xs font-semibold text-brand">{stagedCount} staged</span>}
          <button type="button" onClick={reset} disabled={clean || saving} className={acButton.secondary}>
            Reset
          </button>
          <button type="button" onClick={() => void save()} disabled={clean || saving} className={cn(acButton.primary, "px-3.5")}>
            <Save className="h-[18px] w-[18px]" aria-hidden />
            {saving ? "Saving…" : saveLabel}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <Panel className="flex flex-wrap items-center gap-2 overflow-visible px-3 py-2.5">
          <div className="inline-flex overflow-hidden rounded-md border border-line-strong">
            <button type="button" aria-pressed={isRole} onClick={() => !isRole && go(acPath.modules({ role: subject.kind === "user" ? subject.roleKey : undefined }))} className={segment(isRole)}>
              <Shield className="h-4 w-4" aria-hidden />
              Role
            </button>
            <button
              type="button"
              aria-pressed={!isRole}
              disabled={data.people.length === 0}
              onClick={() => isRole && data.people[0] && go(acPath.modules({ user: data.people[0].id }))}
              className={cn(segment(!isRole), "border-l border-line-strong")}
            >
              <User className="h-4 w-4" aria-hidden />
              Employee
            </button>
          </div>
          <select
            aria-label={isRole ? "Role" : "Employee"}
            value={subject.kind === "role" ? subject.key : subject.id}
            onChange={(e) => go(acPath.modules(isRole ? { role: e.target.value } : { user: e.target.value }))}
            className={cn(acInput, "min-w-[200px] max-w-[320px] font-semibold")}
          >
            {(isRole ? data.roles : data.people).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted">{meta}</span>
          <div className="flex-1" />
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-[7px] h-[18px] w-[18px] text-subtle" aria-hidden />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a module or permission" aria-label="Find a module or permission" className={cn(acInput, "w-[220px] pl-[30px]")} />
          </div>
          <button
            type="button"
            disabled={filtering}
            onClick={() => setOpen(allOpen ? new Set() : new Set(layout.map((l) => l.module.key)))}
            title={allOpen ? "Collapse every module" : "Expand every module"}
            aria-label={allOpen ? "Collapse every module" : "Expand every module"}
            className={acButton.icon}
          >
            {allOpen ? <ChevronsDownUp className="h-[18px] w-[18px]" aria-hidden /> : <ChevronsUpDown className="h-[18px] w-[18px]" aria-hidden />}
          </button>
          <div className="inline-flex overflow-hidden rounded-md border border-line-strong">
            {VIEWS.map((v, i) => (
              <button key={v.v} type="button" aria-pressed={view === v.v} onClick={() => setView(v.v)} className={cn(segment(view === v.v), i > 0 && "border-l border-line")}>
                {v.label}
              </button>
            ))}
          </div>
        </Panel>

        {subjectLock ? (
          <p className="flex items-center gap-2 rounded-md bg-info-bg px-3 py-2 text-xs text-info">
            <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {subjectLock} Everything here is read-only.
          </p>
        ) : (
          !viewer.isSuperAdmin && (
            <p className="flex items-center gap-2 rounded-md bg-info-bg px-3 py-2 text-xs text-info">
              <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
              Permissions you don&apos;t hold yourself, and the ones only a super admin grants, are locked for you — nobody hands out access they don&apos;t have.
            </p>
          )
        )}

        <div className="grid grid-cols-1 items-start gap-4 2xl:grid-cols-[minmax(0,1fr)_300px]">
          <Panel className="min-w-0">
            <div className="max-h-[calc(100vh-300px)] min-h-[320px] overflow-auto">
              <table className="w-full min-w-[1040px] border-collapse">
                <thead>
                  <tr>
                    <th className={cn(thBase, "left-0 z-30 min-w-[300px] px-3 py-2 text-left")}>Module · permission</th>
                    <th className={cn(thBase, "w-[76px] px-0.5 pb-1 pt-1.5 text-center text-[10.5px] leading-[1.2] tracking-[0.03em]")} title="Whether the module is in the menu at all. Off hides it and refuses its pages.">
                      <div>In menu</div>
                      <div className="mt-[3px] flex justify-center">
                        <BulkPair onWord="on" offWord="off" onTitle="Show every listed section in the menu" offTitle="Hide every listed section from the menu" disabled={subjectLock !== null || saving || listedSections.length === 0} onPick={(allow) => flip(listedSections, allow)} />
                      </div>
                    </th>
                    <th className={cn(thBase, "w-[76px] px-0.5 pb-1 pt-1.5 text-center text-[10.5px] leading-[1.2] tracking-[0.03em]")} title="What applies: the stored answer, or the default where nothing is stored.">
                      <div>Allowed</div>
                      <div className="mt-[3px] flex justify-center">
                        <BulkPair onWord="on" offWord="off" onTitle="Allow every listed permission" offTitle="Deny every listed permission" disabled={subjectLock !== null || saving || listedKeys.length === 0} onPick={(allow) => flip(listedKeys, allow)} />
                      </div>
                    </th>
                    <th className={cn(thBase, "w-[176px] px-3 py-2 text-left")}>{isRole ? "Answer on this role" : "Exception for them"}</th>
                    <th className={cn(thBase, "min-w-[230px] px-3 py-2 text-left")}>Source</th>
                    <th className={cn(thBase, "w-[180px] px-3 py-2 text-left")}>Scope</th>
                  </tr>
                </thead>
                <tbody>
                  {listed.map(moduleRows)}
                  {listed.length === 0 && (
                    <tr>
                      <td colSpan={6}>
                        <EmptyNote>{term ? `Nothing matches “${q.trim()}”.` : "No permission answers that way."}</EmptyNote>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <MatrixLegend person={!isRole} />
          </Panel>

          <MatrixSummary title={subject.name} sub={meta} stats={stats} staged={stagedItems} links={links} onUndoAll={reset} onLeave={leave} />
        </div>

        <HintNote>
          {isRole
            ? "A Deny set on a role beats its default, and a Default moves if the registry's default ever does — pin an answer with Allow or Deny to keep it. One person's exception beats whatever their role says."
            : "An exception — Allow or Deny — beats whatever their role says, for this person only, until its end date; a lapsed one falls back to the role on its own. Exceptions are logged one by one with the reason given on save."}{" "}
          In menu gates the row: with it off, the module is left out of the menu and its pages are refused at the door.
        </HintNote>

        {!clean && (
          <div className="sticky bottom-3 z-30 flex flex-wrap items-center gap-3 rounded-lg border border-line-strong bg-surface px-4 py-2.5 shadow-lg">
            <span className="text-[13px] font-semibold text-text">
              {stagedCount} staged {stagedCount === 1 ? "change" : "changes"}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted">
              {isRole ? `Not saved yet — nothing has changed for ${subject.name}.` : `Not saved yet — saved as exceptions for ${subject.name} alone.`}
            </span>
            <button type="button" onClick={reset} disabled={saving} className={acButton.secondary}>
              Discard
            </button>
            <button type="button" onClick={() => void save()} disabled={saving} className={cn(acButton.primary, "px-3.5")}>
              <Save className="h-[18px] w-[18px]" aria-hidden />
              {saving ? "Saving…" : saveLabel}
            </button>
          </div>
        )}
      </div>

      {asking && subject.kind === "user" && (
        <SaveExceptionsDialog name={subject.name} count={staged.length} removing={staged.length - exceptionCount} busy={saving} onClose={() => setAsking(false)} onSave={(options) => commit(options)} />
      )}
      {ending && subject.kind === "user" && (
        <ExceptionEndDialog name={subject.name} permission={byKey.get(ending)?.label ?? ending} until={byKey.get(ending)?.own?.until ?? null} busy={saving} onClose={() => setEnding(null)} onSave={saveEnd} />
      )}
    </AcPage>
  );
}
