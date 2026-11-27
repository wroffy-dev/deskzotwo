/**
 * check:reviews — goals and performance reviews (src/actions/reviews.ts, src/lib/hr/review-rules.ts).
 *
 * The scoring first, then a fixture of its own: a department of its own (so the cycle takes in nobody real), an
 * employee, their manager, the manager's manager, HR and an outsider. Notifications are caught rather than sent.
 * Everything is named ZZPROBE_RV and removed in a finally.
 *
 *   npm run check:reviews
 */
import "dotenv/config";
import Module from "node:module";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { directClient } from "../src/lib/tenancy/direct-client";

let actor: { id: string; name: string; email: string } | null = null;
const told: { userId: string; type: string; title: string }[] = [];
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => (actor ? { ...actor, role: "SALES" } : null);
    return { requireUser: async () => user(), currentUser: async () => user(), viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/lib/notify") return { notifyUser: async (n: { userId: string; type: string; title: string }) => void told.push(n) };
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new Error("notFound");
      },
      redirect: () => {
        throw new Error("redirect");
      },
      useRouter: () => ({ refresh() {}, push() {} }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_RV";
const MAIL = "@zzprobe-rv.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

/** Awaits the async components in a tree, so renderToStaticMarkup can render it (see scripts/check-item-import.ts). */
async function resolveAsync(node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveAsync));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: unknown }>;
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") {
    return resolveAsync(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
  }
  if (el.props && "children" in el.props) {
    const kids = await resolveAsync(el.props.children);
    return Array.isArray(kids) ? cloneElement(el, undefined, ...(kids as ReactNode[])) : cloneElement(el, undefined, kids as ReactNode);
  }
  return el;
}
const render = async (page: unknown) => renderToStaticMarkup((await resolveAsync(await page)) as ReactElement);

