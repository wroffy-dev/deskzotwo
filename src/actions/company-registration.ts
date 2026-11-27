"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { refuseWhileViewingAs, requireUser } from "@/lib/session";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { mayAccess } from "@/lib/authz/access";
import { hasEffectivePermission } from "@/actions/permission";
import { companyMasker } from "@/lib/companies/masking";
import { workspacePack } from "@/lib/country-pack";
import { notMigratedYet } from "@/lib/not-migrated";
import {
  cinRefusal,
  cleanAuthority,
  cleanDay,
  cleanLicenceNumber,
  licenceNumberRefusal,
  normaliseCin,
} from "@/lib/companies/registration-rules";
import type { ActionResult } from "@/actions/company";

/**
 * A company's registrations (owner, 20 Nov 2026 — src/lib/companies/registration-rules.ts). The CIN or trade licence is
 * anybody's who may edit the company; its PAN stays finance's (`payments.manage`), as on Payout details — it decides
 * the TDS on every payment to it — and is never changed by somebody it is masked for.
 */

export type RegistrationInput = {
  cin?: string;
  /** Sent only by somebody the card let change it. */
  panNumber?: string;
  tradeLicenceNumber?: string;
  tradeLicenceAuthority?: string;
  /** yyyy-mm-dd, or "" for none. */
  tradeLicenceExpiresOn?: string;
};

const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export async function setCompanyRegistration(companyId: string, input: RegistrationInput): Promise<ActionResult<null>> {
  const user = await requireUser();
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  const company = await db.company.findUnique({
    where: { id: String(companyId ?? "") },
    select: { id: true, name: true, ownerUserId: true, relationshipType: true, panNumber: true },
  });
  if (!company || !(await canSeeCompany(user.id, company))) return { ok: false, error: "Company not found." };
  if (!(await mayAccess(user.id, "companies", "edit", company.id))) return { ok: false, error: "You can't edit this company." };

  const india = workspacePack().india;
  const changes: string[] = [];
  let data: { cin: string | null } | { tradeLicenceNumber: string | null; tradeLicenceAuthority: string | null; tradeLicenceExpiresOn: Date | null };

  if (india) {
    const refusal = cinRefusal(input?.cin);
    if (refusal) return { ok: false, error: refusal };
    data = { cin: normaliseCin(input?.cin) || null };

    if (input?.panNumber !== undefined) {
      const pan = String(input.panNumber ?? "").replace(/\s+/g, "").toUpperCase();
      if (pan !== (company.panNumber ?? "")) {
        if (!(await hasEffectivePermission(user.id, "payments.manage"))) {
          return { ok: false, error: "Changing a company's PAN needs the “Manage finance records” permission." };
        }
        if ((await companyMasker(user.id, "detail")).flags.pan) return { ok: false, error: "The PAN is masked for you, so it can't be changed here." };
        if (pan && !PAN.test(pan)) return { ok: false, error: "PAN must look like ABCDE1234F." };
        await db.company.update({ where: { id: company.id }, data: { panNumber: pan || null } });
        changes.push(pan ? "PAN changed" : "PAN removed");
      }
    }
  } else {
    const refusal = licenceNumberRefusal(input?.tradeLicenceNumber);
    if (refusal) return { ok: false, error: refusal };
    const day = cleanDay(input?.tradeLicenceExpiresOn);
    if (day === null) return { ok: false, error: "Enter the expiry as a date." };
    const number = cleanLicenceNumber(input?.tradeLicenceNumber) || null;
    data = {
      tradeLicenceNumber: number,
      tradeLicenceAuthority: number ? cleanAuthority(input?.tradeLicenceAuthority) || null : null,
      tradeLicenceExpiresOn: number && day ? new Date(`${day}T00:00:00Z`) : null,
    };
  }

  try {
    const before = await db.companyRegistration.findUnique({ where: { companyId: company.id } });
    const after = { ...(before ?? {}), ...data };
    const empty = !after.cin && !after.tradeLicenceNumber;
    const differs = Object.entries(data).some(([k, v]) => {
      const was = before?.[k as keyof typeof before];
      return (was instanceof Date ? was.getTime() : (was ?? null)) !== (v instanceof Date ? v.getTime() : v);
    });
    if (empty) {
      if (before) await db.companyRegistration.delete({ where: { companyId: company.id } });
    } else if (differs) {
      await db.companyRegistration.upsert({
        where: { companyId: company.id },
        create: { companyId: company.id, ...data, updatedById: user.id },
        update: { ...data, updatedById: user.id },
      });
    }
    if (differs) changes.push(india ? (after.cin ? `CIN ${after.cin}` : "CIN removed") : after.tradeLicenceNumber ? `trade licence ${after.tradeLicenceNumber}` : "trade licence removed");
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: "This workspace isn't ready for registrations yet — try again in a few minutes." };
    throw err;
  }

  if (changes.length) {
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Company", entityId: company.id, entityLabel: `${company.name}: ${changes.join(", ")}` });
  }
  revalidatePath(`/companies/${company.id}`);
  return { ok: true, data: null };
}
