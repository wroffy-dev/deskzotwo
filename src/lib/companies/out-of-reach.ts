import { db } from "@/lib/db";
import { companyScope } from "@/lib/authz/company-scope";

/**
 * Of these companies, those this person can't open — for a list that may hold records of companies beyond their own
 * (a role whose Support tickets level is All), so a name among them is words and not a link to a page that isn't found.
 */
export async function companiesOutOfReach(userId: string, companyIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(companyIds)];
  if (ids.length === 0) return [];
  const seen = await db.company.findMany({ where: { AND: [{ id: { in: ids } }, await companyScope(userId)] }, select: { id: true } });
  const reach = new Set(seen.map((c) => c.id));
  return ids.filter((id) => !reach.has(id));
}
