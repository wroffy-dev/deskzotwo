import Link from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { reviewsHome, type ReviewListRow } from "@/actions/reviews";
import { Badge, Card } from "@/components/ui/card";
import { NewCycleForm, RatingText, ReviewStatusBadge } from "@/components/hr/reviews";
import { formatCalendarDay } from "@/lib/time/zone";

export const metadata = { title: "Goals & reviews" };

const day = (iso: string) => formatCalendarDay(new Date(`${iso}T00:00:00Z`));

function ReviewList({ rows, showName }: { rows: ReviewListRow[]; showName: boolean }) {
  return (
    <ul className="divide-y divide-line">
      {rows.map((r) => (
        <li key={r.id}>
          <Link href={`/people/reviews/${r.id}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-surface-sunken">
            <div className="min-w-0">
              <p className="text-sm font-medium text-text">{showName ? r.name : r.cycle}</p>
              <p className="text-xs text-muted">
                {showName ? `${r.cycle} · ` : ""}period ends {day(r.periodEnd)}
                {r.dueOn ? ` · due ${day(r.dueOn)}` : ""}
                {r.cycleStatus === "CLOSED" ? " · cycle closed" : ""}
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs">
              {r.status === "COMPLETED" && !showName && <RatingText value={r.managerRating} />}
              {r.status === "COMPLETED" && !showName && !r.acknowledged && <Badge tone="amber">Not acknowledged</Badge>}
              <ReviewStatusBadge status={r.status} />
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * People › Goals & reviews (owner, 31 Oct 2026 — src/actions/reviews.ts): my reviews and their goals, the reviews
 * waiting for me as somebody's manager, and — for HR — the review cycles.
 */
export default async function ReviewsPage() {
  if (!(await isModuleEnabled("hr"))) return <ModuleDisabledNotice moduleKey="hr" />;
  const { mine, toReview, hr, cycles, departments } = await reviewsHome();
  return (
    <div className="animate-fade-rise space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-text">Goals &amp; reviews</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Set goals for each review period with your manager, rate yourself at the end, and read what your reviewer says. Ratings run 1 to 5, from
          below expectations to outstanding.
        </p>
      </div>

      {toReview.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-text">Waiting for you ({toReview.length})</h2>
          <Card className="p-0">
            <ReviewList rows={toReview} showName />
          </Card>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-text">My reviews</h2>
        {mine.length === 0 ? (
          <Card className="p-4 text-sm text-muted">You aren&apos;t in a review cycle yet — HR starts them.</Card>
        ) : (
          <Card className="p-0">
            <ReviewList rows={mine} showName={false} />
          </Card>
        )}
      </section>

      {hr && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-text">Review cycles</h2>
          </div>
          <NewCycleForm departments={departments} />
          {cycles.length > 0 && (
            <Card className="p-0">
              <ul className="divide-y divide-line">
                {cycles.map((c) => (
                  <li key={c.id}>
                    <Link href={`/people/reviews/cycles/${c.id}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-surface-sunken">
                      <div>
                        <p className="text-sm font-medium text-text">{c.name}</p>
                        <p className="text-xs text-muted">
                          {day(c.periodStart)} – {day(c.periodEnd)} · {c.people} people · {c.selfSent} self-assessed · {c.completed} completed
                        </p>
                      </div>
                      <Badge tone={c.status === "OPEN" ? "blue" : "default"}>{c.status === "OPEN" ? "Open" : "Closed"}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </section>
      )}
    </div>
  );
}
