import { createHash, randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notifyUser } from "@/lib/notify";
import { getOrganisation } from "@/lib/organisation";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { withinCallerBudget } from "@/lib/security/caller-budget";
import { callerKeyIp } from "@/lib/client-ip";
import { tenantKey } from "@/lib/tenancy/cache";
import { recordChanges } from "@/lib/smart-lists/history";
import { emitRowsAdded } from "@/lib/automate/emit-smart-lists";
import { OWN_ROWS, cleanTitle, titleNameOf } from "@/lib/smart-lists/own-rows";
import { FORM_KINDS, cleanFormFields, type FormQuestion } from "@/lib/smart-lists/forms";
import { optionsOf, parseValue, valueText, type PropertyKind } from "@/lib/smart-lists/values";
import { rightsFor } from "@/lib/smart-lists/access";
import { CONSENT_MAX, DEFAULT_CONSENT } from "@/lib/smart-lists/public-form-words";

/**
 * A form's public link (owner, 20 Nov 2026 — Smart Lists phase 4: "a public link for people outside the company — with
 * consent wording, spam protection, and answers that wait to be accepted before they become rows"). Anybody with the
 * link answers; nobody signs in. What they see: the form's name, what it's for and its questions — never the list's
 * name, its rows or anybody in the company (a Person question isn't asked on the public link).
 *
 * Spam: no CAPTCHA, as the company's own forms (src/actions/marketing-public.ts) — a hidden field and a minimum fill
 * time, answered as a success so a bot learns nothing; answers counted by the sender's network address (in memory,
 * src/lib/security/caller-budget.ts) and, hashed, in the database: per sender and per form an hour, and a cap on
 * answers waiting. The address itself is never kept.
 *
 * Consent: the builder writes the wording (Deskzo's to start); the box must be ticked, and the answer is refused if it
 * isn't. Answers wait (PENDING) until whoever may change the list accepts one — it becomes a row "from the public
 * form" — or declines it; either way the answer's own copy is emptied, the row holding what was kept. A builder may
 * turn waiting off: answers become rows at once, still behind the same spam checks. Decided answers are forgotten
 * after 90 days, and answers nobody decided too (tidyPublicAnswers). Server only.
 */

/** What a public form asks: as a form inside the company, less a Person (the company's people aren't shown outside). */
export const PUBLIC_KINDS: readonly PropertyKind[] = FORM_KINDS.filter((k) => k !== "PERSON");
export const PUBLIC_LIMITS = { consent: CONSENT_MAX, perSender: 5, perCaller: 10, perCallerAllForms: 30, perForm: 200, waiting: 500, keepDays: 90 } as const;
const HOUR_MS = 60 * 60_000;
const SLUG = /^[A-Za-z0-9_-]{10,40}$/;

export const newSlug = () => randomBytes(12).toString("base64url");

/** The consent wording as shown: {company} becomes the company's name. */
export function consentText(raw: string | null | undefined, ourName: string): string {
  const text = String(raw ?? "").trim() || DEFAULT_CONSENT;
  return text.replace(/\{company\}/gi, ourName).slice(0, PUBLIC_LIMITS.consent * 2);
}

type LinkRow = { formId: string; consent: string; approve: boolean; form: { id: string; name: string; intro: string | null; fields: Prisma.JsonValue; workbookId: string; createdByUserId: string | null; workbook: { name: string; ownerUserId: string } } };

/** An open public link: the link, its form and list open, and Smart Lists on in this workspace. */
async function openLink(slug: unknown): Promise<LinkRow | null> {
  if (typeof slug !== "string" || !SLUG.test(slug)) return null;
  if (!(await moduleAvailableForTenant("workspace"))) return null;
  const link = await db.workbookPublicForm
    .findUnique({
      where: { slug },
      select: {
        formId: true,
        consent: true,
        approve: true,
        active: true,
        form: { select: { id: true, name: true, intro: true, fields: true, active: true, workbookId: true, createdByUserId: true, workbook: { select: { name: true, mode: true, ownerUserId: true } } } },
      },
    })
    .catch(() => null);
  if (!link || !link.active || !link.form.active || link.form.workbook.mode !== "ROWS") return null;
  return { ...link, form: { ...link.form, workbook: { name: link.form.workbook.name, ownerUserId: link.form.workbook.ownerUserId } } };
}

async function questionsOf(link: LinkRow): Promise<(FormQuestion & { kind: PropertyKind })[]> {
  const props = await db.workbookProperty.findMany({ where: { workbookId: link.form.workbookId }, select: { id: true, name: true, kind: true, options: true } });
  return cleanFormFields(link.form.fields, props.map((p) => ({ id: p.id, kind: p.kind as PropertyKind })))
    .map((f) => {
      const p = props.find((x) => x.id === f.propertyId)!;
      return { propertyId: p.id, name: p.name, kind: p.kind as PropertyKind, options: optionsOf(p.options), required: f.required };
    })
    .filter((q) => PUBLIC_KINDS.includes(q.kind));
}

