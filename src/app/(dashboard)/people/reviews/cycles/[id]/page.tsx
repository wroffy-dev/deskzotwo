import Link from "next/link";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { reviewCycle } from "@/actions/reviews";
import { Badge, Card } from "@/components/ui/card";
import { CycleActions, RatingText, ReviewStatusBadge } from "@/components/hr/reviews";
import { formatCalendarDay } from "@/lib/time/zone";

export const metadata = { title: "Review cycle" };

const day = (iso: string) => formatCalendarDay(new Date(`${iso}T00:00:00Z`));

/** A review cycle for HR (owner, 31 Oct 2026): everybody in it, where their review stands, and how they were rated. */
export default async function ReviewCyclePage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await isModuleEnabled("hr"))) return <ModuleDisabledNotice moduleKey="hr" />;
  const { id } = await params;
  const view = await reviewCycle(id);
  if (!view) notFound();
  const { cycle, rows } = view;

  return (
    <div className="animate-fade-rise space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/people/reviews" className="text-sm text-muted hover:text-text">
            ← Goals &amp; reviews
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-text">{cycle.name}</h1>
            <Badge tone={cycle.status === "OPEN" ? "blue" : "default"}>{cycle.status === "OPEN" ? "Open" : "Closed"}</Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {day(cycle.periodStart)} – {day(cycle.periodEnd)} · {cycle.people} people · {cycle.selfSent} self-assessed · {cycle.completed} completed
          </p>
        </div>
        <CycleActions cycleId={cycle.id} status={cycle.status} />
      </div>

      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="px-4 py-2 font-medium">Person</th>
              <th className="px-4 py-2 font-medium">Reviewer</th>
              <th className="px-4 py-2 font-medium">Goals</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Self</th>
              <th className="px-4 py-2 font-medium">Reviewer&apos;s rating</th>
              <th className="px-4 py-2 font-medium">Goal score</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.reviewId} className="border-t border-line">
                <td className="px-4 py-2">
                  <Link href={`/people/reviews/${r.reviewId}`} className="font-medium text-text hover:underline">
                    {r.name}
                  </Link>
                  {r.department && <span className="block text-xs text-subtle">{r.department}</span>}
                </td>
                <td className="px-4 py-2 text-muted">{r.reviewer ?? "HR"}</td>
                <td className="px-4 py-2 tabular-nums">{r.goals}</td>
                <td className="px-4 py-2">
                  <ReviewStatusBadge status={r.status} />
                  {r.status === "COMPLETED" && !r.acknowledged && <span className="block text-xs text-subtle">not acknowledged</span>}
                </td>
                <td className="px-4 py-2 text-xs">{r.selfRating ?? <span className="text-subtle">—</span>}</td>
                <td className="px-4 py-2 text-xs">
                  <RatingText value={r.managerRating} />
                </td>
                <td className="px-4 py-2 text-xs tabular-nums">{r.goalScore ?? <span className="text-subtle">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
