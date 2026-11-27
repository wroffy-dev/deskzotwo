"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { refuseWhileViewingAs } from "@/lib/session";
import { requireModuleUser } from "@/lib/modules-access";
import { recordAudit } from "@/lib/audit";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { formAccess } from "@/actions/forms";
import { checkWebsite, formWebsite, popupSnippet, type LandingSettings, type PopupSettings } from "@/lib/forms/website";
import type { ActionResult } from "@/actions/company";

/** A form's pop-up and landing page, with the line to paste, for whoever may see the form (owner, 1 Nov 2026). */
export async function getFormWebsite(formId: string): Promise<{ popup: PopupSettings; landing: LandingSettings; snippet: string; pageUrl: string; canEdit: boolean } | null> {
  const access = await formAccess(formId);
  if (!access?.see) return null;
  const form = await db.inboundForm.findUnique({ where: { id: formId }, select: { slug: true } });
  if (!form) return null;
  const [settings, origin] = await Promise.all([formWebsite(formId), tenantOrigin()]);
  return { ...settings, snippet: popupSnippet(origin, form.slug), pageUrl: `${origin}/forms/${form.slug}`, canEdit: access.edit };
}

/** Saves a form's pop-up and landing page (src/lib/forms/website-rules.ts), for whoever may edit the form. */
export async function saveFormWebsite(formId: string, input: { popup?: unknown; landing?: unknown }): Promise<ActionResult<null>> {
  const user = await requireModuleUser("forms");
  const refused = await refuseWhileViewingAs();
  if (refused) return { ok: false, error: refused };
  const access = await formAccess(formId);
  if (!access?.edit) return { ok: false, error: "You can't change this form." };
  const checked = checkWebsite(input ?? {});
  if (!checked.ok) return checked;
  const data = { popup: checked.popup as unknown as Prisma.InputJsonValue, landing: checked.landing as unknown as Prisma.InputJsonValue };
  await db.formWebsite.upsert({ where: { formId }, create: { formId, ...data }, update: data });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "InboundForm", entityId: formId, entityLabel: `Form on the website: pop-up ${checked.popup.on ? "on" : "off"}, landing page ${checked.landing.on ? "on" : "off"}` });
  revalidatePath(`/marketing/forms/${formId}`);
  return { ok: true, data: null };
}
