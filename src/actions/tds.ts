"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { indiaClock } from "@/lib/time/zone";
import { sectionByKey } from "@/lib/tds/sections";
import { billTdsAdvice } from "@/lib/tds/vendor";
import type { ActionResult } from "@/actions/company";

/**
 * TDS on vendors' bills (owner, 25 Oct 2026; src/lib/tds): the bill form's advice, and a vendor's usual section
 * and lower deduction certificates. Setting either is finance's (`payments.manage`), as the vendor's PAN is.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

async function reachableCompany(userId: string, companyId: string) {
  const company = await db.company.findUnique({ where: { id: String(companyId ?? "") }, select: { id: true, name: true, ownerUserId: true, relationshipType: true } });
  return company && (await canSeeCompany(userId, company)) ? company : null;
}

async function financeUser() {
  const user = await requireModuleUser("purchase_documents");
  return (await hasEffectivePermission(user.id, "payments.manage")) ? user : null;
}

/** The bill form's TDS line: the rate this bill should deduct at under the section, and why. Null when there's nothing to say. */
export async function tdsAdviceForBill(input: { companyId: string; sectionKey?: string | null; amount: number; day: string; documentId?: string | null }) {
  const user = await requireModuleUser("purchase_documents");
  if (!(await reachableCompany(user.id, input?.companyId))) return null;
  const day = DAY.test(String(input.day ?? "")) ? input.day : indiaClock.today();
  const amount = Math.max(0, Number(input.amount) || 0);
  const got = await billTdsAdvice({ companyId: input.companyId, sectionKey: input.sectionKey ?? null, amount, day, excludeDocumentId: input.documentId ?? null });
  if (!got) return null;
  return { sectionKey: got.section.key, advice: got.advice, pan: got.facts.pan, usualSectionKey: got.facts.usualSectionKey, yearSoFar: got.yearSoFar };
}

/** A vendor's usual section — what its bills start from. Null clears it. */
export async function setVendorTdsSection(companyId: string, sectionKey: string | null): Promise<ActionResult<null>> {
  const user = await financeUser();
  if (!user) return { ok: false, error: "Setting a vendor's TDS needs the “Manage finance records” permission." };
  const company = await reachableCompany(user.id, companyId);
  if (!company) return { ok: false, error: "Company not found." };
  if (sectionKey === null || sectionKey === "") {
    await db.vendorTds.deleteMany({ where: { companyId: company.id } });
  } else {
    const section = sectionByKey(sectionKey);
    if (!section) return { ok: false, error: "Choose one of the TDS sections." };
    await db.vendorTds.upsert({ where: { companyId: company.id }, create: { companyId: company.id, sectionKey: section.key, updatedById: user.id }, update: { sectionKey: section.key, updatedById: user.id } });
  }
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Company", entityId: company.id, entityLabel: `${company.name}: usual TDS section ${sectionKey ? (sectionByKey(sectionKey)?.oldSection ?? sectionKey) : "cleared"}` });
  revalidatePath(`/companies/${company.id}`);
  return { ok: true, data: null };
}

/** Records a lower or nil deduction certificate the vendor holds. */
export async function addTdsCertificate(input: {
  companyId: string;
  sectionKey: string;
  certificateNo: string;
  ratePercent: number | string;
  amountLimit?: number | string | null;
  validFrom: string;
  validTo: string;
}): Promise<ActionResult<{ id: string }>> {
  const user = await financeUser();
  if (!user) return { ok: false, error: "Recording a vendor's certificate needs the “Manage finance records” permission." };
  const company = await reachableCompany(user.id, input?.companyId);
  if (!company) return { ok: false, error: "Company not found." };
  const section = sectionByKey(input.sectionKey);
  if (!section) return { ok: false, error: "Choose the section the certificate is for." };
  const certificateNo = String(input.certificateNo ?? "").trim().toUpperCase();
  if (!certificateNo || certificateNo.length > 40) return { ok: false, error: "Give the certificate's number, as it's printed on it." };
  const rate = Number(input.ratePercent);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) return { ok: false, error: "The rate is a percentage, 0 to 100 (0 for a nil deduction certificate)." };
  const limitText = String(input.amountLimit ?? "").trim();
  const limit = limitText ? Number(limitText) : null;
  if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) return { ok: false, error: "The amount it covers is more than 0, or leave it blank." };
  if (!DAY.test(String(input.validFrom ?? "")) || !DAY.test(String(input.validTo ?? ""))) return { ok: false, error: "Give the dates it's valid from and to." };
  if (input.validTo < input.validFrom) return { ok: false, error: "It ends before it starts." };
  try {
    const made = await db.tdsCertificate.create({
      data: {
        companyId: company.id,
        sectionKey: section.key,
        certificateNo,
        ratePercent: new Prisma.Decimal(rate),
        amountLimit: limit === null ? null : new Prisma.Decimal(limit),
        validFrom: new Date(`${input.validFrom}T00:00:00Z`),
        validTo: new Date(`${input.validTo}T00:00:00Z`),
        createdById: user.id,
      },
      select: { id: true },
    });
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "Company", entityId: company.id, entityLabel: `${company.name}: lower deduction certificate ${certificateNo} (${section.oldSection}, ${rate}%, ${input.validFrom} to ${input.validTo})` });
    revalidatePath(`/companies/${company.id}`);
    return { ok: true, data: made };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { ok: false, error: `${certificateNo} is already recorded for this vendor.` };
    throw err;
  }
}

export async function removeTdsCertificate(id: string): Promise<ActionResult<null>> {
  const user = await financeUser();
  if (!user) return { ok: false, error: "Removing a vendor's certificate needs the “Manage finance records” permission." };
  const certificate = await db.tdsCertificate.findUnique({ where: { id: String(id ?? "") }, select: { id: true, companyId: true, certificateNo: true } });
  const company = certificate ? await reachableCompany(user.id, certificate.companyId) : null;
  if (!certificate || !company) return { ok: false, error: "That certificate isn't there." };
  await db.tdsCertificate.delete({ where: { id: certificate.id } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "Company", entityId: company.id, entityLabel: `${company.name}: lower deduction certificate ${certificate.certificateNo} removed` });
  revalidatePath(`/companies/${company.id}`);
  return { ok: true, data: null };
}
