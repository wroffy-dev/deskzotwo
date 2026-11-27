import Link from "next/link";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { getReview } from "@/actions/reviews";
import { Card } from "@/components/ui/card";
import { AcknowledgeButton, AssessmentForm, GoalsPanel, RatingText, ReviewStatusBadge } from "@/components/hr/reviews";
import { formatCalendarDay } from "@/lib/time/zone";

export const metadata = { title: "Review" };

const day = (iso: string) => formatCalendarDay(new Date(`${iso}T00:00:00Z`));

function Verdict({ title, rating, score, comments, by }: { title: string; rating: number | null; score: number | null; comments: string | null; by?: string | null }) {
  return (
    <Card className="space-y-2 p-4">
      <h2 className="text-sm font-semibold text-text">{title}</h2>
      <div className="flex flex-wrap gap-x-8 gap-y-1 text-sm">
        <span>
          Overall: <RatingText value={rating} />
        </span>
        {score != null && (
          <span>
            Goals: <RatingText value={score} />
          </span>
        )}
      </div>
      {comments && <p className="whitespace-pre-line text-sm text-text">{comments}</p>}
      {by && <p className="text-xs text-subtle">— {by}</p>}
    </Card>
  );
}

/** One person's review in a cycle (owner, 31 Oct 2026): their goals, their self-assessment and their reviewer's rating. */
export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await isModuleEnabled("hr"))) return <ModuleDisabledNotice moduleKey="hr" />;
  const { id } = await params;
  const review = await getReview(id);
  if (!review) notFound();
  const self = review.viewer === "self";

  return (
    <div className="animate-fade-rise space-y-4">
      <div>
        <Link href="/people/reviews" className="text-sm text-muted hover:text-text">
          ← Goals &amp; reviews
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-text">{self ? review.cycle.name : `${review.person.name} — ${review.cycle.name}`}</h1>
          <ReviewStatusBadge status={review.status} />
        </div>
        <p className="mt-0.5 text-xs text-muted">
          {day(review.cycle.periodStart)} – {day(review.cycle.periodEnd)}
          {review.reviewer ? ` · reviewer ${review.reviewer.name}` : " · reviewed by HR"}
          {review.cycle.selfDueOn ? ` · self-assessment due ${day(review.cycle.selfDueOn)}` : ""}
          {review.cycle.managerDueOn ? ` · ratings due ${day(review.cycle.managerDueOn)}` : ""}
          {review.cycle.status === "CLOSED" ? " · the cycle is closed" : ""}
        </p>
      </div>

      <GoalsPanel review={review} />

      {review.can.self && <AssessmentForm review={review} as="self" />}
      {review.self?.submittedAt && (
        <Verdict title={self ? "Your self-assessment" : "Their self-assessment"} rating={review.self.rating} score={review.selfScore} comments={review.self.comments} />
      )}
      {!self && review.status === "AWAITING_SELF" && <p className="text-sm text-muted">{review.person.name} hasn&apos;t sent their self-assessment yet.</p>}

      {review.can.review && <AssessmentForm review={review} as="reviewer" />}
      {review.manager?.submittedAt && (
        <Verdict title={self ? "Your reviewer's rating" : "The reviewer's rating"} rating={review.manager.rating} score={review.managerScore} comments={review.manager.comments} by={review.reviewedBy?.name} />
      )}
      {self && review.status === "AWAITING_MANAGER" && <p className="text-sm text-muted">Sent — {review.reviewer?.name ?? "HR"} rates you next.</p>}

      {review.can.acknowledge && <AcknowledgeButton reviewId={review.id} />}
      {review.acknowledgedAt && <p className="text-xs text-subtle">{self ? "You've" : `${review.person.name} has`} read and acknowledged this review.</p>}
    </div>
  );
}
