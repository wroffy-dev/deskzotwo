import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { cidrContains, parseCidr, parseIp } from "@/lib/access/ip";
import { clientIpFrom } from "@/lib/client-ip";
import { ACK, MAX_BODY_BYTES, handshakeResponse, parseAttlog, tableOf } from "@/lib/hr/iclock";
import { linkPunchesToUsers, rollupPunches } from "@/lib/hr/punch-rollup";
import { tenantForDeviceSerial, touchDeviceRoute } from "@/lib/platform/device-routes";
import { HOST_MISMATCH, requestHost } from "@/lib/tenancy/host";
import { tenantForHost } from "@/lib/tenancy/registry";
import { runAsTenant } from "@/lib/tenancy/resolve";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { lockoutState, recordFailure } from "@/lib/security/lockout";
import { readTextWithin } from "@/lib/http/body";
import { deviceKeyAccepted, deviceKeyHashOf } from "@/lib/hr/device-key";
import type { Tenant } from "@/lib/tenancy/state";

/**
 * Where eSSL / ZKTeco terminals push their attendance.
 *
 * ── Security, stated plainly ─────────────────────────────────────────────────
 *
 * The iclock protocol has no authentication. None. A terminal announces a serial number and starts
 * uploading, and the firmware offers no way to add a header, a token or a client certificate. That
 * is the protocol, not an oversight here, and it means this endpoint must be treated as a
 * LAN-facing one: reachable from the office network or over a VPN, never published to the internet.
 *
 * On the hosted platform that is not always possible — a customer's terminal reaches the server over
 * the internet, at its workspace's address or the platform's `devices.` host. Then the serial number
 * is the only thing identifying it, and a serial is printed on the device. Everything below still
 * holds, and a serial is only ever routed to the one workspace that registered it
 * (src/lib/platform/device-routes.ts); what is missing is proof the sender *is* that terminal. The
 * one proof the protocol leaves room for is where the request came from: HR can give a terminal the
 * addresses it calls from (owner, 2 Nov 2026 — "Phase 1 security fixes", audit M-8), and then a
 * request from anywhere else is refused before anything is read. A terminal without a list has its
 * uploads refused unless HR has ticked "accept from any address" for it (security audit, Nov 2026) —
 * and then its punches are as trustworthy as the network they came over.
 *
 * And one more, where the terminal's settings take a web address (owner, 12 Nov 2026 — security audit SEC-06): HR can
 * give a terminal its own secret address, /iclock-k/<key>, and from then on a request naming its serial without the
 * key is refused as an unknown serial is (src/lib/hr/device-key.ts). The serial alone no longer speaks for it.
 *
 * Given that, the defences that are actually available are used:
 *
 *   · A serial must be registered and active before a single row is accepted. An unknown serial
 *     gets a flat refusal and is recorded, so an unexpected terminal is visible rather than silent.
 *   · A terminal with an address list is answered only from those addresses (see addressAllowed);
 *     a call from anywhere else is refused and recorded, and does not count as the terminal being seen.
 *   · Nothing here creates people. An unrecognised enrolment number produces a punch attached to
 *     nobody, waiting to be mapped by hand — so a fabricated upload cannot invent an employee.
 *   · A day already covered by approved leave, or corrected by HR, is never overwritten
 *     (see src/lib/hr/punch-rollup.ts). The worst a rogue upload can do is add a present day for a
 *     person who is already mapped, which is visible on the attendance grid.
 *   · Bodies are size-capped, because the device sets no limit. The cap is set above a terminal's
 *     whole memory, since that is what a first upload is (see MAX_BODY_BYTES).
 *
 * ── Replies ──────────────────────────────────────────────────────────────────
 *
 * Plain text, always. A device that receives JSON, HTML, or a redirect to the login page treats the
 * batch as failed and re-sends it — forever. That last one is why `/iclock` is excluded from the
 * auth middleware: without it, every upload would be answered with a 307 to /login and the terminal
 * would never make progress.
 */

/** Rows per insert, well inside Postgres's 65,535 bind parameters at six columns a row. */
const INSERT_CHUNK = 5_000;

/**
 * A serial as it may appear in a log line (security audit, 11 Nov 2026 — SEC-06): letters, digits and dashes, cut
 * short. It came straight from the query string, so a new line in it wrote a forged entry into the CERT-In logs.
 */