export type PublicForm = { slug: string; name: string; intro: string | null; titleName: string; questions: FormQuestion[]; consent: string; ourName: string };

/** A public form as a stranger sees it, or null — one answer for a link that never was, is closed, or is off. */
export async function publicFormFor(slug: unknown): Promise<PublicForm | null> {
  const link = await openLink(slug);
  if (!link) return null;
  const org = await getOrganisation();
  const ourName = org.tradeName || org.legalName || "us";
  return { slug: slug as string, name: link.form.name, intro: link.form.intro, titleName: await titleNameOf(link.form.workbookId), questions: await questionsOf(link), consent: consentText(link.consent, ourName), ourName };
}

/** Who is told answers wait: the form's maker while they may still change the list, otherwise the list's builder. */
async function decider(link: LinkRow): Promise<string> {
  const maker = link.form.createdByUserId;
  if (maker && maker !== link.form.workbook.ownerUserId) {
    const wb = await db.workbook.findUnique({ where: { id: link.form.workbookId }, select: { id: true, ownerUserId: true, shared: true } });
    const active = await db.user.findFirst({ where: { id: maker, active: true }, select: { id: true } });
    if (wb && active && (await rightsFor(maker, wb)).shape) return maker;
  }
  return link.form.workbook.ownerUserId;
}

export type PublicAnswerResult = { ok: true; thankYou: string } | { ok: false; error: string };

