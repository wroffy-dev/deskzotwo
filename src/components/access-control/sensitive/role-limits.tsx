"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import type { RoleLimitRow } from "@/actions/access-control-sensitive";
import { setRoleUnmaskLimit } from "@/actions/field-access";
import { acPath } from "@/lib/access-control/nav";
import { Dialog } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { Panel, PanelHeader, Pill, acButton, acInput, rowHoverClass, tdClass, thClass } from "@/components/access-control/ui";
import { LIMIT_PRESETS } from "@/components/access-control/sensitive/default-limit";
import { cn } from "@/lib/utils";

/** The three things a role's limit can be: nothing set (the workspace default), an explicit "no limit", or a number. */
type LimitChoice = "default" | "none" | "number";

const words = (limit: number | null) => (limit === null ? "no limit" : `${limit} a day`);

/**
 * Each role's daily unmasking limit — what its people get when they have no limit of their own. Nothing
 * set on a role is the workspace default for everybody in it who may unmask anything; "No limit" has to
 * be chosen. Admin's is a super admin's to change, as everything else about that role is.
 */
export function RoleLimitsPanel({ roles, workspaceDefault }: { roles: RoleLimitRow[]; workspaceDefault: number | null }) {
  const [editing, setEditing] = useState<RoleLimitRow | null>(null);
  return (
    <Panel id="role-limits" className="scroll-mt-4">
      <PanelHeader title="Limits by role" meta={<span className="text-xs text-subtle">what a role&apos;s people get without a limit of their own</span>} />
      <div className="overflow-auto">
        <table className="w-full min-w-[640px] border-collapse">
          <thead>
            <tr>
              <th className={thClass}>Role</th>
              <th className={cn(thClass, "text-right")}>People</th>
              <th className={cn(thClass, "text-right")}>Daily limit</th>
              <th className={thClass}>Comes from</th>
              <th className={cn(thClass, "w-[60px]")} />
            </tr>
          </thead>
          <tbody>
            {roles.map((r) => {
              const applies = r.stored ? r.dailyLimit : workspaceDefault;
              return (
                <tr key={r.key} className={rowHoverClass}>
                  <td className={tdClass}>
                    <Link href={acPath.fields({ role: r.key })} className="font-semibold text-text hover:text-brand">
                      {r.name}
                    </Link>
                    {!r.active && <Pill className="ml-2">Switched off</Pill>}
                  </td>
                  <td className={cn(tdClass, "text-right tabular-nums text-text/80")}>{r.people}</td>
                  <td className={cn(tdClass, "whitespace-nowrap text-right font-semibold tabular-nums")}>{applies === null ? "No limit" : applies}</td>
                  <td className={tdClass}>
                    {r.stored ? (
                      <Pill tone={r.dailyLimit === null ? "amber" : "brand"}>{r.dailyLimit === null ? "No limit, chosen for this role" : "Set on this role"}</Pill>
                    ) : (
                      <Pill>Workspace default</Pill>
                    )}
                  </td>
                  <td className={cn(tdClass, "text-right")}>
                    <button
                      type="button"
                      title={r.lockedWhy ?? "Edit role limit"}
                      aria-label={`Edit ${r.name}'s daily limit`}
                      disabled={r.lockedWhy !== null}
                      onClick={() => setEditing(r)}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text/80 transition-colors hover:bg-surface-sunken disabled:pointer-events-none disabled:opacity-35"
                    >
                      <Pencil className="h-4 w-4" aria-hidden />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {editing && <RoleLimitDialog key={editing.key} role={editing} workspaceDefault={workspaceDefault} onClose={() => setEditing(null)} />}
    </Panel>
  );
}

function RoleLimitDialog({ role, workspaceDefault, onClose }: { role: RoleLimitRow; workspaceDefault: number | null; onClose: () => void }) {
  const router = useRouter();
  const [choice, setChoice] = useState<LimitChoice>(!role.stored ? "default" : role.dailyLimit === null ? "none" : "number");
  const [value, setValue] = useState(role.dailyLimit === null ? "" : String(role.dailyLimit));
  const [pending, start] = useTransition();
  const defaultWords = words(workspaceDefault);

  const save = () => {
    if (choice === "number" && value.trim() === "") {
      toast.error("Enter how many a day, or choose the workspace default or no limit.");
      return;
    }
    start(async () => {
      const result = await setRoleUnmaskLimit(role.key, choice === "default" ? "default" : choice === "none" ? null : value);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(`${role.name}: ${choice === "default" ? `the workspace default (${defaultWords})` : choice === "none" ? "no daily limit" : `${value} a day`}`);
      onClose();
      router.refresh();
    });
  };

  return (
    <Dialog open onClose={onClose} title={`Unmasking limit (daily) · ${role.name}`}>
      <div className="space-y-4 text-[13px] text-text">
        <p className="leading-[1.5] text-muted">
          How many different leads, contacts and companies each person in this role may unmask in one day, together. Unmasking a lead&apos;s email, phone and company together
          counts once, as does a contact&apos;s or a company&apos;s; opening it again the same day counts nothing. Nothing set on the role is the workspace&apos;s default —{" "}
          {defaultWords} — for everybody in it who may unmask anything; &ldquo;No limit&rdquo; has to be chosen.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label htmlFor="ac-role-limit-choice" className="block text-xs font-semibold text-text/80">
              Limit
            </label>
            <select id="ac-role-limit-choice" value={choice} disabled={pending} onChange={(e) => setChoice(e.target.value as LimitChoice)} className={cn(acInput, "min-w-[14rem] px-2")}>
              <option value="default">Workspace default ({defaultWords})</option>
              <option value="number">A number a day</option>
              <option value="none">No limit</option>
            </select>
          </div>
          {choice === "number" && (
            <div className="space-y-1">
              <label htmlFor="ac-role-limit" className="block text-xs font-semibold text-text/80">
                Leads, contacts and companies a day
              </label>
              <input id="ac-role-limit" inputMode="numeric" value={value} disabled={pending} onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))} placeholder="How many" className={cn(acInput, "w-32")} />
            </div>
          )}
        </div>
        {choice === "number" && (
          <div className="flex gap-1.5">
            {LIMIT_PRESETS.map((n) => (
              <button key={n} type="button" onClick={() => setValue(String(n))} className="h-8 rounded-md border border-line px-2.5 text-xs text-muted transition-colors hover:bg-surface-sunken">
                {n}
              </button>
            ))}
          </div>
        )}
        <p className="text-xs text-subtle">
          Applies to {role.people} {role.people === 1 ? "person" : "people"} in {role.name} — except anybody with a limit of their own.
        </p>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className={acButton.secondary}>
            Cancel
          </button>
          <button type="button" onClick={save} disabled={pending} className={acButton.primary}>
            {pending ? "Saving…" : "Save limit"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
