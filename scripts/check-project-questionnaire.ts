/**
 * check:project-questionnaire — a project's questionnaire, end to end (owner, 16 Nov 2026: "start phase 1 with starter
 * examples"; src/lib/projects/questionnaire*.ts, src/actions/project-questionnaire.ts, src/actions/questionnaire-public.ts).
 *
 *   1. The questions: refused with a reason on save, read tolerantly, answers checked against what was asked.
 *   2. Project types: started from an example (stages and questions), the questionnaire saved by whoever manages types.
 *   3. Sending: an email with a personal link; the log never holds the link; a reminder makes a new link and the old
 *      one stops working; nothing goes for a project with no questions or to somebody at another company.
 *   4. The customer: opens it, saves halfway, attaches files (checked, five at most), can't send it back until the
 *      required ones are answered, then can't change it; the project moves to Discovery and its people are told.
 *   5. Reopened with the answers to change; withdrawn, the link stops working; somebody not on the project sees nothing.
 *
 * Nothing leaves the machine: the mailbox is stubbed. Own fixture tagged ZZPQ, removed in a finally.
 *
 *   npm run check:project-questionnaire
 */
import "dotenv/config";
import Module from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { directClient } from "../src/lib/tenancy/direct-client";
import { checkAnswers, checkQuestionsForSave, parseQuestions } from "../src/lib/projects/questionnaire";