const shown = (serial: string | null) => (serial ? serial.replace(/[^A-Za-z0-9_-]/g, "?").slice(0, 40) : "-");

/**
 * Guessing serials (SEC-06): an address that names unknown terminals — or a known one from outside its list — more than
 * a few times in ten minutes is answered "not registered" without being looked up. A terminal that's registered never
 * misses, so it never meets this.
 */
const guessKey = (request: Request) => `iclock-miss|${clientIpFrom(request.headers) ?? "unknown"}`;
const NOT_REGISTERED = () => text("Device not registered", 401);

/** Punches stamped further ahead than this are a wrong clock or a forgery, and are left out (SEC-06). */
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

function text(body: string, status = 200) {
  return new NextResponse(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/**
 * Whether a terminal with this address list may call from where this request came from (audit M-8).
 *
 * An empty list is any address — a terminal registered before lists existed, or by HR who left it blank, keeps
 * working. Otherwise the caller's address must fall inside one of the entries, each an exact IP or a CIDR range
 * (saved canonical by saveBiometricDevice, matched by the same code as the network rules: src/lib/access/ip.ts).
 * The address is the one our own proxy reports (src/lib/client-ip.ts, which honours TRUST_PROXY); when there is
 * none, nobody can be shown to be on the list, so a terminal with one is refused — as the console's allowlist does,
 * rather than trusting a header anybody can write.
 */
function addressAllowed(allowedIps: string[], request: Request): { ok: true } | { ok: false; caller: string | null } {
  if (allowedIps.length === 0) return { ok: true };
  const caller = clientIpFrom(request.headers);
  const ip = parseIp(caller);
  if (!ip) return { ok: false, caller };
  const listed = allowedIps.some((entry) => {
    const cidr = parseCidr(entry);
    return !!cidr && cidrContains(cidr, ip);
  });
  return listed ? { ok: true } : { ok: false, caller };
}

/** Resolves and stamps the calling terminal, or explains why it is not welcome. */
async function authenticateDevice(serial: string | null, request: Request, key: string | null) {
  if (!serial) return { error: text("Missing SN", 400) };
  if (lockoutState([guessKey(request)]).lockedOut) return { error: NOT_REGISTERED() };

  const device = await db.biometricDevice.findUnique({ where: { serialNumber: serial } });
  if (!device) {
    // Logged rather than ignored: the first thing somebody does is plug the terminal in and wonder
    // why nothing arrives, and the answer is almost always "its serial isn't registered yet".
    console.warn(`[biometric] refused unknown terminal serial=${shown(serial)}`);
    recordFailure([guessKey(request)]);
    return { error: NOT_REGISTERED() };
  }
  // A terminal given its own secret address answers only there (SEC-06) — asked before anything else is said about
  // it, so without the key nobody learns the serial is real, or that the terminal is switched off.
  if (!(await deviceKeyAccepted(await deviceKeyHashOf(device.id), key))) {
    console.warn(`[biometric] refused terminal serial=${shown(serial)}: ${key ? "the wrong" : "no"} key in its address`);
    recordFailure([guessKey(request)]);
    return { error: NOT_REGISTERED() };
  }
  // Removed from Biometric (owner, 2 Nov 2026): refused as one switched off is, its punches kept.
  if (!device.active || device.removedAt) {
    return { error: text("Device disabled", 403) };
  }
  // Before anything is stamped or read: a call from an address the terminal isn't given is not the terminal (M-8).
  const from = addressAllowed(device.allowedIps, request);
  if (!from.ok) {
    console.warn(`[biometric] refused terminal serial=${shown(serial)} from ${from.caller ?? "an unknown address"}: not in its address list`);
    // The same answer an unknown serial gets (SEC-06): from outside its list, nobody learns the serial is real.
    recordFailure([guessKey(request)]);
    return { error: NOT_REGISTERED() };
  }
  return { device };
}

/**
 * Which workspace a terminal's request is for.
 *
 * The address it came in on, when that names a workspace — a terminal set up with the workspace's
 * own host. Otherwise (a bare IP on the office network, the platform's `devices.` host) its serial
 * number, through the route written when HR registered it (src/lib/platform/device-routes.ts).
 * /iclock is outside the proxy, so this is also where a workspace that is not active is refused.
 */
type Routed = { tenant: Tenant } | { error: NextResponse };

async function workspaceFor(request: Request): Promise<Routed> {
  const serial = new URL(request.url).searchParams.get("SN");
  const host = requestHost(request.headers);
  if (host === HOST_MISMATCH) return { error: text("Misdirected request", 421) };
  let tenant = host ? await tenantForHost(host) : null;
  if (!tenant && serial) {
    tenant = await tenantForDeviceSerial(serial);
    if (tenant) await touchDeviceRoute(serial);
  }
  if (!tenant) {
    if (serial) console.warn(`[biometric] no workspace for terminal serial=${shown(serial)}`);
    return { error: text("Device not registered", 401) };
  }
  if (tenant.status !== "ACTIVE") return { error: text("Unavailable", 503) };
  return { tenant };
}

/**
 * Attendance is HR's. A workspace whose plan leaves HR out is answered like a held one: the terminal
 * keeps its punches and tries again, so nothing is lost if HR comes back.
 */
async function withHr(work: () => Promise<NextResponse>): Promise<NextResponse> {
  if (!(await moduleAvailableForTenant("hr"))) return text("Unavailable", 503);
  return work();
}

/** `key` is there only at a terminal's secret address (src/app/api/biometric/key/[key]/iclock). */
type Context = { params: Promise<{ path?: string[]; key?: string }> };

export async function GET(request: Request, context: Context) {
  const routed = await workspaceFor(request);
  if ("error" in routed) return routed.error;
  return runAsTenant(routed.tenant, () => withHr(() => handleGet(request, context)));
}

export async function POST(request: Request, context: Context) {
  const routed = await workspaceFor(request);
  if ("error" in routed) return routed.error;
  return runAsTenant(routed.tenant, () => withHr(() => handlePost(request, context)));
}

async function handleGet(request: Request, context: Context) {
  const { path, key } = await context.params;
  const url = new URL(request.url);
  const serial = url.searchParams.get("SN");

  const result = await authenticateDevice(serial, request, key ?? null);
  if (result.error) return result.error;
  const device = result.device;

  await db.biometricDevice.update({
    where: { id: device.id },
    data: {
      lastSeenAt: new Date(),
      deviceModel: url.searchParams.get("DeviceType") ?? device.deviceModel,
      firmware: url.searchParams.get("pushver") ?? device.firmware,
    },
  });

  const endpoint = (path ?? []).join("/");

  // The opening handshake: the device asks what it should do and we answer with its settings.
  if (endpoint === "cdata") {
    // Once per connection, not per poll: what the terminal says it is and speaks, for when uploads don't arrive.
    console.info(`[biometric] ${shown(serial)} handshake ${url.searchParams.toString().replace(/[\r\n]/g, " ").slice(0, 300)}`);
    return text(handshakeResponse(device.serialNumber));
  }

  // "Anything for me?" — polled every few seconds. There is no command queue in this build, so the
  // honest answer is no. Returning anything other than OK here makes some firmware retry in a loop.
  if (endpoint === "getrequest") {
    return text(ACK);
  }

  return text(ACK);
}

async function handlePost(request: Request, context: Context) {
  const { path, key } = await context.params;
  const url = new URL(request.url);
  const serial = url.searchParams.get("SN");

  const result = await authenticateDevice(serial, request, key ?? null);
  if (result.error) return result.error;
  const device = result.device;

  // Stamped before anything can refuse the upload: a terminal that keeps calling is seen, even when what it sends is not taken.
  await db.biometricDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });

  /**
   * Secure by default (security audit, Nov 2026): a terminal with no address list sends nothing in until HR ticks
   * "accept from any address" for it. A list empty by default made the serial — printed on the device — the only
   * proof of who was sending, so anybody who knew it could post punches that became attendance days. Its handshake
   * is still answered, so HR sees it calling (Last seen) while its uploads are refused.
   */
  // A terminal on its own secret address has already proved itself (SEC-06): the key is what the serial couldn't be.
  if (device.allowedIps.length === 0 && !device.acceptAnyAddress && !(await deviceKeyHashOf(device.id))) {
    console.warn(`[biometric] refused an upload from ${shown(serial)}: it has no address list, and accepting it from any address is off`);
    return text("Uploads from this terminal need a secret address, an address list, or accepting it from any address turned on, in Biometric", 403);
  }

  // Read with a ceiling the sender can't talk its way past (SEC-27): a chunked body declares no length.
  const body = await readTextWithin(request, MAX_BODY_BYTES);
  if (body === null) {
    console.warn(`[biometric] oversized upload from ${shown(serial)}`);
    return text("Payload too large", 413);
  }

  const endpoint = (path ?? []).join("/");
  // Every upload, in one line: a terminal that is seen but whose punches never arrive is otherwise silent.
  console.info(`[biometric] ${shown(serial)} POST /${endpoint} table=${shown(url.searchParams.get("table"))} bytes=${body.length}`);

  if (endpoint === "devicecmd") {
    // The result of a command we sent. Nothing sends commands yet, so this is just acknowledged.
    return text(ACK);
  }

  const table = tableOf(url.searchParams);
  if (table === "OPERLOG") {
    // Enrolments, deletions, someone changing the device clock. Not attendance, and storing menu
    // activity would be surveillance without a purpose, so it is acknowledged and dropped.
    return text(ACK);
  }
  if (table !== "ATTLOG") {
    // Kept to its first line, and cut short: a template or photo upload is long, and none of it is needed.
    if (table === "OTHER" && body) console.info(`[biometric] ${shown(serial)} ignored table=${shown(url.searchParams.get("table"))}: ${body.split(/\r?\n/)[0]?.slice(0, 120)}`);
    // Photos and fingerprint templates land here. Refused on purpose — this app has no use for a
    // biometric template and every reason not to hold one.
    return text(ACK);
  }

  const parsed = parseAttlog(body);
  const { rejected } = parsed;
  if (rejected.length > 0) {
    console.warn(`[biometric] ${shown(serial)}: ${rejected.length} unreadable row(s), first: ${rejected[0].line.replace(/[\r\n]/g, " ").slice(0, 120)}`);
  }
  // Not a punch from tomorrow or later (SEC-06): a terminal's clock that far off is wrong, and an upload saying so is
  // somebody writing attendance ahead of time.
  const horizon = Date.now() + FUTURE_SLACK_MS;
  const punches = parsed.punches.filter((p) => p.punchedAt.getTime() <= horizon);
  if (punches.length < parsed.punches.length) {
    console.warn(`[biometric] ${shown(serial)}: ${parsed.punches.length - punches.length} punch(es) dated in the future left out`);
  }
  if (punches.length === 0) {
    console.info(`[biometric] ${shown(serial)} ATTLOG with no readable punch${body ? `, first line: ${body.split(/\r?\n/)[0]?.slice(0, 200)}` : ""}`);
    return text(ACK);
  }

  // `skipDuplicates` is what makes a terminal re-sending its whole buffer a no-op. They do this
  // after a reboot, after a clock change, and whenever ATTLOGStamp is reset — routinely, in other
  // words, and the unique constraint is the only thing standing between that and duplicate days.
  // In chunks: a first upload can be a whole terminal's memory, far more rows than one insert can carry.
  const created = { count: 0 };
  for (let i = 0; i < punches.length; i += INSERT_CHUNK) {
    const batch = await db.biometricPunch.createMany({
      data: punches.slice(i, i + INSERT_CHUNK).map((p) => ({
        deviceId: device.id,
        deviceUserId: p.deviceUserId,
        punchedAt: p.punchedAt,
        punchType: p.punchType,
        verifyMode: p.verifyMode,
        raw: p.raw,
      })),
      skipDuplicates: true,
    });
    created.count += batch.count;
  }

  const latest = punches.reduce((max, p) => (p.punchedAt > max ? p.punchedAt : max), punches[0].punchedAt);
  await db.biometricDevice.update({
    where: { id: device.id },
    data: {
      lastPunchAt: latest > (device.lastPunchAt ?? new Date(0)) ? latest : device.lastPunchAt,
      punchesReceived: { increment: created.count },
    },
  });

  console.info(`[biometric] ${shown(serial)} ATTLOG ${punches.length} punch(es), ${created.count} new`);

  if (created.count > 0) {
    await linkPunchesToUsers([...new Set(punches.map((p) => p.deviceUserId))]);
    await rollupPunches();
  }

  return text(ACK);
}
