import { DNS_TIMEOUT_MS, resolver } from "@/lib/dns";
import { parseEmailAddress } from "@/lib/email-verification";

/**
 * The last look at an address before mail leaves (owner, 30 Oct 2026: "check is email id valid before sending any
 * mail") — for every sender: the workspace's own providers (src/lib/marketing/providers) and Deskzo's own mailer
 * (src/lib/platform/mailer.ts).
 *
 * It stops only what is sure to bounce: an address that isn't one, or a domain that doesn't exist or takes no mail
 * (no MX, and no address to fall back to). Unlike the Verify button (src/lib/email-verification-lookup.ts), a DNS
 * that doesn't answer — a timeout, a resolver down — is *not* a verdict: the mail goes, and the provider's own bounce
 * tells the truth later. Refusing a customer's renewal reminder because 1.1.1.1 was slow would be worse than the
 * bounce it saves. Shared or personal mailboxes, throwaway services: they deliver, so they go.
 *
 * Definite answers are kept a few hours a domain; an unanswered lookup isn't kept.
 */
export type AddressVerdict = { ok: true } | { ok: false; address: string; detail: string };

const TTL_MS = 6 * 60 * 60 * 1000;
const domains = new Map<string, { takesMail: boolean; at: number }>();

/** What DNS said, three ways: records, a definite none, or no answer at all. */
async function lookup(kind: "MX" | "A" | "AAAA", domain: string): Promise<"some" | "none" | "unknown"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const query = kind === "MX" ? resolver.resolveMx(domain) : kind === "A" ? resolver.resolve4(domain) : resolver.resolve6(domain);
    const found = await Promise.race([query, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), DNS_TIMEOUT_MS)))]);
    if (found === null) return "unknown";
    return found.length > 0 ? "some" : "none";
  } catch (err) {
    // ENOTFOUND: the domain doesn't exist. ENODATA: it exists, without this record. Anything else is the network.
    const code = (err as { code?: string } | null)?.code;
    return code === "ENOTFOUND" || code === "ENODATA" ? "none" : "unknown";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Whether a domain takes mail: true, false — or null when DNS didn't say. */
async function domainTakesMail(domain: string): Promise<boolean | null> {
  if (testDomains) return testDomains(domain);
  const kept = domains.get(domain);
  if (kept && Date.now() - kept.at < TTL_MS) return kept.takesMail;
  const mx = await lookup("MX", domain);
  let takesMail: boolean | null;
  if (mx === "some") takesMail = true;
  else {
    // No MX: RFC 5321 falls back to the domain's own address.
    const [a, aaaa] = await Promise.all([lookup("A", domain), lookup("AAAA", domain)]);
    takesMail = a === "some" || aaaa === "some" ? true : mx === "none" && a === "none" && aaaa === "none" ? false : null;
  }
  if (takesMail !== null) domains.set(domain, { takesMail, at: Date.now() });
  return takesMail;
}

/** One address: whether mail to it can arrive at all. */
export async function addressVerdict(raw: string): Promise<AddressVerdict> {
  const address = raw.trim();
  const parsed = parseEmailAddress(address);
  if (!parsed) return { ok: false, address, detail: `"${address}" isn't an email address — check it for a typo or a stray space.` };
  if ((await domainTakesMail(parsed.domain)) === false) {
    return { ok: false, address, detail: `${parsed.domain} doesn't exist or takes no mail — check ${address} for a typo.` };
  }
  return { ok: true };
}

/** Every address a mail goes to; the first that can't receive it, if any. */
export async function firstUndeliverable(addresses: (string | null | undefined)[]): Promise<AddressVerdict> {
  for (const a of new Set(addresses.map((x) => x?.trim()).filter((x): x is string => !!x))) {
    const verdict = await addressVerdict(a);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}

/**
 * For the check suites, as the mailer's own `setTestMailTransport`: their made-up domains (acme.test, zz.invalid) answered
 * without DNS — `() => true` lets everything through. Null puts real DNS back.
 */
let testDomains: ((domain: string) => boolean | null) | null = null;
export function setTestMailDomains(answer: ((domain: string) => boolean | null) | null): void {
  testDomains = answer;
}
