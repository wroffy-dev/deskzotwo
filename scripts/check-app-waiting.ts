/**
 * check:app-waiting — "Waiting for you" on the phone (owner, 22 Nov 2026; src/lib/app/waiting.ts, /api/app/waiting),
 * through the real route handlers, as paired phones, against this workspace's database.
 *
 *   · The list: Tara's follow-up and check-in, and Arjun's chase email, each with what decides it in place; somebody
 *     else's phone sees none of them.
 *   · One opened: the draft to change, who it goes to — and only for the person whose it is.
 *   · Sent as changed from the phone, by the web's own action: from their mailbox, the email marked sent.
 *   · Set aside from the phone; a kind there isn't, a 404.
 *
 * Everything is named ZZAPPWAIT and removed at the end. Nothing leaves: the mailbox is a stand-in.
 *
 *   npm run check:app-waiting
 */
import "dotenv/config";
import Module from "node:module";
import { randomBytes } from "node:crypto";
import { directClient } from "../src/lib/tenancy/direct-client";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
process.env.TRUST_PROXY = "1";
process.env.DESKZO_APP = "on";

const TAG = "ZZAPPWAIT";
const MAIL = "@zzappwait.invalid";
const requestHeaders = new Headers({ host: "deskzo.localhost:3000", "user-agent": "check:app-waiting", "x-forwarded-for": "198.51.100.61" });

