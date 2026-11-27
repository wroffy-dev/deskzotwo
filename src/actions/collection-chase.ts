"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireModuleUser, moduleAvailableForTenant } from "@/lib/modules-access";
import { refuseWhileViewingAs } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { copilotConfig } from "@/lib/copilot/settings";
import { formatMoney } from "@/lib/currency";
import { notifyUser } from "@/lib/notify";
import { workspaceClock } from "@/lib/time/workspace";
import { mayLogFollowUps } from "@/lib/collections/load";
import { shortDay } from "@/lib/collections/rules";
import { isChaseTone } from "@/lib/collections/chase";
import {
  ChaseRefusal,
  accountsPerson,
  chaseListFor,
  chaseView,
  closeReply,
  discardChase,
  draftChase,
  openReply,
  repliesFor,
  sendChase,
  waitingChasesFor,
  type ChaseList,
  type ChaseView,
  type ReplyView,
  type WaitingChase,
} from "@/lib/collections/chase-server";
import { logFollowUp } from "@/actions/collections";
import { setRemindersPaused } from "@/actions/payment-collection";
import type { ActionResult } from "@/actions/company";

/**
 * Arjun, the Collections teammate (owner, 19 Nov 2026 — src/lib/collections/chase-server.ts). Everything here takes what
 * My collections takes — `collections.followUp` or `payments.record`, with `payments.view` — and works only on dues in the
 * person's own collections. Drafting also takes "Use Deskzo AI" with Deskzo AI switched on. Never while viewing as
 * somebody.
 */

async function who(): Promise<{ id: string; name: string } | { error: string }> {
  const user = await requireModuleUser("receivables");
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { error: viewingAs };
  if (!(await mayLogFollowUps(user.id))) return { error: "You don't follow up payments, so Arjun can't work on them for you." };
  return { id: user.id, name: user.name ?? "Somebody" };
}

function refusal<T>(err: unknown): ActionResult<T> {
  if (err instanceof ChaseRefusal) return { ok: false, error: err.message };
  throw err;
}

/** Arjun drafts a chase email to one customer, in the tone asked for or the one the facts call for; the draft comes back. */
export async function draftChaseEmail(input: { companyId: string; tone?: string | null }): Promise<ActionResult<ChaseView>> {
  const user = await who();
  if ("error" in user) return { ok: false, error: user.error };
  if (!(await copilotConfig()).enabled) return { ok: false, error: "Deskzo AI is switched off for this workspace." };
  if (!(await can(user.id, "copilot.use"))) return { ok: false, error: "Drafting with Arjun takes the “Use Deskzo AI” permission." };
  try {
    const id = await draftChase(user.id, String(input?.companyId ?? ""), isChaseTone(input?.tone) ? input.tone : null);
    const view = await chaseView(id, user.id);
    if (!view) return { ok: false, error: "The draft wasn't found." };
    revalidatePath("/collections");
    return { ok: true, data: view };
  } catch (err) {
    return refusal(err);
  }
}

/** A draft, to read and change. */
export async function openChaseEmail(id: string): Promise<ActionResult<ChaseView>> {
  const user = await who();
  if ("error" in user) return { ok: false, error: user.error };
  const view = await chaseView(String(id ?? ""), user.id);
  return view ? { ok: true, data: view } : { ok: false, error: "That chase email isn't there any more." };
}

export async function sendChaseEmail(input: { id: string; subject: string; body: string; contactIds: string[]; attachStatement: boolean }): Promise<ActionResult<{ to: string[] }>> {
  const user = await who();
  if ("error" in user) return { ok: false, error: user.error };
  try {
    const sent = await sendChase(String(input?.id ?? ""), user.id, {
      subject: String(input?.subject ?? ""),
      body: String(input?.body ?? ""),
      contactIds: Array.isArray(input?.contactIds) ? input.contactIds.map(String).slice(0, 50) : [],
      attachStatement: input?.attachStatement === true,
    });
    revalidatePath("/collections");
    revalidatePath("/today");
    return { ok: true, data: sent };
  } catch (err) {
    return refusal(err);
  }
}

export async function discardChaseEmail(id: string): Promise<ActionResult<null>> {
  const user = await who();
  if ("error" in user) return { ok: false, error: user.error };
  try {
    await discardChase(String(id ?? ""), user.id);
    revalidatePath("/collections");
    revalidatePath("/today");
    return { ok: true, data: null };
  } catch (err) {
    return refusal(err);
  }
}

export type ReplyAction = "promise" | "paid" | "dispute" | "done" | "dismiss";

/**
 * What a person does with a customer's reply, as Arjun suggested or otherwise:
 *
 *   · promise — a promise to pay by the day (and, for one invoice, the amount) logged on each invoice, through the same
 *     Log follow-up anybody uses — so it's tracked, flagged if broken, and the reminders wait for it;
 *   · paid — accounts asked to check the bank, as a task (the person reminders go out as, where they record payments);
 *   · dispute — the customer's reminders paused, and accounts asked to sort it out;
 *   · done — noted as a follow-up and closed; dismiss — set aside, nothing noted.
 */
