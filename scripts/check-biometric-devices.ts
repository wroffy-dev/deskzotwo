/**
 * check:biometric-devices — a terminal switched off and on, and removed (owner, 2 Nov 2026).
 *
 *   · Off, the terminal is refused; on, it is answered again.
 *   · Removed, it leaves the Biometric list and is refused, while every punch it sent stays.
 *   · Registering the same serial again brings the same terminal back, punches and all.
 *   · Somebody without "Manage HR" can do none of it.
 *   · Its address list (Phase 1 security fixes, audit M-8): empty, it is answered from anywhere; with one, a call
 *     from any other address — or from an address nobody can vouch for — is refused before anything is read or
 *     stamped, and answered from a listed IP or range; an entry that isn't an address or range is refused on save.
 *   · The settings changes audit M-9 found unlogged now are: a module switched, branding saved or its images
 *     changed, a department created, edited or deleted, a payroll statutory or bank file downloaded.
 *
 * Against the workspace in DATABASE_URL (the copy, never the live one); everything it makes carries ZZBIO and
 * is removed at the end — the module switch and branding it touches are put back as they were.
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
process.env.TRUST_PROXY = "1";

const TAG = "ZZBIO";
const ROLE = "ZZBIO_CLERK";
const HOST = "deskzo.localhost:3000";
const requestHeaders = new Headers({ host: HOST, "user-agent": "check:biometric-devices", "x-forwarded-for": "198.51.100.71" });
let browserUser: { id: string; name: string; email: string; role: string } | null = null;

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/headers") return { headers: async () => requestHeaders, cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set() {}, delete() {} }) };
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new Error("notFound");
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
    };
  }
  if (request === "@/lib/auth") {
    return { auth: async () => (browserUser ? { user: browserUser, expires: "" } : null), signIn: async () => {}, signOut: async () => {}, handlers: {} };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function cleanup() {
  await db.biometricPunch.deleteMany({ where: { device: { serialNumber: { startsWith: TAG } } } });
  await db.biometricDevice.deleteMany({ where: { serialNumber: { startsWith: TAG } } });
  await db.department.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.user.deleteMany({ where: { email: { endsWith: "@zzbio.invalid" } } });
  await db.rolePermission.deleteMany({ where: { role: ROLE } });
  await db.role.deleteMany({ where: { key: ROLE } });
}

async function main() {
  await cleanup();
  const boss = await db.user.findFirst({ where: { isSuperAdmin: true, active: true }, select: { id: true, name: true, email: true, role: true } });
  if (!boss) throw new Error("the workspace has no active super admin to act as HR");
  // A role of its own with nothing but the HR menu: not "Manage HR".
  await db.role.create({ data: { key: ROLE, name: `${TAG} clerk` } });
  await db.rolePermission.create({ data: { role: ROLE, permission: "section.hr", allowed: true } });
  const clerk = await db.user.create({ data: { name: `${TAG} Clerk`, email: "clerk@zzbio.invalid", role: ROLE, passwordHash: "x".repeat(60) } });

  /* eslint-disable @typescript-eslint/no-require-imports */
  const bio = require("../src/actions/biometric") as typeof import("../src/actions/biometric");
  const iclock = require("../src/app/api/biometric/iclock/[[...path]]/route") as typeof import("../src/app/api/biometric/iclock/[[...path]]/route");
  const moduleActions = require("../src/actions/module") as typeof import("../src/actions/module");
  const branding = require("../src/actions/branding") as typeof import("../src/actions/branding");
  const departments = require("../src/actions/department") as typeof import("../src/actions/department");
  const payrollFiles = require("../src/app/api/payroll/[runId]/files/[kind]/route") as typeof import("../src/app/api/payroll/[runId]/files/[kind]/route");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const SERIAL = `${TAG}-0001`;
  const hello = async () => (await iclock.GET(new Request(`http://${HOST}/iclock/cdata?SN=${SERIAL}&options=all`, { headers: { host: HOST } }), { params: Promise.resolve({ path: ["cdata"] }) })).status;
  /** The terminal's handshake as our proxy would hand it over: X-Forwarded-For as given (TRUST_PROXY=1 above), none for null. */
  const helloFrom = async (forwardedFor: string | null) => {
    const res = await iclock.GET(new Request(`http://${HOST}/iclock/cdata?SN=${SERIAL}&options=all`, { headers: { host: HOST, ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}) } }), { params: Promise.resolve({ path: ["cdata"] }) });
    return { status: res.status, body: await res.text() };
  };
  const startedAt = new Date();

  try {
    section("Registered and on");
    browserUser = boss;
    const saved = await bio.saveBiometricDevice({ serialNumber: SERIAL, name: `${TAG} Front door` });
    ok("HR registers a terminal", saved.ok, saved);
    const id = saved.ok ? saved.data.id : "";
    ok("it is on, and listed", (await bio.listBiometricDevices()).some((d) => d.id === id && d.active));
    ok("the terminal is answered", (await hello()) === 200, await hello());
    await db.biometricPunch.create({ data: { deviceId: id, deviceUserId: "zz-1", punchedAt: new Date("2026-11-01T09:01:00Z"), raw: "zz" } });
    await db.biometricPunch.create({ data: { deviceId: id, deviceUserId: "zz-1", punchedAt: new Date("2026-11-01T18:05:00Z"), raw: "zz" } });

    section("Address list (M-8)");
    const listOf = async () => (await db.biometricDevice.findUnique({ where: { id }, select: { allowedIps: true } }))?.allowedIps;
    ok("a new terminal has no list", JSON.stringify(await listOf()) === "[]", await listOf());
    ok("  answered from any address", (await helloFrom("192.0.2.99")).status === 200 && (await helloFrom("2001:db8::7")).status === 200);
    ok("  and from one nobody can vouch for", (await helloFrom(null)).status === 200);
    const listed = await bio.saveBiometricDevice({ id, serialNumber: SERIAL, name: `${TAG} Front door`, allowedIps: [" 203.0.113.9/24 ", "198.51.100.9", "198.51.100.9", "::ffff:192.0.2.1", ""] });
    ok("HR gives it a list", listed.ok, listed);
    ok("  stored canonical: a range's host bits cleared, an exact IP as itself, repeats and blanks dropped", JSON.stringify(await listOf()) === JSON.stringify(["203.0.113.0/24", "198.51.100.9", "192.0.2.1"]), await listOf());
    const saveAudit = await db.auditLog.findFirst({ where: { entityType: "BiometricDevice", entityId: id, action: "UPDATE" }, orderBy: { createdAt: "desc" }, select: { entityLabel: true } });
    ok("  the audit log says where it's accepted from", !!saveAudit?.entityLabel.includes("accepted only from 203.0.113.0/24, 198.51.100.9, 192.0.2.1"), saveAudit?.entityLabel);
    const stranger = await helloFrom("192.0.2.99");
    // Answered as an unknown serial is (security audit SEC-06): from outside its list, nobody learns the serial is real.
    ok("refused from an address not on it, as if the serial weren't registered", stranger.status === 401 && stranger.body === "Device not registered", stranger);
    ok("  refused when the address is unknown", (await helloFrom(null)).status === 401);
    ok("  refused when a listed address is only claimed ahead of the real one", (await helloFrom("198.51.100.9, 192.0.2.99")).status === 401);
    ok("answered from a listed IP", (await helloFrom("198.51.100.9")).status === 200);
    ok("  from inside a listed range", (await helloFrom("203.0.113.200")).status === 200);
    ok("  from a listed address in its IPv6 spelling", (await helloFrom("::ffff:203.0.113.5")).status === 200 && (await helloFrom("192.0.2.1")).status === 200);
    await db.biometricDevice.update({ where: { id }, data: { lastSeenAt: new Date("2026-01-01T00:00:00Z") } });
    const upload = await iclock.POST(
      new Request(`http://${HOST}/iclock/cdata?SN=${SERIAL}&table=ATTLOG`, { method: "POST", headers: { host: HOST, "x-forwarded-for": "192.0.2.99" }, body: "zz-2\t2026-11-01 09:30:00\t0\t1\t0\t0" }),
      { params: Promise.resolve({ path: ["cdata"] }) },
    );
    ok("an upload from elsewhere is refused, and stores nothing", upload.status === 401 && (await db.biometricPunch.count({ where: { deviceId: id, deviceUserId: "zz-2" } })) === 0, upload.status);
    ok("  nor does it count as the terminal being seen", (await db.biometricDevice.findUnique({ where: { id }, select: { lastSeenAt: true } }))?.lastSeenAt?.toISOString() === "2026-01-01T00:00:00.000Z");
    await helloFrom("198.51.100.9");
    ok("  a listed address does", ((await db.biometricDevice.findUnique({ where: { id }, select: { lastSeenAt: true } }))?.lastSeenAt?.getTime() ?? 0) > Date.parse("2026-06-01"));
    const before = JSON.stringify(await listOf());
    for (const [label, entries] of [
      ["not an address", ["not-an-ip"]],
      ["a prefix past /32", ["10.0.0.0/33"]],
      ["a range wider than any office", ["0.0.0.0/0"]],
      ["a good entry beside a bad one", ["198.51.100.9", "198.51.100.300"]],
      ["something that isn't text", [42 as unknown as string]],
      ["more entries than any terminal needs", Array.from({ length: 21 }, (_, i) => `198.51.100.${i + 1}`)],
    ] as [string, string[]][]) {
      const refused = await bio.saveBiometricDevice({ id, serialNumber: SERIAL, name: `${TAG} Front door`, allowedIps: entries });
      ok(`refused on save: ${label}`, !refused.ok, refused);
    }
    process.env.TRUST_PROXY = "0";
    const blind = await bio.saveBiometricDevice({ id, serialNumber: SERIAL, name: `${TAG} Front door`, allowedIps: ["198.51.100.9"] });
    process.env.TRUST_PROXY = "1";
    ok("refused on save: a list on a server that can't see addresses", !blind.ok, blind);
    ok("  none of those changed the list", JSON.stringify(await listOf()) === before, await listOf());
    const untouched = await bio.saveBiometricDevice({ id, serialNumber: SERIAL, name: `${TAG} Front door`, location: "Lobby" });
    ok("an edit that doesn't mention the list keeps it", untouched.ok && JSON.stringify(await listOf()) === before, await listOf());
    browserUser = { id: clerk.id, name: clerk.name, email: clerk.email, role: clerk.role };
    ok("somebody without Manage HR can't clear it", !(await bio.saveBiometricDevice({ id, serialNumber: SERIAL, name: `${TAG} Front door`, allowedIps: [] })).ok && JSON.stringify(await listOf()) === before);
    browserUser = boss;
    const cleared = await bio.saveBiometricDevice({ id, serialNumber: SERIAL, name: `${TAG} Front door`, allowedIps: [] });
    ok("emptied, it is answered from anywhere again", cleared.ok && JSON.stringify(await listOf()) === "[]" && (await helloFrom("192.0.2.99")).status === 200 && (await hello()) === 200, cleared);

    section("Its own secret address (security audit SEC-06)");
    // Each try from an address of its own, so the guessing limit on one address isn't what refuses it.
    let caller = 0;
    const keyed = async (key: string | null) => {
      caller += 1;
      const res = await iclock.GET(new Request(`http://${HOST}/iclock/cdata?SN=${SERIAL}&options=all`, { headers: { host: HOST, "x-forwarded-for": `198.18.7.${caller}` } }), {
        params: Promise.resolve({ path: ["cdata"], ...(key ? { key } : {}) }),
      });
      return { status: res.status, body: await res.text() };
    };
    browserUser = { id: clerk.id, name: clerk.name, email: clerk.email, role: clerk.role };
    ok("somebody without Manage HR can't make one", !(await bio.issueBiometricDeviceKey(id)).ok);
    browserUser = boss;
    ok("with none, a key in the address is neither asked for nor minded", (await keyed(null)).status === 200 && (await keyed("abcdefghjkmnpqrs")).status === 200);
    const issued = await bio.issueBiometricDeviceKey(id);
    const key = issued.ok ? issued.data.path.replace("/iclock-k/", "") : "";
    ok("HR makes one: an address to type in, shown once", issued.ok && /^\/iclock-k\/[a-z0-9]{16}$/.test(issued.ok ? issued.data.path : ""), issued.ok ? "" : issued);
    const stored = await db.biometricDevice.findUnique({ where: { id }, select: { accessKeyHash: true } });
    ok("  only its digest is kept", !!stored?.accessKeyHash && !stored.accessKeyHash.includes(key));
    ok("  the list says it has one, never what it is", (await bio.listBiometricDevices()).some((d) => d.id === id && d.hasKey) && !JSON.stringify(await bio.listBiometricDevices()).includes(key));
    const bare = await keyed(null);
    ok("the serial alone is now refused, as an unknown serial is", bare.status === 401 && bare.body === "Device not registered", bare);
    ok("  and so is a wrong key, or one that isn't a key", (await keyed("abcdefghjkmnpqrs")).status === 401 && (await keyed("../../etc")).status === 401);
    ok("with its key it is answered", (await keyed(key)).status === 200);
    const reissued = await bio.issueBiometricDeviceKey(id);
    const key2 = reissued.ok ? reissued.data.path.replace("/iclock-k/", "") : "";
    ok("a new one stops the old one", reissued.ok && key2 !== key && (await keyed(key)).status === 401 && (await keyed(key2)).status === 200);
    const removedKey = await bio.clearBiometricDeviceKey(id);
    ok("removed, the plain address answers again", removedKey.ok && (await keyed(null)).status === 200, removedKey);
    // Security audit, Nov 2026: with no list, uploads are refused unless HR ticks "accept from any address".
    section("Uploads with no address list");
    const uploadFrom = async (forwardedFor: string | null) =>
      (
        await iclock.POST(
          new Request(`http://${HOST}/iclock/cdata?SN=${SERIAL}&table=ATTLOG`, {
            method: "POST",
            headers: { host: HOST, ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}) },
            body: "zz-up\t2026-11-02 09:00:00\t0\t1\t0\t0",
          }),
          { params: Promise.resolve({ path: ["cdata"] }) },
        )
      ).status;
    const anyOf = async () => (await db.biometricDevice.findUnique({ where: { id }, select: { acceptAnyAddress: true } }))?.acceptAnyAddress;
    ok("a new terminal doesn't accept from any address", (await anyOf()) === false);
    ok("  so, with no list, an ATTLOG upload is refused (403), and nothing is stored", (await uploadFrom("192.0.2.99")) === 403 && (await db.biometricPunch.count({ where: { deviceId: id, deviceUserId: "zz-up" } })) === 0);
    ok("  its handshake is still answered, so HR sees it calling", (await hello()) === 200);
    const opted = await bio.saveBiometricDevice({ id, serialNumber: SERIAL, name: `${TAG} Front door`, allowedIps: [], acceptAnyAddress: true });
    ok("HR ticks 'accept from any address': uploads are taken", opted.ok && (await anyOf()) === true && (await uploadFrom("192.0.2.99")) === 200 && (await db.biometricPunch.count({ where: { deviceId: id, deviceUserId: "zz-up" } })) === 1, opted);
    const optedAudit = await db.auditLog.findFirst({ where: { entityType: "BiometricDevice", entityId: id }, orderBy: { createdAt: "desc" }, select: { entityLabel: true } });
    ok("  and the audit log says it is accepted from any address", !!optedAudit?.entityLabel.includes("accepted from any address"), optedAudit?.entityLabel);
    const listedOnly = await bio.saveBiometricDevice({ id, serialNumber: SERIAL, name: `${TAG} Front door`, allowedIps: ["198.51.100.9"], acceptAnyAddress: false });
    ok("with a list instead: an upload from a listed address is taken", listedOnly.ok && (await uploadFrom("198.51.100.9")) === 200, listedOnly);
    ok("  and one from anywhere else is refused", (await uploadFrom("192.0.2.99")) !== 200);
    const unticked = await bio.saveBiometricDevice({ id, serialNumber: SERIAL, name: `${TAG} Front door`, allowedIps: [], acceptAnyAddress: false });
    const untickedAudit = await db.auditLog.findFirst({ where: { entityType: "BiometricDevice", entityId: id }, orderBy: { createdAt: "desc" }, select: { entityLabel: true } });
    ok("list emptied and unticked: uploads refused again, and the audit log says so", unticked.ok && (await uploadFrom("192.0.2.99")) === 403 && !!untickedAudit?.entityLabel.includes("uploads refused"), untickedAudit?.entityLabel);
    await db.biometricPunch.deleteMany({ where: { deviceId: id, deviceUserId: "zz-up" } });

    section("Switched off and on");
    const off = await bio.setBiometricDeviceActive(id, false);
    ok("switched off", off.ok && (await db.biometricDevice.findUnique({ where: { id } }))?.active === false, off);
    ok("  the terminal is refused", (await hello()) === 403);
    ok("  still listed, as off", (await bio.listBiometricDevices()).some((d) => d.id === id && !d.active));
    const on = await bio.setBiometricDeviceActive(id, true);
    ok("switched on again: answered", on.ok && (await hello()) === 200);

    section("Somebody without Manage HR");
    browserUser = { id: clerk.id, name: clerk.name, email: clerk.email, role: clerk.role };
    ok("can't switch it off", !(await bio.setBiometricDeviceActive(id, false)).ok);
    ok("nor remove it", !(await bio.removeBiometricDevice(id)).ok && (await db.biometricDevice.findUnique({ where: { id } }))?.removedAt === null);
    ok("nor sees the list", (await bio.listBiometricDevices()).length === 0);

    section("Removed");
    browserUser = boss;
    const removed = await bio.removeBiometricDevice(id);
    const row = await db.biometricDevice.findUnique({ where: { id } });
    ok("HR removes it", removed.ok && !!row?.removedAt && row.removedById === boss.id && row.active === false, removed);
    ok("  gone from the list", !(await bio.listBiometricDevices()).some((d) => d.id === id));
    ok("  the terminal is refused", (await hello()) === 403);
    ok("  its punches are kept", (await db.biometricPunch.count({ where: { deviceId: id } })) === 2);
    ok("  it can't be switched back on from a stale screen", !(await bio.setBiometricDeviceActive(id, true)).ok);
    ok("  a file can't be imported against it", !(await bio.importPunchFile(id, "1\t2026-11-01 09:00:00\t0\t1\t0\t0")).ok);
    ok("  removing it twice is no change", (await bio.removeBiometricDevice(id)).ok);
    const audit = await db.auditLog.findFirst({ where: { entityType: "BiometricDevice", entityId: id, action: "DELETE" }, select: { entityLabel: true } });
    ok("  in the audit log, with the punches it kept", !!audit && audit.entityLabel.includes("2 punch(es) are kept"), audit?.entityLabel);

    section("Registered again");
    const again = await bio.saveBiometricDevice({ serialNumber: SERIAL.toLowerCase(), name: `${TAG} Front door (back)` });
    ok("the same serial registered again brings the same terminal back", again.ok && again.data.id === id, again);
    const back = await db.biometricDevice.findUnique({ where: { id }, select: { removedAt: true, active: true, name: true } });
    ok("  listed and on, under its new name", !back?.removedAt && back?.active === true && back.name.endsWith("(back)") && (await bio.listBiometricDevices()).some((d) => d.id === id));
    ok("  with its punches", (await db.biometricPunch.count({ where: { deviceId: id } })) === 2);
    ok("  and answered", (await hello()) === 200);
    ok("one terminal for the serial, not two", (await db.biometricDevice.count({ where: { serialNumber: SERIAL } })) === 1);

    section("Settings changes in the audit log (M-9)");
    browserUser = boss;
    const latest = (entityType: string, entityId?: string) =>
      db.auditLog.findFirst({ where: { entityType, ...(entityId ? { entityId } : {}), userId: boss.id, createdAt: { gte: startedAt } }, orderBy: { createdAt: "desc" }, select: { action: true, entityId: true, entityLabel: true } });

    // HR is on (its terminal was just answered), so switching it on again changes nothing but the log.
    const hrSwitch = await db.systemModule.findUnique({ where: { key: "hr" } });
    const switched = await moduleActions.setModuleEnabled("hr", true);
    const moduleRow = await latest("SystemModule", "hr");
    ok("a module switched: logged, saying which and which way", switched.ok && moduleRow?.entityLabel === "People (HR) module switched on", moduleRow ?? switched);
    if (hrSwitch) await db.systemModule.update({ where: { key: "hr" }, data: { enabled: hrSwitch.enabled } });
    else await db.systemModule.deleteMany({ where: { key: "hr" } });

    const brandRow = await db.brandingSettings.findUnique({ where: { id: "global" } });
    const brandNow = await branding.getBranding();
    const saved2 = await branding.updateBranding({ appName: brandNow.appName, shortName: brandNow.shortName ?? "", tagline: `${TAG} tagline`, primaryColor: brandNow.primaryColor, defaultTheme: brandNow.defaultTheme });
    const brandSaved = await latest("BrandingSettings");
    ok("branding saved: logged, with what changed", saved2.ok && !!brandSaved?.entityLabel.includes(`tagline ${brandNow.tagline ?? "(none)"} → ${TAG} tagline`), brandSaved ?? saved2);
    const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const uploaded = await branding.uploadBrandingImage("favicon", pixel);
    const imageRow = await latest("BrandingSettings");
    ok("a branding image replaced: logged, without the image", uploaded.ok && !!imageRow?.entityLabel.startsWith("Branding favicon replaced") && !imageRow.entityLabel.includes("base64"), imageRow ?? uploaded);
    const removedImage = await branding.removeBrandingImage("favicon");
    ok("  and removed: logged", removedImage.ok && (await latest("BrandingSettings"))?.entityLabel === "Branding favicon removed");
    if (brandRow) await db.brandingSettings.update({ where: { id: "global" }, data: { appName: brandRow.appName, shortName: brandRow.shortName, tagline: brandRow.tagline, primaryColor: brandRow.primaryColor, defaultTheme: brandRow.defaultTheme, logoDataUrl: brandRow.logoDataUrl, faviconDataUrl: brandRow.faviconDataUrl } });
    else await db.brandingSettings.deleteMany({ where: { id: "global" } });

    const made = await departments.createDepartment({ name: `${TAG} Night shift` });
    const deptId = made.ok ? made.data.id : "";
    ok("a department created: logged", made.ok && (await latest("Department", deptId))?.entityLabel === `Department ${TAG} Night shift created`, made);
    const renamed = await departments.updateDepartment({ id: deptId, name: `${TAG} Late shift` });
    ok("  renamed: logged, with both names", renamed.ok && (await latest("Department", deptId))?.entityLabel === `Department ${TAG} Night shift renamed ${TAG} Late shift`);
    const flagged = await departments.setDepartmentSupportTeam(deptId, true);
    ok("  made a support team: logged", flagged.ok && (await latest("Department", deptId))?.entityLabel === `Department ${TAG} Late shift made a support team`);
    const assignable = await departments.setDepartmentAssignTeam(deptId, "caller", true);
    ok("  its members made callers: logged", assignable.ok && (await latest("Department", deptId))?.entityLabel === `Department ${TAG} Late shift: members may be given a company as caller`);
    const gone = await departments.deleteDepartment(deptId);
    const deptDeleted = await latest("Department", deptId);
    ok("  deleted: logged", gone.ok && deptDeleted?.action === "DELETE" && deptDeleted.entityLabel === `Department ${TAG} Late shift deleted`, deptDeleted ?? gone);
    browserUser = { id: clerk.id, name: clerk.name, email: clerk.email, role: clerk.role };
    const refusedDept = await departments.createDepartment({ name: `${TAG} Refused` });
    ok("  a refused change writes nothing", !refusedDept.ok && !(await db.auditLog.findFirst({ where: { userId: clerk.id, entityType: "Department" } })));
    browserUser = boss;

    const run = await db.payrollRun.findFirst({ where: { status: { not: "DRAFT" } }, orderBy: [{ year: "desc" }, { month: "desc" }], select: { id: true } });
    const draft = await db.payrollRun.findFirst({ where: { status: "DRAFT" }, select: { id: true } });
    const download = async (runId: string, kind: string) => (await payrollFiles.GET(new Request(`http://${HOST}/api/payroll/${runId}/files/${kind}`), { params: Promise.resolve({ runId, kind }) })).status;
    if (!run) ok("payroll file downloads: no locked payroll month in this workspace to download from", false);
    else {
      const filesBefore = await db.auditLog.count({ where: { entityType: "PayrollRun", entityId: run.id, createdAt: { gte: startedAt } } });
      const bank = await download(run.id, "bank");
      const bankRow = await latest("PayrollRun", run.id);
      ok("the bank transfer file downloaded: logged", bank === 200 && !!bankRow?.entityLabel.startsWith("Bank transfer file for ") && bankRow.entityLabel.includes(" downloaded — "), bankRow ?? bank);
      const ecr = await download(run.id, "ecr");
      ok("  the PF ECR file: logged", ecr === 200 && !!(await latest("PayrollRun", run.id))?.entityLabel.startsWith("PF ECR file for "), ecr);
      const esi = await download(run.id, "esi");
      ok("  the ESI return: logged", esi === 200 && !!(await latest("PayrollRun", run.id))?.entityLabel.startsWith("ESI return for "), esi);
      ok("  a file that doesn't exist: refused, nothing logged", (await download(run.id, "nope")) === 404 && (await db.auditLog.count({ where: { entityType: "PayrollRun", entityId: run.id, createdAt: { gte: startedAt } } })) === filesBefore + 3);
      browserUser = { id: clerk.id, name: clerk.name, email: clerk.email, role: clerk.role };
      ok("  somebody who may not run payroll: refused, nothing logged", (await download(run.id, "bank")) === 404 && !(await db.auditLog.findFirst({ where: { userId: clerk.id, entityType: "PayrollRun" } })));
      browserUser = boss;
    }
    if (draft) ok("  a draft month: refused, nothing logged", (await download(draft.id, "bank")) === 404 && !(await db.auditLog.findFirst({ where: { entityType: "PayrollRun", entityId: draft.id, createdAt: { gte: startedAt }, entityLabel: { contains: " downloaded — " } } })));
  } finally {
    browserUser = boss;
    const left = await db.biometricDevice.findMany({ where: { serialNumber: { startsWith: TAG } }, select: { id: true } });
    for (const d of left) await bio.removeBiometricDevice(d.id).catch(() => null);
    await cleanup();
    // The audit rows the M-9 section wrote, and only those: its own departments, the module and branding it put back, its downloads.
    await db.auditLog.deleteMany({
      where: {
        userId: boss.id,
        createdAt: { gte: startedAt },
        OR: [
          { entityType: "Department", entityLabel: { contains: TAG } },
          { entityType: "SystemModule", entityId: "hr" },
          { entityType: "BrandingSettings" },
          { entityType: "PayrollRun", entityLabel: { contains: " downloaded — " } },
        ],
      },
    });
  }

  ok("nothing of this check is left", (await db.biometricDevice.count({ where: { serialNumber: { startsWith: TAG } } })) === 0);
  console.log(failures === 0 ? `\nAll ${passes} biometric device checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
