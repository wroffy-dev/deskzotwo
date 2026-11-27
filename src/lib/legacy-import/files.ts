import JSZip from "jszip";
import Papa from "papaparse";
import { readCapped } from "@/lib/marketing/template-upload";

/** Shared with the other uploads that unpack a ZIP (security audit round two, R2-19): Kredily's, the switch's. */
export { readCapped };

/**
 * What an upload holds (src/lib/legacy-import): CSV files, given one by one or in a ZIP. Read whole into rows of
 * heading → text — the old CRM's export is a few files of a few megabytes each — with every limit checked before the
 * bytes are inflated, so a crafted ZIP can't take the server's memory with it.
 */

export const UPLOAD_LIMITS = {
  /**
   * One upload: the ZIP or the CSVs together (owner, 26 Oct 2026: 250 MB). The browser sends a big one in parts
   * of `partBytes` — Cloudflare, in front of Deskzo, refuses a request over 100 MB on its usual plans — and the
   * server puts them back together (src/app/api/legacy-import/upload/route.ts).
   */
  requestBytes: 250 * 1024 * 1024,
  /** One part of an upload sent in parts. */
  partBytes: 40 * 1024 * 1024,
  /** One CSV, inflated. */
  fileBytes: 250 * 1024 * 1024,
  /** Everything in a ZIP, inflated — read a file at a time, each stored before the next is opened. */
  zipBytes: 1024 * 1024 * 1024,
  /** Files in a ZIP. */
  zipFiles: 300,
};

export class UploadRefused extends Error {}

export type ReadFile = { name: string; headers: string[]; rows: Record<string, string>[] };

/** A CSV's text as rows: the first line its headings (a byte-order mark dropped), quoted fields across lines kept. */
export function parseCsv(name: string, text: string): ReadFile {
  const parsed = Papa.parse<string[]>(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, { skipEmptyLines: "greedy" });
  const [head, ...data] = parsed.data;
  if (!head || head.length === 0) throw new UploadRefused(`${name} has no heading row.`);
  const headers = head.map((h) => h.trim());
  const seen = new Set<string>();
  for (const h of headers) {
    if (!h) continue;
    if (seen.has(h.toLowerCase())) throw new UploadRefused(`${name} has the heading "${h}" twice.`);
    seen.add(h.toLowerCase());
  }
  const rows = data.map((cells) => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""])));
  return { name, headers, rows };
}

/** Every CSV in what was uploaded: a ZIP's (folders flattened, the Mac's metadata left out), or the files themselves. */
export async function readUpload(uploads: { name: string; bytes: Buffer }[]): Promise<ReadFile[]> {
  const out: ReadFile[] = [];
  await eachUploadFile(uploads, async (file) => void out.push(file));
  return out;
}

/**
 * The same, a file at a time: each CSV read, handed to `onFile` (which stores it) and let go before the next is
 * opened — so a 250 MB ZIP never sits in memory as rows all at once. Every limit is checked before anything is read.
 */
export async function eachUploadFile(uploads: { name: string; bytes: Buffer }[], onFile: (file: ReadFile) => Promise<void>): Promise<number> {
  const total = uploads.reduce((t, u) => t + u.bytes.length, 0);
  if (total > UPLOAD_LIMITS.requestBytes) throw new UploadRefused(`That's ${Math.round(total / 1024 / 1024)} MB — upload at most ${UPLOAD_LIMITS.requestBytes / 1024 / 1024} MB at a time, in more than one go if need be.`);
  for (const upload of uploads) {
    const lower = upload.name.toLowerCase();
    if (!lower.endsWith(".csv") && !lower.endsWith(".zip")) throw new UploadRefused(`${upload.name} isn't a .csv or a .zip.`);
  }
  let count = 0;
  for (const upload of uploads) {
    if (upload.name.toLowerCase().endsWith(".csv")) {
      if (upload.bytes.length > UPLOAD_LIMITS.fileBytes) throw new UploadRefused(`${upload.name} is over ${UPLOAD_LIMITS.fileBytes / 1024 / 1024} MB — export it in parts.`);
      await onFile(parseCsv(upload.name, upload.bytes.toString("utf8")));
      count += 1;
    } else {
      count += await readZip(upload.name, upload.bytes, onFile);
    }
  }
  if (count === 0) throw new UploadRefused("There's no CSV file in that.");
  return count;
}

async function readZip(name: string, bytes: Buffer, onFile: (file: ReadFile) => Promise<void>): Promise<number> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new UploadRefused(`${name} isn't a ZIP file that can be opened.`);
  }
  const entries = Object.values(zip.files).filter((f) => !f.dir && !/(^|\/)__MACOSX\//.test(f.name) && !/(^|\/)\._/.test(f.name));
  const csvs = entries.filter((f) => f.name.toLowerCase().endsWith(".csv"));
  if (csvs.length > UPLOAD_LIMITS.zipFiles) throw new UploadRefused(`${name} has ${csvs.length} CSV files — at most ${UPLOAD_LIMITS.zipFiles} at a time.`);
  // A first look at the sizes the ZIP says; each entry is still inflated only as far as its cap.
  const declared = csvs.reduce((t, f) => t + ((f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0), 0);
  if (declared > UPLOAD_LIMITS.zipBytes) throw new UploadRefused(`${name} unpacks to more than ${UPLOAD_LIMITS.zipBytes / 1024 / 1024} MB — split it into smaller ZIPs.`);
  let inflated = 0;
  for (const entry of csvs) {
    const data = await readCapped(entry, UPLOAD_LIMITS.fileBytes);
    if (!data) throw new UploadRefused(`${entry.name} in ${name} is over ${UPLOAD_LIMITS.fileBytes / 1024 / 1024} MB unpacked — export it in parts.`);
    inflated += data.length;
    if (inflated > UPLOAD_LIMITS.zipBytes) throw new UploadRefused(`${name} unpacks to more than ${UPLOAD_LIMITS.zipBytes / 1024 / 1024} MB — split it into smaller ZIPs.`);
    await onFile(parseCsv(entry.name.split("/").pop() ?? entry.name, data.toString("utf8")));
  }
  return csvs.length;
}
