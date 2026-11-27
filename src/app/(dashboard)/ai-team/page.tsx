import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getCopilotAvailability } from "@/actions/copilot";
import { teamActivityToday, teamDayStart, teamFeedFor } from "@/lib/ai/teammate-work";
import { kabirLiveFor } from "@/lib/ai/kabir-live";
import { TeamRoom } from "@/components/ai/teammate-live";
import { waitingForYou } from "@/lib/ai/waiting";
import { WaitingForYouCard } from "@/components/ai/waiting-for-you";
import { getTeamScorecard } from "@/actions/ai-quality";
import { TeamScorecard } from "@/components/ai/team-scorecard";

export const metadata = { title: "AI team" };
export const dynamic = "force-dynamic";

/**
 * The Team room (owner, 19 Nov 2026 — "user can see agents working on screen", phase 2): this person's AI teammates as
 * they work — each a card with their real steps ticking — and a feed of everything they've done for them, live
 * (src/lib/ai/teammate-work.ts). Only for somebody Deskzo AI is switched on for, and only their own team's work.
 */
export default async function AiTeamPage() {
  const user = await requireUser();
  if (!(await getCopilotAvailability())) notFound();
  const [team, feed, kabir, waiting] = await Promise.all([
    teamActivityToday(user.id),
    teamFeedFor(user.id),
    kabirLiveFor(user.id, await teamDayStart()).catch(() => null),
    // What they left for this person to decide, across teammates (owner, 20 Nov 2026 — src/lib/ai/waiting.ts).
    waitingForYou(user.id, 20).catch(() => null),
  ]);
  const scores = await getTeamScorecard().catch(() => null);
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-text">Your AI team</h1>
        <p className="mt-1 text-sm text-muted">
          Watch them work. Each step you see is a real stage of the job as it happens, and only work done for you is shown. Nothing here is sent anywhere
          by itself — what needs you waits for you.
        </p>
      </div>
      {waiting && <WaitingForYouCard waiting={waiting} />}
      <TeamRoom initial={{ ...team, feed, kabir }} />
      {/* How each is doing, for whoever runs the workspace (owner, 20 Nov 2026 — step 2). */}
      {scores && <TeamScorecard scores={scores} />}
    </div>
  );
}
