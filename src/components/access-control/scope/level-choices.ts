import { LEVEL_WORDS } from "@/lib/authz/level-order";
import type { AccessAction } from "@/lib/authz/access";
import type { Choice } from "@/components/access-control/scope/chips";
import { ACTION_LABEL, LEVEL_ORDER, levelMeans, type ReachRow } from "@/components/access-control/scope/reach";
import type { ReachDraft } from "@/components/access-control/scope/use-reach-draft";

/** Why a level can't be chosen for an action here: it would reach wider than the action it sits under. */
export function widerThanWhy(draft: ReachDraft, row: ReachRow, action: AccessAction, choice: Parameters<ReachDraft["blockedBy"]>[2]): string | null {
  const blocked = draft.blockedBy(row, action, choice);
  return blocked ? `Can't be wider than ${ACTION_LABEL[blocked.action]} (${LEVEL_WORDS[blocked.level]}).` : null;
}

/** What following the base is called: a role follows its permissions, a person their role. */
export function inheritLabel(row: ReachRow, action: AccessAction, isUser: boolean): string {
  return isUser ? `Their role's — ${LEVEL_WORDS[row.cells[action].base]}` : `As its permissions — ${LEVEL_WORDS[row.cells[action].base]}`;
}

/**
 * A cell's menu: the levels its record type offers — only those, since any other is refused and would
 * answer None — then "inherit", which removes what is set here.
 */
export function levelChoices(draft: ReachDraft, row: ReachRow, action: AccessAction, isUser: boolean): Choice[] {
  const cell = row.cells[action];
  return [
    ...LEVEL_ORDER.filter((level) => row.levels.includes(level)).map(
      (level): Choice => ({
        key: level,
        label: LEVEL_WORDS[level],
        hint: levelMeans(level, row.ownMeans),
        tone: level,
        disabledWhy: widerThanWhy(draft, row, action, level),
        onPick: () => draft.choose([{ record: row.key, action, level }]),
      }),
    ),
    {
      key: "inherit",
      label: inheritLabel(row, action, isUser),
      hint: isUser ? "Inherit: remove the level set for them alone." : "Inherit: remove the level set on this role.",
      tone: cell.base,
      dashed: true,
      disabledWhy: widerThanWhy(draft, row, action, null),
      onPick: () => draft.choose([{ record: row.key, action, level: null }]),
    },
  ];
}

/** The next level a click moves a chip to: through the record's own levels, skipping any too wide for what is above. */
export function cycleLevel(draft: ReachDraft, row: ReachRow, action: AccessAction) {
  const options = LEVEL_ORDER.filter((level) => row.levels.includes(level) && !draft.blockedBy(row, action, level));
  if (options.length === 0) return;
  const at = options.indexOf(draft.levelOf(row, action));
  draft.choose([{ record: row.key, action, level: options[(at + 1) % options.length]! }]);
}
