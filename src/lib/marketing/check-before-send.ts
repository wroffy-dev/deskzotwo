import { db } from "@/lib/db";
import { checkEmailAddress, primeMailHosts } from "@/lib/email-verification-lookup";
import type { EmailCheckStatus } from "@prisma/client";
import type { SendVerdict } from "@/lib/marketing/suppression";

/**
 * Checking addresses as a campaign goes (owner, 2 Nov 2026: "can't it verify before sending"). Marketing goes only to
 * an address Deskzo has checked — it protects the sending domain from bounces — and an address nobody had checked held
 * the whole audience back. Now pressing Send checks them first: syntax and DNS, the same check as Contacts › Check
 * emails, the verdict written on the contact. A good address goes; a dead one is held back as invalid, for good reason.
 */

const PROFILE_FRESH_MS = 30 * 86_400_000;
/** Domains looked up at once — enough to be quick, few enough that a public resolver doesn't rate-limit it. */
const AT_ONCE = 10;

type Checkable = { id: string; email: string | null; emailCheckedValue: string | null; companyId: string };

/** Whether a contact's address has a verdict for the address as it is now. */
export function needsCheck(c: Pick<Checkable, "email" | "emailCheckedValue">): boolean {
  const email = c.email?.trim().toLowerCase();
  return !!email && email !== (c.emailCheckedValue?.trim().toLowerCase() ?? null);
}

/**
 * Checks the addresses with no current verdict, and writes each verdict on its contact. Returns what each became, so
 * the caller can judge with it straight away. One lookup per domain: the first address of each domain is checked, ten
 * domains at a time, and the rest of that domain is answered from the lookup cache.
 */
export async function checkUncheckedAddresses(contacts: Checkable[]): Promise<Map<string, { status: EmailCheckStatus; value: string }>> {
  const out = new Map<string, { status: EmailCheckStatus; value: string }>();
  const todo = contacts.filter(needsCheck);
  if (todo.length === 0) return out;

  // What Domain Intel already found for these companies, so most domains cost nothing.
  const profiles = await db.domainProfile.findMany({
    where: { companyId: { in: [...new Set(todo.map((c) => c.companyId))] }, fetchedAt: { not: null } },
    select: { domain: true, mxHosts: true, fetchedAt: true },
  });
  for (const p of profiles) if (p.fetchedAt && Date.now() - p.fetchedAt.getTime() <= PROFILE_FRESH_MS) primeMailHosts(p.domain.toLowerCase(), p.mxHosts);

  const byDomain = new Map<string, Checkable[]>();
  for (const c of todo) {
    const domain = c.email!.trim().toLowerCase().split("@")[1] ?? "";
    byDomain.set(domain, [...(byDomain.get(domain) ?? []), c]);
  }
  const groups = [...byDomain.values()];
  const checkOne = async (c: Checkable) => {
    const value = c.email!.trim();
    const outcome = await checkEmailAddress(value);
    await db.contact.update({
      where: { id: c.id },
      data: { emailStatus: outcome.status, emailCheckDetail: outcome.detail, emailCheckMethod: "AUTOMATIC", emailCheckedValue: value, emailCheckedAt: new Date(), emailCheckedByUserId: null },
    });
    out.set(c.id, { status: outcome.status, value });
  };
  for (let i = 0; i < groups.length; i += AT_ONCE) {
    // The first of each domain together; the rest of each domain after it, from the cache.
    await Promise.all(groups.slice(i, i + AT_ONCE).map(async (group) => {
      for (const c of group) await checkOne(c);
    }));
  }
  return out;
}

/** Held back only because nobody has checked the address yet — what pressing Send will check. */
export function onlyUnchecked(verdict: SendVerdict): boolean {
  return !verdict.ok && verdict.findings.length > 0 && verdict.findings.every((f) => f.key === "UNVERIFIED_ADDRESS");
}
