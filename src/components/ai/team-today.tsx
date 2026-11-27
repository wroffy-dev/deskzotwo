"use client";

import Link from "next/link";
import { TeammateAvatar, useTeammate } from "@/components/ai/teammate-avatar";
import { Card } from "@/components/ui/card";
import type { TeammateKey } from "@/lib/ai/teammates";

/**
 * "Your AI team today" on Today (owner, 19 Nov 2026): what each teammate finished for this person since the day began
 * (src/lib/ai/teammate-work.ts's own counts), and — first — whoever is waiting on them, said in the teammate's voice.
 * Shown only when there is something to say.
 */
export type TeamTodayData = {
  /** Jobs each finished for this person today. */
  done: Partial<Record<TeammateKey, number>>;
  /** Tara's drafts waiting to be checked and sent. */
  draftsWaiting: number;
  /** Leads Ved read as hot or warm, listed below. */
  leadsToWork: number;
  /** Kabir's day, for somebody the Customer inbox is open to. */
  kabir?: { answered: number; handed: number; chatting: number } | null;
  /** Arjun's day, for somebody who follows payments up: customers worth chasing, drafts waiting, replies he read. */
  arjun?: { toChase: number; drafts: number; replies: number } | null;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function TeamTodayCard({ team }: { team: TeamTodayData }) {
  const ved = team.done.ved ?? 0;
  const tara = team.done.tara ?? 0;
  const mira = team.done.mira ?? 0;
  const kabir = team.kabir?.answered ?? 0;
  const chatting = team.kabir?.chatting ?? 0;
  const arjun = team.done.arjun ?? 0;
  const a = team.arjun ?? { toChase: 0, drafts: 0, replies: 0 };
  const all = ved + tara + mira + kabir + arjun;
  if (all === 0 && team.draftsWaiting === 0 && team.leadsToWork === 0 && chatting === 0 && a.toChase + a.drafts + a.replies === 0) return null;
  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-text">Your AI team today</h2>
        <span className="text-xs text-muted">
          {all > 0 ? `${plural(all, "job", "jobs")} done for you` : "Waiting on you"} ·{" "}
          <Link href="/ai-team" className="font-medium text-brand hover:underline">
            Team room
          </Link>
        </span>
      </div>
      <div className="space-y-2.5">
        {team.draftsWaiting > 0 && (
          <Says teammate="tara" href="#emails-to-check">
            I&apos;ve drafted {plural(team.draftsWaiting, "follow-up", "follow-ups")} — have a look? Nothing goes until you send it.
          </Says>
        )}
        {chatting > 0 && (
          <Says teammate="kabir" href="/ai-team">
            I&apos;m chatting with {plural(chatting, "customer", "customers")} right now — step in any time.
          </Says>
        )}
        {a.replies > 0 && (
          <Says teammate="arjun" href="/collections#replies">
            {plural(a.replies, "customer has", "customers have")} replied to your payment emails — I&apos;ve read them; have a look?
          </Says>
        )}
        {a.drafts > 0 && (
          <Says teammate="arjun" href="/collections">
            I&apos;ve drafted {plural(a.drafts, "chase email", "chase emails")} for you to check. Nothing goes until you send it.
          </Says>
        )}
        {a.toChase > 0 && a.replies === 0 && (
          <Says teammate="arjun" href="#payments-to-chase">
            {plural(a.toChase, "customer is", "customers are")} worth chasing for payment today — they&apos;re listed below.
          </Says>
        )}
        {team.leadsToWork > 0 && (
          <Says teammate="ved" href="#leads-to-work">
            {plural(team.leadsToWork, "lead looks", "leads look")} worth working first — they&apos;re listed below.
          </Says>
        )}
      </div>
      {all > 0 && (
        <ul className="flex flex-wrap gap-x-5 gap-y-2 border-t border-line pt-3 text-sm text-text">
          {ved > 0 && <Did teammate="ved">researched and planned {plural(ved, "lead", "leads")}</Did>}
          {tara > 0 && <Did teammate="tara">drafted {plural(tara, "email", "emails")}</Did>}
          {mira > 0 && <Did teammate="mira">drafted {plural(mira, "workflow", "workflows")}</Did>}
          {arjun > 0 && <Did teammate="arjun">drafted or read {plural(arjun, "payment email", "payment emails")}</Did>}
          {kabir > 0 && (
            <Did teammate="kabir">
              answered {plural(kabir, "chat", "chats")}
              {(team.kabir?.handed ?? 0) > 0 ? `, ${team.kabir!.handed} handed to a person` : ""}
            </Did>
          )}
        </ul>
      )}
    </Card>
  );
}

/** A line in the teammate's own voice, as a speech bubble from their face. */
function Says({ teammate, href, children }: { teammate: TeammateKey; href: string; children: React.ReactNode }) {
  const t = useTeammate(teammate);
  return (
    <a href={href} className="flex items-start gap-2.5">
      <TeammateAvatar teammate={teammate} size="sm" className="mt-0.5" />
      <span className="min-w-0 rounded-2xl rounded-tl-sm bg-surface-sunken px-3 py-2 text-sm text-text hover:bg-line">
        <span className="mr-1.5 font-semibold">{t.name}</span>
        {children}
      </span>
    </a>
  );
}

function Did({ teammate, children }: { teammate: TeammateKey; children: React.ReactNode }) {
  const t = useTeammate(teammate);
  return (
    <li className="flex items-center gap-2">
      <TeammateAvatar teammate={teammate} size="xs" />
      <span>
        <span className="font-medium">{t.name}</span> {children}
      </span>
    </li>
  );
}
