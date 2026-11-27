"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { requireModuleAccess } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { DEDUCTOR_TYPES, quarterLabel } from "@/lib/tds/form140-format";
import { form140File, type TdsSettingsValues } from "@/lib/tds/form140";
import type { ActionResult } from "@/actions/company";

/**
 * The quarterly TDS statement on the TDS page (owner, 26 Oct 2026; src/lib/tds/form140.ts): the details every
 * statement repeats, the Form 140 file, and the token number a filed one was given. Finance's
 * (`payments.manage`), as the page is.
 */

async function financeUser() {
  const user = await requireModuleAccess("accounting");
  return (await hasEffectivePermission(user.id, "payments.manage")) ? user : null;
}

const REFUSED = "TDS statements need the “Manage finance records” permission.";
const text = (v: unknown, max = 120) => String(v ?? "").trim().slice(0, max);

/** Saves the TAN, the deductor category and the person responsible. A field may be left blank until it's known. */
export async function saveTdsSettings(input: TdsSettingsValues): Promise<ActionResult<null>> {
  const user = await financeUser();
  if (!user) return { ok: false, error: REFUSED };
  const tan = text(input?.tan, 10).toUpperCase();
  if (tan && !/^[A-Z]{4}[0-9]{5}[A-Z]$/.test(tan)) return { ok: false, error: "A TAN is four letters, five digits and a letter — as ABCD12345E." };
  const deductorType = text(input?.deductorType, 1).toUpperCase() || "K";
  if (!DEDUCTOR_TYPES[deductorType]) return { ok: false, error: "Choose what kind of deductor the company is." };
  const pan = text(input?.responsiblePan, 10).toUpperCase();
  if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) return { ok: false, error: "The responsible person's PAN is five letters, four digits and a letter." };
  const pincode = text(input?.responsiblePincode, 6);
  if (pincode && !/^\d{6}$/.test(pincode)) return { ok: false, error: "A PIN code is six digits." };
  const email = text(input?.responsibleEmail, 75);
  if (email && !/^[^\s@^]+@[^\s@^]+\.[^\s@^]+$/.test(email)) return { ok: false, error: "That email address isn't one." };
  const designation = text(input?.responsibleDesignation, 20);
  const data = {
    tan: tan || null,
    deductorType,
    responsibleName: text(input?.responsibleName, 75) || null,
    responsibleDesignation: designation || null,
    responsiblePan: pan || null,
    responsibleAddress: text(input?.responsibleAddress, 200) || null,
    responsibleCity: text(input?.responsibleCity, 25) || null,
    responsibleState: text(input?.responsibleState, 60) || null,
    responsiblePincode: pincode || null,
    responsibleEmail: email || null,
    responsiblePhone: text(input?.responsiblePhone, 20) || null,
    updatedById: user.id,
  };
  await db.tdsSettings.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "TdsSettings", entityId: "global", entityLabel: `TDS statement details${tan ? ` (TAN ${tan})` : ""}` });
  revalidatePath("/accounting/tds");
  return { ok: true, data: null };
}

/** The quarter's Form 140 as a file to save, or what stops it. */
export async function downloadForm140(input: { taxYear: number; quarter: number; previousToken?: string | null }): Promise<ActionResult<{ fileName: string; text: string; warnings: string[] }>> {
  const user = await financeUser();
  if (!user) return { ok: false, error: REFUSED };
  const taxYear = Math.trunc(Number(input?.taxYear));
  const quarter = Math.trunc(Number(input?.quarter));
  if (!(taxYear >= 2026 && taxYear < 2100) || !(quarter >= 1 && quarter <= 4)) return { ok: false, error: "Form 140 is for tax years from 2026-27, a quarter at a time." };
  const token = String(input?.previousToken ?? "").replace(/\s/g, "");
  if (token && !/^\d{15}$/.test(token)) return { ok: false, error: "The previous statement's token number is fifteen digits." };
  const made = await form140File({ taxYear, quarter, previousToken: token || null }, user.id);
  if (!made.ok) return { ok: false, error: `Not yet — ${made.problems.length === 1 ? made.problems[0] : `${made.problems.length} things to fix first, listed on the page.`}` };
  await recordAudit({ userId: user.id, action: "CREATE", entityType: "TdsStatement", entityId: `140:${taxYear}:${quarter}`, entityLabel: `Form 140 file for ${quarterLabel(taxYear, quarter)}: ${made.summary.deductees} deductee row(s), ${made.summary.challans} challan(s)` });
  revalidatePath("/accounting/tds");
  return { ok: true, data: { fileName: made.fileName, text: made.text, warnings: made.warnings } };
}

/** The token number the e-filing portal gave a filed statement — which the next quarter's must quote. Blank clears it. */
export async function saveTdsStatementToken(input: { taxYear: number; quarter: number; tokenNumber: string; filedOn?: string | null }): Promise<ActionResult<null>> {
  const user = await financeUser();
  if (!user) return { ok: false, error: REFUSED };
  const taxYear = Math.trunc(Number(input?.taxYear));
  const quarter = Math.trunc(Number(input?.quarter));
  if (!(taxYear >= 2026 && taxYear < 2100) || !(quarter >= 1 && quarter <= 4)) return { ok: false, error: "Choose the quarter." };
  const token = String(input?.tokenNumber ?? "").replace(/\s/g, "");
  if (token && !/^\d{15}$/.test(token)) return { ok: false, error: "A token number is fifteen digits, as on the filing's acknowledgement." };
  const filedOn = /^\d{4}-\d{2}-\d{2}$/.test(String(input?.filedOn ?? "")) ? new Date(`${input.filedOn}T00:00:00Z`) : null;
  await db.tdsStatement.upsert({
    where: { formNumber_taxYear_quarter: { formNumber: "140", taxYear, quarter } },
    create: { formNumber: "140", taxYear, quarter, tokenNumber: token || null, filedOn },
    update: { tokenNumber: token || null, filedOn },
  });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "TdsStatement", entityId: `140:${taxYear}:${quarter}`, entityLabel: token ? `Form 140 for ${quarterLabel(taxYear, quarter)} filed under token ${token}` : `Form 140 token for ${quarterLabel(taxYear, quarter)} cleared` });
  revalidatePath("/accounting/tds");
  return { ok: true, data: null };
}
