import { Prisma, type PlatformMailJob } from "@deskzo/control-client";
import { controlDb } from "@/lib/platform/control-db";
import { deliverMail, platformMailerReplaced, sendPlatformMail, type PlatformMail } from "@/lib/platform/mailer";
import { redactSecrets } from "@/lib/console-shared/redact";

/**
 * The platform's mail queue (owner, 30 Oct 2026 — docs: Deskzo at scale, Part 1): a mail raised where nobody waits
 * for it — a notification, a billing reminder, a report, an alert — is written here and tried at once in the
 * background, so the page that raised it never waits on the mail provider, and a send that fails is tried again
 * instead of lost:
 *
 *   · at once, then after 1 min, 5 min, 30 min, 2 h and 12 h — six tries over about fourteen hours;
 *   · a permanent refusal (the server's 5xx: no such mailbox, refused for policy) goes DEAD at once — trying again
 *     would only be refused again;
 *   · DEAD ones wait on the console (Mail log › Queue) with Try again, and raise an alert (`mail.dead`);
 *   · claimed with SELECT … FOR UPDATE SKIP LOCKED, so two workers — or the worker and the background try — never
 *     send the same mail; one held past its lock (a crash mid-send) is queued again;
 *   · a caller's `key` is the mail's identity: the same key again is the same mail, never a second one.
 *
 * What still waits on the send, because a person is looking at the result (a sign-in code, a document, a helpdesk
 * reply), calls sendPlatformMail as before. A sent mail's body is dropped after a day; its row, after a week; a dead
 * one, after two weeks. Every try is in the Mail log as before (deliverMail records it).
 */

export const RETRY_AFTER_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000] as const;
export const MAX_ATTEMPTS = RETRY_AFTER_MS.length + 1;
const LOCK_MS = 2 * 60_000;
/** Sign-in and account mail first, alerts next, everything else after. */
const PRIORITY: Record<string, number> = { ACCOUNT: 0, ALERTS: 1 };
/** An attachment past this is refused at queueing: the queue isn't a file store. */
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

type StoredMail = Omit<PlatformMail, "attachments"> & { attachments?: { filename: string; contentType: string; base64: string }[] };

const toStored = (mail: PlatformMail): StoredMail => ({
  ...mail,
  ...(mail.attachments?.length ? { attachments: mail.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, base64: a.content.toString("base64") })) } : { attachments: undefined }),
});
const fromStored = (s: StoredMail): PlatformMail => ({
  ...s,
  ...(s.attachments?.length ? { attachments: s.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.base64, "base64") })) } : { attachments: undefined }),
});

export type QueueOptions = {
  /** The mail's identity: queued once, whatever happens to the caller. At most 200 characters. */
  key?: string;
  /** The workspace it was raised in, for the console's list. */
  tenant?: string | null;
  /** Leave it for the worker instead of trying it at once (a check, or a burst better spread out). */
  noKick?: boolean;
};

/**
 * Queues a mail and tries it at once in the background; resolves as soon as it is written. Never throws for a mail
 * that can't be sent now — it is tried again. Throws only for one that can't be queued (too big, no database).
 */
export async function queuePlatformMail(mail: PlatformMail, options: QueueOptions = {}): Promise<{ id: string | null; duplicate: boolean }> {
  // A check that replaced the sender reads what was sent, there and then: no queue in between.
  if (platformMailerReplaced()) {
    await sendPlatformMail(mail);
    return { id: null, duplicate: false };
  }
  const payload = toStored(mail);
  const size = Buffer.byteLength(JSON.stringify(payload));
  if (size > MAX_PAYLOAD_BYTES) throw new Error(`That mail is ${Math.round(size / 1024 / 1024)} MB — the queue takes up to 8 MB.`);
  const key = options.key?.slice(0, 200);
  try {
    const job = await controlDb().platformMailJob.create({
      data: {
        type: mail.type,
        priority: PRIORITY[mail.type] ?? 5,
        payload: payload as unknown as Prisma.InputJsonValue,
        to: mail.to.slice(0, 320),
        subject: (mail.logSubject ?? mail.subject).slice(0, 300),
        tenant: options.tenant?.slice(0, 64) ?? null,
        key: key ?? null,
      },
      select: { id: true },
    });
    if (!options.noKick) void sendJob(job.id).catch(() => undefined);
    return { id: job.id, duplicate: false };
  } catch (err) {
    if (key && err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const same = await controlDb().platformMailJob.findUnique({ where: { key }, select: { id: true } });
      return { id: same?.id ?? null, duplicate: true };
    }
    throw err;
  }
}

/** Whether the server refused for good: a 5xx reply to the mail itself. A 4xx, a timeout or a lost connection is worth another try. */
export function permanentRefusal(err: unknown): boolean {
  const code = (err as { responseCode?: unknown } | null)?.responseCode;
  return typeof code === "number" && code >= 500 && code < 600;
}

const errorText = (err: unknown) => (redactSecrets(err instanceof Error ? err.message : String(err)) ?? "failed").slice(0, 500);

