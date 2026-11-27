import JSZip from "jszip";
import { readCapped } from "@/lib/legacy-import/files";
import { parseFile } from "@/lib/portability/import";
import { FileTooLarge } from "@/lib/portability/workbook";
import { isZohoChart, uploadChart, type ChartUpload } from "./accounts";
import { archiveChallans, archiveDocuments, dayOf, isZohoChallans, splitForArchive, storeArchive, unreadableDates, type ArchiveKind } from "./archive";
import { MigrationRefused, type MigrationRow } from "./state";
import { STEPS, storeFile, type StepKey } from "./steps";
import { creditApplications, isZohoCreditApplications, isZohoFile, isZohoMovement, movementsAsJournals, type CreditApplications } from "./zoho";

/**
 * The switch's files through /api/migration/upload: one step's CSV or XLSX, or a whole Zoho Books backup as a ZIP
 * — a year's invoices are more than a server action takes. A backup's files are sorted by what they are: each
 * step's by the id column only Zoho's has (./zoho.ts), the parts Zoho splits a big one into ("Invoice00.csv",
 * "Invoice01.csv") put back together, the chart of accounts to the old chart's map (./accounts.ts). Zoho's transfers,
 * deposits and refunds join the manual journals, and its credit-note applications say what each note was set
 * against (./zoho.ts). The rest —
 * contacts, items, quotes — belong to the old-CRM import's master lists, and are named as left out.
 */

export const UPLOAD_LIMITS = { requestBytes: 60 * 1024 * 1024, fileBytes: 80 * 1024 * 1024, zipBytes: 300 * 1024 * 1024, zipFiles: 300 } as const;

export type MigrationFileRows = { name: string; rows: Record<string, string>[] };

/**
 * Rows a file of the switch may hold: Zoho's file holds every year, so a big workspace's Invoice.csv passes the usual
 * 100,000 (src/lib/portability/workbook.ts). An .xlsx is still opened only once its parts are known to unpack within
 * the usual caps.
 */
const MAX_ROWS = 1_000_000;

async function rowsOf(name: string, bytes: Buffer): Promise<Record<string, string>[]> {
  // parseFile keeps both of a heading Zoho writes twice ("Issued Date", "Payment Type") as two columns.
  try {
    return await parseFile(bytes.toString("base64"), name, { rows: MAX_ROWS });
  } catch (err) {
    if (err instanceof FileTooLarge) throw new MigrationRefused(`${name}: ${err.message}`);
    throw err;
  }
}

/** The uploads as files of rows, a ZIP opened with every limit checked before anything is unpacked. */
export async function readMigrationUpload(uploads: { name: string; bytes: Buffer }[]): Promise<MigrationFileRows[]> {
  const out: MigrationFileRows[] = [];
  for (const upload of uploads) {
    const lower = upload.name.toLowerCase();
    if (/\.(csv|xlsx)$/.test(lower)) {
      if (upload.bytes.length > UPLOAD_LIMITS.fileBytes) throw new MigrationRefused(`${upload.name} is over ${UPLOAD_LIMITS.fileBytes / 1024 / 1024} MB — export it by months.`);
      out.push({ name: upload.name, rows: await rowsOf(upload.name, upload.bytes) });
      continue;
    }
    if (!lower.endsWith(".zip")) throw new MigrationRefused(`${upload.name} isn't a .csv, .xlsx or .zip.`);
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(upload.bytes);
    } catch {
      throw new MigrationRefused(`${upload.name} isn't a ZIP file that can be opened.`);
    }
    const entries = Object.values(zip.files).filter((f) => !f.dir && !/(^|\/)__MACOSX\//.test(f.name) && !/(^|\/)\._/.test(f.name) && f.name.toLowerCase().endsWith(".csv"));
    if (entries.length > UPLOAD_LIMITS.zipFiles) throw new MigrationRefused(`${upload.name} has ${entries.length} CSV files — at most ${UPLOAD_LIMITS.zipFiles} at a time.`);
    // A first look at the sizes the ZIP says — whatever its maker wrote, so not believed: each entry below is unpacked
    // only as far as its cap, and all of them together only as far as the ZIP's (security audit round two, 13 Nov
    // 2026 — R2-19: `entry.async` used to unpack each whole before its size was looked at).
    const declared = entries.reduce((t, e) => t + ((e as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0), 0);
    if (declared > UPLOAD_LIMITS.zipBytes) throw new MigrationRefused(`${upload.name} unpacks to more than ${UPLOAD_LIMITS.zipBytes / 1024 / 1024} MB — upload it in parts.`);
    let inflated = 0;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const bytes = await readCapped(entry, UPLOAD_LIMITS.fileBytes);
      if (!bytes) throw new MigrationRefused(`${entry.name} is over ${UPLOAD_LIMITS.fileBytes / 1024 / 1024} MB unpacked — export it by months.`);
      inflated += bytes.length;
      if (inflated > UPLOAD_LIMITS.zipBytes) throw new MigrationRefused(`${upload.name} unpacks to more than ${UPLOAD_LIMITS.zipBytes / 1024 / 1024} MB — upload it in parts.`);
      out.push({ name: entry.name, rows: await rowsOf(entry.name, bytes) });
    }
  }
  if (out.length === 0) throw new MigrationRefused("There's no CSV file in that upload.");
  return out;
}

/** The day an expense or a journal row is dated by, in Zoho's own file and as transfers are written. */
const EARLIER_DATE: Partial<Record<StepKey, string>> = { expenses: "Expense Date", journals: "Journal Date" };

