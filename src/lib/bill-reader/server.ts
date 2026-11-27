import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { aiFilesRefused, aiTurn, AiRefusal } from "@/lib/ai/gateway";
import { workspaceClock } from "@/lib/time/workspace";
import { baseCurrency } from "@/lib/currency";
import { keepDataUrl, storedFile } from "@/lib/storage/files";
import { keepOrRefuse } from "@/lib/file-refusal";
import { branchIdentity, defaultBranchIdFor } from "@/lib/branches/identity";
import { duplicateVendorBillRefusal } from "@/lib/documents/create-draft";
import { knownHsnCodes } from "@/lib/platform/hsn-directory";
import { vendorSide } from "@/lib/companies/roles";
import { teammateWork } from "@/lib/ai/teammate-work";
import { BILL_STEPS } from "@/lib/ai/teammate-steps";
import {
  ACCEPTED_TYPES,
  FILE_MAX_BYTES,
  PDF_MAX_PAGES,
  PROPOSE_BILL,
  READ_BILL_SYSTEM,
  checkBill,
  isAcceptedType,
  nameOverlap,
  proposedBillSchema,
  settleBill,
  type BillCheck,
  type ReadBill,
} from "@/lib/bill-reader/rules";

/**
 * Arjun reading a vendor's bill (owner, 20 Nov 2026 — the rules and checks are ./rules.ts).
 *
 *   · The file is kept first — in the storage box, as every document's is (src/lib/storage/registry.ts) — so the bill
 *     made from it can always show the vendor's original. Then Deskzo AI reads it, charged to the person who uploaded it
 *     (feature `bills.read`), seen working as Arjun.
 *   · What was read is checked, and matched: the vendor by their GSTIN on a vendor's address (else offered by name),
 *     our purchase order by the number the bill quotes (else the vendor's open ones offered), and each line to a PO
 *     line or a catalogue item by its words.
 *   · The draft itself is made by the action (src/actions/bill-reader.ts) through the bill form's own door.
 */

export class BillReadRefusal extends Error {}

export type VendorOption = { id: string; name: string; locationId: string | null; gstin: string | null };
export type PoOption = { id: string; number: string; issued: string; lines: { itemId: string | null; name: string }[] };

export type ReadingView = {
  id: string;
  fileName: string;
  contentType: string;
  status: string;
  bill: ReadBill | null;
  checks: BillCheck[];
  /** The vendor their GSTIN found, when it did. */
  vendor: VendorOption | null;
  /** Vendors whose names are like the bill's, when the GSTIN found none. */
  vendorCandidates: VendorOption[];
  /** The chosen vendor's open purchase orders; `poId` the one the bill quotes. */
  pos: PoOption[];
  poId: string | null;
  /** By line: the catalogue item matched, and its name. */
  items: ({ id: string; name: string } | null)[];
  documentId: string | null;
  error: string | null;
};

const base64Of = (bytes: Buffer) => bytes.toString("base64");

/** Pages in a PDF, or null when it can't be opened as one. */
async function pdfPages(bytes: Uint8Array): Promise<number | null> {
  try {
    const { getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
    return pdf.numPages;
  } catch {
    return null;
  }
}

/** The company's own GSTINs, and the state the person's branch is in. */
async function ours(userId: string): Promise<{ gstins: string[]; stateCode: string | null }> {
  const [regs, identity] = await Promise.all([
    db.gstRegistration.findMany({ where: { active: true }, select: { gstin: true } }).catch(() => []),
    defaultBranchIdFor(userId)
      .then((id) => branchIdentity(id))
      .catch(() => null),
  ]);
  return { gstins: regs.map((r) => r.gstin.toUpperCase()), stateCode: identity?.stateCode ?? null };
}

/** The vendor a GSTIN belongs to, on one of their addresses; or vendors with a name like the bill's. */
export async function matchVendor(bill: ReadBill): Promise<{ vendor: VendorOption | null; candidates: VendorOption[] }> {
  const side = await vendorSide();
  if (bill.vendorGstin) {
    const loc = await db.companyLocation.findFirst({
      where: { gstNumber: { equals: bill.vendorGstin, mode: "insensitive" }, company: side },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      select: { id: true, gstNumber: true, company: { select: { id: true, name: true } } },
    });
    if (loc) return { vendor: { id: loc.company.id, name: loc.company.name, locationId: loc.id, gstin: loc.gstNumber }, candidates: [] };
  }
  // The same company registered in another state — the same PAN, the middle ten of the GSTIN — first (owner, 23 Nov
  // 2026: Savex's Maharashtra GSTIN on a bill to a Savex kept with another). Offered, not chosen: the address differs.
  const pan = bill.vendorGstin && bill.vendorGstin.length === 15 ? bill.vendorGstin.slice(2, 12).toUpperCase() : null;
  const samePan = pan
    ? await db.companyLocation.findMany({
        where: { gstNumber: { contains: pan, mode: "insensitive" }, company: side },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        take: 3,
        select: { gstNumber: true, company: { select: { id: true, name: true } } },
      })
    : [];
  const byName = await vendorsNamedLike(bill.vendorName ?? "", side);
  const seen = new Set<string>();
  const candidates: VendorOption[] = [];
  for (const c of [...samePan.map((l) => ({ id: l.company.id, name: l.company.name, locationId: null, gstin: l.gstNumber })), ...byName]) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    candidates.push(c);
  }
  return { vendor: null, candidates: candidates.slice(0, 6) };
}

