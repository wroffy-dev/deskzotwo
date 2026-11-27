"use client";

import { useState, useTransition } from "react";
import { CompanyLink } from "@/components/companies/company-link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronUp, Phone } from "lucide-react";
import { actOnChaseReply, type ArjunToday, type ReplyAction } from "@/actions/collection-chase";
import type { ReplyView } from "@/lib/collections/chase-server";
import { CHASE_ACTION_LABELS, READING_LABELS, type ChaseAction } from "@/lib/collections/chase";
import { shortDay } from "@/lib/collections/rules";
import { formatMoney } from "@/lib/currency";
import { companyPath } from "@/lib/record-links";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { TeammateAvatar, useTeammate } from "@/components/ai/teammate-avatar";
import { useClock } from "@/components/time/clock-provider";
import { DraftChaseButton, OpenChaseButton } from "@/components/collections/chase-dialog";

const ACTION_TONE: Record<ChaseAction, "red" | "amber" | "brand"> = { CALL: "red", CHECK: "amber", EMAIL: "brand" };

/**
 * Arjun on My collections (owner, 19 Nov 2026 — src/lib/collections/chase-server.ts): the replies he read, waiting for
 * the person; the chase emails he drafted, waiting to be checked; and who to chase today — each with why, what to do,
 * the brief for a call, and a Draft email.
 */
