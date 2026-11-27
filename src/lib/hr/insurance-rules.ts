/**
 * Group insurance's checks (owner, 31 Oct 2026 — src/actions/insurance.ts). Pure, for scripts/check-hr-extras.ts.
 */

export const RELATIONS = [
  { value: "SPOUSE", label: "Spouse" },
  { value: "CHILD", label: "Child" },
  { value: "PARENT", label: "Parent" },
  { value: "PARENT_IN_LAW", label: "Parent-in-law" },
  { value: "OTHER", label: "Other" },
] as const;
export type Relation = (typeof RELATIONS)[number]["value"];
export type Dependent = { name: string; relation: Relation; dateOfBirth: string | null };

export const MAX_DEPENDENTS = 8;
const DAY_ISO = /^\d{4}-\d{2}-\d{2}$/;

/** The family as typed, tidied, or why it can't be kept. `today` is yyyy-mm-dd. */
export function dependentsOrRefusal(input: unknown, today: string): { ok: true; dependents: Dependent[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: "List the family members covered." };
  const rows = input.filter((d) => d && String((d as Dependent).name ?? "").trim());
  if (rows.length > MAX_DEPENDENTS) return { ok: false, error: `At most ${MAX_DEPENDENTS} family members.` };
  const out: Dependent[] = [];
  for (const raw of rows) {
    const d = raw as Partial<Dependent>;
    const name = String(d.name ?? "").trim().replace(/\s+/g, " ");
    if (name.length < 2 || name.length > 80) return { ok: false, error: `Give “${name}” their full name.` };
    if (!RELATIONS.some((r) => r.value === d.relation)) return { ok: false, error: `Say how ${name} is related.` };
    const dob = d.dateOfBirth ? String(d.dateOfBirth) : null;
    if (dob && (!DAY_ISO.test(dob) || dob > today)) return { ok: false, error: `${name}'s date of birth isn't a past date.` };
    out.push({ name, relation: d.relation as Relation, dateOfBirth: dob });
  }
  if (out.filter((d) => d.relation === "SPOUSE").length > 1) return { ok: false, error: "Only one spouse." };
  return { ok: true, dependents: out };
}

/** Where a policy stands on a day: not started, running, or ended. `today` and the dates are yyyy-mm-dd. */
export function policyState(validFrom: string, validTo: string, today: string): "UPCOMING" | "ACTIVE" | "EXPIRED" {
  if (today < validFrom) return "UPCOMING";
  return today > validTo ? "EXPIRED" : "ACTIVE";
}
