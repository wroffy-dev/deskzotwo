import { createHash, randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notifyUser } from "@/lib/notify";
import { getOrganisation } from "@/lib/organisation";
import { mailboxState, sendAsUser } from "@/lib/mail/mailbox";
import { deliverNow, emailRouteFor } from "@/lib/marketing/pipeline";
import { senderDisplayName } from "@/lib/documents/mail-route-labels";
import { textToHtml } from "@/lib/pipeline/automation-rules";
import { keepDataUrl } from "@/lib/storage/files";
import { fileRefusal, isStorageFull } from "@/lib/file-refusal";
import { LIMITS, QUESTIONNAIRE_FILE, parseAnswers, type Answers, type FileAnswer } from "@/lib/projects/questionnaire";

/**
 * A project's questionnaire, server side (owner, 16 Nov 2026). Plain, not `"use server"`: the actions that wrap it
 * decide who may ask, and check scripts call it directly.
 *
 * The link is the whole authentication — 192 bits, for one round of one project's questions — so only its hash is
 * kept. Sending again makes a new link; the old one stops working.
 */

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export function newLink(): { token: string; hash: string } {
  const token = randomBytes(24).toString("base64url");
  return { token, hash: hashToken(token) };
}
export const questionnaireUrl = (origin: string, token: string) => `${origin.replace(/\/+$/, "")}/q/${token}`;

/** The round a link opens, if it is still open for answers or was answered (the page says thank you then). */
export async function roundForToken(token: unknown) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{30,64}$/.test(token)) return null;
  return db.projectQuestionnaire.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      projectId: true,
      contactId: true,
      round: true,
      questions: true,
      answers: true,
      openedAt: true,
      submittedAt: true,
      closedAt: true,
      project: { select: { id: true, code: true, name: true, status: true, managerId: true, company: { select: { id: true, name: true } } } },
    },
  });
}

/**
 * The email with the link: from the sender's own mailbox when connected, else the company's mail server with replies
 * to them — as a quick message goes. Logged in the email log against the customer.
 */
