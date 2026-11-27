import type { CallDirection, CallOutcome } from "@prisma/client";
import type { Clock } from "@/lib/time/zone";

/**
 * The business line's figures (owner, 26 Oct 2026 — src/lib/telephony): every call the cloud telephony reported
 * in a period, the customer known or not — worked out here from the rows src/actions/telephony.ts reads within
 * the viewer's reach. Pure, so a suite can feed it rows and check the sums. Calls › Team report covers each
 * person's calling; this is the line's own view of it.
 *
 *   · Incoming: answered, missed, and of the missed how many were called back — by a call out to the number,
 *     or the customer reaching somebody when they rang again — and how long that took (the middle value).
 *   · Outgoing: placed and connected. Talk time, and the average ring before an answer.
 *   · When people ring: incoming by hour of the day, in the workspace's time.
 *   · Each of the business's numbers, and each person who takes calls.
 *   · Numbers that aren't anyone on file, most recent first — enquiries waiting to become leads.
 */

export type LineCall = {
  id: string;
  direction: CallDirection;
  outcome: CallOutcome | null;
  startedAt: Date;
  talkSeconds: number;
  ringSeconds: number | null;
  customerKey: string | null;
  customerNumber: string;
  virtualNumber: string | null;
  agentUserId: string | null;
  agentName: string | null;
  /** Logged on Calls — its number is somebody on file. */
  logged: boolean;
};

/** A call that came after a missed one: out to the number, or the customer getting through. */
export type LaterCall = { key: string; at: Date };

export type LineTotals = {
  incoming: number;
  answered: number;
  missed: number;
  calledBack: number;
  notCalledBack: number;
  /** Minutes from a missed call to its call back — the middle value. */
  callbackMedianMinutes: number | null;
  outgoing: number;
  connected: number;
  talkSeconds: number;
  averageTalkSeconds: number;
  averageRingSeconds: number | null;
  callers: number;
  notOnFile: number;
};

export type LineReport = {
  totals: LineTotals;
  hours: { hour: number; answered: number; missed: number }[];
  numbers: { number: string; incoming: number; answered: number; missed: number; outgoing: number }[];
  people: { key: string; userId: string | null; name: string; answered: number; outgoing: number; connected: number; talkSeconds: number }[];
  unknown: { key: string; number: string; calls: number; missed: number; lastAt: Date; lastAnsweredBy: string | null }[];
  missedWaiting: { id: string; number: string; at: Date; logged: boolean }[];
};

const median = (values: number[]) => {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
};

