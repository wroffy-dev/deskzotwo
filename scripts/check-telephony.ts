/**
 * check:telephony — cloud calling through CallerDesk (owner, 26 Oct 2026 — src/lib/telephony).
 *
 *   1. CallerDesk's own samples read right: its call list and both webhooks, India's time, the zero date, which
 *      way a call went, and "Answered" that nobody answered.
 *   2. Connecting: a key CallerDesk refuses isn't kept; a number not on the account is refused; the key kept
 *      encrypted and never shown; the webhook's address carries a secret.
 *   3. Who is who: a member matched to a person, read back from CallerDesk; one member, one person.
 *   4. Call through CallerDesk: the member rung by id, then the customer, from the business number; the call
 *      waits for its report, which — confirmed against the call list though the ids differ — logs it as the
 *      caller's, about what the dialog was about. Never for somebody who isn't a member.
 *   5. The webhook: a wrong address is a 404; a notice the call list doesn't have logs nothing; a customer's
 *      missed call is a callback for the company's owner, once; a number on nobody waits on the line's list.
 *   6. Reading the call list: everything kept once however often it's read, a day already held skipped with
 *      one request, missed calls with no owner to the person picked.
 *   7. The business line's figures: answered, missed, called back and not, unknown numbers.
 *   8. A workspace not migrated yet: nothing breaks.
 *
 * In a scratch workspace built from the migrations, dropped after.
 *
 *   npm run check:telephony
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
// The pages are rendered without a browser: a named notFound, and a router that goes nowhere.
const navigation = {
  notFound: () => {
    throw new Error("notFound");
  },
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/calls/line",
};
const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["@/lib/session", session],
  ["next/navigation", navigation],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("../src/lib/session"), session],
]);
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (byName.has(request)) return byName.get(request);
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && byFile.has(resolved)) return byFile.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

// ── A fake CallerDesk ───────────────────────────────────────────────────────────────────────────

const GOOD_KEY = "zz-callerdesk-key-0001";
/** A key CallerDesk knows, on an account it has switched off. */
const INACTIVE_KEY = "zz-callerdesk-key-0002";
const DESKPHONE = "08069000001";
type Row = Record<string, string | number | null>;
const fake = {
  calls: [] as { method: string; path: string; params: Record<string, string> }[],
  /** The call list, as CallerDesk returns it. */
  list: [] as Row[],
  /** As a real account may: the date filter not taken, every dated read "No Data Found" (owner, 31 Oct 2026). */
  datesIgnored: false,
  members: [
    { member_id: "101", member_name: "Rita Zz", member_num: "09810000099", status: "1" },
    { member_id: "102", member_name: "Sam Zz", member_num: "09810000098", status: "1" },
  ],
  campaign: 777000,
};
const realFetch = globalThis.fetch;
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
/** What profile_billing_v2 says is left. */
const balance = { avail_call_coins: "900", call_coins: "1000", avail_clicktocall_coins: "500", clicktocall_coins: "500", expired_on: "2099-12-31 00:00:00" };
const recordingsAsked: { url: string; range: string | null }[] = [];
async function callerdeskFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input instanceof Request ? input.url : input));
  // A recording: CallerDesk's own host, which honours a Range.
  if (url.hostname === "callrecords.callerdesk.io") {
    const range = new Headers(init?.headers).get("range");
    recordingsAsked.push({ url: url.toString(), range });
    const bytes = new Uint8Array(1000).fill(7);
    return range
      ? new Response(bytes.slice(0, 100), { status: 206, headers: { "content-type": "audio/x-wav", "content-length": "100", "content-range": "bytes 0-99/1000", "accept-ranges": "bytes" } })
      : new Response(bytes, { status: 200, headers: { "content-type": "audio/x-wav", "content-length": "1000" } });
  }
  if (url.hostname !== "app.callerdesk.io") return realFetch(input, init);
  const params = init?.method === "POST" ? Object.fromEntries(new URLSearchParams(String(init.body ?? ""))) : Object.fromEntries(url.searchParams);
  const name = url.pathname.replace("/api/", "");
  fake.calls.push({ method: init?.method ?? "GET", path: name, params });
  if (params.authcode === INACTIVE_KEY) return reply({ type: "error", message: "Account is Inactive please contact administrator!" });
  if (params.authcode !== GOOD_KEY) return reply({ type: "error", message: "Invalid Authcode" });
  if (name === "profile_billing_v2") return reply({ login_account: { company_name: "Zz Telecom Pvt Ltd", ...balance }, type: "success" });
  if (name === "getdeskphone_v2") return reply({ getdeskphone: [{ did_id: "1", did_num: "1206850001", deskphone: DESKPHONE }], type: "success" });
  if (name === "getmemberlist_V2") return reply({ getmember: fake.members, total_record: fake.members.length, type: "success" });
  if (name === "click_to_call_v4") {
    fake.campaign += 1;
    return reply({ type: "success", message: "Call to Customer Initiate Successfully..", campid: fake.campaign, callerid: "120476xxxx" });
  }
  if (name === "call_list_v2") {
    // Asked with the key alone: the recent calls, under `data`, as some of its answers put them.
    if (!params.start_date) return reply({ data: fake.list.slice(-50), type: "success" });
    if (fake.datesIgnored) return reply({ type: "error", message: "No Data Found" });
    const day = params.start_date;
    const rows = fake.list.filter((r) => String(r.startdatetime).slice(0, 10) === day && (!params.caller_num || r.caller_num === params.caller_num));
    if (rows.length === 0) return reply({ type: "error", message: "No Data Found" });
    const page = Number(params.current_page ?? 1);
    return reply({ result: rows.slice((page - 1) * 25, page * 25), current_page: page, total: rows.length, type: "success" });
  }
  return reply({ type: "error", message: `the fake has no ${name}` });
}
globalThis.fetch = callerdeskFetch as typeof fetch;