export async function emailQuestionnaire(input: {
  senderId: string;
  companyId: string;
  contact: { id: string; name: string; email: string };
  projectName: string;
  link: string;
  note: string;
  reminder: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const [sender, mailbox, route, org] = await Promise.all([
    db.user.findUnique({ where: { id: input.senderId }, select: { id: true, name: true, email: true } }),
    mailboxState(input.senderId),
    emailRouteFor("TRANSACTIONAL"),
    getOrganisation(),
  ]);
  if (!sender) return { ok: false, error: "Your account wasn't found." };
  const first = input.contact.name.trim().split(/\s+/)[0] || "there";
  const ours = org.tradeName || org.legalName || "us";
  const subject = input.reminder ? `Reminder: a few questions about ${input.projectName}` : `A few questions about ${input.projectName}`;
  const text = [
    `Hi ${first},`,
    "",
    input.note.trim() ||
      `So that we plan ${input.projectName} around what you actually have, could you answer a few questions? Rough answers are fine, and you can save and come back to it.`,
    "",
    input.link,
    "",
    `Thank you,`,
    sender.name,
    ours,
  ].join("\n");
  const html = textToHtml(text);
  let from: string;
  if (mailbox.state === "connected") {
    const out = await sendAsUser(sender.id, { subject, html, to: [{ name: input.contact.name, email: input.contact.email }], attachments: [] });
    if (!out.ok) return { ok: false, error: `Your mailbox didn't send it: ${out.error}` };
    from = out.mailbox;
  } else if (route) {
    const out = await deliverNow({ to: input.contact.email, toName: input.contact.name, fromName: senderDisplayName(sender.name, ours), replyTo: sender.email, subject, html, text }, "TRANSACTIONAL", { delivering: true });
    if (!out.ok) return { ok: false, error: `The company's mail server didn't take it: ${out.error}` };
    from = out.fromEmail ?? out.provider;
  } else {
    return { ok: false, error: "You haven't a mailbox connected (My profile), and no mail server is set up for the company (Settings › Mail & messaging)." };
  }
  const now = new Date();
  await db.marketingMessage.create({
    data: {
      token: randomBytes(24).toString("base64url"),
      companyId: input.companyId,
      contactId: input.contact.id,
      channel: "EMAIL",
      messageClass: "TRANSACTIONAL",
      // The link itself is never logged: the log is read by more people than the project.
      subject,
      body: textToHtml(text.replace(input.link, "[the questionnaire link]")),
      textBody: text.replace(input.link, "[the questionnaire link]"),
      toEmail: input.contact.email,
      status: "SENT",
      scheduledFor: now,
      sentAt: now,
      attempts: 1,
      sentByUserId: sender.id,
      fromEmail: from,
    },
  });
  return { ok: true };
}

/** What each kind of file must start with — a file is what its name says or it isn't kept. */
const FILE_KINDS: Record<string, { mime: string; is: (b: Buffer) => boolean }> = {
  pdf: { mime: "application/pdf", is: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  png: { mime: "image/png", is: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  jpg: { mime: "image/jpeg", is: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  jpeg: { mime: "image/jpeg", is: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", is: (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", is: (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 },
  doc: { mime: "application/msword", is: (b) => b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) },
  xls: { mime: "application/vnd.ms-excel", is: (b) => b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) },
  csv: { mime: "text/csv", is: (b) => !b.subarray(0, 4096).includes(0) && !/^\s*<(!doctype|html|svg|script|\?xml)/i.test(b.subarray(0, 512).toString("latin1")) },
};

/** A file the customer attached, checked: one of the kinds above, really that kind, 4 MB at most. */
export function checkQuestionnaireFile(name: string, bytes: Buffer): { ok: true; name: string; mime: string } | { ok: false; error: string } {
  return checkAttachedFile(name, bytes, QUESTIONNAIRE_FILE.maxBytes);
}

/** A file sent through a public link, checked the same way — also a reseller's quote request (src/lib/quote-requests). */
export function checkAttachedFile(name: string, bytes: Buffer, maxBytes: number): { ok: true; name: string; mime: string } | { ok: false; error: string } {
  const clean = (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f"<>|*?:]/g, "").trim().slice(-120) || "file";
  if (bytes.length === 0) return { ok: false, error: `${clean} is empty.` };
  if (bytes.length > maxBytes) return { ok: false, error: `${clean} is over ${Math.round(maxBytes / 1024 / 1024)} MB — save a smaller copy and attach that.` };
  const ext = clean.includes(".") ? clean.split(".").pop()!.toLowerCase() : "";
  const kind = FILE_KINDS[ext];
  if (!kind) return { ok: false, error: `${clean} can't be attached — PDF, Word, Excel, CSV and pictures can.` };
  if (!kind.is(bytes)) return { ok: false, error: `${clean} isn't the kind of file its name says. Save it again and attach that.` };
  return { ok: true, name: clean, mime: kind.mime };
}

/** The file kept as one of the project's documents, and named in the round's answers. */
export async function addRoundFile(roundId: string, projectId: string, key: string, file: { name: string; mime: string; bytes: Buffer }, contactName: string | null): Promise<{ ok: true; file: FileAnswer } | { ok: false; error: string }> {
  return db.$transaction(async (tx) => {
    // The row locked, so two files at once can't both read "under five".
    await tx.$queryRaw`SELECT id FROM project_questionnaires WHERE id = ${roundId} FOR UPDATE`;
    const round = await tx.projectQuestionnaire.findUnique({ where: { id: roundId }, select: { answers: true, submittedAt: true, closedAt: true } });
    if (!round || round.submittedAt || round.closedAt) return { ok: false as const, error: "This questionnaire can't be changed any more." };
    const answers = parseAnswers(round.answers);
    const kept = Array.isArray(answers[key]) ? (answers[key] as FileAnswer[]).filter((f) => typeof f === "object") : [];
    if (kept.length >= LIMITS.filesPerQuestion) return { ok: false as const, error: `${LIMITS.filesPerQuestion} files at most here.` };
    // Kept before the row: refused — the workspace out of storage — the customer is told, in words for them rather than
    // for its administrators, and nothing is written (src/lib/file-refusal.ts).
    let fileDataUrl: string;
    try {
      fileDataUrl = await keepDataUrl("project-documents", `data:${file.mime};base64,${file.bytes.toString("base64")}`);
    } catch (err) {
      if (isStorageFull(err)) return { ok: false as const, error: `${file.name} can't be attached just now — there's no room left to keep it. Send it to your contact another way.` };
      const refusal = fileRefusal(err);
      if (refusal !== null) return { ok: false as const, error: refusal };
      throw err;
    }
    const doc = await tx.projectDocument.create({
      data: {
        projectId,
        type: "OTHER",
        name: file.name,
        note: `Sent with the questionnaire${contactName ? ` by ${contactName}` : ""}.`,
        fileDataUrl,
        mimeType: file.mime,
        sizeBytes: file.bytes.length,
      },
      select: { id: true },
    });
    const added: FileAnswer = { documentId: doc.id, name: file.name, size: file.bytes.length };
    await tx.projectQuestionnaire.update({ where: { id: roundId }, data: { answers: { ...answers, [key]: [...kept, added] } as Prisma.InputJsonValue, savedAt: new Date() } });
    return { ok: true as const, file: added };
  });
}

/** A file taken back off before sending: out of the answers, and out of the project's documents. */
export async function removeRoundFile(roundId: string, key: string, documentId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM project_questionnaires WHERE id = ${roundId} FOR UPDATE`;
    const round = await tx.projectQuestionnaire.findUnique({ where: { id: roundId }, select: { projectId: true, answers: true, submittedAt: true, closedAt: true } });
    if (!round || round.submittedAt || round.closedAt) return { ok: false as const, error: "This questionnaire can't be changed any more." };
    const answers = parseAnswers(round.answers);
    const kept = Array.isArray(answers[key]) ? (answers[key] as FileAnswer[]) : [];
    // Only a file this round holds: a document id from anywhere else removes nothing.
    if (!kept.some((f) => f.documentId === documentId)) return { ok: false as const, error: "That file isn't on this questionnaire." };
    // Kept when an answered round names it too — a reopened questionnaire starts with the files sent before.
    const answered = await tx.projectQuestionnaire.findMany({ where: { projectId: round.projectId, submittedAt: { not: null } }, select: { answers: true } });
    const stillNamed = answered.some((r) => Object.values(parseAnswers(r.answers)).some((v) => Array.isArray(v) && v.some((f) => typeof f === "object" && f.documentId === documentId)));
    if (!stillNamed) await tx.projectDocument.deleteMany({ where: { id: documentId, projectId: round.projectId, uploadedById: null } });
    const left = kept.filter((f) => f.documentId !== documentId);
    const next: Answers = { ...answers };
    if (left.length) next[key] = left;
    else delete next[key];
    await tx.projectQuestionnaire.update({ where: { id: roundId }, data: { answers: next as Prisma.InputJsonValue, savedAt: new Date() } });
    return { ok: true as const };
  });
}

/**
 * Answered: the project team told, a line in its log, and a project still Proposed moved to Discovery — the answers are
 * what discovery starts from.
 */
export async function afterAnswered(round: { id: string; projectId: string; contactId: string | null }) {
  const project = await db.project.findUnique({
    where: { id: round.projectId },
    select: { code: true, name: true, status: true, stakeholders: { where: { userId: { not: null } }, select: { userId: true } } },
  });
  if (!project) return;
  const contact = round.contactId ? await db.contact.findUnique({ where: { id: round.contactId }, select: { name: true } }) : null;
  const who = contact?.name ?? "The customer";
  if (project.status === "PROPOSED") await db.project.updateMany({ where: { id: round.projectId, status: "PROPOSED" }, data: { status: "DISCOVERY" } });
  await db.projectUpdate.create({ data: { projectId: round.projectId, body: `${who} answered the questionnaire. Their answers are on the Requirements tab.${project.status === "PROPOSED" ? " The project moved to Discovery." : ""}` } });
  const ids = [...new Set(project.stakeholders.map((s) => s.userId!))];
  await Promise.all(
    ids.map((userId) =>
      notifyUser({ userId, type: "FORM_RESPONSE", title: `${who} answered the questionnaire for ${project.code}`, message: project.name, link: `/projects/${round.projectId}?tab=requirements` }),
    ),
  );
}
