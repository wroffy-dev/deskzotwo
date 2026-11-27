import { db } from "@/lib/db";
import { parseEmailAddress } from "@/lib/email-verification";
import { notMigratedYet } from "@/lib/not-migrated";
import { domainAndParents, domainCovers } from "@/lib/mail-block-rules";
import { currentTenantOrNull } from "@/lib/tenancy/resolve";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * A workspace's "never mail them" (owner, 31 Oct 2026: "can a workspace admin block a company domain or particular
 * email so no mail goes to that"): an address, or a whole domain with its subdomains, that no email from the workspace
 * goes to — invoices and documents too. Settings › Blocked addresses (src/actions/mail-blocks.ts) keeps them; they are
 * `Suppression` rows by hand with `allMail` set, so the marketing list shows them as well.
 *
 * Checked where every email leaves (src/lib/marketing/providers — the workspace's own providers — and
 * src/lib/platform/mailer.ts, which sends a workspace's documents through Deskzo), so no kind of mail slips past.
 * Outside a workspace (a signup, the console) there is nothing to check.
 *
 * A workspace not migrated yet (`allMail` is in NOT_YET_EVERYWHERE) has none: its blocks by hand go on stopping
 * marketing and reminders, as they always did.
 */
export type AllMailBlock = { address: string; scope: "EMAIL" | "DOMAIN"; value: string; by: string | null; at: Date };

/** The first address an all-mail block covers, with who blocked it and when — or null. */
export async function allMailBlockFor(addresses: (string | null | undefined)[]): Promise<AllMailBlock | null> {
  const parsed = [...new Set(addresses.map((a) => a?.trim().toLowerCase()).filter((a): a is string => !!a))]
    .map((address) => ({ address, domain: parseEmailAddress(address)?.domain ?? null }));
  if (parsed.length === 0) return null;
  if (!(await currentTenantOrNull())) return null;
  let rows: { scope: string; value: string; createdAt: Date; createdBy: { name: string } | null }[];
  try {
    rows = await db.suppression.findMany({
      where: {
        allMail: true,
        OR: [
          { scope: "EMAIL", value: { in: parsed.map((p) => p.address) } },
          { scope: "DOMAIN", value: { in: [...new Set(parsed.flatMap((p) => (p.domain ? domainAndParents(p.domain) : [])))] } },
        ],
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }],
      },
      select: { scope: true, value: true, createdAt: true, createdBy: { select: { name: true } } },
    });
  } catch (err) {
    // A workspace not migrated yet has no `allMail` column, and so no all-mail blocks.
    if (notMigratedYet(err)) return null;
    throw err;
  }
  for (const p of parsed) {
    const row = rows.find((r) => (r.scope === "EMAIL" && r.value === p.address) || (r.scope === "DOMAIN" && domainCovers(r.value, p.domain)));
    if (row) return { address: p.address, scope: row.scope as "EMAIL" | "DOMAIN", value: row.value, by: row.createdBy?.name ?? null, at: row.createdAt };
  }
  return null;
}

/** "ravi@sales.acme.com is blocked from all mail: acme.com was blocked by Priya on 30 Oct 2026 (Settings › Blocked addresses)." */
export async function blockSentence(block: AllMailBlock): Promise<string> {
  const how = `${block.by ? ` by ${block.by}` : ""} on ${(await workspaceClock()).date(block.at)} (Settings › Blocked addresses)`;
  return block.scope === "DOMAIN"
    ? `${block.address} is blocked from all mail: ${block.value} was blocked${how}.`
    : `${block.address} is blocked from all mail${how}.`;
}