/** Words every other company has in its name: none of them tells one vendor from another. */
const GENERIC = new Set(
  "private pvt limited ltd llp india the and of co company corporation corp enterprise enterprises trader traders technologies technology tech solution solutions system systems service services infotech infosystems infosys software softwares network networks international global digital computer computers consultancy consulting consultants distribution distributors distributor group industries it cloud data info".split(" "),
);

/** Vendors whose names share the bill's telling words — the brand, usually its first, counted twice. */
export async function vendorsNamedLike(name: string, side: Prisma.CompanyWhereInput): Promise<VendorOption[]> {
  const words = name
    .split(/[^A-Za-z0-9&]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 2 && !GENERIC.has(w));
  if (words.length === 0) return [];
  const rows = await db.company.findMany({ where: { AND: [side, { OR: words.map((w) => ({ name: { contains: w, mode: "insensitive" as const } })) }] }, take: 40, select: { id: true, name: true } });
  const score = (n: string) => words.reduce((s, w, i) => s + (n.toLowerCase().includes(w) ? (i === 0 ? 2 : 1) : 0), 0);
  return rows
    .map((r) => ({ r, s: score(r.name) }))
    .sort((a, b) => b.s - a.s || a.r.name.localeCompare(b.r.name))
    .slice(0, 6)
    .map(({ r }) => ({ id: r.id, name: r.name, locationId: null, gstin: null }));
}

/** A vendor's purchase orders still open to bill, newest first. */
export async function openPos(vendorId: string): Promise<PoOption[]> {
  const rows = await db.tradeDocument.findMany({
    where: { companyId: vendorId, docType: "PURCHASE_ORDER", status: { notIn: ["DRAFT", "CANCELLED", "REJECTED", "EXPIRED"] } },
    orderBy: { issueDate: "desc" },
    take: 20,
    select: { id: true, docNumber: true, issueDate: true, lines: { orderBy: { sortOrder: "asc" }, select: { itemId: true, name: true } } },
  });
  return rows.map((r) => ({ id: r.id, number: r.docNumber, issued: r.issueDate.toISOString().slice(0, 10), lines: r.lines.map((l) => ({ itemId: l.itemId, name: l.name })) }));
}

const squash = (s: string) => s.replace(/[^a-z0-9]/gi, "").toLowerCase();

/** Each line's item: the PO line's it reads most like, else a catalogue item of the same name. */
export async function matchItems(bill: ReadBill, po: PoOption | null): Promise<({ id: string; name: string } | null)[]> {
  const names = bill.lines.map((l) => l.description);
  const catalogue = await db.item.findMany({ where: { name: { in: names, mode: "insensitive" } }, select: { id: true, name: true } }).catch(() => []);
  const ids = [...new Set((po?.lines ?? []).flatMap((l) => (l.itemId ? [l.itemId] : [])))];
  const itemNames = new Map((ids.length ? await db.item.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []).map((i) => [i.id, i.name]));
  return bill.lines.map((l) => {
    let best: { id: string; name: string; score: number } | null = null;
    for (const p of po?.lines ?? []) {
      if (!p.itemId) continue;
      const score = Math.max(nameOverlap(l.description, p.name), nameOverlap(l.description, itemNames.get(p.itemId) ?? ""));
      if (score >= 0.6 && (!best || score > best.score)) best = { id: p.itemId, name: itemNames.get(p.itemId) ?? p.name, score };
    }
    if (best) return { id: best.id, name: best.name };
    const same = catalogue.find((c) => squash(c.name) === squash(l.description));
    return same ? { id: same.id, name: same.name } : null;
  });
}

