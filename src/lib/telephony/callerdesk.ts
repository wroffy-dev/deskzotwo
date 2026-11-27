import type { ReportedCall, TelephonyBalance, TelephonyMember } from "@/lib/telephony/types";
import { TelephonyError } from "@/lib/telephony/types";

/**
 * CallerDesk's API (owner, 26 Oct 2026 — src/lib/telephony), from its public reference at api.callerdesk.io.
 *
 *   · Every request carries the account's key as `authcode` — a form field on the POSTs, a query parameter
 *     on the GETs. Answers are JSON with `type: "success"` or `type: "error"` and a `message`.
 *   · Click-to-call by member id (`click_to_call_v4`) rings the agent first and then the customer, from the
 *     account's virtual number ("deskphone"). It answers with a campaign id, which the call's report carries.
 *   · The call list (`call_list_v2`) is every call on the account's numbers, by day, 25 a page, fixed.
 *   · The webhook (a paid add-on) posts a Live Call when a call starts and a Call Report after it ends —
 *     as JSON, or as a GET with the same fields in the address. It is signed with nothing.
 *   · Times are India's, written "yyyy-mm-dd hh:mm:ss", with "0000-00-00 00:00:00" for none.
 *
 * Numbers come as CallerDesk writes them (leading 0, no +91); what's matched is their last ten digits.
 */

const BASE = "https://app.callerdesk.io/api";
/** CallerDesk's list pages are fixed at 25 calls and 50 members. */
export const CALL_PAGE = 25;
const MEMBER_PAGE = 50;
const TIMEOUT_MS = 20_000;

