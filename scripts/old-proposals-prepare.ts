/**
 * The proposals made in Excel before Zoho (owner, 25 Nov 2026), made ready for Settings › Old CRM migration › Old
 * proposals (src/lib/old-proposals): walks the folder, reads the status sheet and every quotation, joins the two, and
 * writes one compressed file to upload. Reads only; nothing in the folder is changed and no database is opened.
 *
 *   npx tsx scripts/old-proposals-prepare.ts <folder> <status sheet.xlsx> <out.json.gz> [own mail domain, …]
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";
import JSZip from "jszip";
import { extractText, getDocumentProxy } from "unpdf";
import { attachPapers, joinProposals, pdfQuotation, quotationOf, rowsOf, sharedStrings, statusRows, wordRows, type Prepared, type Quotation, type SheetRow, type StatusRow } from "../src/lib/old-proposals/read";

async function workbook(path: string): Promise<{ sheets: { name: string; rows: SheetRow[] }[]; saved: string | null }> {
  const zip = await JSZip.loadAsync(readFileSync(path));
  const text = async (name: string) => (await zip.file(name)?.async("string")) ?? "";
  const strings = sharedStrings(await text("xl/sharedStrings.xml"));
  const targets = new Map([...(await text("xl/_rels/workbook.xml.rels")).matchAll(/<Relationship\b[^>]*>/g)].map((m) => [/\bId="([^"]+)"/.exec(m[0])?.[1] ?? "", /\bTarget="([^"]+)"/.exec(m[0])?.[1] ?? ""]));
  const sheets = [];
  for (const m of (await text("xl/workbook.xml")).matchAll(/<sheet\b[^>]*>/g)) {
    const target = targets.get(/\br:id="([^"]+)"/.exec(m[0])?.[1] ?? "") ?? "";
    const xml = await text(target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    if (xml) sheets.push({ name: /\bname="([^"]*)"/.exec(m[0])?.[1] ?? "", rows: rowsOf(xml, strings) });
  }
  return { sheets, saved: /<dcterms:modified[^>]*>([^<]+)</.exec(await text("docProps/core.xml"))?.[1]?.slice(0, 19) ?? null };
}

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []));

async function main() {
  const [folder, sheet, out, ...domains] = process.argv.slice(2);
  if (!folder || !sheet || !out) throw new Error("Give the folder, the status sheet and the file to write.");
  const own = new RegExp(`@(${(domains.length ? domains : ["wroffy"]).map((d) => d.replace(/[^\w.-]/g, "").replace(/\./g, "\\.")).join("|")})`, "i");
  const status: StatusRow[] = (await workbook(sheet)).sheets.flatMap((s) => statusRows(s.name, s.rows, own));
  console.log(`Status sheet: ${status.length} rows`);

  const quotations: Quotation[] = [];
  const unread: Prepared["unread"] = [];
  let otherFiles = 0;
  const papers: string[] = [];
  const read: Record<string, number> = {};
  const took = (kind: string, q: Quotation) => {
    quotations.push(q);
    read[kind] = (read[kind] ?? 0) + 1;
  };
  for (const path of walk(folder)) {
    const file = relative(folder, path).split(sep).join("/");
    const name = file.split("/").pop()!;
    if (path === sheet || /^([~_]\$|thumbs\.db|desktop\.ini)/i.test(name) || /\.(lnk|log|txt|pub|xlam|tmp)$/i.test(name)) continue;
    const parts = file.split("/");
    const at = { file, folder: parts.length > 2 ? parts[1]! : "" };
    // A proposal in Word, or its PDF; anything else is a paper, kept beside its company's.
    if (!/\.xlsx$/i.test(name)) {
      let q: Quotation | null = null;
      try {
        if (/\.docx$/i.test(name)) {
          const zip = await JSZip.loadAsync(readFileSync(path));
          const saved = /<dcterms:modified[^>]*>([^<]+)</.exec((await zip.file("docProps/core.xml")?.async("string")) ?? "")?.[1]?.slice(0, 19) ?? null;
          q = quotationOf(wordRows((await zip.file("word/document.xml")?.async("string")) ?? ""), { ...at, saved, word: true }, own);
        } else if (/\.pdf$/i.test(name)) {
          const { text } = await extractText(await getDocumentProxy(new Uint8Array(readFileSync(path))), { mergePages: true });
          q = pdfQuotation(text, at, own);
        }
      } catch {
        // Unreadable: a paper like any other.
      }
      // A form or an agreement can name a customer too: a proposal says when, or which, or what.
      if (q && (q.date || q.ref || q.lines.length)) took(/\.pdf$/i.test(name) ? "pdf" : "word", q);
      else {
        otherFiles += 1;
        papers.push(file);
      }
      continue;
    }
    try {
      const book = await workbook(path);
      const found = book.sheets.map((s) => quotationOf(s.rows, { file, folder: parts.length > 2 ? parts[parts.length - 2]! : "", saved: book.saved }, own)).filter((q): q is Quotation => !!q);
      // More than one quotation in a workbook: the fullest. (Three files in all.)
      const best = found.sort((a, b) => b.lines.length - a.lines.length)[0];
      if (best) took("excel", best);
      else papers.push(file);
    } catch {
      unread.push({ file, why: "Damaged, or not really an Excel file" });
    }
    if (quotations.length % 1000 === 0) console.log(`  ${quotations.length} quotations read…`);
  }
  const attached = attachPapers(joinProposals(status, quotations), papers);
  const proposals = attached.proposals;
  for (const file of attached.loose) unread.push({ file, why: "Not in a customer's folder" });
  const prepared: Prepared = { version: 1, made: new Date().toISOString(), proposals, unread, otherFiles };
  const bytes = gzipSync(Buffer.from(JSON.stringify(prepared)), { level: 9 });
  writeFileSync(out, bytes);
  const count = (f: (p: (typeof proposals)[number]) => boolean) => proposals.filter(f).length;
  console.log(
    JSON.stringify(
      {
        quotations: quotations.length,
        read,
        attached: proposals.reduce((t, p) => t + p.attachments.length, 0),
        papersOnly: count((p) => p.product === "Papers only"),
        probablyWon: count((p) => p.issues.some((i) => /probably won/.test(i))),
        proposals: proposals.length,
        byReference: count((p) => p.joined === "REFERENCE"),
        byDate: count((p) => p.joined === "DATE"),
        sheetOnly: count((p) => p.joined === "SHEET_ONLY"),
        fileOnly: count((p) => p.joined === "FILE_ONLY"),
        status: Object.fromEntries(["WON", "LOST", "PENDING", "OTHER", "UNKNOWN"].map((s) => [s, count((p) => p.status === s)])),
        withTotal: count((p) => p.total !== null),
        withLines: count((p) => p.lines.length > 0),
        versions: proposals.reduce((t, p) => t + Math.max(0, p.files.length - 1), 0),
        mixed: count((p) => p.issues.some((i) => i.startsWith("Files under one"))),
        unread: unread.length,
        KB: Math.round(bytes.length / 1024),
      },
      null,
      1,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