export type UploadOutcome = {
  stored: { step: StepKey; fileId: string; filename: string; files: string[]; units: number; zoho: boolean; unknown: string[] }[];
  /** A step the workspace can't take (its plan leaves the module out), and why. */
  refused: { step: StepKey; files: string[]; error: string }[];
  /** Earlier years' documents, and finished quotes, orders and POs, kept to be read (./archive.ts). */
  archived: { kind: ArchiveKind; count: number }[];
  /** Earlier years' expenses and journals: in the opening balances already, so not brought. */
  earlier: { step: StepKey; rows: number }[];
  /** Rows whose date couldn't be read, with one as it was written. */
  unreadable: { step: StepKey; rows: number; example: string }[];
  chart: ChartUpload | null;
  left: string[];
};

/**
 * Keeps what the upload brings: one step's file when the page names the step, else every file sorted by what it
 * is. A step's parts are one file; a step given again replaces what was kept for it.
 */
export async function storeUpload(m: MigrationRow, files: MigrationFileRows[], step: StepKey | null, userId: string, merge = false): Promise<UploadOutcome> {
  const byStep = new Map<StepKey, MigrationFileRows[]>();
  let chart: MigrationFileRows | null = null;
  let applications: CreditApplications = new Map();
  // Zoho's delivery challans: all to the archive, none to a step (./archive.ts).
  const challans: Record<string, string>[] = [];
  const left: string[] = [];
  for (const file of files) {
    if (file.rows.length === 0) {
      left.push(`${file.name} (empty)`);
      continue;
    }
    if (!step && isZohoMovement(file.rows)) {
      byStep.set("journals", [...(byStep.get("journals") ?? []), { name: file.name, rows: movementsAsJournals(file.name, file.rows) }]);
      continue;
    }
    if (!step && isZohoCreditApplications(file.rows)) {
      applications = creditApplications(file.rows);
      continue;
    }
    if (!step && isZohoChallans(file.rows)) {
      challans.push(...file.rows);
      continue;
    }
    const found = step ?? STEPS.map((s) => s.key).find((k) => isZohoFile(k, file.rows)) ?? null;
    if (found) byStep.set(found, [...(byStep.get(found) ?? []), file]);
    else if (isZohoChart(file.rows)) chart = file;
    else left.push(file.name);
  }
  if (byStep.size === 0 && !chart && challans.length === 0) {
    throw new MigrationRefused(step ? "That file has no rows." : "None of those files is one the switch brings — Zoho's Invoice, Credit_Note, Creditnotes_Invoice, Customer_Payment, Bill, Vendor_Credits, Vendor_Payment, Expense, Journal, Transfer_Fund, Deposit, Refund, Quote, Sales_Order, Purchase_Order or Chart_of_Accounts. For another system's, choose the step first.");
  }
  const stored: UploadOutcome["stored"] = [];
  const refused: UploadOutcome["refused"] = [];
  const archived: UploadOutcome["archived"] = [];
  const earlier: UploadOutcome["earlier"] = [];
  const unreadable: UploadOutcome["unreadable"] = [];
  if (challans.length) {
    const { documents } = archiveChallans(challans);
    if (documents.length) archived.push({ kind: "DELIVERY_CHALLAN", count: await storeArchive(m, "DELIVERY_CHALLAN", documents, merge) });
  }
  for (const s of STEPS) {
    const parts = byStep.get(s.key);
    if (!parts) continue;
    const name = parts.length === 1 ? parts[0]!.name : `${parts[0]!.name} and ${parts.length - 1} more`;
    try {
      const filename = name.split("/").pop()!.slice(0, 200);
      let rows = parts.flatMap((p) => p.rows);
      // Zoho's file holds every year: what is before the year being brought across is kept to be read
      // (./archive.ts), or — an expense's, a journal's — is already in the opening balances.
      if (isZohoFile(s.key, rows)) {
        // A date it can't read decides nothing: named, with an example, so the format can be seen.
        const bad = unreadableDates(s.key, rows);
        if (bad) unreadable.push({ step: s.key, ...bad });
        const split = splitForArchive(s.key, rows, m.yearStart);
        if (split.archive.length) {
          const { documents } = archiveDocuments(s.key, split.archive);
          const kind = documents[0]?.kind as ArchiveKind | undefined;
          if (kind) archived.push({ kind, count: await storeArchive(m, kind, documents, merge) });
        }
        rows = split.step;
        const dated = EARLIER_DATE[s.key];
        if (dated) {
          const before = rows.filter((r) => (dayOf(r[dated]) ?? "9999") < m.yearStart);
          if (before.length) {
            earlier.push({ step: s.key, rows: before.length });
            const gone = new Set(before);
            rows = rows.filter((r) => !gone.has(r));
          }
        }
        if (rows.filter((r) => Object.values(r).some((v) => v && v.trim())).length === 0) continue;
      }
      const kept = await storeFile(m, s.key, filename, rows, userId, applications, merge);
      stored.push({ step: s.key, fileId: kept.fileId, filename, files: parts.map((p) => p.name), units: kept.units, zoho: kept.zoho, unknown: kept.unknown });
    } catch (err) {
      if (!(err instanceof MigrationRefused) || step) throw err;
      refused.push({ step: s.key, files: parts.map((p) => p.name), error: err.message });
    }
  }
  return { stored, refused, archived, earlier, unreadable, chart: chart ? await uploadChart(m, (chart as MigrationFileRows).rows) : null, left };
}
