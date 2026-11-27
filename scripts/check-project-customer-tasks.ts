/**
 * check:project-customer-tasks — projects phase 3 (owner, 16 Nov 2026): a stage that is the customer's to do, and the
 * customer emailed when a stage they can see changes (src/lib/projects/portal.ts, src/lib/projects/portal-mail.ts).
 *
 *   1. The customer's to do: never also an approval; the customer marks it done on the portal (their company's only),
 *      once; the team told, the log says so with their note; "Waiting on customer" counts it.
 *   2. Emails: to the customer's people with a working portal link, each with their own link, once per address; a stage
 *      done, an approval asked for, a to do set; never for a hidden stage, a project off the portal, with the switch
 *      off; the email log without the link; no mail server — the project's log says so.
 *   3. Settings › Customer emails: the row and its switch.
 *   4. The screens, rendered.
 *
 * Nothing leaves the machine: delivery is stubbed. Own fixture tagged ZZPT, removed in a finally.
 *
 *   npm run check:project-customer-tasks
 */
import "dotenv/config";
import Module from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { directClient } from "../src/lib/tenancy/direct-client";

type Actor = { id: string; role: string; name: string; email: string };
let actor: Actor | null = null;
type Sent = { to: string; subject: string; text: string; replyTo?: string };
const sent: Sent[] = [];
let route = true;

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/navigation") return { useRouter: () => ({ refresh() {}, push() {} }), notFound: () => { throw new Error("NOT_FOUND"); } };
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/lib/modules-access" || request.endsWith("lib/modules-access")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, requireModuleUser: async () => actor, requireModuleAccess: async () => actor, moduleAvailableForTenant: async () => true };
  }
  if (request === "@/lib/tenancy/resolve" || request.endsWith("lib/tenancy/resolve")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, tenantOrigin: async () => "https://zzpt.example" };
  }
  if (request === "@/lib/marketing/pipeline" || request.endsWith("lib/marketing/pipeline")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return {
      ...real,
      emailRouteFor: async () => (route ? { label: "Test SMTP", fromEmail: "projects@zzpt.example" } : null),
      deliverNow: async (m: { to: string; subject: string; text: string; replyTo?: string }) => {
        sent.push({ to: m.to, subject: m.subject, text: m.text, replyTo: m.replyTo });
        return { ok: true, provider: "Test SMTP", fromEmail: "projects@zzpt.example" };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const TAG = "ZZPT";

async function cleanup() {
  const companies = await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = companies.map((c) => c.id);
  await db.marketingMessage.deleteMany({ where: { companyId: { in: ids } } });
  await db.portalLogin.deleteMany({ where: { companyId: { in: ids } } });
  await db.project.deleteMany({ where: { companyId: { in: ids } } });
  await db.company.deleteMany({ where: { id: { in: ids } } });
  await db.notification.deleteMany({ where: { title: { contains: "PRJ-ZZPT" } } }).catch(() => {});
}

async function main() {
  await cleanup();
  const admin = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true, active: true }, select: { id: true, role: true, name: true, email: true } });
  actor = admin;
  const before = await db.customerEmailSettings.findUnique({ where: { id: "global" }, select: { projectStageEmails: true } });
  const staff = await import("../src/actions/project-portal");
  const plan = await import("../src/actions/project");
  const lib = await import("../src/lib/projects/portal");
  const settings = await import("../src/actions/customer-emails");
  const { newLinkToken } = await import("../src/lib/portal/link-token");

  try {
    const company = await db.company.create({ data: { name: `${TAG} Customer`, normalizedName: `${TAG.toLowerCase()} customer`, relationshipType: "CLIENT", createdById: admin.id }, select: { id: true } });
    const other = await db.company.create({ data: { name: `${TAG} Other`, normalizedName: `${TAG.toLowerCase()} other`, relationshipType: "CLIENT", createdById: admin.id }, select: { id: true } });
    const link = async (personName: string, personEmail: string | null, extra: object = {}) => {
      const made = await newLinkToken(24);
      await db.portalLogin.create({ data: { companyId: company.id, personName, personEmail, expiresAt: new Date(Date.now() + 86_400_000), ...made.stored, ...extra } });
      return made.token;
    };
    const raviToken = await link("Ravi Kumar", "ravi@zzpt.invalid");
    await link("Ravi again", "RAVI@zzpt.invalid"); // the same address, an older link — one email
    await link("Gone", "gone@zzpt.invalid", { revokedAt: new Date() });
    await link("Lapsed", "lapsed@zzpt.invalid", { expiresAt: new Date(Date.now() - 1000) });
    await link("No address", null);
    const project = await db.project.create({
      data: {
        code: "PRJ-ZZPT-1",
        name: `${TAG} Microsoft 365 move`,
        companyId: company.id,
        createdById: admin.id,
        managerId: admin.id,
        stakeholders: { create: { userId: admin.id, role: "PROJECT_MANAGER" } },
        milestones: { create: [{ name: "Add the DNS record", sortOrder: 0 }, { name: "Approve the switch-over date", sortOrder: 1 }, { name: "Test move", sortOrder: 2 }, { name: "Internal check", sortOrder: 3 }] },
      },
      select: { id: true, milestones: { orderBy: { sortOrder: "asc" }, select: { id: true } } },
    });
    const [dns, approve, testMove, internal] = project.milestones.map((m) => m.id);
    await staff.setProjectOnPortal(project.id, true);
    await settings.setCustomerEmailSwitch({ kind: "projectStages", on: true });

    section("1. The customer's to do");
    sent.length = 0;
    ok("a stage made the customer's to do", (await staff.setStagePortal(dns, { customerTask: true })).ok);
    ok("  they're emailed once per address, never a revoked or lapsed link, with their own portal link", sent.length === 1 && sent[0].to.toLowerCase() === "ravi@zzpt.invalid" && sent[0].text.includes(`https://zzpt.example/portal/`) && /waiting for you/.test(sent[0].subject), sent.map((s) => s.to));
    const logged = await db.marketingMessage.findFirst({ where: { companyId: company.id }, orderBy: { createdAt: "desc" }, select: { textBody: true } });
    ok("  the email log doesn't hold the link", !!logged && !(logged.textBody ?? "").includes("/portal/") && /their portal link/.test(logged.textBody ?? ""));
    ok("  replies go to the project's manager", sent[0]?.replyTo === admin.email);
    await staff.setStagePortal(dns, { needsApproval: true });
    let st = await db.projectPortalStage.findUniqueOrThrow({ where: { milestoneId: dns }, select: { needsApproval: true, customerTask: true } });
    ok("a stage is approved by them or done by them, never both", st.needsApproval && !st.customerTask, st);
    sent.length = 0;
    await staff.setStagePortal(dns, { customerTask: true });
    st = await db.projectPortalStage.findUniqueOrThrow({ where: { milestoneId: dns }, select: { needsApproval: true, customerTask: true } });
    ok("  and back again", !st.needsApproval && st.customerTask && sent.length === 1, st);
    ok("\"Waiting on customer\" counts it", (await lib.waitingOnCustomer(project.id)) === 1);
    const seen = (await lib.portalProjectsFor(company.id))[0];
    ok("on the portal it is theirs to do", seen?.stages.find((s) => s.id === dns)?.yourTodo === true);
    ok("another company can't mark it done", !(await lib.completeCustomerTask({ companyId: other.id, milestoneId: dns, note: "", byName: "X", portalLoginId: null })).ok);
    ok("  nor a stage that isn't theirs", !(await lib.completeCustomerTask({ companyId: company.id, milestoneId: testMove, note: "", byName: "Ravi", portalLoginId: null })).ok);
    const doneIt = await lib.completeCustomerTask({ companyId: company.id, milestoneId: dns, note: "TXT record added at GoDaddy.", byName: "Ravi Kumar", portalLoginId: null });
    const m = await db.projectMilestone.findUniqueOrThrow({ where: { id: dns }, select: { completedAt: true } });
    const logLine = await db.projectUpdate.findFirst({ where: { projectId: project.id, body: { contains: "marked" } }, select: { body: true } });
    ok("marked done: the stage is done, the log says so with their note", doneIt.ok && !!m.completedAt && /GoDaddy/.test(logLine?.body ?? ""), logLine?.body);
    const told = await db.notification.findFirst({ where: { userId: admin.id, title: { contains: "the customer did" } }, select: { link: true } });
    ok("  the team is told", told?.link === `/projects/${project.id}?tab=portal`);
    ok("  a second click does nothing", !(await lib.completeCustomerTask({ companyId: company.id, milestoneId: dns, note: "", byName: "Ravi", portalLoginId: null })).ok);
    ok("  and nothing waits on them now", (await lib.waitingOnCustomer(project.id)) === 0);

    section("2. Emails");
    sent.length = 0;
    await staff.setStagePortal(approve, { needsApproval: true });
    await staff.askStageApproval(approve, true);
    ok("asked to approve a stage: emailed", sent.length === 1 && /please approve/.test(sent[0].subject), sent.map((s) => s.subject));
    ok("  and it waits on them", (await lib.waitingOnCustomer(project.id)) === 1);
    sent.length = 0;
    await plan.setMilestoneDone(testMove, true);
    ok("a stage the team marks done: emailed", sent.length === 1 && /is done/.test(sent[0].subject), sent.map((s) => s.subject));
    sent.length = 0;
    await plan.setMilestoneDone(testMove, true);
    ok("  ticked again while done: not emailed twice", sent.length === 0);
    await staff.setStagePortal(internal, { hidden: true });
    sent.length = 0;
    await plan.setMilestoneDone(internal, true);
    ok("a hidden stage never emails", sent.length === 0);
    await settings.setCustomerEmailSwitch({ kind: "projectStages", on: false });
    await plan.setMilestoneDone(testMove, false);
    sent.length = 0;
    await plan.setMilestoneDone(testMove, true);
    ok("with the switch off, nothing is emailed", sent.length === 0);
    await settings.setCustomerEmailSwitch({ kind: "projectStages", on: true });
    await staff.setProjectOnPortal(project.id, false);
    await plan.setMilestoneDone(testMove, false);
    sent.length = 0;
    await plan.setMilestoneDone(testMove, true);
    ok("a project off the portal emails nothing", sent.length === 0);
    await staff.setProjectOnPortal(project.id, true);
    route = false;
    await plan.setMilestoneDone(testMove, false);
    await plan.setMilestoneDone(testMove, true);
    route = true;
    const noRoute = await db.projectUpdate.findFirst({ where: { projectId: project.id, body: { contains: "wasn't emailed" } }, select: { body: true } });
    ok("no mail server: nothing goes, and the project's log says why", /no mail server/.test(noRoute?.body ?? ""), noRoute?.body);
    void raviToken;

    section("3. Settings › Customer emails");
    const overview = await settings.getCustomerEmails();
    const row = overview.ok ? overview.data.rows.find((r) => r.key === "project-stages") : null;
    ok("the page lists project stage updates with its switch", !!row && row.toggle?.kind === "projectStages" && row.toggle.on === true, row);

    section("4. The screens, rendered");
    await db.projectPortalStage.update({ where: { milestoneId: dns }, data: { customerTask: true } });
    await db.projectMilestone.update({ where: { id: dns }, data: { completedAt: null } });
    const { PortalProjects } = await import("../src/components/portal/portal-projects");
    const portalHtml = renderToStaticMarkup(createElement(PortalProjects, { token: "t", projects: await lib.portalProjectsFor(company.id) }));
    ok("the portal: Waiting for you, the to do with Mark as done", /Waiting for you/.test(portalHtml) && /Yours to do/.test(portalHtml) && /Mark as done/.test(portalHtml) && /Approve/.test(portalHtml));
    const { ProjectPortalTab } = await import("../src/components/projects/project-portal-tab");
    const state = await staff.projectPortalState(project.id);
    const tabHtml = state ? renderToStaticMarkup(createElement(ProjectPortalTab, { projectId: project.id, state })) : "";
    ok("the team's tab: the Customer's to do tick and badge", /Customer&#x27;s to do|Customer's to do/.test(tabHtml) && /Waiting for the customer/.test(tabHtml));
  } finally {
    await cleanup();
    if (before) await db.customerEmailSettings.update({ where: { id: "global" }, data: { projectStageEmails: before.projectStageEmails } });
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  await db.$disconnect();
  if (failures) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
