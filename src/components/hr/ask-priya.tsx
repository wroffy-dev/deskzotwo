"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { ChevronRight, Send, UserRound } from "lucide-react";
import { askHrDesk, askHrInstead } from "@/actions/hr-desk";
import type { QuestionView } from "@/lib/hr-desk/server";
import { QUESTION_MAX, STATUS_LABELS } from "@/lib/hr-desk/rules";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/input";
import { TeammateAvatar, useTeammate } from "@/components/ai/teammate-avatar";
import { useClock } from "@/components/time/clock-provider";

const EXAMPLES = ["How many casual leaves do I have left?", "When is the next holiday?", "Is my October payslip ready?", "Did I miss marking attendance this month?"];

/**
 * "Ask Priya" on My HR (owner, 20 Nov 2026 — src/lib/hr-desk): the HR desk, for anybody here. She answers from their own
 * records and the HR guides chosen for her, and passes what she can't to HR — whose answer comes back here.
 */
export function AskPriya({ data }: { data: { questions: QuestionView[]; closed: string | null } }) {
  const priya = useTeammate("priya");
  const [question, setQuestion] = useState("");
  const [list, setList] = useState(data.questions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();
  const [all, setAll] = useState(false);
  // One row open at a time — the newest to begin with, then whichever the person clicks.
  const [openId, setOpenId] = useState<string | null>(data.questions[0]?.id ?? null);
  const folded = foldQuestions(list);
  const shown = all ? folded : folded.slice(0, RECENT);
  const hidden = folded.length - shown.length;
  const waitingHidden = folded.slice(RECENT).filter((row) => row.q.status === "WITH_HR").length;

  // One question at a time: a second click, or Enter while she's looking, does nothing.
  const sending = useRef(false);
  const ask = (text: string) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    start(async () => {
      const r = await askHrDesk(text)
        .catch(() => ({ ok: false as const, error: "That didn't go through — check your connection and ask again." }))
        .finally(() => {
          sending.current = false;
        });
      setBusy(false);
      if (!r.ok) return setError(r.error);
      setList((l) => [r.data, ...l.filter((q) => q.id !== r.data.id)]);
      setOpenId(r.data.id);
      setQuestion("");
    });
  };

  return (
    <Card id="ask" className="scroll-mt-20 p-4">
      <div className="flex items-start gap-3">
        <TeammateAvatar teammate="priya" size="md" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-text">
            Ask {priya.name} <span className="font-normal text-muted">· HR desk</span>
          </h2>
          <p className="text-xs text-muted">Leave, holidays, attendance, payslips or a policy — she answers from your own records and the company&apos;s HR guides, and passes anything else to HR.</p>
        </div>
      </div>
      {data.closed ? (
        <p className="mt-3 text-sm text-muted">{data.closed}</p>
      ) : (
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (question.trim()) ask(question);
          }}
        >
          <Textarea
            aria-label={`Your question for ${priya.name}`}
            rows={2}
            maxLength={QUESTION_MAX}
            value={question}
            placeholder="How many casual leaves do I have left?"
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && question.trim()) {
                e.preventDefault();
                ask(question);
              }
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" type="submit" disabled={busy || !question.trim()}>
              <Send className="mr-1.5 h-3.5 w-3.5" />
              {busy ? `${priya.name} is looking…` : "Ask"}
            </Button>
            {list.length === 0 &&
              EXAMPLES.map((ex) => (
                <button key={ex} type="button" onClick={() => ask(ex)} disabled={busy} className="rounded-full border border-line px-2.5 py-1 text-xs text-muted hover:bg-surface-sunken hover:text-text">
                  {ex}
                </button>
              ))}
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
        </form>
      )}
      {list.length > 0 && (
        <ul className="mt-4 divide-y divide-line border-t border-line">
          {shown.map(({ q, times }) => (
            <QuestionRow
              key={q.id}
              q={q}
              times={times}
              open={openId === q.id}
              onToggle={() => setOpenId((id) => (id === q.id ? null : q.id))}
              onChange={(next) => setList((l) => l.map((x) => (x.id === next.id ? next : x)))}
            />
          ))}
          {hidden > 0 && (
            <li className="pt-2">
              <button type="button" onClick={() => setAll(true)} className="text-xs font-medium text-brand hover:underline">
                Show {hidden} earlier {hidden === 1 ? "question" : "questions"}
                {waitingHidden > 0 && ` · ${waitingHidden} still with HR`}
              </button>
            </li>
          )}
          {all && folded.length > RECENT && (
            <li className="pt-2">
              <button type="button" onClick={() => setAll(false)} className="text-xs font-medium text-muted hover:text-text hover:underline">
                Show fewer
              </button>
            </li>
          )}
        </ul>
      )}
    </Card>
  );
}

