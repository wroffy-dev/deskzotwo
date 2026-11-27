import tls from "node:tls";
import { DNS_TIMEOUT_MS, resolver, withTimeout } from "@/lib/dns";
import { publicAddressOf } from "@/lib/net/safe-fetch";
import { inspectDomain } from "@/lib/domain-intel/lookup";
import { toDomain } from "@/lib/domain-intel/signatures";
import { isFreeMailbox } from "@/lib/email-verification";

/**
 * Domain intel on a ticket (owner, 2 Nov 2026: "a domain intel button for the support team — website, domain host,
 * registrar and expiry, MX records, DNS records, name servers — to identify the issue fast").
 *
 * A live check of any domain, nothing stored: Domain Intel's own lookups (src/lib/domain-intel/lookup.ts — public DNS,
 * the homepage through the network guard, RDAP for the registrar), and beside them what a support person asks next —
 * every record type, the www name, the website's certificate — and the problems they add up to, worst first, so the
 * likely cause is the first thing read. Every lookup is timed out and allowed to fail.
 */

export type CertFindings = { issuer: string | null; subject: string | null; validTo: Date | null; names: string[]; error: string | null };

export type Problem = { level: "bad" | "warn"; text: string };

export type LiveDomainReport = Awaited<ReturnType<typeof inspectDomain>> & {
  domain: string;
  checkedAt: Date;
  aaaa: string[];
  aRecords: string[];
  txtRecords: string[];
  soa: { primary: string; admin: string; serial: number } | null;
  caa: string[];
  www: { cname: string | null; addresses: string[] };
  mxRecords: { priority: number; exchange: string }[];
  cert: CertFindings | null;
  problems: Problem[];
};

/** A name worth looking up: a registrable-looking domain, no more. */
export function cleanDomain(input: string | null | undefined): string | null {
  const d = toDomain(input?.replace(/^.*@/, "") ?? null);
  if (!d || d.length > 253 || !/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*\.[a-z]{2,63}$/.test(d)) return null;
  return d;
}

/** The website's certificate, read on a connection to its public address — never one inside our network. */
async function certificateOf(domain: string): Promise<CertFindings | null> {
  let address: string;
  try {
    address = await publicAddressOf(domain);
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    const done = (r: CertFindings) => {
      socket.destroy();
      resolve(r);
    };
    // Read, not trusted: a broken chain is itself a finding, so verification is left to us.
    const socket = tls.connect({ host: address, port: 443, servername: domain, rejectUnauthorized: false, timeout: 6_000 }, () => {
      const cert = socket.getPeerCertificate();
      if (!cert || !cert.valid_to) return done({ issuer: null, subject: null, validTo: null, names: [], error: "No certificate offered" });
      const names = (cert.subjectaltname ?? "")
        .split(",")
        .map((n) => n.trim().replace(/^DNS:/, ""))
        .filter(Boolean);
      const validTo = new Date(cert.valid_to);
      const covers = names.some((n) => n === domain || (n.startsWith("*.") && domain.endsWith(n.slice(1))) || n === `www.${domain}`);
      done({
        issuer: (cert.issuer?.O ?? cert.issuer?.CN ?? null) as string | null,
        subject: (cert.subject?.CN ?? null) as string | null,
        validTo: Number.isNaN(validTo.getTime()) ? null : validTo,
        names: names.slice(0, 20),
        error: socket.authorized ? null : covers ? (socket.authorizationError ? String(socket.authorizationError) : null) : `It's for ${names.slice(0, 3).join(", ") || "another name"}, not ${domain}`,
      });
    });
    socket.on("timeout", () => done({ issuer: null, subject: null, validTo: null, names: [], error: "No answer on port 443" }));
    socket.on("error", (err) => done({ issuer: null, subject: null, validTo: null, names: [], error: err.message.slice(0, 160) }));
  });
}

const DAY = 86_400_000;

