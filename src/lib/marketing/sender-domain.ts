/**
 * Whether the sending domain is set up to be believed, and exactly what to add where it isn't (owner, 1 Nov 2026 — the
 * gaps against Brevo, Mailchimp, HubSpot). Pure: the DNS answers in, a line per record out, each with the record to
 * paste into the domain's DNS. Used by Settings › Marketing's domain check (src/actions/messaging-provider.ts).
 */

export type RecordCheck = {
  record: "SPF" | "DKIM" | "DMARC" | "MX";
  status: "ok" | "warn" | "error";
  message: string;
  /** The record to add or change, ready to paste. */
  fix?: { type: "TXT" | "CNAME"; host: string; value: string } | null;
};

/** The SPF include a provider sends through; null where it can't be known from here (a plain SMTP host we don't know). */
export function spfIncludeFor(providerKey: string, host?: string | null): string | null {
  const h = (host ?? "").toLowerCase();
  if (providerKey === "resend" || providerKey === "ses") return "include:amazonses.com";
  if (providerKey === "elastic") return "include:_spf.elasticemail.com";
  if (providerKey === "m365" || /office365|outlook/.test(h)) return "include:spf.protection.outlook.com";
  if (/gmail|google/.test(h)) return "include:_spf.google.com";
  if (/zoho\.in/.test(h)) return "include:zoho.in";
  if (/zoho/.test(h)) return "include:zoho.com";
  if (/sendgrid/.test(h)) return "include:sendgrid.net";
  if (/brevo|sendinblue/.test(h)) return "include:spf.brevo.com";
  if (/mailgun/.test(h)) return "include:mailgun.org";
  if (/amazonaws/.test(h)) return "include:amazonses.com";
  return null;
}

/** Where a provider's DKIM records come from — they're made for each domain, so only the provider can give them. */
export function dkimHowTo(providerKey: string, host?: string | null): string {
  const h = (host ?? "").toLowerCase();
  if (providerKey === "resend") return "In Resend, open Domains and add this domain: it lists the DKIM records to add.";
  if (providerKey === "ses" || /amazonaws/.test(h)) return "In the Amazon SES console, Verified identities › this domain › DKIM: add its three CNAME records.";
  if (providerKey === "elastic") return "In Elastic Email, Settings › Domains › this domain: add the DKIM record it shows.";
  if (providerKey === "m365" || /office365|outlook/.test(h)) return "In Microsoft 365 Defender, Email authentication › DKIM: add the selector1 and selector2 CNAMEs, then switch DKIM on.";
  if (/gmail|google/.test(h)) return "In Google Admin, Apps › Gmail › Authenticate email: generate a DKIM key and add it as a TXT record.";
  if (/zoho/.test(h)) return "In Zoho Mail admin, Domains › this domain › Email configuration › DKIM: add the selector it gives you.";
  return "Your mail provider gives the DKIM record for this domain — look for “DKIM” or “domain authentication” in its settings.";
}

/** DNS lookups an SPF record costs — receivers give up past ten, and then none of it counts. */
export function spfLookups(spf: string): number {
  // Mechanism by mechanism — "include:a" is one lookup, not an include and an "a".
  return spf.split(/\s+/).filter((t) => /^[~\-?+]?(include:|a$|a:|a\/|mx$|mx:|mx\/|ptr|exists:|redirect=)/i.test(t)).length;
}

/** An SPF record with an include added before its "all", or a new one. */
export function withInclude(spf: string | null, include: string): string {
  if (!spf) return `v=spf1 ${include} ~all`;
  if (spf.toLowerCase().includes(include.toLowerCase())) return spf;
  const all = spf.match(/\s[~\-?+]all\s*$/i);
  return all ? `${spf.slice(0, all.index)} ${include}${all[0]}` : `${spf} ${include} ~all`;
}

