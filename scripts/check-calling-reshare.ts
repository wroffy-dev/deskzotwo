/**
 * check:calling-reshare — somebody added to a running calling activity gets a share (owner, 11 Nov 2026 —
 * src/lib/workspace/reshare.ts).
 *
 *   1. The rule: when the people on it and the people holding its records have drifted apart.
 *   2. On the database, with a list of its own (ZZPROBE_RESHARE, removed in a finally): twelve records between two
 *      callers, three of them called; a third caller joins — the nine uncalled are three each, the three called stay
 *      where they were; one caller leaves — their uncalled go to the others, their calls stay theirs.
 *
 *   npm run check:calling-reshare
 */
import "dotenv/config";
import { callersChanged } from "../src/lib/workspace/reshare";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && !pass ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};

async function main() {
  console.log("\n— 1. The rule —\n");
  ok("the same people: nothing to do", !callersChanged(["a", "b"], ["b", "a"]));
  ok("somebody new holds nothing: share again", callersChanged(["a", "b", "c"], ["a", "b"]));
  ok("somebody gone still holds some: share again", callersChanged(["a"], ["a", "b"]));
  ok("records nobody holds: share again", callersChanged(["a"], ["a", null]));

  console.log("\n— 2. On the database —\n");
  const { db } = await import("../src/lib/db");
  const { reshareUncalled } = await import("../src/lib/workspace/reshare");
  const people = await db.user.findMany({ where: { active: true }, orderBy: { createdAt: "asc" }, take: 3, select: { id: true } });
  const companies = await db.company.findMany({ take: 12, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (people.length < 3 || companies.length < 12) {
    console.log("  (needs three people and twelve companies — skipped)");
    return;
  }
  const [a, b, c] = people.map((p) => p.id) as [string, string, string];
  const list = await db.workbook.create({
    data: { name: "ZZPROBE_RESHARE", ownerUserId: a, filters: {}, mode: "COLD_CALLING", startedAt: new Date() } as never,
    select: { id: true },
  });
  try {
    await db.workbookRecord.createMany({
      data: companies.map((co, i) => ({ workbookId: list.id, companyId: co.id, assignedToUserId: i % 2 === 0 ? a : b, sortOrder: Math.floor(i / 2) })),
    });
    // Three called: two of a's, one of b's.
    const rows = await db.workbookRecord.findMany({ where: { workbookId: list.id }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }], select: { id: true, assignedToUserId: true } });
    const called = [...rows.filter((r) => r.assignedToUserId === a).slice(0, 2), ...rows.filter((r) => r.assignedToUserId === b).slice(0, 1)];
    await db.workbookRecord.updateMany({ where: { id: { in: called.map((r) => r.id) } }, data: { status: "DONE", completedAt: new Date() } });

    const count = async (userId: string, status?: "PENDING" | "DONE") => db.workbookRecord.count({ where: { workbookId: list.id, assignedToUserId: userId, ...(status ? { status } : {}) } });

    await db.$transaction((tx) => reshareUncalled(tx, list.id, [a, b, c], "ROUND_ROBIN"));
    ok("a third caller joins: the nine uncalled are three each", (await count(a, "PENDING")) === 3 && (await count(b, "PENDING")) === 3 && (await count(c, "PENDING")) === 3);
    ok("  calls already made stay with whoever made them", (await count(a, "DONE")) === 2 && (await count(b, "DONE")) === 1 && (await count(c, "DONE")) === 0);
    ok("  nothing dropped", (await db.workbookRecord.count({ where: { workbookId: list.id } })) === 12);
    const queue = await db.workbookRecord.findMany({ where: { workbookId: list.id, assignedToUserId: c, status: "PENDING" }, orderBy: { sortOrder: "asc" }, select: { sortOrder: true } });
    ok("  the new caller's queue runs from the top", queue.map((q) => q.sortOrder).join() === "0,1,2");

    await db.$transaction((tx) => reshareUncalled(tx, list.id, [b, c], "ROUND_ROBIN"));
    ok("a caller leaves: their uncalled go to the others", (await count(a, "PENDING")) === 0 && (await count(b, "PENDING")) + (await count(c, "PENDING")) === 9);
    ok("  their calls stay theirs", (await count(a, "DONE")) === 2);
  } finally {
    await db.workbookRecord.deleteMany({ where: { workbookId: list.id } });
    await db.workbook.delete({ where: { id: list.id } }).catch(() => undefined);
  }
}

main()
  .then(() => {
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