/** What the findings add up to, worst first — the likely cause of a "mail isn't arriving" or "site is down" ticket. */
export function problemsIn(r: Omit<LiveDomainReport, "problems">, now = new Date()): Problem[] {
  const out: Problem[] = [];
  const days = (d: Date | null) => (d ? Math.floor((d.getTime() - now.getTime()) / DAY) : null);
  const expiry = days(r.expiresOn);
  if (expiry !== null && expiry < 0) out.push({ level: "bad", text: `The domain expired ${-expiry} day${expiry === -1 ? "" : "s"} ago — renew it with ${r.registrar ?? "the registrar"}.` });
  else if (expiry !== null && expiry <= 30) out.push({ level: "warn", text: `The domain expires in ${expiry} day${expiry === 1 ? "" : "s"} (${r.registrar ?? "registrar unknown"}).` });
  if (r.nsHosts.length === 0) out.push({ level: "bad", text: "No name servers answer for it — the domain may not be set up, or be on hold." });
  if (r.mxHosts.length === 0) out.push({ level: "bad", text: "No MX records — nobody can email this domain." });
  const spfs = r.txtRecords.filter((t) => t.toLowerCase().startsWith("v=spf1"));
  if (spfs.length > 1) out.push({ level: "bad", text: `${spfs.length} SPF records — there must be one; mail may be rejected until they're merged.` });
  else if (spfs.length === 0 && r.mxHosts.length) out.push({ level: "warn", text: "No SPF record — mail from this domain is likelier to land in spam." });
  if (!r.dmarcRecord && r.mxHosts.length) out.push({ level: "warn", text: "No DMARC record — Gmail and Yahoo may refuse bulk mail from it." });
  if (!r.dkimFound && r.mxHosts.length) out.push({ level: "warn", text: "No DKIM found under the usual selectors — check the mail provider's DKIM is switched on." });
  if (r.httpStatus === null) out.push({ level: r.aRecords.length || r.cnames.length ? "bad" : "warn", text: r.aRecords.length || r.cnames.length ? "The website doesn't answer." : "No website — the domain points nowhere for the web." });
  else if (r.httpStatus >= 500) out.push({ level: "bad", text: `The website answers with an error (${r.httpStatus}).` });
  else if (r.httpStatus >= 400) out.push({ level: "warn", text: `The website answers ${r.httpStatus}.` });
  if (r.finalUrl?.startsWith("http://")) out.push({ level: "warn", text: "The website isn't on HTTPS — browsers mark it \"Not secure\"." });
  if (r.cert) {
    const certDays = days(r.cert.validTo);
    if (certDays !== null && certDays < 0) out.push({ level: "bad", text: `The website's SSL certificate expired ${-certDays} day${certDays === -1 ? "" : "s"} ago.` });
    else if (certDays !== null && certDays <= 14) out.push({ level: "warn", text: `The website's SSL certificate expires in ${certDays} day${certDays === 1 ? "" : "s"}.` });
    if (r.cert.error && certDays !== null && certDays >= 0) out.push({ level: "warn", text: `The SSL certificate has a problem: ${r.cert.error}.` });
  }
  if (r.dmarcPolicy === "none" && r.mxHosts.length) out.push({ level: "warn", text: "DMARC is at p=none — it reports, it doesn't protect." });
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === "bad" ? -1 : 1));
}

export async function liveDomainReport(domain: string): Promise<LiveDomainReport> {
  const [base, aaaa, a, txt, soa, caa, mx, wwwCname, wwwA, cert] = await Promise.all([
    inspectDomain(domain),
    withTimeout(resolver.resolve6(domain), DNS_TIMEOUT_MS),
    withTimeout(resolver.resolve4(domain), DNS_TIMEOUT_MS),
    withTimeout(resolver.resolveTxt(domain), DNS_TIMEOUT_MS),
    withTimeout(resolver.resolveSoa(domain), DNS_TIMEOUT_MS),
    withTimeout(resolver.resolveCaa(domain), DNS_TIMEOUT_MS),
    withTimeout(resolver.resolveMx(domain), DNS_TIMEOUT_MS),
    withTimeout(resolver.resolveCname(`www.${domain}`), DNS_TIMEOUT_MS),
    withTimeout(resolver.resolve4(`www.${domain}`), DNS_TIMEOUT_MS),
    certificateOf(domain),
  ]);
  const report: Omit<LiveDomainReport, "problems"> = {
    ...base,
    domain,
    checkedAt: new Date(),
    aaaa: aaaa ?? [],
    aRecords: a ?? [],
    txtRecords: (txt ?? []).map((parts) => parts.join("")),
    soa: soa ? { primary: soa.nsname, admin: soa.hostmaster, serial: soa.serial } : null,
    caa: (caa ?? []).map((r) => [r.critical ? "critical" : "", r.issue ? `issue ${r.issue}` : r.issuewild ? `issuewild ${r.issuewild}` : r.iodef ? `iodef ${r.iodef}` : ""].filter(Boolean).join(" ")),
    www: { cname: wwwCname?.[0] ?? null, addresses: wwwA ?? [] },
    mxRecords: (mx ?? []).sort((x, y) => x.priority - y.priority).map((r) => ({ priority: r.priority, exchange: r.exchange })),
    cert,
  };
  return { ...report, problems: problemsIn(report) };
}

/**
 * The domains a ticket points at, likeliest first: the customer's website, the contact's email domain, and any domain
 * or address written in the ticket or its comments — not a free mailbox's (gmail.com says nothing about the customer).
 */
export function domainsFrom(sources: { website?: string | null; emails?: (string | null | undefined)[]; text?: string[] }): string[] {
  const found: string[] = [];
  const add = (v: string | null | undefined) => {
    const d = cleanDomain(v);
    if (d && !isFreeMailbox(d) && !found.includes(d)) found.push(d);
  };
  add(sources.website);
  for (const e of sources.emails ?? []) add(e);
  for (const t of sources.text ?? []) {
    for (const m of t.matchAll(/[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})|\b((?:[a-z0-9-]+\.)+(?:com|in|net|org|co\.in|io|ai|biz|info|co|us|uk|ae|tech|online|store|app|dev))\b/gi)) add(m[1] ?? m[2]);
  }
  return found.slice(0, 6);
}