/** A stranger answers a public form. `caller`: their network address, when known — counted, never kept. */
export async function answerPublicForm(input: { slug: string; title: unknown; answers: unknown; consent: unknown; website?: unknown; elapsedMs?: unknown; caller: string | null }): Promise<PublicAnswerResult> {
  const link = await openLink(input.slug);
  if (!link) return { ok: false, error: "This form is closed." };
  const thankYou = link.approve ? "Thank you — your answers were sent." : "Thank you — your answers were received.";
  // Both bot checks answer with success: telling a bot it was caught only teaches it.
  if (typeof input.website === "string" && input.website.trim()) return { ok: true, thankYou };
  if (typeof input.elapsedMs === "number" && input.elapsedMs < 2000) return { ok: true, thankYou };
  if (input.consent !== true) return { ok: false, error: "Tick the box to agree — the answers can't be sent without it." };

  const titleName = await titleNameOf(link.form.workbookId);
  const title = cleanTitle(String(input.title ?? ""));
  if (!title) return { ok: false, error: `Fill in the ${titleName.toLowerCase()}.` };
  const raw = input.answers && typeof input.answers === "object" ? (input.answers as Record<string, unknown>) : {};
  const cells: { propertyId: string; value: Prisma.InputJsonValue }[] = [];
  let email: string | null = null;
  for (const q of await questionsOf(link)) {
    const parsed = parseValue(q.kind, raw[q.propertyId], q.options);
    if (!parsed.ok) return { ok: false, error: `${q.name}: ${parsed.error}` };
    if (parsed.value === null) {
      if (q.required) return { ok: false, error: `Fill in ${q.name}.` };
      continue;
    }
    if (q.kind === "EMAIL" && !email) email = String(parsed.value).toLowerCase().slice(0, 200);
    cells.push({ propertyId: q.propertyId, value: parsed.value as Prisma.InputJsonValue });
  }

  // How often from where — the address reduced (IPv6 by /64) and hashed, never kept as it is.
  const sender = input.caller ? callerKeyIp(input.caller) : (email ?? "unknown");
  if (input.caller) {
    const workspace = await tenantKey();
    const allowed = withinCallerBudget(
      [
        { key: `${workspace}|list-form-caller:${link.formId}:${sender}`, max: PUBLIC_LIMITS.perCaller },
        { key: `${workspace}|list-forms-caller:${sender}`, max: PUBLIC_LIMITS.perCallerAllForms },
      ],
      HOUR_MS,
    );
    if (!allowed) return { ok: false, error: "Too many answers just now. Try again in a little while." };
  }
  const sourceHash = createHash("sha256").update(`${sender}:${link.formId}`).digest("hex").slice(0, 32);
  const since = new Date(Date.now() - HOUR_MS);
  const workbookId = link.form.workbookId;
  if (!link.approve && (await db.workbookRow.count({ where: { workbookId } })) >= OWN_ROWS.perList) return { ok: false, error: "This form isn't taking answers just now." };
  const last = link.approve ? null : await db.workbookRow.aggregate({ where: { workbookId }, _max: { sortOrder: true } });

  let done: { kind: "busy" } | { kind: "waiting"; firstInAnHour: boolean } | { kind: "row"; rowId: string };
  try {
    done = await db.$transaction(async (tx) => {
      // Counted under the form's lock, where the answer is written: a burst can't all read "under the limit".
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`deskzo:list-form-rate:${link.formId}`}))`;
      const fromSender = await tx.workbookFormSubmission.count({ where: { formId: link.formId, sourceHash, createdAt: { gte: since } } });
      const onForm = await tx.workbookFormSubmission.count({ where: { formId: link.formId, createdAt: { gte: since } } });
      if (fromSender >= PUBLIC_LIMITS.perSender || onForm >= PUBLIC_LIMITS.perForm) return { kind: "busy" as const };
      if (link.approve) {
        if ((await tx.workbookFormSubmission.count({ where: { formId: link.formId, status: "PENDING" } })) >= PUBLIC_LIMITS.waiting) return { kind: "busy" as const };
        const recent = await tx.workbookFormSubmission.count({ where: { formId: link.formId, status: "PENDING", createdAt: { gte: since } } });
        const answers = Object.fromEntries(cells.map((c) => [c.propertyId, c.value])) as Prisma.InputJsonValue;
        await tx.workbookFormSubmission.create({ data: { formId: link.formId, workbookId, title, answers, email, sourceHash }, select: { id: true } });
        return { kind: "waiting" as const, firstInAnHour: recent === 0 };
      }
      const row = await tx.workbookRow.create({ data: { workbookId, title, sortOrder: (last?._max.sortOrder ?? 0) + 10, createdByUserId: null, updatedByUserId: null }, select: { id: true, title: true } });
      if (cells.length) await tx.workbookRowValue.createMany({ data: cells.map((c) => ({ workbookId, rowId: row.id, propertyId: c.propertyId, value: c.value, updatedByUserId: null })) });
      // Kept only to count: what was answered is the row now.
      await tx.workbookFormSubmission.create({ data: { formId: link.formId, workbookId, title: "", answers: {}, email: null, sourceHash, status: "ACCEPTED", rowId: row.id, decidedAt: new Date() }, select: { id: true } });
      await emitRowsAdded(tx, [{ workbookId, listName: link.form.workbook.name, own: true, rowKey: row.id, title: row.title }], "form", null);
      return { kind: "row" as const, rowId: row.id };
    });
  } catch {
    return { ok: false, error: "This form isn't taking answers just now." };
  }
  if (done.kind === "busy") return { ok: false, error: "This form isn't taking answers just now. Try again in a little while." };
  if (done.kind === "row") {
    await recordChanges([{ workbookId, rowKey: done.rowId, kind: "ADDED", after: `the public form "${link.form.name}"`, byUserId: null }]);
    return { ok: true, thankYou };
  }
  // Told once an hour at most, however many answers come.
  if (done.firstInAnHour) {
    await notifyUser({
      userId: await decider(link),
      type: "SMART_LIST_SUBMISSION",
      title: `An answer to "${link.form.name}" waits for you`,
      message: `Somebody answered the public form of ${link.form.workbook.name}. Accept it to add it as a row, or decline it.`,
      link: `/smart-lists/${workbookId}?answers=1`,
    });
  }
  return { ok: true, thankYou };
}

export type WaitingAnswer = { id: string; formName: string; title: string; email: string | null; at: string; lines: { name: string; text: string }[] };

/** A list's answers waiting to be accepted, oldest first — for whoever may change the list (the caller checks). */
export async function waitingAnswers(workbookId: string): Promise<WaitingAnswer[]> {
  const rows = await db.workbookFormSubmission
    .findMany({ where: { workbookId, status: "PENDING" }, orderBy: { createdAt: "asc" }, take: PUBLIC_LIMITS.waiting, select: { id: true, formId: true, title: true, email: true, answers: true, createdAt: true } })
    .catch(() => []);
  if (!rows.length) return [];
  const [forms, props] = await Promise.all([
    db.workbookForm.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.formId))] } }, select: { id: true, name: true } }),
    db.workbookProperty.findMany({ where: { workbookId }, orderBy: { sortOrder: "asc" }, select: { id: true, name: true, kind: true, options: true } }),
  ]);
  const formName = new Map(forms.map((f) => [f.id, f.name]));
  return rows.map((r) => {
    const answers = (r.answers && typeof r.answers === "object" ? r.answers : {}) as Record<string, unknown>;
    const lines = props
      .filter((p) => answers[p.id] !== undefined && answers[p.id] !== null)
      .map((p) => ({ name: p.name, text: valueText(p.kind as PropertyKind, answers[p.id], optionsOf(p.options)) }))
      .filter((l) => l.text);
    return { id: r.id, formName: formName.get(r.formId) ?? "A form", title: r.title, email: r.email, at: r.createdAt.toISOString(), lines };
  });
}

/**
 * Accept (a row "from the public form", added by whoever accepted it) or decline a waiting answer. Its answers are
 * read again against the list as it is now: a column since deleted, or changed so the answer no longer fits, is left
 * out rather than refusing the row. The answer's own copy is emptied either way. The caller checks who may.
 */
export async function decideAnswer(input: { workbookId: string; submissionId: string; accept: boolean; userId: string }): Promise<{ ok: true; rowId: string | null } | { ok: false; error: string }> {
  const sub = await db.workbookFormSubmission.findFirst({ where: { id: input.submissionId, workbookId: input.workbookId }, select: { id: true, formId: true, status: true, title: true, answers: true } }).catch(() => null);
  if (!sub || sub.status !== "PENDING") return { ok: false, error: "That answer was already decided." };
  const forgotten = { title: "", answers: {}, email: null, decidedAt: new Date(), decidedByUserId: input.userId };
  if (!input.accept) {
    const n = await db.workbookFormSubmission.updateMany({ where: { id: sub.id, status: "PENDING" }, data: { ...forgotten, status: "DECLINED" } });
    return n.count ? { ok: true, rowId: null } : { ok: false, error: "That answer was already decided." };
  }
  if ((await db.workbookRow.count({ where: { workbookId: input.workbookId } })) >= OWN_ROWS.perList) return { ok: false, error: "This list is full — delete some rows first." };
  const [form, wb, props, last] = await Promise.all([
    db.workbookForm.findUnique({ where: { id: sub.formId }, select: { name: true } }),
    db.workbook.findUnique({ where: { id: input.workbookId }, select: { name: true } }),
    db.workbookProperty.findMany({ where: { workbookId: input.workbookId }, select: { id: true, kind: true, options: true } }),
    db.workbookRow.aggregate({ where: { workbookId: input.workbookId }, _max: { sortOrder: true } }),
  ]);
  const answers = (sub.answers && typeof sub.answers === "object" ? sub.answers : {}) as Record<string, unknown>;
  const cells: { propertyId: string; value: Prisma.InputJsonValue }[] = [];
  for (const p of props) {
    if (answers[p.id] === undefined || !PUBLIC_KINDS.includes(p.kind as PropertyKind)) continue;
    const parsed = parseValue(p.kind as PropertyKind, answers[p.id], optionsOf(p.options));
    if (parsed.ok && parsed.value !== null) cells.push({ propertyId: p.id, value: parsed.value as Prisma.InputJsonValue });
  }
  const formName = form?.name ?? "a form";
  const rowId = await db.$transaction(async (tx) => {
    const claimed = await tx.workbookFormSubmission.updateMany({ where: { id: sub.id, status: "PENDING" }, data: { ...forgotten, status: "ACCEPTED" } });
    if (!claimed.count) return null;
    const row = await tx.workbookRow.create({
      data: { workbookId: input.workbookId, title: cleanTitle(sub.title) || "An answer", sortOrder: (last._max.sortOrder ?? 0) + 10, createdByUserId: input.userId, updatedByUserId: input.userId },
      select: { id: true, title: true },
    });
    if (cells.length) await tx.workbookRowValue.createMany({ data: cells.map((c) => ({ workbookId: input.workbookId, rowId: row.id, propertyId: c.propertyId, value: c.value, updatedByUserId: input.userId })) });
    await tx.workbookFormSubmission.update({ where: { id: sub.id }, data: { rowId: row.id } });
    await emitRowsAdded(tx, [{ workbookId: input.workbookId, listName: wb?.name ?? "", own: true, rowKey: row.id, title: row.title }], "form", input.userId);
    return row.id;
  });
  if (!rowId) return { ok: false, error: "That answer was already decided." };
  await recordChanges([{ workbookId: input.workbookId, rowKey: rowId, kind: "ADDED", after: `the public form "${formName}"`, byUserId: input.userId }]);
  return { ok: true, rowId };
}

/** Answers kept 90 days at most — decided ones (kept only to count) and ones nobody decided. Never throws. */
export async function tidyPublicAnswers(now: Date = new Date()): Promise<number> {
  try {
    const before = new Date(now.getTime() - PUBLIC_LIMITS.keepDays * 24 * HOUR_MS);
    return (await db.workbookFormSubmission.deleteMany({ where: { createdAt: { lt: before } } })).count;
  } catch {
    return 0;
  }
}
