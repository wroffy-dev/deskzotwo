"use server";

import type { ConsoleResult } from "@/actions/platform/console";
import { ENTER, consoleAudit, consoleRefusal, revalidateConsole } from "@/lib/platform/console-guard";
import { ConsoleRefused } from "@/lib/platform/refused";
import { dropMailJob, retryMailJob } from "@/lib/platform/mail/queue";
import { StaffRefused, requireStaff } from "@/lib/platform/staff-session";

/**
 * Mail log › Queue (src/lib/platform/mail/queue.ts — owner, 30 Oct 2026): a mail given up on, tried again or dropped,
 * by the staff who answer for delivery (the Mail log's own gate). Audited by id — never the address or the subject.
 */

async function act(id: unknown, what: "retry" | "drop"): Promise<ConsoleResult<null>> {
  let staff;
  try {
    staff = await requireStaff(ENTER);
  } catch (err) {
    if (err instanceof StaffRefused) return { ok: false, error: err.message };
    throw err;
  }
  try {
    const jobId = String(id ?? "");
    if (!/^[a-z0-9]{10,40}$/i.test(jobId)) throw new ConsoleRefused("That isn't a mail in the queue.");
    const done = what === "retry" ? await retryMailJob(jobId) : await dropMailJob(jobId);
    if (!done) throw new ConsoleRefused("That mail isn't waiting any more — it may have been sent, or dropped.");
    await consoleAudit(staff, what === "retry" ? "mail.queue.retry" : "mail.queue.drop", { id: jobId });
    revalidateConsole();
    return { ok: true, data: null };
  } catch (err) {
    const refusal = consoleRefusal(err);
    if (refusal !== null) return { ok: false, error: refusal };
    throw err;
  }
}

export async function consoleRetryMail(id: unknown): Promise<ConsoleResult<null>> {
  return act(id, "retry");
}

export async function consoleDropMail(id: unknown): Promise<ConsoleResult<null>> {
  return act(id, "drop");
}
