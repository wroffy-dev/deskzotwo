import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { workplaceAccess } from "@/lib/mail/mailbox";
import { STILL_THERE } from "@/lib/contacts/left";
import { companiesByDomain, emailDomain } from "@/lib/support-mail/domain-match";
import { isFreeMailbox } from "@/lib/email-verification";
import { addressOf, isMailReader, websiteDomain, type MailReader } from "@/lib/mail-reading/agents";
import { grantsRead, readMailbox, type ReadMail } from "@/lib/mail-reading/providers";

/**
 * Reading people's connected mailboxes for the AI teammates (owner, 23 Nov 2026: "lets give agent access to read mails !
 * this will be admin based if he wants to give access or not"; chosen: every connected mailbox, only mail with known
 * parties, per agent and per mailbox).
 *
 *   · Off until an admin turns it on (MailReadSettings), and then only for the people and agents the admin ticks
 *     (MailReadGrant). The provider's own permission to read comes from each person reconnecting once — Deskzo asks.
 *   · Only mail to or from somebody already in Deskzo is kept: a contact by address, else one company by its contacts'
 *     domain or its website — never by a free-mail domain, never the workspace's own. Internal mail, personal mail and
 *     strangers' mail is read past and never kept. Text is kept short; attachments aren't kept.
 *   · Reading starts from the moment it's turned on for a mailbox — no history — and goes forward each heartbeat.
 *   · What an agent reads is logged (MailReadLog) — the admin's record of what the AI saw.
 */

export type MailReadingView = {
  ready: boolean;
  enabled: boolean;
  people: { userId: string; name: string; mailbox: string; provider: string; canRead: boolean; broken: boolean; agents: MailReader[]; lastRunAt: string | null; lastError: string | null; kept: number }[];
};

