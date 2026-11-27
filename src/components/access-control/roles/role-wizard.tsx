"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDownUp, ArrowLeft, ArrowRight, Check, CirclePlus, Columns3, Copy, Filter, Grid3x3, LayoutTemplate, Lock, Shield, TriangleAlert, type LucideIcon } from "lucide-react";
import { createRole, duplicateRole, updateRole } from "@/actions/role";
import { setRolePermissions } from "@/actions/permission";
import { setRoleAccessLevels } from "@/actions/access-levels";
import { claimsMoreThan, LEVEL_WORDS, UNDER } from "@/lib/authz/level-order";
import { acPath } from "@/lib/access-control/nav";
import { confirmAction } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { AcPage, HintNote, Panel, acButton, acInput, acToneOf } from "@/components/access-control/ui";
import { PresetPicker } from "@/components/access-control/roles/preset-picker";
import { MODULE_ICON, WizardModulesStep } from "@/components/access-control/roles/wizard-modules-step";
import { WizardScopeStep, scopeSlot, type ScopeChoice } from "@/components/access-control/roles/wizard-scope-step";
import type { WizardRole, WizardStart, WizardViewer } from "@/components/access-control/roles/types";
import { cn } from "@/lib/utils";

type StartFrom = "blank" | "copy" | "preset";
type ScopeAction = "view" | "edit" | "delete" | "assign";

const STARTS: { key: StartFrom; label: string; description: string; icon: LucideIcon }[] = [
  { key: "blank", label: "Blank role", description: "Holds nothing but the menu sections until you allow permissions.", icon: CirclePlus },
  { key: "copy", label: "Copy an existing role", description: "Starts with everything another role grants, reaches and masks.", icon: Copy },
  { key: "preset", label: "From a built-in profile", description: "Starts with the permissions a ready-made job profile lists.", icon: LayoutTemplate },
];

const labelClass = "text-xs font-semibold text-text/80";
const eyebrowClass = "mb-2 text-[11px] font-bold uppercase tracking-[0.04em] text-subtle";

/**
 * Create / Edit Role: the design's four-step wizard (Basics, Modules, Data scope, Review) over the
 * real actions. The design's "Sensitive fields" step is left to Field Permissions, which the Review
 * step links to; its category, colour, icon, drafts and role inheritance have no counterpart here.
 *
 * A role must exist before permissions can be set on it, so creating one happens when the first
 * step is left: `createRole`, `duplicateRole` for a copy, or `createRole` then `setRolePermissions`
 * for a built-in profile. From then on — and for a role opened with `?role=` — each step saves on
 * Continue, through `updateRole`, `setRolePermissions` and `setRoleAccessLevels`, with every rule
 * those apply. What the viewer can't change is locked with the server's own reason.
 */
