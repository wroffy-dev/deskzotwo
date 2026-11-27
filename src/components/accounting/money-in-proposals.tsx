"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { askArjunMoneyIn, recordFromBankLine, type MoneyInPanel } from "@/actions/bank-match";
import { matchStatementLine } from "@/actions/bank";
import type { ProposalKind } from "@/lib/bank-match/rules";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TeammateAvatar, useTeammate } from "@/components/ai/teammate-avatar";
import { formatCalendarDay } from "@/lib/time/zone";
import { formatMoney } from "@/lib/currency";

const KIND_WORDS: Record<ProposalKind, string> = {
  EXACT: "Pays an invoice",
  SEVERAL: "Pays several invoices",
  TDS: "Pays an invoice, less TDS",
  PART: "Part of an invoice",
  ON_ACCOUNT: "Onto their account",
  IN_BOOKS: "Already in the books",
};

/**
 * Banking › money in the books don't have yet (owner, 20 Nov 2026 — src/lib/bank-match): for each statement line of money
 * in that nothing matches, who Arjun reads it as from and what it pays — recorded and ticked against the line only when
 * somebody presses Record & match. A receipt already in the books is offered to be matched instead, never recorded
 * twice. Lines the rules couldn't read can be asked of Deskzo AI.
 */
export function MoneyInProposals({ bankAccountId, panel }: { bankAccountId: string; panel: MoneyInPanel }) {
  const arjun = useTeammate("arjun");
  const router = useRouter();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();
  if (panel.foreign) return null;
  const items = panel.items.filter((i) => !hidden.has(i.line.id));
  if (!items.length && !panel.unasked && !panel.unplaced) return null;

  const act = (lineId: string, fn: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, done: (data: unknown) => string) =>
    start(async () => {
      setBusy(lineId);
      setError(null);
      const r = await fn();
      setBusy(null);
      if (!r.ok) return setError(r.error);
      setNotes((n) => ({ ...n, [lineId]: done(r.data) }));
      setHidden((h) => new Set(h).add(lineId));
      router.refresh();
    });

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
        <TeammateAvatar teammate="arjun" size="sm" />
        <span className="flex-1">
          Money in that isn&apos;t in your books yet <span className="font-normal text-muted">· {arjun.name}</span>
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted">
          Who each line is from and what it pays, read from the narration — an invoice number, a customer&apos;s name, an amount only one invoice has. Nothing is
          recorded until you press Record &amp; match; it then goes on as Record payment would, into this account, and the line is ticked.
        </p>
        {error && <p className="rounded-base bg-danger-bg px-3 py-2 text-xs text-danger">{error}</p>}
        {Object.values(notes).length > 0 && (
          <ul className="space-y-0.5 text-xs text-success">
            {Object.entries(notes).map(([id, n]) => (
              <li key={id}>{n}</li>
            ))}
          </ul>
        )}
        <ul className="divide-y divide-line">
          {items.map(({ line, proposal: p }) => (
            <li key={line.id} className="space-y-1.5 py-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-xs text-subtle">{formatCalendarDay(line.date)}</span>
                <span className="min-w-0 flex-1 break-words text-sm text-text">{line.narration}</span>
                <span className="text-sm font-medium tabular-nums text-success">{formatMoney(line.amount)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge tone={p.kind === "IN_BOOKS" ? "blue" : p.confidence === "HIGH" ? "green" : "amber"}>{KIND_WORDS[p.kind]}</Badge>
                {p.how === "AI" && (
                  <span className="flex items-center gap-1 text-muted">
                    <Sparkles className="h-3 w-3" /> read by Deskzo AI
                  </span>
                )}
                {p.companyName && <span className="font-medium text-text">{p.companyName}</span>}
                {p.allocations.length > 0 && <span className="text-muted">{p.allocations.map((a) => `${a.number} ${formatMoney(a.amount)}`).join(" · ")}</span>}
              </div>
              <p className="text-xs text-muted">{p.why}</p>
              <div className="flex flex-wrap gap-2">
                {p.kind === "IN_BOOKS" ? (
                  <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => act(line.id, () => matchStatementLine(line.id, p.bookLineId!), () => `Matched ${formatMoney(line.amount)} to the receipt already in the books.`)}>
                    {busy === line.id ? "Matching…" : "Match"}
                  </Button>
                ) : (
                  panel.mayRecord && (
                    <Button
                      size="sm"
                      disabled={busy !== null || !p.companyId}
                      onClick={() =>
                        act(
                          line.id,
                          () => recordFromBankLine({ statementLineId: line.id, companyId: p.companyId!, allocations: p.allocations.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount })) }),
                          (d) => {
                            const data = d as { matched: boolean; notes: string[] };
                            return `${formatMoney(line.amount)} from ${p.companyName} recorded${data.matched ? " and matched" : ""}.${data.notes.length ? ` ${data.notes.join(" ")}` : ""}`;
                          },
                        )
                      }
                    >
                      {busy === line.id ? "Recording…" : "Record & match"}
                    </Button>
                  )
                )}
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setHidden((h) => new Set(h).add(line.id))}>
                  Not this
                </Button>
              </div>
            </li>
          ))}
        </ul>
        {(panel.unasked > 0 || panel.unplaced > 0) && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-xs text-muted">
            {panel.unasked > 0 && (
              <>
                <span>
                  {panel.unasked} more line{panel.unasked === 1 ? "" : "s"} the rules couldn&apos;t place.
                </span>
                {panel.mayAsk && (
                  <Button
                    size="sm"
                    variant="subtle"
                    disabled={busy !== null}
                    onClick={() =>
                      start(async () => {
                        setBusy("ask");
                        setError(null);
                        const r = await askArjunMoneyIn(bankAccountId);
                        setBusy(null);
                        if (!r.ok) return setError(r.error);
                        setNotes((n) => ({ ...n, ask: `${arjun.name} read ${r.data.asked} line${r.data.asked === 1 ? "" : "s"} and placed ${r.data.placed}.` }));
                        router.refresh();
                      })
                    }
                  >
                    {busy === "ask" ? `${arjun.name} is reading them…` : `Ask ${arjun.name} to read them`}
                  </Button>
                )}
              </>
            )}
            {panel.unplaced > 0 && <span>{panel.unplaced} he couldn&apos;t place — match those by hand below.</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
