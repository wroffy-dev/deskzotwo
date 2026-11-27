import { createHash } from "node:crypto";
import { redactSecrets } from "@/lib/console-shared/redact";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";

/**
 * The platform's own suppression list (owner, 31 Oct 2026: "should we use some global suppression list?").
 *
 * Mail through Deskzo's own servers — the platform's mail, and a workspace's documents sent "from Deskzo" — shares
 * one sending reputation, so an address one workspace's mail bounced from for good is not sent to again from any
 * workspace until it expires. Mail a workspace sends through its own provider carries its own reputation and keeps
 * its own list (marketing_suppressions); this one isn't asked there.
 *
 *   · **Only** a hard bounce (the server said the mailbox or domain doesn't exist) and a spam complaint. Never an
 *     unsubscribe — that belongs to the business it was given to, under the DPDP Act and GDPR alike.
 *   · **Kept by a hash**, never the address: the console can count the list and look an address up, but nobody can
 *     read who is on it, or which workspace's mail put them there. The server's words are kept without the address.
 *   · **Expires**: a bounce after 90 days (mailboxes are made again, people rejoin), a complaint after a year.
 *
 * Fails open: with no control plane, or the table not migrated yet, nothing is stopped — the list is a courtesy to
 * the sending reputation, and never the reason a sign-in code doesn't arrive.
 */
export type PlatformSuppressionReason = "HARD_BOUNCE" | "COMPLAINT";

const DAY = 86_400_000;
export const KEEP_DAYS: Record<PlatformSuppressionReason, number> = { HARD_BOUNCE: 90, COMPLAINT: 365 };

export const addressHash = (address: string) => createHash("sha256").update(address.trim().toLowerCase()).digest("hex");

/** The server's words, without the address or anything secret. */
function cleanDetail(detail: string | null | undefined, address: string): string | null {
  if (!detail) return null;
  const escaped = address.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (redactSecrets(detail.replace(new RegExp(escaped, "gi"), "<address>")) ?? "").slice(0, 300) || null;
}

/** On the list: kept from now, a complaint over a bounce, the later expiry of the two. Never throws. */
export async function recordPlatformSuppression(address: string, reason: PlatformSuppressionReason, detail?: string | null, now = new Date()): Promise<void> {
  if (!controlConfigured() || !address.trim()) return;
  const db = controlDb();
  const hash = addressHash(address);
  const expiresAt = new Date(now.getTime() + KEEP_DAYS[reason] * DAY);
  try {
    const was = await db.platformMailSuppression.findUnique({ where: { addressHash: hash }, select: { reason: true, expiresAt: true } });
    const keptReason = was?.reason === "COMPLAINT" ? "COMPLAINT" : reason;
    await db.platformMailSuppression.upsert({
      where: { addressHash: hash },
      create: { addressHash: hash, reason, detail: cleanDetail(detail, address), firstAt: now, lastAt: now, expiresAt },
      update: {
        reason: keptReason,
        detail: cleanDetail(detail, address),
        lastAt: now,
        expiresAt: was && was.expiresAt > expiresAt ? was.expiresAt : expiresAt,
        hits: { increment: 1 },
      },
    });
  } catch (err) {
    console.error("[mail] couldn't record a suppression:", err instanceof Error ? err.message : err);
  }
}

