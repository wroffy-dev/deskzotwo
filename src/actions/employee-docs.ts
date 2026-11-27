"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type EmployeeDocumentType, type LetterType } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleAccess, requireModuleUser } from "@/lib/modules-access";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { hasEffectivePermission } from "@/actions/permission";
import { getDownlineUserIds } from "@/lib/org-chart";
import { checkUpload } from "@/lib/hr/document-upload";
import { dataUrlOrNull, keepDataUrl } from "@/lib/storage/files";
import { keepOrRefuse } from "@/lib/file-refusal";
import { dateOnly } from "@/lib/hr/calendar";
import { monthlyGross } from "@/lib/hr/payroll";
import { STRUCTURE_EXTRAS_READ, componentsOfStructure, ctcOfStructure } from "@/lib/hr/salary-split";
import { mergeLetterTemplate } from "@/lib/hr/letter-templates";
import { notMigratedYet } from "@/lib/not-migrated";
import { hiddenFileIds, isFileHidden } from "@/lib/hr/file-visibility";
import { letterNumberFor, renderLetter, subjectFor, type LetterPayload } from "@/lib/hr/letters";
import { computeGratuity, serviceYears } from "@/lib/hr/settlement";
import { getOrganisation, letterSignatureImage, letterSignatureSettings } from "@/lib/organisation";
import { workspaceClock } from "@/lib/time/workspace";
import { personPath } from "@/lib/record-links";
import type { ActionResult } from "@/actions/company";
import { clip, clipOrNull, TEXT_MAX } from "@/lib/text/bounded";

/**
 * Personnel files: uploaded documents, previous employment, and the letters the company issues.
 *
 * Two access rules run through everything here, and they are not the same rule.
 *
 * A *document* may be hidden from the person it describes — `visibleToEmployee` — because an
 * interview scorecard or a disciplinary note belongs on a personnel file but is not for the
 * subject. Employees see their own visible documents; HR sees all of them.
 *
 * *Previous employment and salary* are HR's, full stop. An employee can see their own history but
 * not edit it once it is on file, because the whole point of recording a claimed last-drawn salary
 * is that it was claimed at a particular time and can be checked.
 */

/**
 * Who may see a personnel record.
 *
 * `targetUserId` is null for a document or letter that still belongs to a candidate — nobody is
 * employed yet, so there is no "self" and no manager, and HR is the only answer. Passing the null
 * through rather than special-casing at each call site means a candidate's CV cannot leak by
 * somebody forgetting the check.
 */
async function access(targetUserId: string | null) {
  const user = await requireModuleUser("hr");
  const manage = await hasEffectivePermission(user.id, "hr.manage");
  if (!targetUserId) {
    return { user, manage, isSelf: false, isManager: false, canRead: manage };
  }
  const isSelf = user.id === targetUserId;
  const isManager = !manage && !isSelf ? (await getDownlineUserIds(user.id)).includes(targetUserId) : false;
  return { user, manage, isSelf, isManager, canRead: manage || isSelf || isManager };
}

/**
 * `access` for the actions only People (HR)'s own pages use: People (HR) open to the person as well. The actions other
 * screens use keep `access` alone (owner, 3 Nov 2026 — Phase 2 permission fixes, audit L-6).
 */
async function accessIfOpen(...args: Parameters<typeof access>) {
  await requireModuleAccess("hr");
  return access(...args);
}

// ─── Documents ────────────────────────────────────────────────────────────────

export async function listEmployeeDocuments(userId: string) {
  const { manage, canRead } = await accessIfOpen(userId);
  if (!canRead) return [];
  return toPlain(
    await db.employeeDocument.findMany({
      // The employee and their manager never see the internal file; HR sees everything.
      where: { userId, ...(manage ? {} : { visibleToEmployee: true }) },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, type: true, name: true, note: true, mimeType: true, sizeBytes: true,
        visibleToEmployee: true, createdAt: true, letterId: true,
        uploadedBy: { select: { name: true } },
      },
    }),
  );
}

