"use server";

import { revalidatePath } from "next/cache";
import type { MsmeCategory } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { MSME_CATEGORIES, MSME_CATEGORY_LABELS, normaliseUdyam, udyamRefusal } from "@/lib/payables/msme-rules";
import type { ActionResult } from "@/actions/company";

/**
 * A vendor's MSME (Udyam) registration (owner, 17 Nov 2026; src/lib/payables/msme.ts). Set by finance
 * (`payments.manage`), as its PAN and TDS are; everyone who sees the vendor reads it.
 */

const MODULES = ["vendors", "purchase_documents", "payables"];

async function financeUser() {
  const user = await requireModuleUser(MODULES);
  return (await hasEffectivePermission(user.id, "payments.manage")) ? user : null;
}

async function reachableCompany(userId: string, companyId: unknown) {
  const company = await db.company.findUnique({
    where: { id: String(companyId ?? "") },
    select: { id: true, name: true, ownerUserId: true, relationshipType: true, companySeq: true },
  });
  return company && (await canSeeCompany(userId, company)) ? company : null;
}

export async function setVendorMsme(companyId: string, input: { udyamNumber: string; category: string }): Promise<ActionResult<null>> {
  const user = await financeUser();
  if (!user) return { ok: false, error: "Recording a vendor's MSME registration needs the “Manage finance records” permission." };
  const company = await reachableCompany(user.id, companyId);
  if (!company) return { ok: false, error: "Company not found." };
  const refusal = udyamRefusal(input?.udyamNumber);
  if (refusal) return { ok: false, error: refusal };
  const category = String(input?.category ?? "") as MsmeCategory;
  if (!MSME_CATEGORIES.includes(category)) return { ok: false, error: "Choose Micro, Small or Medium." };
  const udyamNumber = normaliseUdyam(input.udyamNumber);
  await db.vendorMsme.upsert({
    where: { companyId: company.id },
    create: { companyId: company.id, udyamNumber, category, updatedById: user.id },
    update: { udyamNumber, category, updatedById: user.id },
  });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Company",
    entityId: company.id,
    entityLabel: `${company.name}: MSME ${MSME_CATEGORY_LABELS[category]}, ${udyamNumber}`,
  });
  revalidatePath(`/companies/${company.id}`);
  revalidatePath("/payables");
  return { ok: true, data: null };
}

export async function clearVendorMsme(companyId: string): Promise<ActionResult<null>> {
  const user = await financeUser();
  if (!user) return { ok: false, error: "Changing a vendor's MSME registration needs the “Manage finance records” permission." };
  const company = await reachableCompany(user.id, companyId);
  if (!company) return { ok: false, error: "Company not found." };
  const removed = await db.vendorMsme.deleteMany({ where: { companyId: company.id } });
  if (removed.count > 0) {
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Company", entityId: company.id, entityLabel: `${company.name}: MSME registration removed` });
  }
  revalidatePath(`/companies/${company.id}`);
  revalidatePath("/payables");
  return { ok: true, data: null };
}