export function ArjunPanel({ data }: { data: ArjunToday }) {
  const arjun = useTeammate("arjun");
  return (
    <Card className="mt-5 p-0">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <TeammateAvatar teammate="arjun" size="md" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-text">
            Who to chase today <span className="font-normal text-muted">· {arjun.name}, Collections</span>
          </h2>
          <p className="text-xs text-muted">
            Ranked from your books — how much is late and for how long, promises broken or due, and who nobody has been in touch with. No AI is used for the
            list; {arjun.name} drafts an email only when you ask.
          </p>
        </div>
      </div>

      {data.replies.length > 0 && (
        <section id="replies" aria-label="Replies" className="scroll-mt-20 border-b border-line px-4 py-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-subtle">Replies to act on</h3>
          <ul className="mt-2 space-y-3">
            {data.replies.map((r) => (
              <ReplyRow key={r.id} reply={r} />
            ))}
          </ul>
        </section>
      )}

      {data.waiting.length > 0 && (
        <section aria-label="Drafts to check" className="border-b border-line px-4 py-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-subtle">Drafts to check</h3>
          <ul className="mt-2 space-y-1.5">
            {data.waiting.map((w) => (
              <li key={w.id} className="flex flex-wrap items-baseline gap-x-2">
                <OpenChaseButton id={w.id} label={w.subject} />
                <span className="text-xs text-subtle">
                  {w.companyName}
                  {w.auto ? " · drafted this morning by himself" : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.list.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted">Nothing to chase today — nothing on your accounts is late, broken or promised for today.</p>
      ) : (
        <ol className="divide-y divide-line">
          {data.list.map((item, i) => (
            <ChaseRow key={item.companyId} item={item} rank={i + 1} mayDraft={data.mayDraft} />
          ))}
        </ol>
      )}
    </Card>
  );
}

function ChaseRow({ item, rank, mayDraft }: { item: ArjunToday["list"][number]; rank: number; mayDraft: boolean }) {
  const [open, setOpen] = useState(false);
  const b = item.brief;
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <span className="mt-0.5 w-5 shrink-0 text-right text-xs font-semibold text-subtle">{rank}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {item.onTheirAccount ? (
              <CompanyLink href={`${companyPath(item.companySeq)}?tab=statement`} className="font-medium text-text hover:underline">
                {item.companyName}
              </CompanyLink>
            ) : (
              <span className="font-medium text-text">{item.companyName}</span>
            )}
            <Badge tone={ACTION_TONE[item.action]}>{CHASE_ACTION_LABELS[item.action]}</Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted">{item.reasons.join(" · ")}</p>
        </div>
        {/* On a phone, on a line of their own under the name — beside it they squeezed it to a word a line. */}
        <div className="flex w-full flex-wrap items-center gap-2 pl-8 sm:w-auto sm:shrink-0 sm:pl-0">
          <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <Phone className="mr-1.5 h-3.5 w-3.5" />
            Call brief
            {open ? <ChevronUp className="ml-1 h-3.5 w-3.5" /> : <ChevronDown className="ml-1 h-3.5 w-3.5" />}
          </Button>
          {mayDraft && item.mayEmail && <DraftChaseButton companyId={item.companyId} variant={item.action === "EMAIL" ? "primary" : "secondary"} />}
        </div>
      </div>
      {open && (
        <div className="mt-3 space-y-2 rounded-base border border-line bg-surface-sunken p-3 text-sm sm:ml-8">
          <p className="font-medium text-text">{b.headline}</p>
          <div className="relative overflow-x-auto">
            <table className="w-full text-xs">
              <tbody>
                {b.dues.map((d) => (
                  <tr key={d.label} className="border-t border-line first:border-0">
                    <td className="py-1 pr-2 font-mono">{d.label}</td>
                    <td className="py-1 pr-2 text-muted">due {d.due}</td>
                    <td className="py-1 pr-2 text-muted">{d.late}</td>
                    <td className="py-1 pr-2 text-right">{d.balance}</td>
                    <td className="py-1 text-xs text-subtle">{d.promise ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="space-y-1 text-xs">
            {b.lines.map((l) => (
              <div key={l.label} className="flex gap-2">
                <dt className="w-20 shrink-0 text-subtle">{l.label}</dt>
                <dd className="min-w-0 break-words text-text">{l.text}</dd>
              </div>
            ))}
          </dl>
          <p className="rounded-base bg-brand-subtle px-2.5 py-1.5 text-xs text-text">
            <span className="font-semibold">Ask: </span>
            {b.ask}
          </p>
        </div>
      )}
    </li>
  );
}

function ReplyRow({ reply }: { reply: ReplyView }) {
  const router = useRouter();
  const clock = useClock();
  const [mode, setMode] = useState<"promise" | null>(reply.reading === "PROMISE" ? "promise" : null);
  const [on, setOn] = useState(reply.promisedOn ?? "");
  const [amount, setAmount] = useState(reply.promisedAmount !== null ? String(reply.promisedAmount) : "");
  const [docs, setDocs] = useState<Set<string>>(() => new Set(reply.invoices.map((i) => i.id)));
  const [busy, setBusy] = useState<ReplyAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [, start] = useTransition();
  const today = clock.today();

  const act = (action: ReplyAction) =>
    start(async () => {
      setBusy(action);
      setError(null);
      const r = await actOnChaseReply({
        replyId: reply.id,
        action,
        ...(action === "promise" ? { promisedOn: on, promisedAmount: amount ? Number(amount) : null, documentIds: [...docs] } : { documentIds: [...docs] }),
      });
      setBusy(null);
      if (!r.ok) return setError(r.error);
      setDone(r.data.outcome);
      router.refresh();
    });

  const reading = reply.reading ?? "UNREAD";
  const suggested: ReplyAction | null = reading === "PAID" ? "paid" : reading === "DISPUTE" ? "dispute" : null;
  if (done) {
    return (
      <li className="text-sm text-muted">
        {reply.companyName}: {done}.
      </li>
    );
  }
  return (
    <li className="rounded-base border border-line p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-text">{reply.companyName}</span>
        <Badge tone={reading === "DISPUTE" ? "red" : reading === "PROMISE" || reading === "PAID" ? "green" : "default"}>{READING_LABELS[reading]}</Badge>
        <span className="text-xs text-subtle">
          {reply.fromName ?? "The customer"} · {clock.dateTimeShort(new Date(reply.receivedAt))}
          {!reply.senderVerified && " · sender not verified"}
        </span>
      </div>
      {reply.summary && <p className="mt-1 text-text">{reply.summary}</p>}
      <p className="mt-0.5 text-xs text-muted">
        {reply.promisedOn && `Pay by ${shortDay(reply.promisedOn)}${reply.promisedAmount !== null ? ` · ${formatMoney(reply.promisedAmount)}` : ""}. `}
        {reply.reading === "PAID" &&
          `Paid${reply.paidAmount !== null ? ` ${formatMoney(reply.paidAmount)}` : ""}${reply.paidOn ? ` on ${shortDay(reply.paidOn)}` : ""}${reply.reference ? ` · ref ${reply.reference}` : ""}. `}
        {reply.detail}
      </p>
      <details className="mt-1">
        <summary className="cursor-pointer text-xs text-muted hover:text-text">Their email</summary>
        <p className="mt-1 whitespace-pre-wrap break-words rounded-base bg-surface-sunken p-2 text-xs text-text">{reply.text}</p>
      </details>

      {mode === "promise" && (
        <div className="mt-2 flex flex-wrap items-end gap-2 rounded-base bg-surface-sunken p-2">
          <label className="text-xs text-muted">
            Pay by
            <Input type="date" min={today} value={on} onChange={(e) => setOn(e.target.value)} className="mt-0.5 h-8 w-40" />
          </label>
          {docs.size === 1 && (
            <label className="text-xs text-muted">
              Amount (optional)
              <Input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-0.5 h-8 w-36" />
            </label>
          )}
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {reply.invoices.map((i) => (
              <label key={i.id} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={docs.has(i.id)}
                  onChange={(e) =>
                    setDocs((s) => {
                      const next = new Set(s);
                      if (e.target.checked) next.add(i.id);
                      else next.delete(i.id);
                      return next;
                    })
                  }
                />
                <span className="font-mono">{i.number}</span> <span className="text-subtle">{formatMoney(i.balance, i.currency)}</span>
              </label>
            ))}
          </div>
          <Button size="sm" disabled={busy !== null || !on || docs.size === 0} onClick={() => act("promise")}>
            {busy === "promise" ? "Logging…" : "Log the promise"}
          </Button>
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        {mode !== "promise" && (
          <Button size="sm" variant={reading === "PROMISE" ? "primary" : "secondary"} disabled={busy !== null || reply.invoices.length === 0} onClick={() => setMode("promise")}>
            Log a promise…
          </Button>
        )}
        <Button size="sm" variant={suggested === "paid" ? "primary" : "secondary"} disabled={busy !== null} onClick={() => act("paid")}>
          {busy === "paid" ? "Asking…" : "Ask accounts to check the bank"}
        </Button>
        <Button size="sm" variant={suggested === "dispute" ? "primary" : "secondary"} disabled={busy !== null} onClick={() => act("dispute")}>
          {busy === "dispute" ? "Pausing…" : "Pause reminders — a dispute"}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => act("done")}>
          Noted
        </Button>
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => act("dismiss")}>
          Set aside
        </Button>
      </div>
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </li>
  );
}
