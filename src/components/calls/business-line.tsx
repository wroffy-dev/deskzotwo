import Link from "next/link";
import type { LineReportView } from "@/actions/telephony";
import { Card } from "@/components/ui/card";
import { ReadCallsNow } from "@/components/calls/read-calls-now";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { formatDuration } from "@/lib/calls";
import { waited } from "@/lib/call-report";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * Calls › Business line, drawn (owner, 26 Oct 2026 — src/lib/telephony): the period, the line's totals, incoming
 * by hour, each number and each person, the missed calls nobody has called back and the numbers not on file.
 * Given the report (src/actions/telephony.ts); asks nothing itself but the workspace's clock.
 */

const shift = (key: string, days: number) => new Date(Date.parse(`${key}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const tab = "rounded-full border border-line-strong bg-surface px-3 py-1 text-sm text-muted transition-colors hover:text-text";

export async function BusinessLine({ report, lastRead = null }: { report: LineReportView; lastRead?: Date | null }) {
  const clock = await workspaceClock();
  const today = report.today;
  const weekday = clock.parts(new Date()).weekday;
  const presets = [
    { label: "Today", from: today, to: today },
    { label: "Yesterday", from: shift(today, -1), to: shift(today, -1) },
    { label: "This week", from: shift(today, -((weekday + 6) % 7)), to: today },
    { label: "Last 7 days", from: shift(today, -6), to: today },
    { label: "This month", from: `${today.slice(0, 8)}01`, to: today },
  ];
  const oneDay = report.from === report.to;
  const period = oneDay ? (report.from === today ? "today" : clock.date(clock.startOfDay(report.from))) : `${clock.dayMonth(clock.startOfDay(report.from))} – ${clock.date(clock.startOfDay(report.to))}`;
  const t = report.totals;
  const busiest = Math.max(1, ...report.hours.map((h) => h.answered + h.missed));
  const answerRate = t.incoming ? Math.round((t.answered / t.incoming) * 100) : 0;

  return (
    <div className="animate-fade-rise">
      <h1 className="text-xl font-semibold text-text">Calls</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Every call on your business numbers {period}, through CallerDesk — answered or not, from customers on file or not.
        {!report.everyone && " Only the calls of people whose calls you can see."}
      </p>

      <div className="mt-5 flex flex-wrap gap-2">
        <Link href="/calls" className={tab}>
          All calls
        </Link>
        <Link href={{ pathname: "/calls", query: { view: "due" } }} className={tab}>
          Callbacks owed
        </Link>
        <Link href="/calls/report" className={tab}>
          Team report
        </Link>
        <span className="rounded-full bg-brand px-3 py-1 text-sm text-brand-contrast" aria-current="page">
          Business line
        </span>
        {report.connected && <ReadCallsNow lastRead={lastRead} />}
      </div>

      {!report.connected ? (
        <Card className="mt-5 px-4 py-6 text-sm text-muted">
          CallerDesk isn&apos;t connected. Whoever manages settings can connect it in Settings › Cloud calling.
        </Card>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {presets.map((p) => {
              const on = p.from === report.from && p.to === report.to;
              return (
                <Link
                  key={p.label}
                  href={{ pathname: "/calls/line", query: { from: p.from, to: p.to } }}
                  aria-current={on ? "true" : undefined}
                  className={`rounded-base px-2.5 py-1 text-sm ${on ? "bg-surface-sunken font-medium text-text" : "text-muted hover:text-text"}`}
                >
                  {p.label}
                </Link>
              );
            })}
            <DateRangePicker fromParam="from" toParam="to" label="Period" />
          </div>
          {report.clamped && <p className="mt-2 text-xs text-warning">A report covers three months at most — showing the last three months of the period you chose.</p>}

          <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="Calls in" value={String(t.incoming)} note={t.incoming ? `${answerRate}% answered` : "none"} />
            <Stat label="Missed" value={String(t.missed)} note={t.missed ? `${t.calledBack} called back${t.callbackMedianMinutes !== null ? ` in ${waited(t.callbackMedianMinutes)}` : ""}` : "none"} />
            <Stat label="Not called back" value={String(t.notCalledBack)} note="missed, nobody has rung them since" warn={t.notCalledBack > 0} />
            <Stat label="Calls out" value={String(t.outgoing)} note={t.outgoing ? `${t.connected} connected` : "none"} />
            <Stat
              label="Talk time"
              value={formatDuration(t.talkSeconds)}
              note={`${t.averageTalkSeconds ? `${formatDuration(t.averageTalkSeconds)} a call` : "—"}${t.averageRingSeconds !== null ? ` · answered in ${t.averageRingSeconds}s` : ""}`}
            />
          </div>

          <Card className="mt-5 px-4 py-3">
            <div className="text-xs uppercase tracking-wide text-subtle">Calls in by hour — lighter were missed</div>
            <div className="mt-3 flex h-28 items-end gap-1" role="img" aria-label={`Incoming calls by hour of the day, ${period}`}>
              {report.hours.map((h) => (
                <div key={h.hour} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${String(h.hour).padStart(2, "0")}:00 — ${h.answered} answered, ${h.missed} missed`}>
                  <div className="w-full rounded-t-sm bg-warning/40" style={{ height: `${(h.missed / busiest) * 100}%` }} />
                  <div className="w-full bg-brand" style={{ height: `${(h.answered / busiest) * 100}%` }} />
                </div>
              ))}
            </div>
            <div className="mt-1 flex justify-between text-[11px] text-subtle">
              <span>midnight</span>
              <span>noon</span>
              <span>11 pm</span>
            </div>
          </Card>

          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <Card className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="px-4 pt-3 text-left text-xs uppercase tracking-wide text-subtle">People</caption>
                <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th scope="col" className="px-4 py-2">Person</th>
                    <th scope="col" className="px-3 py-2 text-right">Answered</th>
                    <th scope="col" className="px-3 py-2 text-right">Calls out</th>
                    <th scope="col" className="px-4 py-2 text-right">Talk time</th>
                  </tr>
                </thead>
                <tbody>
                  {report.people.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-6 text-center text-muted">No calls answered or made in this period.</td>
                    </tr>
                  ) : (
                    report.people.map((p) => (
                      <tr key={p.key} className="border-b border-line last:border-0">
                        <th scope="row" className="px-4 py-2 text-left font-medium text-text">
                          {p.name}
                          {!p.userId && <span className="block text-xs font-normal text-muted">not matched to anyone here</span>}
                        </th>
                        <td className="px-3 py-2 text-right tabular-nums text-text">{p.answered}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-text">
                          {p.outgoing}
                          {p.outgoing > 0 && <span className="ml-1 text-xs text-muted">{p.connected} connected</span>}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-text">{formatDuration(p.talkSeconds)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </Card>

            <Card className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="px-4 pt-3 text-left text-xs uppercase tracking-wide text-subtle">Your numbers</caption>
                <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th scope="col" className="px-4 py-2">Number</th>
                    <th scope="col" className="px-3 py-2 text-right">Calls in</th>
                    <th scope="col" className="px-3 py-2 text-right">Missed</th>
                    <th scope="col" className="px-4 py-2 text-right">Calls out</th>
                  </tr>
                </thead>
                <tbody>
                  {report.numbers.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-6 text-center text-muted">No calls in this period.</td>
                    </tr>
                  ) : (
                    report.numbers.map((n) => (
                      <tr key={n.number} className="border-b border-line last:border-0">
                        <th scope="row" className="px-4 py-2 text-left font-mono text-xs text-text">{n.number}</th>
                        <td className="px-3 py-2 text-right tabular-nums text-text">{n.incoming}</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${n.missed ? "text-warning" : "text-text"}`}>{n.missed}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-text">{n.outgoing}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </Card>
          </div>

          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <Card className="px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-subtle">Missed, not called back</div>
              {report.missedWaiting.length === 0 ? (
                <p className="mt-3 text-sm text-muted">Every missed call has been called back.</p>
              ) : (
                <ul className="mt-2 divide-y divide-line">
                  {report.missedWaiting.map((m) => (
                    <li key={m.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <span className="font-mono text-text">{m.number}</span>
                      <span className="text-xs text-muted">
                        {clock.dateTimeShort(m.at)}
                        {m.logged ? " · a callback on Calls" : " · not on file"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-subtle">Numbers not on file</div>
              {report.unknown.length === 0 ? (
                <p className="mt-3 text-sm text-muted">Every caller is somebody on file.</p>
              ) : (
                <ul className="mt-2 divide-y divide-line">
                  {report.unknown.map((u) => (
                    <li key={u.key} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 text-sm">
                      <span className="font-mono text-text">{u.number}</span>
                      <span className="flex items-center gap-3 text-right text-xs text-muted">
                        <span>
                          {u.calls} call{u.calls === 1 ? "" : "s"}
                          {u.missed ? <span className="text-warning"> · {u.missed} missed</span> : null} · last {clock.dateTimeShort(u.lastAt)}
                          {u.lastAnsweredBy ? ` · ${u.lastAnsweredBy} answered` : ""}
                        </span>
                        {report.mayMakeLeads && (
                          <Link href={{ pathname: "/leads/new", query: { phone: u.number } }} className="shrink-0 font-medium text-brand hover:underline">
                            Make a lead
                          </Link>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {report.unknown.length > 0 && <p className="mt-2 text-xs text-subtle">Make one a lead — or a contact — and its next call is logged on Calls.</p>}
            </Card>
          </div>

          <p className="mt-3 max-w-3xl text-xs text-subtle">
            Only calls CallerDesk&apos;s own call list has confirmed are counted. A missed call is called back by any call out to the number afterwards, or by the customer reaching
            somebody when they ring again — whether through the business line, the Deskzo app or logged by hand. Hours are in this workspace&apos;s time.
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, note, warn }: { label: string; value: string; note: string; warn?: boolean }) {
  return (
    <Card className={`px-4 py-3 ${warn ? "border-warning/40" : ""}`}>
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${warn ? "text-warning" : "text-text"}`}>{value}</div>
      <div className="mt-0.5 text-xs text-muted">{note}</div>
    </Card>
  );
}
