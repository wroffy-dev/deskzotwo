"use client";

import { useCallback, useMemo, useState } from "react";
import type { AccessLevel } from "@prisma/client";
import type { AccessAction } from "@/lib/authz/access";
import { claimsMoreThan, UNDER } from "@/lib/authz/level-order";
import { REACH_ACTIONS, type ReachChange, type ReachRow } from "@/components/access-control/scope/reach";

const slotOf = (record: string, action: string) => `${record}:${action}`;

/**
 * Record levels chosen but not saved yet — the staged half of both screens.
 *
 * The rules are the ones the role and person editors already kept, and the save actions enforce
 * (src/actions/access-levels.ts, person-access.ts): edit never reaches wider than view, nor delete and
 * assign wider than edit. Narrowing what an action sits under narrows the action with it, as the
 * engine would; a level that would claim more than the one above it is not offered at all.
 */
export function useReachDraft(rows: ReachRow[]) {
  const [picked, setPicked] = useState<Map<string, AccessLevel | null>>(() => new Map());
  const rowOf = useMemo(() => new Map(rows.map((r) => [r.key as string, r])), [rows]);

  /** What is set here after the draft: a level, or null where it follows its base. */
  const setOf = (row: ReachRow, action: AccessAction): AccessLevel | null => {
    const s = slotOf(row.key, action);
    return picked.has(s) ? picked.get(s)! : row.cells[action].set;
  };
  /** What the grid says after the draft — the level set, or the base under it. */
  const configured = (row: ReachRow, action: AccessAction): AccessLevel => setOf(row, action) ?? row.cells[action].base;
  /** What to draw: the engine's answer until the cell is touched, then what was chosen. */
  const levelOf = (row: ReachRow, action: AccessAction): AccessLevel => (picked.has(slotOf(row.key, action)) ? configured(row, action) : row.cells[action].effective);
  const isChanged = (row: ReachRow, action: AccessAction) => {
    const s = slotOf(row.key, action);
    return picked.has(s) && picked.get(s) !== row.cells[action].set;
  };

  /** The action this choice would be wider than, if any — "Edit can't be wider than View". */
  const blockedBy = (row: ReachRow, action: AccessAction, choice: AccessLevel | null): { action: AccessAction; level: AccessLevel } | null => {
    const resulting = choice ?? row.cells[action].base;
    for (const parent of UNDER[action]) {
      if (!row.actions.includes(parent)) continue;
      const above = configured(row, parent);
      if (claimsMoreThan(resulting, above)) return { action: parent, level: above };
    }
    return null;
  };

  const choose = useCallback(
    (choices: ReachChange[]) => {
      setPicked((prev) => {
        const next = new Map(prev);
        for (const c of choices) {
          const row = rowOf.get(c.record);
          if (!row || !row.actions.includes(c.action as AccessAction)) continue;
          next.set(slotOf(c.record, c.action), c.level);
          const at = (a: AccessAction) => {
            const s = slotOf(row.key, a);
            return (next.has(s) ? next.get(s)! : row.cells[a].set) ?? row.cells[a].base;
          };
          // Narrowing View narrows what sits under it, as the engine and the server would.
          for (const dependent of ["edit", "delete", "assign"] as const) {
            if (!row.actions.includes(dependent)) continue;
            for (const parent of UNDER[dependent]) {
              if (row.actions.includes(parent) && claimsMoreThan(at(dependent), at(parent))) next.set(slotOf(row.key, dependent), at(parent));
            }
          }
        }
        // A cell put back to what is stored is no change at all.
        for (const [s, level] of next) {
          const [record, action] = s.split(":") as [string, AccessAction];
          if (rowOf.get(record)?.cells[action].set === level) next.delete(s);
        }
        return next;
      });
    },
    [rowOf],
  );

  const changes: ReachChange[] = rows.flatMap((row) =>
    REACH_ACTIONS.flatMap((action) => (row.actions.includes(action) && isChanged(row, action) ? [{ record: row.key, action, level: picked.get(slotOf(row.key, action)) ?? null }] : [])),
  );

  const reset = useCallback((record?: string) => {
    setPicked((prev) => {
      if (!record) return new Map();
      const next = new Map(prev);
      for (const s of prev.keys()) if (s.startsWith(`${record}:`)) next.delete(s);
      return next;
    });
  }, []);

  return { setOf, configured, levelOf, isChanged, blockedBy, choose, changes, reset };
}

export type ReachDraft = ReturnType<typeof useReachDraft>;
