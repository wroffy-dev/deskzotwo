/**
 * check:desks — the internal help desk (owner, 25 Nov 2026 — src/lib/desks).
 *
 *   · The rules: office time counted on (hours, Sundays, holidays, no hours set), what's owed next, times as typed.
 *   · On a scratch workspace of its own (<db>_desks_check, built from the migrations and dropped at the end, pass or fail):
 *     who sees a request — whoever asked, the desk, the super admin, nobody else: not an admin, a manager, the old desk
 *     after it moved, anybody viewing as somebody, or a support login; a note and its file only the desk's; a person's
 *     own request to their own desk; picking up at once; the three ways new ones are given out; the clock stopped and
 *     started; opened again, or too late to; overdue told once; somebody who left; desks set up, and what can't be.
 *   · Phase 2: approval before the desk sees it, and asked for by the desk — who sees what, who may decide, rejected,
 *     taken back, withdrawn, an approver who has left; the desk's steps; the asset's earlier requests and repair; Today.
 *   · Nothing of a request in the audit log. The menu, the pages and the settings drawn.
 *
 * The session is a stand-in; no mail is sent; nothing is written to any other database.
 *
 *   npm run check:desks
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const withDatabase = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

let actorId = "";
let viewingAs = false;
const roles = new Map<string, string>();
const mails: { userId: string; type: string; subject: string; body: string }[] = [];
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") {
    return {
      useRouter: () => ({ push() {}, refresh() {}, replace() {}, back() {}, prefetch() {} }),
      usePathname: () => "/help-desk",
      useSearchParams: () => new URLSearchParams(),
      notFound: () => {
        throw new Error("NOT_FOUND");
      },
      redirect: (to: string) => {
        throw new Error(`REDIRECT ${to}`);
      },
    };
  }
  if (request === "@/lib/email" || request.endsWith("/lib/email")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, sendEmailNotification: async (m: { userId: string; type: string; subject: string; body: string }) => void mails.push(m) };
  }
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = async () => (actorId ? { id: actorId, role: roles.get(actorId) ?? "PROFILE", name: "Zz", email: `${actorId}@zzdesks.invalid` } : null);
    return {
      requireUser: async () => {
        const u = await user();
        if (!u) throw new Error("Unauthorized");
        return u;
      },
      currentUser: user,
      viewAsContext: async () => (viewingAs ? { actor: { id: "zz" }, user: { id: actorId } } : null),
      refuseWhileViewingAs: async () => (viewingAs ? "Not while viewing as somebody." : null),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is needed.");
  if (!["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname)) throw new Error("Only against a local database server.");
  const scratchName = `${new URL(url).pathname.slice(1)}_desks_check`;
  const scratchUrl = withDatabase(url, scratchName);
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  section("A scratch workspace");
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
  try {
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60_000 });
    ok("built from its migrations", true);
    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = " ";
    process.env.DESKZO_TENANCY_FALLBACK = "legacy";
    for (const k of ["STORAGE_AZURE_CONNECTION_STRING", "STORAGE_AZURE_CONTAINER", "STORAGE_AZURE_CONTAINER_URL", "STORAGE_AZURE_SAS", "STORAGE_DIR", "STORAGE_PREFIX"]) process.env[k] = "";
    rules();
    await scenario();
  } finally {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_database where datname = ${scratchName}`;
    ok("the scratch workspace is dropped", Number(left[0]!.n) === 0);
    await admin.$disconnect();
  }
  console.log(failures === 0 ? `\nAll ${passes} help desk checks passed.` : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

function rules() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const r = require("../src/lib/desks/rules") as typeof import("../src/lib/desks/rules");
  const { clockFor } = require("../src/lib/time/zone") as { clockFor: (zone: string) => import("../src/lib/time/zone").Clock };
  const { officeMinutesBetween } = require("../src/lib/leads/response") as typeof import("../src/lib/leads/response");
  /* eslint-enable @typescript-eslint/no-require-imports */
  section("Office time");
  const clock = clockFor("Asia/Kolkata");
  const hours = { startMinute: 570, endMinute: 1110, graceMinutes: 0 }; // 9:30 to 6:30
  const none = () => false;
  const add = (from: string, minutes: number, holiday: (d: string) => boolean = none, h: typeof hours | null = hours) => r.addOfficeMinutes(new Date(from), minutes, clock, h, holiday).toISOString();
  // Wednesday 25 November 2026.
  ok("an hour within the day", add("2026-11-25T11:00:00+05:30", 60) === new Date("2026-11-25T12:00:00+05:30").toISOString());
  ok("  over the evening, into the next morning", add("2026-11-25T18:00:00+05:30", 60) === new Date("2026-11-26T10:00:00+05:30").toISOString());
  ok("  from before opening, from the opening", add("2026-11-25T07:00:00+05:30", 30) === new Date("2026-11-25T10:00:00+05:30").toISOString());
  ok("  Saturday evening to Monday, Sunday off", add("2026-11-28T18:00:00+05:30", 60) === new Date("2026-11-30T10:00:00+05:30").toISOString());
  ok("  a holiday off", add("2026-11-25T18:00:00+05:30", 60, (d) => d === "2026-11-26") === new Date("2026-11-27T10:00:00+05:30").toISOString());
  ok("  with no office hours set, by the clock", add("2026-11-25T18:00:00+05:30", 600, none, null) === new Date("2026-11-26T04:00:00+05:30").toISOString());
  ok("  nothing but holidays: gives up, by the clock", add("2026-11-25T18:00:00+05:30", 60, () => true) === new Date("2026-11-25T19:00:00+05:30").toISOString());
  let back = true;
  for (const [from, n] of [["2026-11-25T11:11:00+05:30", 45], ["2026-11-27T17:30:00+05:30", 700], ["2026-11-29T12:00:00+05:30", 1620]] as const) {
    const to = r.addOfficeMinutes(new Date(from), n, clock, hours, none);
    if (officeMinutesBetween(new Date(from), to, clock, hours, none) !== n) back = false;
  }
  ok("  and officeMinutesBetween counts back the same", back);
  ok("a day is the office's own; 24 hours with none set", r.spanMinutes({ n: 2, unit: "days" }, hours) === 1080 && r.spanMinutes({ n: 1, unit: "days" }, null) === 1440 && r.spanMinutes({ n: 4, unit: "hours" }, hours) === 240);

  section("What's owed, and words");
  const at = (s: string) => new Date(s);
  const now = at("2026-11-25T06:00:00Z");
  const owed = (o: Partial<Parameters<typeof r.dueState>[0]>) => r.dueState({ status: "IN_PROGRESS", replyDueAt: at("2026-11-25T07:00:00Z"), fixDueAt: at("2026-11-26T07:00:00Z"), firstRepliedAt: null, ...o }, now);
  const first = owed({});
  ok("the first reply, then the fix", first.kind === "reply" && !first.late && owed({ firstRepliedAt: now }).kind === "fix");
  const late = owed({ replyDueAt: at("2026-11-25T05:00:00Z") });
  ok("  late once past", late.kind === "reply" && late.late && /Reply overdue/.test(r.dueWords(late, () => "then")));
  ok("  nothing while it waits or is on hold, or is resolved", owed({ status: "WAITING" }).kind === "paused" && owed({ status: "ON_HOLD" }).kind === "paused" && owed({ status: "RESOLVED" }).kind === "done");
  ok("the same status, each side's words", r.statusWords("WAITING", "requester") === "Waiting for you" && r.statusWords("WAITING", "desk") === "Waiting for them");
  ok("times as typed: whole hours or days, 1 to 90", r.timesProblem(r.DEFAULT_TIMES) === null && r.timesProblem({ ...r.DEFAULT_TIMES, SLOW: { reply: { n: 0, unit: "hours" }, fix: { n: 1, unit: "days" } } }) !== null && r.timesProblem({}) !== null && r.timesProblem({ ...r.DEFAULT_TIMES, SLOW: { reply: { n: 1, unit: "weeks" }, fix: { n: 1, unit: "days" } } }) !== null);
  ok("  kept ones that aren't times read as they come", r.readTimes({ SLOW: { reply: { n: 2, unit: "hours" }, fix: "x" } }).SLOW.reply.n === 2 && r.readTimes(null).BLOCKED.reply.n === 1);
  ok("REQ numbers; \"IT\" is the IT desk, \"Front desk\" stays", r.formatRequestId(128) === "REQ-000128" && r.deskLabel("IT") === "IT desk" && r.deskLabel("Front desk") === "Front desk");
}