type Mail = { userId: string; subject: string; html: string; to: { name: string; email: string }[] };
const mails: Mail[] = [];
type Actor = { id: string; role: string; name: string; email: string };
let actor: Actor | null = null;
let manage = true;
let outsider = false;

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/navigation") return { useRouter: () => ({ refresh() {}, push() {} }), notFound: () => { throw new Error("NOT_FOUND"); } };
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/headers") return { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) };
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
  if (request === "@/lib/authz/access" || request.endsWith("lib/authz/access")) {
    const real = originalLoad.call(this, request, parent, isMain) as { projectAccess: (u: string, l: string) => Promise<object> };
    return { ...real, projectAccess: async (u: string, l: string) => (outsider ? { id: "nobody-zzpq" } : real.projectAccess(u, l)) };
  }
  if (request === "@/lib/tenancy/resolve" || request.endsWith("lib/tenancy/resolve")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, tenantOrigin: async () => "https://zzpq.example" };
  }
  if (request === "@/lib/mail/mailbox" || request.endsWith("lib/mail/mailbox")) {
    return {
      mailboxState: async (userId: string) => ({ state: "connected", provider: "MICROSOFT", mailbox: `${userId}@zzpq.invalid` }),
      sendAsUser: async (userId: string, mail: Omit<Mail, "userId">) => {
        mails.push({ userId, ...mail });
        return { ok: true, mailbox: `${userId}@zzpq.invalid`, provider: "MICROSOFT" };
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
const TAG = "ZZPQ";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
const linkIn = (m?: Mail) => /\/q\/([A-Za-z0-9_-]{30,64})/.exec(m?.html ?? "")?.[1] ?? "";

async function cleanup() {
  const companies = await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const cids = companies.map((c) => c.id);
  await db.marketingMessage.deleteMany({ where: { companyId: { in: cids } } });
  await db.project.deleteMany({ where: { companyId: { in: cids } } });
  await db.contact.deleteMany({ where: { companyId: { in: cids } } });
  await db.company.deleteMany({ where: { id: { in: cids } } });
  await db.projectType.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.projectType.deleteMany({ where: { name: { startsWith: "Google Workspace → Microsoft 365 migration (" }, projects: { none: {} }, createdAt: { gte: new Date(Date.now() - 3600_000) } } });
  await db.notification.deleteMany({ where: { title: { contains: "PRJ-ZZPQ" } } }).catch(() => {});
}

async function main() {
  section("1. The questions");
  ok("a question with no wording is refused, saying which", (() => { const r = checkQuestionsForSave([{ label: "Users?", type: "NUMBER" }, { label: "", type: "TEXT" }]); return !r.ok && /Question 2/.test(r.error); })());
  ok("  a choice with fewer than two options is refused", !checkQuestionsForSave([{ label: "Edition", type: "SELECT", options: ["Only one"] }]).ok);
  const saved = checkQuestionsForSave([{ label: "How many users?", type: "NUMBER", required: true }, { label: "How many users?", type: "TEXT" }, { label: "Edition", type: "RADIO", options: "Starter\nPlus\nPlus" }]);
  ok("  keys made from the wording, unique; repeated options dropped", saved.ok && saved.questions[0].key === "how_many_users" && saved.questions[1].key === "how_many_users_2" && saved.questions[2].options.join() === "Starter,Plus", saved);
  ok("reading tolerates junk: a bad entry is left out, a choice with no options asked as text", (() => { const q = parseQuestions([null, { label: "x" }, { label: "Pick", type: "SELECT", options: [] }, { label: "Ok", type: "DATE" }]); return q.length === 2 && q[0].type === "TEXT" && q[1].type === "DATE"; })());
  const qs = saved.ok ? saved.questions : [];
  const a1 = checkAnswers(qs, { how_many_users: "40", how_many_users_2: "about forty", edition: "Plus", sneaky: "x" }, {}, true);
  ok("answers: only what was asked is kept", a1.ok && !("sneaky" in a1.answers) && a1.answers.edition === "Plus", a1);
  ok("  a required question missing stops a send, not a save", !checkAnswers(qs, {}, {}, true).ok && checkAnswers(qs, {}, {}, false).ok);
  ok("  an option not offered, a word for a number, are refused", (() => { const r = checkAnswers(qs, { how_many_users: "forty", edition: "Enterprise" }, {}, false); return !r.ok && !!r.errors.how_many_users && !!r.errors.edition; })());

  await cleanup();
  const admin = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true, active: true }, select: { id: true, role: true, name: true, email: true } });
  actor = admin;
  const staff = await import("../src/actions/project-questionnaire");
  const pub = await import("../src/actions/questionnaire-public");

  try {
    section("2. Project types");
    const made = await staff.createProjectTypeFromStarter("gws-to-m365");
    const type = made.ok ? await db.projectType.findUnique({ where: { id: made.data.id }, select: { name: true, questions: true, templateMilestones: { select: { name: true } } } }) : null;
    ok("an example becomes a project type with its stages and questions", made.ok && (type?.templateMilestones.length ?? 0) === 8 && parseQuestions(type?.questions).some((q) => q.key === "user_list" && q.type === "FILE"), { made, stages: type?.templateMilestones.length });
    if (made.ok) await db.projectType.update({ where: { id: made.data.id }, data: { name: `${TAG} migration` } });
    manage = false;
    ok("  only for whoever manages project types", !(await staff.createProjectTypeFromStarter("website")).ok);
    const typeId = made.ok ? made.data.id : "";
    ok("  and so are its questions", !(await staff.saveProjectTypeQuestions(typeId, [{ label: "x", type: "TEXT" }])).ok);
    manage = true;
    const own = await staff.saveProjectTypeQuestions(typeId, [
      { label: "About you", type: "HEADING" },
      { label: "How many users?", type: "NUMBER", required: true },
      { label: "Edition", type: "SELECT", options: ["Starter", "Plus"] },
      { label: "User list", type: "FILE", required: true },
    ]);
    ok("the admin's own questions are saved over the example's", own.ok && own.data.count === 4, own);
    const empty = await db.projectType.create({ data: { name: `${TAG} no questions` }, select: { id: true } });

    section("3. Sending");
    const company = await db.company.create({ data: { name: `${TAG} Customer`, normalizedName: `${TAG.toLowerCase()} customer`, relationshipType: "CLIENT", createdById: admin.id }, select: { id: true } });
    const other = await db.company.create({ data: { name: `${TAG} Elsewhere`, normalizedName: `${TAG.toLowerCase()} elsewhere`, relationshipType: "CLIENT", createdById: admin.id }, select: { id: true } });
    const ravi = await db.contact.create({ data: { companyId: company.id, name: "Ravi Kumar", email: "ravi@zzpq.invalid", isPrimary: true }, select: { id: true } });
    const stranger = await db.contact.create({ data: { companyId: other.id, name: "Someone Else", email: "else@zzpq.invalid" }, select: { id: true } });
    const project = await db.project.create({ data: { code: "PRJ-ZZPQ-1", name: `${TAG} move to Microsoft 365`, companyId: company.id, typeId, createdById: admin.id, managerId: admin.id, status: "PROPOSED", stakeholders: { create: { userId: admin.id, role: "PROJECT_MANAGER" } } }, select: { id: true } });
    const bare = await db.project.create({ data: { code: "PRJ-ZZPQ-2", name: `${TAG} bare`, companyId: company.id, typeId: empty.id, createdById: admin.id, managerId: admin.id }, select: { id: true } });

    ok("nothing goes for a project whose type has no questions", !(await staff.sendProjectQuestionnaire({ projectId: bare.id, contactId: ravi.id })).ok);
    ok("  nor to somebody at another company", !(await staff.sendProjectQuestionnaire({ projectId: project.id, contactId: stranger.id })).ok);
    mails.length = 0;
    const sent = await staff.sendProjectQuestionnaire({ projectId: project.id, contactId: ravi.id, note: "Hi — the questions we discussed." });
    const token1 = linkIn(mails[0]);
    ok("sent: an email to the contact with a personal link, the note in it", sent.ok && mails.length === 1 && mails[0].to[0].email === "ravi@zzpq.invalid" && !!token1 && /questions we discussed/.test(mails[0].html), { sent, to: mails[0]?.to });
    const logged = await db.marketingMessage.findFirst({ where: { companyId: company.id }, orderBy: { createdAt: "desc" }, select: { body: true, textBody: true } });
    ok("  the email log never holds the link", !!logged && !logged.body.includes(token1) && !(logged.textBody ?? "").includes(token1));
    ok("  the link opens the questions", (await pub.getQuestionnaire(token1))?.questions.length === 4);
    mails.length = 0;
    const again = await staff.sendProjectQuestionnaire({ projectId: project.id, contactId: ravi.id });
    const token = linkIn(mails[0]);
    ok("sent again: a reminder with a new link, and the old one stops working", again.ok && again.data.reminder && token !== token1 && (await pub.getQuestionnaire(token1)) === null && (await pub.getQuestionnaire(token)) !== null, again);
    ok("  a made-up link opens nothing", (await pub.getQuestionnaire("x".repeat(32))) === null);

    section("4. The customer");
    const round = await db.projectQuestionnaire.findFirstOrThrow({ where: { projectId: project.id }, select: { id: true, openedAt: true } });
    ok("opening it is noted", !!round.openedAt);
    const half = await pub.saveQuestionnaire(token, { how_many_users: "40" }, false);
    ok("saved halfway, without the required file", half.ok && !half.submitted, half);
    const early = await pub.saveQuestionnaire(token, { how_many_users: "40" }, true);
    ok("  can't be sent back until the required ones are answered", !early.ok && !!early.errors?.user_list, early);
    const fileForm = (name: string, bytes: Buffer, key = "user_list") => {
      const f = new FormData();
      f.set("token", token);
      f.set("key", key);
      f.set("file", new File([bytes], name));
      return f;
    };
    const bad = await pub.attachQuestionnaireFile(fileForm("users.exe", Buffer.from("MZ")));
    ok("a program can't be attached", !bad.ok, bad);
    ok("  nor a file that isn't what its name says", !(await pub.attachQuestionnaireFile(fileForm("users.pdf", Buffer.from("not a pdf")))).ok);
    ok("  nor a file on a question that isn't a file question", !(await pub.attachQuestionnaireFile(fileForm("users.pdf", PDF, "how_many_users"))).ok);
    const csv = await pub.attachQuestionnaireFile(fileForm("users.csv", Buffer.from("name,email\nRavi,ravi@x.com\n")));
    const pdf = await pub.attachQuestionnaireFile(fileForm("plan.pdf", PDF));
    const docs = await db.projectDocument.findMany({ where: { projectId: project.id }, select: { id: true, name: true, uploadedById: true } });
    ok("files attached become the project's documents", csv.ok && pdf.ok && docs.length === 2 && docs.every((d) => d.uploadedById === null), docs);
    const removed = pdf.ok ? await pub.removeQuestionnaireFile(token, "user_list", pdf.file.documentId) : null;
    ok("  one taken back off is gone from the documents too", removed?.ok === true && (await db.projectDocument.count({ where: { projectId: project.id } })) === 1, removed);
    const foreign = await db.projectDocument.create({ data: { projectId: bare.id, name: "theirs.pdf", fileDataUrl: "data:application/pdf;base64,JVBERi0=", mimeType: "application/pdf", sizeBytes: 5 }, select: { id: true } });
    ok("  a document that isn't on this questionnaire can't be removed through it", !(await pub.removeQuestionnaireFile(token, "user_list", foreign.id)).ok && (await db.projectDocument.count({ where: { id: foreign.id } })) === 1);
    const done = await pub.saveQuestionnaire(token, { how_many_users: "40", edition: "Plus" }, true);
    const after = await db.project.findUniqueOrThrow({ where: { id: project.id }, select: { status: true, updates: { select: { body: true } } } });
    ok("sent back: the project moves from Proposed to Discovery, with a line in its log", done.ok && done.submitted && after.status === "DISCOVERY" && after.updates.some((u) => /answered the questionnaire/.test(u.body)), { done, status: after.status });
    const told = await db.notification.findFirst({ where: { userId: admin.id, title: { contains: "PRJ-ZZPQ-1" } }, select: { link: true } });
    ok("  and the project's people are told, linked to the answers", told?.link === `/projects/${project.id}?tab=requirements`, told);
    ok("  once sent back it can't be changed", !(await pub.saveQuestionnaire(token, { how_many_users: "1" }, false)).ok && !(await pub.attachQuestionnaireFile(fileForm("more.pdf", PDF))).ok);
    ok("  and the link says thank you rather than nothing", (await pub.getQuestionnaire(token))?.submittedAt !== null);

    section("5. Reopened, withdrawn, and who may see");
    ok("sending again after an answer needs a reopen", !(await staff.sendProjectQuestionnaire({ projectId: project.id, contactId: ravi.id })).ok);
    mails.length = 0;
    const reopened = await staff.sendProjectQuestionnaire({ projectId: project.id, contactId: ravi.id, reopen: true });
    const token3 = linkIn(mails[0]);
    const page3 = await pub.getQuestionnaire(token3);
    ok("reopened: a second round, starting from the answers, files included", reopened.ok && reopened.data.round === 2 && page3?.answers.how_many_users === "40" && Array.isArray(page3?.answers.user_list), { reopened, answers: page3?.answers });
    const keptFile = Array.isArray(page3?.answers.user_list) ? (page3!.answers.user_list as { documentId: string }[])[0] : null;
    if (keptFile) await pub.removeQuestionnaireFile(token3, "user_list", keptFile.documentId);
    ok("  a file taken off the new round stays as the first round's record", !!keptFile && (await db.projectDocument.count({ where: { id: keptFile.documentId } })) === 1);
    const view = await staff.projectQuestionnaires(project.id);
    ok("the Requirements tab has both rounds, latest first, and who they went to", view?.rounds.length === 2 && view.rounds[0].round === 2 && view.rounds[1].contact === "Ravi Kumar" && view.rounds[1].answers.edition === "Plus", view?.rounds.map((r) => r.round));
    const open2 = await db.projectQuestionnaire.findFirstOrThrow({ where: { projectId: project.id, round: 2 }, select: { id: true } });
    const withdrawn = await staff.withdrawProjectQuestionnaire(open2.id);
    ok("withdrawn, its link stops working", withdrawn.ok && (await pub.getQuestionnaire(token3)) === null, withdrawn);
    outsider = true;
    ok("somebody not on the project sees nothing", (await staff.projectQuestionnaires(project.id)) === null);
    ok("  and can't send it", !(await staff.sendProjectQuestionnaire({ projectId: project.id, contactId: ravi.id })).ok);
    outsider = false;

    section("6. The screens, rendered");
    const { QuestionnaireForm } = await import("../src/components/projects/questionnaire-form");
    const formHtml = renderToStaticMarkup(createElement(QuestionnaireForm, { token: "t", page: { projectName: "Move to Microsoft 365", companyName: "Acme", ourName: "Wroffy", questions: parseQuestions([{ label: "About you", type: "HEADING" }, { label: "How many users?", type: "NUMBER", required: true }, { label: "Edition", type: "RADIO", options: ["Starter", "Plus"] }, { label: "User list", type: "FILE" }]), answers: { how_many_users: "40" }, submittedAt: null } }));
    ok("the customer's page: headings, questions, answers so far, a file picker, Send it back", /About you/.test(formHtml) && /value="40"/.test(formHtml) && /type="radio"/.test(formHtml) && /type="file"/.test(formHtml) && /Send it back/.test(formHtml) && /Save for later/.test(formHtml));
    const thanks = renderToStaticMarkup(createElement(QuestionnaireForm, { token: "t", page: { projectName: "P", companyName: "A", ourName: "", questions: [], answers: {}, submittedAt: new Date().toISOString() } }));
    ok("  once sent back, a thank-you", /we have your answers/.test(thanks));
    const { ProjectRequirements } = await import("../src/components/projects/project-requirements");
    const data = await staff.projectQuestionnaires(project.id);
    const reqHtml = data ? renderToStaticMarkup(createElement(ProjectRequirements, { data })) : "";
    ok("the Requirements tab: the send box, each round and its answers", /Reopen for changes|Send the questionnaire|Send it again/.test(reqHtml) && /Round 1/.test(reqHtml) && /How many users?/.test(reqHtml) && /users.csv/.test(reqHtml), reqHtml.slice(0, 200));
    const { QuestionnaireEditor } = await import("../src/components/settings/questionnaire-editor");
    const edHtml = renderToStaticMarkup(createElement(QuestionnaireEditor, { typeId: "x", questions: parseQuestions([{ label: "Edition", type: "SELECT", options: ["Starter", "Plus"] }]) }));
    ok("the questionnaire editor: each question with its kind, options and Required", /value="Edition"/.test(edHtml) && /File upload/.test(edHtml) && edHtml.includes("Starter") && edHtml.includes("Plus</textarea>") && /Required/.test(edHtml));
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
