"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/actions/company";
import { recordAudit } from "@/lib/audit";
import { refuseWhileViewingAs, requireUser } from "@/lib/session";
import { isTeammateKey } from "@/lib/ai/teammates";
import { workspaceTeammates } from "@/lib/ai/teammates-server";
import { mayManageTeammates, setTeammateOn } from "@/lib/ai/teammate-switches";

/**
 * Settings › AI teammates (owner, 23 Nov 2026): switching one teammate on or off in this workspace. Off stops every AI
 * call made for them, at the gateway (src/lib/ai/teammate-switches.ts). Whoever may change the settings, never while
 * viewing as somebody else — it would be recorded as them.
 */
export async function switchTeammate(key: unknown, on: unknown): Promise<ActionResult<null>> {
  const user = await requireUser();
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  if (!(await mayManageTeammates(user.id))) return { ok: false, error: "Only an admin can switch AI teammates on or off." };
  if (!isTeammateKey(key) || typeof on !== "boolean") return { ok: false, error: "That isn't one of your AI teammates." };
  await setTeammateOn(key, on, user.id);
  const name = (await workspaceTeammates())[key].name;
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "AiTeammateSwitch", entityId: key, entityLabel: `${name} switched ${on ? "on" : "off"}` });
  revalidatePath("/settings/ai-teammates");
  return { ok: true, data: null };
}
