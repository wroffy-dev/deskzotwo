/**
 * Whether an email's From address is backed by sender authentication (security audit, Nov 2026).
 *
 * The From header is whatever the sender typed. It decided who an email was from: it could add a REPLY to a
 * customer's ticket and open it again, or file a new ticket under the contact's company. Now an email counts as
 * being from its From address only when the receiving mail server says so — the mail receiver
 * (deploy/cloudflare/inbound-email-worker.js) reads the authentication results Cloudflare added on receipt and sends
 * them, signed with the rest, as `auth`:
 *
 *   - DMARC passed for the From domain (which itself needs SPF or DKIM aligned with it), or
 *   - a DKIM signature passed for a domain aligned with the From domain (the same domain, or one a subdomain of
 *     the other — DMARC's relaxed alignment).
 *
 * Anything else — no results at all (an older receiver), results from a server that isn't the one we expect,
 * a failure, SPF alone — is unverified, and the email waits in the Support inbox flagged as such
 * (src/lib/support-mail/receive.ts).
 */

export type InboundAuth = {
  /** The server that checked it — Cloudflare's own ("mx.cloudflare.net"), or it isn't believed. */
  authservId: string;
  dmarc: string | null;
  /** The From domain DMARC was evaluated for (header.from). */
  dmarcDomain: string | null;
  /** Each DKIM signature's result and signing domain (header.d). */
  dkim: { result: string; domain: string }[];
  spf: string | null;
};

export type SenderCheck = { verified: boolean; why: string };

/** The authentication server whose results are believed: Cloudflare Email Routing's, unless the platform says otherwise. */
export function expectedAuthserv(): string {
  return (process.env.INBOUND_MAIL_AUTHSERV_ID?.trim() || "mx.cloudflare.net").toLowerCase();
}

const DOMAIN = /^[a-z0-9.-]{1,253}$/;
const word = (v: unknown) => (typeof v === "string" && v.length <= 40 ? v.trim().toLowerCase() : null);
const domainOf = (v: unknown) => {
  const d = typeof v === "string" ? v.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "") : "";
  return DOMAIN.test(d) && d.includes(".") ? d : null;
};

/** The `auth` the receiver sent, checked for shape — null when there is none or it isn't what the receiver writes. */
export function readAuth(value: unknown): InboundAuth | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const authservId = word(v.authservId);
  if (!authservId) return null;
  const dkim = Array.isArray(v.dkim)
    ? v.dkim.slice(0, 10).flatMap((d) => {
        const row = d as Record<string, unknown>;
        const result = word(row?.result);
        const domain = domainOf(row?.domain);
        return result && domain ? [{ result, domain }] : [];
      })
    : [];
  return { authservId, dmarc: word(v.dmarc), dmarcDomain: domainOf(v.dmarcDomain), dkim, spf: word(v.spf) };
}

/** DMARC's relaxed alignment, without a public-suffix list: the same domain, or one a subdomain of the other. */
export function aligned(a: string, b: string): boolean {
  if (!a.includes(".") || !b.includes(".")) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

export function checkSender(auth: InboundAuth | null, fromAddress: string): SenderCheck {
  const fromDomain = domainOf(fromAddress.split("@")[1]);
  if (!fromDomain) return { verified: false, why: "its From address has no domain to check" };
  if (!auth) return { verified: false, why: "the mail receiver sent no authentication results for it" };
  if (auth.authservId !== expectedAuthserv()) return { verified: false, why: `its authentication results came from ${auth.authservId}, not the mail receiver` };
  if (auth.dmarc === "pass" && auth.dmarcDomain && aligned(auth.dmarcDomain, fromDomain)) return { verified: true, why: `DMARC passed for ${fromDomain}` };
  const signed = auth.dkim.find((d) => d.result === "pass" && aligned(d.domain, fromDomain));
  if (signed) return { verified: true, why: `DKIM-signed by ${signed.domain}` };
  const said = [auth.dmarc && `DMARC ${auth.dmarc}`, auth.dkim.length ? `DKIM ${auth.dkim.map((d) => `${d.result} (${d.domain})`).join(", ")}` : "no DKIM signature", auth.spf && `SPF ${auth.spf}`].filter(Boolean).join("; ");
  return { verified: false, why: `nothing shows it is from ${fromDomain} (${said})` };
}
