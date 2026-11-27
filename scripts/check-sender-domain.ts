/**
 * check:sender-domain — the sending domain's set-up, record by record, with what to paste (owner, 1 Nov 2026 —
 * src/lib/marketing/sender-domain.ts), and the warm-up arithmetic. No DNS, no database.
 *
 *   npm run check:sender-domain
 */
import { checkDomain, dkimHowTo, spfIncludeFor, spfLookups, warmUp, withInclude } from "../src/lib/marketing/sender-domain";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const find = (checks: ReturnType<typeof checkDomain>, record: string) => checks.find((c) => c.record === record)!;

ok("each provider's SPF include: SES and Resend, Microsoft 365, a Zoho India SMTP host, Gmail", spfIncludeFor("ses") === "include:amazonses.com" && spfIncludeFor("resend") === "include:amazonses.com" && spfIncludeFor("m365") === "include:spf.protection.outlook.com" && spfIncludeFor("smtp", "smtp.zoho.in") === "include:zoho.in" && spfIncludeFor("smtp", "smtp.gmail.com") === "include:_spf.google.com");
ok("  an SMTP host we don't know names none — never a guess", spfIncludeFor("smtp", "mail.example.in") === null);
ok("an include goes before the all; a record that has it is left alone", withInclude("v=spf1 include:x -all", "include:y") === "v=spf1 include:x include:y -all" && withInclude("v=spf1 include:y ~all", "include:y") === "v=spf1 include:y ~all" && withInclude(null, "include:y") === "v=spf1 include:y ~all");
ok("lookups counted: includes, a, mx", spfLookups("v=spf1 include:a include:b mx a ip4:1.2.3.4 ~all") === 4);

const two = checkDomain({ domain: "acme.in", spfRecords: ["v=spf1 include:_spf.google.com ~all", "v=spf1 include:zoho.in -all"], dmarcRecord: null, dkimFound: false, mxCount: 1, providers: [{ key: "ses" }] });
ok("two SPF records: an error, and one record to replace them, every sender named once", find(two, "SPF").status === "error" && find(two, "SPF").fix?.value === "v=spf1 include:_spf.google.com include:zoho.in include:amazonses.com ~all", find(two, "SPF").fix);
ok("  no DKIM: where to get it from SES", find(two, "DKIM").status === "error" && find(two, "DKIM").message.includes("SES"));
ok("  no DMARC: a monitoring record to start with, at _dmarc, reports to the domain", find(two, "DMARC").fix?.host === "_dmarc" && find(two, "DMARC").fix?.value === "v=DMARC1; p=none; rua=mailto:dmarc-reports@acme.in; fo=1");
const zoho = checkDomain({ domain: "acme.in", spfRecords: ["v=spf1 include:_spf.google.com ~all"], dmarcRecord: "v=DMARC1; p=none; rua=mailto:x@acme.in", dkimFound: true, mxCount: 0, providers: [{ key: "smtp", host: "smtp.zoho.in" }] });
ok("SPF that doesn't name the sender: a warning, and the record with it added", find(zoho, "SPF").status === "warn" && find(zoho, "SPF").fix?.value === "v=spf1 include:_spf.google.com include:zoho.in ~all");
ok("  DMARC at p=none: step it up to quarantine, keeping the rest", find(zoho, "DMARC").status === "warn" && find(zoho, "DMARC").fix?.value === "v=DMARC1; p=quarantine; rua=mailto:x@acme.in");
ok("  no MX: a warning", find(zoho, "MX").status === "warn");
ok("+all: an error, ending it in ~all", (() => { const c = find(checkDomain({ domain: "a.in", spfRecords: ["v=spf1 include:x +all"], dmarcRecord: null, dkimFound: true, mxCount: 1, providers: [] }), "SPF"); return c.status === "error" && c.fix?.value === "v=spf1 include:x ~all"; })());
ok("all in order: nothing to fix", checkDomain({ domain: "a.in", spfRecords: ["v=spf1 include:amazonses.com ~all"], dmarcRecord: "v=DMARC1; p=reject", dkimFound: true, mxCount: 2, providers: [{ key: "resend" }] }).every((c) => c.status === "ok" && !c.fix));
ok("DKIM advice for an unknown host still says where to look", /DKIM/.test(dkimHowTo("smtp", "mail.example.in")));

const fresh = warmUp(0, 5000);
ok("warm-up: a domain that hasn't sent — 100 a day, and a warning for 5,000 at once", fresh.limit === 100 && !!fresh.warning && /50–100 a day/.test(fresh.advice));
ok("  one that sent 400 on its busiest day: up to 800, and 600 is fine", warmUp(400, 600).limit === 800 && warmUp(400, 600).warning === null);

console.log(failures ? `\n${failures} failed.` : "\nAll sender-domain checks pass.");
process.exitCode = failures ? 1 : 0;
