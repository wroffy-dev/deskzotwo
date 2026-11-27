/**
 * check:hr-extras — group insurance (src/actions/insurance.ts), learning (src/actions/learning.ts) and employee
 * referrals (src/actions/referrals.ts, with Hiring telling the referrer).
 *
 * The rules first, then a fixture of its own: a department of its own (so "everybody" means nobody real only where a
 * department is named — "everybody working" is never used here), an employee, their manager, HR, a recruiter.
 * Notifications are caught. Everything is named ZZPROBE_HX and removed in a finally.
 *
 *   npm run check:hr-extras
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
const TAG = "ZZPROBE_HX";
const MAIL = "@zzprobe-hx.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

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
  await db.insurancePolicy.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.course.deleteMany({ where: { title: { startsWith: TAG } } });
  await db.candidate.deleteMany({ where: { email: { endsWith: MAIL } } });
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
  await db.user.updateMany({ where: { id: { in: ids } }, data: { managerId: null } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.department.deleteMany({ where: { name: { startsWith: TAG } } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const rules = require("../src/lib/hr/insurance-rules") as typeof import("../src/lib/hr/insurance-rules");
  const insurance = require("../src/actions/insurance") as typeof import("../src/actions/insurance");
  const learning = require("../src/actions/learning") as typeof import("../src/actions/learning");
  const referrals = require("../src/actions/referrals") as typeof import("../src/actions/referrals");
  const candidates = require("../src/actions/candidate") as typeof import("../src/actions/candidate");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("The family on a cover");
  const fam = rules.dependentsOrRefusal([{ name: "  Priya   Rao ", relation: "SPOUSE", dateOfBirth: "1992-03-04" }, { name: "", relation: "CHILD" }, { name: "Arjun Rao", relation: "CHILD", dateOfBirth: null }], "2026-10-31");
  ok("names tidied, blank rows dropped", fam.ok && fam.dependents.length === 2 && fam.dependents[0]!.name === "Priya Rao", fam);
  ok("two spouses refused", !rules.dependentsOrRefusal([{ name: "A One", relation: "SPOUSE" }, { name: "B Two", relation: "SPOUSE" }], "2026-10-31").ok);
  ok("a birth date to come refused", !rules.dependentsOrRefusal([{ name: "A One", relation: "CHILD", dateOfBirth: "2027-01-01" }], "2026-10-31").ok);
  ok("an unknown relation refused", !rules.dependentsOrRefusal([{ name: "A One", relation: "COUSIN" }], "2026-10-31").ok);
  ok("a policy's state on a day", rules.policyState("2026-04-01", "2027-03-31", "2026-10-31") === "ACTIVE" && rules.policyState("2026-04-01", "2027-03-31", "2027-04-01") === "EXPIRED" && rules.policyState("2027-04-01", "2028-03-31", "2026-10-31") === "UPCOMING");

  await cleanup();
  try {
    section("The fixture");
    const dept = await db.department.create({ data: { name: `${TAG} Team` } });
    const make = (name: string, inDept = true) =>
      db.user.create({ data: { name: `${TAG} ${name}`, email: `${name.toLowerCase()}${MAIL}`, role: "SALES", passwordHash: "x".repeat(60), ...(inDept ? { departmentId: dept.id } : {}) } });
    const boss = await make("Boss");
    const emp = await make("Employee");
    const other = await make("Other", false);
    const hr = await make("Hr", false);
    const recruiter = await make("Recruiter", false);
    await db.user.update({ where: { id: emp.id }, data: { managerId: boss.id } });
    await db.userPermission.createMany({ data: [{ userId: hr.id, permission: "hr.manage", allowed: true, reason: TAG }, { userId: recruiter.id, permission: "hiring.manage", allowed: true, reason: TAG }] });
    const as = (u: { id: string; name: string; email: string }) => (actor = { id: u.id, name: u.name, email: u.email });
    ok("a department of two — employee and manager — somebody else, HR and a recruiter", true);

    section("Insurance");
    as(emp);
    ok("only HR records a policy", !(await insurance.savePolicy({ name: `${TAG} Health`, kind: "HEALTH", insurer: "Acme General", policyNumber: "P-1", validFrom: "2026-04-01", validTo: "2027-03-31" })).ok);
    as(hr);
    ok("a policy that ends before it starts is refused", !(await insurance.savePolicy({ name: `${TAG} Health`, kind: "HEALTH", insurer: "Acme General", policyNumber: "P-1", validFrom: "2026-04-01", validTo: "2026-03-31" })).ok);
    const pol = await insurance.savePolicy({ name: `${TAG} Health`, kind: "HEALTH", insurer: "Acme General", policyNumber: "P-1", sumInsured: 500000, validFrom: "2026-04-01", validTo: "2027-03-31", helpline: "1800 000 000" });
    const old = await insurance.savePolicy({ name: `${TAG} Old`, kind: "ACCIDENT", insurer: "Acme General", policyNumber: "P-0", validFrom: "2024-04-01", validTo: "2025-03-31" });
    ok("HR records a running policy and an ended one", pol.ok && old.ok);
    if (!pol.ok || !old.ok) throw new Error("no policy");
    const added = await insurance.addInsuranceMembers({ policyId: pol.data.id, userIds: [emp.id, boss.id] });
    ok("two people on it", added.ok && added.data.added === 2, added);
    ok("adding them again adds nobody", (await insurance.addInsuranceMembers({ policyId: pol.data.id, userIds: [emp.id] })).ok && (await db.insuranceMember.count({ where: { policyId: pol.data.id } })) === 2);
    await insurance.addInsuranceMembers({ policyId: old.data.id, userIds: [emp.id] });
    const empMember = await db.insuranceMember.findUniqueOrThrow({ where: { policyId_userId: { policyId: pol.data.id, userId: emp.id } } });
    ok("HR sets the member number", (await insurance.saveInsuranceMember({ id: empMember.id, memberNumber: "M-77" })).ok);

    as(emp);
    const page = await insurance.insurancePage();
    const mine = page.mine.find((c) => c.id === pol.data.id);
    ok("the employee sees their cover: number, ₹5 lakh, the helpline, in force", mine?.memberNumber === "M-77" && mine.cover === 500000 && mine.helpline === "1800 000 000" && mine.state === "ACTIVE", mine);
    ok("  and not the company's policy list", !page.hr && page.policies.length === 0);
    ok("they add their family", (await insurance.saveMyDependents({ memberId: empMember.id, dependents: [{ name: "Priya Rao", relation: "SPOUSE", dateOfBirth: "1992-03-04" }] })).ok);
    const oldMember = await db.insuranceMember.findUniqueOrThrow({ where: { policyId_userId: { policyId: old.data.id, userId: emp.id } } });
    ok("  but not on a policy that has ended", !(await insurance.saveMyDependents({ memberId: oldMember.id, dependents: [] })).ok);
    as(other);
    ok("nobody else changes their family", !(await insurance.saveMyDependents({ memberId: empMember.id, dependents: [] })).ok);
    as(hr);
    const hrView = (await insurance.insurancePage()).policies.find((p) => p.id === pol.data.id);
    ok("HR sees the members and the family", hrView?.members.length === 2 && hrView.members.find((m) => m.userId === emp.id)?.dependents[0]?.name === "Priya Rao");

    section("Learning");
    as(emp);
    ok("only HR adds a course", !(await learning.saveCourse({ title: `${TAG} POSH` })).ok);
    as(hr);
    ok("a link that isn't one is refused", !(await learning.saveCourse({ title: `${TAG} POSH`, link: "intranet/posh" })).ok);
    const course = await learning.saveCourse({ title: `${TAG} POSH`, link: "https://example.com/posh", durationMinutes: 45 });
    ok("HR adds a course", course.ok);
    if (!course.ok) throw new Error("no course");
    told.length = 0;
    const given = await learning.assignCourse({ courseId: course.data.id, departmentId: dept.id, dueOn: "2026-01-15" });
    ok("HR gives it to the department, due 15 Jan 2026", given.ok && given.data.assigned === 2, given);
    ok("  both are told", told.filter((t) => t.type === "COURSE_ASSIGNED").length === 2);
    ok("  giving it again adds nobody", (await learning.assignCourse({ courseId: course.data.id, userIds: [emp.id] })).ok && (await db.courseAssignment.count({ where: { courseId: course.data.id } })) === 2);
    as(boss);
    ok("a manager can't give it to somebody outside their team", !(await learning.assignCourse({ courseId: course.data.id, userIds: [other.id] })).ok);
    ok("  nor to a whole department", !(await learning.assignCourse({ courseId: course.data.id, departmentId: dept.id })).ok);
    const bossView = await learning.learningPage();
    const teamCourse = bossView.courses.find((c) => c.id === course.data.id);
    ok("the manager sees their team's course: their one report, overdue", bossView.manages && teamCourse?.assigned === 1 && teamCourse.overdue === 1, bossView.courses);
    as(emp);
    const myCourse = (await learning.learningPage()).mine.find((c) => c.courseId === course.data.id);
    ok("the employee sees it, overdue", !!myCourse && myCourse.overdue && !myCourse.completedAt);
    ok("they mark it done", (await learning.completeCourse({ assignmentId: myCourse!.assignmentId, note: "Know who to tell." })).ok);
    ok("  not twice", !(await learning.completeCourse({ assignmentId: myCourse!.assignmentId })).ok);
    as(other);
    ok("nobody else marks it for them", !(await learning.completeCourse({ assignmentId: myCourse!.assignmentId })).ok);
    as(hr);
    const learners = await learning.courseLearners(course.data.id);
    ok("HR sees who has it: one done with their note", learners?.length === 2 && learners.some((l) => l.completedAt && l.note === "Know who to tell."));

    section("Referrals");
    as(emp);
    ok("a referral needs a reason", !(await referrals.referCandidate({ name: "Kavya Iyer", email: `kavya${MAIL}`, note: "Good" })).ok);
    // Answered as a new referral is, and nothing kept (security audit SEC-66): who has a login or is applying isn't told.
    const colleague = await referrals.referCandidate({ name: "Boss Again", email: `boss${MAIL}`, note: "Worked with them for years." });
    ok("nobody who already has a login — nothing is added", colleague.ok && colleague.data.id === "" && (await db.candidate.count({ where: { email: `boss${MAIL}` } })) === 0, colleague);
    told.length = 0;
    const ref = await referrals.referCandidate({ name: "Kavya Iyer", email: `kavya${MAIL}`, designation: "Sales executive", note: "Sold for three years at a distributor I know." });
    ok("the employee refers somebody", ref.ok, ref);
    if (!ref.ok) throw new Error("no referral");
    ok("  the recruiter is told", told.some((t) => t.userId === recruiter.id && t.type === "REFERRAL_SUBMITTED"));
    const cand = await db.candidate.findUniqueOrThrow({ where: { id: ref.data.id }, select: { source: true, referredById: true, status: true } });
    ok("  a candidate in Hiring, via Referral, with who referred them", cand.source === "Referral" && cand.referredById === emp.id && cand.status === "PROSPECT");
    const twice = await referrals.referCandidate({ name: "Kavya Iyer", email: `KAVYA${MAIL}`, note: "Sold for three years at a distributor." });
    ok("the same person twice isn't added twice", twice.ok && twice.data.id === "" && (await db.candidate.count({ where: { email: { equals: `kavya${MAIL}`, mode: "insensitive" } } })) === 1, twice);
    as(recruiter);
    told.length = 0;
    ok("the recruiter offers them a role", (await candidates.setCandidateStatus(ref.data.id, "OFFERED")).ok);
    ok("  the referrer hears the step", told.some((t) => t.userId === emp.id && t.type === "REFERRAL_UPDATED" && t.title.includes("offered a role")), told);
    ok("  the candidate page names who referred them", (await candidates.getCandidate(ref.data.id))?.referredBy?.name === emp.name);
    as(emp);
    const list = await referrals.myReferrals();
    ok("the referrer's list shows them, offered", list.length === 1 && list[0]!.status === "OFFERED");

    section("The pages render");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const InsurancePage = require("../src/app/(dashboard)/people/insurance/page").default as () => Promise<unknown>;
    const LearningPage = require("../src/app/(dashboard)/people/learning/page").default as () => Promise<unknown>;
    const ReferralsPage = require("../src/app/(dashboard)/people/referrals/page").default as () => Promise<unknown>;
    /* eslint-enable @typescript-eslint/no-require-imports */
    const ins = await render(InsurancePage());
    ok("Insurance: their cover and family", ins.includes(`${TAG} Health`) && ins.includes("M-77") && ins.includes("Priya Rao"));
    const lrn = await render(LearningPage());
    ok("Learning: their course, done", lrn.includes(`${TAG} POSH`) && lrn.includes("Done"));
    const rfl = await render(ReferralsPage());
    ok("Referrals: the form and their referral", rfl.includes("Send the referral") && rfl.includes("Kavya Iyer") && rfl.includes("Offered a role"));
    as(hr);
    const hrIns = await render(InsurancePage());
    ok("HR's Insurance: the company's policies", hrIns.includes("Company policies") && hrIns.includes("Add everybody working"));
  } finally {
    actor = null;
    await cleanup();
    const left = (await db.user.count({ where: { email: { endsWith: MAIL } } })) + (await db.candidate.count({ where: { email: { endsWith: MAIL } } }));
    ok("nothing of the fixture is left behind", left === 0, left);
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nAll HR extras checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
