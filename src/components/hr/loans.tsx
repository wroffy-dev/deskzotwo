"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { HandCoins } from "lucide-react";
import { cancelLoan, createLoan, decideLoan, recordDisbursal, recordRepayment, requestLoan, type LoanView } from "@/actions/loan";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";

const KIND = { LOAN: "Loan", ADVANCE: "Salary advance" } as const;
const monthWords = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
const dayWords = (d: string) => formatCalendarDay(new Date(`${d}T00:00:00Z`));
const todayIso = () => new Date().toISOString().slice(0, 10);

function useRun() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ ok: true; data?: unknown } | { ok: false; error: string }>, done?: () => void) =>
    start(async () => {
      setError(null);
      setNotice(null);
      const r = await fn();
      if (!r.ok) return setError(r.error);
      const warning = (r.data as { warning?: string | null } | undefined)?.warning;
      if (warning) setNotice(warning);
      done?.();
      router.refresh();
    });
  return { run, pending, error, notice };
}

/** One loan's line: what it is, how it is recovered, and where it stands. */
function Line({ l, children }: { l: LoanView; children?: ReactNode }) {
  const state =
    l.status === "REQUESTED"
      ? "Waiting for approval"
      : l.status === "REJECTED"
        ? "Not approved"
        : !l.disbursedOn
          ? "Approved — not paid out yet"
          : l.outstanding > 0
            ? `${formatCurrency(l.outstanding)} still owed`
            : "Repaid";
  return (
    <li className="space-y-1 py-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium text-text">
          {KIND[l.kind]} · {formatCurrency(l.amount)}
        </span>
        <span className={`text-xs ${l.status === "REJECTED" ? "text-danger" : l.outstanding > 0 || l.status === "REQUESTED" ? "text-warning" : "text-muted"}`}>{state}</span>
      </div>
      <p className="text-xs text-muted">
        {l.instalments === 1 ? "In one go" : `${l.instalments} instalments of ${formatCurrency(l.instalmentAmount)}`} from {monthWords(l.firstMonth)}
        {l.disbursedOn ? ` · paid out ${dayWords(l.disbursedOn)}` : ""}
        {l.recovered > 0 ? ` · ${formatCurrency(l.recovered)} recovered` : ""} · {l.reason}
      </p>
      {l.decisionNote && <p className="text-xs text-subtle">Note: {l.decisionNote}</p>}
      {children}
    </li>
  );
}

/** My HR › Loans & advances (owner, 31 Oct 2026): mine, and asking for one. */
export function MyLoansCard({ loans, startsFrom }: { loans: LoanView[]; startsFrom: string }) {
  const { run, pending, error } = useRun();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"LOAN" | "ADVANCE">("ADVANCE");
  const [amount, setAmount] = useState("");
  const [instalments, setInstalments] = useState("1");
  const [reason, setReason] = useState("");
  const waiting = loans.some((l) => l.status === "REQUESTED");
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <HandCoins className="h-4 w-4 text-muted" />
          <h3 className="text-sm font-semibold text-text">Loans &amp; advances</h3>
        </div>
        {!open && !waiting && (
          <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
            Ask for an advance or loan
          </Button>
        )}
      </div>
      {loans.length === 0 && !open && <p className="mt-2 text-sm text-subtle">None. An advance or a loan is recovered from your pay, month by month.</p>}
      {loans.length > 0 && (
        <ul className="mt-1 divide-y divide-line">
          {loans.map((l) => (
            <Line key={l.id} l={l}>
              {l.status === "REQUESTED" && (
                <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => run(() => cancelLoan(l.id))}>
                  Withdraw it
                </Button>
              )}
            </Line>
          ))}
        </ul>
      )}
      {open && (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap gap-3">
            <div>
              <Label htmlFor="ln-kind">What</Label>
              <Select id="ln-kind" value={kind} onChange={(e) => setKind(e.target.value === "LOAN" ? "LOAN" : "ADVANCE")} className="w-44">
                <option value="ADVANCE">Salary advance</option>
                <option value="LOAN">Loan</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="ln-amount">Amount</Label>
              <Input id="ln-amount" type="number" min="1" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-36" />
            </div>
            <div>
              <Label htmlFor="ln-months">Months to repay</Label>
              <Input id="ln-months" type="number" min="1" max={kind === "ADVANCE" ? 3 : 60} value={instalments} onChange={(e) => setInstalments(e.target.value)} className="w-28" />
            </div>
          </div>
          <div>
            <Label htmlFor="ln-reason">What it&apos;s for</Label>
            <Textarea id="ln-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <p className="text-xs text-subtle">
            Recovered from your pay from {monthWords(startsFrom)}, unless payroll sets another month. An advance is repaid within three months.
          </p>
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={pending} onClick={() => run(() => requestLoan({ kind, amount: Number(amount), instalments: Number(instalments), reason }), () => setOpen(false))}>
              {pending ? "Asking…" : "Ask"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </Card>
  );
}

/** A request waiting: approve it as asked or with other terms, or turn it down. */
function Decide({ l, startsFrom }: { l: LoanView; startsFrom: string }) {
  const { run, pending, error } = useRun();
  const [amount, setAmount] = useState(String(l.amount));
  const [instalments, setInstalments] = useState(String(l.instalments));
  const [firstMonth, setFirstMonth] = useState(startsFrom);
  const [note, setNote] = useState("");
  return (
    <div className="mt-2 space-y-2 rounded-base border border-line p-3">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label htmlFor={`d-a-${l.id}`}>Amount</Label>
          <Input id={`d-a-${l.id}`} type="number" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-32" />
        </div>
        <div>
          <Label htmlFor={`d-n-${l.id}`}>Months</Label>
          <Input id={`d-n-${l.id}`} type="number" min="1" value={instalments} onChange={(e) => setInstalments(e.target.value)} className="w-24" />
        </div>
        <div>
          <Label htmlFor={`d-m-${l.id}`}>From</Label>
          <Input id={`d-m-${l.id}`} type="month" value={firstMonth} onChange={(e) => setFirstMonth(e.target.value)} className="w-40" />
        </div>
        <div className="min-w-48 flex-1">
          <Label htmlFor={`d-note-${l.id}`}>Note to them</Label>
          <Input id={`d-note-${l.id}`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Needed to turn it down" />
        </div>
      </div>
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={pending} onClick={() => run(() => decideLoan({ id: l.id, approve: true, amount: Number(amount), instalments: Number(instalments), firstMonth, note }))}>
          Approve
        </Button>
        <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => run(() => decideLoan({ id: l.id, approve: false, note }))}>
          Turn down
        </Button>
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}

/** A loan running: record it paid out, or a repayment made by hand. */
function Movements({ l }: { l: LoanView }) {
  const { run, pending, error, notice } = useRun();
  const [on, setOn] = useState(todayIso());
  const [cash, setCash] = useState(false);
  const [amount, setAmount] = useState(String(l.outstanding));
  return (
    <div className="mt-2 flex flex-wrap items-end gap-2">
      <div>
        <Label htmlFor={`m-on-${l.id}`}>On</Label>
        <Input id={`m-on-${l.id}`} type="date" value={on} onChange={(e) => setOn(e.target.value)} className="w-40" />
      </div>
      {l.disbursedOn && (
        <div>
          <Label htmlFor={`m-amt-${l.id}`}>Amount</Label>
          <Input id={`m-amt-${l.id}`} type="number" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-32" />
        </div>
      )}
      <label className="flex items-center gap-1.5 pb-2 text-xs text-muted">
        <input type="checkbox" checked={cash} onChange={(e) => setCash(e.target.checked)} /> In cash
      </label>
      {!l.disbursedOn ? (
        <>
          <Button type="button" size="sm" disabled={pending} onClick={() => run(() => recordDisbursal({ id: l.id, on, cash }))}>
            Record paid out
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => run(() => cancelLoan(l.id))}>
            Cancel it
          </Button>
        </>
      ) : (
        <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => run(() => recordRepayment({ id: l.id, amount: Number(amount), on, cash }))}>
          Record repaid by hand
        </Button>
      )}
      {error && <p role="alert" className="w-full text-sm text-danger">{error}</p>}
      {notice && <p className="w-full text-sm text-warning">{notice}</p>}
    </div>
  );
}