/** Lines whose HSN/SAC the GST directory doesn't list — or isn't 4, 6 or 8 digits. */
export async function unknownHsnLines(bill: ReadBill): Promise<number[]> {
  const codes = bill.lines.map((l) => l.hsn ?? "");
  const known = await knownHsnCodes(codes.filter(Boolean)).catch(() => ({ checked: false, found: new Map() }));
  return codes.flatMap((c, i) => (c && (!/^(\d{4}|\d{6}|\d{8})$/.test(c) || (known.checked && !known.found.has(c))) ? [i] : []));
}

/** The checks for a bill, with a vendor chosen (for "already entered"). */
export async function checksFor(bill: ReadBill, userId: string, vendorId: string | null, billNumber: string | null): Promise<BillCheck[]> {
  const [own, unknownHsn, clock] = await Promise.all([ours(userId), unknownHsnLines(bill), workspaceClock()]);
  const duplicate = vendorId && billNumber ? await duplicateVendorBillRefusal(vendorId, billNumber) : null;
  return checkBill(bill, { ourGstins: own.gstins, ourStateCode: own.stateCode, baseCurrency: baseCurrency(), duplicate, unknownHsn, today: clock.today() });
}

/** Everything the review screen shows for a reading — matched again each time, so a vendor added since is found. */
export async function readingView(id: string, userId: string, chosen: { vendorId?: string | null; poId?: string | null } = {}): Promise<ReadingView | null> {
  const row = await db.billReading.findUnique({ where: { id }, select: { id: true, createdById: true, fileName: true, contentType: true, status: true, read: true, error: true, documentId: true } });
  if (!row || row.createdById !== userId) return null;
  const bill = (row.read as ReadBill | null) ?? null;
  if (!bill) return { id: row.id, fileName: row.fileName, contentType: row.contentType, status: row.status, bill: null, checks: [], vendor: null, vendorCandidates: [], pos: [], poId: null, items: [], documentId: row.documentId, error: row.error };
  const match = await matchVendor(bill);
  const vendorId = chosen.vendorId ?? match.vendor?.id ?? null;
  const pos = vendorId ? await openPos(vendorId) : [];
  const quoted = bill.poNumber ? pos.find((p) => squash(p.number) === squash(bill.poNumber!)) : undefined;
  const poId = chosen.poId !== undefined ? chosen.poId : (quoted?.id ?? null);
  const po = pos.find((p) => p.id === poId) ?? null;
  const [checks, items] = await Promise.all([checksFor(bill, userId, vendorId, bill.billNumber), matchItems(bill, po)]);
  return {
    id: row.id,
    fileName: row.fileName,
    contentType: row.contentType,
    status: row.status,
    bill,
    checks,
    vendor: match.vendor,
    vendorCandidates: match.candidates,
    pos,
    poId,
    items,
    documentId: row.documentId,
    error: row.error,
  };
}

/**
 * A file uploaded to be read: checked, kept, read by Deskzo AI as Arjun, settled and stored. Throws BillReadRefusal with
 * words for a file that can't be read at all; a bill the model couldn't make out comes back FAILED, saying so.
 */
