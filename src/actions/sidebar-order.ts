"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { refuseWhileViewingAs, requireUser } from "@/lib/session";
import { hasSidebarOrder, readSidebarOrder } from "@/lib/navigation-order";
import type { ActionResult } from "@/actions/company";

/**
 * Saves the person's own sidebar order (owner, 17 Nov 2026 — src/lib/navigation-order.ts). Anybody may arrange their
 * own; nobody arranges another's — not while viewing as them either. Only an order is kept: what is stored can't add a
 * page to the menu or move one out of its section, because the layout only ever reorders what the menu already holds.
 */
export async function saveSidebarOrder(input: unknown): Promise<ActionResult<{ saved: boolean }>> {
  const user = await requireUser();
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const order = readSidebarOrder(input);
  await db.user.update({ where: { id: user.id }, data: { sidebarOrder: order as Prisma.InputJsonValue }, select: { id: true } });
  revalidatePath("/", "layout");
  return { ok: true, data: { saved: hasSidebarOrder(order) } };
}

/** Back to the app's own order. */
export async function resetSidebarOrder(): Promise<ActionResult<{ saved: boolean }>> {
  const user = await requireUser();
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  await db.user.update({ where: { id: user.id }, data: { sidebarOrder: {} }, select: { id: true } });
  revalidatePath("/", "layout");
  return { ok: true, data: { saved: false } };
}