type Out = { subject: string; html: string; to: { name: string | null; email: string }[] };
const mailboxSends: Out[] = [];
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/headers") return { headers: async () => requestHeaders, cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set() {}, delete() {} }) };
  if (request === "next/navigation") return { notFound: () => { throw new Error("notFound"); }, redirect: (to: string) => { throw new Error(`redirect ${to}`); } };
  if (request === "@/lib/auth") {
    return {
      auth: async () => {
        /* eslint-disable-next-line @typescript-eslint/no-require-imports */
        const { apiActor } = require("../src/lib/api/actor") as typeof import("../src/lib/api/actor");
        const api = apiActor();
        return api ? { user: { id: api.userId, name: api.name, email: api.email, role: api.role }, expires: "" } : null;
      },
      signIn: async () => {},
      signOut: async () => {},
      handlers: {},
    };
  }
  if (request === "@/lib/email") return { sendEmailNotification: async () => {} };
  if (request === "@/lib/mail/mailbox" || request.endsWith("/lib/mail/mailbox")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return {
      ...real,
      mailboxState: async () => ({ state: "connected", provider: "GOOGLE", mailbox: "seller@zz-own.test" }),
      sendAsUser: async (_userId: string, mail: Out) => {
        mailboxSends.push(mail);
        return { ok: true, mailbox: "seller@zz-own.test", provider: "GOOGLE" };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

const ROUTES: [RegExp, string, string[]][] = [
  [/^\/waiting$/, "waiting", []],
  [/^\/waiting\/([^/]+)\/([^/]+)$/, "waiting/[kind]/[id]", ["kind", "id"]],
];
type Answer<T = unknown> = { status: number; data: T; error?: { code: string; message: string } };
async function call<T = unknown>(token: string, method: string, path: string, body?: unknown): Promise<Answer<T>> {
  const route = ROUTES.find(([re]) => re.test(path));
  if (!route) throw new Error(`no route for ${path}`);
  const [re, dir, names] = route;
  const match = re.exec(path)!;
  const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(match[i + 1]!)]));
  /* eslint-disable-next-line @typescript-eslint/no-require-imports */
  const mod = require(`../src/app/api/app/${dir}/route`) as Record<string, (req: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>>;
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  for (const [k, v] of requestHeaders) headers[k] ??= v;
  const res = await mod[method]!(new Request(`http://deskzo.localhost:3000/api/app${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), { params: Promise.resolve(params) });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  return { status: res.status, data: json.data as T, error: json.error };
}

type Item = { teammate: string; title: string; path: string; decide: { kind: string; id: string } | null };
type Email = { kind: string; company: string; to: string; subject: string; body: string; hold_until: string | null; hint: string };

async function cleanup(companyIds: string[] = []) {
  const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  const companies = [...companyIds, ...(await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id)];
  const leads = (await db.lead.findMany({ where: { companyId: { in: companies } }, select: { id: true } })).map((l) => l.id);
  await db.aiDraftRecord.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.activityLog.deleteMany({ where: { userId: { in: ids } } });
  await db.notification.deleteMany({ where: { userId: { in: ids } } });
  await db.activity.deleteMany({ where: { leadId: { in: leads } } });
  await db.marketingMessage.deleteMany({ where: { companyId: { in: companies } } });
  await db.nurtureEnrolment.deleteMany({ where: { leadId: { in: leads } } });
  await db.lead.deleteMany({ where: { id: { in: leads } } });
  await db.collectionChase.deleteMany({ where: { companyId: { in: companies } } });
  await db.reengageEmail.deleteMany({ where: { companyId: { in: companies } } });
  await db.contact.deleteMany({ where: { companyId: { in: companies } } });
  await db.company.deleteMany({ where: { id: { in: companies } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const pairing = require("../src/lib/app/pairing") as typeof import("../src/lib/app/pairing");
  /* eslint-enable @typescript-eslint/no-require-imports */
  await cleanup();
  const nurtureBefore = await db.nurtureSettings.findUnique({ where: { id: "global" } });
  const reengageBefore = await db.reengageSettings.findUnique({ where: { id: "global" } });
  try {
    section("The people, their phones and what waits");
    // One who follows up payments too, as whoever had Arjun draft a chase must.
    const seller = await db.user.create({ data: { name: `${TAG} Seller`, email: `seller${MAIL}`, role: "ADMIN", passwordHash: "x".repeat(60) } });
    const other = await db.user.create({ data: { name: `${TAG} Other`, email: `other${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) } });
    const pair = async (userId: string, model: string) => {
      const code = await pairing.startPairing(userId);
      /* eslint-disable-next-line @typescript-eslint/no-require-imports */
      const mod = require("../src/app/api/app/pair/route") as { POST: (req: Request) => Promise<Response> };
      const res = await mod.POST(new Request("http://deskzo.localhost:3000/api/app/pair", { method: "POST", headers: { ...Object.fromEntries(requestHeaders), "content-type": "application/json" }, body: JSON.stringify({ code: code.code, platform: "android", model }) }));
      return ((await res.json()) as { data: { token: string } }).data.token;
    };
    const sellerPhone = await pair(seller.id, `${TAG} seller phone`);
    const otherPhone = await pair(other.id, `${TAG} other phone`);
    ok("two people, both phones paired", sellerPhone.startsWith("dzp_") && otherPhone.startsWith("dzp_"));

    await db.nurtureSettings.upsert({ where: { id: "global" }, create: { id: "global", enabled: true, perDay: 50 }, update: { enabled: true } });
    await db.reengageSettings.upsert({ where: { id: "global" }, create: { id: "global", enabled: true }, update: { enabled: true } });
    const company = async (name: string) => {
      const c = await db.company.create({ data: { name: `${TAG} ${name} Pvt Ltd`, normalizedName: `${TAG} ${name} pvt ltd`.toLowerCase(), createdById: seller.id, ownerUserId: seller.id }, select: { id: true } });
      const p = await db.contact.create({ data: { companyId: c.id, name: `Neha ${name}`, email: `neha.${name.toLowerCase()}${MAIL}`, isPrimary: true, createdByUserId: seller.id }, select: { id: true } });
      return { id: c.id, contactId: p.id };
    };
    const a = await company("Alpha");
    const lead = await db.lead.create({ data: { companyId: a.id, contactId: a.contactId, title: `${TAG} seats`, ownerUserId: seller.id, createdByUserId: seller.id, status: "QUALIFYING" }, select: { id: true } });
    const enrol = await db.nurtureEnrolment.create({ data: { leadId: lead.id, contactId: a.contactId, ownerId: seller.id, enrolledById: seller.id, replyToken: randomBytes(12).toString("hex"), touches: { create: [{ step: 0, status: "WAITING", subject: "About the seats", body: "Hi {{firstName}},\n\nShall we pick up where we left off on the seats?\n\n{{senderName}}" }] } }, include: { touches: true } });
    const touch = enrol.touches[0]!;
    const b = await company("Beta");
    await db.customerStats.create({ data: { companyId: b.id, lastPurchaseAt: new Date(Date.now() - 300 * 86_400_000), lifetimeValue: 1 } });
    const checkIn = await db.reengageEmail.create({ data: { companyId: b.id, contactId: b.contactId, ownerId: seller.id, subject: "How are things?", body: "Hi {{firstName}},\n\nIt's been a while — how are the laptops doing?\n\n{{senderName}}", replyToken: randomBytes(12).toString("hex") } });
    const chase = await db.collectionChase.create({ data: { companyId: a.id, createdById: seller.id, tone: "gentle", subject: "Invoices due", body: "Hi {{firstName}},\n\nA reminder about {{invoices}}.\n\n{{senderName}}", documentIds: [], replyToken: randomBytes(12).toString("hex") } });

    section("The list");
    const list = await call<{ items: Item[]; total: number }>(sellerPhone, "GET", "/waiting");
    const mine = list.data?.items.filter((i) => i.decide && [touch.id, checkIn.id, chase.id].includes(i.decide.id)) ?? [];
    ok("their phone lists the follow-up, the check-in and the chase email — each to decide in place", list.status === 200 && mine.length === 3 && mine.some((i) => i.decide?.kind === "nurture") && mine.some((i) => i.decide?.kind === "checkin") && mine.some((i) => i.decide?.kind === "chase"), list.data?.items.map((i) => i.title));
    const theirs = await call<{ items: Item[] }>(otherPhone, "GET", "/waiting");
    ok("  somebody else's phone sees none of them", theirs.status === 200 && !theirs.data.items.some((i) => i.decide && [touch.id, checkIn.id, chase.id].includes(i.decide.id)));

    section("Opened");
    const opened = await call<Email>(sellerPhone, "GET", `/waiting/nurture/${touch.id}`);
    ok("the follow-up: the draft, its company and who it goes to", opened.status === 200 && opened.data.subject === "About the seats" && opened.data.to === "Neha Alpha" && opened.data.company.includes("Alpha") && opened.data.hint.includes("{{firstName}}"), opened.data ?? opened.error);
    const peek = await call<Email>(otherPhone, "GET", `/waiting/nurture/${touch.id}`);
    ok("  on somebody else's phone: not there", peek.status === 404, peek.status);
    ok("a kind there isn't: 404", (await call(sellerPhone, "GET", `/waiting/invoice/${touch.id}`)).status === 404);

    section("Sent and set aside from the phone");
    const sent = await call<{ done: string }>(sellerPhone, "POST", `/waiting/nurture/${touch.id}`, { action: "send", when: "now", subject: "About the 40 seats", body: opened.data.body });
    const after = await db.nurtureTouch.findUnique({ where: { id: touch.id } });
    const m = mailboxSends[mailboxSends.length - 1];
    ok("sent as changed, from their mailbox, by the web's own action", sent.status === 200 && sent.data.done === "sent" && after?.status === "SENT" && after.subject === "About the 40 seats" && m?.to[0]?.email === `neha.alpha${MAIL}` && !!m.html.includes("Hi Neha,"), sent.data ?? sent.error);
    ok("  sending it again: refused, saying why", (await call(sellerPhone, "POST", `/waiting/nurture/${touch.id}`, { action: "send", when: "now", subject: "x again", body: "y".repeat(30) })).status === 422);
    const stolen = await call(otherPhone, "POST", `/waiting/checkin/${checkIn.id}`, { action: "send", when: "now", subject: "Hijacked", body: "z".repeat(40) });
    ok("somebody else's phone can't send the check-in", stolen.status === 422 && (await db.reengageEmail.findUnique({ where: { id: checkIn.id } }))?.status === "WAITING", stolen.error);
    const checkInOpen = await call<Email>(sellerPhone, "GET", `/waiting/checkin/${checkIn.id}`);
    const how = checkInOpen.data.hold_until ? "working-hours" : "now";
    const approved = await call<{ done: string }>(sellerPhone, "POST", `/waiting/checkin/${checkIn.id}`, { action: "send", when: how, subject: checkInOpen.data.subject, body: checkInOpen.data.body });
    const ci = await db.reengageEmail.findUnique({ where: { id: checkIn.id } });
    ok(`the check-in approved — ${checkInOpen.data.hold_until ? `held for ${checkInOpen.data.hold_until}` : "sent at once, in working hours"}`, approved.status === 200 && (checkInOpen.data.hold_until ? approved.data.done === "held" && ci?.status === "SCHEDULED" : approved.data.done === "sent" && ci?.status === "SENT"), approved.data ?? approved.error);
    const chaseOpen = await call<Email>(sellerPhone, "GET", `/waiting/chase/${chase.id}`);
    ok("the chase email opens, with what it's about", chaseOpen.status === 200 && chaseOpen.data.subject === "Invoices due" && chaseOpen.data.hint.includes("{{invoices}}"), chaseOpen.data ?? chaseOpen.error);
    const skipped = await call<{ done: string }>(sellerPhone, "POST", `/waiting/chase/${chase.id}`, { action: "skip" });
    ok("  set aside from the phone", skipped.status === 200 && skipped.data.done === "skipped" && (await db.collectionChase.findUnique({ where: { id: chase.id } }))?.status !== "WAITING", skipped.data ?? skipped.error);
    const left = await call<{ items: Item[] }>(sellerPhone, "GET", "/waiting");
    ok("what was decided is off the list", !left.data.items.some((i) => i.decide && [touch.id, chase.id].includes(i.decide.id)));
  } finally {
    await cleanup();
    await db.nurtureSettings.deleteMany({ where: { id: "global" } });
    if (nurtureBefore) await db.nurtureSettings.create({ data: nurtureBefore });
    await db.reengageSettings.deleteMany({ where: { id: "global" } });
    if (reengageBefore) await db.reengageSettings.create({ data: reengageBefore });
  }
  console.log(failures ? `\n${failures} failed` : "\nAll app-waiting checks passed.");
  if (failures) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