export async function uploadEmployeeDocument(input: {
  userId: string;
  type: EmployeeDocumentType;
  name: string;
  fileDataUrl: string;
  mimeType: string;
  note?: string;
  visibleToEmployee?: boolean;
}): Promise<ActionResult<{ id: string }>> {
  const { user, manage, isSelf } = await accessIfOpen(input.userId);
  // Somebody may add their own CV or a certificate; only HR files documents on other people.
  if (!manage && !isSelf) return { ok: false, error: "You can't add documents to someone else's file." };

  // Capped as read (owner, 15 Nov 2026 — input bounds).
  const name = clip(input.name, TEXT_MAX.name);
  const check = checkUpload({ ...input, name });
  if (!check.ok) return { ok: false, error: check.error };
  const { sizeBytes } = check;

  const target = await db.user.findUnique({ where: { id: input.userId }, select: { name: true, userSeq: true } });
  if (!target) return { ok: false, error: "That user no longer exists." };

  // The file goes to the storage box when the server has one (src/lib/storage/files.ts); the row keeps its reference.
  // Kept first: a workspace out of storage is told so, and no row is written (src/lib/file-refusal.ts).
  const kept = await keepOrRefuse(() => keepDataUrl("employee-documents", input.fileDataUrl));
  if (!kept.ok) return kept;

  const created = await db.employeeDocument.create({
    data: {
      userId: input.userId,
      type: input.type,
      name,
      note: clipOrNull(input.note, TEXT_MAX.paragraph),
      fileDataUrl: kept.value,
      mimeType: input.mimeType,
      sizeBytes,
      // An employee cannot file something against themselves that they then cannot see.
      visibleToEmployee: manage ? (input.visibleToEmployee ?? true) : true,
      uploadedById: user.id,
    },
    select: { id: true },
  });

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "EmployeeDocument",
    entityId: created.id,
    entityLabel: `${name} added to ${target.name}'s file`,
  });
  // HR putting a document on somebody's file that they can see tells them — in the bell and by email (owner, 18 Nov
  // 2026: "when HR issues a document to any user mail that to particular user"). Not their own upload, and not one HR
  // keeps about them. The email links to their file; the document itself stays behind the sign-in.
  if (!isSelf && created && (manage ? (input.visibleToEmployee ?? true) : true)) {
    await notifyUser({
      userId: input.userId,
      type: "LETTER_ISSUED",
      title: `${name} is on your file`,
      message: `HR added ${name} to your documents.`,
      link: `${personPath(target.userSeq)}?tab=documents`,
    });
  }
  revalidatePath(`/people/${input.userId}`);
  return { ok: true, data: created };
}

/** The file itself, fetched only when somebody opens it — the list never carries the payload. */
export async function getEmployeeDocument(id: string) {
  const doc = await db.employeeDocument.findUnique({
    where: { id },
    select: { id: true, userId: true, name: true, mimeType: true, fileDataUrl: true, visibleToEmployee: true },
  });
  if (!doc) return null;
  const { manage, canRead } = await access(doc.userId);
  if (!canRead) return null;
  if (!doc.visibleToEmployee && !manage) return null;
  // The file itself, from the storage box when it is kept there. One the box no longer has is not found, as a deleted
  // one is. An issued letter's "letter:<id>" passes through as it is.
  const fileDataUrl = await dataUrlOrNull(doc.fileDataUrl);
  if (fileDataUrl === null) return null;
  return { ...doc, fileDataUrl };
}

export async function deleteEmployeeDocument(id: string): Promise<ActionResult<null>> {
  const doc = await db.employeeDocument.findUnique({
    where: { id },
    select: { id: true, userId: true, name: true, letterId: true },
  });
  if (!doc) return { ok: false, error: "That document no longer exists." };

  const { user, manage } = await accessIfOpen(doc.userId);
  if (!manage) return { ok: false, error: "Only HR can remove a document from a personnel file." };
  if (doc.letterId) {
    return { ok: false, error: "That's a letter the company issued. Revoke the letter instead of deleting the file." };
  }

  await db.employeeDocument.delete({ where: { id } });
  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "EmployeeDocument",
    entityId: id,
    entityLabel: `Removed ${doc.name}`,
  });
  if (doc.userId) revalidatePath(`/people/${doc.userId}`);
  return { ok: true, data: null };
}

// ─── Previous employment ──────────────────────────────────────────────────────

export async function listEmploymentHistory(userId: string) {
  const { canRead } = await accessIfOpen(userId);
  if (!canRead) return [];
  return toPlain(
    await db.employmentHistory.findMany({
      where: { userId },
      orderBy: [{ toDate: "desc" }, { fromDate: "desc" }],
      include: { verifiedBy: { select: { name: true } } },
    }),
  );
}

