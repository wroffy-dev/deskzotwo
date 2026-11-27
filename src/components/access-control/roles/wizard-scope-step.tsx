"use client";

import type { AccessLevel } from "@prisma/client";
import type { AccessRow } from "@/actions/access-levels";
import { LEVEL_WORDS } from "@/lib/authz/level-order";
import { acInput, tdClass, thClass } from "@/components/access-control/ui";
import { cn } from "@/lib/utils";

const ACTIONS = [
  { key: "view", label: "View" },
  { key: "edit", label: "Edit" },
  { key: "delete", label: "Delete" },
  { key: "assign", label: "Assign" },
] as const;

/** The value a cell's select holds: a level, or "" for "follows its permissions". */
export type ScopeChoice = AccessLevel | "";

export function scopeSlot(record: string, action: string) {
  return `${record}:${action}`;
}

/**
 * The wizard's Data scope step: which records the role reaches, one row per record type and one
 * choice per action. A cell either follows the role's permissions — what every cell does until
 * somebody chooses — or holds a level set here; only the levels a record type offers are listed
 * (contacts have no owner of their own). The design's custom scope rules have no counterpart: the
 * levels are None, Own, Team, Branch, All and "As the account".
 *
 * Nothing is saved here: the wizard saves the changed cells through `setRoleAccessLevels`.
 */
export function WizardScopeStep({
  rows,
  choices,
  lockedWhy,
  disabled,
  onChange,
}: {
  rows: AccessRow[];
  /** The cells picked since the last save. */
  choices: Map<string, ScopeChoice>;
  lockedWhy: string | null;
  disabled: boolean;
  onChange: (record: string, action: (typeof ACTIONS)[number]["key"], choice: ScopeChoice) => void;
}) {
  return (
    <div className="overflow-auto rounded-lg border border-line">
      <table className="w-full min-w-[720px] border-collapse">
        <thead>
          <tr>
            <th scope="col" className={thClass}>
              Records
            </th>
            {ACTIONS.map((a) => (
              <th key={a.key} scope="col" className={thClass}>
                {a.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row" className={cn(tdClass, "min-w-[10rem] text-left font-normal")}>
                <span className="block font-semibold text-text">{row.label}</span>
                <span className="block text-xs text-muted">Own: {row.ownMeans}</span>
              </th>
              {ACTIONS.map((a) => {
                // An action the record doesn't have — nobody deletes a project — isn't a choice.
                if (!row.actions.includes(a.key)) {
                  return (
                    <td key={a.key} className={cn(tdClass, "text-subtle")} aria-label={`${row.label}, ${a.label}: not an action it has`}>
                      —
                    </td>
                  );
                }
                const cell = row.cells[a.key];
                const slot = scopeSlot(row.key, a.key);
                const picked = choices.get(slot);
                const choice = picked ?? cell.stored ?? "";
                const edited = picked !== undefined && picked !== (cell.stored ?? "");
                return (
                  <td key={a.key} className={tdClass}>
                    <select
                      className={cn(acInput, "w-full min-w-[9.5rem] px-2 disabled:opacity-60", edited && "border-brand")}
                      value={choice}
                      disabled={disabled || lockedWhy !== null}
                      title={lockedWhy ?? (choice === "" ? `${cell.derivedFrom.held ? "Holds" : "Doesn't hold"} "${cell.derivedFrom.label}", so ${LEVEL_WORDS[cell.derived].toLowerCase()}.` : undefined)}
                      aria-label={`${row.label}, ${a.label}`}
                      onChange={(e) => onChange(row.key, a.key, e.target.value as ScopeChoice)}
                    >
                      <option value="">As its permissions — {LEVEL_WORDS[cell.derived]}</option>
                      {row.levels.map((level) => (
                        <option key={level} value={level}>
                          {LEVEL_WORDS[level]}
                        </option>
                      ))}
                    </select>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