/** Sends one claimed job, and records how it went. */
async function deliver(job: PlatformMailJob, now: () => Date): Promise<"sent" | "retry" | "dead"> {
  const db = controlDb();
  const attempts = job.attempts + 1;
  try {
    await deliverMail(fromStored(job.payload as unknown as StoredMail));
    await db.platformMailJob.update({ where: { id: job.id }, data: { status: "SENT", attempts, sentAt: now(), lockedUntil: null, lastError: null } });
    return "sent";
  } catch (err) {
    const dead = attempts >= MAX_ATTEMPTS || permanentRefusal(err);
    await db.platformMailJob.update({
      where: { id: job.id },
      data: dead
        ? { status: "DEAD", attempts, lockedUntil: null, lastError: errorText(err) }
        : { status: "QUEUED", attempts, lockedUntil: null, lastError: errorText(err), nextAttemptAt: new Date(now().getTime() + RETRY_AFTER_MS[attempts - 1]!) },
    });
    return dead ? "dead" : "retry";
  }
}

/** One job, now, if it is still waiting and nobody holds it — the background try right after queueing. */
export async function sendJob(id: string, now: () => Date = () => new Date()): Promise<"sent" | "retry" | "dead" | "taken"> {
  const until = new Date(now().getTime() + LOCK_MS);
  const claimed = await controlDb().$queryRaw<PlatformMailJob[]>`
    update "platform_mail_jobs" set "status" = 'SENDING', "lockedUntil" = ${until}
    where "id" = ${id} and "status" = 'QUEUED' and "nextAttemptAt" <= ${now()}
    returning *`;
  return claimed[0] ? deliver(claimed[0], now) : "taken";
}

/**
 * The worker's turn: puts back what a crash left held, then sends what is due, most urgent first, until `max` are
 * sent or `budgetMs` is spent. Safe beside other workers (SKIP LOCKED).
 */
export async function drainMailQueue({ max = 50, budgetMs = 20_000, now = () => new Date() }: { max?: number; budgetMs?: number; now?: () => Date } = {}): Promise<{ sent: number; retry: number; dead: number; requeued: number }> {
  const db = controlDb();
  const requeued = await db.platformMailJob.updateMany({ where: { status: "SENDING", lockedUntil: { lt: now() } }, data: { status: "QUEUED", lockedUntil: null } });
  const out = { sent: 0, retry: 0, dead: 0, requeued: requeued.count };
  const deadline = Date.now() + budgetMs;
  while (out.sent + out.retry + out.dead < max && Date.now() < deadline) {
    const until = new Date(now().getTime() + LOCK_MS);
    const claimed = await db.$queryRaw<PlatformMailJob[]>`
      update "platform_mail_jobs" set "status" = 'SENDING', "lockedUntil" = ${until}
      where "id" = (
        select "id" from "platform_mail_jobs"
        where "status" = 'QUEUED' and "nextAttemptAt" <= ${now()}
        order by "priority", "createdAt"
        for update skip locked
        limit 1
      )
      returning *`;
    if (!claimed[0]) break;
    out[await deliver(claimed[0], now)] += 1;
  }
  return out;
}

/** Try again: a dead mail, or a waiting one, sent on the worker's next turn with its tries counted afresh. */
export async function retryMailJob(id: string): Promise<boolean> {
  const { count } = await controlDb().platformMailJob.updateMany({ where: { id, status: { in: ["DEAD", "QUEUED"] } }, data: { status: "QUEUED", attempts: 0, nextAttemptAt: new Date(), lockedUntil: null } });
  return count === 1;
}

/** Gives up on one: removed, as if never queued. */
export async function dropMailJob(id: string): Promise<boolean> {
  const { count } = await controlDb().platformMailJob.deleteMany({ where: { id, status: { in: ["DEAD", "QUEUED"] } } });
  return count === 1;
}

export type QueueStats = { queued: number; due: number; dead: number; oldestDue: Date | null };

/** What the alerts and the console read. */
export async function mailQueueStats(now = new Date()): Promise<QueueStats> {
  const db = controlDb();
  const [queued, due, dead, oldest] = await Promise.all([
    db.platformMailJob.count({ where: { status: { in: ["QUEUED", "SENDING"] } } }),
    db.platformMailJob.count({ where: { status: "QUEUED", nextAttemptAt: { lte: now } } }),
    db.platformMailJob.count({ where: { status: "DEAD" } }),
    db.platformMailJob.findFirst({ where: { status: "QUEUED", nextAttemptAt: { lte: now } }, orderBy: { nextAttemptAt: "asc" }, select: { nextAttemptAt: true } }),
  ]);
  return { queued, due, dead, oldestDue: oldest?.nextAttemptAt ?? null };
}

/** The console's list: dead ones first, then what waits, newest first within each. */
export async function listMailJobs(take = 100) {
  return controlDb().platformMailJob.findMany({
    where: { status: { in: ["DEAD", "QUEUED", "SENDING"] } },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: Math.min(Math.max(take, 1), 500),
    select: { id: true, type: true, to: true, subject: true, tenant: true, status: true, attempts: true, nextAttemptAt: true, lastError: true, createdAt: true },
  });
}

/** A sent mail's body after a day, its row after a week, a dead one after two weeks — with the platform tick's daily chores. */
export async function purgeMailJobs(now = new Date()): Promise<{ emptied: number; removed: number }> {
  const db = controlDb();
  const day = 86_400_000;
  const emptied = await db.platformMailJob.updateMany({ where: { status: "SENT", sentAt: { lt: new Date(now.getTime() - day) }, NOT: { payload: { equals: {} } } }, data: { payload: {} } });
  const removed = await db.platformMailJob.deleteMany({
    where: { OR: [{ status: "SENT", sentAt: { lt: new Date(now.getTime() - 7 * day) } }, { status: "DEAD", createdAt: { lt: new Date(now.getTime() - 14 * day) } }] },
  });
  return { emptied: emptied.count, removed: removed.count };
}