export function checkDomain(input: {
  domain: string;
  spfRecords: string[];
  dmarcRecord: string | null;
  dkimFound: boolean;
  mxCount: number;
  providers: { key: string; host?: string | null }[];
}): RecordCheck[] {
  const out: RecordCheck[] = [];
  const includes = [...new Set(input.providers.map((p) => spfIncludeFor(p.key, p.host)).filter((i): i is string => !!i))];
  const spf = input.spfRecords[0] ?? null;

  if (input.spfRecords.length > 1) {
    // Every mechanism the records name, once, plus your senders', ending in ~all.
    const parts = [...new Set(input.spfRecords.flatMap((r) => r.split(/\s+/).filter((p) => p && !/^v=spf1$/i.test(p) && !/^[~\-?+]?all$/i.test(p))))];
    const merged = includes.reduce((rec, inc) => withInclude(rec, inc), `v=spf1 ${parts.join(" ")} ~all`);
    out.push({ record: "SPF", status: "error", message: `${input.spfRecords.length} SPF records — receivers treat that as none at all. Replace them with this one.`, fix: { type: "TXT", host: "@", value: merged } });
  } else if (!spf) {
    out.push({ record: "SPF", status: "error", message: "No SPF record: receivers can't tell your mail from a forgery.", fix: { type: "TXT", host: "@", value: includes.reduce((rec, inc) => withInclude(rec, inc), `v=spf1 ${includes[0] ?? "include:<your provider>"} ~all`) } });
  } else if (/\+all\s*$/i.test(spf)) {
    out.push({ record: "SPF", status: "error", message: "SPF ends in +all, which lets anybody send as you. End it in ~all.", fix: { type: "TXT", host: "@", value: spf.replace(/\+all\s*$/i, "~all") } });
  } else {
    const missing = includes.filter((i) => !spf.toLowerCase().includes(i.toLowerCase()));
    if (missing.length) out.push({ record: "SPF", status: "warn", message: `SPF doesn't name ${missing.join(" or ")}, which your mail goes out through.`, fix: { type: "TXT", host: "@", value: missing.reduce((rec, inc) => withInclude(rec, inc), spf) } });
    else if (spfLookups(spf) > 10) out.push({ record: "SPF", status: "warn", message: `SPF needs ${spfLookups(spf)} lookups; receivers stop at 10 and then ignore it. Remove senders you no longer use.` });
    else out.push({ record: "SPF", status: "ok", message: "SPF names the services you send through." });
  }

  const how = dkimHowTo(input.providers[0]?.key ?? "smtp", input.providers[0]?.host);
  out.push(input.dkimFound ? { record: "DKIM", status: "ok", message: "DKIM found — your mail carries a signature receivers can check." } : { record: "DKIM", status: "error", message: `No DKIM signature found. ${how}` });

  const report = `rua=mailto:dmarc-reports@${input.domain}`;
  if (!input.dmarcRecord) {
    out.push({ record: "DMARC", status: "error", message: "No DMARC record. Start by monitoring for two weeks, then quarantine.", fix: { type: "TXT", host: "_dmarc", value: `v=DMARC1; p=none; ${report}; fo=1` } });
  } else if (/p=none/i.test(input.dmarcRecord)) {
    out.push({ record: "DMARC", status: "warn", message: "DMARC is p=none: it watches and enforces nothing. Once your reports show your own mail passing, quarantine.", fix: { type: "TXT", host: "_dmarc", value: input.dmarcRecord.replace(/p=none/i, "p=quarantine") } });
  } else {
    out.push({ record: "DMARC", status: "ok", message: `DMARC enforces (${input.dmarcRecord.match(/p=(\w+)/i)?.[0] ?? "p=?"}).` });
  }

  out.push(input.mxCount > 0 ? { record: "MX", status: "ok", message: "Replies can reach this domain." } : { record: "MX", status: "warn", message: "No MX records, so nobody can reply to this domain — and some receivers count that against it." });
  return out;
}

/**
 * How much to send while a domain builds its reputation: from the largest day of the last 30, the most to send in a day
 * now — about double, at least 100 — and a warning for a campaign far beyond what this domain has ever sent.
 */
export function warmUp(largestDay: number, campaignSize?: number): { limit: number; warning: string | null; advice: string } {
  const limit = Math.max(100, largestDay * 2);
  const advice =
    largestDay < 200
      ? "A domain that hasn't sent much yet: start with 50–100 a day to the people most likely to open, and roughly double every two or three days while bounces and complaints stay low."
      : `This domain's busiest day in the last 30 was ${largestDay.toLocaleString("en-IN")}. Keep any day to about ${limit.toLocaleString("en-IN")} until that's routine.`;
  const warning = campaignSize && campaignSize > limit ? `${campaignSize.toLocaleString("en-IN")} people is more than double this domain's busiest day lately (${largestDay.toLocaleString("en-IN")}) — a jump that size is how mail lands in spam. Split it over a few days, the most engaged first.` : null;
  return { limit, warning, advice };
}
