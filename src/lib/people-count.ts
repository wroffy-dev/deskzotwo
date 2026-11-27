/**
 * How a count of people reads once some are switched off: the active ones are the team, the rest are said beside it
 * (owner, 25 Nov 2026 — "inactive old users are also getting counted in team").
 */
export function peopleCount(active: number, switchedOff: number, one: string, many: string): string {
  const text = `${active} ${active === 1 ? one : many}`;
  return switchedOff > 0 ? `${text} · ${switchedOff} switched off` : text;
}

/** For a refusal that counts everybody, switched off or not: " (all switched off)", " (2 switched off)", or nothing. */
export function ofThemSwitchedOff(total: number, switchedOff: number): string {
  if (switchedOff <= 0) return "";
  return switchedOff >= total ? (total === 1 ? " (switched off)" : " (all switched off)") : ` (${switchedOff} switched off)`;
}