export async function mailReadingEnabled(): Promise<boolean> {
  try {
    return (await db.mailReadSettings.findUnique({ where: { id: "default" }, select: { enabled: true } }))?.enabled === true;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
}

/** The admin's screen: the switch, and every connected mailbox with what it allows and who may read it. */
export async function mailReadingView(): Promise<MailReadingView> {
  try {
    const [enabled, connections, grants, cursors] = await Promise.all([
      mailReadingEnabled(),
      db.mailConnection.findMany({ where: { user: { active: true } }, orderBy: { user: { name: "asc" } }, select: { userId: true, provider: true, mailbox: true, scopes: true, brokenAt: true, user: { select: { name: true } } } }),
      db.mailReadGrant.findMany({ select: { userId: true, agent: true } }),
      db.mailReadCursor.findMany({ select: { userId: true, lastRunAt: true, lastError: true, kept: true } }),
    ]);
    return {
      ready: true,
      enabled,
      people: connections.map((c) => {
        const cur = cursors.find((x) => x.userId === c.userId);
        return {
          userId: c.userId,
          name: c.user.name,
          mailbox: c.mailbox,
          provider: c.provider,
          canRead: grantsRead(c.provider, c.scopes),
          broken: !!c.brokenAt,
          agents: grants.filter((g) => g.userId === c.userId && isMailReader(g.agent)).map((g) => g.agent as MailReader),
          lastRunAt: cur?.lastRunAt?.toISOString() ?? null,
          lastError: cur?.lastError ?? null,
          kept: cur?.kept ?? 0,
        };
      }),
    };
  } catch (err) {
    if (notMigratedYet(err)) return { ready: false, enabled: false, people: [] };
    throw err;
  }
}

export async function setMailReading(enabled: boolean, userId: string): Promise<void> {
  await db.mailReadSettings.upsert({ where: { id: "default" }, create: { id: "default", enabled, updatedById: userId }, update: { enabled, updatedById: userId } });
}

/** Which agents may read one person's mailbox — the whole set, replaced. */
export async function setMailReaders(personId: string, agents: MailReader[], byId: string): Promise<void> {
  const wanted = [...new Set(agents.filter(isMailReader))];
  await db.$transaction(async (tx) => {
    await tx.mailReadGrant.deleteMany({ where: { userId: personId, agent: { notIn: wanted } } });
    for (const agent of wanted) await tx.mailReadGrant.upsert({ where: { userId_agent: { userId: personId, agent } }, create: { userId: personId, agent, createdById: byId }, update: {} });
    // A mailbox newly read starts from now: no history is read back.
    if (wanted.length) await tx.mailReadCursor.upsert({ where: { userId: personId }, create: { userId: personId, since: new Date() }, update: {} });
  });
}

/** Whether Deskzo should ask this person's provider for the permission to read, when they connect. */
export async function readingWantedFor(userId: string): Promise<boolean> {
  try {
    if (!(await mailReadingEnabled())) return false;
    return (await db.mailReadGrant.count({ where: { userId } })) > 0;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
}

/** For a person's own Profile: is their mailbox read, by whom, and does it still need reconnecting to allow it. */
export async function myMailReading(userId: string): Promise<{ readers: MailReader[]; needsReconnect: boolean } | null> {
  try {
    if (!(await mailReadingEnabled())) return null;
    const grants = await db.mailReadGrant.findMany({ where: { userId }, select: { agent: true } });
    if (!grants.length) return null;
    const c = await db.mailConnection.findUnique({ where: { userId }, select: { provider: true, scopes: true } });
    return { readers: grants.map((g) => g.agent).filter(isMailReader), needsReconnect: !!c && !grantsRead(c.provider, c.scopes) };
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

// ─── Who an email is with ─────────────────────────────────────────────────────

export type Party = { companyId: string; contactId: string | null; leadId: string | null };

/** Every domain the workspace's own people use, and the mailbox's own — mail only among these is internal. */
export async function ourDomains(mailbox: string): Promise<Set<string>> {
  const people = await db.user.findMany({ where: { active: true }, select: { email: true } });
  const out = new Set(people.map((p) => emailDomain(p.email)).filter((d): d is string => !!d && !isFreeMailbox(d)));
  const mine = emailDomain(mailbox);
  if (mine) out.add(mine);
  return out;
}

/** The one company (and contact, and open lead) an email is with — or null when it's with nobody known, or with more than one. */
export async function partyOf(mail: Pick<ReadMail, "fromEmail" | "to" | "cc">, mailbox: string, ours?: Set<string>): Promise<Party | null> {
  // The workspace's own people and domains are never a party: mail among colleagues is internal, whichever of the
  // company's domains it's on.
  const own = ours ?? (await ourDomains(mailbox));
  const others = [...new Set([mail.fromEmail, ...mail.to, ...mail.cc].map((a) => addressOf(a)).filter((a) => a && a !== mailbox.toLowerCase() && !own.has(emailDomain(a) ?? "")))];
  if (!others.length) return null;

  // A contact by address — the strongest.
  const contacts = await db.contact.findMany({ where: { email: { in: others, mode: "insensitive" }, ...STILL_THERE }, select: { id: true, companyId: true } });
  let companyId: string | null = null;
  let contactId: string | null = null;
  const contactCompanies = [...new Set(contacts.map((c) => c.companyId))];
  if (contactCompanies.length === 1) {
    companyId = contactCompanies[0]!;
    contactId = contacts.length === 1 ? contacts[0]!.id : null;
  } else if (contactCompanies.length > 1) return null;

  // Else one company by its contacts' domain, or by its website.
  if (!companyId) {
    const byDomain = await companiesByDomain(others);
    const found = new Set<string>();
    for (const v of byDomain.values()) for (const c of v?.companies ?? []) found.add(c.id);
    if (found.size === 1) companyId = [...found][0]!;
    else if (found.size === 0) {
      const domains = [...new Set(others.map((a) => emailDomain(a)).filter((d): d is string => !!d && !isFreeMailbox(d)))];
      if (domains.length) {
        const sites = await db.company.findMany({ where: { OR: domains.map((d) => ({ website: { contains: d, mode: "insensitive" as const } })) }, select: { id: true, website: true }, take: 10 });
        const exact = sites.filter((c) => domains.includes(websiteDomain(c.website)));
        if (exact.length === 1) companyId = exact[0]!.id;
      }
    }
  }
  if (!companyId) return null;
  const lead = await db.lead.findFirst({ where: { companyId, status: { notIn: ["WON", "LOST", "DISQUALIFIED"] } }, orderBy: { updatedAt: "desc" }, select: { id: true } }).catch(() => null);
  return { companyId, contactId, leadId: lead?.id ?? null };
}

// ─── The heartbeat's reading ──────────────────────────────────────────────────

const PER_MAILBOX = 50;

/** Reads each allowed mailbox forward from where it got to, keeping mail with known parties. Null when reading is off. */
export async function mailReadingChores(opts: { budgetMs: number }): Promise<{ mailboxes: number; kept: number; skipped: number; failed: number } | null> {
  if (!(await mailReadingEnabled())) return null;
  const started = Date.now();
  const out = { mailboxes: 0, kept: 0, skipped: 0, failed: 0 };
  const people = [...new Set((await db.mailReadGrant.findMany({ where: { user: { active: true } }, select: { userId: true } })).map((g) => g.userId))];
  const cursors = await db.mailReadCursor.findMany({ where: { userId: { in: people } }, orderBy: { lastRunAt: { sort: "asc", nulls: "first" } }, select: { userId: true, since: true } });
  for (const cur of cursors) {
    if (Date.now() - started > opts.budgetMs) break;
    const conn = await db.mailConnection.findUnique({ where: { userId: cur.userId }, select: { provider: true, scopes: true, brokenAt: true } });
    if (!conn || conn.brokenAt || !grantsRead(conn.provider, conn.scopes)) continue;
    out.mailboxes += 1;
    const result = await readOne(cur.userId, cur.since);
    if (!result.ok) {
      out.failed += 1;
      await db.mailReadCursor.update({ where: { userId: cur.userId }, data: { lastRunAt: new Date(), lastError: result.error } });
      continue;
    }
    out.kept += result.kept;
    out.skipped += result.skipped;
  }
  return out;
}

/** One mailbox, one page forward. */
export async function readOne(userId: string, since: Date): Promise<{ ok: true; kept: number; skipped: number } | { ok: false; error: string }> {
  let access = await workplaceAccess(userId);
  if (!access.ok) return { ok: false, error: access.error };
  let page = await readMailbox(access.token, access.connection, since, PER_MAILBOX);
  if (!page.ok && page.status === 401) {
    access = await workplaceAccess(userId, true);
    if (!access.ok) return { ok: false, error: access.error };
    page = await readMailbox(access.token, access.connection, since, PER_MAILBOX);
  }
  if (!page.ok) return { ok: false, error: page.error };
  const mailbox = access.connection.mailbox.toLowerCase();
  const ours = await ourDomains(mailbox);
  let kept = 0;
  let skipped = 0;
  let last = since;
  for (const m of page.mails) {
    if (m.sentAt > last) last = m.sentAt;
    if (!m.providerId || Number.isNaN(m.sentAt.getTime())) continue;
    const party = await partyOf(m, mailbox, ours);
    if (!party) {
      skipped += 1;
      continue;
    }
    await db.mailMessage.upsert({
      where: { userId_providerId: { userId, providerId: m.providerId } },
      create: {
        userId,
        provider: access.connection.provider,
        providerId: m.providerId,
        threadId: m.threadId,
        direction: m.fromEmail === mailbox ? "OUT" : "IN",
        fromEmail: m.fromEmail,
        fromName: m.fromName,
        toEmails: m.to,
        ccEmails: m.cc,
        subject: m.subject.slice(0, 500),
        snippet: m.snippet,
        bodyText: m.bodyText,
        hasAttachments: m.hasAttachments,
        sentAt: m.sentAt,
        ...party,
      },
      update: {},
    });
    kept += 1;
  }
  await db.mailReadCursor.update({ where: { userId }, data: { since: last, lastRunAt: new Date(), lastError: null, kept: { increment: kept }, skipped: { increment: skipped } } });
  return { ok: true, kept, skipped };
}

/** An agent reading a kept email: allowed only when the admin lets it read that mailbox — and logged. */
export async function agentMayRead(agent: MailReader, messageIds: string[], purpose: string): Promise<string[]> {
  if (!messageIds.length || !(await mailReadingEnabled())) return [];
  const msgs = await db.mailMessage.findMany({ where: { id: { in: messageIds } }, select: { id: true, userId: true } });
  const allowed = new Set((await db.mailReadGrant.findMany({ where: { agent, userId: { in: msgs.map((m) => m.userId) } }, select: { userId: true } })).map((g) => g.userId));
  const ok = msgs.filter((m) => allowed.has(m.userId)).map((m) => m.id);
  if (ok.length) await db.mailReadLog.createMany({ data: ok.map((messageId) => ({ messageId, agent, purpose: purpose.slice(0, 200) })) });
  return ok;
}
