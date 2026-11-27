import { requireUser } from "@/lib/session";
import { todayFor } from "@/lib/app/daily";
import { workspaceClock } from "@/lib/time/workspace";
import { greeting } from "@/lib/hr/celebrations";
import { accessContextFor } from "@/lib/modules-access";
import { TodayView } from "@/components/today/today-view";
import { hasEffectivePermission } from "@/actions/permission";
import { hotLeadsFor } from "@/lib/research/auto-plan";
import { waitingFor } from "@/lib/nurture/server";
import { teamActivityToday, teamDayStart } from "@/lib/ai/teammate-work";
import { kabirLiveFor } from "@/lib/ai/kabir-live";
import { arjunWaiting, chaseListFor } from "@/lib/collections/chase-server";
import { mayLogFollowUps } from "@/lib/collections/load";
import { waitingForYou } from "@/lib/ai/waiting";
import { supportToday } from "@/lib/desks/today";

export const metadata = { title: "Today" };

/**
 * Today (owner, 31 Oct 2026: "the PWA… like the native app — the dedicated icons below and the front screen"): the
 * phone app's first screen, on the web — where an installed app opens, and the first tab of the bar along the
 * bottom on a phone (src/components/layout/app-tab-bar.tsx). The same facts as the Android app's Today
 * (src/lib/app/daily.ts `todayFor`): clocked in or not, tasks due today and overdue, what waits for a decision,
 * leave left. Each card only where its module is open to the person.
 */
export default async function TodayPage() {
  const user = await requireUser();
  const [today, clock, access] = await Promise.all([todayFor(user.id), workspaceClock(), accessContextFor(user.id)]);
  const firstName = (user.name ?? "").trim().split(/\s+/)[0] || "there";
  // Their own leads Deskzo AI read as hot or warm, to work first (owner, 18 Nov 2026 — src/lib/research/auto-plan.ts).
  const hotLeads = access.openModules.includes("leads") ? await hotLeadsFor(user.id).catch(() => []) : [];
  // Nurture emails waiting for them to check and send (phase 3, src/lib/nurture).
  const toCheck = access.openModules.includes("leads") ? await waitingFor(user.id).catch(() => []) : [];
  // What their AI team finished for them since the day began (src/lib/ai/teammate-work.ts).
  const team = await teamActivityToday(user.id).catch(() => null);
  const kabir = await kabirLiveFor(user.id, await teamDayStart()).catch(() => null);
  // Arjun's picks of who to chase for payment today, his drafts and the replies he read (src/lib/collections/chase-server.ts).
  const chases =
    access.openModules.includes("receivables") && (await mayLogFollowUps(user.id))
      ? await Promise.all([chaseListFor(user.id, new Date(), 5), arjunWaiting(user.id)])
          .then(([list, waiting]) => ({ items: list.items.map((i) => ({ id: i.companyId, companyName: i.companyName, action: i.action, reasons: i.reasons.slice(0, 2).join(" · ") })), ...waiting }))
          .catch(() => null)
      : null;
  // Everything the AI team left for them to decide, one list (owner, 20 Nov 2026 — src/lib/ai/waiting.ts).
  const waiting = await waitingForYou(user.id).catch(() => null);
  // Customers' tickets and colleagues' help desk requests given to them, in one list (owner, 25 Nov 2026).
  const support = await supportToday(user.id, access.openModules, clock).catch(() => null);
  return (
    <TodayView
      today={today}
      greeting={greeting(new Date(), firstName, clock)}
      zone={clock.zone}
      approvals={access.openModules.includes("notifications")}
      newLead={access.openModules.includes("leads") && (await hasEffectivePermission(user.id, "leads.create"))}
      hotLeads={hotLeads}
      toCheck={toCheck}
      teamDone={team?.done}
      kabir={kabir ? { answered: kabir.answeredToday, handed: kabir.handedToday, chatting: kabir.chats.length } : null}
      chases={chases}
      waiting={waiting}
      support={support}
    />
  );
}
