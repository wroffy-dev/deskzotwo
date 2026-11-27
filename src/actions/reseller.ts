"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type ResellerOnboardingStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleAccess, requireModuleUser } from "@/lib/modules-access";
import { isModuleEnabled } from "@/actions/module";
import { mayAccess, type AccessAction } from "@/lib/authz/access";
import { recordAudit } from "@/lib/audit";
import { calculateOrderAmount } from "@/lib/gst";
import {
  isOnboardingComplete,
  outstandingOnboardingItems,
  type OnboardingInputs,
} from "@/lib/reseller-onboarding";
import { resellerProfileSchema, resellerItemPriceSchema, bulkUpdateResellersSchema } from "@/lib/validation/reseller";
import { toPlain } from "@/lib/serialize";
import { companyMasker, maskCompanyWith } from "@/lib/companies/masking";
import type { ActionResult } from "@/actions/company";
import { can } from "@/lib/authz/resolve";
import { refuseWhileViewingAs } from "@/lib/session";

/**
 * Security audit round three, 14 Nov 2026 (R3-18, low): a reseller's agreement approval was a person picked from a
 * list, and activation needed only the edit right — so whoever set a reseller up could name anyone as approver and
 * switch it on themselves. Approving and activating are now a settings manager's ("Manage settings"), the approval is
 * recorded as whoever gives it (never typed), and the person activating isn't the one who last changed onboarding.
 */
const APPROVER_KEY = "settings.manage";

/**
 * Whether this person may act this way on a reseller — an account, so the account rule
 * (src/lib/authz/access.ts), which its page asks before showing anything here. One out of reach
 * answers as missing, or as not a reseller.
 */
async function reaches(userId: string, resellerId: string, action: AccessAction): Promise<boolean> {
  return mayAccess(userId, "companies", action, resellerId);
}

/** The profile plus the company/location fields the onboarding checklist reads. */
export async function getResellerOnboarding(companyId: string) {
  const user = await requireModuleUser("resellers");
  if (!(await reaches(user.id, companyId, "view"))) return null;
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: {
      id: true,
      name: true,
      relationshipType: true,
      panNumber: true,
      paymentTerms: true,
      locations: { where: { isPrimary: true }, select: { gstNumber: true } },
      resellerProfile: { include: { agreementApprovedBy: { select: { id: true, name: true } } } },
    },
  });
  if (!company || company.relationshipType !== "RESELLER" || !company.resellerProfile) return null;

  const profile = company.resellerProfile;
  // The PAN and GSTIN as the companies policy shows them on the reseller's own page (owner, 5 Nov 2026 — Phase 3 masking
  // fixes, audit H.4.1; src/lib/companies/masking.ts): this action answers the browser too, and sent both in full. The
  // checklist asks only whether each is on file, so a masked one still counts and an empty one still doesn't.
  const masker = await companyMasker(user.id, "detail");
  const onFile = (value: string | null | undefined, field: "pan" | "gstin") => (value ? masker.present(field, value) : null);
  const inputs: OnboardingInputs = {
    agreementSignedOn: profile.agreementSignedOn,
    creditLimit: profile.creditLimit,
    tier: profile.tier,
    panNumber: onFile(company.panNumber, "pan"),
    gstNumber: onFile(company.locations[0]?.gstNumber, "gstin"),
  };
  return toPlain({ company: maskCompanyWith(masker, company), profile, inputs });
}

/**
 * Unpaid balance across the reseller's orders, against the credit limit they were granted. Across all
 * of them, to anybody who may open the reseller: a limit is the account's, and a part of the balance
 * would read as headroom that isn't there.
 */
export async function getResellerCreditSummary(companyId: string) {
  const user = await requireModuleUser("resellers");
  if (!(await reaches(user.id, companyId, "view"))) return null;
  const [profile, orders] = await Promise.all([
    db.resellerProfile.findUnique({ where: { companyId }, select: { creditLimit: true } }),
    db.companyProduct.findMany({
      where: { companyId, orderStatus: { notIn: ["REJECTED", "CANCELLED"] } },
      select: {
        quantity: true,
        unitPrice: true,
        item: { select: { sellingPrice: true, taxRatePercent: true } },
        allocations: { select: { amount: true } },
      },
    }),
  ]);

  let billed = 0;
  let paid = 0;
  for (const o of orders) {
    const { total } = calculateOrderAmount({
      quantity: o.quantity,
      unitPrice: Number(o.unitPrice ?? o.item.sellingPrice),
      taxRatePercent: o.item.taxRatePercent ? Number(o.item.taxRatePercent) : null,
    });
    billed += total;
    paid += o.allocations.reduce((sum, a) => sum + Number(a.amount), 0);
  }

  const outstanding = Math.round((billed - paid) * 100) / 100;
  const creditLimit = profile?.creditLimit ? Number(profile.creditLimit) : null;
  return {
    creditLimit,
    outstanding,
    available: creditLimit === null ? null : Math.round((creditLimit - outstanding) * 100) / 100,
    overLimit: creditLimit !== null && outstanding > creditLimit,
  };
}

