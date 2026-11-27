import ExcelJS from "exceljs";
import JSZip from "jszip";

/**
 * Opening a spreadsheet somebody uploaded, with its inflated size checked first (security audit round two, 13 Nov
 * 2026 — R2-19).
 *
 * An .xlsx is a ZIP. Its sheets are XML, and XML compresses extremely well: a sheet of one character repeated is a few
 * kilobytes in the file and gigabytes unpacked. ExcelJS unpacks every part whole and then builds an object per cell,
 * in the one process that serves every workspace, so a 25 MB upload could take all of its memory. Here every part is
 * unpacked once as a stream, counting bytes and nothing kept, and the file is refused as soon as one part or the whole
 * passes its cap — before ExcelJS sees it. The sizes a ZIP's headers declare are whatever its maker wrote, so they are
 * not believed. Rows are counted on the way through too, so a sheet of a million tiny rows is refused unparsed.
 */

export const SHEET_LIMITS = {
  /** One part of the workbook (a sheet, the shared strings), unpacked. */
  entryBytes: 50 * 1024 * 1024,
  /** Every part together, unpacked. */
  totalBytes: 200 * 1024 * 1024,
  /** Parts in the workbook — a real one has tens. */
  entries: 2000,
  /** Rows in a file, under its headings. */
  rows: 100_000,
  /** Columns in a file. */
  columns: 500,
};

export type SheetLimits = Partial<typeof SHEET_LIMITS>;

/** A file refused for its size, with words for the person who sent it. Not an internal error (src/lib/plain-error.ts). */
export class FileTooLarge extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileTooLarge";
  }
}

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
const isSheet = (name: string) => /^xl\/worksheets\/[^/]+\.xml$/i.test(name);

/**
 * What an entry unpacks to, counted as it streams and never kept: its size and, for a sheet, its rows. Null as soon as
 * it passes `cap` — the stream is paused there, so nothing past the cap is ever inflated.
 */
export function inflatedWithin(entry: JSZip.JSZipObject, cap: number, countRows = false): Promise<{ bytes: number; rows: number } | null> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let rows = 0;
    let carry = "";
    let done = false;
    const stream = entry.nodeStream("nodebuffer");
    stream
      .on("data", (data: Buffer) => {
        if (done) return;
        bytes += data.length;
        if (bytes > cap) {
          done = true;
          stream.pause();
          resolve(null);
          return;
        }
        if (countRows) {
          // "<row " or "<row>" — the tag split across two chunks is caught by the few characters carried over.
          const text = carry + data.toString("latin1");
          rows += text.match(/<row[\s>]/g)?.length ?? 0;
          carry = text.slice(-4);
        }
      })
      .on("error", (err: Error) => {
        if (done) return;
        done = true;
        reject(err);
      })
      .on("end", () => {
        if (done) return;
        done = true;
        resolve({ bytes, rows });
      });
  });
}

/**
 * Refuses a workbook whose parts unpack past the caps, or whose sheets hold more rows than a file may, without unpacking
 * any part further than its cap. Throws FileTooLarge with the reason — a file that isn't a ZIP at all among them.
 */
export async function checkWorkbookSize(bytes: Buffer | Uint8Array, name = "That file", limits: SheetLimits = {}): Promise<void> {
  const caps = { ...SHEET_LIMITS, ...limits };
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new FileTooLarge(`${name} isn't an Excel file that can be opened. Save it again as .xlsx, or as .csv.`);
  }
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  if (entries.length > caps.entries) throw new FileTooLarge(`${name} has ${entries.length} parts inside — more than a spreadsheet ever needs.`);
  let total = 0;
  for (const entry of entries) {
    const sheet = isSheet(entry.name);
    const remaining = caps.totalBytes - total;
    const got = await inflatedWithin(entry, Math.min(caps.entryBytes, remaining), sheet);
    if (!got) {
      throw new FileTooLarge(
        remaining < caps.entryBytes
          ? `${name} unpacks to more than ${mb(caps.totalBytes)}. Split it into smaller files, or save it as .csv.`
          : `A sheet in ${name} unpacks to more than ${mb(caps.entryBytes)}. Split it into smaller files, or save it as .csv.`,
      );
    }
    total += got.bytes;
    // The heading row is one of them.
    if (sheet && got.rows > caps.rows + 1) throw new FileTooLarge(`${name} has more than ${caps.rows.toLocaleString("en-IN")} rows in a sheet. Split it and import in batches.`);
  }
}

/** A workbook, opened only once its size has been checked (`checkWorkbookSize`), its sheets' columns checked after. */
export async function loadWorkbook(bytes: Buffer | Uint8Array, name = "That file", limits: SheetLimits = {}): Promise<ExcelJS.Workbook> {
  const caps = { ...SHEET_LIMITS, ...limits };
  await checkWorkbookSize(bytes, name, caps);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(new Uint8Array(bytes) as unknown as ArrayBuffer);
  for (const ws of wb.worksheets) {
    if (ws.columnCount > caps.columns) throw new FileTooLarge(`${name} has ${ws.columnCount} columns in "${ws.name}" — at most ${caps.columns}.`);
    if (ws.rowCount > caps.rows + 1) throw new FileTooLarge(`${name} has more than ${caps.rows.toLocaleString("en-IN")} rows in a sheet. Split it and import in batches.`);
  }
  return wb;
}
