"use client";

import { Gauge } from "lucide-react";
import type { TeammateScore } from "@/lib/ai/drafts";
import { Card } from "@/components/ui/card";
import { TeammateAvatar, useTeammate } from "@/components/ai/teammate-avatar";

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "—");

/**
 * Each teammate's last 30 days (owner, 20 Nov 2026 — step 2; src/lib/ai/drafts.ts `scorecard`): for Tara and Arjun how
 * their drafts fared — sent as written, lightly edited, rewritten, set aside — and how many got an answer; what Kabir and
 * Priya handed to a person; and the thumbs, with the reasons for the downs. For whoever may change the workspace's settings.
 */
export function TeamScorecard({ scores }: { scores: TeammateScore[] }) {
  const shown = scores.filter((s) => (s.drafts?.decided ?? 0) > 0 || (s.handled?.total ?? 0) > 0 || s.feedback.good + s.feedback.bad > 0);
  return (
    <Card className="p-4">
      <div className="flex items-center gap-3">
        <Gauge className="h-5 w-5 text-brand" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-text">How your AI team is doing</span>
          <span className="block text-xs text-muted">The last 30 days — where each one needs help shows here first.</span>
        </span>
      </div>
      {shown.length === 0 ? (
        <p className="mt-3 text-xs text-subtle">Nothing to score yet — it fills in as drafts are sent or set aside, and as chats and questions come in.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line border-t border-line">
          {shown.map((s) => (
            <Row key={s.teammate} score={s} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function Row({ score }: { score: TeammateScore }) {
  const t = useTeammate(score.teammate);
  const d = score.drafts;
  const lines: string[] = [];
  if (d && d.decided) {
    lines.push(
      `${d.decided} drafts: ${pct(d.asWritten, d.decided)} sent as written, ${pct(d.lightEdit, d.decided)} lightly edited, ${pct(d.rewritten, d.decided)} rewritten, ${pct(d.skipped, d.decided)} set aside`,
    );
    lines.push(`${d.replied} of ${d.sent} sent got an answer (${pct(d.replied, d.sent)})`);
  }
  if (score.handled && score.handled.total) {
    lines.push(
      score.teammate === "kabir"
        ? `${score.handled.total} chats answered, ${score.handled.handedOn} handed to a person (${pct(score.handled.handedOn, score.handled.total)})`
        : `${score.handled.total} questions, ${score.handled.handedOn} passed to HR (${pct(score.handled.handedOn, score.handled.total)})`,
    );
  }
  const f = score.feedback;
  return (
    <li className="flex items-start gap-2.5 py-2.5 text-xs">
      <TeammateAvatar teammate={score.teammate} size="sm" className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="block text-sm text-text">
          {t.name} <span className="text-subtle">· {t.role}</span>
        </span>
        {lines.map((l) => (
          <span key={l} className="block text-muted">
            {l}
          </span>
        ))}
        {f.good + f.bad > 0 && (
          <span className="block text-muted">
            👍 {f.good} · 👎 {f.bad}
            {f.reasons.length > 0 && <span className="text-subtle"> — “{f.reasons.join("” · “")}”</span>}
          </span>
        )}
      </span>
    </li>
  );
}
