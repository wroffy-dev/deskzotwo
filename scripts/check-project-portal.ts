/**
 * check:project-portal — projects on the customer portal (owner, 16 Nov 2026 — projects phase 2; src/lib/projects/portal.ts,
 * src/actions/project-portal.ts, src/actions/portal-public.ts).
 *
 *   1. The team's side: a project shown or not, stages hidden, approved by the customer, with a link (http(s) only);
 *      asking for approval only for a stage that may be; sharing only this project's updates and documents.
 *   2. What the customer sees: only projects put on the portal, of their own company; hidden stages, internal updates
 *      and unshared documents never; a shared document downloadable, nobody else's.
 *   3. Approving: only a stage asked about, of their company; changes need a word; approved finishes the stage; the
 *      team is told and the log says so; a second click answers nothing.
 *   4. The screens, rendered.
 *
 * Own fixture tagged ZZPP, removed in a finally.
 *
 *   npm run check:project-portal
 */
import "dotenv/config";
import Module from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { directClient } from "../src/lib/tenancy/direct-client";
import { cleanStageLink } from "../src/lib/projects/portal";

type Actor = { id: string; role: string; name: string; email: string };
let actor: Actor | null = null;
let manage = true;

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
  if (request === "@/actions/permission" || request.endsWith("actions/permission")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, hasEffectivePermission: async (_u: string, k: string) => (k === "projects.manage" ? manage : true) };
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
const TAG = "ZZPP";

async function cleanup() {
  const companies = await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  await db.project.deleteMany({ where: { companyId: { in: companies.map((c) => c.id) } } });
  await db.company.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.notification.deleteMany({ where: { title: { contains: "PRJ-ZZPP" } } }).catch(() => {});
}