/** A moment as CallerDesk writes it: India's wall clock. */
const ist = (at: Date) => new Date(at.getTime() + 330 * 60_000).toISOString().replace("T", " ").slice(0, 19);
let sid = 1700000000;
/** A row of CallerDesk's call list. */
function listed(o: { customer: string; at: Date; flow: "IVR" | "WEBOBD"; talk: number; member?: string; memberName?: string; status?: string; id?: string }): Row {
  sid += 1;
  return {
    id: String(sid),
    sid_id: o.id ?? `${sid}.${sid % 1000}`,
    file: o.talk ? `https://callrecords.callerdesk.io/zz/${sid}.wav` : "",
    deskphone: DESKPHONE,
    caller_name: "",
    is_contact: 0,
    member_name: o.memberName ?? "",
    caller_num: o.customer,
    coin_deducted: "1",
    member_num: o.member ?? "",
    call_date: ist(new Date(o.at.getTime() + (o.talk + 20) * 1000)),
    startdatetime: ist(o.at),
    enddatetime: ist(new Date(o.at.getTime() + (o.talk + 20) * 1000)),
    total_duration: String(o.talk + 20),
    talk_duration: String(o.talk),
    ringing_duration: 12,
    key_pressed: "--",
    block: "NO",
    callresult: o.talk ? "Answered" : "Missed",
    callstatus: o.status ?? (o.talk ? "ANSWER" : "NO ANSWER"),
    group_name: "",
    LegA_Picked_time: "0000-00-00 00:00:00",
    LegB_Start_time: "0000-00-00 00:00:00",
    LegB_Picked_time: o.talk ? ist(new Date(o.at.getTime() + 12_000)) : "0000-00-00 00:00:00",
    Flow_type: o.flow,
    contact_id: null,
    Member_type: "1",
  };
}

const MINUTE = 60_000;
const MIGRATION = "prisma/migrations/20261127100000_cloud_telephony/migration.sql";

