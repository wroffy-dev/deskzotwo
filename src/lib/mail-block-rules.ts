import { parseEmailAddress } from "@/lib/email-verification";

/**
 * The rules of a block by hand (owner, 31 Oct 2026 — src/lib/mail-blocks.ts), with nothing that reaches a server: the
 * settings form reads them too.
 *
 *   · A domain covers its subdomains: blocking acme.com stops mail.acme.com and sales.in.acme.com.
 *   · What is typed is read the way people type it: "@Acme.com", "https://www.acme.com/contact", " ravi@acme.com ".
 */

/** A domain and every domain above it, down to two labels: a.b.acme.co.in → a.b.acme.co.in, b.acme.co.in, acme.co.in, co.in. */
export function domainAndParents(domain: string): string[] {
  const labels = domain.trim().toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."));
  return out;
}

/** Whether a block on `blocked` covers mail to `domain` — the domain itself, or one under it. */
export function domainCovers(blocked: string, domain: string | null): boolean {
  if (!domain) return false;
  const d = domain.toLowerCase();
  const b = blocked.toLowerCase();
  return d === b || d.endsWith(`.${b}`);
}

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** What was typed, as a block keeps it — or why it can't be one. */
export function readBlockValue(scope: "EMAIL" | "DOMAIN", raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const typed = raw.trim().toLowerCase();
  if (!typed) return { ok: false, error: scope === "EMAIL" ? "Type the address to block." : "Type the domain to block." };
  if (scope === "EMAIL") {
    const parsed = parseEmailAddress(typed);
    return parsed ? { ok: true, value: `${parsed.local}@${parsed.domain}` } : { ok: false, error: `"${raw.trim()}" isn't an email address.` };
  }
  // A domain as people paste it: an address, a link, an @ in front.
  const domain = (typed.includes("@") ? typed.slice(typed.lastIndexOf("@") + 1) : typed)
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/^www\./, "")
    .replace(/\.$/, "");
  if (!DOMAIN.test(domain)) return { ok: false, error: `"${raw.trim()}" isn't a domain — type it like acme.com.` };
  if (domain.split(".").length < 2) return { ok: false, error: "Block a company's domain, like acme.com." };
  // co.in, gov.in, com.au: every company under it, not one.
  if (/^(co|com|net|org|gov|ac|edu|nic|res|gen|firm|ind|ltd|plc)\.[a-z]{2}$/.test(domain)) {
    return { ok: false, error: `${domain} is shared by every company under it — block the company's own domain, like acme.${domain}.` };
  }
  return { ok: true, value: domain };
}
