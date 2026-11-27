"use client";

import { useState, useTransition } from "react";
import { getChatsOf, openReviewedChat, type AiActivity, type AiActivityPerson } from "@/actions/copilot-review";
import type { ChatItem, ReviewedChat } from "@/lib/copilot/review";
import type { ProposalBlock } from "@/lib/copilot/types";
import { creditsText } from "@/lib/ai/catalogue";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Ago } from "@/components/ui/ago";
import { ActionNotice } from "@/components/ui/action-notice";
import { ChatText } from "@/components/copilot/chat-text";
import { ActivityLine, ProposalChanges, ReportCard } from "@/components/copilot/chat-blocks";
import { useClock } from "@/components/time/clock-provider";

type OpenChat = { id: string; title: string; ownerName: string; deleted: boolean; items: ChatItem[] };

/** Settings › AI activity (src/app/(dashboard)/settings/ai-activity): the month's usage per person, their chats, and the review log. */
export function AiActivityView({ activity }: { activity: AiActivity }) {
  const clock = useClock();
  const [person, setPerson] = useState<AiActivityPerson | null>(null);
  const [chats, setChats] = useState<ReviewedChat[] | null>(null);
  const [chat, setChat] = useState<OpenChat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const t = activity.totals;
  const top = Math.max(1, ...activity.people.map((p) => p.credits));

  function showChats(p: AiActivityPerson) {
    setError(null);
    setPerson(p);
    setChats(null);
    startTransition(async () => {
      const r = await getChatsOf(p.userId);
      if (r.ok) setChats(r.data);
      else setError(r.error);
    });
  }

  function open(id: string) {
    setError(null);
    startTransition(async () => {
      const r = await openReviewedChat(id);
      if (r.ok) setChat(r.data);
      else setError(r.error);
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Figure label="Credits used" value={creditsText(t.credits)} strong />
        <Figure label="Questions asked" value={String(t.questions)} />
        <Figure label="Chats" value={String(t.chats)} />
        <Figure label="People using it" value={String(t.people)} />
      </div>

      <Card>
        <CardHeader className="text-sm font-semibold text-text">People · {activity.month}</CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {activity.people.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted">Nobody has used Deskzo AI this month yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] uppercase tracking-wide text-muted">
                <tr className="border-b border-line">
                  <th className="px-4 py-2 font-medium">Person</th>
                  <th className="px-3 py-2 text-right font-medium">Questions</th>
                  <th className="px-3 py-2 text-right font-medium">Chats</th>
                  <th className="px-3 py-2 font-medium">Credits this month</th>
                  <th className="px-3 py-2 text-right font-medium">Today</th>
                  <th className="px-3 py-2 font-medium">Last used</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {activity.people.map((p) => (
                  <tr key={p.userId} className="border-b border-line last:border-0">
                    <td className="px-4 py-2 text-text">{p.name}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{p.questions}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{p.chats}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-24 overflow-hidden rounded bg-surface-sunken">
                          <div className="h-full bg-brand" style={{ width: `${Math.round((p.credits / top) * 100)}%` }} />
                        </div>
                        <span className="tabular-nums">{creditsText(p.credits)}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{creditsText(p.today)}</td>
                    <td className="px-3 py-2 text-muted">
                      <Ago at={p.lastAt} />
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Button size="sm" variant="secondary" onClick={() => showChats(p)} disabled={pending}>
                        View chats
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {activity.features.length > 0 && (
        <Card>
          <CardHeader className="text-sm font-semibold text-text">What the credits went on</CardHeader>
          <CardContent className="space-y-2 text-sm">
            {activity.features.map((f) => (
              <div key={f.label} className="flex items-center justify-between gap-3">
                <span className="text-text">{f.label}</span>
                <span className="tabular-nums text-muted">
                  {creditsText(f.credits)} · {f.turns} {f.turns === 1 ? "request" : "requests"}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {error && <ActionNotice tone="error">{error}</ActionNotice>}

      <Dialog open={person !== null && chat === null} onClose={() => setPerson(null)} title={person ? `${person.name}'s chats` : "Chats"}>
        {chats === null ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : chats.length === 0 ? (
          <p className="text-sm text-muted">No chats with Deskzo AI.</p>
        ) : (
          <ul className="max-h-[60vh] divide-y divide-line overflow-y-auto">
            {chats.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => open(c.id)} disabled={pending} className="flex w-full items-center gap-3 px-1 py-2 text-left hover:bg-surface-sunken">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-text">{c.title || "Untitled chat"}</span>
                    <span className="block text-[11px] text-subtle">
                      {c.questions} {c.questions === 1 ? "question" : "questions"} · last {clock.dateTimeShort(c.updatedAt)}
                    </span>
                  </span>
                  {c.deleted && <Badge tone="amber">Deleted by them</Badge>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Dialog>

      <Dialog open={chat !== null} onClose={() => setChat(null)} title={chat ? `${chat.ownerName} · ${chat.title || "Untitled chat"}` : "Chat"} large>
        {chat && (
          <div className="max-h-[70vh] space-y-3 overflow-y-auto">
            {chat.deleted && <p className="text-[12px] text-warning">{chat.ownerName} deleted this chat; it&apos;s kept for review.</p>}
            {chat.items.length === 0 && <p className="text-sm text-muted">This chat is empty.</p>}
            {chat.items.map((item, i) =>
              item.role === "user" ? (
                <div key={i} className="ml-8 whitespace-pre-wrap rounded-base bg-brand px-3 py-2 text-[13px] text-brand-contrast">
                  {item.text}
                </div>
              ) : item.role === "note" ? (
                <p key={i} className="text-center text-[11px] text-subtle">
                  {item.text}
                </p>
              ) : (
                <div key={i} className="mr-4 space-y-2">
                  {item.segments.map((s, j) =>
                    s.kind === "text" ? (
                      <ChatText key={j} text={s.text} />
                    ) : s.block.type === "activity" ? (
                      <ActivityLine key={j} block={s.block} />
                    ) : s.block.type === "report" ? (
                      <ReportCard key={j} block={s.block} />
                    ) : (
                      <div key={j} className="rounded-base border border-line px-3 py-2 text-[13px]">
                        <p className="font-medium text-text">{s.block.summary}</p>
                        {s.block.changes && (
                          <div className="mt-1">
                            <ProposalChanges changes={s.block.changes} />
                          </div>
                        )}
                        {s.block.details && <p className="mt-1 whitespace-pre-wrap text-muted">{s.block.details}</p>}
                        <p className="mt-1 text-[11px] text-subtle">
                          {PROPOSAL_KIND[s.block.kind]} · {proposalState(s.block.kind, s.block.status)}
                          {s.block.assignee ? ` · for ${s.block.assignee.name}` : ""}
                        </p>
                      </div>
                    ),
                  )}
                </div>
              ),
            )}
          </div>
        )}
      </Dialog>

      <Card>
        <CardHeader className="text-sm font-semibold text-text">Chats reviewed lately</CardHeader>
        <CardContent className="text-sm">
          {activity.reviews.length === 0 ? (
            <p className="text-muted">Nobody has opened anybody&apos;s chat yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {activity.reviews.map((r, i) => (
                <li key={i} className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-text">
                    {r.reviewer} read {r.owner}&apos;s chat <span className="text-muted">“{r.title}”</span>
                  </span>
                  <span className="text-[12px] text-subtle">{clock.dateTimeShort(r.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const PROPOSAL_KIND: Record<ProposalBlock["kind"], string> = { TASK: "Task", NOTE: "Note", LEAD: "Lead", LEAD_UPDATE: "Change to a lead" };

function proposalState(kind: ProposalBlock["kind"], status: ProposalBlock["status"]): string {
  const did = kind === "LEAD_UPDATE" ? "saved" : "created";
  switch (status) {
    case "DONE":
      return did;
    case "PENDING":
      return "not answered";
    case "FAILED":
      return "failed";
    default:
      return `not ${did}`;
  }
}

function Figure({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-base border border-line bg-surface px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted">{label}</p>
      <p className={`tabular-nums ${strong ? "text-lg font-semibold text-text" : "text-lg text-text"}`}>{value}</p>
    </div>
  );
}