export async function saveEmploymentHistory(input: {
  id?: string;
  userId: string;
  companyName: string;
  designation?: string;
  location?: string;
  fromDate?: string;
  toDate?: string;
  lastDrawnCtc?: number;
  reasonForLeaving?: string;
  referenceName?: string;
  referenceContact?: string;
  note?: string;
}): Promise<ActionResult<{ id: string }>> {
  const { user, manage } = await accessIfOpen(input.userId);
  if (!manage) return { ok: false, error: "Only HR can record previous employment." };

  const companyName = clip(input.companyName, TEXT_MAX.name);
  if (!companyName) return { ok: false, error: "Name the previous employer." };
  if (input.fromDate && input.toDate && new Date(input.toDate) < new Date(input.fromDate)) {
    return { ok: false, error: "The end date is before the start date." };
  }

  const data = {
    userId: input.userId,
    companyName,
    designation: clipOrNull(input.designation, TEXT_MAX.name),
    location: clipOrNull(input.location, TEXT_MAX.name),
    fromDate: input.fromDate ? dateOnly(input.fromDate) : null,
    toDate: input.toDate ? dateOnly(input.toDate) : null,
    lastDrawnCtc: input.lastDrawnCtc ? new Prisma.Decimal(input.lastDrawnCtc) : null,
    reasonForLeaving: clipOrNull(input.reasonForLeaving, TEXT_MAX.paragraph),
    referenceName: clipOrNull(input.referenceName, TEXT_MAX.name),
    referenceContact: clipOrNull(input.referenceContact, TEXT_MAX.line),
    note: clipOrNull(input.note, TEXT_MAX.paragraph),
  };

  const row = input.id
    ? await db.employmentHistory.update({ where: { id: input.id }, data, select: { id: true } })
    : await db.employmentHistory.create({ data, select: { id: true } });

  await recordAudit({
    userId: user.id,
    action: input.id ? "UPDATE" : "CREATE",
    entityType: "EmploymentHistory",
    entityId: row.id,
    entityLabel: `Previous employment at ${companyName}`,
  });
  revalidatePath(`/people/${input.userId}`);
  return { ok: true, data: row };
}

/**
 * Marking a previous employer as checked.
 *
 * Separate from editing it on purpose: "we rang them and it is true" is a different claim from
 * "this is what the candidate told us", and an HRMS that cannot distinguish the two cannot answer
 * the only question background verification exists to answer.
 */
export async function verifyEmploymentHistory(id: string, verified: boolean): Promise<ActionResult<null>> {
  const row = await db.employmentHistory.findUnique({ where: { id }, select: { userId: true, companyName: true } });
  if (!row) return { ok: false, error: "That entry no longer exists." };

  const { user, manage } = await accessIfOpen(row.userId);
  if (!manage) return { ok: false, error: "Only HR can verify previous employment." };

  await db.employmentHistory.update({
    where: { id },
    data: verified ? { verifiedAt: new Date(), verifiedById: user.id } : { verifiedAt: null, verifiedById: null },
  });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "EmploymentHistory",
    entityId: id,
    entityLabel: `${row.companyName} marked ${verified ? "verified" : "unverified"}`,
  });
  if (row.userId) revalidatePath(`/people/${row.userId}`);
  return { ok: true, data: null };
}

export async function deleteEmploymentHistory(id: string): Promise<ActionResult<null>> {
  const row = await db.employmentHistory.findUnique({ where: { id }, select: { userId: true, companyName: true } });
  if (!row) return { ok: false, error: "That entry no longer exists." };
  const { user, manage } = await accessIfOpen(row.userId);
  if (!manage) return { ok: false, error: "Only HR can remove previous employment." };

  await db.employmentHistory.delete({ where: { id } });
  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "EmploymentHistory",
    entityId: id,
    entityLabel: `Removed previous employment at ${row.companyName}`,
  });
  if (row.userId) revalidatePath(`/people/${row.userId}`);
  return { ok: true, data: null };
}

// ─── Letters ──────────────────────────────────────────────────────────────────