/** How many questions stay in view, each a line until it is opened (owner, 23 Nov 2026 — "q&a taking too much screen"). */
const RECENT = 3;

/**
 * The list as a person reads it (owner, 23 Nov 2026 — "this will keep piling up"): the same question asked again and
 * answered the same way is one row, "asked 3 times", the newest kept; then the last few, and whatever HR still owes them.
 */
export function foldQuestions(list: QuestionView[]): { q: QuestionView; times: number }[] {
  const key = (q: QuestionView) => `${q.status}|${q.question.trim().toLowerCase().replace(/[?.!\s]+$/g, "").replace(/\s+/g, " ")}`;
  const out: { q: QuestionView; times: number }[] = [];
  const seen = new Map<string, { q: QuestionView; times: number }>();
  for (const q of list) {
    const k = key(q);
    const had = seen.get(k);
    if (had) had.times++;
    else {
      const row = { q, times: 1 };
      seen.set(k, row);
      out.push(row);
    }
  }
  return out;
}

function QuestionRow({ q, times = 1, open, onToggle, onChange }: { q: QuestionView; times?: number; open: boolean; onToggle: () => void; onChange: (q: QuestionView) => void }) {
  const priya = useTeammate("priya");
  const clock = useClock();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();
  const person = () =>
    start(async () => {
      setBusy(true);
      setError(null);
      const r = await askHrInstead(q.id);
      setBusy(false);
      if (!r.ok) return setError(r.error);
      onChange(r.data);
    });
  return (
    <li className="text-sm">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-2 py-2 text-left hover:text-brand">
        <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-medium text-text">{q.question}</span>
        <span className="flex shrink-0 items-center gap-2 text-xs text-subtle">
          {times > 1 && <span className="hidden sm:inline">Asked {times} times · last</span>}
          <span className="hidden sm:inline">{clock.dateTimeShort(new Date(q.askedAt))}</span>
          <Badge tone={q.status === "WITH_HR" ? "amber" : q.status === "HR_ANSWERED" ? "green" : "default"}>{STATUS_LABELS[q.status] ?? q.status}</Badge>
        </span>
      </button>
      {open && (
        <div className="space-y-1.5 pb-3">
          {q.answer && (
            <div className="flex items-start gap-2">
              <TeammateAvatar teammate="priya" size="xs" className="mt-0.5" />
              <p className="min-w-0 flex-1 whitespace-pre-wrap rounded-2xl rounded-tl-sm bg-surface-sunken px-3 py-2 text-text">
                <span className="mr-1 font-semibold">{priya.name}</span>
                {q.answer}
              </p>
            </div>
          )}
          {q.hrAnswer && (
            <div className="flex items-start gap-2">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-subtle text-brand">
                <UserRound className="h-3 w-3" />
              </span>
              <p className="min-w-0 flex-1 whitespace-pre-wrap rounded-2xl rounded-tl-sm bg-brand-subtle/50 px-3 py-2 text-text">
                <span className="mr-1 font-semibold">{q.hrAnsweredBy ?? "HR"}</span>
                {q.hrAnswer}
              </p>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 pl-7">
            {q.link && (
              <Link href={q.link.href} className="text-xs font-medium text-brand hover:underline">
                {q.link.label} →
              </Link>
            )}
            {q.status === "ANSWERED" && (
              <button type="button" onClick={person} disabled={busy} className="text-xs text-muted hover:text-text hover:underline">
                {busy ? "Passing it on…" : "Ask a person in HR instead"}
              </button>
            )}
            {q.status === "WITH_HR" && <span className="text-xs text-muted">With HR — their answer will appear here.</span>}
          </div>
          {error && <p className="pl-7 text-xs text-danger">{error}</p>}
        </div>
      )}
    </li>
  );
}
