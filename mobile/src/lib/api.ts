import * as Crypto from "expo-crypto";
import { calls } from "@/lib/native";
import { readCopy, saveCopy, shownCopyFrom } from "@/lib/offline";

/** Deskzo's /api/app (src/lib/app/handler.ts on the server): `{ data }`, or `{ error: { code, message, fields } }`. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

type Listener = () => void;
const signedOutListeners = new Set<Listener>();

/** Told when Deskzo says this phone is no longer signed in. */
export function onSignedOut(listener: Listener): () => void {
  signedOutListeners.add(listener);
  return () => void signedOutListeners.delete(listener);
}

/** A page Deskzo itself answers 404 to, not in its own words: a company whose Deskzo is older than this app. */
export const NOT_ON_SERVER = "Your company's Deskzo hasn't been updated for this part of the app yet — ask your administrator. Everything else is under More.";

/** Where a list is: Deskzo sends it beside a list's rows (src/lib/app/handler.ts). */
export type Page = { page: number; page_size: number; total: number; has_more: boolean };

/** What a request can say besides its body. */
export type RequestOptions = {
  /**
   * The same for every try of one create (newIdempotencyKey), so a retry after an answer that never
   * arrived gets the record already made back instead of making a second (POST /api/app/leads).
   */
  idempotencyKey?: string;
};

/** A key for one create, kept for as long as the screen making it is open. */
export function newIdempotencyKey(): string {
  return Array.from(Crypto.getRandomBytes(16), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function request<T>(
  where: { baseUrl: string; host: string | null; token?: string | null },
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  options?: RequestOptions,
): Promise<T> {
  return (await requestWithPage<T>(where, method, path, body, options)).data;
}

async function requestWithPage<T>(
  where: { baseUrl: string; host: string | null; token?: string | null },
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  options?: RequestOptions,
): Promise<{ data: T; page: Page | null }> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (where.token) headers.authorization = `Bearer ${where.token}`;
  if (where.host) headers.host = where.host;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (options?.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`${where.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    // No connection: the last copy of the person's own work, if one is kept (offline-rules.ts), rather than a blank screen.
    const copy = method === "GET" ? await readCopy(where.token, where.host, path) : null;
    if (copy) {
      shownCopyFrom(copy.savedAt);
      return { data: copy.data as T, page: copy.page as Page | null };
    }
    throw new ApiError(0, "offline", "Can't reach Deskzo. Check the phone's internet connection.");
  }
  const text = await res.text();
  let json: { data?: T; page?: Page; error?: { code: string; message: string; fields?: Record<string, string> } } = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // Not Deskzo answering — a captive portal, a proxy.
  }
  if (!res.ok) {
    const err = json.error ?? (res.status === 404 ? { code: "not_on_server", message: NOT_ON_SERVER } : { code: `http_${res.status}`, message: "Deskzo didn't answer as expected. Try again in a moment." });
    if (res.status === 401 && err.code === "signed_out") signedOutListeners.forEach((l) => l());
    throw new ApiError(res.status, err.code, err.message, err.fields);
  }
  shownCopyFrom(null);
  if (method === "GET") void saveCopy(where.token, where.host, path, json.data, json.page ?? null);
  return { data: json.data as T, page: json.page ?? null };
}

/** As this phone's person. */
export function api<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown, options?: RequestOptions): Promise<T> {
  const session = calls.getSession();
  if (!session) return Promise.reject(new ApiError(401, "signed_out", "This phone isn't paired."));
  return request<T>(session, method, path, body, options);
}

/** One page of a list, as this phone's person, with where it is in the list. */
export function apiPage<T>(path: string): Promise<{ data: T[]; page: Page | null }> {
  const session = calls.getSession();
  if (!session) return Promise.reject(new ApiError(401, "signed_out", "This phone isn't paired."));
  return requestWithPage<T[]>(session, "GET", path);
}

/** The phone's own sign-in, for what fetch() doesn't carry: a picture in chat, the live stream. Null when not paired. */
export function signedIn(): { baseUrl: string; headers: Record<string, string> } | null {
  const session = calls.getSession();
  if (!session) return null;
  const headers: Record<string, string> = { authorization: `Bearer ${session.token}` };
  if (session.host) headers.host = session.host;
  return { baseUrl: session.baseUrl, headers };
}

/**
 * A form with files, as chat and expense claims send them. Not through fetch: the app's fetch is Expo's, which can't send
 * a file given by its address on the phone (`{ uri, name, type }`) — React Native's own XMLHttpRequest can.
 */
export async function upload<T>(path: string, form: FormData): Promise<T> {
  const where = signedIn();
  if (!where) throw new ApiError(401, "signed_out", "This phone isn't paired.");
  const sent = await new Promise<{ status: number; text: string } | null>((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${where.baseUrl}${path}`);
    for (const [name, value] of Object.entries({ accept: "application/json", ...where.headers })) xhr.setRequestHeader(name, value);
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
    xhr.onerror = () => resolve(null);
    xhr.ontimeout = () => resolve(null);
    xhr.send(form);
  });
  if (!sent) throw new ApiError(0, "offline", "Can't reach Deskzo. Check the phone's internet connection.");
  let json: { data?: T; error?: { code: string; message: string } } = {};
  try {
    json = JSON.parse(sent.text) as typeof json;
  } catch {
    // Not JSON — said below by its status.
  }
  if (sent.status < 200 || sent.status >= 300) {
    if (sent.status === 401 && json.error?.code === "signed_out") signedOutListeners.forEach((l) => l());
    throw new ApiError(sent.status, json.error?.code ?? `http_${sent.status}`, json.error?.message ?? "Deskzo didn't take that. Try again.");
  }
  return json.data as T;
}

// What the server answers (src/lib/app/calls.ts).

