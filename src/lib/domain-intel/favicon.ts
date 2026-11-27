import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { safeFetch } from "@/lib/net/safe-fetch";

/**
 * A company's own icon, for the tile beside its name (owner, 15 Nov 2026: "when we do domain lookup get favicon icon
 * for this icon on left side of company name"). Read during the domain lookup, from where the homepage says its icon
 * is — else /favicon.ico — through the same guard as the homepage (src/lib/net/safe-fetch.ts), and kept on the profile
 * as a small data URL: the page shows it from our own data, so nobody's browser calls the company's site just to open
 * the record. Only a real image, at most 32 KB; anything else is no icon, and the tile keeps its initials.
 */

const MAX_BYTES = 32_000;
const TIMEOUT_MS = 5_000;
type ImageType = "image/png" | "image/x-icon" | "image/svg+xml" | "image/jpeg" | "image/gif" | "image/webp";

/** Where the homepage says its icons are — the biggest (apple-touch) first — then /favicon.ico. */
export function iconUrlsFrom(html: string, pageUrl: string): string[] {
  const out: { href: string; rank: number }[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)["']?/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    if (!/\bicon\b/.test(rel)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? /\bhref\s*=\s*([^\s>]+)/i.exec(tag)?.[1];
    if (!href || href.startsWith("data:")) continue;
    out.push({ href, rank: rel.includes("apple-touch") ? 0 : /\bsizes\s*=\s*["']?(\d{2,3})/i.test(tag) ? 1 : 2 });
  }
  const urls: string[] = [];
  for (const { href } of out.sort((a, b) => a.rank - b.rank)) {
    try {
      const u = new URL(href, pageUrl);
      if ((u.protocol === "https:" || u.protocol === "http:") && !urls.includes(u.toString())) urls.push(u.toString());
    } catch {
      // Not an address; the next one may be.
    }
  }
  try {
    const fallback = new URL("/favicon.ico", pageUrl).toString();
    if (!urls.includes(fallback)) urls.push(fallback);
  } catch {
    // A page URL that isn't one has no icon either.
  }
  return urls.slice(0, 4);
}

/** What the bytes are, by their first few — the header a server sends is often wrong for icons. */
export function imageTypeOf(bytes: Buffer, declared: string | null): ImageType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return "image/x-icon";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString("ascii").startsWith("GIF8")) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  const head = bytes.subarray(0, 300).toString("utf8").trimStart().toLowerCase();
  if ((declared ?? "").includes("svg") || head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    // An SVG can carry script; one that does is no icon of ours.
    const text = bytes.toString("utf8").toLowerCase();
    return /<script|on\w+\s*=|javascript:|<foreignobject/.test(text) ? null : "image/svg+xml";
  }
  return null;
}

/** The first of these that is a real, small image, as a data URL — or null. */
export async function fetchFavicon(urls: string[], fetcher: typeof safeFetch = safeFetch): Promise<string | null> {
  for (const url of urls) {
    try {
      const response = await fetcher(url, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES + 1, maxRedirects: 3, headers: { accept: "image/*" } });
      if (response.status < 200 || response.status >= 300 || response.truncated || response.bytes.length < 16) continue;
      const type = imageTypeOf(response.bytes, response.headers.get("content-type"));
      if (!type) continue;
      return `data:${type};base64,${response.bytes.toString("base64")}`;
    } catch {
      // Unreachable or refused: try the next.
    }
  }
  return null;
}

/** A company's icon from its last lookup — null before one, or in a workspace not migrated yet. */
export async function faviconOf(companyId: string): Promise<string | null> {
  try {
    const row = await db.domainProfile.findUnique({ where: { companyId }, select: { favicon: true } });
    return row?.favicon ?? null;
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}