/**
 * A change asks what the module's pages ask: Resellers switched on for the company and open to this
 * person (isModuleEnabled: the switch and the role's section), not only in the plan.
 */
const CLOSED = "Resellers isn't open to you here.";

export async function updateResellerProfile(companyId: string, input: unknown): Promise<ActionResult<null>> {
  const user = await requireModuleUser("resellers");
  if (!(await isModuleEnabled("resellers"))) return { ok: false, error: CLOSED };
  const parsed = resellerProfileSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const profile = await db.resellerProfile.findUnique({ where: { companyId } });
  if (!profile || !(await reaches(user.id, companyId, "edit"))) {
    return { ok: false, error: "That company isn't a reseller." };
  }

  const data = parsed.data;
  // The credit limit is the Credit tab's: "Override credit terms & limits" and a reason kept on the
  // credit record (src/actions/credit.ts). The onboarding form shows it and sends it back as it was;
  // a different one sent here would be the same change with neither.
  const storedLimit = profile.creditLimit == null ? null : Number(profile.creditLimit);
  const askedLimit = data.creditLimit ?? null;
  if (askedLimit !== storedLimit) {
    return { ok: false, error: "Change the credit limit from the Credit tab — it needs the credit permission and a reason." };
  }
  // R3-18 (low): the approval is the approver's own act, recorded from the session.
  const askedApprover = data.agreementApprovedByUserId || null;
  if (askedApprover && askedApprover !== profile.agreementApprovedByUserId) {
    if (askedApprover !== user.id) return { ok: false, error: "The agreement's approval is recorded by the approver — ask them to open this and record it." };
    const viewingAs = await refuseWhileViewingAs();
    if (viewingAs) return { ok: false, error: viewingAs };
    if (!(await can(user.id, APPROVER_KEY))) return { ok: false, error: "Approving a reseller agreement needs “Manage settings”." };
  }
  await db.resellerProfile.update({
    where: { companyId },
    data: {
      agreementSignedOn: data.agreementSignedOn ? new Date(data.agreementSignedOn) : null,
      agreementReference: data.agreementReference || null,
      agreementApprovedByUserId: data.agreementApprovedByUserId || null,
      tier: data.tier || null,
      discountPercent: data.discountPercent ?? null,
      notes: data.notes || null,
    },
  });

  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ResellerProfile", entityId: profile.id, entityLabel: "Reseller onboarding" });
  revalidatePath(`/companies/${companyId}`);
  revalidatePath("/resellers");
  return { ok: true, data: null };
}

/**
 * Activation is the gate: a reseller can't go ACTIVE with onboarding steps still outstanding, since
 * being ACTIVE is exactly what unblocks order punching.
 */
export async function setResellerStatus(companyId: string, status: ResellerOnboardingStatus): Promise<ActionResult<null>> {
  const user = await requireModuleUser("resellers");
  if (!(await isModuleEnabled("resellers"))) return { ok: false, error: CLOSED };
  const onboarding = await getResellerOnboarding(companyId);
  if (!onboarding || !(await reaches(user.id, companyId, "edit"))) {
    return { ok: false, error: "That company isn't a reseller." };
  }

  if (status === "ACTIVE" && !isOnboardingComplete(onboarding.inputs)) {
    const missing = outstandingOnboardingItems(onboarding.inputs).map((i) => i.label);
    return { ok: false, error: `Onboarding isn't complete — still outstanding: ${missing.join(", ")}.` };
  }
  // R3-18 (low): activating is an approver's decision, and not the decision of whoever last changed onboarding.
  if (status === "ACTIVE" && onboarding.profile.status !== "ACTIVE") {
    const viewingAs = await refuseWhileViewingAs();
    if (viewingAs) return { ok: false, error: viewingAs };
    if (!(await can(user.id, APPROVER_KEY))) return { ok: false, error: "Activating a reseller needs “Manage settings”." };
    const lastEdit = await db.auditLog.findFirst({
      where: { entityType: "ResellerProfile", entityId: onboarding.profile.id, entityLabel: "Reseller onboarding" },
      orderBy: { createdAt: "desc" },
      select: { userId: true, impersonatedByUserId: true },
    });
    if (lastEdit && (lastEdit.userId === user.id || lastEdit.impersonatedByUserId === user.id)) {
      return { ok: false, error: "You last changed this reseller's onboarding, so somebody else has to activate it." };
    }
  }

  await db.resellerProfile.update({
    where: { companyId },
    data: { status, activatedAt: status === "ACTIVE" ? (onboarding.profile.activatedAt ?? new Date()) : onboarding.profile.activatedAt },
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "ResellerProfile",
    entityId: onboarding.profile.id,
    entityLabel: `${onboarding.company.name} → ${status}`,
  });
  revalidatePath(`/companies/${companyId}`);
  revalidatePath("/resellers");
  return { ok: true, data: null };
}

