import { requireUser } from "@/lib/session";
import { workspaceTeammates } from "@/lib/ai/teammates-server";
import { TEAMMATE_KEYS } from "@/lib/ai/teammates";
import { mayManageTeammates, teamStatus } from "@/lib/ai/teammate-switches";
import { waitingForYou } from "@/lib/ai/waiting";
import { AiTeammatesSettings } from "@/components/settings/ai-teammates";

export const metadata = { title: "AI teammates" };
export const dynamic = "force-dynamic";

/**
 * Settings › AI teammates (owner, 19 Nov 2026 — src/lib/ai/teammates.ts): the AI that works in Deskzo, as named
 * teammates. Since 23 Nov 2026 it says whether each one is working here, why not if not, and what each did this month,
 * with a switch per teammate (src/lib/ai/teammate-switches.ts). Everybody signed in sees who's who; the switches are an
 * admin's. Their names and photos are set by Deskzo for the workspace's country (src/lib/ai/teammate-looks.ts).
 */
export default async function AiTeammatesPage() {
  const user = await requireUser();
  const [canManage, teammates, team, waiting] = await Promise.all([mayManageTeammates(user.id), workspaceTeammates(), teamStatus(), waitingForYou(user.id, 1).catch(() => null)]);
  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">AI teammates</h1>
        <p className="mt-1 text-sm text-muted">
          Who works in your workspace, whether they can work here now, and what they did this month. Each carries an AI mark, so nobody takes one for a
          person, and asked, they always say they&apos;re AI.
        </p>
      </div>
      <AiTeammatesSettings team={team} teammates={TEAMMATE_KEYS.map((k) => teammates[k])} waiting={waiting?.total ?? 0} canManage={canManage} />
    </div>
  );
}