export type Me = {
  /** Whether the workspace wants the phone recorder's files for logged calls (src/lib/calls/recordings.ts). */
  recordings?: boolean;
  person: { id: string; name: string; email: string };
  workspace: { name: string | null };
  phone: { id: string; name: string; platform: string; call_sync: boolean };
  /** Older servers answer only calls: a part they don't name, they don't have (src/app/(tabs)/_layout.tsx). */
  can: { calls: boolean; attendance?: boolean; tasks?: boolean; chat?: boolean; leads?: boolean; companies?: boolean; contacts?: boolean; visits?: boolean; expenses?: boolean; calendar?: boolean };
  /** The web's menu for the More tab — what the person may open (src/lib/app/sales.ts); none from an older server. */
  modules?: { group: string; items: { label: string; href: string }[] }[];
  /** The workspace's screen rules for this person (src/lib/app/dlp.ts); none from an older server. */
  screen?: ScreenRulesFromServer;
};

export type ScreenRulesFromServer = {
  screenshots: { limit: number; used: number } | null;
  watermark: { label: string; opacity: number; scope: "CUSTOMER_DATA" | "EVERY_PAGE" } | null;
  copyBlocked?: boolean;
};

export type Outcome = "CONNECTED" | "NO_ANSWER" | "BUSY" | "SWITCHED_OFF" | "WRONG_NUMBER" | "LEFT_VOICEMAIL" | "CALLBACK_REQUESTED" | "NOT_INTERESTED";

export const OUTCOMES: { value: Outcome; label: string }[] = [
  { value: "CONNECTED", label: "Connected" },
  { value: "CALLBACK_REQUESTED", label: "Callback requested" },
  { value: "NOT_INTERESTED", label: "Not interested" },
  { value: "NO_ANSWER", label: "No answer" },
  { value: "BUSY", label: "Busy" },
  { value: "SWITCHED_OFF", label: "Switched off" },
  { value: "LEFT_VOICEMAIL", label: "Left voicemail" },
  { value: "WRONG_NUMBER", label: "Wrong number" },
];

export type ReviewCall = {
  id: string;
  number: string;
  direction: "in" | "out";
  outcome: Outcome;
  started_at: string;
  duration: number;
  contact: string | null;
  company: string;
  lead_id: string | null;
  open_leads: { id: string; ref: string | null; title: string; stage: string }[];
};

export type Callback = { id: string; due_at: string; number: string; contact: string | null; company: string; notes: string | null };

export type Ring = { id: string; number: string; label: string; asked_at: string };

// The everyday screens (src/lib/app/daily.ts).

export type Attendance = { status: string | null; check_in_at: string | null; check_out_at: string | null; worked_minutes: number | null };

/**
 * Whether the person's office checks where they clock (src/lib/app/daily.ts locationOut on the server) — never where
 * the office is. `exception` is one waiting for a decision, or approved and usable now.
 */
export type LocationPolicy = {
  required: boolean;
  configured: boolean;
  office: string | null;
  radius_m: number | null;
  exceptions_allowed: boolean;
  exception: { id: string; status: "APPROVED" | "PENDING"; scope: "IN" | "OUT" | "IN_AND_OUT"; valid_until: string | null; used_in: boolean; used_out: boolean } | null;
};

/** What clocking in or out answers: the day, how the location was checked, and the rule now. */
export type Clocked = Attendance & { check: "INSIDE" | "EXCEPTION" | "NOT_ENFORCED" | null; distance_m: number | null; location: LocationPolicy };

export type ExceptionReason = "ALTERNATE_LOCATION" | "GPS_UNAVAILABLE" | "CORRECTION" | "OTHER";

export type Task = { id: string; title: string; due: string | null; status: string; priority: string | null; company: string | null; can_work: boolean };

export type Today = {
  date: string;
  attendance: Attendance | null;
  /** Absent from a server older than GPS attendance. */
  location?: LocationPolicy | null;
  tasks: { due_today: Task[]; open: number; overdue: number } | null;
  approvals_waiting: number;
  leave: {
    balances: { type_id: string; code: string; name: string; available: number; pending: number }[];
    upcoming: { id: string; type: string; from: string; to: string; days: number; status: string }[];
  } | null;
};

/** What the AI teammates left for the person (owner, 22 Nov 2026 — src/lib/app/waiting.ts on the server). */
export type WaitingKind = "nurture" | "checkin" | "chase";
export type WaitingItem = { teammate: string; teammate_name: string; title: string; detail: string | null; at: string; path: string; decide: { kind: WaitingKind; id: string } | null };
export type WaitingList = { items: WaitingItem[]; total: number };
export type WaitingEmail = {
  kind: WaitingKind;
  id: string;
  teammate_name: string;
  company: string;
  to: string;
  from_problem: string | null;
  subject: string;
  body: string;
  hold_until: string | null;
  lines: string[];
  hint: string;
  path: string;
};
export type WaitingDone = { done: "sent" | "held" | "skipped"; at: string | null };

export type ApprovalKind = "leave" | "correction" | "expense" | "workflow" | "order" | "device" | "attendance-exception";

export type Approval = { kind: ApprovalKind; id: string; title: string; detail: string | null; from: string | null; asked_at: string | null; reason_to_reject: boolean };

export type LeaveRequest = {
  id: string;
  type: string;
  from: string;
  to: string;
  from_half_day: boolean;
  to_half_day: boolean;
  days: number;
  reason: string;
  status: string;
  note: string | null;
  decided_by: string | null;
  asked_at: string | null;
};

export type Leave = {
  types: { id: string; code: string; name: string; paid: boolean }[];
  balances: { type_id: string; name: string; paid: boolean; available: number; pending: number; used: number }[];
  requests: LeaveRequest[];
};
