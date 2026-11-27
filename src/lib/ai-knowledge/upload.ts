import JSZip from "jszip";
import { normalisePath, readCapped } from "@/lib/marketing/template-upload";
import { AI_KNOWLEDGE_LIMITS, normaliseText } from "@/lib/ai-knowledge/chunk";

/**
 * Reading what Settings › AI Knowledge is given: several .md or .txt files at once, or a .zip of them (folders and
 * all). No database in here — this turns the upload into named texts, and says what it left out and why; the store
 * (./store.ts) saves them. Every limit is far past what a company's guides need and short of what a hostile upload
 * tries: a .zip that says it unpacks past 40 MB is refused before a byte is inflated, and each file is read only as
 * far as its own limit, whatever the archive's headers claim (src/lib/marketing/template-upload.ts `readCapped`).
 */

export const UPLOAD_LIMITS = {
  /** One request: every file in it together. */
  requestBytes: 25 * 1024 * 1024,
  /** One .md or .txt file. */
  fileBytes: 1024 * 1024,
  /** What a .zip may unpack to, all of it. */
  inflatedBytes: 40 * 1024 * 1024,
  /** Files in one upload, a .zip's included. */
  files: 300,
} as const;

export type UploadedText = { name: string; content: string };
export type UploadRead = { files: UploadedText[]; skipped: { name: string; reason: string }[] };

const TEXT_NAME = /\.(md|markdown|txt)$/i;

/** A file's bytes as text: UTF-8 (a byte-order mark let go), or UTF-16 as Windows' Notepad saves it. Null for anything that isn't text. */
export function decodeText(bytes: Buffer): string | null {
  let text: string;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) text = bytes.subarray(2).toString("utf16le");
  else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // Big-endian, as some Macs save it: turned round pair by pair (an odd last byte is half a character, dropped).
    const swapped = Buffer.from(bytes.subarray(2, 2 + ((bytes.length - 2) & ~1)));
    swapped.swap16();
    text = swapped.toString("utf16le");
  } else text = bytes.toString("utf8");
  // A NUL, or more than a sprinkling of bytes that aren't UTF-8, is a program or a picture renamed .md.
  if (text.includes("\u0000")) return null;
  const broken = (text.match(/�/g) ?? []).length;
  if (broken > 8 && broken > text.length / 100) return null;
  return text;
}

