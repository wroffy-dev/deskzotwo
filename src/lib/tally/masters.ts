/**
 * Tally's own masters, as the accountant exports them (Display › List of Accounts › Export, XML) and uploads on the Tally
 * settings page (src/lib/tally) — so Deskzo knows every ledger and stock item Tally already has, and matches names to
 * them instead of creating "Acme Ltd" again beside Tally's "ACME LTD.". Pure: the file's bytes in, the masters out.
 *
 * Tally writes these files in UTF-16 (with its byte-order mark) by default, or UTF-8 when asked.
 */

export type ParsedMaster = { kind: "LEDGER" | "STOCKITEM"; name: string; parent: string | null; gstin: string | null };

/** The file's text, whichever encoding Tally wrote it in. */
export function decodeTallyFile(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  // UTF-16 without a mark: every other byte of plain ASCII is zero.
  if (bytes.length >= 4 && bytes[1] === 0 && bytes[3] === 0) return new TextDecoder("utf-16le").decode(bytes);
  const text = new TextDecoder("utf-8").decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const unescape = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .trim();

const first = (block: string, tagName: string): string | null => {
  const m = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, "i").exec(block);
  const v = m ? unescape(m[1]!) : "";
  return v || null;
};

const GSTIN = /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z][Z][0-9A-Z]$/;

/** Every ledger and stock item in a Tally masters export, once each by kind and name. */
export function parseTallyMasters(text: string): ParsedMaster[] {
  const out = new Map<string, ParsedMaster>();
  for (const kind of ["LEDGER", "STOCKITEM"] as const) {
    const re = new RegExp(`<${kind}\\s+NAME="([^"]*)"[^>]*>([\\s\\S]*?)</${kind}>`, "gi");
    for (const m of text.matchAll(re)) {
      const name = unescape(m[1]!);
      if (!name) continue;
      const body = m[2]!;
      const gstin = (first(body, "PARTYGSTIN") ?? first(body, "GSTIN") ?? "").toUpperCase();
      out.set(`${kind}:${name.toLowerCase()}`, { kind, name, parent: first(body, "PARENT"), gstin: GSTIN.test(gstin) ? gstin : null });
    }
  }
  return [...out.values()];
}
