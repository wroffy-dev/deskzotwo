/**
 * That handing over a leaver's work moves their work — and only their work.
 *
 * This feature can re-point an entire book of business from one screen, and every way it can go
 * wrong is silent:
 *
 *   - a record dropped during a split stays assigned to somebody who has left, and looks owned,
 *   - a successor who is deactivated absorbs the lot and nothing ever surfaces again,
 *   - and a sweep that reaches one field too far rewrites who approved an order or whose payslip
 *     that was, which nothing in the application would ever report.
 *
 * None of those throw. So this builds a small organisation, gives one person a spread of work,
 * hands it over through the real action, and then asks the database what actually moved.
 *
 *   npm run check:handover
 *
 * The session substitution is the same one `check-notes` documents at length: two modules are
 * swapped as they load so a script can say who is calling. Everything that decides what moves —
 * the area registry, the routing rules, the allocator, the transaction — is the real code.
 *
 * Everything is created under a reserved prefix and removed again, so this is safe to run against
 * a database with real data in it.
 *
 * And who may hand over a person (owner, 3 Nov 2026 — "Phase 2 permission fixes", audit M-5 follow-up, L-2): moving
 * somebody's reports is a manager change for each of them, held to `assertMayChangeManager` as the user screen holds
 * one — nobody into your own line, nobody under a person reaching wider by team than you or the leaver did (a team
 * passing to a successor is succession), nobody their own manager — before anything is written; and the history of
 * somebody else's handovers is for whoever may run one.
 */
import Module from "node:module";
import type { Role } from "@/lib/roles";
import { db } from "../src/lib/db";

const PREFIX = "ZZHandover";
const EMAIL = "zzhandover.";
// A custom role holding nothing, for somebody who holds only what they're granted (as check:confer's).
const BARE_ROLE = "ZZHANDOVER_BARE";

let failures = 0;
function ok(label: string, pass: boolean, detail: unknown = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== null ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
}
function section(title: string) {
  console.log(`\n— ${title} —\n`);
}

// ── Who the actions think is calling ────────────────────────────────────────────────────────────

type Actor = { id: string; name: string; email: string; role: Role };
let actor: Actor | null = null;

const load = Module.createRequire(__filename);
const moduleInternals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};

const sessionStub = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
};
const cacheStub = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T>(fn: T) => fn };

const substitutes = new Map<string, unknown>([
  [load.resolve("../src/lib/session"), sessionStub],
  [load.resolve("next/cache"), cacheStub],
]);