export async function actOnChaseReply(input: { replyId: string; action: ReplyAction; promisedOn?: string | null; promisedAmount?: number | null; documentIds?: string[] }): Promise<ActionResult<{ outcome: string }>> {
  const user = await who();
  if ("error" in user) return { ok: false, error: user.error };
  const reply = await openReply(String(input?.replyId ?? ""), user.id);
  if (!reply) return { ok: false, error: "That reply isn't there any more." };
  if (reply.status !== "OPEN") return { ok: false, error: "Somebody has dealt with this reply already." };
  const action = input?.action;
  const company = reply.chase.company.name;
  const heard = `Replied by email${reply.fromName ? ` (${reply.fromName})` : ""}: ${reply.summary ?? reply.subject}`.slice(0, 1000);
  // The invoices it's about: those ticked, of the email's own.
  const asked = Array.isArray(input?.documentIds) ? input.documentIds.map(String) : [];
  const about = (asked.length ? asked : reply.documentIds.length ? reply.documentIds : reply.chase.documentIds).filter((id) => reply.chase.documentIds.includes(id));

  const noteOn = async (documentIds: string[]) => {
    for (const documentId of documentIds.slice(0, 1)) await logFollowUp({ documentId, channel: "EMAIL", remarks: heard });
  };
  const taskFor = async (title: string, description: string) => {
    const assignee = await accountsPerson(user.id);
    if (await moduleAvailableForTenant("tasks")) {
      await db.task.create({
        data: {
          title: title.slice(0, 500),
          description: description.slice(0, 5000),
          dueDate: (await workspaceClock()).calendarDate(new Date()),
          assignedToUserId: assignee,
          createdByUserId: user.id,
          companyId: reply.chase.companyId,
          status: "TODO",
          priority: "HIGH",
        },
        select: { id: true },
      });
    } else {
      await notifyUser({ userId: assignee, type: "PAYMENT_FOLLOW_UP_DUE", title, message: description.slice(0, 500), link: "/collections" });
    }
    return assignee;
  };

  if (action === "promise") {
    const on = String(input?.promisedOn ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) return { ok: false, error: "Pick the day they promised to pay by." };
    if (!about.length) return { ok: false, error: "Tick the invoices the promise is for." };
    const amount = about.length === 1 && typeof input?.promisedAmount === "number" && input.promisedAmount > 0 ? input.promisedAmount : undefined;
    let logged = 0;
    let firstError: string | null = null;
    for (const documentId of about) {
      const r = await logFollowUp({ documentId, channel: "EMAIL", remarks: heard, promisedOn: on, ...(amount !== undefined ? { promisedAmount: amount } : {}) });
      if (r.ok) logged += 1;
      else firstError ??= r.error;
    }
    if (!logged) return { ok: false, error: firstError ?? "The promise couldn't be logged." };
    const outcome = `Promise logged: to pay by ${shortDay(on)}, on ${logged === 1 ? "1 invoice" : `${logged} invoices`}`;
    await closeReply(reply.id, user.id, "DONE", outcome);
    revalidatePath("/collections");
    return { ok: true, data: { outcome } };
  }

  if (action === "paid") {
    const amount = reply.paidAmount !== null ? ` ${formatMoney(Number(reply.paidAmount))}` : "";
    const on = reply.paidOn ? ` on ${shortDay(reply.paidOn.toISOString())}` : "";
    const ref = reply.reference ? ` (ref ${reply.reference})` : "";
    const assignee = await taskFor(`Check the bank: ${company} say they've paid${amount}${on}${ref}`, `${heard}\n\nIf it's there, record it against their invoices; if not, tell ${user.name}.`);
    await noteOn(about);
    const outcome = assignee === user.id ? "A task to check the bank, for you" : "Accounts asked to check the bank";
    await closeReply(reply.id, user.id, "DONE", outcome);
    revalidatePath("/collections");
    return { ok: true, data: { outcome } };
  }

  if (action === "dispute") {
    const why = `Disputed by email: ${reply.detail ?? reply.summary ?? reply.subject}`.slice(0, 300);
    const paused = await setRemindersPaused(reply.chase.companyId, true, why);
    if (!paused.ok) return { ok: false, error: paused.error };
    await taskFor(`Sort out ${company}'s query`, `${heard}${reply.detail ? `\n\nWhat they question: ${reply.detail}` : ""}\n\nTheir payment reminders are paused until somebody resumes them on the Statement tab.`);
    await noteOn(about);
    const outcome = "Reminders paused, and a task to sort it out";
    await closeReply(reply.id, user.id, "DONE", outcome);
    revalidatePath("/collections");
    return { ok: true, data: { outcome } };
  }

  if (action === "done") {
    await noteOn(about);
    await closeReply(reply.id, user.id, "DONE", "Noted as a follow-up");
    revalidatePath("/collections");
    return { ok: true, data: { outcome: "Noted as a follow-up" } };
  }

  if (action === "dismiss") {
    await closeReply(reply.id, user.id, "DISMISSED", "Set aside");
    revalidatePath("/collections");
    return { ok: true, data: { outcome: "Set aside" } };
  }
  return { ok: false, error: "Pick what to do with it." };
}

export type ArjunToday = {
  list: ChaseList["items"];
  considered: number;
  waiting: WaitingChase[];
  replies: ReplyView[];
  /** May press "Draft email": Deskzo AI on, and theirs to use. */
  mayDraft: boolean;
};

/** Arjun's part of My collections: who to chase today, drafts waiting, and replies to act on. Null for somebody who can't. */
export async function arjunForMe(): Promise<ArjunToday | null> {
  const user = await requireModuleUser("receivables");
  if (!(await mayLogFollowUps(user.id))) return null;
  const [list, waiting, replies, config, mayUse] = await Promise.all([chaseListFor(user.id), waitingChasesFor(user.id), repliesFor(user.id), copilotConfig(), can(user.id, "copilot.use")]);
  return { list: list.items, considered: list.considered, waiting, replies, mayDraft: config.enabled && mayUse };
}
