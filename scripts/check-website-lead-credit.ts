/**
 * check:website-lead-credit — who a lead that came in by itself is credited to (owner, 9 Nov 2026: "this came from our
 * website, but why is my name in Raised by?"). Raised by is what "Leads raised" incentives pay on.
 *
 * A website's key of its own (ZZPROBE_WLC): its lead is raised and sourced by nobody, not the key's maker; a card's
 * lead is still its holder's; a source that says nobody (a booking page, a workflow) is nobody's; and the repair
 * migration, rolled back, clears the old credit only where it was the key's maker. Removed in a finally.
 *
 *   npm run check:website-lead-credit
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => ({ id: actorId, role: "ADMIN" }), currentUser: async () => ({ id: actorId, role: "ADMIN" }) };
  }
  if (request === "@/lib/notify") return { notifyUser: async () => undefined, notifyUsers: async () => undefined };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_WLC";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};

async function cleanup() {
  const keyIds = (await db.leadCaptureKey.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((k) => k.id);
  const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  const leads = (await db.lead.findMany({ where: { OR: [{ captureKeyId: { in: keyIds } }, { companyId: { in: companies } }] }, select: { id: true } })).map((l) => l.id);
  await db.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...leads, ...companies] } }, { entityLabel: { contains: TAG } }] } });
  await db.lead.deleteMany({ where: { id: { in: leads } } });
  await db.company.deleteMany({ where: { id: { in: companies } } });
  await db.leadCaptureKey.deleteMany({ where: { id: { in: keyIds } } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { intakeLead, leadPayloadSchema } = require("../src/lib/lead-capture/intake") as typeof import("../src/lib/lead-capture/intake");
  await cleanup();
  try {
    const maker = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: { id: true } });
    actorId = maker.id;
    const key = await db.leadCaptureKey.create({ data: { name: `${TAG} site`, keyId: `lck_zzprobewlc${Date.now()}`, secretDigest: "zz", createdById: maker.id } });
    const payload = (n: string) => leadPayloadSchema.parse({ name: `Zz ${n}`, email: `${n}@zzprobe-wlc.example`, company: `${TAG} ${n}`, external_id: `zz-${n}` });
    const credit = async (id: string | null) => db.lead.findUniqueOrThrow({ where: { id: id ?? "" }, select: { createdByUserId: true, sourcedByUserId: true } });

    const site = await intakeLead({ id: key.id, name: key.name, sourceLabel: "zzprobe.example", createdById: maker.id }, payload("site"));
    const siteCredit = await credit(site.leadId);
    ok("a website's lead is raised and sourced by nobody — not the key's maker", siteCredit.createdByUserId === null && siteCredit.sourcedByUserId === null, siteCredit);

    const card = await intakeLead({ id: null, name: "Zz's digital card", sourceLabel: "Digital card", createdById: maker.id }, payload("card"), { ownerUserId: maker.id, notify: false });
    const cardCredit = await credit(card.leadId);
    ok("a card's lead is still its holder's", cardCredit.createdByUserId === maker.id && cardCredit.sourcedByUserId === maker.id, cardCredit);

    const booked = await intakeLead({ id: null, name: "Booking page", sourceLabel: "Booking page", createdById: maker.id }, payload("booked"), { raisedBy: null, notify: false });
    const bookedCredit = await credit(booked.leadId);
    ok("a source that says nobody (a booking page, a workflow) is nobody's", bookedCredit.createdByUserId === null && bookedCredit.sourcedByUserId === null, bookedCredit);

    // The admin's choice, per form (owner, 9 Nov 2026 — "let the admin decide").
    const { keyCredit } = require("../src/lib/lead-capture/credit") as typeof import("../src/lib/lead-capture/credit");
    ok("nothing set: nobody, shown as Website", (await keyCredit(key.id)).mode === "NOBODY" && (await keyCredit(key.id)).label === "Website");
    await db.leadCaptureKey.update({ where: { id: key.id }, data: { creditMode: "NOBODY", creditLabel: "Wroffy Website" } });
    ok("nobody, under a name of the admin's own", (await keyCredit(key.id)).label === "Wroffy Website");
    await db.leadCaptureKey.update({ where: { id: key.id }, data: { creditMode: "MAKER", creditLabel: null } });
    const byMaker = await credit((await intakeLead({ id: key.id, name: key.name, sourceLabel: null, createdById: maker.id }, payload("maker"))).leadId);
    ok("set to its maker: the key's maker raised and sourced it", byMaker.createdByUserId === maker.id && byMaker.sourcedByUserId === maker.id, byMaker);
    const other = await db.user.findFirstOrThrow({ where: { active: true, isSuperAdmin: false, kind: "MEMBER" }, select: { id: true } });
    await db.leadCaptureKey.update({ where: { id: key.id }, data: { creditMode: "PERSON", creditUserId: other.id } });
    const byPerson = await credit((await intakeLead({ id: key.id, name: key.name, sourceLabel: null, createdById: maker.id }, payload("person"))).leadId);
    ok("set to a person: that person", byPerson.createdByUserId === other.id && byPerson.sourcedByUserId === other.id, byPerson);
    await db.leadCaptureKey.update({ where: { id: key.id }, data: { creditUserId: "zz-nobody-here" } });
    const gone = await credit((await intakeLead({ id: key.id, name: key.name, sourceLabel: null, createdById: maker.id }, payload("gone"))).leadId);
    ok("a person no longer here: nobody, never somebody else", gone.createdByUserId === null && gone.sourcedByUserId === null, gone);
    await db.leadCaptureKey.update({ where: { id: key.id }, data: { creditMode: null, creditUserId: null } });

    // The repair, on a lead made the old way, rolled back.
    const old = await db.lead.findUniqueOrThrow({ where: { id: site.leadId! }, select: { id: true } });
    await db.lead.update({ where: { id: old.id }, data: { createdByUserId: maker.id, sourcedByUserId: maker.id } });
    const sql = readFileSync("prisma/migrations/20261208100000_website_leads_raised_by_nobody/migration.sql", "utf8");
    const ROLLBACK = new Error("roll back");
    await db
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(sql);
        const repaired = await tx.lead.findUniqueOrThrow({ where: { id: old.id }, select: { createdByUserId: true, sourcedByUserId: true } });
        ok("the repair clears an old website lead's credit to the key's maker", repaired.createdByUserId === null && repaired.sourcedByUserId === null, repaired);
        const kept = await tx.lead.findUniqueOrThrow({ where: { id: card.leadId! }, select: { createdByUserId: true } });
        ok("…and leaves a lead with no key alone", kept.createdByUserId === maker.id);
        throw ROLLBACK;
      })
      .catch((err) => {
        if (err !== ROLLBACK) throw err;
      });
  } finally {
    await cleanup();
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} failed` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}

void main();
