/**
 * Performance reviews' arithmetic and checks (owner, 31 Oct 2026 — src/actions/reviews.ts). Pure, for
 * scripts/check-reviews.ts.
 */

export const RATINGS = [
  { value: 1, label: "Below expectations" },
  { value: 2, label: "Needs improvement" },
  { value: 3, label: "Meets expectations" },
  { value: 4, label: "Exceeds expectations" },
  { value: 5, label: "Outstanding" },
] as const;

export const ratingLabel = (r: number | null | undefined) => RATINGS.find((x) => x.value === r)?.label ?? null;
export const isRating = (r: unknown): r is number => typeof r === "number" && Number.isInteger(r) && r >= 1 && r <= 5;

type ScoredGoal = { weight: number; status: "ACTIVE" | "ACHIEVED" | "DROPPED"; rating: number | null };

/**
 * The goals' score, to one place: weighted by each goal's share when any has one, otherwise a plain average. Dropped
 * goals and unrated ones count for nothing; null when nothing is rated.
 */
export function goalScore(goals: ScoredGoal[]): number | null {
  const rated = goals.filter((g) => g.status !== "DROPPED" && isRating(g.rating));
  if (rated.length === 0) return null;
  const weighted = rated.some((g) => g.weight > 0);
  const total = weighted ? rated.reduce((t, g) => t + g.weight, 0) : rated.length;
  if (total <= 0) return null;
  const sum = rated.reduce((t, g) => t + (g.rating as number) * (weighted ? g.weight : 1), 0);
  return Math.round((sum / total) * 10) / 10;
}

/** A word on the goals' weights when they are set and don't come to 100% — shown, not enforced. */
export function weightNote(goals: { weight: number; status: string }[]): string | null {
  const live = goals.filter((g) => g.status !== "DROPPED");
  if (!live.some((g) => g.weight > 0)) return null;
  const total = live.reduce((t, g) => t + g.weight, 0);
  return total === 100 ? null : `The goals' weights come to ${total}%, not 100%.`;
}

/** What is wrong with a cycle's dates, or null. */
export function cycleProblem(start: Date, end: Date, selfDue: Date | null, managerDue: Date | null): string | null {
  if (end < start) return "The period ends before it starts.";
  if (end.getTime() - start.getTime() > 400 * 86_400_000) return "Keep a cycle to a year or less.";
  if (selfDue && managerDue && managerDue < selfDue) return "Reviewers' ratings can't be due before the self-assessments.";
  return null;
}

/** What is wrong with a goal as entered, or null. */
export function goalProblem(g: { title: string; weight: number; progress: number }): string | null {
  if (g.title.trim().length < 3) return "Give the goal a title — a few words.";
  if (g.title.length > 200) return "Keep the title under 200 characters.";
  if (!Number.isInteger(g.weight) || g.weight < 0 || g.weight > 100) return "The weight is a whole percent, 0 to 100.";
  if (!Number.isInteger(g.progress) || g.progress < 0 || g.progress > 100) return "Progress is a whole percent, 0 to 100.";
  return null;
}