export async function readBill(userId: string, file: { name: string; type: string; bytes: Buffer }): Promise<string> {
  const name = (file.name || "bill").replace(/[^\w .()-]+/g, "_").slice(0, 120);
  if (!isAcceptedType(file.type)) throw new BillReadRefusal(`Arjun reads ${Object.values(ACCEPTED_TYPES).join(", ")} files — that one is ${file.type || "of an unknown kind"}.`);
  if (!file.bytes.length) throw new BillReadRefusal("That file is empty.");
  if (file.bytes.length > FILE_MAX_BYTES) throw new BillReadRefusal(`That file is ${Math.round(file.bytes.length / 1024 / 1024)} MB — ${FILE_MAX_BYTES / 1024 / 1024} MB at most.`);
  if (file.type === "application/pdf") {
    const pages = await pdfPages(file.bytes);
    if (pages === null) throw new BillReadRefusal("That PDF couldn't be opened — it may be damaged or locked with a password.");
    if (pages > PDF_MAX_PAGES) throw new BillReadRefusal(`That PDF has ${pages} pages — a bill is a page or two. Upload just the bill.`);
  }
  // Before the file is kept: a masked account is never sent one (src/lib/ai/gateway.ts).
  const refused = await aiFilesRefused("bills.read");
  if (refused) throw new BillReadRefusal(refused);
  const data = base64Of(file.bytes);
  // Out of storage: refused as any file Arjun can't take is, saying so, before anything is written (src/lib/file-refusal.ts).
  const stored = await keepOrRefuse(() => keepDataUrl("bill-readings", `data:${file.type};base64,${data}`));
  if (!stored.ok) throw new BillReadRefusal(stored.error);
  const row = await db.billReading.create({ data: { createdById: userId, fileName: name, contentType: file.type, fileDataUrl: stored.value, bytes: file.bytes.length, status: "FAILED" }, select: { id: true } });

  try {
    await teammateWork(
      { teammate: "arjun", userId, kind: "bills.read", subject: `bill-reading:${row.id}`, label: name, href: `/purchase/bills/read?reading=${row.id}`, steps: BILL_STEPS },
      async (work) => {
        let outcome;
        try {
          outcome = await aiTurn({
            userId,
            feature: "bills.read",
            system: READ_BILL_SYSTEM,
            history: [{ role: "user", text: "Read this bill.", files: [{ name, mediaType: file.type as keyof typeof ACCEPTED_TYPES, data }] }],
            tools: [PROPOSE_BILL],
          });
        } catch (err) {
          if (err instanceof AiRefusal) throw new BillReadRefusal(err.message);
          throw err;
        }
        await work.step(1);
        const call = outcome.toolCalls.find((c) => c.name === PROPOSE_BILL.name);
        const parsed = call ? proposedBillSchema.safeParse(call.input) : null;
        if (!parsed?.success) throw new BillReadRefusal("Arjun couldn't make the bill out. Try a clearer photo, or the vendor's PDF.");
        const bill = settleBill(parsed.data);
        await work.step(2);
        await db.billReading.update({ where: { id: row.id }, data: { status: "READ", read: bill as unknown as object, error: null } });
        if (bill.vendorName) await work.about(`${bill.vendorName}${bill.billNumber ? ` · ${bill.billNumber}` : ""}`);
        return bill;
      },
      (bill) => (bill.notABill ? "That wasn't a bill" : `Read ${bill.lines.length} line${bill.lines.length === 1 ? "" : "s"} — ready to check`),
    );
  } catch (err) {
    const words = err instanceof BillReadRefusal ? err.message : "Arjun couldn't read it just now. Try again in a minute.";
    if (!(err instanceof BillReadRefusal)) console.error("[bill-reader] reading failed", err instanceof Error ? err.message : err);
    await db.billReading.update({ where: { id: row.id }, data: { error: words.slice(0, 500) } });
  }
  return row.id;
}

/** The vendor's file, for whoever uploaded it or may open the bill made from it — the caller checks the bill. */
export async function readingFile(id: string): Promise<{ bytes: Buffer; contentType: string; fileName: string; createdById: string; documentId: string | null } | null> {
  const row = await db.billReading.findUnique({ where: { id }, select: { fileDataUrl: true, contentType: true, fileName: true, createdById: true, documentId: true } }).catch((err) => {
    if (notMigratedYet(err)) return null;
    throw err;
  });
  if (!row) return null;
  const file = await storedFile(row.fileDataUrl, row.contentType);
  return file ? { bytes: file.bytes, contentType: row.contentType, fileName: row.fileName, createdById: row.createdById, documentId: row.documentId } : null;
}

/** The reading a bill was made from, for the bill's own page. */
export async function readingOfDocument(documentId: string): Promise<{ id: string; fileName: string } | null> {
  try {
    return await db.billReading.findUnique({ where: { documentId }, select: { id: true, fileName: true } });
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}