/** Payroll's new loan or advance for somebody — approved as it is made. */
function NewLoan({ people, startsFrom }: { people: { id: string; name: string }[]; startsFrom: string }) {
  const { run, pending, error } = useRun();
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState("");
  const [kind, setKind] = useState("LOAN");
  const [amount, setAmount] = useState("");
  const [instalments, setInstalments] = useState("6");
  const [firstMonth, setFirstMonth] = useState(startsFrom);
  const [reason, setReason] = useState("");
  if (!open)
    return (
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        New loan or advance
      </Button>
    );
  return (
    <Card className="w-full space-y-3 p-4">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label htmlFor="nl-who">For</Label>
          <Select id="nl-who" value={userId} onChange={(e) => setUserId(e.target.value)} className="w-56">
            <option value="">Choose…</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="nl-kind">What</Label>
          <Select id="nl-kind" value={kind} onChange={(e) => setKind(e.target.value)} className="w-40">
            <option value="LOAN">Loan</option>
            <option value="ADVANCE">Salary advance</option>
          </Select>
        </div>
        <div>
          <Label htmlFor="nl-amt">Amount</Label>
          <Input id="nl-amt" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-32" />
        </div>
        <div>
          <Label htmlFor="nl-n">Months</Label>
          <Input id="nl-n" type="number" min="1" value={instalments} onChange={(e) => setInstalments(e.target.value)} className="w-24" />
        </div>
        <div>
          <Label htmlFor="nl-m">From</Label>
          <Input id="nl-m" type="month" value={firstMonth} onChange={(e) => setFirstMonth(e.target.value)} className="w-40" />
        </div>
      </div>
      <div>
        <Label htmlFor="nl-r">What it&apos;s for</Label>
        <Input id="nl-r" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={pending} onClick={() => run(() => createLoan({ userId, kind, amount: Number(amount), instalments: Number(instalments), firstMonth, reason }), () => setOpen(false))}>
          Set it up
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </Card>
  );
}

/** People › Loans & advances, for whoever runs payroll. */
export function LoansManager({ waiting, running, done, people, startsFrom }: { waiting: LoanView[]; running: LoanView[]; done: LoanView[]; people: { id: string; name: string }[]; startsFrom: string }) {
  const section = (title: string, rows: LoanView[], empty: string, extra: (l: LoanView) => ReactNode) => (
    <Card className="p-4">
      <h2 className="text-sm font-semibold text-text">{title}</h2>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-subtle">{empty}</p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((l) => (
            <Line key={l.id} l={{ ...l, reason: `${l.person.name} — ${l.reason}` }}>
              {extra(l)}
            </Line>
          ))}
        </ul>
      )}
    </Card>
  );
  return (
    <div className="space-y-4">
      <NewLoan people={people} startsFrom={startsFrom} />
      {section("Asked for", waiting, "Nobody is waiting on a loan or advance.", (l) => <Decide l={l} startsFrom={startsFrom} />)}
      {section("Running", running, "No loans or advances being recovered.", (l) => <Movements l={l} />)}
      {done.length > 0 && section("Repaid or turned down", done, "", () => null)}
    </div>
  );
}