export async function listEmployeeLetters(userId: string) {
  const { canRead, manage, isSelf } = await accessIfOpen(userId);
  if (!canRead) return [];
  // A letter an admin has switched off in the file manager is kept from the person it's for.
  const hidden = isSelf && !manage ? await hiddenFileIds(userId, "LETTER") : new Set<string>();
  const where = { userId, ...(hidden.size ? { id: { notIn: [...hidden] } } : {}) };
  const select = {
    id: true, type: true, letterNumber: true, subject: true, issuedOn: true,
    status: true, createdAt: true, issuedBy: { select: { name: true } },
  } as const;
  try {
    // The template's name where it came from one, shown instead of "From a template".
    return toPlain(await db.employeeLetter.findMany({ where, orderBy: { createdAt: "desc" }, select: { ...select, templateName: true } }));
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
    return toPlain((await db.employeeLetter.findMany({ where, orderBy: { createdAt: "desc" }, select })).map((l) => ({ ...l, templateName: null })));
  }
}

/**
 * Every employee's letters, newest first — People › Letters (owner, 21 Oct 2026). HR's only: the per-person
 * list on someone's page is what anybody else reads. Filtered by status, and by the template it came from.
 */
export async function recentLetters(filters: { status?: string; templateId?: string; page?: number } = {}) {
  const { manage } = await accessIfOpen(null);
  if (!manage) return null;
  const pageSize = 50;
  const page = Math.max(1, Math.floor(Number(filters.page) || 1));
  const status = filters.status === "DRAFT" || filters.status === "ISSUED" || filters.status === "REVOKED" ? filters.status : undefined;
  const select = {
    id: true, type: true, letterNumber: true, subject: true, issuedOn: true, status: true,
    user: { select: { name: true, userSeq: true } },
    issuedBy: { select: { name: true } },
  } as const;
  try {
    const where = { userId: { not: null }, ...(status ? { status } : {}), ...(filters.templateId ? { templateId: filters.templateId } : {}) } satisfies Prisma.EmployeeLetterWhereInput;
    const [rows, total] = await Promise.all([
      db.employeeLetter.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize, select: { ...select, templateName: true, signed: true } }),
      db.employeeLetter.count({ where }),
    ]);
    return toPlain({ rows, total, page, pageSize });
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
    const where = { userId: { not: null }, ...(status ? { status } : {}) } satisfies Prisma.EmployeeLetterWhereInput;
    const [rows, total] = await Promise.all([
      db.employeeLetter.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize, select }),
      db.employeeLetter.count({ where }),
    ]);
    return toPlain({ rows: rows.map((r) => ({ ...r, templateName: null, signed: false })), total, page, pageSize });
  }
}

/**
 * The facts a letter freezes, from the employee record as it stands *today* — for a built-in letter and for
 * one of HR's own templates alike (src/lib/hr/letter-templates.ts). Null when the person is gone.
 */