type Json = Record<string, unknown>;

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" || s === "--" || s.toLowerCase() === "null" ? null : s;
};
const int = (v: unknown): number => {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** "2024-12-30 12:43:19", in India's time — null for none, or for the zero date CallerDesk writes. */
export function callerdeskTime(v: unknown): Date | null {
  const s = text(v);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ Tn](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m || m[1] === "0000") return null;
  const at = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+05:30`);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** A day as CallerDesk's filters take it — India's calendar day of a moment. */
export function callerdeskDay(at: Date): string {
  return new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/** IVR is a call to the business; the rest (WEBOBD, a click-to-call) one from it. */
const directionOf = (flow: unknown): "INBOUND" | "OUTBOUND" => (String(flow ?? "").trim().toUpperCase() === "IVR" ? "INBOUND" : "OUTBOUND");

/** Answered: somebody talked, or CallerDesk says ANSWER. Its "callresult" alone can say Answered for a call nobody picked up. */
const wasAnswered = (status: string | null, talk: number) => talk > 0 || (status ?? "").toUpperCase() === "ANSWER";

const recording = (v: unknown) => {
  const s = text(v);
  return s && /^https:\/\//i.test(s) ? s : null;
};

/** A call from CallerDesk's call list — the record a webhook is checked against. */
export function parseListedCall(row: Json): ReportedCall | null {
  const id = text(row.sid_id) ?? text(row.id);
  const customer = text(row.caller_num);
  const startedAt = callerdeskTime(row.startdatetime) ?? callerdeskTime(row.call_date);
  if (!id || !customer || !startedAt) return null;
  const status = text(row.callstatus) ?? text(row.callresult);
  const talk = int(row.talk_duration);
  return {
    providerCallId: id,
    campaignId: text(row.campid),
    live: false,
    direction: directionOf(row.Flow_type),
    customerNumber: customer,
    virtualNumber: text(row.deskphone),
    agentNumber: text(row.member_num),
    agentName: text(row.member_name),
    status,
    answered: wasAnswered(status, talk),
    startedAt,
    answeredAt: callerdeskTime(row.LegB_Picked_time) ?? callerdeskTime(row.LegA_Picked_time),
    endedAt: callerdeskTime(row.enddatetime),
    durationSeconds: int(row.total_duration),
    talkSeconds: talk,
    ringSeconds: row.ringing_duration === undefined || row.ringing_duration === null ? null : int(row.ringing_duration),
    recordingUrl: recording(row.file),
    callGroup: text(row.group_name),
    keyPressed: text(row.key_pressed),
  };
}

/**
 * A webhook's call — a Live Call (no end yet) or a Call Report. Null for anything else it sends (member and
 * call group changes, security activity), or a call without its number or start.
 */
export function parseWebhookCall(body: Json): ReportedCall | null {
  const type = (text(body.type) ?? "").toLowerCase();
  if (type && !type.includes("call")) return null;
  const id = text(body.CallSid) ?? text(body.Uniqueid);
  const customer = text(body.SourceNumber);
  const startedAt = callerdeskTime(body.StartTime);
  if (!id || !customer || !startedAt) return null;
  const endedAt = callerdeskTime(body.EndTime);
  const live = type.includes("live") || (!endedAt && body.CallDuration === undefined);
  const status = text(body.Status);
  const talk = int(body.TalkDuration);
  return {
    providerCallId: id,
    campaignId: text(body.campid),
    live,
    direction: directionOf(body.Direction),
    customerNumber: customer,
    virtualNumber: text(body.DestinationNumber),
    agentNumber: text(body.DialWhomNumber),
    agentName: text(body.receiver_name),
    status,
    answered: !live && wasAnswered(status, talk),
    startedAt,
    answeredAt: callerdeskTime(body.LegB_Picked_time) ?? callerdeskTime(body.LegA_Picked_time),
    endedAt: live ? null : endedAt,
    durationSeconds: int(body.CallDuration),
    talkSeconds: talk,
    ringSeconds: null,
    recordingUrl: recording(body.CallRecordingUrl),
    callGroup: text(body.call_group),
    keyPressed: text(body.key_press),
  };
}

async function ask(method: "GET" | "POST", path: string, authCode: string, params: Record<string, string | number> = {}): Promise<Json> {
  const fields = new URLSearchParams({ authcode: authCode, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  const url = method === "GET" ? `${BASE}/${path}?${fields}` : `${BASE}/${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" } : { Accept: "application/json" },
      body: method === "POST" ? fields.toString() : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    throw new TelephonyError(`CallerDesk didn't answer (${err instanceof Error ? err.message : "no reason given"}).`);
  }
  const raw = await response.text();
  let body: Json;
  try {
    body = JSON.parse(raw) as Json;
  } catch {
    throw new TelephonyError(`CallerDesk answered ${response.status} with something that isn't JSON.`, response.status);
  }
  if (!response.ok) throw new TelephonyError(text(body.message) ?? `CallerDesk answered ${response.status}.`, response.status);
  if (String(body.type ?? "").toLowerCase() === "error") throw new TelephonyError(text(body.message) ?? "CallerDesk refused it.", 400, true);
  return body;
}

/** The list's rows: under `result`, or `data` as some of its answers put them. */
function listedRows(body: Json): Json[] {
  if (Array.isArray(body.result)) return body.result as Json[];
  if (Array.isArray(body.data)) return body.data as Json[];
  return [];
}

/** "No data found" and its kind: an empty page, not a failure. */
const nothingThere = (err: unknown) => err instanceof TelephonyError && err.refused && /no (data|record|call)|not found/i.test(err.message);

/**
 * The customer's number as click-to-call takes it. Numbers are kept with their country code
 * ("+91 98765 43210", src/lib/phone.ts) and CallerDesk writes Indian ones as ten digits, so an Indian
 * number goes as its ten digits; any other goes as it was kept.
 */
export function dialledNumber(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  if (digits.length === 10) return digits;
  return phone.trim();
}

