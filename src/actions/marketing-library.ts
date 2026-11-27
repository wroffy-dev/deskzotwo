"use server";

import { revalidatePath } from "next/cache";
import type { MarketingTopic } from "@prisma/client";
import { requireUser, refuseWhileViewingAs } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { isModuleEntitled } from "@/lib/modules-access";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { libraryTemplate } from "@/lib/marketing/template-library";
import { libraryBrand } from "@/lib/marketing/library-brand";
import { saveDesign } from "@/lib/marketing/design-store";
import { TOPICS } from "@/lib/marketing/topics";
import type { ActionResult } from "@/actions/company";

/**
 * Marketing › Templates — the template library and the email builder (owner, 1 Nov 2026). A ready-made template, or a
 * design made in the builder, saved as one of the workspace's templates: drawn in its look, stored as an uploaded HTML
 * template is (cleaned, its fields checked, pictures hosted), with the design kept so it opens in the builder again
 * (src/lib/marketing/design-store.ts). For whoever may manage marketing, as uploading is.
 */

async function gate(): Promise<{ userId: string } | { error: string }> {
  const user = await requireUser();
  if (!(await isModuleEntitled("marketing"))) return { error: "Marketing isn't part of this workspace's plan." };
  if (!(await can(user.id, "marketing.manage"))) return { error: "You can't add marketing templates." };
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { error: viewing };
  return { userId: user.id };
}

export async function addLibraryTemplate(key: string): Promise<ActionResult<{ id: string; name: string; warnings: string[] }>> {
  const g = await gate();
  if ("error" in g) return { ok: false, error: g.error };
  const template = libraryTemplate(String(key ?? ""));
  if (!template) return { ok: false, error: "That template isn't in the library." };

  const saved = await saveDesign({
    userId: g.userId,
    name: template.name,
    topic: template.topic,
    subject: template.subject,
    preheader: template.preheader,
    design: template.design(await libraryBrand()),
    fileName: `${template.key}.html`,
  });
  if (!saved.ok) return { ok: false, error: saved.error };

  await recordAudit({ userId: g.userId, action: "CREATE", entityType: "MarketingTemplate", entityId: saved.data.id, entityLabel: `From the template library: ${template.name}` });
  revalidatePath("/marketing/templates");
  revalidatePath("/marketing/send");
  return { ok: true, data: { id: saved.data.id, name: template.name, warnings: saved.data.warnings } };
}

export type DesignedTemplateInput = { id?: string; name: string; topic: string; subject: string; preheader: string; design: unknown };

/** The builder's Save: a new template, or the one being edited — only one that exists, as an email template. */
export async function saveDesignedTemplate(input: DesignedTemplateInput): Promise<ActionResult<{ id: string; warnings: string[] }>> {
  const g = await gate();
  if ("error" in g) return { ok: false, error: g.error };
  const name = String(input?.name ?? "").trim().slice(0, 200);
  if (!name) return { ok: false, error: "Give the template a name." };
  const topic = String(input?.topic ?? "") as MarketingTopic;
  if (!TOPICS.some((t) => t.key === topic)) return { ok: false, error: "Pick what the email is about." };
  const id = typeof input?.id === "string" && input.id ? input.id : undefined;
  if (id) {
    const row = await db.marketingTemplate.findUnique({ where: { id }, select: { channel: true } });
    if (!row || row.channel !== "EMAIL") return { ok: false, error: "That template no longer exists." };
  }

  const saved = await saveDesign({
    userId: g.userId,
    id,
    name,
    topic,
    subject: String(input?.subject ?? "").trim().slice(0, 300) || null,
    preheader: String(input?.preheader ?? "").trim().slice(0, 300) || null,
    design: input?.design,
  });
  if (!saved.ok) return { ok: false, error: saved.error };

  await recordAudit({ userId: g.userId, action: id ? "UPDATE" : "CREATE", entityType: "MarketingTemplate", entityId: saved.data.id, entityLabel: `${id ? "Changed" : "Made"} in the email builder: ${name}` });
  revalidatePath("/marketing/templates");
  revalidatePath("/marketing/send");
  return { ok: true, data: saved.data };
}