const realLoad = moduleInternals._load;
moduleInternals._load = function (request: string, parent: unknown, isMain: boolean) {
  let resolved: string | null = null;
  try {
    resolved = moduleInternals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && substitutes.has(resolved)) return substitutes.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

const handover = load("../src/actions/handover") as typeof import("../src/actions/handover");

// ── The cast ────────────────────────────────────────────────────────────────────────────────────

async function makeUser(name: string, role: Role, active = true) {
  return db.user.create({
    data: {
      name: `${PREFIX} ${name}`,
      email: `${EMAIL}${name.toLowerCase()}@example.invalid`,
      passwordHash: "x",
      role,
      active,
    },
  });
}

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { startsWith: EMAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return;
  const companies = await db.company.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } });
  const companyIds = companies.map((c) => c.id);

  await db.assetMovement.deleteMany({ where: { OR: [{ fromUserId: { in: ids } }, { toUserId: { in: ids } }] } });
  await db.asset.deleteMany({ where: { assetTag: { startsWith: PREFIX } } });
  await db.workbookRecord.deleteMany({ where: { workbook: { name: { startsWith: PREFIX } } } });
  await db.workbook.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await db.task.deleteMany({ where: { title: { startsWith: PREFIX } } });
  await db.ticket.deleteMany({ where: { title: { startsWith: PREFIX } } });
  await db.lead.deleteMany({ where: { title: { startsWith: PREFIX } } });
  await db.candidate.deleteMany({ where: { email: { startsWith: EMAIL } } });
  await db.inboundForm.deleteMany({ where: { slug: { startsWith: "zzhandover-" } } });
  await db.handoverLine.deleteMany({ where: { toUserId: { in: ids } } });
  await db.handover.deleteMany({ where: { fromUserId: { in: ids } } });
  await db.notification.deleteMany({ where: { userId: { in: ids } } });
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.user.updateMany({ where: { managerId: { in: ids } }, data: { managerId: null } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.rolePermission.deleteMany({ where: { role: BARE_ROLE } });
  await db.role.deleteMany({ where: { key: BARE_ROLE } });
}

async function main() {
  await cleanup();

  const admin = await makeUser("Admin", "ADMIN");
  const leaver = await makeUser("Leaver", "SALES");
  const alice = await makeUser("Alice", "SALES");
  const bob = await makeUser("Bob", "SALES");
  const dormant = await makeUser("Dormant", "SALES", false);
  const report = await makeUser("Report", "SALES");
  await db.user.update({ where: { id: report.id }, data: { managerId: leaver.id } });

  actor = { id: admin.id, name: admin.name, email: admin.email, role: admin.role };

  // Six accounts owned by the leaver, so a two-way split is unambiguous at three each.
  const companies = [];
  for (let i = 1; i <= 6; i++) {
    companies.push(
      await db.company.create({
        data: {
          name: `${PREFIX} Account ${i}`,
          normalizedName: `${PREFIX.toLowerCase()} account ${i}`,
          // Created by the leaver on purpose: this is the field a naive sweep would rewrite.
          createdById: leaver.id,
          ownerUserId: leaver.id,
        },
      }),
    );
  }

  const ticket = await db.ticket.create({
    data: {
      title: `${PREFIX} Printer down`,
      companyId: companies[0]!.id,
      createdByUserId: leaver.id,
      assignedToUserId: leaver.id,
      status: "OPEN",
    },
  });
  const closedTicket = await db.ticket.create({
    data: {
      title: `${PREFIX} Old and closed`,
      companyId: companies[0]!.id,
      createdByUserId: leaver.id,
      assignedToUserId: leaver.id,
      status: "CLOSED",
    },
  });
  const lead = await db.lead.create({
    data: { title: `${PREFIX} Renewal`, companyId: companies[1]!.id, ownerUserId: leaver.id, status: "QUALIFIED" },
  });
  const wonLead = await db.lead.create({
    data: { title: `${PREFIX} Already won`, companyId: companies[1]!.id, ownerUserId: leaver.id, status: "WON" },
  });
  const task = await db.task.create({
    data: { title: `${PREFIX} Call them back`, createdByUserId: leaver.id, assignedToUserId: leaver.id },
  });
  const asset = await db.asset.create({
    data: { assetTag: `${PREFIX}-LAP-1`, name: `${PREFIX} Laptop`, createdById: admin.id, custodianUserId: leaver.id, status: "ASSIGNED" },
  });

  section("What the leaver is holding");

  const inventory = await handover.handoverInventory(leaver.id);
  if (!inventory.ok) {
    ok("The inventory loads", false, inventory.error);
    return;
  }
  const count = (key: string) => inventory.data.areas.find((a) => a.key === key)?.count ?? -1;

  ok("Six accounts owned", count("accounts-owned") === 6, count("accounts-owned"));
  ok("  one open ticket, not the closed one", count("tickets") === 1, `${count("tickets")} of 2 tickets`);
  ok("  one open lead, not the won one", count("leads") === 1, `${count("leads")} of 2 leads`);
  ok("  one open task", count("tasks") === 1);
  ok("  one direct report", count("reports") === 1);
  ok("  one laptop", count("assets") === 1);
  ok(
    "Every area is listed, including the empty ones",
    inventory.data.areas.length >= 12 && inventory.data.areas.some((a) => a.count === 0),
    `${inventory.data.areas.length} areas — a hidden empty area can't be told from one nobody looked at`,
  );

  section("What it refuses before writing anything");

  const refusals: [string, Awaited<ReturnType<typeof handover.applyHandover>>][] = [
    [
      "the leaver as their own successor",
      await handover.applyHandover({
        fromUserId: leaver.id,
        routings: [{ key: "tickets", routing: { mode: "ONE", userId: leaver.id } }],
      }),
    ],
    [
      "a deactivated successor",
      await handover.applyHandover({
        fromUserId: leaver.id,
        routings: [{ key: "tickets", routing: { mode: "ONE", userId: dormant.id } }],
      }),
    ],
    [
      "splitting something that can't be split",
      await handover.applyHandover({
        fromUserId: leaver.id,
        routings: [{ key: "assets", routing: { mode: "SPLIT", userIds: [alice.id, bob.id], method: "ROUND_ROBIN" } }],
      }),
    ],
    [
      "a split with only one person in it",
      await handover.applyHandover({
        fromUserId: leaver.id,
        routings: [{ key: "leads", routing: { mode: "SPLIT", userIds: [alice.id], method: "ROUND_ROBIN" } }],
      }),
    ],
    [
      "an area that does not exist",
      await handover.applyHandover({ fromUserId: leaver.id, routings: [{ key: "payslips", routing: { mode: "ONE", userId: alice.id } }] }),
    ],
    [
      "a plan that moves nothing",
      await handover.applyHandover({ fromUserId: leaver.id, routings: [{ key: "tickets", routing: { mode: "KEEP" } }] }),
    ],
  ];
  for (const [label, result] of refusals) {
    ok(`Refuses ${label}`, !result.ok, result.ok ? "it went through" : result.error);
  }
  ok(
    "  and a refusal writes nothing",
    (await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).assignedToUserId === leaver.id,
    "validation runs over the whole plan before the transaction opens",
  );

  section("The handover itself");

  const applied = await handover.applyHandover({
    fromUserId: leaver.id,
    reason: "Resigned",
    routings: [
      // All three routings in one plan, which is the point of the feature.
      { key: "accounts-owned", routing: { mode: "SPLIT", userIds: [alice.id, bob.id], method: "ROUND_ROBIN" } },
      { key: "tickets", routing: { mode: "ONE", userId: bob.id } },
      { key: "leads", routing: { mode: "ONE", userId: alice.id } },
      { key: "reports", routing: { mode: "ONE", userId: alice.id } },
      { key: "assets", routing: { mode: "ONE", userId: bob.id } },
      { key: "tasks", routing: { mode: "KEEP" } },
    ],
  });
  ok("It applies", applied.ok, applied.ok ? `${applied.data.total} items moved` : applied.error);
  if (!applied.ok) return;

  const owners = await db.company.findMany({
    where: { id: { in: companies.map((c) => c.id) } },
    select: { ownerUserId: true, createdById: true },
  });
  const forAlice = owners.filter((c) => c.ownerUserId === alice.id).length;
  const forBob = owners.filter((c) => c.ownerUserId === bob.id).length;

  ok("Six accounts split evenly", forAlice === 3 && forBob === 3, `Alice ${forAlice}, Bob ${forBob}`);
  ok(
    "  and none was left behind",
    owners.every((c) => c.ownerUserId !== leaver.id),
    "a dropped record stays pointing at somebody who has left, and still looks owned",
  );
  ok(
    "The open ticket moved",
    (await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).assignedToUserId === bob.id,
  );
  ok(
    "  the closed one did not",
    (await db.ticket.findUniqueOrThrow({ where: { id: closedTicket.id } })).assignedToUserId === leaver.id,
    "who worked a closed ticket is a fact about what happened",
  );
  ok("The open lead moved", (await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).ownerUserId === alice.id);
  ok(
    "  the won one did not",
    (await db.lead.findUniqueOrThrow({ where: { id: wonLead.id } })).ownerUserId === leaver.id,
  );
  ok(
    "The direct report has a new manager",
    (await db.user.findUniqueOrThrow({ where: { id: report.id } })).managerId === alice.id,
    "otherwise their leave requests and expense claims submit into a void",
  );
  ok(
    "An area left as KEEP did not move",
    (await db.task.findUniqueOrThrow({ where: { id: task.id } })).assignedToUserId === leaver.id,
    "an unconfigured area must do nothing",
  );

  section("Custody is a claim about the physical world");

  const movedAsset = await db.asset.findUniqueOrThrow({ where: { id: asset.id } });
  const movement = await db.assetMovement.findFirst({ where: { assetId: asset.id }, orderBy: { occurredAt: "desc" } });
  ok("The laptop is on Bob's name", movedAsset.custodianUserId === bob.id);
  ok("  and it went through the movement ledger", movement !== null && movement.toUserId === bob.id);
  ok(
    "  which Bob still has to acknowledge",
    movement !== null && movement.acknowledgedAt === null,
    "the register otherwise states that he holds a laptop he has never seen",
  );

  section("What it must never touch");

  // The assertion the whole module is built around. Everything above could pass while this fails,
  // and nothing in the application would ever report it.
  ok(
    "Who created those accounts is unchanged",
    owners.every((c) => c.createdById === leaver.id),
    "history is a fact about what happened, not a statement about who is responsible now",
  );
  ok(
    "  who raised the ticket is unchanged",
    (await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).createdByUserId === leaver.id,
  );
  ok(
    "  and who created the task is unchanged",
    (await db.task.findUniqueOrThrow({ where: { id: task.id } })).createdByUserId === leaver.id,
  );
  ok(
    "No area can reach a personal or historical field",
    !inventory.data.areas.some((a) =>
      ["payslips", "attendance", "leave", "settlement", "incentives", "targets", "expenses"].some((banned) =>
        a.key.includes(banned),
      ),
    ),
    "the registry is a closed list — there is no path to those fields at all",
  );

  section("What the record says happened");

  const leaverHistory = await handover.handoverHistory(leaver.id);
  ok("The leaver's record shows it", leaverHistory.length === 1, `${leaverHistory.length} entries`);
  ok("  in the giving direction", leaverHistory[0]?.direction === "given", leaverHistory[0]?.direction);
  ok("  with the reason kept", leaverHistory[0]?.reason === "Resigned", leaverHistory[0]?.reason ?? "(none)");
  ok("  and who ran it", leaverHistory[0]?.performedByName === admin.name, leaverHistory[0]?.performedByName);
  ok(
    "  the totals agree with what moved",
    leaverHistory[0]?.total === applied.data.total,
    `record says ${leaverHistory[0]?.total}, the action moved ${applied.data.total}`,
  );
  ok(
    "  and the split names both people",
    ["ZZHandover Alice", "ZZHandover Bob"].every((n) =>
      leaverHistory[0]!.lines.some((l) => l.areaLabel === "Accounts they own" && l.personName === n && l.count === 3),
    ),
    leaverHistory[0]!.lines.filter((l) => l.areaLabel === "Accounts they own").map((l) => `${l.personName} ${l.count}`).join(", "),
  );

  // The question that was unanswerable before this existed, and the one asked far more often.
  const aliceHistory = await handover.handoverHistory(alice.id);
  ok("Alice's record shows where her new accounts came from", aliceHistory.length === 1);
  ok("  in the receiving direction", aliceHistory[0]?.direction === "received", aliceHistory[0]?.direction);
  ok("  naming the leaver", aliceHistory[0]?.counterpartName === leaver.name, aliceHistory[0]?.counterpartName);
  ok(
    "  and counting only her share, not the whole handover",
    aliceHistory[0]?.total === 5,
    `${aliceHistory[0]?.total} of ${applied.data.total} — a shared split must not read as if she took the lot`,
  );
  ok(
    "  Bob's record is separate and his own",
    (await handover.handoverHistory(bob.id))[0]?.total === 5,
  );
  ok(
    "Somebody uninvolved has no history",
    (await handover.handoverHistory(dormant.id)).length === 0,
  );

  const stored = await db.handoverLine.findFirst({ where: { areaKey: "accounts-owned" } });
  ok(
    "The area's name is frozen on the line",
    stored?.areaLabel === "Accounts they own",
    "renaming an area later must not rewrite what March's handover says happened",
  );

  section("Everyone who received work was told");

  const told = await db.notification.findMany({
    where: { userId: { in: [alice.id, bob.id] } },
    select: { userId: true, title: true },
  });
  ok("Both successors were notified", new Set(told.map((n) => n.userId)).size === 2, `${told.length} notifications`);
  ok(
    "  and the leaver was not",
    (await db.notification.count({ where: { userId: leaver.id } })) === 0,
    "work appearing overnight with no explanation is how a handover becomes a fortnight of nothing",
  );

  const audit = await db.auditLog.findFirst({ where: { userId: admin.id, entityId: leaver.id } });
  ok("It is on the audit trail", audit !== null, audit?.entityLabel);

  section("A new manager is held to the reach of whoever hands people over (audit M-5 follow-up)");

  // Holds "Hand over someone's work" and nothing else: reaches no visits, where a salesperson reaches their team's.
  await db.role.create({ data: { key: BARE_ROLE, name: `${PREFIX} Bare`, isSystem: false } });
  const hr = await makeUser("Hr", BARE_ROLE);
  await db.userPermission.create({ data: { userId: hr.id, permission: "people.handover", allowed: true, reason: PREFIX } });
  const leaver2 = await makeUser("Leavertwo", "SALES");
  const report2 = await makeUser("Reporttwo", "SALES");
  await db.user.update({ where: { id: report2.id }, data: { managerId: leaver2.id } });
  const carol = await makeUser("Carol", "SALES");
  const ticket2 = await db.ticket.create({
    data: { title: `${PREFIX} Second printer`, companyId: companies[2]!.id, createdByUserId: leaver2.id, assignedToUserId: leaver2.id, status: "OPEN" },
  });
  const plan2 = (to: string) =>
    handover.applyHandover({
      fromUserId: leaver2.id,
      routings: [
        { key: "tickets", routing: { mode: "ONE", userId: carol.id } },
        { key: "reports", routing: { mode: "ONE", userId: to } },
      ],
    });
  const managerOf = async (id: string) => (await db.user.findUniqueOrThrow({ where: { id } })).managerId;
  const ticketWith = async () => (await db.ticket.findUniqueOrThrow({ where: { id: ticket2.id } })).assignedToUserId;

  // A leaver who reached no visits either (the bare role, as HR's): their report under a salesperson is a new reach.
  const leaver3 = await makeUser("Leaverthree", BARE_ROLE);
  const report3 = await makeUser("Reportthree", BARE_ROLE);
  await db.user.update({ where: { id: report3.id }, data: { managerId: leaver3.id } });
  const ticket3 = await db.ticket.create({
    data: { title: `${PREFIX} Third printer`, companyId: companies[2]!.id, createdByUserId: leaver3.id, assignedToUserId: leaver3.id, status: "OPEN" },
  });
  const plan3 = (to: string) =>
    handover.applyHandover({
      fromUserId: leaver3.id,
      routings: [
        { key: "tickets", routing: { mode: "ONE", userId: carol.id } },
        { key: "reports", routing: { mode: "ONE", userId: to } },
      ],
    });
  const ticket3With = async () => (await db.ticket.findUniqueOrThrow({ where: { id: ticket3.id } })).assignedToUserId;

  actor = { id: hr.id, name: hr.name, email: hr.email, role: hr.role };
  const narrow = await plan3(carol.id);
  ok(
    "somebody reaching no visits can't put a report nobody saw by team under a salesperson",
    !narrow.ok && /by team, wider than you reach/.test(narrow.error),
    narrow.ok ? "it went through" : narrow.error,
  );
  ok("  the report still has their old manager", (await managerOf(report3.id)) === leaver3.id);
  ok("  and nothing else in the plan moved either — the ticket stays", (await ticket3With()) === leaver3.id, "refused before the transaction writes anything");
  ok("  and no handover was recorded", (await db.handover.count({ where: { fromUserId: leaver3.id } })) === 0);
  const toThemselves = await handover.applyHandover({ fromUserId: leaver3.id, routings: [{ key: "reports", routing: { mode: "ONE", userId: report3.id } }] });
  ok("  nor make somebody their own manager", !toThemselves.ok && /can't report to themselves/.test(toThemselves.error) && (await managerOf(report3.id)) === leaver3.id, toThemselves.ok ? "it went through" : toThemselves.error);

  // Succession (guards.ts `succeeding`): the salesperson leaving saw their report's visits by team, so the next
  // salesperson may too — whoever hands the team over, HR included.
  const succession = await plan2(carol.id);
  ok("but a salesperson's team passes to the next salesperson, from somebody reaching no visits — succession, not a new reach", succession.ok && (await managerOf(report2.id)) === carol.id && (await ticketWith()) === carol.id, succession.ok ? "" : succession.error);

  actor = { id: admin.id, name: admin.name, email: admin.email, role: admin.role };
  const intoOwn = await plan3(admin.id);
  ok(
    "an admin reaching everything still can't bring the report under themselves",
    !intoOwn.ok && /your own reporting line/.test(intoOwn.error),
    intoOwn.ok ? "it went through" : intoOwn.error,
  );
  ok("  the report still has their old manager, the ticket its old owner", (await managerOf(report3.id)) === leaver3.id && (await ticket3With()) === leaver3.id);
  const wide = await plan3(carol.id);
  ok("  but may put them under a salesperson", wide.ok && (await managerOf(report3.id)) === carol.id && (await ticket3With()) === carol.id, wide.ok ? "" : wide.error);

  section("Somebody else's handovers are for whoever may run one (audit L-2)");

  const nosy = await makeUser("Nosy", "SALES");
  actor = { id: nosy.id, name: nosy.name, email: nosy.email, role: nosy.role };
  const peeked = await handover.handoverHistory(leaver.id);
  ok("somebody without Hand over someone's work reads none of the leaver's", peeked.length === 0, `${peeked.length} entries`);
  actor = { id: leaver.id, name: leaver.name, email: leaver.email, role: leaver.role };
  ok("  the leaver still reads their own", (await handover.handoverHistory(leaver.id)).length === 1);
  actor = { id: hr.id, name: hr.name, email: hr.email, role: hr.role };
  ok("  and so does whoever holds it", (await handover.handoverHistory(leaver.id)).length === 1);
  actor = { id: admin.id, name: admin.name, email: admin.email, role: admin.role };

  console.log(failures === 0 ? "\nAll handover checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await db.$disconnect();
  });
