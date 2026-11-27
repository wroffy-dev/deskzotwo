"use server";

import { db } from "@/lib/db";
import { plainError } from "@/lib/plain-error";
import { can } from "@/lib/authz/resolve";
import { requireModuleAccess } from "@/lib/modules-access";
import { listRegistrationChoices } from "@/lib/branches/identity";
import { countsForReturn } from "@/lib/ledger/gst-returns";
import { parseGstr2b, reconcileGstr2b, type BookBill, type MatchRow, type TwoBRow } from "@/lib/ledger/gstr2b";
import { indiaClock } from "@/lib/time/zone";
import type { ActionResult } from "@/actions/company";

/**
 * GSTR-2B against the bills (owner, 29 Oct 2026; src/lib/ledger/gstr2b.ts): the portal's file uploaded, matched, shown
 * — nothing kept. Whoever keeps the books, as the GST page asks (`payments.manage`).
 */

/** How far back a bill can be and still be what a vendor filed this month: a late filing of an older invoice. */
const LOOK_BACK_MONTHS = 3;

export type Gstr2bResult = { gstin: string; month: number; year: number; rows: MatchRow[]; notes: TwoBRow[]; billsLooked: number };

export async function reconcileGstr2bFile(text: string): Promise<ActionResult<Gstr2bResult>> {
  const user = await requireModuleAccess("accounting");
  if (!(await can(user.id, "payments.manage"))) return { ok: false, error: "Reconciling GSTR-2B needs the right to manage finance records." };
  if (typeof text !== "string" || !text.trim()) return { ok: false, error: "Choose the GSTR-2B JSON file first." };

  let file;
  try {
    file = parseGstr2b(text);
  } catch (e) {
    return { ok: false, error: plainError(e, "That file couldn't be read — choose the GSTR-2B JSON downloaded from the GST portal.") };
  }
  const m = /^(\d{2})(\d{4})$/.exec(file.period);
  if (!m) return { ok: false, error: "The file doesn't say which month it is for (rtnprd)." };
  const month = Number(m[1]);
  const year = Number(m[2]);

  // The registration the 2B is for — the file names it; a GSTIN that isn't ours is somebody else's file.
  const registration = (await listRegistrationChoices()).find((r) => r.gstin.toUpperCase() === file.gstin);
  if (!registration) return { ok: false, error: `This GSTR-2B is for ${file.gstin || "no GSTIN"}, which isn't one of this business's GST registrations.` };

  const from = indiaClock.midnight(year, month - 1 - LOOK_BACK_MONTHS, 1);
  const periodFrom = indiaClock.midnight(year, month - 1, 1);
  const before = indiaClock.midnight(year, month, 1);
  const raw = await db.tradeDocument.findMany({
    where: { docType: "BILL", direction: "PURCHASE", gstRegistrationId: registration.id, issueDate: { gte: from, lt: before } },
    select: { id: true, docNumber: true, reference: true, status: true, sellerGstin: true, issueDate: true, taxableValue: true, igstAmount: true, cgstAmount: true, sgstAmount: true, company: { select: { name: true } } },
    orderBy: { issueDate: "asc" },
    take: 20_000,
  });
  const periodStart = indiaClock.dateKey(periodFrom);
  const bills: BookBill[] = raw
    .filter((b) => countsForReturn(b))
    .map((b) => ({
      id: b.id,
      docNumber: b.docNumber,
      reference: b.reference,
      vendorGstin: b.sellerGstin,
      vendorName: b.company.name,
      date: indiaClock.dateKey(b.issueDate),
      taxableValue: Number(b.taxableValue),
      igst: Number(b.igstAmount),
      cgst: Number(b.cgstAmount),
      sgst: Number(b.sgstAmount),
    }));
  const rows = reconcileGstr2b(file.rows, bills, (b) => b.date >= periodStart);
  return { ok: true, data: { gstin: file.gstin, month, year, rows, notes: file.rows.filter((r) => r.kind !== "INVOICE"), billsLooked: bills.length } };
}