async function employeePayload(userId: string, issuerName: string) {
  const person = await db.user.findUnique({
    where: { id: userId },
    select: {
      name: true,
      department: { select: { name: true } },
      manager: { select: { name: true } },
      employeeProfile: true,
      // Two, so an increment letter can state what the salary was as well as what it becomes.
      salaryStructures: { orderBy: { effectiveFrom: "desc" }, take: 2, omit: STRUCTURE_EXTRAS_READ },
      payslips: {
        where: { run: { status: { in: ["LOCKED", "PAID"] } } },
        orderBy: [{ run: { year: "desc" } }, { run: { month: "desc" } }],
        take: 1,
        select: { netPay: true, grossEarnings: true, run: { select: { month: true, year: true } } },
      },
    },
  });
  if (!person) return null;

  const profile = person.employeeProfile;
  const structure = person.salaryStructures[0];
  const gross = structure ? monthlyGross(componentsOfStructure(structure)) : null;

  const org = await getOrganisation();
  const slip = person.payslips[0];
  const previous = person.salaryStructures[1];
  const previousGross = previous ? monthlyGross(componentsOfStructure(previous)) : null;

  // Gratuity is computed rather than typed, so the statement and the settlement cannot disagree.
  const gratuity =
    profile?.joinedOn && profile.exitedOn && structure
      ? computeGratuity(Number(structure.basic), profile.joinedOn, profile.exitedOn)
      : null;

  // The record's own days are `@db.Date` columns, read as the days they hold; today is the workspace's.
  const clock = await workspaceClock();
  const today = clock.parts(new Date());

  const payload: LetterPayload = {
    employeeName: person.name,
    designation: profile?.designation ?? "—",
    department: person.department?.name ?? null,
    employeeCode: profile?.employeeCode ?? null,
    companyName: org.legalName || "the company",
    companyAddress: [org.addressLine1, org.addressLine2, org.city, org.state, org.pincode].filter(Boolean).join("\n") || null,
    // The CTC the salary card shows (src/lib/hr/salary-split.ts): gross and the employer's PF and ESI,
    // a year of it. Letters said twelve months of gross, which wasn't the CTC anybody was offered.
    annualCtc: structure ? Math.round(ctcOfStructure(structure)) : null,
    monthlyGross: gross,
    joinedOn: profile?.joinedOn ? profile.joinedOn.toISOString().slice(0, 10) : null,
    probationMonths: profile?.probationEndsOn && profile.joinedOn
      ? Math.max(1, Math.round((profile.probationEndsOn.getTime() - profile.joinedOn.getTime()) / (30 * 86400000)))
      : 6,
    confirmedOn: profile?.confirmedOn ? profile.confirmedOn.toISOString().slice(0, 10) : null,
    lastWorkingDay: profile?.exitedOn ? profile.exitedOn.toISOString().slice(0, 10) : null,
    reportingTo: person.manager?.name ?? null,
    workLocation: profile?.workLocation ?? null,
    offerValidUntil: clock.dateKey(clock.midnight(today.year, today.month, today.day + 14)),
    forMonth: slip?.run.month ?? null,
    forYear: slip?.run.year ?? null,
    netPay: slip ? Number(slip.netPay) : null,
    // The configured signatory if there is one — an appointment letter should be signed by the HR
    // head, not by whichever colleague happened to press the button.
    signatoryName: org.letterSignatoryName || issuerName,
    signatoryTitle: org.letterSignatoryTitle || "For " + (org.legalName || "the company"),

    previousCtc: previous ? Math.round(ctcOfStructure(previous)) : previousGross ? Math.round(previousGross * 12) : null,
    previousDesignation: profile?.designation ?? null,
    effectiveFrom: structure?.effectiveFrom.toISOString().slice(0, 10) ?? null,
    previousLocation: profile?.workLocation ?? null,
    extendedUntil: profile?.probationEndsOn
      ? new Date(profile.probationEndsOn.getTime() + 90 * 86400000).toISOString().slice(0, 10)
      : null,
    stipend: profile?.employmentType === "INTERN" ? gross : null,
    internshipFrom: profile?.joinedOn?.toISOString().slice(0, 10) ?? null,
    internshipTo: profile?.exitedOn?.toISOString().slice(0, 10) ?? null,
    resignedOn: profile?.exitedOn
      ? new Date(profile.exitedOn.getTime() - (profile.noticePeriodDays ?? 30) * 86400000).toISOString().slice(0, 10)
      : null,
    noticePeriodDays: profile?.noticePeriodDays ?? 30,
    leaveWeeks: 26,
    gratuityAmount: gratuity?.amount ?? null,
    serviceYears:
      profile?.joinedOn && profile.exitedOn ? serviceYears(profile.joinedOn, profile.exitedOn) : null,
    contractMonths: profile?.employmentType === "CONTRACT" || profile?.employmentType === "CONSULTANT" ? 12 : null,
  };
  return { payload, org, clock, year: today.year };
}

/**
 * Security audit round three, 14 Nov 2026 (R3-13): every letter froze the whole payload — CTC, gross, last net pay —
 * whatever it said, and the letter came back with it to line managers and to HR without payroll rights. Now a letter
 * freezes pay only when it states pay, and only when whoever drafts it runs payroll (`payroll.manage`); otherwise those
 * fields are frozen empty. Reading is limited in getLetter.
 */
const PAY_FIELDS = ["annualCtc", "monthlyGross", "netPay", "forMonth", "forYear", "previousCtc", "stipend", "gratuityAmount"] as const;
const PAY_LETTERS: ReadonlySet<LetterType> = new Set<LetterType>([
  "LETTER_OF_INTENT", "OFFER", "APPOINTMENT", "SALARY_CERTIFICATE", "INTERNSHIP", "CONTRACT_AGREEMENT", "INCREMENT", "PROMOTION", "GRATUITY_STATEMENT",
]);

