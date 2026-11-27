import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { isStorageFull } from "@/lib/file-refusal";
import { assertRoomFor } from "@/lib/storage/allowance";
import { bytesOf } from "@/lib/storage/files";
import { currentTenant } from "@/lib/tenancy/resolve";
import { OPENED_CALL, openedCalls, zohoConnected, zohoPdfPath } from "./archive-pdf";
import { zohoAllowance, ZohoBusy, zohoGet, ZohoRefused } from "./client";
import { callDay, keepArchivedPdf } from "./pull";

/**
 * An archived document's PDF fetched from Zoho when somebody opens it (25 Nov 2026): an earlier year's quote comes from
 * Zoho's list and its PDF isn't fetched by a pull — there are tens of thousands — so the one being looked at is asked for
 * then, kept as the pull keeps one, and not asked for again.
 *
 *   · **Whoever asks has been checked already:** the route's access checks come before this, and so before any call.
 *   · **Within the day's allowance**, whoever spent it: what the pulls used today and what was opened this way together.
 *     Each call here is counted as it is made, whether Zoho gives the PDF or not, and a pull leaves room for them.
 *   · **Refused, nothing is kept:** Zoho's "no" may be a passing one (access withdrawn, another organisation chosen), and
 *     an empty row would take the link away for good.
 */

export type OpenedPdf = { ok: true; pdf: Buffer } | { ok: false; status: number; why: string };

const no = (status: number, why: string): OpenedPdf => ({ ok: false, status, why });
const GONE = no(404, "Not found");
// 413 and 424, not a 5xx: the proxy in front of Deskzo shows a page of its own for some of those.
const FULL = no(413, "Your workspace's storage is full, so this PDF can't be fetched from Zoho and kept. An administrator can add storage in Settings › Billing.");
const USED = no(429, "Today's Zoho calls are used, so this PDF can't be fetched now. Open it again after midnight.");

/** The calls already made today, by every pull and by opening PDFs. */
async function callsToday(day: string): Promise<number> {
  const [pulls] = await db.$queryRaw<{ n: number }[]>`select coalesce(sum(("progress"->'calls'->>${day}::text)::int), 0)::int as n from "zoho_pulls"`;
  return (pulls?.n ?? 0) + (await openedCalls(day));
}

/** A call about to be made, counted against the day. The days before are done with. */
async function countCall(migrationId: string, day: string): Promise<void> {
  const id = randomUUID();
  await db.migrationRecord.create({ data: { migrationId, kind: OPENED_CALL, recordId: id, key: `${day}:${id}` } });
  await db.migrationRecord.deleteMany({ where: { kind: OPENED_CALL, NOT: { key: { startsWith: `${day}:` } } } });
}

/** Being fetched now, so two people opening the same document at once make one call between them. */
const fetching = new Map<string, Promise<OpenedPdf>>();

/** The document's PDF from Zoho, kept. Only for someone the caller has checked may see the document. */
export async function openArchivedPdf(documentId: string): Promise<OpenedPdf> {
  // By workspace too: a workspace restored from another's backup has the same ids.
  const key = `${(await currentTenant()).id}:${documentId}`;
  const going = fetching.get(key);
  if (going) return going;
  const work = fetchPdf(documentId).finally(() => fetching.delete(key));
  fetching.set(key, work);
  return work;
}

async function fetchPdf(documentId: string): Promise<OpenedPdf> {
  const doc = await db.archivedDocument.findUnique({ where: { id: documentId }, select: { migrationId: true, kind: true, oldId: true, file: { select: { data: true, size: true } } } });
  const path = doc ? zohoPdfPath(doc) : null;
  if (!doc || !path) return GONE;
  // Kept since the caller looked: by somebody else opening it, or by a pull.
  if (doc.file) return doc.file.size > 0 ? { ok: true, pdf: await bytesOf(doc.file.data) } : GONE;
  if (!(await zohoConnected())) return no(409, "Deskzo isn't connected to Zoho any more, so this PDF can't be fetched. An administrator can connect it again on the Switch to Deskzo page.");
  try {
    await assertRoomFor(1);
  } catch (err) {
    if (!isStorageFull(err)) throw err;
    return FULL;
  }
  const day = await callDay();
  if ((await callsToday(day)) >= (await zohoAllowance()).allowance) return USED;
  await countCall(doc.migrationId, day);

  let pdf: Buffer;
  try {
    pdf = (await zohoGet(path, {}, "pdf")) as Buffer;
  } catch (err) {
    if (err instanceof ZohoBusy) return err.daily ? USED : no(429, "Zoho asked Deskzo to slow down. Open this PDF again in a minute.");
    if (err instanceof ZohoRefused) return no(424, `Zoho refused this PDF. ${err.message}`);
    // `fetch` says so this way when it can't reach the other side.
    if (err instanceof TypeError) return no(424, "Deskzo couldn't reach Zoho for this PDF. Open it again in a few minutes.");
    throw err;
  }
  if (pdf.subarray(0, 1024).indexOf("%PDF-") < 0) return no(424, "Zoho refused this PDF: what it sent isn't one.");
  try {
    if (!(await keepArchivedPdf(documentId, pdf))) return FULL;
  } catch (err) {
    // The document was taken out while Zoho was answering (an upload replaced the archive).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") return GONE;
    throw err;
  }
  return { ok: true, pdf };
}