export async function listResellerItemPrices(resellerId: string) {
  const user = await requireModuleUser("resellers");
  if (!(await reaches(user.id, resellerId, "view"))) return [];
  return toPlain(
    await db.resellerItemPrice.findMany({
      where: { resellerId },
      orderBy: { item: { name: "asc" } },
      include: { item: { select: { id: true, name: true, sku: true, unit: true, sellingPrice: true } } },
    }),
  );
}

export async function upsertResellerItemPrice(resellerId: string, input: unknown): Promise<ActionResult<null>> {
  const user = await requireModuleUser("resellers");
  if (!(await isModuleEnabled("resellers"))) return { ok: false, error: CLOSED };
  const parsed = resellerItemPriceSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const reseller = await db.company.findUnique({ where: { id: resellerId }, select: { relationshipType: true } });
  if (!reseller || reseller.relationshipType !== "RESELLER" || !(await reaches(user.id, resellerId, "edit"))) {
    return { ok: false, error: "That company isn't a reseller." };
  }

  const { itemId, price, notes } = parsed.data;
  try {
    await db.resellerItemPrice.upsert({
      where: { resellerId_itemId: { resellerId, itemId } },
      create: { resellerId, itemId, price, notes: notes || null },
      update: { price, notes: notes || null },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
      return { ok: false, error: "That product no longer exists." };
    }
    throw err;
  }

  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ResellerItemPrice", entityId: resellerId, entityLabel: "Reseller pricing" });
  revalidatePath(`/companies/${resellerId}`);
  return { ok: true, data: null };
}

export async function deleteResellerItemPrice(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("resellers");
  if (!(await isModuleEnabled("resellers"))) return { ok: false, error: CLOSED };
  const existing = await db.resellerItemPrice.findUnique({ where: { id } });
  if (!existing || !(await reaches(user.id, existing.resellerId, "edit"))) {
    return { ok: false, error: "Price not found." };
  }
  await db.resellerItemPrice.delete({ where: { id } });
  revalidatePath(`/companies/${existing.resellerId}`);
  return { ok: true, data: null };
}

/**
 * The price a reseller pays for one item — used by the punch form to fill in the sale price. Only for a reseller this
 * person may see, as the punch form asks it (`punchItemContext`, src/actions/order-punch.ts); another answers as missing
 * (owner, 3 Nov 2026 — Phase 2 permission fixes, audit L-2: it had no check of its own).
 */
export async function getResellerPriceForItem(resellerId: string, itemId: string) {
  const user = await requireModuleAccess("resellers");
  if (!(await reaches(user.id, resellerId, "view"))) return null;
  const [profile, special, item] = await Promise.all([
    db.resellerProfile.findUnique({ where: { companyId: resellerId }, select: { discountPercent: true } }),
    db.resellerItemPrice.findUnique({ where: { resellerId_itemId: { resellerId, itemId } }, select: { price: true } }),
    db.item.findUnique({ where: { id: itemId }, select: { sellingPrice: true } }),
  ]);
  if (!item) return null;
  return {
    catalogPrice: Number(item.sellingPrice),
    specialPrice: special ? Number(special.price) : null,
    discountPercent: profile?.discountPercent ? Number(profile.discountPercent) : null,
  };
}

/**
 * Bulk status/tier changes from the reseller list. Status goes through `setResellerStatus` per
 * reseller so the activation gate still applies — being ACTIVE is what unblocks order punching, and
 * a bulk path that skipped the onboarding check would be a way to let unvetted resellers trade.
 * Resellers that fail the gate are reported by name rather than failing the whole batch.
 */
export async function bulkUpdateResellers(input: unknown): Promise<ActionResult<{ count: number; blocked: string[] }>> {
  const user = await requireModuleAccess("resellers");
  if (!(await isModuleEnabled("resellers"))) return { ok: false, error: CLOSED };
  const parsed = bulkUpdateResellersSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { companyIds, status, tier } = parsed.data;
  if (!status && !tier) return { ok: false, error: "Pick a status or tier to apply." };

  const blocked: string[] = [];
  let changed = 0;

  for (const companyId of companyIds) {
    // Ticked on a list of the resellers this person may open. One posted from outside it is refused,
    // named by the id it came as — its name is not theirs to read.
    if (!(await reaches(user.id, companyId, "edit"))) {
      blocked.push(companyId);
      continue;
    }
    if (tier) {
      await db.resellerProfile.updateMany({ where: { companyId }, data: { tier } });
    }
    if (status) {
      const result = await setResellerStatus(companyId, status);
      if (!result.ok) {
        const company = await db.company.findUnique({ where: { id: companyId }, select: { name: true } });
        blocked.push(company?.name ?? companyId);
        continue;
      }
    }
    changed += 1;
  }

  revalidatePath("/resellers");
  return { ok: true, data: { count: changed, blocked } };
}