/** A file's name as kept: its path's "/" separators, no "..", trimmed to the limit; null when nothing's left of it. */
export function knowledgeName(raw: string): string | null {
  const path = normalisePath(String(raw ?? "").trim());
  if (!path) return null;
  const clean = path
    .split("/")
    .map((part) => part.replace(/[\u0000-\u001f<>:"|?*\\]/g, "").trim())
    .filter(Boolean)
    .join("/");
  if (!clean || clean.length > AI_KNOWLEDGE_LIMITS.nameChars) return null;
  return clean;
}

/** One text file's content, checked: the text, or why it can't be kept. */
function readOne(bytes: Buffer): { content: string } | { reason: string } {
  if (bytes.length > UPLOAD_LIMITS.fileBytes) return { reason: "over 1 MB — split it into smaller files" };
  const decoded = decodeText(bytes);
  if (decoded === null) return { reason: "it isn't text — save it as UTF-8 .md or .txt" };
  const content = normaliseText(decoded);
  if (!content) return { reason: "it's empty" };
  if (content.length > AI_KNOWLEDGE_LIMITS.fileChars) return { reason: `over ${AI_KNOWLEDGE_LIMITS.fileChars.toLocaleString("en-IN")} characters — split it into smaller files` };
  return { content };
}

/** The folder every entry of a .zip is inside, when there's one — a zipped folder's own name, left off the files'. */
function sharedFolder(paths: string[]): string {
  const first = paths[0]?.split("/") ?? [];
  if (first.length < 2) return "";
  const top = first[0]!;
  return paths.every((p) => p.startsWith(`${top}/`)) ? `${top}/` : "";
}

async function readZip(fileName: string, bytes: Buffer, out: UploadRead, room: () => number): Promise<void> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    out.skipped.push({ name: fileName, reason: "the .zip couldn't be opened" });
    return;
  }
  // The Mac's resource forks and hidden files are nobody's knowledge.
  const entries = Object.values(zip.files).filter((f) => !f.dir && !/(^|\/)(__MACOSX|\.)/.test(f.name));
  const declared = entries.reduce((t, f) => t + ((f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0), 0);
  if (declared > UPLOAD_LIMITS.inflatedBytes) {
    out.skipped.push({ name: fileName, reason: "the .zip unpacks to more than 40 MB" });
    return;
  }
  const paths = entries.map((e) => normalisePath(e.name) ?? "");
  const folder = sharedFolder(paths.filter(Boolean));
  let inflated = 0;
  for (const [i, entry] of entries.entries()) {
    const path = paths[i]!;
    // Named in what's left out as it would have been kept: without the zipped folder's own name.
    const shown = path ? path.slice(folder.length) || path : entry.name;
    if (!path) {
      out.skipped.push({ name: shown, reason: "its path climbs out of the .zip" });
      continue;
    }
    if (!TEXT_NAME.test(path)) {
      out.skipped.push({ name: shown, reason: "not a .md or .txt file" });
      continue;
    }
    if (room() <= 0) {
      out.skipped.push({ name: shown, reason: `more than ${UPLOAD_LIMITS.files} files in one upload` });
      continue;
    }
    const name = knowledgeName(path.slice(folder.length));
    if (!name) {
      out.skipped.push({ name: shown, reason: `its name is over ${AI_KNOWLEDGE_LIMITS.nameChars} characters` });
      continue;
    }
    const data = await readCapped(entry, UPLOAD_LIMITS.fileBytes);
    if (!data) {
      out.skipped.push({ name, reason: "over 1 MB — split it into smaller files" });
      continue;
    }
    inflated += data.length;
    if (inflated > UPLOAD_LIMITS.inflatedBytes) {
      out.skipped.push({ name: fileName, reason: "the .zip unpacks to more than 40 MB — the rest of it was left out" });
      return;
    }
    const read = readOne(data);
    if ("reason" in read) out.skipped.push({ name, reason: read.reason });
    else out.files.push({ name, content: read.content });
  }
}

/**
 * An upload's texts: each .md or .txt file as it is, and each one inside a .zip under its path there (without the
 * zipped folder's own name). Two with one name: the later is left out. Never throws for one bad file.
 */
export async function readKnowledgeUpload(uploads: { name: string; bytes: Buffer }[]): Promise<UploadRead> {
  const out: UploadRead = { files: [], skipped: [] };
  const room = () => UPLOAD_LIMITS.files - out.files.length;
  for (const upload of uploads) {
    const fileName = String(upload.name ?? "").split(/[\\/]/).pop() ?? "";
    if (/\.zip$/i.test(fileName)) {
      await readZip(fileName, upload.bytes, out, room);
      continue;
    }
    if (!TEXT_NAME.test(fileName)) {
      out.skipped.push({ name: fileName || "(no name)", reason: "not a .md, .txt or .zip file" });
      continue;
    }
    if (room() <= 0) {
      out.skipped.push({ name: fileName, reason: `more than ${UPLOAD_LIMITS.files} files in one upload` });
      continue;
    }
    const name = knowledgeName(fileName);
    if (!name) {
      out.skipped.push({ name: fileName, reason: `its name is over ${AI_KNOWLEDGE_LIMITS.nameChars} characters` });
      continue;
    }
    const read = readOne(upload.bytes);
    if ("reason" in read) out.skipped.push({ name, reason: read.reason });
    else out.files.push({ name, content: read.content });
  }
  // One file to a name: a second "faq.md" in the same upload would only overwrite the first.
  const seen = new Set<string>();
  const unique: UploadedText[] = [];
  for (const file of out.files) {
    const key = file.name.toLowerCase();
    if (seen.has(key)) out.skipped.push({ name: file.name, reason: "another file in this upload has the same name" });
    else {
      seen.add(key);
      unique.push(file);
    }
  }
  out.files = unique;
  return out;
}
