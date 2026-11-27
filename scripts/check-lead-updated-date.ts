/**
 * check:lead-updated-date — a lead's Updated moves when somebody works it, not when it is rescored (owner, 5 Nov 2026:
 * "why all leads showing 5th Nov?").
 *
 * A lead of its own (ZZPROBE_LU) on an existing customer: the 12-hourly sweep and opening it leave the date alone while
 * the score is still stored; rescoring after real work moves it. Then the repair migration, in a transaction rolled
 * back: back to the last real thing that happened, never forward. Removed in a finally.
 *
 *   npm run check:lead-updated-date
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { directClient } from "../src/lib/tenancy/direct-client";

const db = directClient();
const TITLE = "ZZPROBE_LU";
const DAY = 86_400_000;
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};

async function cleanup() {
  await db.lead.deleteMany({ where: { title: { startsWith: TITLE } } });
}

async function main() {
  const { refreshLeadScore, refreshLeadScoreQuietly, refreshStaleLeadScores } = await import("../src/lib/leads/score-store");
  await cleanup();
  try {
    const company = await db.company.findFirstOrThrow({ select: { id: true } });
    const user = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: { id: true } });
    const old = new Date(Date.now() - 40 * DAY);
    const lead = await db.lead.create({ data: { title: `${TITLE} worked`, companyId: company.id, createdAt: old, updatedAt: old } });
    const updatedAt = async (id = lead.id) => (await db.lead.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } })).updatedAt.getTime();

    console.log("\n— Rescoring —\n");
    await refreshStaleLeadScores({ limit: 500 });
    const swept = await db.lead.findUniqueOrThrow({ where: { id: lead.id }, select: { scoreUpdatedAt: true, updatedAt: true } });
    ok("the sweep scored it", swept.scoreUpdatedAt !== null);
    ok("…and left Updated alone", swept.updatedAt.getTime() === old.getTime(), swept.updatedAt);

    const score = await refreshLeadScoreQuietly(lead.id);
    ok("opening it works the score out", score !== null);
    ok("…and leaves Updated alone", (await updatedAt()) === old.getTime());

    await refreshLeadScore(lead.id);
    ok("rescoring after real work moves it", (await updatedAt()) > old.getTime());

    console.log("\n— The repair —\n");
    const sql = readFileSync("prisma/migrations/20261205100000_lead_updated_repair/migration.sql", "utf8");
    const untouched = await db.lead.create({ data: { title: `${TITLE} nothing since`, companyId: company.id, createdAt: old, updatedAt: new Date() } });
    const staged = await db.lead.create({ data: { title: `${TITLE} staged`, companyId: company.id, createdAt: old, stageChangedAt: new Date(Date.now() - 20 * DAY), updatedAt: new Date() } });
    const quiet = new Date(Date.now() - 30 * DAY);
    const older = await db.lead.create({ data: { title: `${TITLE} already right`, companyId: company.id, createdAt: old, updatedAt: quiet } });
    const lastActivity = new Date(Date.now() - 3 * DAY);
    await db.activity.create({ data: { leadId: lead.id, userId: user.id, type: "NOTE", notes: "ZZ", occurredAt: lastActivity } });
    // An activity newer than its date: the repair only ever moves a date back.
    await db.activity.create({ data: { leadId: older.id, userId: user.id, type: "NOTE", notes: "ZZ", occurredAt: new Date(Date.now() - 2 * DAY) } });

    const ROLLBACK = new Error("roll back");
    await db
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(sql);
        const read = async (id: string) => (await tx.lead.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } })).updatedAt.getTime();
        ok("worked: back to its last activity", (await read(lead.id)) === lastActivity.getTime());
        ok("nothing since: back to the day it was added", (await read(untouched.id)) === old.getTime());
        ok("moved stage: back to that", (await read(staged.id)) === new Date((await tx.lead.findUniqueOrThrow({ where: { id: staged.id }, select: { stageChangedAt: true } })).stageChangedAt!).getTime());
        ok("never forward", (await read(older.id)) === quiet.getTime());
        throw ROLLBACK;
      }, { timeout: 120_000 })
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
