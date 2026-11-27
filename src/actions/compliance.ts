"use server";

import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/authz/resolve";
import { filingCalendar, markFiling } from "@/lib/compliance/filings";
import { requireModuleAccess } from "@/lib/modules-access";
import type { ActionResult } from "@/actions/company";

/**
 * The filing calendar on Accounting (owner, 29 Oct 2026; src/lib/compliance): GSTR-1, GSTR-3B, TDS deposited and its
 * returns, coming and missed — and marking one filed. Whoever keeps the books, as the GST page asks (`payments.manage`).
 */

async function keeper() {
  const user = await requireModuleAccess("accounting");
  return (await can(user.id, "payments.manage")) ? user : null;
}

export async function filingDeadlines() {
  if (!(await keeper())) return null;
  return filingCalendar();
}

const KEY = /^(GSTR1|GSTR3B|TDS_DEPOSIT):\d{4}-\d{2}$|^(TDS26Q|TDS24Q|TCS27EQ):\d{4}-Q[1-4]$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Marks a filing done (its reminder stops), or with `filedOn` null takes the mark back. */
export async function markFilingDone(key: string, filedOn: string | null, reference?: string | null): Promise<ActionResult<null>> {
  const user = await keeper();
  if (!user) return { ok: false, error: "Marking filings needs the right to manage finance records." };
  const k = String(key ?? "");
  if (!KEY.test(k)) return { ok: false, error: "That isn't a filing on the calendar." };
  if (filedOn !== null && !DAY.test(String(filedOn))) return { ok: false, error: "Give the day it was filed." };
  const ref = reference ? String(reference).trim().slice(0, 100) || null : null;
  await markFiling(k, filedOn, ref, user.id);
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ComplianceFiling", entityId: k, entityLabel: filedOn ? `Marked ${k} filed on ${filedOn}${ref ? ` (${ref})` : ""}` : `Took back ${k} as filed` });
  revalidatePath("/accounting");
  return { ok: true, data: null };
}
