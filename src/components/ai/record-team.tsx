"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { makeResearchPlan } from "@/actions/research-plan";
import { startNurture } from "@/actions/nurture";
import { draftChaseEmail } from "@/actions/collection-chase";
import { draftReengage } from "@/actions/reengage";
import type { TeamAction, TeamSlot } from "@/lib/ai/record-team";
import { TeammateAvatar, useTeammate } from "@/components/ai/teammate-avatar";

/**
 * The AI team at the top of a lead or a customer (owner, 20 Nov 2026 — step 3; src/lib/ai/record-team.ts): each
 * teammate's face, what they've done for this record, and their one button — the same action as the card further down,
 * as this person, with its checks. What it makes waits for a person; nothing is sent from here.
 */
export function RecordTeam({ record, slots }: { record: { kind: "lead" | "company"; id: string }; slots: TeamSlot[] }) {
  if (!slots.length) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" aria-label="Your AI team on this record">
      {slots.map((slot) => (
        <Slot key={slot.teammate} record={record} slot={slot} />
      ))}
    </div>
  );
}

const WORKING: Record<TeamAction, string> = { "ved-plan": "researching…", "tara-nurture": "starting…", "arjun-chase": "drafting…", "tara-checkin": "writing…" };
const DONE: Record<TeamAction, string> = {
  "ved-plan": "Planned — see the plan below.",
  "tara-nurture": "Started — the first email waits for the lead's owner.",
  "arjun-chase": "Drafted — it waits on My collections.",
  "tara-checkin": "Drafted — it waits for the account manager.",
};

function Slot({ record, slot }: { record: { kind: "lead" | "company"; id: string }; slot: TeamSlot }) {
  const router = useRouter();
  const t = useTeammate(slot.teammate);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const run = (kind: TeamAction) =>
    start(async () => {
      setMessage(null);
      const result =
        kind === "ved-plan"
          ? await makeResearchPlan(record)
          : kind === "tara-nurture"
            ? await startNurture(record.id)
            : kind === "tara-checkin"
              ? await draftReengage(record.id)
              : await draftChaseEmail({ companyId: record.id });
      if (!result.ok) return setMessage({ ok: false, text: result.error });
      setMessage({ ok: true, text: DONE[kind] });
      router.refresh();
    });
  const words = slot.status ?? slot.note;
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-full border border-line bg-surface py-0.5 pl-0.5 pr-2 text-xs">
      <TeammateAvatar teammate={slot.teammate} size="xs" />
      <span className="font-medium text-text">{t.name}</span>
      {words &&
        (slot.href ? (
          <Link href={slot.href} className="text-muted hover:text-text hover:underline">
            {words}
          </Link>
        ) : (
          <span className={slot.note && !slot.status ? "text-subtle" : "text-muted"}>{words}</span>
        ))}
      {slot.action && (
        <button
          type="button"
          disabled={pending}
          onClick={() => run(slot.action!.kind)}
          className="rounded-full bg-brand-subtle px-2 py-0.5 font-medium text-brand hover:brightness-105 disabled:opacity-60"
        >
          {pending ? `${t.name} is ${WORKING[slot.action.kind]}` : slot.action.label}
        </button>
      )}
      {message && <span className={message.ok ? "text-success" : "text-danger"}>{message.text}</span>}
    </span>
  );
}
