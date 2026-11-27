"use server";

import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { refuseWhileViewingAs } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { copilotConfig } from "@/lib/copilot/settings";
import { documentWriteKey } from "@/lib/documents/write-permission";
import { workspacePack } from "@/lib/country-pack";
import { createTradeDocument } from "@/actions/trade-document";
import { BillReadRefusal, matchItems, openPos, readBill, readingView, unknownHsnLines, type ReadingView } from "@/lib/bill-reader/server";
import { draftInput } from "@/lib/bill-reader/rules";
import type { ActionResult } from "@/actions/company";
import { mailBillToRead, skipMailBill } from "@/lib/mail-reading/arjun";
import { firstReadableFile } from "@/lib/mail-reading/attachments";

/**
 * Arjun reading a vendor's bill (owner, 20 Nov 2026 — src/lib/bill-reader). Reading one takes what entering a bill takes
 * (the purchase documents module and the right to create bills) and Deskzo AI on, with "Use Deskzo AI" — it spends
 * credits. The draft goes through `createTradeDocument`, the bill form's own door, so it meets every rule a typed bill
 * does. Never while viewing as somebody.
 */

async function who(): Promise<{ id: string } | { error: string }> {
  const user = await requireModuleUser("purchase_documents");
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { error: viewingAs };
  if (!(await can(user.id, documentWriteKey("BILL", "create")))) return { error: "Reading a bill makes a draft bill — that takes the right to create bills." };
  // Its checks are India's GST — GSTINs, CGST and SGST against IGST, HSN (src/lib/bill-reader/rules.ts). Elsewhere, by hand.
  if (!workspacePack().india) return { error: "Arjun reads India's GST bills for now — enter this one by hand." };
  return { id: user.id };
}

/** A file uploaded, read, and the review the screen shows. */
export async function readBillFile(form: FormData): Promise<ActionResult<ReadingView>> {
  const user = await who();
  if ("error" in user) return { ok: false, error: user.error };
  if (!(await copilotConfig()).enabled) return { ok: false, error: "Deskzo AI is switched off for this workspace." };
  if (!(await can(user.id, "copilot.use"))) return { ok: false, error: "Reading bills uses Deskzo AI — that takes the “Use Deskzo AI” permission." };
  const file = form.get("file");
  if (!(file instanceof File)) return { ok: false, error: "Choose the bill's file first." };
  try {
    const id = await readBill(user.id, { name: file.name, type: file.type, bytes: Buffer.from(await file.arrayBuffer()) });
    const view = await readingView(id, user.id);
    return view ? { ok: true, data: view } : { ok: false, error: "The reading wasn't found." };
  } catch (err) {
    if (err instanceof BillReadRefusal) return { ok: false, error: err.message };
    throw err;
  }
}

/** The review again — with a vendor or purchase order chosen. */
export async function reviewBillReading(input: { id: string; vendorId?: string | null; poId?: string | null }): Promise<ActionResult<ReadingView>> {
  const user = await who();
  if ("error" in user) return { ok: false, error: user.error };
  const view = await readingView(String(input?.id ?? ""), user.id, {
    ...(input?.vendorId !== undefined ? { vendorId: input.vendorId ? String(input.vendorId) : null } : {}),
    ...(input?.poId !== undefined ? { poId: input.poId ? String(input.poId) : null } : {}),
  });
  return view ? { ok: true, data: view } : { ok: false, error: "That reading isn't there any more." };
}

/**
 * The draft bill, from a reading and what the person chose: the vendor, their address, the purchase order, the bill's
 * number and dates. A check that stops it — not a bill, already entered, another currency — means no draft.
 */
