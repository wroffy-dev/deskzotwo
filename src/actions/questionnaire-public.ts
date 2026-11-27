"use server";

import { headers } from "next/headers";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { callerKeyIp, clientIpFrom } from "@/lib/client-ip";
import { withinCallerBudget } from "@/lib/security/caller-budget";
import { tenantKey } from "@/lib/tenancy/cache";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { getOrganisation } from "@/lib/organisation";
import { toPlain } from "@/lib/serialize";
import { notMigratedYet } from "@/lib/not-migrated";
import { checkAnswers, parseAnswers, parseQuestions, type Answers, type FileAnswer, type Question } from "@/lib/projects/questionnaire";
import { addRoundFile, afterAnswered, checkQuestionnaireFile, removeRoundFile, roundForToken } from "@/lib/projects/questionnaire-server";

/**
 * The customer's side of a project questionnaire (owner, 16 Nov 2026): the page at /q/<token>, saving, attaching files
 * and sending it back. No account — the link is the authentication, for this one round of this one project, and grants
 * nothing else: not the project, not its documents, not another round. Every way a link can be wrong reads the same.
 */

const GONE = "This questionnaire isn't available any more. If you think it should be, reply to the email it came in.";
const BUSY = "That's a lot of changes at once — wait a minute and try again.";

/** So many requests from one caller in ten minutes — a script can't hammer a link. */
async function withinBudget(): Promise<boolean> {
  let ip: string | null = null;
  try {
    ip = clientIpFrom(await headers());
  } catch {
    ip = null;
  }
  if (!ip) return true;
  return withinCallerBudget([{ key: `${await tenantKey()}|questionnaire:${callerKeyIp(ip)}`, max: 200 }], 10 * 60_000);
}

async function open(token: unknown) {
  if (!(await moduleAvailableForTenant("projects"))) return null;
  try {
    return await roundForToken(token);
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

export type QuestionnairePage = {
  projectName: string;
  companyName: string;
  ourName: string;
  questions: Question[];
  answers: Answers;
  submittedAt: string | null;
};

/** What the page shows, or null for every link that doesn't open one. The first look is noted. */
export async function getQuestionnaire(token: string): Promise<QuestionnairePage | null> {
  const round = await open(token);
  if (!round || (round.closedAt && !round.submittedAt)) return null;
  if (!round.openedAt) await db.projectQuestionnaire.update({ where: { id: round.id }, data: { openedAt: new Date() } }).catch(() => null);
  const org = await getOrganisation();
  return toPlain({
    projectName: round.project.name,
    companyName: round.project.company.name,
    ourName: org.tradeName || org.legalName || "",
    questions: parseQuestions(round.questions),
    answers: parseAnswers(round.answers),
    submittedAt: round.submittedAt ? round.submittedAt.toISOString() : null,
  });
}

/** Saves what is filled in; `submit` sends it back, once every required question is answered. */
export async function saveQuestionnaire(token: string, raw: unknown, submit: boolean): Promise<{ ok: true; submitted: boolean } | { ok: false; error: string; errors?: Record<string, string> }> {
  if (!(await withinBudget())) return { ok: false, error: BUSY };
  const round = await open(token);
  if (!round || round.closedAt || round.submittedAt) return { ok: false, error: round?.submittedAt ? "You've sent this back already — thank you." : GONE };
  const questions = parseQuestions(round.questions);
  const checked = checkAnswers(questions, raw, parseAnswers(round.answers), submit === true);
  if (!checked.ok) return { ok: false, error: submit ? "A few answers need another look." : "A few answers need another look before they can be saved.", errors: checked.errors };
  const now = new Date();
  // Only while still open — a second tab sending at the same moment changes nothing twice.
  const { count } = await db.projectQuestionnaire.updateMany({
    where: { id: round.id, submittedAt: null, closedAt: null },
    data: { answers: checked.answers as Prisma.InputJsonValue, savedAt: now, ...(submit ? { submittedAt: now } : {}) },
  });
  if (count === 0) return { ok: false, error: GONE };
  if (submit) await afterAnswered({ id: round.id, projectId: round.projectId, contactId: round.contactId });
  return { ok: true, submitted: submit === true };
}

/** One file for one file question: `token`, `key` and `file` in the form. */
export async function attachQuestionnaireFile(form: FormData): Promise<{ ok: true; file: FileAnswer } | { ok: false; error: string }> {
  if (!(await withinBudget())) return { ok: false, error: BUSY };
  const round = await open(form.get("token"));
  if (!round || round.closedAt || round.submittedAt) return { ok: false, error: GONE };
  const key = String(form.get("key") ?? "");
  if (!parseQuestions(round.questions).some((q) => q.key === key && q.type === "FILE")) return { ok: false, error: "That question doesn't take a file." };
  const file = form.get("file");
  if (!(file instanceof File)) return { ok: false, error: "Choose a file." };
  const bytes = Buffer.from(await file.arrayBuffer());
  const checked = checkQuestionnaireFile(file.name, bytes);
  if (!checked.ok) return checked;
  const contact = round.contactId ? await db.contact.findUnique({ where: { id: round.contactId }, select: { name: true } }) : null;
  return toPlain(await addRoundFile(round.id, round.projectId, key, { name: checked.name, mime: checked.mime, bytes }, contact?.name ?? null));
}

export async function removeQuestionnaireFile(token: string, key: string, documentId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await withinBudget())) return { ok: false, error: BUSY };
  const round = await open(token);
  if (!round || round.closedAt || round.submittedAt) return { ok: false, error: GONE };
  return removeRoundFile(round.id, String(key ?? ""), String(documentId ?? ""));
}