export function buildLineReport(input: { clock: Clock; calls: LineCall[]; later: LaterCall[]; names: Map<string, string>; unknownLimit?: number }): LineReport {
  const { clock, calls } = input;
  const answeredOf = (c: LineCall) => c.outcome === "CONNECTED";
  const inbound = calls.filter((c) => c.direction === "INBOUND");
  const outbound = calls.filter((c) => c.direction === "OUTBOUND");
  const missed = inbound.filter((c) => !answeredOf(c));

  // What answers a missed call: a call out to the number after it, or the customer reaching somebody later.
  const answers: LaterCall[] = [
    ...input.later,
    ...outbound.filter((c) => c.customerKey).map((c) => ({ key: c.customerKey!, at: c.startedAt })),
    ...inbound.filter((c) => c.customerKey && answeredOf(c)).map((c) => ({ key: c.customerKey!, at: c.startedAt })),
  ];
  const byKey = new Map<string, Date[]>();
  for (const a of answers) byKey.set(a.key, [...(byKey.get(a.key) ?? []), a.at]);
  const callbackMinutes: number[] = [];
  const waiting: LineCall[] = [];
  for (const m of missed) {
    const next = (m.customerKey ? (byKey.get(m.customerKey) ?? []) : []).filter((at) => at.getTime() > m.startedAt.getTime()).sort((a, b) => a.getTime() - b.getTime())[0];
    if (next) callbackMinutes.push(Math.round((next.getTime() - m.startedAt.getTime()) / 60_000));
    else waiting.push(m);
  }

  const talked = calls.filter((c) => c.talkSeconds > 0);
  const talkSeconds = talked.reduce((n, c) => n + c.talkSeconds, 0);
  const rings = inbound.filter((c) => answeredOf(c) && c.ringSeconds !== null).map((c) => c.ringSeconds!);
  const keys = new Set(calls.map((c) => c.customerKey ?? c.customerNumber));

  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, answered: 0, missed: 0 }));
  for (const c of inbound) {
    const h = hours[clock.parts(c.startedAt).hour]!;
    if (answeredOf(c)) h.answered += 1;
    else h.missed += 1;
  }

  const numbers = new Map<string, LineReport["numbers"][number]>();
  for (const c of calls) {
    const number = c.virtualNumber ?? "—";
    const row = numbers.get(number) ?? { number, incoming: 0, answered: 0, missed: 0, outgoing: 0 };
    if (c.direction === "INBOUND") {
      row.incoming += 1;
      if (answeredOf(c)) row.answered += 1;
      else row.missed += 1;
    } else row.outgoing += 1;
    numbers.set(number, row);
  }

  const people = new Map<string, LineReport["people"][number]>();
  for (const c of calls) {
    if (!c.agentUserId && !c.agentName) continue;
    const key = c.agentUserId ?? `name:${c.agentName}`;
    const row = people.get(key) ?? { key, userId: c.agentUserId, name: (c.agentUserId && input.names.get(c.agentUserId)) || c.agentName || "—", answered: 0, outgoing: 0, connected: 0, talkSeconds: 0 };
    if (c.direction === "INBOUND" && answeredOf(c)) row.answered += 1;
    if (c.direction === "OUTBOUND") {
      row.outgoing += 1;
      if (answeredOf(c)) row.connected += 1;
    }
    row.talkSeconds += c.talkSeconds;
    people.set(key, row);
  }

  const unknown = new Map<string, LineReport["unknown"][number]>();
  for (const c of [...calls].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())) {
    if (c.logged) continue;
    const key = c.customerKey ?? c.customerNumber;
    const row = unknown.get(key);
    if (row) {
      row.calls += 1;
      if (c.direction === "INBOUND" && !answeredOf(c)) row.missed += 1;
      continue;
    }
    unknown.set(key, {
      key,
      number: c.customerNumber,
      calls: 1,
      missed: c.direction === "INBOUND" && !answeredOf(c) ? 1 : 0,
      lastAt: c.startedAt,
      lastAnsweredBy: answeredOf(c) ? ((c.agentUserId && input.names.get(c.agentUserId)) || c.agentName) : null,
    });
  }
  // A number known to the line already — some of its calls logged — isn't an unknown caller.
  const knownKeys = new Set(calls.filter((c) => c.logged).map((c) => c.customerKey ?? c.customerNumber));
  const unknownRows = [...unknown.values()].filter((u) => !knownKeys.has(u.key));

  return {
    totals: {
      incoming: inbound.length,
      answered: inbound.length - missed.length,
      missed: missed.length,
      calledBack: callbackMinutes.length,
      notCalledBack: waiting.length,
      callbackMedianMinutes: median(callbackMinutes),
      outgoing: outbound.length,
      connected: outbound.filter(answeredOf).length,
      talkSeconds,
      averageTalkSeconds: talked.length ? Math.round(talkSeconds / talked.length) : 0,
      averageRingSeconds: median(rings),
      callers: keys.size,
      notOnFile: unknownRows.length,
    },
    hours,
    numbers: [...numbers.values()].sort((a, b) => b.incoming + b.outgoing - (a.incoming + a.outgoing)),
    people: [...people.values()].sort((a, b) => b.answered + b.outgoing - (a.answered + a.outgoing)),
    unknown: unknownRows.slice(0, input.unknownLimit ?? 50),
    missedWaiting: waiting
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, 50)
      .map((c) => ({ id: c.id, number: c.customerNumber, at: c.startedAt, logged: c.logged })),
  };
}