/** The payload with the pay fields emptied, unless the letter states pay and its drafter may put pay in it. */
async function payloadToFreeze(payload: LetterPayload, statesPay: boolean, drafterId: string): Promise<LetterPayload> {
  if (statesPay && (await hasEffectivePermission(drafterId, "payroll.manage"))) return payload;
  return { ...payload, ...Object.fromEntries(PAY_FIELDS.map((key) => [key, null])) };
}

/** Whether a stored letter carries pay: its type states it, or its frozen payload holds some (one of HR's own templates). */
function letterCarriesPay(type: LetterType, payload: unknown): boolean {
  if (PAY_LETTERS.has(type)) return true;
  const frozen = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  return PAY_FIELDS.some((key) => frozen[key] !== null && frozen[key] !== undefined);
}

/**
 * Builds a letter from the employee record as it stands *today*, and freezes that into the row.
 *
 * Everything the letter will assert is captured now — see the note in src/lib/hr/letters.ts. The
 * body comes back editable, because whoever issues it always wants to change a sentence, and a
 * template nobody can adjust gets replaced by a Word document within a month.
 */
export async function draftLetter(userId: string, type: LetterType): Promise<ActionResult<{ id: string }>> {
  const { user, manage } = await accessIfOpen(userId);
  if (!manage) return { ok: false, error: "Only HR can issue letters." };
  if (type === "CUSTOM") return { ok: false, error: "Pick the template to draft it from." };

  const built = await employeePayload(userId, user.name);
  if (!built) return { ok: false, error: "That user no longer exists." };
  const { org, clock, year } = built;
  const payload = await payloadToFreeze(built.payload, PAY_LETTERS.has(type), user.id);

  const sequence =(await db.employeeLetter.count({ where: { type, issuedOn: { gte: new Date(Date.UTC(year, 0, 1)) } } })) + 1;

  const created = await db.employeeLetter.create({
    data: {
      userId,
      type,
      letterNumber: letterNumberFor(type, year, sequence, org.letterNumberPrefix),
      subject: subjectFor(type, payload),
      issuedOn: clock.calendarDate(new Date()),
      payload: payload as unknown as Prisma.InputJsonValue,
      body: renderLetter(type, payload),
      issuedById: user.id,
      ...(await signedByDefault()),
    },
    select: { id: true },
  });

  revalidatePath(`/people/${userId}`);
  return { ok: true, data: created };
}

/**
 * A letter from one of HR's own templates (owner, 21 Oct 2026): the person's facts frozen as for a built-in
 * letter, the template's subject and body with them filled in, and a number with the template's own code.
 */