export const callerdesk = {
  /** The account behind a key — trying it. */
  async account(authCode: string): Promise<{ name: string | null }> {
    const body = await ask("POST", "profile_billing_v2", authCode);
    const account = (body.login_account ?? {}) as Json;
    return { name: text(account.company_name) };
  },

  /** What's left on the account: call and click-to-call credits ("coins"), out of the plan's, and when the plan ends. */
  async balance(authCode: string): Promise<TelephonyBalance> {
    const body = await ask("POST", "profile_billing_v2", authCode);
    const a = (body.login_account ?? {}) as Json;
    const pair = (left: unknown, total: unknown) => (text(left) === null ? null : { left: Number.parseInt(String(left), 10) || 0, total: int(total) });
    return {
      calls: pair(a.avail_call_coins, a.call_coins),
      clickToCall: pair(a.avail_clicktocall_coins, a.clicktocall_coins),
      endsAt: callerdeskTime(a.expired_on),
    };
  },

  /** The account's virtual numbers, as click-to-call's `deskphone` takes them. */
  async numbers(authCode: string): Promise<string[]> {
    const body = await ask("POST", "getdeskphone_v2", authCode).catch((err) => {
      if (nothingThere(err)) return { getdeskphone: [] } as Json;
      throw err;
    });
    const rows = Array.isArray(body.getdeskphone) ? (body.getdeskphone as Json[]) : [];
    return [...new Set(rows.map((r) => text(r.deskphone) ?? text(r.did_num)).filter((n): n is string => !!n))];
  },

  /** Every member on the account. */
  async members(authCode: string): Promise<TelephonyMember[]> {
    const out: TelephonyMember[] = [];
    for (let page = 1; page <= 40; page += 1) {
      const body = await ask("POST", "getmemberlist_V2", authCode, { current_page: page }).catch((err) => {
        if (nothingThere(err)) return { getmember: [] } as Json;
        throw err;
      });
      const rows = Array.isArray(body.getmember) ? (body.getmember as Json[]) : [];
      for (const r of rows) {
        const memberId = text(r.member_id);
        const number = text(r.member_num);
        if (memberId && number) out.push({ memberId, name: text(r.member_name) ?? number, number, active: String(r.status ?? "1") === "1" });
      }
      const total = int(body.total_record);
      if (rows.length < MEMBER_PAGE || out.length >= total) break;
    }
    return out;
  },

  /** Rings the member, then the customer. The campaign id names the call in its report. */
  async clickToCall(authCode: string, input: { memberId: string; customerNumber: string; deskphone: string }): Promise<{ campaignId: string | null }> {
    const body = await ask("GET", "click_to_call_v4", authCode, {
      calling_party_b: dialledNumber(input.customerNumber),
      deskphone: input.deskphone,
      call_from_did: 1,
      member_id: input.memberId,
    });
    return { campaignId: text(body.campid) };
  },

  /**
   * One page of a day's calls, and how many the day holds. `said`: CallerDesk's own words when it answered "no data",
   * and `rows`: what it sent before any was read as a call — for saying what happened when nothing arrives.
   */
  async callsOn(authCode: string, day: string, page: number, filter: { callerNumber?: string } = {}): Promise<{ calls: ReportedCall[]; total: number; rows: number; said: string | null }> {
    let said: string | null = null;
    const body = await ask("POST", "call_list_v2", authCode, {
      start_date: day,
      end_date: day,
      current_page: page,
      ...(filter.callerNumber ? { caller_num: filter.callerNumber } : {}),
    }).catch((err) => {
      if (!nothingThere(err)) throw err;
      said = err instanceof Error ? err.message : null;
      return { result: [], total: 0 } as Json;
    });
    const rows = listedRows(body);
    return { calls: rows.map(parseListedCall).filter((c): c is ReportedCall => !!c), total: int(body.total), rows: rows.length, said };
  },

  /**
   * The account's recent calls, asked with nothing but the key — how another integration reads this list live
   * (owner, 31 Oct 2026: CallerDesk had today's calls, Deskzo none). Asked when the dated list brings nothing, in
   * case CallerDesk doesn't take its date filter.
   */
  async recentCalls(authCode: string): Promise<{ calls: ReportedCall[]; rows: number; fields: string[] }> {
    const body = await ask("POST", "call_list_v2", authCode).catch((err) => {
      if (nothingThere(err)) return { result: [] } as Json;
      throw err;
    });
    const rows = listedRows(body);
    // The first row's field names, never its values: what to look at when its calls can't be read.
    return { calls: rows.map(parseListedCall).filter((c): c is ReportedCall => !!c), rows: rows.length, fields: rows[0] ? Object.keys(rows[0]).slice(0, 40) : [] };
  },
};