async function cleanup() {
  const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  await db.reviewCycle.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
  await db.user.updateMany({ where: { id: { in: ids } }, data: { managerId: null } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.department.deleteMany({ where: { name: { startsWith: TAG } } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const rules = require("../src/lib/hr/review-rules") as typeof import("../src/lib/hr/review-rules");
  const actions = require("../src/actions/reviews") as typeof import("../src/actions/reviews");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("Scoring");
  ok("weighted: 4 at 60% and 2 at 40% is 3.2", rules.goalScore([{ weight: 60, status: "ACTIVE", rating: 4 }, { weight: 40, status: "ACHIEVED", rating: 2 }]) === 3.2);
  ok("no weights: a plain average, 4 and 5 is 4.5", rules.goalScore([{ weight: 0, status: "ACTIVE", rating: 4 }, { weight: 0, status: "ACTIVE", rating: 5 }]) === 4.5);
  ok("dropped and unrated goals count for nothing", rules.goalScore([{ weight: 50, status: "DROPPED", rating: 1 }, { weight: 50, status: "ACTIVE", rating: 3 }, { weight: 20, status: "ACTIVE", rating: null }]) === 3);
  ok("nothing rated: no score", rules.goalScore([{ weight: 0, status: "ACTIVE", rating: null }]) === null);
  ok("weights of 60 and 30 noted; 100 and none not", rules.weightNote([{ weight: 60, status: "ACTIVE" }, { weight: 30, status: "ACTIVE" }]) !== null && rules.weightNote([{ weight: 60, status: "ACTIVE" }, { weight: 40, status: "ACTIVE" }, { weight: 10, status: "DROPPED" }]) === null && rules.weightNote([{ weight: 0, status: "ACTIVE" }]) === null);
  ok("a period ending before it starts, or over a year, is refused", !!rules.cycleProblem(d("2026-04-01"), d("2026-03-31"), null, null) && !!rules.cycleProblem(d("2026-04-01"), d("2027-06-01"), null, null) && rules.cycleProblem(d("2026-04-01"), d("2027-03-31"), null, null) === null);
  ok("ratings due before self-assessments is refused", !!rules.cycleProblem(d("2026-04-01"), d("2027-03-31"), d("2027-04-15"), d("2027-04-10")));

  await cleanup();
  try {
    section("The fixture");
    const dept = await db.department.create({ data: { name: `${TAG} Team` } });
    const make = (name: string, inDept = true) =>
      db.user.create({ data: { name: `${TAG} ${name}`, email: `${name.toLowerCase()}${MAIL}`, role: "SALES", passwordHash: "x".repeat(60), ...(inDept ? { departmentId: dept.id } : {}) } });
    const top = await make("Top");
    const boss = await make("Boss");
    const emp = await make("Employee");
    const hrPerson = await make("Hr", false);
    const outsider = await make("Outsider", false);
    await db.user.update({ where: { id: boss.id }, data: { managerId: top.id } });
    await db.user.update({ where: { id: emp.id }, data: { managerId: boss.id } });
    await db.userPermission.create({ data: { userId: hrPerson.id, permission: "hr.manage", allowed: true, reason: TAG } });
    const as = (u: { id: string; name: string; email: string }) => (actor = { id: u.id, name: u.name, email: u.email });
    ok("a department of three — employee, manager, the manager's manager — HR and an outsider", true);

    section("Starting a cycle");
    as(boss);
    const refused = await actions.createReviewCycle({ name: `${TAG} Annual`, periodStart: "2026-04-01", periodEnd: "2027-03-31", departmentId: dept.id });
    ok("a manager can't start one", !refused.ok);
    as(hrPerson);
    told.length = 0;
    const started = await actions.createReviewCycle({ name: `${TAG} Annual`, periodStart: "2026-04-01", periodEnd: "2027-03-31", selfDueOn: "2027-04-10", managerDueOn: "2027-04-20", departmentId: dept.id });
    ok("HR starts it for the department: three people", started.ok && started.data.people === 3, started);
    if (!started.ok) throw new Error("no cycle");
    const cycleId = started.data.id;
    ok("  each is told", told.filter((n) => n.type === "REVIEW_STARTED").length === 3);
    const review = await db.performanceReview.findUniqueOrThrow({ where: { cycleId_userId: { cycleId, userId: emp.id } } });
    ok("  the employee's reviewer is their manager", review.reviewerId === boss.id && review.status === "AWAITING_SELF");
    const again = await actions.addPeopleToCycle(cycleId, dept.id);
    ok("adding new joiners adds nobody twice", again.ok && again.data.added === 0, again);

    section("Who sees it");
    as(outsider);
    ok("an outsider: nothing", (await actions.getReview(review.id)) === null);
    as(top);
    ok("the manager's manager: may review", (await actions.getReview(review.id))?.can.review === true);
    as(emp);
    const mineView = await actions.getReview(review.id);
    ok("the employee: may set goals and self-assess, not review", !!mineView && mineView.can.editGoals && mineView.can.self && !mineView.can.review, mineView?.can);

    section("Goals");
    const g1 = await actions.saveGoal({ reviewId: review.id, title: "Close ₹50 lakh of new business", weight: 60, progress: 80 });
    as(boss);
    const g2 = await actions.saveGoal({ reviewId: review.id, title: "Renew every key account", weight: 30 });
    as(outsider);
    ok("an outsider can't add one", !(await actions.saveGoal({ reviewId: review.id, title: "Sneaky goal", weight: 10 })).ok);
    as(emp);
    ok("the employee and their manager each add one", g1.ok && g2.ok);
    ok("a weight over 100 is refused", !(await actions.saveGoal({ reviewId: review.id, title: "Too heavy", weight: 120 })).ok);
    ok("weights of 60 and 30 are noted", (await actions.getReview(review.id))?.weightNote === "The goals' weights come to 90%, not 100%.");
    const g3 = await actions.saveGoal({ reviewId: review.id, title: "Train two juniors", weight: 10 });
    ok("a third brings them to 100", g3.ok && (await actions.getReview(review.id))?.weightNote === null);
    if (!g1.ok || !g2.ok || !g3.ok) throw new Error("no goals");

    section("Self-assessment");
    ok("every goal must be rated", !(await actions.submitSelfAssessment({ reviewId: review.id, rating: 4, comments: "A good year.", goalRatings: { [g1.data.id]: 4 } })).ok);
    ok("a rating of 6 is refused", !(await actions.submitSelfAssessment({ reviewId: review.id, rating: 6, comments: "A good year.", goalRatings: { [g1.data.id]: 4, [g2.data.id]: 4, [g3.data.id]: 4 } })).ok);
    as(boss);
    const bossPeek = await actions.getReview(review.id);
    ok("before it's sent, the manager doesn't see the self-ratings", bossPeek?.self === null);
    as(emp);
    told.length = 0;
    const sent = await actions.submitSelfAssessment({ reviewId: review.id, rating: 4, comments: "A good year.", goalRatings: { [g1.data.id]: 5, [g2.data.id]: 3, [g3.data.id]: 4 } });
    ok("sent", sent.ok, sent);
    ok("  their reviewer is told", told.some((n) => n.userId === boss.id && n.type === "REVIEW_SELF_SUBMITTED"));
    const afterSelf = await actions.getReview(review.id);
    ok("  the employee can't change goals or send it again", !!afterSelf && !afterSelf.can.editGoals && !afterSelf.can.self);
    ok("  their goal score is 4.3 (5×60 + 3×30 + 4×10)", afterSelf?.selfScore === 4.3, afterSelf?.selfScore);
    ok("  nor see a reviewer's rating yet", afterSelf?.manager === null);

    section("The reviewer");
    as(emp);
    ok("nobody rates themselves", !(await actions.submitManagerReview({ reviewId: review.id, rating: 5, comments: "Me!", goalRatings: { [g1.data.id]: 5, [g2.data.id]: 5, [g3.data.id]: 5 } })).ok);
    as(boss);
    told.length = 0;
    const done = await actions.submitManagerReview({ reviewId: review.id, rating: 3, comments: "Solid, renewals slipped.", goalRatings: { [g1.data.id]: 4, [g2.data.id]: 2, [g3.data.id]: 3 } });
    ok("the manager completes it", done.ok, done);
    ok("  the employee is told", told.some((n) => n.userId === emp.id && n.type === "REVIEW_COMPLETED"));
    const row = await db.performanceReview.findUniqueOrThrow({ where: { id: review.id } });
    ok("  completed, rated 3, by the manager", row.status === "COMPLETED" && row.managerRating === 3 && row.reviewedById === boss.id);
    ok("  it can't be completed twice", !(await actions.submitManagerReview({ reviewId: review.id, rating: 4, comments: "Again", goalRatings: { [g1.data.id]: 4, [g2.data.id]: 4, [g3.data.id]: 4 } })).ok);
    as(emp);
    const finalView = await actions.getReview(review.id);
    ok("  the employee now sees it: 3, goals 3.3 (4×60 + 2×30 + 3×10)", finalView?.manager?.rating === 3 && finalView.managerScore === 3.3 && finalView.can.acknowledge, finalView?.managerScore);
    const ack = await actions.acknowledgeReview(review.id);
    ok("  and acknowledges it", ack.ok && !!(await db.performanceReview.findUniqueOrThrow({ where: { id: review.id } })).acknowledgedAt);

    section("Going ahead without a self-assessment");
    const bossReview = await db.performanceReview.findUniqueOrThrow({ where: { cycleId_userId: { cycleId, userId: boss.id } } });
    as(top);
    const noSelf = await actions.submitManagerReview({ reviewId: bossReview.id, rating: 4, comments: "Carried the team.", goalRatings: {} });
    ok("the manager's manager rates them with no goals and no self-assessment", noSelf.ok, noSelf);

    section("HR's view and closing");
    as(boss);
    ok("the cycle page is HR's only", (await actions.reviewCycle(cycleId)) === null);
    as(hrPerson);
    const cv = await actions.reviewCycle(cycleId);
    ok("HR sees three, two completed", cv?.rows.length === 3 && cv.cycle.completed === 2, cv?.cycle);
    const empRow = cv?.rows.find((r) => r.name.endsWith("Employee"));
    ok("  the employee's goal score 3.3, acknowledged", empRow?.goalScore === 3.3 && empRow.acknowledged, empRow);
    const closed = await actions.setReviewCycleStatus(cycleId, "CLOSED");
    ok("closed", closed.ok);
    const topReview = await db.performanceReview.findUniqueOrThrow({ where: { cycleId_userId: { cycleId, userId: top.id } } });
    as(top);
    ok("  nothing changes in a closed cycle", !(await actions.saveGoal({ reviewId: topReview.id, title: "Late goal" })).ok);
    as(hrPerson);
    ok("  HR may reopen it", (await actions.setReviewCycleStatus(cycleId, "OPEN")).ok);

    section("The pages render");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const HomePage = require("../src/app/(dashboard)/people/reviews/page").default as () => Promise<unknown>;
    const OnePage = require("../src/app/(dashboard)/people/reviews/[id]/page").default as (p: { params: Promise<{ id: string }> }) => Promise<unknown>;
    const CyclePage = require("../src/app/(dashboard)/people/reviews/cycles/[id]/page").default as (p: { params: Promise<{ id: string }> }) => Promise<unknown>;
    /* eslint-enable @typescript-eslint/no-require-imports */
    const home = await render(HomePage());
    ok("HR's page: the cycle and the button to start one", home.includes(`${TAG} Annual`) && home.includes("Start a review cycle"), home.slice(0, 200));
    const cyclePage = await render(CyclePage({ params: Promise.resolve({ id: cycleId }) }));
    ok("the cycle's page: everybody, and closing it", cyclePage.includes(`${TAG} Employee`) && cyclePage.includes("Close the cycle") && cyclePage.includes("Meets expectations"));
    as(emp);
    const one = await render(OnePage({ params: Promise.resolve({ id: review.id }) }));
    ok("the employee's review: goals, both verdicts", one.includes("Close ₹50 lakh of new business") && one.includes("Your self-assessment") && one.includes("Solid, renewals slipped.") && one.includes("read and acknowledged"));
    as(boss);
    const bossHome = await render(HomePage());
    ok("a manager's page: no cycles section", !bossHome.includes("Start a review cycle"));
    as(outsider);
    let refusedRender = "";
    try {
      await render(OnePage({ params: Promise.resolve({ id: review.id }) }));
    } catch (e) {
      refusedRender = (e as Error).message;
    }
    ok("an outsider's look at it: not found", refusedRender === "notFound", refusedRender);
  } finally {
    actor = null;
    await cleanup();
    const left = await db.user.count({ where: { email: { endsWith: MAIL } } });
    ok("nothing of the fixture is left behind", left === 0, left);
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nAll review checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