async function scenario() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const actions = require("../src/actions/desks") as typeof import("../src/actions/desks");
  const server = require("../src/lib/desks/server") as typeof import("../src/lib/desks/server");
  const menu = require("../src/lib/desks/menu") as typeof import("../src/lib/desks/menu");
  const rulesLib = require("../src/lib/desks/rules") as typeof import("../src/lib/desks/rules");
  const nav = require("../src/lib/navigation") as typeof import("../src/lib/navigation");
  const access = require("../src/lib/modules-access") as typeof import("../src/lib/modules-access");
  const fileRoute = require("../src/app/api/desks/files/[id]/route") as typeof import("../src/app/api/desks/files/[id]/route");
  const { renderHtml } = require("./lib/render-html") as typeof import("./lib/render-html");
  const HelpDeskPage = (require("../src/app/(dashboard)/help-desk/page") as { default: (p: unknown) => Promise<unknown> }).default;
  const NewPage = (require("../src/app/(dashboard)/help-desk/new/page") as { default: (p: unknown) => Promise<unknown> }).default;
  const RequestPage = (require("../src/app/(dashboard)/help-desk/[ref]/page") as { default: (p: unknown) => Promise<unknown> }).default;
  const QueuePage = (require("../src/app/(dashboard)/desks/[seq]/page") as { default: (p: unknown) => Promise<unknown> }).default;
  const SettingsPage = (require("../src/app/(dashboard)/settings/help-desk/page") as { default: () => Promise<unknown> }).default;
  /* eslint-enable @typescript-eslint/no-require-imports */

  const dept = async (name: string) => (await db.department.create({ data: { name }, select: { id: true } })).id;
  const [itDept, adminDept, salesDept, emptyDept] = [await dept("Zz IT"), await dept("Zz Admin"), await dept("Zz Sales"), await dept("Zz Empty")];
  const person = async (name: string, departmentId: string | null, extra: Record<string, unknown> = {}) => {
    const u = await db.user.create({ data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@zzdesks.invalid`, role: "SALES", passwordHash: "x".repeat(60), departmentId, ...extra } as never, select: { id: true, role: true } });
    roles.set(u.id, u.role);
    return u.id;
  };
  const boss = await person("Zz Boss", null, { role: "ADMIN", isSuperAdmin: true });
  const otherAdmin = await person("Zz Other Admin", null, { role: "ADMIN" });
  const manager = await person("Zz Manager", salesDept);
  const finance = await person("Zz Finance", null);
  const asha = await person("Zz Asha", salesDept, { managerId: manager });
  const imran = await person("Zz Imran", itDept);
  const pooja = await person("Zz Pooja", itDept);
  const dev = await person("Zz Dev", itDept);
  const kavya = await person("Zz Kavya", adminDept);
  const support = await person("Zz Support Login", itDept, { kind: "SUPPORT" });
  const gone = await person("Zz Gone", itDept, { active: false });
  const as = async <T>(id: string, work: () => Promise<T>): Promise<T> => {
    const before = actorId;
    actorId = id;
    try {
      return await work();
    } finally {
      actorId = before;
    }
  };
  const text = async (page: Promise<unknown>) => (await renderHtml(page as never)).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
  const told = (userId: string, type: string) => db.notification.count({ where: { userId, type: type as never } });

  section("Setting desks up");
  const base = { description: "Laptop, email", routing: "POOL", personId: null, leadId: null, times: rulesLib.DEFAULT_TIMES, active: true, types: [{ name: "Laptop", asksAsset: true, active: true }, { name: "Email", asksAsset: false, active: true }] };
  ok("not without settings.manage", !(await as(asha, () => actions.saveDeskSettings({ ...base, name: "Zz IT", departmentId: itDept }))).ok);
  ok("no desk: nothing in anybody's menu", !(await menu.deskMenu(asha)).open);
  const made = await as(boss, () => actions.saveDeskSettings({ ...base, name: "Zz IT", departmentId: itDept }));
  const adminMade = await as(boss, () => actions.saveDeskSettings({ ...base, name: "Zz Admin", departmentId: adminDept, types: [] }));
  const emptyMade = await as(boss, () => actions.saveDeskSettings({ ...base, name: "Zz Empty", departmentId: emptyDept }));
  ok("added, and logged as settings are", made.ok && adminMade.ok && emptyMade.ok && (await db.auditLog.count({ where: { entityType: "Desk", action: "CREATE" } })) === 3, made);
  const itId = made.ok ? made.data.id : "";
  const adminId = adminMade.ok ? adminMade.data.id : "";
  const emptyId = emptyMade.ok ? emptyMade.data.id : "";
  const refused = async (change: Record<string, unknown>) => {
    const r = await as(boss, () => actions.saveDeskSettings({ ...base, name: "Zz Wrong", departmentId: itDept, ...change } as never));
    return r.ok ? "" : r.error;
  };
  ok("refused, each with why: no name, no department, the same name, one person from elsewhere, a lead from elsewhere, times that aren't, two types alike", [await refused({ name: " " }), await refused({ departmentId: "x" }), await refused({ name: "zz it" }), await refused({ routing: "PERSON", personId: asha }), await refused({ leadId: kavya }), await refused({ times: {} }), await refused({ types: [{ name: "A" }, { name: "a" }] })].every(Boolean) && (await db.desk.count()) === 3);
  const live = await server.liveDesks();
  ok("asked: the desks with somebody there — not the one with nobody", live.map((d) => d.name).join() === "Zz IT,Zz Admin", live.map((d) => d.name));
  ok("  its people: the department's, still here — no support login, nobody who left", live[0]!.people.join() === "Zz Dev,Zz Imran,Zz Pooja", live[0]!.people);
  const itSeq = live[0]!.seq;
  const laptop = live[0]!.types.find((t) => t.name === "Laptop")!.id;
  const email = live[0]!.types.find((t) => t.name === "Email")!.id;

  section("The menu");
  const links = async (id: string) => nav.buildNavigation(await access.accessContextFor(id)).flatMap((s) => s.items.map((i) => `${s.group}: ${i.label}`));
  const ashaMenu = await links(asha);
  ok("an employee: Help desk, and no desk's list", ashaMenu.includes("My work: Help desk") && !ashaMenu.some((l) => / desk$/.test(l) && l.startsWith("Support")), ashaMenu);
  const imranMenu = await links(imran);
  ok("  the desk's people: their desk under Support, theirs alone", imranMenu.includes("Support: Zz IT desk") && !imranMenu.includes("Support: Zz Admin desk"), imranMenu.filter((l) => l.startsWith("Support")));
  const supportLinks = nav.buildNavigation({ ...(await access.accessContextFor(boss)), openModules: ["desks", "helpdesk", "inbox"], permissions: [...(await access.accessContextFor(boss)).permissions] }).find((s) => s.group === "Support")!.items.map((i) => i.href);
  ok("  beside customers' work, not last", supportLinks.indexOf("/desks/1") === supportLinks.indexOf("/inbox") + 1 && supportLinks.indexOf("/inbox/reports") > supportLinks.indexOf("/desks/1"), supportLinks);
  const bossMenu = await links(boss);
  ok("  the super admin: every desk", bossMenu.includes("Support: Zz IT desk") && bossMenu.includes("Support: Zz Admin desk"));
  ok("  another admin: none", !(await links(otherAdmin)).some((l) => l.startsWith("Support: Zz")));
  ok("  a support login: not even Help desk", !(await menu.deskMenu(support)).open);

  section("Asking");
  const asset = await db.asset.create({ data: { assetTag: "ZZ-AST-1", name: "Zz Laptop", custodianUserId: asha, createdById: boss } as never, select: { id: true } }).catch((err: unknown) => {
    console.log(err);
    return null;
  });
  const form = (o: Record<string, string>, files: File[] = []) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    for (const x of files) f.append("files", x);
    return f;
  };
  const pdf = (name: string) => new File([Buffer.from("%PDF-1.4 zz")], name, { type: "application/pdf" });
  const raise = async (by: string, o: Record<string, string>, files: File[] = []) => {
    const r = await as(by, () => actions.raiseDeskRequest(form({ deskId: itId, typeId: email, title: "Zz help", details: "", level: "SLOW", ...o }, files)));
    return r.ok ? { ok: true as const, seq: Number(r.data.href.slice(-6)) } : { ok: false as const, error: r.error };
  };
  const bad = [await raise(asha, { title: " " }), await raise(asha, { level: "NOW" }), await raise(asha, { typeId: "x" }), await raise(asha, { typeId: "" }), await raise(asha, { deskId: emptyId }), await raise(asha, { deskId: "x" }), await raise(asha, { forUserId: manager }), await raise(asha, { assetId: "x" }), await raise(asha, {}, [new File(["x"], "zz.exe", { type: "application/x-msdownload" })])];
  ok("refused: no line, no level, no type, a desk with nobody, for somebody else, an asset that isn't theirs, a kind of file it doesn't take", bad.every((b) => !b.ok) && (await db.deskRequest.count()) === 0, bad);
  const one = await raise(asha, { typeId: laptop, title: "  Laptop   shuts down ", details: "After 20 minutes", level: "BLOCKED", assetId: asset?.id ?? "" }, [pdf("photo.pdf")]);
  const oneRow = one.ok ? await db.deskRequest.findUnique({ where: { seq: one.seq }, include: { files: true } }) : null;
  ok("asked: open, with the whole desk, its line tidied, its asset and file kept, its times set", !!oneRow && oneRow.status === "OPEN" && oneRow.assignedToId === null && oneRow.title === "Laptop shuts down" && oneRow.assetId === asset?.id && oneRow.files.length === 1 && !!oneRow.replyDueAt && !!oneRow.fixDueAt && oneRow.replyDueAt < oneRow.fixDueAt, one);
  ok("  the desk's people told, and nobody else", (await told(imran, "DESK_REQUEST_NEW")) === 1 && (await told(pooja, "DESK_REQUEST_NEW")) === 1 && (await told(dev, "DESK_REQUEST_NEW")) === 1 && (await db.notification.count({ where: { type: "DESK_REQUEST_NEW" } })) === 3);
  const id = oneRow!.id;
  const seq = oneRow!.seq;

  section("Who sees it");
  const sees = async (userId: string) => {
    const v = await server.viewerOf(userId);
    return v ? ((await server.findRequest(v, { id }))?.side ?? null) : null;
  };
  ok("whoever asked, as that; the desk's people and the super admin, as the desk", (await sees(asha)) === "requester" && (await as(imran, () => sees(imran))) === "desk" && (await as(boss, () => sees(boss))) === "desk");
  ok("  not another admin, their manager, another desk, a support login or somebody who left", [await sees(otherAdmin), await sees(manager), await sees(kavya), await sees(support), await sees(gone)].every((s) => s === null));
  const page = (userId: string) => as(userId, () => text(RequestPage({ params: Promise.resolve({ ref: rulesLib.formatRequestId(seq) }) })).catch((err: Error) => err.message));
  const outsiders = [await page(otherAdmin), await page(manager), await page(kavya), await page(support)];
  ok("  its page isn't there for them, as one that isn't", outsiders.every((p) => p === "NOT_FOUND") && (await as(asha, () => text(RequestPage({ params: Promise.resolve({ ref: "REQ-999999" }) })).catch((err: Error) => err.message))) === "NOT_FOUND", outsiders);
  const queueOf = (userId: string, s = itSeq, tab = "open") => as(userId, () => text(QueuePage({ params: Promise.resolve({ seq: String(s) }), searchParams: Promise.resolve({ tab }) })).catch((err: Error) => err.message));
  ok("  nor the desk's list", [await queueOf(otherAdmin), await queueOf(manager), await queueOf(asha), await queueOf(kavya)].every((p) => p === "NOT_FOUND"));
  const acts = async (userId: string) => [
    await as(userId, () => actions.pickUpDeskRequest(id)),
    await as(userId, () => actions.assignDeskRequest(id, userId)),
    await as(userId, () => actions.setDeskRequestStatus(id, "RESOLVED")),
    await as(userId, () => actions.moveDeskRequest(id, adminId)),
    await as(userId, () => actions.sayOnDeskRequest(form({ id, kind: "note", body: "x" }))),
  ];
  const tried = [...(await acts(otherAdmin)), ...(await acts(manager)), ...(await acts(kavya)), ...(await acts(asha)), await as(manager, () => actions.sayOnDeskRequest(form({ id, body: "x" }))), await as(imran, () => actions.closeDeskRequest(id))];
  ok("  and nothing done to it: not the desk's work by whoever asked, not closed for them by the desk", tried.every((t) => !t.ok && t.error === "That request isn't there.") && (await db.deskRequestMessage.count()) === 0, tried.filter((t) => t.ok));
  viewingAs = true;
  const peeked = [await page(asha), await as(asha, () => text(HelpDeskPage({ searchParams: Promise.resolve({}) }))), await queueOf(imran)];
  const viewedActs = [await as(imran, () => actions.pickUpDeskRequest(id)), await raise(asha, {})];
  const viewedFile = await as(asha, () => fileRoute.GET(new Request("http://zz.invalid/f"), { params: Promise.resolve({ id: oneRow!.files[0]!.id }) }));
  viewingAs = false;
  ok("  nothing of it shown, or done, while viewing as somebody who could", peeked.every((p) => p.includes("aren't shown while you're viewing") && !p.includes("shuts down")) && viewedActs.every((a) => !a.ok) && viewedFile.status === 404, peeked);

  section("Working it");
  const both = await Promise.all([as(imran, () => actions.pickUpDeskRequest(id)), new Promise((r) => setTimeout(r, 1)).then(() => as(pooja, () => actions.pickUpDeskRequest(id)))]);
  const holder = (await db.deskRequest.findUniqueOrThrow({ where: { id }, select: { assignedToId: true, status: true } })).assignedToId;
  ok("picked up, once", (await db.deskRequestMessage.count({ where: { requestId: id, kind: "EVENT", body: { contains: "picked it up" } } })) === 1 && !!holder, both);
  await db.deskRequest.update({ where: { id }, data: { assignedToId: imran, status: "IN_PROGRESS" } });
  const beforeNote = await told(asha, "DESK_REQUEST_UPDATE");
  const noted = await as(pooja, () => actions.sayOnDeskRequest(form({ id, kind: "note", body: "Third time for this model" }, [pdf("secret.pdf")])));
  ok("a note tells whoever has it, and never whoever asked", noted.ok && (await told(imran, "DESK_REQUEST_UPDATE")) === 1 && (await told(asha, "DESK_REQUEST_UPDATE")) === beforeNote, noted);
  const ashaPage = await page(asha);
  const imranPage = await page(imran);
  ok("  seen by the desk", imranPage.includes("Third time for this model") && imranPage.includes("desk only") && imranPage.includes("secret.pdf"));
  ok("  and not by whoever asked: not the note, not its file", ashaPage.includes("After 20 minutes") && !ashaPage.includes("Third time") && !ashaPage.includes("secret.pdf"), ashaPage.slice(0, 400));
  const noteFile = await db.deskRequestFile.findFirstOrThrow({ where: { fileName: "secret.pdf" }, select: { id: true } });
  const serve = (userId: string, fileId: string) => as(userId, () => fileRoute.GET(new Request("http://zz.invalid/f"), { params: Promise.resolve({ id: fileId }) }));
  const own = await serve(asha, oneRow!.files[0]!.id);
  ok("  a file opened by whoever may, and by nobody else; a note's, not by whoever asked", own.status === 200 && (await own.text()).startsWith("%PDF") && (await serve(imran, noteFile.id)).status === 200 && [await serve(asha, noteFile.id), await serve(manager, oneRow!.files[0]!.id), await serve(kavya, noteFile.id), await serve(otherAdmin, noteFile.id), await serve("", noteFile.id)].every((r) => r.status === 404));
  mails.length = 0;
  const replied = await as(imran, () => actions.sayOnDeskRequest(form({ id, kind: "reply", body: "Bring it at 3" })));
  const afterReply = await db.deskRequest.findUniqueOrThrow({ where: { id }, select: { firstRepliedAt: true, status: true } });
  ok("a reply is the first reply, and whoever asked is told", replied.ok && !!afterReply.firstRepliedAt && (await told(asha, "DESK_REQUEST_UPDATE")) === beforeNote + 1 && mails.some((m) => m.userId === asha && m.body.includes("Bring it at 3")));
  ok("  an empty one isn't", !(await as(imran, () => actions.sayOnDeskRequest(form({ id, body: "  " })))).ok);
  ok("given only to the desk's people, and never to whoever asked", !(await as(imran, () => actions.assignDeskRequest(id, kavya))).ok && !(await as(imran, () => actions.assignDeskRequest(id, asha))).ok && !(await as(imran, () => actions.assignDeskRequest(id, support))).ok && (await as(imran, () => actions.assignDeskRequest(id, pooja))).ok && (await as(pooja, () => actions.assignDeskRequest(id, null))).ok && (await as(imran, () => actions.assignDeskRequest(id, imran))).ok);

  section("The clock");
  const V = async (userId: string) => (await as(userId, () => server.viewerOf(userId)))!;
  const imranV = await V(imran);
  const ashaV = await V(asha);
  await db.attendanceSettings.create({ data: { id: "global", startMinute: 570, endMinute: 1110, graceMinutes: 0 } as never });
  const clockDay = (s: string) => new Date(`2026-11-${s}:00+05:30`);
  await db.deskRequest.update({ where: { id }, data: { status: "IN_PROGRESS", firstRepliedAt: null, replyDueAt: clockDay("25T12:00"), fixDueAt: clockDay("26T12:00"), pausedAt: null } });
  await server.setStatus(imranV, id, "WAITING", clockDay("25T11:00"));
  await server.setStatus(imranV, id, "ON_HOLD", clockDay("25T11:30"));
  const held = await db.deskRequest.findUniqueOrThrow({ where: { id } });
  ok("stopped while it waits, and once: on hold after it keeps when it stopped", held.pausedAt?.getTime() === clockDay("25T11:00").getTime() && held.status === "ON_HOLD");
  await server.setStatus(imranV, id, "IN_PROGRESS", clockDay("25T13:00"));
  const going = await db.deskRequest.findUniqueOrThrow({ where: { id } });
  ok("  going again: what's owed moved on by the office time it was stopped", going.pausedAt === null && going.replyDueAt?.getTime() === clockDay("25T14:00").getTime() && going.fixDueAt?.getTime() === clockDay("26T14:00").getTime(), going);
  await server.setStatus(imranV, id, "WAITING", clockDay("25T18:00"));
  await server.replyFromRequester(ashaV, id, "Here you go", [], clockDay("26T10:00"));
  const answered = await db.deskRequest.findUniqueOrThrow({ where: { id } });
  ok("  whoever asked answering starts it again — the night not counted", answered.status === "IN_PROGRESS" && answered.pausedAt === null && answered.fixDueAt?.getTime() === clockDay("26T15:00").getTime(), answered.fixDueAt);

  section("Overdue");
  await db.desk.update({ where: { id: itId }, data: { leadId: dev } });
  const lateBefore = await told(imran, "DESK_REQUEST_OVERDUE");
  const swept = await server.deskChores(clockDay("26T15:01"));
  ok("past its time: told to whoever has it and the desk's lead, and nobody else", swept?.fixLate === 1 && (await told(imran, "DESK_REQUEST_OVERDUE")) === lateBefore + 1 && (await told(dev, "DESK_REQUEST_OVERDUE")) === 1 && (await told(pooja, "DESK_REQUEST_OVERDUE")) === 0 && (await told(asha, "DESK_REQUEST_OVERDUE")) === 0, swept);
  const again = await server.deskChores(clockDay("26T15:06"));
  ok("  once", again?.fixLate === 0 && again.replyLate === 0 && (await told(imran, "DESK_REQUEST_OVERDUE")) === lateBefore + 1, again);
  ok("  shown in the desk's Overdue", (await queueOf(imran, itSeq, "late")).includes("Laptop shuts down"));
  await db.user.update({ where: { id: dev }, data: { departmentId: salesDept } });
  const two = await raise(asha, { title: "Zz late reply" });
  const twoId = two.ok ? (await db.deskRequest.findUniqueOrThrow({ where: { seq: two.seq } })).id : "";
  await db.deskRequest.update({ where: { id: twoId }, data: { replyDueAt: clockDay("24T10:00"), fixDueAt: clockDay("28T10:00") } });
  const sweptTwo = await server.deskChores(clockDay("26T15:30"));
  ok("  one nobody picked up: the whole desk — and not a lead who has left it", sweptTwo?.replyLate === 1 && (await told(pooja, "DESK_REQUEST_OVERDUE")) === 1 && (await told(dev, "DESK_REQUEST_OVERDUE")) === 1, sweptTwo);
  ok("  who no longer sees the desk at all", (await queueOf(dev)) === "NOT_FOUND");
  await db.user.update({ where: { id: dev }, data: { departmentId: itDept } });

  section("Somebody leaves");
  await db.deskRequest.update({ where: { id: twoId }, data: { assignedToId: pooja, status: "IN_PROGRESS" } });
  await db.user.update({ where: { id: pooja }, data: { active: false } });
  const returned = await server.deskChores(clockDay("26T15:40"));
  ok("what they had goes back to the desk, which is told, and says so", returned?.returned === 1 && (await db.deskRequest.findUniqueOrThrow({ where: { id: twoId } })).assignedToId === null && (await db.deskRequestMessage.count({ where: { requestId: twoId, body: { startsWith: "Back with the desk" } } })) === 1, returned);
  await db.user.update({ where: { id: pooja }, data: { active: true } });

  section("Resolved, and opened again");
  const resolved = await as(imran, () => actions.sayOnDeskRequest(form({ id, kind: "reply", body: "Fan cleaned", resolve: "1" })));
  const done = await db.deskRequest.findUniqueOrThrow({ where: { id } });
  ok("a reply that resolves it", resolved.ok && done.status === "RESOLVED" && !!done.resolvedAt);
  ok("  can't be picked up or moved then", !(await as(pooja, () => actions.pickUpDeskRequest(id))).ok && !(await as(imran, () => actions.moveDeskRequest(id, adminId))).ok);
  await server.replyFromRequester(ashaV, id, "It's back", [], new Date(done.resolvedAt!.getTime() + 86_400_000));
  const reopened = await db.deskRequest.findUniqueOrThrow({ where: { id } });
  ok("  a reply from whoever asked opens it again, with time afresh", reopened.status === "IN_PROGRESS" && reopened.resolvedAt === null && reopened.fixLateToldAt === null && reopened.fixDueAt! > done.resolvedAt!, reopened);
  const closed = await as(asha, () => actions.closeDeskRequest(id));
  ok("closed by whoever asked", closed.ok && (await db.deskRequest.findUniqueOrThrow({ where: { id } })).status === "RESOLVED");
  await db.deskRequest.update({ where: { id }, data: { resolvedAt: new Date(Date.now() - 15 * 86_400_000) } });
  const tooLate = await as(asha, () => actions.sayOnDeskRequest(form({ id, body: "Again" })));
  ok("  too long ago: a new one is asked for", !tooLate.ok && /new request/.test(tooLate.error), tooLate);

  section("Moving it");
  const moved = await as(imran, () => actions.moveDeskRequest(twoId, adminId));
  ok("to another desk: back to this one's list, as it isn't theirs to see any more", moved.ok && moved.data.href === rulesLib.deskPath(itSeq), moved);
  const imranAfter = await V(imran);
  const kavyaV = await V(kavya);
  ok("  the new desk sees it and is told; the old one doesn't", (await server.findRequest(imranAfter, { id: twoId })) === null && (await server.findRequest(kavyaV, { id: twoId }))?.side === "desk" && (await told(kavya, "DESK_REQUEST_NEW")) === 1);
  const movedRow = await db.deskRequest.findUniqueOrThrow({ where: { id: twoId } });
  ok("  its time from there, its type left behind", movedRow.status === "OPEN" && movedRow.typeId === null && movedRow.assignedToId === null && movedRow.replyLateToldAt === null && movedRow.replyDueAt! > new Date());
  ok("  not to a desk with nobody", !(await as(kavya, () => actions.moveDeskRequest(twoId, emptyId))).ok);

  section("Their own desk");
  const self = await raise(imran, { title: "Zz my own" });
  const selfId = self.ok ? (await db.deskRequest.findUniqueOrThrow({ where: { seq: self.seq } })).id : "";
  ok("one of the desk's people asking it is only the one who asked: no list, no note, no working it", (await server.findRequest(imranAfter, { id: selfId }))?.side === "requester" && !(await queueOf(imran)).includes("Zz my own") && (await queueOf(pooja)).includes("Zz my own") && !(await as(imran, () => actions.pickUpDeskRequest(selfId))).ok && !(await as(imran, () => actions.sayOnDeskRequest(form({ id: selfId, kind: "note", body: "x" })))).ok);

  section("Given out");
  const setRouting = (routing: string, personId: string | null = null) => as(boss, async () => actions.saveDeskSettings({ ...base, id: itId, name: "Zz IT", departmentId: itDept, routing, personId, types: [{ id: laptop, name: "Laptop", asksAsset: true, active: true }, { id: email, name: "Email", asksAsset: false, active: true }] }));
  ok("to one person", (await setRouting("PERSON", pooja)).ok);
  const toOne = await raise(asha, { title: "Zz to Pooja" });
  const holderOf = async (r: { ok: boolean; seq?: number }) => (r.ok ? (await db.deskRequest.findUniqueOrThrow({ where: { seq: r.seq! } })).assignedToId : null);
  ok("  hers, and she alone is told", (await holderOf(toOne)) === pooja);
  const byPooja = await raise(pooja, { title: "Zz by Pooja" });
  ok("  unless she's the one asking: the whole desk", byPooja.ok && (await holderOf(byPooja)) === null);
  await setRouting("TURN");
  const turns = [];
  for (let i = 0; i < 4; i++) turns.push(await holderOf(await raise(asha, { title: `Zz turn ${i}` })));
  ok("each in turn, by name, and round again", turns.join() === [dev, imran, pooja, dev].join(), turns);
  const atOnce = await Promise.all([1, 2, 3].map(async (n) => server.raiseRequest(ashaV, { deskId: itId, typeId: email, title: `Zz at once ${n}`, details: "", level: "SLOW", assetId: null })));
  const three = await Promise.all(atOnce.map(async (r) => (await db.deskRequest.findUniqueOrThrow({ where: { id: r.id } })).assignedToId));
  ok("  three at once: three people", new Set(three).size === 3, three);

  section("For a colleague");
  const forAsha = await raise(imran, { title: "Zz for Asha", forUserId: asha });
  const forRow = forAsha.ok ? await db.deskRequest.findUniqueOrThrow({ where: { seq: forAsha.seq } }) : null;
  ok("raised by one of the desk's people, theirs: they're told, and see it as whoever asked", forRow?.requesterId === asha && forRow.raisedById === imran && (await page(asha).then(() => server.findRequest(ashaV, { id: forRow!.id })))?.side === "requester");
  ok("  their assets shown to the desk, not to anybody", (await as(imran, () => actions.deskColleagueAssets(itId, asha))).length === 1 && (await as(manager, () => actions.deskColleagueAssets(itId, asha))).length === 0 && (await as(kavya, () => actions.deskColleagueAssets(itId, asha))).length === 0);
  ok("  nobody who has left, or a support login", !(await raise(imran, { forUserId: gone })).ok && !(await raise(imran, { forUserId: support })).ok);

  section("Limits");
  const others = await db.user.findUniqueOrThrow({ where: { id: kavya } });
  await db.deskRequest.createMany({ data: Array.from({ length: rulesLib.REQUESTS_PER_DAY }, (_, i) => ({ deskId: itId, requesterId: others.id, title: `Zz ${i}`, level: "SLOW" })) });
  const many = await raise(kavya, {});
  ok("a day's requests", !many.ok && /requests today/.test(many.error), many);
  ok("  too many files", !(await raise(asha, {}, Array.from({ length: 6 }, (_, i) => pdf(`${i}.pdf`)))).ok);

  section("Changing desks");
  const dropped = await as(boss, () => actions.saveDeskSettings({ ...base, id: itId, name: "Zz IT", departmentId: itDept, types: [{ id: email, name: "Email", asksAsset: false, active: true }] }));
  const droppedRow = await db.deskRequestType.findUnique({ where: { id: laptop } });
  ok("a type a request used is only not offered any more", dropped.ok && droppedRow?.active === false && !(await server.liveDesks())[0]!.types.some((t) => t.id === laptop));
  ok("  a desk somebody has asked can't be deleted; one nobody has can", !(await as(boss, () => actions.deleteDeskSettings(itId))).ok && (await as(boss, () => actions.deleteDeskSettings(emptyId))).ok && !(await as(asha, () => actions.deleteDeskSettings(adminId))).ok);
  const off = await as(boss, () => actions.saveDeskSettings({ ...base, id: itId, name: "Zz IT", departmentId: itDept, active: false, types: [{ id: email, name: "Email", asksAsset: false, active: true }] }));
  ok("switched off: no new requests, its people still read what's there", off.ok && !(await raise(asha, {})).ok && (await queueOf(pooja)).includes("Zz my own") && (await menu.deskMenu(pooja)).desks.length === 1);
  await as(boss, () => actions.saveDeskSettings({ ...base, id: itId, name: "Zz IT", departmentId: itDept, types: [{ id: email, name: "Email", asksAsset: false, active: true }] }));
  await db.department.update({ where: { id: adminDept }, data: { members: { set: [] } } });
  await db.department.delete({ where: { id: adminDept } });
  ok("its department deleted: nobody asks it, and only the super admin sees what's there", (await server.findRequest(await V(kavya), { id: twoId })) === null && (await as(boss, async () => server.findRequest(await V(boss), { id: twoId })))?.side === "desk" && !(await server.liveDesks()).some((d) => d.id === adminId));

  section("The screens");
  const home = await as(asha, () => text(HelpDeskPage({ searchParams: Promise.resolve({ show: "all" }) })));
  ok("Help desk: the desks to ask, her requests and nobody else's", home.includes("What do you need help with") && home.includes("Zz IT") && home.includes("Zz late reply") && !home.includes("Zz my own"), home.slice(0, 300));
  const newPage = await as(asha, () => text(NewPage({ searchParams: Promise.resolve({ desk: String(itSeq) }) })));
  ok("  a new one: who sees it, and when they hear back", newPage.includes("New request to Zz IT") && newPage.includes("Zz Imran") && newPage.includes("the super admin. Nobody else, unless it needs") && newPage.includes("First reply within 4 working hours"), newPage.slice(0, 400));
  const notColleague = await as(asha, () => text(NewPage({ searchParams: Promise.resolve({ desk: String(itSeq), for: "colleague" }) })));
  ok("  raising for a colleague offered to the desk's people alone", !notColleague.includes("Raise for a colleague") && (await as(imran, () => text(NewPage({ searchParams: Promise.resolve({ desk: String(itSeq), for: "colleague" }) })))).includes("Raise for a colleague"));
  const list = await queueOf(imran);
  ok("  the desk's list, with Pick up on what nobody has", list.includes("Zz IT desk") && list.includes("Zz by Pooja") && list.includes("Pick up"));
  ok("  settings, with no request in them", (await as(boss, () => text(SettingsPage()))).includes("What people can ask for") && !(await as(boss, () => text(SettingsPage()))).includes("shuts down"));
  ok("    and not for an employee", (await as(asha, () => text(SettingsPage()).catch((err: Error) => err.message))) === "NOT_FOUND");

  section("Approved first");
  const setTypes = (types: Record<string, unknown>[]) => as(boss, () => actions.saveDeskSettings({ ...base, id: itId, name: "Zz IT", departmentId: itDept, types } as never));
  await setTypes([{ id: email, name: "Email", asksAsset: false, active: true }, { id: laptop, name: "Laptop", asksAsset: true, active: true }, { name: "Software", asksAsset: false, approval: "MANAGER", active: true }]);
  const software = (await server.liveDesks())[0]!.types.find((t) => t.name === "Software")!;
  ok("a kind its manager approves, kept", software.approval === "MANAGER" && (await as(boss, () => server.deskSettings()))[0]!.types.some((t) => t.approval === "MANAGER"));
  const askedPage = await as(asha, () => text(NewPage({ searchParams: Promise.resolve({ desk: String(itSeq) }) })));
  ok("  the form says who else sees what's asked", askedPage.includes("unless it needs somebody's approval"));
  const newBefore = await db.notification.count({ where: { type: "DESK_REQUEST_NEW" } });
  const first = await raise(asha, { typeId: software.id, title: "Zz Figma licence", details: "For the campaign" }, [pdf("quote.pdf")]);
  const firstRow = first.ok ? await db.deskRequest.findUniqueOrThrow({ where: { seq: first.seq }, include: { approvals: true, files: true } }) : null;
  const firstId = firstRow!.id;
  ok("asked: held, with nobody, its time not begun, their manager asked", firstRow?.status === "APPROVAL" && firstRow.assignedToId === null && firstRow.fixDueAt === null && firstRow.approvals[0]?.approverId === manager && firstRow.approvals[0].stage === "FIRST" && (await told(manager, "DESK_REQUEST_APPROVAL")) === 1, first);
  ok("  the desk told nothing, and doesn't see it: not its list, its page, its file, nor anything to do to it", (await db.notification.count({ where: { type: "DESK_REQUEST_NEW" } })) === newBefore && !(await queueOf(imran)).includes("Figma") && (await as(imran, async () => server.findRequest(await V(imran), { id: firstId }))) === null && (await serve(imran, firstRow!.files[0]!.id)).status === 404 && !(await as(imran, () => actions.pickUpDeskRequest(firstId))).ok && !(await as(imran, () => actions.addDeskStep(firstId, "x y", null))).ok);
  const pageOf = (userId: string, s: number) => as(userId, () => text(RequestPage({ params: Promise.resolve({ ref: rulesLib.formatRequestId(s) }) })).catch((err: Error) => err.message));
  const managerPage = await pageOf(manager, firstRow!.seq);
  ok("  the manager sees what was asked and its file, and may decide", managerPage.includes("For the campaign") && managerPage.includes("What was asked") && managerPage.includes("Should Zz Asha have this?") && (await serve(manager, firstRow!.files[0]!.id)).status === 200, managerPage.slice(0, 400));
  ok("  another colleague, and another admin: not there", (await pageOf(finance, firstRow!.seq)) === "NOT_FOUND" && (await pageOf(otherAdmin, firstRow!.seq)) === "NOT_FOUND" && !(await as(otherAdmin, () => actions.decideDeskRequest(firstId, true, ""))).ok);
  ok("  nor decided by whoever asked, or by the desk", !(await as(asha, () => actions.decideDeskRequest(firstId, true, ""))).ok && !(await as(imran, () => actions.decideDeskRequest(firstId, true, ""))).ok && !(await as(manager, () => actions.sayOnDeskRequest(form({ id: firstId, body: "hello" })))).ok);
  ok("  whoever asked can't say more meanwhile", !(await as(asha, () => actions.sayOnDeskRequest(form({ id: firstId, body: "please" })))).ok);
  viewingAs = true;
  const decidedViewing = await as(manager, () => actions.decideDeskRequest(firstId, true, ""));
  viewingAs = false;
  ok("  nor while viewing as the manager", !decidedViewing.ok && (await db.deskRequest.findUniqueOrThrow({ where: { id: firstId } })).status === "APPROVAL");
  const twice = await Promise.all([as(manager, () => actions.decideDeskRequest(firstId, true, "Go ahead")), new Promise((r) => setTimeout(r, 1)).then(() => as(manager, () => actions.decideDeskRequest(firstId, false, "No")))]);
  const approved = await db.deskRequest.findUniqueOrThrow({ where: { id: firstId }, include: { approvals: true } });
  ok("approved, once: open, its time begun, the desk told, whoever asked told with the word", twice.filter((t) => t.ok).length === 1 && approved.approvals[0]!.status !== "PENDING" && (approved.approvals[0]!.status === "APPROVED" ? approved.status === "OPEN" && !!approved.fixDueAt : approved.status === "REJECTED"), { twice, status: approved.status });
  if (approved.status !== "OPEN") await db.deskRequest.update({ where: { id: firstId }, data: { status: "OPEN" } });
  ok("  in the desk's list now", (await queueOf(imran)).includes("Figma"));
  await as(imran, () => actions.sayOnDeskRequest(form({ id: firstId, kind: "reply", body: "Zz secret price talk" })));
  ok("  and the manager still sees what was asked, not what's said", (await pageOf(manager, firstRow!.seq)).includes("For the campaign") && !(await pageOf(manager, firstRow!.seq)).includes("secret price talk"));
  const no = await raise(asha, { typeId: software.id, title: "Zz not this" });
  const noRow = await db.deskRequest.findUniqueOrThrow({ where: { seq: no.ok ? no.seq : 0 } });
  const rejected = await as(manager, () => actions.decideDeskRequest(noRow.id, false, "Use the free one"));
  ok("not approved: over, the desk never sees it, whoever asked sees why and can't open it again", rejected.ok && (await db.deskRequest.findUniqueOrThrow({ where: { id: noRow.id } })).status === "REJECTED" && !(await queueOf(imran, itSeq, "resolved")).includes("not this") && (await pageOf(asha, noRow.seq)).includes("Use the free one") && !(await as(asha, () => actions.sayOnDeskRequest(form({ id: noRow.id, body: "please" })))).ok && (await pageOf(imran, noRow.seq)) === "NOT_FOUND", rejected);
  const taken = await raise(asha, { typeId: software.id, title: "Zz taken back" });
  const takenRow = await db.deskRequest.findUniqueOrThrow({ where: { seq: taken.ok ? taken.seq : 0 } });
  ok("taken back: the approval goes with it, and the desk still doesn't see it", (await as(asha, () => actions.closeDeskRequest(takenRow.id))).ok && (await db.deskApproval.findFirstOrThrow({ where: { requestId: takenRow.id } })).status === "WITHDRAWN" && (await pageOf(imran, takenRow.seq)) === "NOT_FOUND" && (await pageOf(manager, takenRow.seq)) === "NOT_FOUND");
  const byBoss = await raise(asha, { typeId: software.id, title: "Zz boss decides" });
  const byBossRow = await db.deskRequest.findUniqueOrThrow({ where: { seq: byBoss.ok ? byBoss.seq : 0 } });
  ok("the super admin may decide in their place", (await pageOf(boss, byBossRow.seq)).includes("Should Zz Asha") && (await as(boss, () => actions.decideDeskRequest(byBossRow.id, true, ""))).ok && (await db.deskRequest.findUniqueOrThrow({ where: { id: byBossRow.id } })).status === "OPEN");
  const noManager = await raise(finance, { typeId: software.id, title: "Zz no manager" });
  ok("with no manager, the super admin is asked", (await db.deskApproval.findFirstOrThrow({ where: { request: { seq: noManager.ok ? noManager.seq : 0 } } })).approverId === boss);
  const bossOwn = await raise(boss, { typeId: software.id, title: "Zz boss own" });
  ok("  and the super admin's own, with nobody above, goes straight to the desk", (await db.deskRequest.findUniqueOrThrow({ where: { seq: bossOwn.ok ? bossOwn.seq : 0 } })).status === "OPEN");
  const leaving = await raise(asha, { typeId: software.id, title: "Zz manager leaves" });
  await db.user.update({ where: { id: manager }, data: { active: false } });
  const moved1 = await server.deskChores();
  ok("a manager who leaves: it's asked of the super admin", moved1?.approvalsMoved === 1 && (await db.deskApproval.findFirstOrThrow({ where: { request: { seq: leaving.ok ? leaving.seq : 0 } } })).approverId === boss, moved1);
  await db.user.update({ where: { id: manager }, data: { active: true } });
  const colleagueHeld = await as(imran, () => actions.raiseDeskRequest(form({ deskId: itId, typeId: software.id, title: "Zz held for Asha", details: "", level: "SLOW", forUserId: asha })));
  ok("raised for a colleague and held: not the desk's yet, so back to Help desk", colleagueHeld.ok && colleagueHeld.data.href === "/help-desk", colleagueHeld);

  section("The desk asks for approval");
  const spend = await raise(asha, { typeId: email, title: "Zz new monitor", details: "Mine flickers" });
  const spendId = (await db.deskRequest.findUniqueOrThrow({ where: { seq: spend.ok ? spend.seq : 0 } })).id;
  const spendSeq = spend.ok ? spend.seq : 0;
  await as(imran, () => actions.pickUpDeskRequest(spendId));
  await as(imran, () => actions.sayOnDeskRequest(form({ id: spendId, kind: "note", body: "Zz desk note" })));
  ok("refused: no reason, themselves, whoever asked for it, a support login; and not by whoever asked", [await as(imran, () => actions.askDeskApproval(spendId, finance, " ")), await as(imran, () => actions.askDeskApproval(spendId, imran, "Pay it")), await as(imran, () => actions.askDeskApproval(spendId, asha, "Pay it")), await as(imran, () => actions.askDeskApproval(spendId, support, "Pay it")), await as(asha, () => actions.askDeskApproval(spendId, finance, "Pay it"))].every((x) => !x.ok));
  const askedFor = await as(imran, () => actions.askDeskApproval(spendId, finance, "Zz 14,000 for a monitor"));
  const askedRow = await db.deskRequest.findUniqueOrThrow({ where: { id: spendId } });
  ok("asked: waits with its clock stopped, and only once at a time", askedFor.ok && askedRow.status === "ASKED" && !!askedRow.pausedAt && !(await as(imran, () => actions.askDeskApproval(spendId, boss, "Again please"))).ok, askedFor);
  const financePage = await pageOf(finance, spendSeq);
  ok("  who is asked sees what was asked and why, not the notes", financePage.includes("Mine flickers") && financePage.includes("14,000 for a monitor") && !financePage.includes("desk note"), financePage.slice(0, 300));
  const bossAsks = await raise(asha, { typeId: email, title: "Zz boss asks" });
  const bossAsksId = (await db.deskRequest.findUniqueOrThrow({ where: { seq: bossAsks.ok ? bossAsks.seq : 0 } })).id;
  await as(boss, () => actions.askDeskApproval(bossAsksId, finance, "Zz boss wants it"));
  const bossPage = await pageOf(boss, bossAsks.ok ? bossAsks.seq : 0);
  ok("  the super admin doesn't answer what they asked for themselves, and isn't offered to", !bossPage.includes("Don't approve") && !(await as(boss, () => actions.decideDeskRequest(bossAsksId, true, ""))).ok && (await pageOf(boss, spendSeq)).includes("It's with Zz Finance. As the super admin, you can answer in their place.") && (await pageOf(finance, bossAsks.ok ? bossAsks.seq : 0)).includes("asked you to approve"));
  await as(boss, () => actions.setDeskRequestStatus(bossAsksId, "RESOLVED"));
  ok("  whoever asked for it sees that it was asked, not why", (await pageOf(asha, spendSeq)).includes("asked Zz Finance to approve it") && !(await pageOf(asha, spendSeq)).includes("14,000"));
  const approvalsPage = (require("../src/app/(dashboard)/approvals/page") as { default: () => Promise<unknown> }).default; // eslint-disable-line @typescript-eslint/no-require-imports
  ok("  on their Approvals and Help desk, and nobody else's", (await as(finance, () => text(approvalsPage()))).includes("new monitor") && (await as(finance, () => text(HelpDeskPage({ searchParams: Promise.resolve({}) })))).includes("waiting for your approval") && !(await as(kavya, () => text(approvalsPage()))).includes("new monitor"));
  viewingAs = true;
  ok("  and not while viewing as them", !(await as(finance, () => text(approvalsPage()))).includes("new monitor"));
  viewingAs = false;
  const said = await as(finance, () => actions.decideDeskRequest(spendId, false, "Zz next quarter"));
  const after = await db.deskRequest.findUniqueOrThrow({ where: { id: spendId } });
  ok("answered: back with the desk, its clock going, the one who asked told — and whoever asked for it not told why", said.ok && after.status === "IN_PROGRESS" && after.pausedAt === null && (await pageOf(imran, spendSeq)).includes("Zz next quarter") && !(await pageOf(asha, spendSeq)).includes("next quarter"), said);
  await as(imran, () => actions.askDeskApproval(spendId, finance, "Zz please again"));
  await as(imran, () => actions.setDeskRequestStatus(spendId, "IN_PROGRESS"));
  ok("going on without the answer withdraws it", (await db.deskApproval.count({ where: { requestId: spendId, status: "WITHDRAWN" } })) === 1 && !(await as(finance, () => actions.decideDeskRequest(spendId, true, ""))).ok);
  await as(imran, () => actions.askDeskApproval(spendId, finance, "Zz once more"));
  await db.user.update({ where: { id: finance }, data: { active: false } });
  await server.deskChores();
  ok("  asked of somebody who leaves: back with the desk, saying so", (await db.deskRequest.findUniqueOrThrow({ where: { id: spendId } })).status === "IN_PROGRESS" && (await pageOf(imran, spendSeq)).includes("has left"));
  await db.user.update({ where: { id: finance }, data: { active: true } });

  section("Steps");
  const stepped = await as(imran, () => actions.addDeskStep(spendId, "Zz order it", pooja));
  const step = await db.deskRequestStep.findFirstOrThrow({ where: { requestId: spendId } });
  ok("added for one of the desk's people, who is told", stepped.ok && step.assigneeId === pooja && (await db.notification.count({ where: { userId: pooja, title: { startsWith: "A step for you" } } })) === 1);
  ok("  not for somebody else, nor by anybody but the desk", !(await as(imran, () => actions.addDeskStep(spendId, "x y", kavya))).ok && !(await as(imran, () => actions.addDeskStep(spendId, "x y", asha))).ok && !(await as(asha, () => actions.addDeskStep(spendId, "x y", null))).ok && !(await as(finance, () => actions.addDeskStep(spendId, "x y", null))).ok && !(await as(asha, () => actions.changeDeskStep(step.id, true))).ok && !(await as(kavya, () => actions.changeDeskStep(step.id, null))).ok);
  ok("  seen by the desk alone — and never a task anybody else lists", (await pageOf(imran, spendSeq)).includes("Zz order it") && !(await pageOf(asha, spendSeq)).includes("Zz order it") && !(await pageOf(finance, spendSeq)).includes("Zz order it") && (await db.task.count()) === 0);

  section("Today");
  const todayLib = require("../src/lib/desks/today") as typeof import("../src/lib/desks/today"); // eslint-disable-line @typescript-eslint/no-require-imports
  const { SupportTodayCard } = require("../src/components/today/support-card") as typeof import("../src/components/today/support-card"); // eslint-disable-line @typescript-eslint/no-require-imports
  const { clockFor } = require("../src/lib/time/zone") as typeof import("../src/lib/time/zone"); // eslint-disable-line @typescript-eslint/no-require-imports
  const india = clockFor("Asia/Kolkata");
  const day = (userId: string, open = ["desks", "helpdesk"]) => as(userId, () => todayLib.supportToday(userId, open, india));
  const client = await db.company.create({ data: { name: "Zz Client", normalizedName: "zz client", relationshipType: "CLIENT", createdById: boss, ownerUserId: imran } as never, select: { id: true } });
  await db.ticket.create({ data: { companyId: client.id, title: "Zz customer ticket", assignedToUserId: imran, createdByUserId: boss, priority: "URGENT", createdAt: new Date(Date.now() - 5 * 86_400_000) } as never });
  const imranDay = await day(imran);
  ok("customers' tickets and colleagues' requests in one list, the late first", imranDay.rows.some((r) => r.kind === "Request" && r.title === "Zz new monitor") && imranDay.rows[0]!.late === true && imranDay.rows.some((r) => r.kind === "Ticket" && r.title === "Zz customer ticket"), imranDay.rows);
  ok("  a step, to whose it is; what waits for approval, to who approves", (await day(pooja)).rows.some((r) => r.kind === "Step" && r.title === "Zz order it") && (await day(boss)).rows.some((r) => r.kind === "Approve"));
  await as(imran, () => actions.setDeskRequestStatus(spendId, "WAITING"));
  ok("  what waits for their answer, to whoever asked", (await day(asha)).rows.some((r) => r.kind === "Answer" && r.title === "Zz new monitor"));
  ok("  each only where its module is open", !(await day(imran, ["desks"])).rows.some((r) => r.kind === "Ticket") && !(await day(imran, ["helpdesk"])).rows.some((r) => r.kind === "Request"));
  viewingAs = true;
  const viewedDay = await day(imran);
  viewingAs = false;
  ok("  and none of the help desk while viewing as somebody", !viewedDay.rows.some((r) => r.kind !== "Ticket"));
  ok("  ticked, a step leaves it; drawn, it reads", (await as(pooja, () => actions.changeDeskStep(step.id, true))).ok && !(await day(pooja)).rows.some((r) => r.kind === "Step") && (await text(SupportTodayCard({ rows: imranDay.rows, more: 2 }) as never)).includes("Support with you"));

  section("The asset");
  const before = await raise(asha, { typeId: laptop, title: "Zz fan noise", assetId: asset?.id ?? "" });
  const beforeRow = await db.deskRequest.findUniqueOrThrow({ where: { seq: before.ok ? before.seq : 0 } });
  const assetPage = await pageOf(imran, beforeRow.seq);
  ok("what the desk was asked about it before, to the desk; not to whoever asked", assetPage.includes("Asked about before") && assetPage.includes("Laptop shuts down") && !(await pageOf(asha, beforeRow.seq)).includes("Asked about before"), assetPage.slice(-400));
  ok("  Send for repair not offered, or done, without the right to move assets", !assetPage.includes("Send for repair") && !(await as(imran, () => actions.sendDeskAssetForRepair(beforeRow.id, "Dell"))).ok && !(await as(asha, () => actions.sendDeskAssetForRepair(beforeRow.id, "Dell"))).ok && (await db.asset.findUniqueOrThrow({ where: { id: asset!.id }, select: { status: true } })).status !== "UNDER_REPAIR");
  const bossAsset = await pageOf(boss, beforeRow.seq);
  const sent = await as(boss, () => actions.sendDeskAssetForRepair(beforeRow.id, "Dell service centre"));
  const movement = await db.assetMovement.findFirst({ where: { assetId: asset!.id, type: "SENT_FOR_REPAIR" } });
  ok("  sent by somebody who may: in the register, said on the request, and the register says nothing of it", bossAsset.includes("Send for repair") && sent.ok && movement?.toLabel === "Dell service centre" && !movement.note && (await pageOf(asha, beforeRow.seq)).includes("sent ZZ-AST-1 for repair"), sent);
  ok("  once it isn't with them, not from here", !(await as(boss, () => actions.sendDeskAssetForRepair(beforeRow.id, "Dell"))).ok);

  section("Moved with all that");
  const admin2 = await as(boss, () => actions.saveDeskSettings({ ...base, name: "Zz Facilities", departmentId: salesDept, types: [] }));
  await as(imran, () => actions.setDeskRequestStatus(spendId, "IN_PROGRESS"));
  await as(imran, () => actions.addDeskStep(spendId, "Zz second", pooja));
  await as(imran, () => actions.askDeskApproval(spendId, finance, "Zz moved meanwhile"));
  const movedOn = await as(imran, () => actions.moveDeskRequest(spendId, admin2.ok ? admin2.data.id : ""));
  ok("the approval is withdrawn, and its open steps are nobody's", movedOn.ok && (await db.deskApproval.count({ where: { requestId: spendId, status: "PENDING" } })) === 0 && (await db.deskRequestStep.count({ where: { requestId: spendId, doneAt: null, assigneeId: { not: null } } })) === 0, movedOn);

  section("Nowhere else");
  const audited = await db.auditLog.findMany({ select: { entityType: true, entityLabel: true } });
  ok("no request in the audit log: only the desks as they were set up", audited.length > 0 && audited.every((a) => a.entityType === "Desk" || a.entityType === "Asset") && !audited.some((a) => /REQ-|shuts|Zz late/.test(a.entityLabel)), audited.filter((a) => a.entityType !== "Desk" && a.entityType !== "Asset"));
  const titles = await db.notification.findMany({ where: { type: { in: ["DESK_REQUEST_NEW", "DESK_REQUEST_UPDATE", "DESK_REQUEST_OVERDUE", "DESK_REQUEST_APPROVAL"] } }, select: { title: true, userId: true, type: true } });
  ok("  what a phone shows — a notice's title — never says what it's about", titles.length > 0 && !titles.some((t) => /shuts down|late reply|my own/.test(t.title)));
  ok("  and nobody outside was ever told", !titles.some((t) => [otherAdmin, support, gone].includes(t.userId)) && titles.filter((t) => t.userId === manager).every((t) => t.type === "DESK_REQUEST_APPROVAL" || /for the Zz Facilities/.test(t.title)), titles.filter((t) => [manager, otherAdmin, support, gone].includes(t.userId)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