/** The first address on the list, and until when — counted as a send stopped. Null when none, or the list can't be read. */
export async function platformSuppressionFor(addresses: (string | null | undefined)[], now = new Date()): Promise<{ address: string; reason: PlatformSuppressionReason; until: Date } | null> {
  if (!controlConfigured()) return null;
  const wanted = [...new Set(addresses.map((a) => a?.trim().toLowerCase()).filter((a): a is string => !!a))];
  if (wanted.length === 0) return null;
  const hashes = new Map(wanted.map((a) => [addressHash(a), a]));
  try {
    const db = controlDb();
    const rows = await db.platformMailSuppression.findMany({ where: { addressHash: { in: [...hashes.keys()] }, expiresAt: { gt: now } }, select: { addressHash: true, reason: true, expiresAt: true } });
    const first = wanted.map((a) => rows.find((r) => r.addressHash === addressHash(a))).find(Boolean);
    if (!first) return null;
    await db.platformMailSuppression.update({ where: { addressHash: first.addressHash }, data: { stopped: { increment: 1 } } });
    return { address: hashes.get(first.addressHash)!, reason: first.reason as PlatformSuppressionReason, until: first.expiresAt };
  } catch (err) {
    console.error("[mail] couldn't read the suppression list:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** The refusal a stopped send carries. */
export function suppressionSentence(s: { address: string; reason: PlatformSuppressionReason; until: Date }): string {
  const why = s.reason === "COMPLAINT" ? "marked mail from Deskzo as spam" : "bounced mail from Deskzo for good — the mailbox or its domain doesn't exist";
  return `${s.address} ${why}, so it isn't mailed again until ${s.until.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}. Check it with them, or ask Deskzo support to take it off the list.`;
}

/**
 * Whether a refusal from the mail server says the recipient doesn't exist — a hard bounce — and for which addresses:
 * nodemailer's `rejected` when it names them, else the one recipient when there was only one. A refusal for policy
 * or a full mailbox isn't a bounce for this list.
 */
export function hardBounced(err: unknown, recipients: string[]): string[] {
  const e = err as { responseCode?: unknown; response?: unknown; message?: unknown; rejected?: unknown } | null;
  const code = typeof e?.responseCode === "number" ? e.responseCode : null;
  if (code === null || code < 500 || code >= 600) return [];
  const said = `${typeof e?.response === "string" ? e.response : ""} ${typeof e?.message === "string" ? e.message : ""}`;
  const noSuchRecipient =
    /\b5\.1\.(1|2|3|10)\b/.test(said) ||
    ((code === 550 || code === 551 || code === 553) && /user unknown|unknown user|no such (user|mailbox|recipient)|does not exist|doesn't exist|mailbox (not found|unavailable)|recipient (address )?rejected|address rejected|invalid recipient/i.test(said));
  if (!noSuchRecipient) return [];
  const rejected = Array.isArray(e?.rejected) ? e.rejected.filter((r): r is string => typeof r === "string") : [];
  if (rejected.length) return rejected;
  return recipients.length === 1 ? recipients : [];
}

/** For the console: the list in numbers, and the latest entries — by hash, never an address. */
export async function platformSuppressionOverview(now = new Date(), take = 100) {
  const db = controlDb();
  const live = { expiresAt: { gt: now } };
  const [bounces, complaints, stopped, latest] = await Promise.all([
    db.platformMailSuppression.count({ where: { ...live, reason: "HARD_BOUNCE" } }),
    db.platformMailSuppression.count({ where: { ...live, reason: "COMPLAINT" } }),
    db.platformMailSuppression.aggregate({ where: live, _sum: { stopped: true } }),
    db.platformMailSuppression.findMany({ where: live, orderBy: { lastAt: "desc" }, take }),
  ]);
  return { bounces, complaints, stopped: stopped._sum.stopped ?? 0, latest };
}

/** One address looked up by the console: its entry, or null. */
export async function platformSuppressionOf(address: string, now = new Date()) {
  const row = await controlDb().platformMailSuppression.findUnique({ where: { addressHash: addressHash(address) } });
  return row && row.expiresAt > now ? row : null;
}

/** Taken off the list — the customer fixed their mailbox. Whether it was on it. */
export async function removePlatformSuppression(address: string): Promise<boolean> {
  const { count } = await controlDb().platformMailSuppression.deleteMany({ where: { addressHash: addressHash(address) } });
  return count > 0;
}

/** Expired entries cleared, on the platform tick with the mail queue's own clean-up. */
export async function purgePlatformSuppressions(now = new Date()): Promise<number> {
  const { count } = await controlDb().platformMailSuppression.deleteMany({ where: { expiresAt: { lte: now } } });
  return count;
}