async function main() {
  section("1. The team's side");
  ok("a stage link: https kept, a script refused, empty is none", cleanStageLink("https://staging.example.com/a") === "https://staging.example.com/a" && typeof cleanStageLink("javascript:alert(1)") === "object" && cleanStageLink("  ") === null);

  await cleanup();
  const admin = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true, active: true }, select: { id: true, role: true, name: true, email: true } });
  actor = admin;
  const staff = await import("../src/actions/project-portal");
  const lib = await import("../src/lib/projects/portal");
  const pub = await import("../src/actions/portal-public");

  try {
    const mine = await db.company.create({ data: { name: `${TAG} Customer`, normalizedName: `${TAG.toLowerCase()} customer`, relationshipType: "CLIENT", createdById: admin.id }, select: { id: true } });
    const theirs = await db.company.create({ data: { name: `${TAG} Other`, normalizedName: `${TAG.toLowerCase()} other`, relationshipType: "CLIENT", createdById: admin.id }, select: { id: true } });
    const make = (code: string, companyId: string) =>
      db.project.create({
        data: {
          code,
          name: `${TAG} ${code}`,
          companyId,
          createdById: admin.id,
          managerId: admin.id,
          stakeholders: { create: { userId: admin.id, role: "PROJECT_MANAGER" } },
          milestones: { create: [{ name: "Brief received", sortOrder: 0, completedAt: new Date() }, { name: "Raise PO with distributor", sortOrder: 1 }, { name: "Design approved", sortOrder: 2 }, { name: "Go live", sortOrder: 3 }] },
        },
        select: { id: true, milestones: { orderBy: { sortOrder: "asc" }, select: { id: true } } },
      });
    const project = await make("PRJ-ZZPP-1", mine.id);
    const hiddenProject = await make("PRJ-ZZPP-2", mine.id);
    const other = await make("PRJ-ZZPP-3", theirs.id);
    const [brief, po, design] = project.milestones.map((m) => m.id);

    manage = false;
    ok("only whoever manages projects puts one on the portal", !(await staff.setProjectOnPortal(project.id, true)).ok);
    manage = true;
    ok("  shown on the portal", (await staff.setProjectOnPortal(project.id, true)).ok && !!(await db.projectPortal.findUnique({ where: { projectId: project.id } })));
    await staff.setProjectOnPortal(other.id, true);
    ok("an internal stage hidden", (await staff.setStagePortal(po, { hidden: true })).ok);
    ok("  asking for approval before the stage is the customer's to approve is refused", !(await staff.askStageApproval(design, true)).ok);
    await staff.setStagePortal(design, { needsApproval: true });
    ok("  a link must be a web address", !(await staff.setStagePortal(design, { link: "javascript:alert(1)" })).ok && (await staff.setStagePortal(design, { link: "https://staging.zzpp.example" })).ok);
    ok("  asked for approval", (await staff.askStageApproval(design, true)).ok);
    ok("  a stage already done can't be asked about", !(await staff.askStageApproval(brief, true)).ok);
    await db.projectUpdate.create({ data: { projectId: project.id, body: "INTERNAL: distributor late on PO" } });
    ok("an update written for the customer is posted and shared", (await staff.postCustomerUpdate(project.id, "Designs are ready for you to look at.")).ok);
    const doc = await db.projectDocument.create({ data: { projectId: project.id, name: "Design v1.pdf", fileDataUrl: "data:application/pdf;base64,JVBERi0xLjQK", mimeType: "application/pdf", sizeBytes: 9 }, select: { id: true } });
    const secret = await db.projectDocument.create({ data: { projectId: project.id, name: "Internal costing.pdf", fileDataUrl: "data:application/pdf;base64,JVBERi0xLjQK", mimeType: "application/pdf", sizeBytes: 9 }, select: { id: true } });
    const otherDoc = await db.projectDocument.create({ data: { projectId: other.id, name: "Theirs.pdf", fileDataUrl: "data:application/pdf;base64,JVBERi0xLjQK", mimeType: "application/pdf", sizeBytes: 9 }, select: { id: true } });
    ok("a document shared", (await staff.shareWithCustomer({ projectId: project.id, documentId: doc.id, shared: true })).ok);
    ok("  another project's document can't be shared through this one", !(await staff.shareWithCustomer({ projectId: project.id, documentId: otherDoc.id, shared: true })).ok);
    await staff.shareWithCustomer({ projectId: other.id, documentId: otherDoc.id, shared: true });

    section("2. What the customer sees");
    const seen = await lib.portalProjectsFor(mine.id);
    const p = seen[0];
    ok("only the project put on the portal, of their own company", seen.length === 1 && p?.code === "PRJ-ZZPP-1", seen.map((s) => s.code));
    ok("  the hidden stage left out; done, waiting and the link shown", !!p && p.stages.length === 3 && !p.stages.some((s) => s.name.includes("PO")) && p.done === 1 && p.stages.find((s) => s.id === design)?.awaitingApproval === true && p.stages.find((s) => s.id === design)?.link === "https://staging.zzpp.example/", p?.stages);
    ok("  the shared update, never the internal one", !!p && p.updates.length === 1 && /Designs are ready/.test(p.updates[0].body) && !p.updates.some((u) => /INTERNAL/.test(u.body)));
    ok("  the shared document only", !!p && p.documents.length === 1 && p.documents[0].name === "Design v1.pdf");
    ok("a shared document can be downloaded; an unshared one, or another company's, can't", (await lib.portalProjectDocumentAllowed(mine.id, doc.id)) && !(await lib.portalProjectDocumentAllowed(mine.id, secret.id)) && !(await lib.portalProjectDocumentAllowed(mine.id, otherDoc.id)));
    await staff.setProjectOnPortal(project.id, false);
    ok("taken off the portal, the project is gone from it, and its documents with it", (await lib.portalProjectsFor(mine.id)).length === 0 && !(await lib.portalProjectDocumentAllowed(mine.id, doc.id)));
    await staff.setProjectOnPortal(project.id, true);
    ok("a made-up portal link sees nothing", (await pub.portalProjects("not-a-real-link-zzpp-123456")).length === 0 && !(await pub.portalProjectFileAllowed("not-a-real-link-zzpp-123456", doc.id)));
    void hiddenProject;

    section("3. Approving");
    const review = (milestoneId: string, decision: string, comment: string, companyId = mine.id) => lib.reviewStage({ companyId, milestoneId, decision, comment, byName: "Ravi Kumar", portalLoginId: null });
    ok("another company can't answer for this stage", !(await review(design, "APPROVED", "", theirs.id)).ok);
    ok("  a stage nobody asked about can't be answered", !(await review(brief, "APPROVED", "")).ok);
    ok("  asking for changes needs a word on what", !(await review(design, "CHANGES", "  ")).ok);
    const changes = await review(design, "CHANGES", "Make the logo bigger.");
    const afterChanges = await db.projectPortalStage.findUniqueOrThrow({ where: { milestoneId: design }, select: { approvalRequestedAt: true } });
    const log1 = await db.projectUpdate.findFirst({ where: { projectId: project.id, body: { contains: "asked for changes" } }, select: { body: true } });
    ok("changes asked: the request answered, the stage not done, the log says what", changes.ok && afterChanges.approvalRequestedAt === null && !!log1 && /logo bigger/.test(log1.body), { changes, log: log1?.body });
    const told = await db.notification.findFirst({ where: { userId: admin.id, title: { contains: "PRJ-ZZPP-1" } }, orderBy: { createdAt: "desc" }, select: { title: true, link: true } });
    ok("  the team is told, linked to the portal tab", !!told && /asked for changes/.test(told.title) && told.link === `/projects/${project.id}?tab=portal`, told);
    ok("  and it can't be answered again until asked again", !(await review(design, "APPROVED", "")).ok);
    await staff.askStageApproval(design, true);
    const approved = await review(design, "APPROVED", "");
    const finished = await db.projectMilestone.findUniqueOrThrow({ where: { id: design }, select: { completedAt: true } });
    ok("approved: the stage is done", approved.ok && !!finished.completedAt, approved);
    ok("  a second click answers nothing", !(await review(design, "APPROVED", "")).ok);
    ok("  both answers kept", (await db.projectStageReview.count({ where: { milestoneId: design } })) === 2);

    section("4. The screens, rendered");
    const { PortalProjects } = await import("../src/components/portal/portal-projects");
    await staff.setStagePortal(project.milestones[3].id, { needsApproval: true });
    await staff.askStageApproval(project.milestones[3].id, true);
    const portalHtml = renderToStaticMarkup(createElement(PortalProjects, { token: "t", projects: await lib.portalProjectsFor(mine.id) }));
    ok("the portal: Your projects, the stages, Approve and Request changes, the shared document", /Your projects/.test(portalHtml) && /Go live/.test(portalHtml) && /Approve/.test(portalHtml) && /Request changes/.test(portalHtml) && /Design v1\.pdf/.test(portalHtml) && !/INTERNAL/.test(portalHtml) && !/Raise PO/.test(portalHtml));
    const { ProjectPortalTab } = await import("../src/components/projects/project-portal-tab");
    const state = await staff.projectPortalState(project.id);
    const tabHtml = state ? renderToStaticMarkup(createElement(ProjectPortalTab, { projectId: project.id, state })) : "";
    ok("the team's tab: on the portal, each stage with its ticks, updates and documents to share", /Shown on the customer portal/.test(tabHtml) && /Show to customer/.test(tabHtml) && /Customer approves/.test(tabHtml) && /Waiting for the customer/.test(tabHtml) && /Approved by Ravi Kumar/.test(tabHtml) && /Internal costing\.pdf/.test(tabHtml));
  } finally {
    await cleanup();
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