async function main() {
  section("Where it shows");
  ok("Settings › Cloud calling is in the catalogue, for whoever manages settings, where Calls is", /key: "telephony"[\s\S]{0,500}permission: "settings\.manage",\s+module: "calls"/.test(read("src/lib/settings/catalogue.ts")));
  ok("  its actions are Calls'", read("src/lib/module-actions.ts").includes(`"telephony.ts": ["calls"]`));
  ok("the heartbeat reads the call list", read("src/lib/marketing/heartbeat.ts").includes("telephonyChores("));
  ok("the migration adds the cloud call source and the three tables", read(MIGRATION).includes(`ALTER TYPE "CallSource" ADD VALUE 'CLOUD'`) && /CREATE TABLE "telephony_(connections|agents|calls)"/.test(read(MIGRATION)));
  ok("a call dialog offers it; Calls shows the business line where one was connected", read("src/components/calls/call-button.tsx").includes("callThroughLine(") && read("src/app/(dashboard)/calls/page.tsx").includes("hasTelephony()"));

  section("1. CallerDesk's samples");
  const cd = load("../src/lib/telephony/callerdesk") as typeof import("../src/lib/telephony/callerdesk");
  // Word for word from api.callerdesk.io.
  const report = cd.parseWebhookCall({
    type: "call_report",
    SourceNumber: "08882369xxx",
    DestinationNumber: "0806286xxx",
    DialWhomNumber: "0765208xxx",
    CallDuration: "26",
    coins: "2",
    Status: "ANSWER",
    StartTime: "2024-12-30 12:43:19",
    EndTime: "2024-12-30 12:43:45",
    CallSid: "8397472",
    CallRecordingUrl: "https://newcallrecords.callerdesk.io/outgoing/12_2024/3xxxwav",
    Direction: "WEBOBD",
    campid: "83974xx",
    TalkDuration: "2",
    call_group: "",
    receiver_name: "Aniket",
    error_code: "0",
    LegA_Picked_time: "2024-12-30 12:43:27",
    LegB_Start_time: "2024-12-30 12:43:28",
    LegB_Picked_time: "2024-12-30 12:43:43",
    key_press: "",
    hangup_cause: "ANSWER(16-customer)",
    Uniqueid: "8397472",
  });
  ok("a Call Report: over, out, answered, its talk, recording, campaign and who took it", !!report && !report.live && report.direction === "OUTBOUND" && report.answered && report.talkSeconds === 2 && report.durationSeconds === 26 && report.recordingUrl?.startsWith("https://") === true && report.campaignId === "83974xx" && report.agentName === "Aniket", report);
  ok("  India's time: 12:43:19 there is 07:13:19 UTC", report?.startedAt.toISOString() === "2024-12-30T07:13:19.000Z");
  const live = cd.parseWebhookCall({ SourceNumber: "0928999xxxx", DestinationNumber: "120685xxx", DialWhomNumber: "", Status: "Ringing", StartTime: "2024-12-30 12:43:19", CallSid: "1586420216.7173", Direction: "IVR", call_group: "Sales" });
  ok("a Live Call: still going, in, no outcome", !!live && live.live && live.direction === "INBOUND" && !live.answered && live.endedAt === null);
  ok("  member and call group events aren't calls", cd.parseWebhookCall({ type: "add_member", member_name: "x" }) === null);
  const sampleRow = cd.parseListedCall({
    id: "115545xx",
    sid_id: "1641549947.175xxx9",
    file: "https://callxxxx.callerdesk.io/897809.wav",
    deskphone: "120476xxx",
    member_name: "Kush",
    caller_num: "0928999xxxx",
    member_num: "0728982xxxx",
    startdatetime: "2022-01-07 15:35:47",
    enddatetime: "2022-01-07 15:36:47",
    total_duration: "60",
    talk_duration: "0",
    ringing_duration: 23,
    key_pressed: "--",
    callresult: "Answered",
    callstatus: "Not Connected",
    group_name: "Website",
    LegA_Picked_time: "0000-00-00 00:00:00",
    LegB_Start_time: "0000-00-00 00:00:00",
    LegB_Picked_time: "0000-00-00 00:00:00",
    Flow_type: "IVR",
  });
  ok("the call list's sample: in, and not answered — its callresult says Answered, nobody talked", !!sampleRow && sampleRow.direction === "INBOUND" && !sampleRow.answered && sampleRow.answeredAt === null && sampleRow.keyPressed === null && sampleRow.ringSeconds === 23, sampleRow);
  ok("  the zero date is no date; a day is India's", cd.callerdeskTime("0000-00-00 00:00:00") === null && cd.callerdeskDay(new Date("2026-10-25T19:00:00Z")) === "2026-10-26");

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const realName = new URL(url).pathname.slice(1);
  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratch = `${realName}_telephony`;
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  let close: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratch}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: withDatabase(url, scratch) }, timeout: 10 * 60_000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);
    process.env.DATABASE_URL = withDatabase(url, scratch);
    process.env.CONTROL_DATABASE_URL = "";
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    close = () => db.$disconnect();
    const actions = require("../src/actions/telephony") as typeof import("../src/actions/telephony");
    const sync = require("../src/lib/telephony/sync") as typeof import("../src/lib/telephony/sync");
    const connection = require("../src/lib/telephony/connection") as typeof import("../src/lib/telephony/connection");
    const webhook = require("../src/app/api/telephony/callerdesk/[token]/route") as typeof import("../src/app/api/telephony/callerdesk/[token]/route");
    /* eslint-enable @typescript-eslint/no-require-imports */

    // ── People, customers ──
    const person = (name: string, extra: Record<string, unknown> = {}) =>
      db.user.create({ data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@zz-telephony.in`, passwordHash: "!", role: "SALES", ...extra }, select: { id: true, name: true, email: true, role: true } });
    const boss = await person("Zz Boss", { role: "ADMIN", isSuperAdmin: true });
    const rita = await person("Rita Zz", { phone: "+91 98100 00099" });
    const sam = await person("Sam Zz");
    const as = <T,>(who: { id: string; name: string; email: string | null; role: string }, work: () => Promise<T>) => {
      const before = actor;
      actor = { id: who.id, name: who.name, email: who.email!, role: who.role };
      return work().finally(() => {
        actor = before;
      });
    };
    actor = { id: boss.id, name: boss.name, email: boss.email!, role: boss.role };
    const company = (name: string, ownerUserId: string | null) => db.company.create({ data: { name, normalizedName: name.toLowerCase(), relationshipType: "CLIENT", createdById: boss.id, ownerUserId }, select: { id: true, name: true } });
    const acme = await company("Zz Acme Traders", rita.id);
    const orphan = await company("Zz Nobody Owns Ltd", null);
    const priya = await db.contact.create({ data: { companyId: acme.id, name: "Priya Zz", phone: "+91 98100 00001", isPrimary: true }, select: { id: true } });
    await db.contact.create({ data: { companyId: orphan.id, name: "Omar Zz", phone: "9810000002", isPrimary: true } });
    const lead = await db.lead.create({ data: { title: "Zz Acme — laptops", companyId: acme.id, contactId: priya.id, ownerUserId: rita.id, status: "CONTACTED" }, select: { id: true } }).catch(() => null);

    section("2. Connecting");
    const before = await actions.telephonyView();
    ok("nothing connected: the page offers to connect", before.ok && before.data.migrated && before.data.connection === null);
    const wrong = await actions.connectCallerdesk({ authCode: "zz-not-the-key", deskphone: "" });
    ok("a key CallerDesk refuses isn't kept, and says why", !wrong.ok && wrong.error.includes("Invalid Authcode") && (await db.telephonyConnection.count()) === 0, wrong.ok ? "" : wrong.error);
    const badNumber = await actions.connectCallerdesk({ authCode: GOOD_KEY, deskphone: "011 4000 0000" });
    ok("  a number that isn't the account's is refused, naming the ones it has", !badNumber.ok && badNumber.error.includes(DESKPHONE));
    const connected = await actions.connectCallerdesk({ authCode: GOOD_KEY, deskphone: "" });
    const row = await db.telephonyConnection.findFirst();
    ok("connected: the account's first number, its name, the key encrypted", connected.ok && row?.deskphone === DESKPHONE && row.accountName === "Zz Telecom Pvt Ltd" && !!row.authCodeEnc && !row.authCodeEnc.includes(GOOD_KEY), connected.ok ? "" : connected.error);
    const view = await actions.telephonyView();
    const hook = view.ok ? view.data.connection!.webhookUrl : "";
    const token = hook.split("/").pop() ?? "";
    ok("  the webhook's address is this workspace's, with a secret in it; the key is never shown", hook.includes("/api/telephony/callerdesk/") && token.length >= 24 && !JSON.stringify(view).includes(GOOD_KEY), hook);
    ok("  only its digest is kept to find it by", row?.webhookTokenHash !== token && !(await db.telephonyConnection.findFirst({ where: { webhookTokenHash: token } })));
    const notSettings = await as(sam, () => actions.connectCallerdesk({ authCode: GOOD_KEY }));
    ok("  somebody who doesn't manage settings can't change it", !notSettings.ok);

    section("3. Who is who");
    const members = await actions.telephonyMembers();
    ok("CallerDesk's members listed", members.ok && members.data.length === 2 && members.data[0]!.memberId === "101");
    const matched = await actions.saveTelephonyAgent({ userId: rita.id, memberId: "101" });
    const agent = await db.telephonyAgent.findFirst({ where: { userId: rita.id } });
    ok("Rita is member 101, with CallerDesk's own number for her", matched.ok && agent?.memberNumber === "09810000099" && agent.numberKey === "9810000099");
    const twice = await actions.saveTelephonyAgent({ userId: sam.id, memberId: "101" });
    ok("  one member is one person", !twice.ok && twice.error.includes("Rita Zz"));
    ok("  a member CallerDesk doesn't have is refused", !(await actions.saveTelephonyAgent({ userId: sam.id, memberId: "999" })).ok);

    section("4. Call through CallerDesk");
    ok("Rita's dialog offers the business line; Sam's doesn't", (await as(rita, () => actions.myLine()))?.deskphone === DESKPHONE && (await as(sam, () => actions.myLine())) === null);
    const samTries = await as(sam, () => actions.callThroughLine({ companyId: acme.id, phoneNumber: "9810000001" }));
    ok("  Sam isn't a member: refused, saying how to be one", !samTries.ok && samTries.error.includes("Cloud calling"));
    const placed = await as(rita, () => actions.callThroughLine({ companyId: acme.id, contactId: priya.id, phoneNumber: "+91 98100 00001", leadId: lead?.id }));
    const ring = fake.calls.findLast((c) => c.path === "click_to_call_v4");
    // An Indian number goes as its ten digits, as CallerDesk writes them (dialledNumber, since c84c2110).
    ok("CallerDesk rings member 101, then the customer, from the business number", placed.ok && ring?.params.member_id === "101" && ring.params.calling_party_b === "9810000001" && ring.params.deskphone === DESKPHONE && ring.params.call_from_did === "1", ring?.params);
    const requested = placed.ok ? await db.telephonyCall.findUnique({ where: { id: placed.data.id } }) : null;
    ok("  the call waits for its report, with its campaign and what it was about", requested?.state === "REQUESTED" && requested.campaignId === String(fake.campaign) && requested.contactId === priya.id && requested.leadId === (lead?.id ?? null));

    // Rita picks up and they talk for 95 seconds; CallerDesk's list has the call under another id than the webhook's.
    const placedAt = new Date(Date.now() - 3 * MINUTE);
    fake.list.push(listed({ customer: "09810000001", at: placedAt, flow: "WEBOBD", talk: 95, member: "09810000099", memberName: "Rita Zz", id: "1761400000.501" }));
    const post = (body: Record<string, unknown>, t = token) =>
      webhook.POST(new Request(`http://localhost:3000/api/telephony/callerdesk/${t}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ token: t }) });
    const reportBody = (o: { customer: string; at: Date; flow: string; talk: number; agent?: string; campid?: string | number; sid: string; status?: string }) => ({
      type: "call_report",
      SourceNumber: o.customer,
      DestinationNumber: DESKPHONE,
      DialWhomNumber: o.agent ?? "",
      CallDuration: String(o.talk + 20),
      Status: o.status ?? (o.talk ? "ANSWER" : "NO ANSWER"),
      StartTime: ist(o.at),
      EndTime: ist(new Date(o.at.getTime() + (o.talk + 20) * 1000)),
      CallSid: o.sid,
      CallRecordingUrl: "",
      Direction: o.flow,
      campid: o.campid ?? "",
      TalkDuration: String(o.talk),
      receiver_name: "",
    });
    const res = await post(reportBody({ customer: "09810000001", at: placedAt, flow: "WEBOBD", talk: 95, agent: "09810000099", campid: fake.campaign, sid: "8397999" }));
    // `source` is named: CallLog's newer columns are left out of select-less reads (NOT_YET_EVERYWHERE).
    const after = placed.ok
      ? await db.telephonyCall.findUnique({
          where: { id: placed.data.id },
          include: { callLog: { select: { userId: true, source: true, durationSeconds: true, outcome: true, contactId: true, leadId: true } } },
        })
      : null;
    ok("its report arrives: the request found by campaign, confirmed from the list, logged", res.status === 200 && after?.state === "ENDED" && !!after.confirmedAt && after.providerCallId === "1761400000.501" && !!after.callLog, { status: res.status, state: after?.state, id: after?.providerCallId });
    ok("  logged as Rita's, through the business line, 95 s, about Priya and the lead", after?.callLog?.userId === rita.id && after.callLog.source === "CLOUD" && after.callLog.durationSeconds === 95 && after.callLog.outcome === "CONNECTED" && after.callLog.contactId === priya.id && after.callLog.leadId === (lead?.id ?? null), { log: after?.callLog, lead: lead?.id });
    ok("  the dialog sees it logged", placed.ok && (await as(rita, () => actions.lineCallState(placed.data.id)))?.logged === true && (await as(sam, () => actions.lineCallState(placed.data.id))) === null);
    await post(reportBody({ customer: "09810000001", at: placedAt, flow: "WEBOBD", talk: 95, agent: "09810000099", campid: fake.campaign, sid: "8397999" }));
    ok("  the same report again: still one call, logged once", (await db.telephonyCall.count({ where: { customerKey: "9810000001" } })) === 1 && (await db.callLog.count({ where: { source: "CLOUD", contactId: priya.id } })) === 1);

    section("5. The webhook");
    const lost = await post(reportBody({ customer: "09810000001", at: new Date(), flow: "IVR", talk: 0, sid: "1" }), "x".repeat(40));
    ok("a wrong address: 404", lost.status === 404);
    const forged = await post(reportBody({ customer: "09810000003", at: new Date(Date.now() - MINUTE), flow: "IVR", talk: 30, sid: "forged-1" }));
    const forgedRow = await db.telephonyCall.findFirst({ where: { providerCallId: "forged-1" } });
    ok("a notice the call list doesn't have: kept, not believed, nothing logged", forged.status === 200 && !!forgedRow && forgedRow.confirmedAt === null && forgedRow.callLogId === null);

    const missedAt = new Date(Date.now() - 10 * MINUTE);
    fake.list.push(listed({ customer: "09810000001", at: missedAt, flow: "IVR", talk: 0 }));
    await post(reportBody({ customer: "09810000001", at: missedAt, flow: "IVR", talk: 0, sid: "w-miss-1" }));
    const missedLog = await db.callLog.findFirst({ where: { source: "CLOUD", direction: "INBOUND", contactId: priya.id }, include: { followUpTask: true } });
    ok("Priya rang and nobody answered: a callback for Acme's owner, due at once", missedLog?.userId === rita.id && missedLog.outcome === "NO_ANSWER" && !!missedLog.followUpAt && missedLog.followUpTask?.assignedToUserId === rita.id, missedLog);
    const again = new Date(Date.now() - 6 * MINUTE);
    fake.list.push(listed({ customer: "09810000001", at: again, flow: "IVR", talk: 0 }));
    await post(reportBody({ customer: "09810000001", at: again, flow: "IVR", talk: 0, sid: "w-miss-2" }));
    ok("  she rang again: logged, but still the one callback", (await db.callLog.count({ where: { source: "CLOUD", direction: "INBOUND", contactId: priya.id } })) === 2 && (await db.task.count({ where: { title: { contains: "missed call" }, assignedToUserId: rita.id } })) === 1);

    const strangerAt = new Date(Date.now() - 20 * MINUTE);
    fake.list.push(listed({ customer: "07000000123", at: strangerAt, flow: "IVR", talk: 40, member: "09810000099", memberName: "Rita Zz" }));
    await post(reportBody({ customer: "07000000123", at: strangerAt, flow: "IVR", talk: 40, agent: "09810000099", sid: "w-stranger" }));
    const stranger = await db.telephonyCall.findFirst({ where: { customerKey: "7000000123" } });
    ok("a number on nobody: kept and confirmed, Rita's, not logged on Calls", !!stranger?.confirmedAt && stranger.agentUserId === rita.id && stranger.callLogId === null);

    const liveRes = await post({ type: "live_call", SourceNumber: "09810000001", DestinationNumber: DESKPHONE, DialWhomNumber: "09810000099", Status: "Picked", StartTime: ist(new Date()), CallSid: "live-1", Direction: "IVR" });
    const liveRow = await db.telephonyCall.findFirst({ where: { providerCallId: "live-1" } });
    ok("a Live Call: a call going on now, not logged", liveRes.status === 200 && liveRow?.state === "LIVE" && liveRow.callLogId === null);
    ok("  as GET, with the fields in the address, too", (await webhook.GET(new Request(`http://localhost:3000/api/telephony/callerdesk/${token}?SourceNumber=09810000005&StartTime=${encodeURIComponent(ist(new Date()))}&CallSid=get-1&Direction=IVR&Status=Ringing`), { params: Promise.resolve({ token }) })).status === 200 && !!(await db.telephonyCall.findFirst({ where: { providerCallId: "get-1" } })));

    section("6. Reading the call list");
    // Calls CallerDesk has that no webhook told us of: yesterday's, and an orphaned company's missed call.
    const yesterday = new Date(Date.now() - 26 * 3_600_000);
    for (let i = 0; i < 30; i += 1) fake.list.push(listed({ customer: `0711111${String(1000 + i)}`, at: new Date(yesterday.getTime() + i * MINUTE), flow: "IVR", talk: i % 3 ? 20 : 0, member: i % 3 ? "09810000099" : "" }));
    fake.list.push(listed({ customer: "09810000002", at: new Date(Date.now() - 40 * MINUTE), flow: "IVR", talk: 0 }));
    await actions.saveMissedCallsPerson(sam.id);
    const conn = (await connection.activeConnection())!;
    const first = await sync.syncConnection(conn.id, { budgetMs: 60_000 });
    const kept = await db.telephonyCall.count({ where: { confirmedAt: { not: null } } });
    ok("the first read goes back 30 days and keeps every call — 30 yesterday, two pages", first.error === null && first.done && kept === fake.list.length, { first, kept, listed: fake.list.length });
    const omar = await db.callLog.findFirst({ where: { source: "CLOUD", company: { name: "Zz Nobody Owns Ltd" } } });
    ok("  a missed call to a company nobody owns goes to the person picked", omar?.userId === sam.id && !!omar.followUpTaskId);
    const second = await sync.syncConnection(conn.id, { budgetMs: 60_000 });
    ok("read again: nothing new kept, a day already held is one request", (await db.telephonyCall.count({ where: { confirmedAt: { not: null } } })) === kept && second.calls === 0 && second.requests <= 3, second);
    ok("  the forged notice is still not believed", (await db.telephonyCall.findFirst({ where: { providerCallId: "forged-1" } }))?.confirmedAt === null);

    section("6b. A call list that doesn't take dates");
    // CallerDesk had today's calls and Deskzo none (owner, 31 Oct 2026): the dated read found nothing, every day.
    fake.datesIgnored = true;
    fake.list.push(listed({ customer: "09810000003", at: new Date(Date.now() - 10 * MINUTE), flow: "IVR", talk: 30, member: "09810000099", id: "undated-1" }));
    await db.telephonyConnection.update({ where: { id: conn.id }, data: { syncedThrough: null } });
    const viaRecent = await sync.syncConnection(conn.id, { budgetMs: 60_000 });
    ok("nothing by date: its recent calls are read instead, and the new one kept", viaRecent.error === null && !!(await db.telephonyCall.findFirst({ where: { providerCallId: "undated-1", confirmedAt: { not: null } } })), viaRecent);
    ok("  asked with the key alone, read from `data`; and it says so", fake.calls.some((c) => c.path === "call_list_v2" && !c.params.start_date) && /dated call list gave 0 row\(s\) \(CallerDesk: "No Data Found"\); its recent-calls list gave \d+, \d+ of them readable/.test(viaRecent.note ?? ""), viaRecent.note);
    fake.datesIgnored = false;
    const askedBefore = fake.calls.length;
    await sync.syncConnection(conn.id, { budgetMs: 60_000 });
    ok("  a list that does take dates: never asked without them", !fake.calls.slice(askedBefore).some((c) => c.path === "call_list_v2" && !c.params.start_date));

    section("6c. Read calls now, from the Calls pages");
    await db.telephonyConnection.update({ where: { id: conn.id }, data: { lastSyncAt: new Date() } });
    const tooSoon = await as(rita, () => actions.readCallsNow());
    ok("once a minute at most, whoever asks", !tooSoon.ok && /try again in a minute/.test(tooSoon.ok ? "" : tooSoon.error), tooSoon);
    await db.telephonyConnection.update({ where: { id: conn.id }, data: { lastSyncAt: new Date(Date.now() - 120_000) } });
    const byRita = await as(rita, () => actions.readCallsNow());
    ok("  after that, anyone on calls reads them — not only whoever manages settings", byRita.ok, byRita);

    section("7. The business line's figures");
    const lineReport = await actions.businessLineReport({});
    ok("everything in the week: in, answered, missed", !!lineReport && lineReport.connected && lineReport.totals.incoming === fake.list.filter((r) => r.Flow_type === "IVR").length && lineReport.totals.outgoing === 1, lineReport?.totals);
    const missedTotal = fake.list.filter((r) => r.Flow_type === "IVR" && r.talk_duration === "0").length;
    // Priya rang at −10 and −6 minutes and Rita called her at −3: both called back, in 5 minutes as the middle value.
    ok("  missed counted; Priya's two called back by Rita's call after them", lineReport?.totals.missed === missedTotal && lineReport.missedWaiting.every((m) => m.number !== "09810000001") && lineReport.totals.calledBack >= 2, lineReport?.missedWaiting.slice(0, 3));
    ok("  the stranger is a number not on file, answered by Rita", !!lineReport?.unknown.find((u) => u.number === "07000000123" && u.lastAnsweredBy === "Rita Zz"));
    ok("  Rita answered and called out", (lineReport?.people.find((p) => p.userId === rita.id)?.outgoing ?? 0) === 1 && (lineReport?.people.find((p) => p.userId === rita.id)?.answered ?? 0) > 0);
    const samView = await as(sam, () => actions.businessLineReport({}));
    ok("  somebody who sees only their own calls sees only those", !!samView && !samView.everyone && samView.totals.incoming < (lineReport?.totals.incoming ?? 0));

    section("9. Recordings, how it went, leads from calls, the balance");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const callActions = require("../src/actions/call") as typeof import("../src/actions/call");
    const recording = require("../src/app/api/telephony/recordings/[id]/route") as typeof import("../src/app/api/telephony/recordings/[id]/route");
    const types = require("../src/lib/telephony/types") as typeof import("../src/lib/telephony/types");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const ritasCall = (await as(rita, () => callActions.listCalls({ page: 1, pageSize: 50 }))).rows.find((r) => r.direction === "OUTBOUND" && r.contact?.id === priya.id) as
      | { id: string; cloud: { recordingId: string | null; mayReview: boolean } | null }
      | undefined;
    ok("Calls shows Rita's call through the line with its recording, and asks her how it went", !!ritasCall?.cloud?.recordingId && ritasCall.cloud.mayReview, ritasCall?.cloud);
    const bossSees = (await callActions.listCalls({ page: 1, pageSize: 50 })).rows.find((r) => r.id === ritasCall?.id) as { cloud: { recordingId: string | null; mayReview: boolean } | null } | undefined;
    ok("  the boss sees the recording too, but it isn't his to write up", !!bossSees?.cloud?.recordingId && !bossSees.cloud.mayReview);
    const play = (who: Actor | null, id: string, range?: string) => {
      const before = actor;
      actor = who;
      return recording.GET(new Request(`http://localhost:3000/api/telephony/recordings/${id}`, { headers: range ? { range } : {} }), { params: Promise.resolve({ id }) }).finally(() => {
        actor = before;
      });
    };
    const ritaActor = { id: rita.id, name: rita.name, email: rita.email!, role: rita.role };
    const samActor = { id: sam.id, name: sam.name, email: sam.email!, role: sam.role };
    const heard = await play(ritaActor, ritasCall!.cloud!.recordingId!);
    ok("Rita plays it: the audio, through Deskzo, from CallerDesk's own link", heard.status === 200 && heard.headers.get("content-type") === "audio/x-wav" && (await heard.arrayBuffer()).byteLength === 1000 && recordingsAsked.at(-1)!.url.startsWith("https://callrecords.callerdesk.io/"));
    const seek = await play(ritaActor, ritasCall!.cloud!.recordingId!, "bytes=0-99");
    ok("  a seek's Range is passed on, and CallerDesk's part comes back", seek.status === 206 && seek.headers.get("content-range") === "bytes 0-99/1000" && recordingsAsked.at(-1)!.range === "bytes=0-99");
    ok("  Sam, who can't see her calls, gets nothing; nor does nobody", (await play(samActor, ritasCall!.cloud!.recordingId!)).status === 404 && (await play(null, ritasCall!.cloud!.recordingId!)).status === 404);
    await db.telephonyCall.update({ where: { id: ritasCall!.cloud!.recordingId! }, data: { recordingUrl: "https://evil.example.com/x.wav" } });
    ok("  a link to anywhere but CallerDesk is never fetched", (await play(ritaActor, ritasCall!.cloud!.recordingId!)).status === 404 && !recordingsAsked.some((r) => r.url.includes("evil")));
    const strangerCall = await db.telephonyCall.findFirst({ where: { customerKey: "7000000123" }, select: { id: true } });
    ok("  a call by a number on nobody: Rita took it, so she may hear it; Sam may not", (await play(ritaActor, strangerCall!.id)).status === 200 && (await play(samActor, strangerCall!.id)).status === 404);

    const notHers = await as(sam, () => actions.reviewCloudCall(ritasCall!.id, { outcome: "CONNECTED", notes: "x" }));
    ok("how it went: only the caller's own", !notHers.ok);
    const noWhen = await as(rita, () => actions.reviewCloudCall(ritasCall!.id, { outcome: "CALLBACK_REQUESTED", notes: "Wants a quote" }));
    ok("  a callback asked for needs a time", !noWhen.ok && noWhen.error.includes("say when"));
    const reviewed = await as(rita, () => actions.reviewCloudCall(ritasCall!.id, { outcome: "CALLBACK_REQUESTED", notes: "Wants a quote for 20 laptops", followUpAt: "2099-01-05T11:00" }));
    const afterReview = await db.callLog.findUnique({ where: { id: ritasCall!.id }, select: { outcome: true, notes: true, reviewedAt: true, followUpAt: true, followUpTask: { select: { assignedToUserId: true, title: true } } } });
    ok("  Rita's word: the outcome, the notes, a callback task for her", reviewed.ok && afterReview?.outcome === "CALLBACK_REQUESTED" && afterReview.notes === "Wants a quote for 20 laptops" && !!afterReview.reviewedAt && afterReview.followUpTask?.assignedToUserId === rita.id, afterReview);
    const reviewedRow = (await as(rita, () => callActions.listCalls({ page: 1, pageSize: 50 }))).rows.find((r) => r.id === ritasCall!.id) as { cloud: { mayReview: boolean } | null } | undefined;
    ok("  and it isn't asked again", reviewedRow?.cloud?.mayReview === false);

    ok("the balance: plenty is nothing to say", types.balanceWarning({ calls: { left: 900, total: 1000 }, clickToCall: { left: 500, total: 500 }, endsAt: new Date("2099-01-01") }) === null);
    const lowWords = types.balanceWarning({ calls: { left: 40, total: 1000 }, clickToCall: null, endsAt: new Date(Date.now() + 3 * 86_400_000) });
    ok("  under a tenth, and a plan ending this week, said in words", !!lowWords && lowWords.includes("40 call credits left") && lowWords.includes("ends in 3 days"), lowWords);
    balance.avail_call_coins = "40";
    const reconnected = await actions.connectCallerdesk({ authCode: "" });
    ok("(still connected for the balance)", reconnected.ok, reconnected.ok ? "" : reconnected.error);
    const liveConn = (await connection.activeConnection())!;
    const warned = await sync.checkBalance(liveConn.id, new Date());
    const told = await db.notification.findMany({ where: { type: "CLOUD_CALLING_ALERT" }, select: { userId: true, link: true } });
    ok("running low: whoever manages settings is told — the boss, not Rita or Sam", !!warned && told.length === 1 && told[0]!.userId === boss.id && told[0]!.link === "/settings/telephony", told);
    await sync.checkBalance(liveConn.id, new Date(Date.now() + 2 * 3_600_000));
    ok("  asked again two hours on: not told twice the same day", (await db.notification.count({ where: { type: "CLOUD_CALLING_ALERT" } })) === 1);
    ok("  and within the hour, CallerDesk isn't even asked", (await sync.checkBalance(liveConn.id, new Date(Date.now() + 2 * 3_600_000 + 60_000))) === null);
    const viewLow = await actions.telephonyView();
    ok("  the settings page shows what's left, and the warning", viewLow.ok && viewLow.data.connection?.balance?.calls?.left === 40 && !!viewLow.data.connection.balance.warning);
    balance.avail_call_coins = "900";

    section("The pages, rendered");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
    const { cloneElement, isValidElement } = require("react") as typeof import("react");
    const SettingsPageRoute = (require("../src/app/(dashboard)/settings/telephony/page") as typeof import("../src/app/(dashboard)/settings/telephony/page")).default;
    const LinePageRoute = (require("../src/app/(dashboard)/calls/line/page") as typeof import("../src/app/(dashboard)/calls/line/page")).default;
    /* eslint-enable @typescript-eslint/no-require-imports */
    // Nested async server components (SettingsPage) awaited before rendering, children re-attached as arguments.
    const resolveAsync = async (node: unknown): Promise<unknown> => {
      if (Array.isArray(node)) return Promise.all(node.map(resolveAsync));
      if (!isValidElement(node)) return node;
      const el = node as import("react").ReactElement<{ children?: unknown }>;
      if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") return resolveAsync(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
      if (el.props && "children" in el.props) {
        const kids = await resolveAsync(el.props.children);
        return Array.isArray(kids) ? cloneElement(el, undefined, ...(kids as import("react").ReactNode[])) : cloneElement(el, undefined, kids as import("react").ReactNode);
      }
      return el;
    };
    const render = async (el: unknown) => renderToStaticMarkup((await resolveAsync(el)) as import("react").ReactElement);
    const settingsHtml = await render(await SettingsPageRoute());
    ok("Settings › Cloud calling: connected, the number, the webhook's address, Rita matched, missed calls to Sam", settingsHtml.includes("Zz Telecom Pvt Ltd") && settingsHtml.includes(DESKPHONE) && settingsHtml.includes(token) && settingsHtml.includes("Rita Zz") && settingsHtml.includes("Missed calls") && !settingsHtml.includes(GOOD_KEY));
    const lineHtml = await render(await LinePageRoute({ searchParams: Promise.resolve({}) }));
    ok("Calls › Business line: the totals, the hours, people, numbers and the numbers not on file", lineHtml.includes("Calls in") && lineHtml.includes("Not called back") && lineHtml.includes("07000000123") && lineHtml.includes(DESKPHONE) && lineHtml.includes("Rita Zz"));
    ok("  and Read calls now, with when they were last read", lineHtml.includes("Read calls now") && lineHtml.includes("Last read"));
    ok("  a number on nobody offers to become a lead", lineHtml.includes("/leads/new?phone=07000000123") && lineHtml.includes("Make a lead"));
    /* eslint-disable @typescript-eslint/no-require-imports */
    const NewLeadRoute = (require("../src/app/(dashboard)/leads/new/page") as typeof import("../src/app/(dashboard)/leads/new/page")).default;
    const ReportRoute = (require("../src/app/(dashboard)/calls/report/page") as typeof import("../src/app/(dashboard)/calls/report/page")).default;
    /* eslint-enable @typescript-eslint/no-require-imports */
    const leadHtml = await render(await NewLeadRoute({ searchParams: Promise.resolve({ phone: "07000000123" }) }));
    // The source and its detail are the form's defaultValues, which react-hook-form puts into its inputs once
    // mounted in a browser — not in a static render — so here it's the banner and the number that show.
    ok("New lead from the call: says it's from the call, with the number", leadHtml.includes("From a call by") && leadHtml.includes("07000000123"));
    const sneaky = await render(await NewLeadRoute({ searchParams: Promise.resolve({ phone: "<script>x</script>" }) }));
    ok("  anything but a number in the address is ignored", !sneaky.includes("From a call by"));
    const today = (await (require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace")).workspaceClock()).today(); // eslint-disable-line @typescript-eslint/no-require-imports
    const reportHtml = await render(await ReportRoute({ searchParams: Promise.resolve({ from: today, to: today }) }));
    ok("Calls › Team report links to the business line", reportHtml.includes('href="/calls/line"'));

    section("Only what's chosen: outgoing, incoming, reports");
    const inactive = await actions.connectCallerdesk({ authCode: INACTIVE_KEY, outgoing: false });
    ok("an account CallerDesk has switched off: says so, and to ask CallerDesk", !inactive.ok && inactive.error.includes("isn't active") && inactive.error.includes("activate"), inactive.ok ? "" : inactive.error);
    const asked = fake.calls.length;
    const reportsOnly = await actions.connectCallerdesk({ authCode: "", outgoing: false, incomingCallbacks: false });
    const ro = await db.telephonyConnection.findFirst({ select: { deskphone: true, incomingCallbacks: true } });
    ok("reports only: saved with no business number and no callbacks", reportsOnly.ok && ro?.deskphone === "" && ro.incomingCallbacks === false, reportsOnly.ok ? "" : reportsOnly.error);
    const triedOn = fake.calls.slice(asked).map((c) => c.path);
    ok("  the key tried on the call list, the numbers not asked for", triedOn.includes("call_list_v2") && !triedOn.includes("getdeskphone_v2"), triedOn.join(", "));
    const roView = await actions.telephonyView();
    ok("  the page shows it", roView.ok && roView.data.connection?.deskphone === "" && roView.data.connection.incomingCallbacks === false);
    ok("  Rita's dialog no longer offers to call through it", (await as(rita, () => actions.myLine())) === null);
    const noDial = await as(rita, () => actions.callThroughLine({ companyId: acme.id, phoneNumber: "9810000001" }));
    ok("  and calling through it is refused", !noDial.ok && noDial.error.includes("calls and recordings only"), noDial.ok ? "" : noDial.error);
    const zed = await db.contact.create({ data: { companyId: acme.id, name: "Zed Zz", phone: "+91 98100 00007" }, select: { id: true } });
    const quietAt = new Date(Date.now() - 3 * MINUTE);
    fake.list.push(listed({ customer: "09810000007", at: quietAt, flow: "IVR", talk: 0 }));
    await post(reportBody({ customer: "09810000007", at: quietAt, flow: "IVR", talk: 0, sid: "w-quiet-1" }));
    const quietLog = await db.callLog.findFirst({ where: { source: "CLOUD", direction: "INBOUND", contactId: zed.id } });
    ok("a missed call with incoming off: logged, no callback", !!quietLog && quietLog.followUpAt === null && quietLog.followUpTaskId === null, quietLog);
    const both = await actions.connectCallerdesk({ authCode: "", outgoing: true, incomingCallbacks: true });
    const back = await db.telephonyConnection.findFirst({ select: { deskphone: true, incomingCallbacks: true } });
    ok("outgoing and incoming on again: the account's number back, callbacks on", both.ok && back?.deskphone === DESKPHONE && back.incomingCallbacks === true);

    section("Disconnecting");
    const gone = await actions.disconnectTelephony();
    const after2 = await db.telephonyConnection.findFirst();
    ok("the key wiped, the members cleared, the calls kept", gone.ok && after2?.active === false && after2.authCodeEnc === "" && (await db.telephonyAgent.count()) === 0 && (await db.telephonyCall.count()) > 0);
    ok("  the old webhook address stops working", (await post(reportBody({ customer: "09810000001", at: new Date(), flow: "IVR", talk: 0, sid: "late" }))).status === 404);
    ok("  Calls still shows the business line's history", await connection.hasTelephony());

    section("8. A workspace not migrated yet");
    await db.$executeRawUnsafe('DROP TABLE "telephony_calls", "telephony_agents", "telephony_connections" CASCADE');
    ok("no connection, nothing to read, no business line", (await connection.activeConnection()) === null && ((await sync.telephonyChores()) ?? []).length === 0 && !(await connection.hasTelephony()));
    const bare = await actions.telephonyView();
    ok("  the settings page says it's being updated", bare.ok && !bare.data.migrated);
  } finally {
    actor = null;
    globalThis.fetch = realFetch;
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratch}'`);
    ok("the scratch database is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} cloud calling checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