export async function draftTemplateLetter(userId: string, templateId: string): Promise<ActionResult<{ id: string }>> {
  const { user, manage } = await accessIfOpen(userId);
  if (!manage) return { ok: false, error: "Only HR can issue letters." };
  const template = await db.letterTemplate.findUnique({ where: { id: templateId }, select: { id: true, name: true, code: true, subject: true, body: true, active: true } });
  if (!template || !template.active) return { ok: false, error: "That template isn't available any more." };

  const built = await employeePayload(userId, user.name);
  if (!built) return { ok: false, error: "That user no longer exists." };
  const { org, clock, year } = built;
  // One of HR's own templates states pay where it uses a salary field (src/lib/hr/letter-templates.ts).
  const payload = await payloadToFreeze(built.payload, /\{\{\s*salary\./.test(`${template.subject}\n${template.body}`), user.id);
  const today = clock.dateKey(new Date());

  // Counted by the number itself, so a template deleted and made again under the same code carries on.
  const stem = letterNumberFor("CUSTOM", year, 0, org.letterNumberPrefix, template.code).replace(/000$/, "");
  const sequence = (await db.employeeLetter.count({ where: { letterNumber: { startsWith: stem } } })) + 1;
  const created = await db.employeeLetter.create({
    data: {
      userId,
      type: "CUSTOM",
      templateId: template.id,
      templateName: template.name,
      letterNumber: letterNumberFor("CUSTOM", year, sequence, org.letterNumberPrefix, template.code),
      subject: mergeLetterTemplate(template.subject, payload, today),
      issuedOn: clock.calendarDate(new Date()),
      payload: payload as unknown as Prisma.InputJsonValue,
      body: mergeLetterTemplate(template.body, payload, today),
      issuedById: user.id,
      ...(await signedByDefault()),
    },
    select: { id: true },
  });

  await recordAudit({ userId: user.id, action: "CREATE", entityType: "EmployeeLetter", entityId: created.id, entityLabel: `Drafted from the template ${template.name}` });
  revalidatePath(`/people/${userId}`);
  return { ok: true, data: created };
}

/** A new letter carries the signature when the company has said so — and only where the column is there. */
async function signedByDefault(): Promise<{ signed?: boolean }> {
  const settings = await letterSignatureSettings();
  return settings.migrated ? { signed: settings.signByDefault } : {};
}

/**
 * What a letter adds to its row since 21 Oct 2026 — the signature choice, the copy made on issue, and the
 * template it came from — read by name, and nothing in a workspace not migrated yet.
 */
async function letterExtras(id: string) {
  try {
    const row = await db.employeeLetter.findUnique({ where: { id }, select: { signed: true, signatureDataUrl: true, templateName: true } });
    return { signed: row?.signed ?? false, signatureDataUrl: row?.signatureDataUrl ?? null, templateName: row?.templateName ?? null, migrated: true };
  } catch (err) {
    if (notMigratedYet(err)) return { signed: false, signatureDataUrl: null, templateName: null, migrated: false };
    throw err;
  }
}

export async function getLetter(id: string) {
  const letter = await db.employeeLetter.findUnique({
    where: { id },
    include: { user: { select: { id: true, userSeq: true, name: true } }, issuedBy: { select: { name: true } } },
  });
  if (!letter) return null;
  const { manage, canRead, user, isSelf } = await access(letter.userId);
  if (!canRead) return null;
  // A draft is HR's working copy — the employee sees a letter once it has been issued.
  if (letter.status === "DRAFT" && !manage) return null;
  // Switched off for them in the file manager.
  if (!manage && letter.userId === user.id && (await isFileHidden("LETTER", letter.id))) return null;
  // R3-13: the frozen facts go to HR and to the person the letter is for. Their line manager reads the letter, but
  // not its pay: only the names the print page signs with, and — where the letter states pay — not its text.
  if (!manage && !isSelf) {
    const frozen = letter.payload && typeof letter.payload === "object" ? (letter.payload as Record<string, unknown>) : {};
    const payload = { companyName: frozen.companyName ?? null, signatoryName: frozen.signatoryName ?? null, signatoryTitle: frozen.signatoryTitle ?? null };
    const body = letterCarriesPay(letter.type, letter.payload)
      ? `This letter states ${letter.user?.name ?? "the employee"}'s pay, so only HR and ${letter.user?.name ?? "the employee"} can read it.`
      : letter.body;
    return toPlain({ ...letter, payload, body, ...(await letterExtras(id)) });
  }
  return toPlain({ ...letter, ...(await letterExtras(id)) });
}

/**
 * Whether a draft carries the signatory's signature (owner, 21 Oct 2026). HR's to switch, while it's a draft:
 * once issued, the letter keeps the copy it was issued with.
 */
export async function setLetterSigned(id: string, signed: boolean): Promise<ActionResult<null>> {
  const letter = await db.employeeLetter.findUnique({ where: { id }, select: { userId: true, status: true } });
  if (!letter) return { ok: false, error: "That letter no longer exists." };
  const { manage } = await accessIfOpen(letter.userId);
  if (!manage) return { ok: false, error: "Only HR can sign a letter." };
  if (letter.status !== "DRAFT") return { ok: false, error: "An issued letter keeps the signature it was issued with." };
  await db.employeeLetter.update({ where: { id }, data: { signed } });
  revalidatePath(`/people/letters/${id}`);
  return { ok: true, data: null };
}

export async function updateLetterBody(id: string, body: string): Promise<ActionResult<null>> {
  const letter = await db.employeeLetter.findUnique({ where: { id }, select: { userId: true, status: true } });
  if (!letter) return { ok: false, error: "That letter no longer exists." };
  const { manage } = await accessIfOpen(letter.userId);
  if (!manage) return { ok: false, error: "Only HR can edit a letter." };
  if (letter.status !== "DRAFT") {
    return { ok: false, error: "An issued letter can't be edited — its number has already been quoted. Revoke it and draft another." };
  }

  await db.employeeLetter.update({ where: { id }, data: { body } });
  if (letter.userId) revalidatePath(`/people/${letter.userId}`);
  return { ok: true, data: null };
}

/**
 * Issuing, which files a copy on the personnel file and tells the employee.
 *
 * The copy is what makes the letter real: it is what the employee can open six months later, and it
 * is why an issued letter cannot be edited afterwards.
 */
export async function issueLetter(id: string): Promise<ActionResult<null>> {
  const letter = await db.employeeLetter.findUnique({
    where: { id },
    select: { id: true, userId: true, candidateId: true, type: true, letterNumber: true, subject: true, status: true, user: { select: { userSeq: true } } },
  });
  if (!letter) return { ok: false, error: "That letter no longer exists." };
  const { user, manage } = await accessIfOpen(letter.userId);
  if (!manage) return { ok: false, error: "Only HR can issue a letter." };
  if (letter.status !== "DRAFT") return { ok: false, error: `That letter is already ${letter.status.toLowerCase()}.` };

  // The signature as it is now goes onto the letter with it, so a new image in settings never re-signs a
  // letter somebody already holds; and it's dated the day it's issued, not the day it was drafted.
  const extras = await letterExtras(id);
  const signature = extras.signed ? await letterSignatureImage() : null;
  const issuedOn = (await workspaceClock()).calendarDate(new Date());

  await db.$transaction(async (tx) => {
    await tx.employeeLetter.update({
      where: { id },
      // Signed with no image to sign with is unsigned: what the letter carries is what it was issued with.
      data: { status: "ISSUED", issuedById: user.id, issuedOn, ...(extras.migrated ? { signatureDataUrl: signature, signed: !!signature } : {}) },
    });
    await tx.employeeDocument.create({
      data: {
        userId: letter.userId,
        // A letter issued to a candidate is filed against the candidate. Copying only the userId
        // would leave the document owned by nobody — invisible on both the hiring page and the
        // personnel file, and never moved across at conversion.
        candidateId: letter.candidateId,
        type: letter.type === "OFFER" ? "OFFER_LETTER" : letter.type === "APPOINTMENT" ? "APPOINTMENT_LETTER" : "OTHER",
        name: `${letter.subject} (${letter.letterNumber})`,
        // The letter is rendered from its frozen payload on demand, so the file entry points at it
        // rather than carrying a second copy that could drift.
        fileDataUrl: `letter:${letter.id}`,
        mimeType: "text/letter",
        sizeBytes: 0,
        visibleToEmployee: true,
        letterId: letter.id,
        uploadedById: user.id,
      },
    });
  });

  // Only an employee gets told. An offer letter is issued to somebody who has no account yet —
  // it reaches them by email from HR, which is the point of it being an offer.
  if (letter.userId && letter.user) {
    await notifyUser({
      userId: letter.userId,
      type: "LETTER_ISSUED",
      title: letter.subject,
      message: `${letter.letterNumber} is on your file.`,
      link: `${personPath(letter.user.userSeq)}?tab=documents`,
    });
  }

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "EmployeeLetter",
    entityId: id,
    entityLabel: `Issued ${letter.letterNumber} — ${letter.subject}`,
  });
  if (letter.userId) revalidatePath(`/people/${letter.userId}`);
  if (letter.candidateId) revalidatePath(`/people/hiring/${letter.candidateId}`);
  return { ok: true, data: null };
}

export async function revokeLetter(id: string): Promise<ActionResult<null>> {
  const letter = await db.employeeLetter.findUnique({ where: { id }, select: { userId: true, candidateId: true, letterNumber: true, status: true } });
  if (!letter) return { ok: false, error: "That letter no longer exists." };
  const { user, manage } = await accessIfOpen(letter.userId);
  if (!manage) return { ok: false, error: "Only HR can revoke a letter." };

  // Never deleted: the number was quoted to somebody, and a reference that resolves to nothing is
  // worse than one that resolves to "withdrawn".
  await db.$transaction(async (tx) => {
    await tx.employeeLetter.update({ where: { id }, data: { status: "REVOKED" } });
    await tx.employeeDocument.deleteMany({ where: { letterId: id } });
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "EmployeeLetter",
    entityId: id,
    entityLabel: `Revoked ${letter.letterNumber}`,
  });
  if (letter.userId) revalidatePath(`/people/${letter.userId}`);
  if (letter.candidateId) revalidatePath(`/people/hiring/${letter.candidateId}`);
  return { ok: true, data: null };
}