export async function makeDraftBill(input: {
  id: string;
  vendorId: string;
  poId?: string | null;
  billNumber: string;
  billDate: string;
  dueDate?: string | null;
}): Promise<ActionResult<{ documentId: string }>> {
  const user = await who();
  if ("error" in user) return { ok: false, error: user.error };
  const vendorId = String(input?.vendorId ?? "");
  if (!vendorId) return { ok: false, error: "Choose the vendor first." };
  const poId = input?.poId ? String(input.poId) : null;
  const view = await readingView(String(input?.id ?? ""), user.id, { vendorId, poId });
  if (!view?.bill) return { ok: false, error: "That reading isn't there any more." };
  if (view.documentId) return { ok: true, data: { documentId: view.documentId } };
  const billNumber = String(input?.billNumber ?? "").trim();
  if (!billNumber) return { ok: false, error: "Type the vendor's bill number." };
  const billDate = String(input?.billDate ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(billDate)) return { ok: false, error: "Pick the bill's date." };
  const dueDate = input?.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(String(input.dueDate)) ? String(input.dueDate) : null;
  // The checks again, for the number as typed.
  const bill = { ...view.bill, billNumber };
  const stop = view.checks.find((c) => c.level === "stop" && !c.text.startsWith("This vendor's bill"));
  if (stop) return { ok: false, error: stop.text };

  // Their address with the bill's GSTIN, where they have one.
  const location = bill.vendorGstin
    ? await db.companyLocation.findFirst({ where: { companyId: vendorId, gstNumber: { equals: bill.vendorGstin, mode: "insensitive" } }, select: { id: true } })
    : null;
  const po = poId ? ((await openPos(vendorId)).find((p) => p.id === poId) ?? null) : null;
  if (poId && !po) return { ok: false, error: "That purchase order isn't open to bill any more." };
  const [items, unknownHsn] = await Promise.all([matchItems(bill, po), unknownHsnLines(bill)]);
  const created = await createTradeDocument(
    draftInput(bill, { vendorId, locationId: location?.id ?? null, poId, billNumber, billDate, dueDate, itemIds: items.map((i) => i?.id ?? null) }, { unknownHsn, fileName: view.fileName }),
    "MANUAL",
  );
  if (!created.ok) return created;
  // The same file read twice and sent again at once is the bill form's double click (src/lib/request-once.ts): the
  // first draft comes back, already another reading's — it's that bill.
  const taken = await db.billReading.findUnique({ where: { documentId: created.data.id }, select: { id: true } });
  if (taken && taken.id !== view.id) return { ok: true, data: { documentId: created.data.id } };
  await db.billReading.update({ where: { id: view.id }, data: { status: "USED", documentId: created.data.id } });
  return { ok: true, data: { documentId: created.data.id } };
}

/**
 * A vendor's bill that came by email to the person's own mailbox (owner, 23 Nov 2026 — Arjun reading money mail,
 * src/lib/mail-reading/arjun.ts): its attachment fetched from the mailbox and read as an upload would be. Its id, for
 * the screen to open (?reading=).
 */
export async function readBillFromMail(messageId: string): Promise<ActionResult<{ id: string }>> {
  const user = await who();
  if ("error" in user) return { ok: false, error: user.error };
  if (!(await copilotConfig()).enabled) return { ok: false, error: "Deskzo AI is switched off for this workspace." };
  if (!(await can(user.id, "copilot.use"))) return { ok: false, error: "Reading bills uses Deskzo AI — that takes the “Use Deskzo AI” permission." };
  const mail = await mailBillToRead(user.id, String(messageId ?? ""));
  if (!mail) return { ok: false, error: "That email isn't one Arjun may read for you any more." };
  const file = await firstReadableFile(mail.userId, mail.providerId);
  if (!file) return { ok: false, error: "That email has no PDF or picture of a bill Arjun can read (5 MB at most) — or your mailbox didn't give it. Open it in your mail and upload the bill here." };
  try {
    return { ok: true, data: { id: await readBill(user.id, file) } };
  } catch (err) {
    if (err instanceof BillReadRefusal) return { ok: false, error: err.message };
    throw err;
  }
}

/** Not a bill, or entered already: off the list. */
export async function skipBillFromMail(messageId: string): Promise<ActionResult<null>> {
  const user = await who();
  if ("error" in user) return { ok: false, error: user.error };
  return (await skipMailBill(user.id, String(messageId ?? ""))) ? { ok: true, data: null } : { ok: false, error: "That email isn't in your list." };
}