export function RoleWizard({
  role,
  start,
  viewer,
  labels,
  initialStep,
  justCreated,
}: {
  /** The role being edited; null while a new one hasn't been created yet. */
  role: WizardRole | null;
  start: WizardStart;
  viewer: WizardViewer | null;
  /** Permission key → label, for a preset's preview. */
  labels: Record<string, string>;
  initialStep: number;
  /** Opened straight after step one created the role, so the wording stays "Create". */
  justCreated: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = useState(role ? initialStep : 0);
  const [pending, startTransition] = useTransition();

  // Step 1
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [startFrom, setStartFrom] = useState<StartFrom>("blank");
  const [sourceKey, setSourceKey] = useState(start.sources.find((s) => s.key !== "ADMIN")?.key ?? start.sources[0]?.key ?? "");
  const [presetKey, setPresetKey] = useState(start.presets[0]?.key ?? "");
  // Step 2: the answers chosen since the last save, over what the role holds.
  const [edits, setEdits] = useState<Map<string, boolean>>(() => new Map());
  // Step 3: the cells chosen since the last save.
  const [levels, setLevels] = useState<Map<string, ScopeChoice>>(() => new Map());

  const savedHeld = useMemo(() => new Set(role?.held ?? []), [role?.held]);
  const viewerHolds = useMemo(() => new Set(viewer?.holds ?? []), [viewer?.holds]);
  const holds = (key: string) => edits.get(key) ?? savedHeld.has(key);

  const nameError = touched && name.trim().length < 2 ? "Role name is required." : serverError;
  const basicsDirty = role !== null && (name.trim() !== role.name || description.trim() !== (role.description ?? ""));
  const permissionChanges = [...edits].filter(([key, allowed]) => allowed !== savedHeld.has(key)).map(([key, allowed]) => ({ key, allowed }));
  const levelChanges = (role?.grid ?? []).flatMap((row) =>
    row.actions.flatMap((action) => {
      const choice = levels.get(scopeSlot(row.key, action));
      const saved = row.cells[action].stored ?? "";
      return choice === undefined || choice === saved ? [] : [{ record: row.key, action, level: choice === "" ? null : choice }];
    }),
  );
  const unsaved = (basicsDirty ? 1 : 0) + permissionChanges.length + levelChanges.length;

  /** Why a permission can't be changed for this role — the checks `setRolePermissions` makes, said first. */
  const lockOf = (key: string): string | null => {
    if (!role || !viewer) return null;
    if (role.key === "ADMIN" && !viewer.isSuperAdmin) return "Only a super admin can change what admins can do.";
    if (viewer.isSuperAdmin) return null;
    if (role.modules.some((m) => m.permissions.some((p) => p.key === key && p.superAdminOnly))) return "Only a super admin can grant this permission.";
    if (!viewerHolds.has(key)) return "You don't hold this yourself, so you can't change it for a role.";
    if (role.key === viewer.role && viewer.ownAccessThroughRole.includes(key) && savedHeld.has(key)) {
      return "You hold this through this role. Taking it away would lock you out of putting it back.";
    }
    return null;
  };
  const adminLocked = role !== null && viewer !== null && role.key === "ADMIN" && !viewer.isSuperAdmin;

  function chooseLevel(record: string, action: ScopeAction, choice: ScopeChoice) {
    setLevels((prev) => {
      const next = new Map(prev).set(scopeSlot(record, action), choice);
      const row = role?.grid.find((r) => r.key === record);
      if (!row) return next;
      const effective = (a: ScopeAction) => {
        const picked = next.get(scopeSlot(record, a));
        const cell = row.cells[a];
        return picked === undefined ? (cell.stored ?? cell.derived) : picked === "" ? cell.derived : picked;
      };
      // Narrowing View narrows what sits under it, as the engine and the server would.
      for (const dependent of ["edit", "delete", "assign"] as const) {
        if (!row.actions.includes(dependent)) continue;
        for (const parent of UNDER[dependent]) if (claimsMoreThan(effective(dependent), effective(parent))) next.set(scopeSlot(record, dependent), effective(parent));
      }
      return next;
    });
  }

  // ─── Saving ──────────────────────────────────────────────────────────────────────────────────

  /** Step one of a new role: make it, then carry on in the same wizard, now editing it. */
  async function create() {
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setTouched(true);
      return;
    }
    setServerError(null);
    const made = startFrom === "copy" ? await duplicateRole({ from: sourceKey, name, description }) : await createRole({ name, description });
    if (!made.ok) {
      setServerError(made.error);
      toast.error(made.error);
      return;
    }
    const preset = startFrom === "preset" ? start.presets.find((p) => p.key === presetKey) : undefined;
    if (preset) {
      // The profile's list, granted through the same action a tick in the matrix uses — so nobody
      // hands out a key they don't hold. Refused, the role stays as a blank one and says so.
      const applied = await setRolePermissions(
        made.data.key,
        preset.permissions.map((key) => ({ key, allowed: true })),
      );
      if (applied.ok) toast.success(`Role ${trimmed} created from “${preset.label}”`);
      else toast.error(`Role ${trimmed} was created holding nothing yet — the profile couldn't be applied. ${applied.error}`);
    } else {
      toast.success(startFrom === "copy" ? `Role ${trimmed} created as a copy of ${start.sources.find((s) => s.key === sourceKey)?.name ?? sourceKey}` : `Role ${trimmed} created`);
    }
    router.replace(`${acPath.wizard(made.data.key)}&step=2&created=1`);
  }

  async function saveBasics(): Promise<boolean> {
    if (!role) return false;
    if (name.trim().length < 2) {
      setTouched(true);
      return false;
    }
    if (!basicsDirty) return true;
    setServerError(null);
    const r = await updateRole({ key: role.key, name, description });
    if (!r.ok) {
      setServerError(r.error);
      toast.error(r.error);
      return false;
    }
    toast.success(`Role ${name.trim()} saved`);
    router.refresh();
    return true;
  }

  async function saveModules(): Promise<boolean> {
    if (!role) return false;
    if (permissionChanges.length === 0) return true;
    const r = await setRolePermissions(role.key, permissionChanges);
    router.refresh();
    if (!r.ok) {
      toast.error(r.error);
      return false;
    }
    toast.success(`Saved ${r.data.changed} permission change${r.data.changed === 1 ? "" : "s"}`);
    return true;
  }

  async function saveScope(): Promise<boolean> {
    if (!role) return false;
    if (levelChanges.length === 0) return true;
    const r = await setRoleAccessLevels(role.key, levelChanges);
    router.refresh();
    if (!r.ok) {
      toast.error(r.error);
      return false;
    }
    toast.success(`Saved ${r.data.changed} data scope change${r.data.changed === 1 ? "" : "s"}`);
    return true;
  }

  const next = () =>
    startTransition(async () => {
      if (!role) {
        await create();
        return;
      }
      const ok = step === 0 ? await saveBasics() : step === 1 ? await saveModules() : step === 2 ? await saveScope() : true;
      if (ok) setStep((s) => Math.min(LAST, s + 1));
    });

  const finish = () =>
    startTransition(async () => {
      if (!role) return;
      if (unsaved > 0) {
        const yes = await confirmAction({
          title: "Leave with unsaved changes?",
          message: `${unsaved} change${unsaved === 1 ? " hasn't" : "s haven't"} been saved. Go back to the step and press Continue to save, or leave and discard.`,
          confirmLabel: "Discard and leave",
          danger: true,
        });
        if (!yes) return;
      }
      if (justCreated) toast.success(`Role ${role.name} is ready`);
      router.push(acPath.roles());
    });

  // ─── What the steps show ─────────────────────────────────────────────────────────────────────

  const creating = role === null || justCreated;
  const modulesWithAccess = (role?.modules ?? []).filter((m) => m.permissions.some((p) => holds(p.key)));
  const allowedCount = (role?.modules ?? []).reduce((n, m) => n + m.permissions.filter((p) => holds(p.key)).length, 0);
  const permissionCount = (role?.modules ?? []).reduce((n, m) => n + m.permissions.length, 0);
  const viewOf = (row: WizardRole["grid"][number]) => {
    const picked = levels.get(scopeSlot(row.key, "view"));
    const cell = row.cells.view;
    return picked === undefined ? (cell.stored ?? cell.derived) : picked === "" ? cell.derived : picked;
  };
  const reached = (role?.grid ?? []).filter((row) => viewOf(row) !== "NONE");

  const steps: { label: string; sub: string; dirty: boolean }[] = [
    { label: "Basics", sub: role ? "Name and description" : "Name, description, start", dirty: basicsDirty },
    { label: "Modules", sub: modulesWithAccess.length ? `${modulesWithAccess.length} ${modulesWithAccess.length === 1 ? "module" : "modules"} with access` : "Permissions per module", dirty: permissionChanges.length > 0 },
    { label: "Data scope", sub: "Which records", dirty: levelChanges.length > 0 },
    { label: "Review", sub: "Check and finish", dirty: false },
  ];
  const titles: [string, string][] = [
    ["Role basics", "Give the role a name people will recognise in the assignment dropdown."],
    ["Module access", "Allow what the role may do, module by module. Everything is adjustable later in the matrix."],
    ["Data scope per record type", "Permissions say what the role can do; scope says on which records."],
    ["Review", creating ? "The role exists as shown. Fine-tune fields in Field Permissions." : "Each step saved as you continued; this is the role for everyone who holds it."],
  ];
  const stepDirty = steps[step]?.dirty ?? false;
  const chosenPreset = start.presets.find((p) => p.key === presetKey);

  return (
    <AcPage
      crumb={creating ? "Create Role" : "Edit Role"}
      title={creating ? "Create Role" : `Edit Role · ${role?.name ?? ""}`}
      description={
        role === null
          ? "Four short steps. The role is created when you leave the first, and each later step saves as you continue."
          : justCreated
            ? `${role.name} is created and holds what is shown. Each step saves as you continue.`
            : `Changes apply to ${role.people} ${role.people === 1 ? "employee" : "employees"} as soon as a step is saved.`
      }
      actions={
        <Link href={acPath.roles()} className={acButton.secondary}>
          {role === null ? "Cancel" : "Back to roles"}
        </Link>
      }
    >
      <div className="grid max-w-[1100px] grid-cols-1 items-start gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
        <Panel className="flex flex-row gap-0.5 overflow-auto p-2 lg:flex-col">
          {steps.map((s, i) => {
            const locked = role === null && i > 0;
            const done = role !== null && i < step;
            return (
              <button
                key={s.label}
                type="button"
                disabled={locked || pending}
                aria-current={step === i ? "step" : undefined}
                title={locked ? "Available once the role is created" : undefined}
                onClick={() => setStep(i)}
                className={cn(
                  "flex min-w-[160px] shrink-0 items-center gap-2.5 rounded-md px-2.5 py-[9px] text-left transition-colors disabled:cursor-not-allowed",
                  step === i ? "bg-brand-subtle" : "hover:bg-surface-sunken",
                  locked && "opacity-55 hover:bg-transparent",
                )}
              >
                <span
                  className={cn(
                    "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold",
                    done ? "bg-success text-white" : step === i ? "bg-brand text-brand-contrast" : "bg-surface-sunken text-muted",
                  )}
                >
                  {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : i + 1}
                </span>
                <span className="min-w-0">
                  <span className={cn("block text-[12.5px] font-semibold", step === i ? "text-brand" : "text-text/80")}>{s.label}</span>
                  <span className={cn("block truncate text-[11px]", s.dirty ? "font-semibold text-warning" : "text-subtle")}>{s.dirty ? "Unsaved changes" : s.sub}</span>
                </span>
              </button>
            );
          })}
        </Panel>

        <Panel className="min-w-0">
          <div className="border-b border-line px-5 py-4">
            <div className="text-[15px] font-bold text-text">{titles[step]?.[0]}</div>
            <div className="mt-0.5 text-[12.5px] text-muted">{titles[step]?.[1]}</div>
          </div>

          <div className="p-5">
            {step === 0 && (
              <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-4">
                <div className="flex flex-col gap-[5px]">
                  <label htmlFor="ac-role-name" className={labelClass}>
                    Role name <span className="text-danger">*</span>
                  </label>
                  <input
                    id="ac-role-name"
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      setServerError(null);
                    }}
                    maxLength={60}
                    autoComplete="off"
                    placeholder="e.g. Regional Sales Lead"
                    className={cn(acInput, "h-9 text-sm font-semibold", nameError && "border-danger")}
                  />
                  {nameError && <span className="text-xs text-danger">{nameError}</span>}
                </div>
                <div className="flex flex-col gap-[5px]">
                  <span className={labelClass}>Key</span>
                  {role ? (
                    <>
                      <code className="flex h-9 items-center rounded-md border border-line bg-surface-sunken/60 px-2.5 font-mono text-xs text-text/80">{role.key}</code>
                      <span className="text-xs text-muted">Never changes, so renaming changes nothing anyone holds.</span>
                    </>
                  ) : (
                    <>
                      <code className="flex h-9 items-center rounded-md border border-line bg-surface-sunken/60 px-2.5 font-mono text-xs text-subtle">{keyPreview(name) || "—"}</code>
                      <span className="text-xs text-muted">Built from the name once, when the role is created, and never changed after.</span>
                    </>
                  )}
                </div>
                <div className="col-span-full flex flex-col gap-[5px]">
                  <label htmlFor="ac-role-description" className={labelClass}>
                    Description
                  </label>
                  <textarea
                    id="ac-role-description"
                    rows={2}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="What this role is for, in one sentence"
                    className={cn(acInput, "h-auto resize-y py-2 leading-[1.5]")}
                  />
                </div>

                {role === null && (
                  <div className="col-span-full flex flex-col gap-2">
                    <span className={labelClass}>Start from</span>
                    <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-2">
                      {STARTS.map((s) => {
                        const on = startFrom === s.key;
                        const unavailable = (s.key === "copy" && start.sources.length === 0) || (s.key === "preset" && start.presets.length === 0);
                        return (
                          <button
                            key={s.key}
                            type="button"
                            aria-pressed={on}
                            disabled={unavailable}
                            onClick={() => setStartFrom(s.key)}
                            className={cn("flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors disabled:opacity-45", on ? "border-brand bg-brand-subtle" : "border-line bg-surface hover:border-line-strong")}
                          >
                            <s.icon className={cn("mt-px h-[18px] w-[18px] shrink-0", on ? "text-brand" : "text-muted")} aria-hidden />
                            <span>
                              <span className="block font-semibold text-text">{s.label}</span>
                              <span className="mt-0.5 block text-xs leading-[1.45] text-muted">{s.description}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {startFrom === "copy" && (
                      <>
                        <select aria-label="Role to copy" value={sourceKey} onChange={(e) => setSourceKey(e.target.value)} className={cn(acInput, "h-[34px] max-w-[360px] px-2")}>
                          {start.sources.map((s) => (
                            <option key={s.key} value={s.key}>
                              {s.name}
                            </option>
                          ))}
                        </select>
                        <InfoNote icon={Copy}>
                          The new role starts with what {start.sources.find((s) => s.key === sourceKey)?.name ?? "that role"} grants, how far it reaches, its field access and its daily unmask limit. It
                          is a copy, not a child: later changes to either role don&apos;t reach the other, and nobody is moved to it. A copy holding more than you do yourself is refused.
                        </InfoNote>
                      </>
                    )}
                    {startFrom === "preset" && (
                      <>
                        <select aria-label="Built-in profile" value={presetKey} onChange={(e) => setPresetKey(e.target.value)} className={cn(acInput, "h-[34px] max-w-[360px] px-2")}>
                          {start.presets.map((p) => (
                            <option key={p.key} value={p.key}>
                              {p.label} · {p.roleName}
                            </option>
                          ))}
                        </select>
                        {chosenPreset && (
                          <InfoNote icon={LayoutTemplate}>
                            {chosenPreset.description} Grants the {chosenPreset.permissions.length} permissions this profile lists; data scope and field access start as a blank role&apos;s. A profile
                            holding a permission you don&apos;t hold yourself is refused, and the role is then left blank.
                          </InfoNote>
                        )}
                      </>
                    )}
                    <HintNote>A role has to exist before permissions can be set on it: Continue creates it, and the next steps then edit the role you just made.</HintNote>
                  </div>
                )}
              </div>
            )}

            {step === 1 && role && (
              <div className="flex flex-col gap-3.5">
                {adminLocked && <LockedNote>Only a super admin can change what admins can do.</LockedNote>}
                {role.presets.length > 0 && (
                  <details className="rounded-lg border border-line">
                    <summary className="cursor-pointer px-3 py-2 text-xs font-bold text-text/80">
                      Start from a preset <span className="ml-1 font-normal text-subtle">{role.presets.length} written for this role</span>
                    </summary>
                    <div className="border-t border-line p-3">
                      <PresetPicker presets={role.presets} labels={labels} mayManage={!adminLocked} onApplied={() => setEdits(new Map())} />
                    </div>
                  </details>
                )}
                <WizardModulesStep
                  modules={role.modules}
                  holds={holds}
                  saved={(key) => savedHeld.has(key)}
                  lockOf={lockOf}
                  disabled={pending}
                  onSet={(changes) =>
                    setEdits((prev) => {
                      const nextEdits = new Map(prev);
                      for (const c of changes) nextEdits.set(c.key, c.allowed);
                      return nextEdits;
                    })
                  }
                />
                <p className="text-xs text-muted">
                  Which menu sections the role sees, and the conditions on each action, are set in the{" "}
                  <Link href={acPath.modules({ role: role.key })} className="font-semibold text-brand hover:underline">
                    Module Matrix
                  </Link>
                  . Enforced on the server for every request — not just hidden in the menu.
                </p>
              </div>
            )}

            {step === 2 && role && (
              <div className="flex flex-col gap-2.5">
                <div className="text-[12.5px] leading-[1.5] text-muted">
                  Which records the role reaches, for each action. “As its permissions” follows what the role&apos;s permissions mean; a level set here replaces it. Edit, delete and assign
                  can&apos;t reach wider than view, and nobody gives a role wider reach than their own.
                </div>
                {role.gridWhy && <LockedNote>{role.gridWhy}</LockedNote>}
                {role.grid.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-line-strong p-6 text-center text-subtle">This role&apos;s records can&apos;t be read.</div>
                ) : (
                  <WizardScopeStep rows={role.grid} choices={levels} lockedWhy={role.gridWhy} disabled={pending} onChange={chooseLevel} />
                )}
                <p className="text-xs text-muted">
                  The same grid, with who it reaches, is in{" "}
                  <Link href={acPath.scope({ role: role.key })} className="font-semibold text-brand hover:underline">
                    Data Scope
                  </Link>
                  .
                </p>
              </div>
            )}

            {step === 3 && role && (
              <div className="flex flex-col gap-4">
                <div className="flex items-center gap-3">
                  <span className={cn("inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] text-white", acToneOf(role.key))}>
                    <Shield className="h-6 w-6" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <div className="text-base font-bold text-text">{role.name}</div>
                    <div className="text-[12.5px] text-muted">
                      {role.isSystem ? "System role" : "Custom role"} · {role.description || "No description"}
                    </div>
                  </div>
                </div>

                {unsaved > 0 && (
                  <HintNote>
                    {unsaved} change{unsaved === 1 ? " is" : "s are"} not saved yet and {unsaved === 1 ? "is" : "are"} counted below. Go back to the step marked “Unsaved changes” and press Continue to
                    save.
                  </HintNote>
                )}

                <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2">
                  {[
                    { label: `of ${role.modules.length} modules with access`, value: modulesWithAccess.length, tone: "text-text" },
                    { label: `of ${permissionCount} permissions allowed`, value: allowedCount, tone: "text-success" },
                    { label: `of ${role.grid.length} record types reached`, value: reached.length, tone: "text-text" },
                    { label: role.people === 1 ? "employee affected" : "employees affected", value: role.people, tone: "text-text" },
                  ].map((s) => (
                    <div key={s.label} className="rounded-lg bg-surface-sunken p-3">
                      <div className={cn("text-[22px] font-bold tracking-[-0.02em]", s.tone)}>{s.value}</div>
                      <div className="text-xs text-muted">{s.label}</div>
                    </div>
                  ))}
                </div>

                <div>
                  <div className={eyebrowClass}>Modules</div>
                  {modulesWithAccess.length === 0 ? (
                    <p className="text-[12.5px] text-subtle">None yet.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {modulesWithAccess.map((m) => {
                        const Icon = MODULE_ICON[m.icon];
                        const n = m.permissions.filter((p) => holds(p.key)).length;
                        const full = n === m.permissions.length;
                        return (
                          <span key={m.key} className="inline-flex h-[26px] items-center gap-1.5 rounded-md bg-surface-sunken px-2.5 text-xs text-text">
                            <Icon className="h-[15px] w-[15px] text-muted" aria-hidden />
                            {m.label}
                            <span className={cn("font-bold", full ? "text-brand" : "text-text/80")}>{full ? "Full" : `${n}/${m.permissions.length}`}</span>
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div>
                  <div className={eyebrowClass}>Data scope</div>
                  {reached.length === 0 ? (
                    <p className="text-[12.5px] text-subtle">Reaches no records yet.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {reached.map((row) => (
                        <span key={row.key} className="inline-flex h-[26px] items-center gap-1.5 rounded-md bg-surface-sunken px-2.5 text-xs text-text">
                          {row.label}
                          <span className="text-subtle">· {LEVEL_WORDS[viewOf(row)]}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <div className={eyebrowClass}>Sensitive fields</div>
                  <div className="text-[12.5px] leading-[1.6] text-text/80">
                    Which lead, contact and company fields this role sees, masks and may unmask — and its daily unmask limit — are set per field in{" "}
                    <Link href={acPath.fields({ role: role.key })} className="font-semibold text-brand hover:underline">
                      Field Permissions
                    </Link>
                    .
                  </div>
                </div>

                <div>
                  <div className={eyebrowClass}>Fine-tune</div>
                  <div className="flex flex-wrap gap-2">
                    <Link href={acPath.modules({ role: role.key })} className={acButton.secondary}>
                      <Grid3x3 className="h-[18px] w-[18px]" aria-hidden />
                      Module Matrix
                    </Link>
                    <Link href={acPath.fields({ role: role.key })} className={acButton.secondary}>
                      <Columns3 className="h-[18px] w-[18px]" aria-hidden />
                      Field Permissions
                    </Link>
                    <Link href={acPath.scope({ role: role.key })} className={acButton.secondary}>
                      <Filter className="h-[18px] w-[18px]" aria-hidden />
                      Data Scope
                    </Link>
                    <Link href={acPath.importExport(role.key)} className={acButton.secondary}>
                      <ArrowDownUp className="h-[18px] w-[18px]" aria-hidden />
                      Import &amp; Export
                    </Link>
                  </div>
                </div>

                {allowedCount === 0 && (
                  <div className="flex gap-2 rounded-md bg-danger-bg px-3 py-2.5 text-[12.5px] leading-[1.5] text-danger">
                    <TriangleAlert className="h-[18px] w-[18px] shrink-0" aria-hidden />
                    <span>No permissions allowed. People with this role will see its menu sections and be able to do nothing in them.</span>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-line/70 bg-surface-sunken/60 px-5 py-3">
            <button type="button" className={acButton.secondary} disabled={step === 0 || pending} onClick={() => setStep((s) => Math.max(0, s - 1))}>
              <ArrowLeft className="h-[18px] w-[18px]" aria-hidden />
              Back
            </button>
            <div className="flex-1" />
            {role !== null && stepDirty && <span className="text-xs font-medium text-warning">Unsaved changes on this step</span>}
            {step < LAST ? (
              <button type="button" className={cn(acButton.primary, "px-3.5")} disabled={pending} onClick={next}>
                {pending ? "Saving…" : role === null ? "Create role & continue" : stepDirty ? "Save & continue" : "Continue"}
                <ArrowRight className="h-[18px] w-[18px]" aria-hidden />
              </button>
            ) : (
              <button
                type="button"
                disabled={pending}
                onClick={finish}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-success bg-success px-3.5 text-[13px] font-semibold text-white transition hover:brightness-110 disabled:pointer-events-none disabled:opacity-45"
              >
                <Check className="h-[18px] w-[18px]" aria-hidden />
                {justCreated ? "Finish" : "Done"}
              </button>
            )}
          </div>
        </Panel>
      </div>
    </AcPage>
  );
}

const LAST = 3;

/** What `createRole` will make of a name: "Regional Manager" → REGIONAL_MANAGER. Shown, never sent — the server builds the real one. */
function keyPreview(name: string) {
  return name
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase()
    .slice(0, 40);
}

function InfoNote({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 rounded-md bg-brand-subtle px-3 py-2.5 text-[12.5px] leading-[1.5] text-brand">
      <Icon className="mt-px h-[18px] w-[18px] shrink-0" aria-hidden />
      <span>{children}</span>
    </div>
  );
}

function LockedNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 rounded-md bg-info-bg px-3 py-2.5 text-[12.5px] leading-[1.5] text-info">
      <Lock className="mt-px h-[18px] w-[18px] shrink-0" aria-hidden />
      <span>{children}</span>
    </div>
  );
}
