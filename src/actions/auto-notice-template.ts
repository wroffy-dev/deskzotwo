"use server";

import { revalidatePath } from "next/cache";
import { requireModuleAccess } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { chosenAutoTemplate, renewalTemplateOptions, setAutoTemplate, type TemplateOption } from "@/lib/marketing/auto-notice-template";
import type { ActionResult } from "@/actions/company";

const NOT_ALLOWED = "Only somebody who can change the workspace's settings can choose this.";

/** Settings › Renewals: which template the automatic renewal reminder uses, and the ones it may. */
export async function renewalReminderTemplate(): Promise<ActionResult<{ chosen: string | null; options: TemplateOption[] }>> {
  const user = await requireModuleAccess("renewals");
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: NOT_ALLOWED };
  const [chosen, options] = await Promise.all([chosenAutoTemplate("RENEWAL"), renewalTemplateOptions()]);
  return { ok: true, data: { chosen, options } };
}

export async function setRenewalReminderTemplate(templateId: string | null): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("renewals");
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: NOT_ALLOWED };
  let name = "the built-in wording";
  if (templateId) {
    const template = (await renewalTemplateOptions()).find((t) => t.id === templateId);
    if (!template) return { ok: false, error: "Choose an email template on the Renewals topic that is switched on." };
    name = template.name;
  }
  await setAutoTemplate("RENEWAL", templateId, user.id);
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "AutoNoticeTemplate", entityId: "RENEWAL", entityLabel: `The automatic renewal reminder uses ${name}` });
  revalidatePath("/settings/renewals");
  return { ok: true, data: null };
}
