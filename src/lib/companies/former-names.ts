import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { legalNameKey } from "@/lib/company-name";
import { tenantKey } from "@/lib/tenancy/cache";

/**
 * A company's former names (owner, 14 Nov 2026: "what if a company was Pvt Ltd but later changed to Ltd"): the names it
 * went by before — taken from a duplicate merged into it, or kept when it is renamed — so a search for the old name,
 * an old PO or invoice in hand, still finds it, and its page says "Formerly …". One per line in companies.formerNames
 * (migration 20261214500000_company_former_names, which also took them from every merge already made).
 *
 * The column is listed in NOT_YET_EVERYWHERE (src/lib/tenancy/clients.ts): a workspace not migrated yet reads and
 * saves as before, and its searches don't look at it.
 */

/** The most kept; the oldest go first. */
export const MAX_FORMER_NAMES = 20;

/** The names, one per line, as a list. */
export function formerNamesList(stored: string | null | undefined): string[] {
  return String(stored ?? "")
    .split("\n")
    .map((n) => n.trim())
    .filter(Boolean);
}

/**
 * `stored` with `add` kept as former names — but never the name it has now, nor one already there (compared by legal name:
 * "Acme Pvt. Ltd." and "Acme Private Limited" are one, "Acme Ltd" another). Null when there are none.
 */
export function withFormerNames(stored: string | null | undefined, add: readonly (string | null | undefined)[], nameNow: string): string | null {
  const seen = new Set([legalNameKey(nameNow)]);
  const out: string[] = [];
  for (const n of [...formerNamesList(stored), ...add.map((x) => String(x ?? "").trim())]) {
    if (!n || n.length > 300) continue;
    const key = legalNameKey(n);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out.length ? out.slice(-MAX_FORMER_NAMES).join("\n") : null;
}

const ready = new Map<string, boolean>();

/** Whether this workspace has the column yet — asked of the catalogue once a process, then remembered once it has. */
export async function formerNamesReady(client: { $queryRaw: typeof db.$queryRaw } = db): Promise<boolean> {
  const key = await tenantKey().catch(() => "default");
  if (ready.get(key)) return true;
  const [row] = await client.$queryRaw<{ has: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'companies' AND column_name = 'formerNames') AS "has"`;
  const has = !!row?.has;
  if (has) ready.set(key, true);
  return has;
}

/** A search's clause for the former names, or none in a workspace without them yet. */
export async function formerNamesWhere(typed: string): Promise<Prisma.CompanyWhereInput[]> {
  const text = typed.trim();
  if (text.length < 2 || !(await formerNamesReady())) return [];
  return [{ formerNames: { contains: text, mode: "insensitive" } }];
}

/**
 * Who a name was, by its former names (owner, 18 Nov 2026: an import or the Zoho archive still naming "ABC Pvt Ltd" after
 * it became "ABC Ltd"): the legal-name key of every former name to its company, or null where two companies once had it —
 * the name can't tell which. Few companies have former names (a rename or a merge), so they are read at once. Empty in a
 * workspace without the column. Callers try the name as it is now first; this is the last resort.
 */
export async function formerNameIndex(): Promise<(name: string) => { id: string; name: string } | null | undefined> {
  if (!(await formerNamesReady())) return () => undefined;
  const rows = await db.company.findMany({ where: { formerNames: { not: null } }, select: { id: true, name: true, formerNames: true } });
  const byKey = new Map<string, { id: string; name: string } | null>();
  for (const r of rows) {
    for (const key of new Set(formerNamesList(r.formerNames).map(legalNameKey).filter(Boolean))) {
      const had = byKey.get(key);
      byKey.set(key, had === undefined || had?.id === r.id ? { id: r.id, name: r.name } : null);
    }
  }
  return (name) => byKey.get(legalNameKey(name));
}

/**
 * A rename keeps what issued documents say they were issued to (owner, 18 Nov 2026): every one not a draft, and not
 * already holding a name of its own, keeps `oldName` — so a reprint, and the e-invoice already registered, still say
 * "ABC Pvt Ltd" after the company becomes "ABC Ltd". Drafts take the new name. As a merge does (src/lib/companies/merge.ts).
 */
export async function keepIssuedNames(client: Pick<Prisma.TransactionClient, "tradeDocument">, companyId: string, oldName: string): Promise<number> {
  const name = oldName.trim();
  if (!name) return 0;
  const done = await client.tradeDocument.updateMany({ where: { companyId, status: { not: "DRAFT" }, partyName: null }, data: { partyName: name } });
  return done.count;
}

/** A company's former names; none in a workspace without the column. */
export async function formerNamesOf(companyId: string): Promise<string[]> {
  if (!(await formerNamesReady())) return [];
  const row = await db.company.findUnique({ where: { id: companyId }, select: { formerNames: true } });
  return formerNamesList(row?.formerNames);
}

type Client = Pick<Prisma.TransactionClient, "company" | "$queryRaw">;

/** Keeps `add` as former names of a company now called `nameNow` — inside the caller's transaction where there is one. */
export async function rememberFormerNames(client: Client, companyId: string, add: readonly (string | null | undefined)[], nameNow: string): Promise<void> {
  if (!(await formerNamesReady(client))) return;
  const row = await client.company.findUnique({ where: { id: companyId }, select: { formerNames: true } });
  const next = withFormerNames(row?.formerNames, add, nameNow);
  if (next !== (row?.formerNames ?? null)) await client.company.update({ where: { id: companyId }, data: { formerNames: next } });
}
