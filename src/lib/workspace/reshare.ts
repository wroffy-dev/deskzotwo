import type { CallerAllocationMethod, Prisma } from "@prisma/client";
import { allocate, type Allocation } from "./allocation";

/**
 * Re-shares a calling activity's uncalled records between the people now on it (owner, 11 Nov 2026): somebody added to
 * a running activity had no records, so they had no queue and no row under "By caller". Only records nobody has opened
 * move — a call made, skipped or in the middle stays with whoever made it, so the credit and the timings stand.
 */
export async function reshareUncalled(
  tx: Prisma.TransactionClient,
  workbookId: string,
  callerIds: string[],
  method: CallerAllocationMethod,
): Promise<Allocation[]> {
  if (callerIds.length === 0) return [];
  const open = await tx.workbookRecord.findMany({
    where: { workbookId, status: "PENDING" },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    select: { id: true, company: { select: { ownerUserId: true } } },
  });
  const allocations = allocate(
    open.map((r) => ({ id: r.id, ownerUserId: r.company.ownerUserId })),
    callerIds,
    method,
  );
  for (const a of allocations) {
    await tx.workbookRecord.update({ where: { id: a.recordId }, data: { assignedToUserId: a.userId, sortOrder: a.sortOrder } });
  }
  return allocations;
}

/** Whether the people on the activity and the people holding its records have drifted apart. */
export function callersChanged(wanted: string[], holders: (string | null)[]): boolean {
  const holding = new Set(holders.filter((id): id is string => !!id));
  const want = new Set(wanted);
  return wanted.some((id) => !holding.has(id)) || [...holding].some((id) => !want.has(id)) || holders.some((id) => !id);
}
