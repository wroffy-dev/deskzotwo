"use server";

import { auth } from "@/lib/auth";
import { requireUser, viewAsContext } from "@/lib/session";
import { forcedSetupFor } from "@/lib/forced-setup";

/**
 * Whether the signed-in person still has to finish on My profile (src/lib/forced-setup.ts) — asked by
 * ForcedSetupGuard when they leave it, so a password changed a moment ago lets them straight through. Never while
 * viewing as somebody: that's about the person signed in.
 */
export async function stillNeedsSetup(): Promise<boolean> {
  const user = await requireUser();
  if (await viewAsContext()) return false;
  return forcedSetupFor(user.id, (await auth())?.user?.sid);
}
