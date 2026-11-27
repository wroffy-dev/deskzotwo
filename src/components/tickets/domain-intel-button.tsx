"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, Copy, Globe, Search, XCircle } from "lucide-react";
import { checkTicketDomain, ticketDomains } from "@/actions/domain-check";
import type { LiveDomainReport } from "@/lib/domain-intel/live-check";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";

/**
 * "Domain intel" on a ticket (owner, 2 Nov 2026: for the support team — website, host, registrar and expiry, MX, DNS
 * records, name servers — "to identify the issue fast"): the customer's domains offered, any typed, looked up live
 * (src/lib/domain-intel/live-check.ts). What looks wrong first, then the domain, the website, mail, and every record;
 * "Copy summary" to paste into a comment.
 */

const day = (v: Date | string | null | undefined) => (v ? new Date(v).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
const daysLeft = (v: Date | string | null | undefined) => (v ? Math.floor((new Date(v).getTime() - Date.now()) / 86_400_000) : null);
const left = (v: Date | string | null | undefined) => {
  const d = daysLeft(v);
  return d === null ? "" : d < 0 ? ` — expired ${-d} days ago` : ` — ${d} days left`;
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-2 border-b border-line py-1.5 text-sm last:border-0">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 break-words text-text">{children}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-base border border-line p-3">
      <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-subtle">{title}</h3>
      {children}
    </section>
  );
}

/** The findings as plain text — for a comment, or a message to the customer. */
function summaryOf(r: LiveDomainReport): string {
  const lines = [
    `Domain check: ${r.domain} (${new Date(r.checkedAt).toLocaleString("en-GB")})`,
    ...(r.problems.length ? ["Problems:", ...r.problems.map((p) => `- ${p.text}`)] : ["No problems spotted."]),
    `Registrar: ${r.registrar ?? "unknown"}; expires ${day(r.expiresOn)}${left(r.expiresOn)}`,
    `Name servers: ${r.nsHosts.join(", ") || "none"}${r.dnsProvider && r.dnsProvider !== "Other" ? ` (${r.dnsProvider})` : ""}`,
    `Website: ${r.finalUrl ?? "no answer"}${r.httpStatus ? ` — ${r.httpStatus}` : ""}${r.hostProvider ? `, hosted on ${r.hostProvider}` : ""}`,
    `SSL: ${r.cert?.validTo ? `${r.cert.issuer ?? "issuer unknown"}, valid to ${day(r.cert.validTo)}${left(r.cert.validTo)}` : (r.cert?.error ?? "not checked")}`,
    `Mail: ${r.emailProvider ?? "provider unknown"}; MX ${r.mxRecords.map((m) => `${m.priority} ${m.exchange}`).join(", ") || "none"}`,
    `SPF: ${r.spfRecord ?? "none"}`,
    `DMARC: ${r.dmarcRecord ?? "none"}`,
    `DKIM: ${r.dkimFound ? "found" : "not found under the usual selectors"}`,
  ];
  return lines.join("\n");
}

export function DomainIntelButton({ ticketId }: { ticketId: string }) {
  const [open, setOpen] = useState(false);
  const [domain, setDomain] = useState("");
  const [offered, setOffered] = useState<string[] | null>(null);
  const [report, setReport] = useState<LiveDomainReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();

  const check = (d: string) =>
    start(async () => {
      setDomain(d);
      setError(null);
      setCopied(false);
      const result = await checkTicketDomain({ ticketId, domain: d });
      if (!result.ok) {
        setReport(null);
        return setError(result.error);
      }
      setReport(result.data);
    });

  const openPanel = async () => {
    setOpen(true);
    if (offered !== null) return;
    const found = await ticketDomains(ticketId).catch(() => []);
    setOffered(found);
    if (found[0] && !domain) check(found[0]);
  };

  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={openPanel} title="Website, registrar and expiry, name servers, mail and DNS records">
        <Globe className="mr-1.5 h-4 w-4" /> Domain intel
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Domain intel" large>
        <div className="space-y-3">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (domain.trim()) check(domain.trim());
            }}
          >
            <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="goignis.com, or an email address on it" aria-label="Domain" autoFocus />
            <Button type="submit" disabled={pending || !domain.trim()}>
              <Search className="mr-1.5 h-4 w-4" /> {pending ? "Checking…" : "Check"}
            </Button>
          </form>
          {offered && offered.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-subtle">From this ticket:</span>
              {offered.map((d) => (
                <button key={d} type="button" onClick={() => check(d)} className={`rounded-full border px-2 py-0.5 ${report?.domain === d ? "border-brand bg-brand/10 text-brand" : "border-line text-muted hover:text-text"}`}>
                  {d}
                </button>
              ))}
            </div>
          )}
          {offered && offered.length === 0 && !report && !pending && <p className="text-xs text-subtle">No domain in this ticket or on the customer — type one.</p>}
          {error && <ActionNotice tone="error">{error}</ActionNotice>}
          {pending && <p className="py-6 text-center text-sm text-muted">Looking up {domain}… DNS, the website, the registrar and the certificate — up to ten seconds.</p>}

          {report && !pending && (
            <div className="max-h-[65vh] space-y-3 overflow-y-auto pr-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-text">
                  {report.domain} <span className="text-xs font-normal text-subtle">checked {new Date(report.checkedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(summaryOf(report));
                      setCopied(true);
                    } catch {
                      setCopied(false);
                    }
                  }}
                >
                  <Copy className="mr-1.5 h-3.5 w-3.5" /> {copied ? "Copied" : "Copy summary"}
                </Button>
              </div>

              <Section title="What looks wrong">
                {report.problems.length === 0 ? (
                  <p className="flex items-center gap-1.5 py-1 text-sm text-success">
                    <CheckCircle2 className="h-4 w-4" /> Nothing wrong spotted.
                  </p>
                ) : (
                  <ul className="space-y-1 py-1">
                    {report.problems.map((p) => (
                      <li key={p.text} className={`flex items-start gap-1.5 text-sm ${p.level === "bad" ? "text-danger" : "text-warning"}`}>
                        {p.level === "bad" ? <XCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
                        {p.text}
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <div className="grid gap-3 md:grid-cols-2">
                <Section title="Domain">
                  <Row label="Registrar">{report.registrar ?? "Not published (some registries, like .in, often don't say)"}</Row>
                  <Row label="Registered">{day(report.registeredOn)}</Row>
                  <Row label="Expires">
                    {day(report.expiresOn)}
                    <span className={(daysLeft(report.expiresOn) ?? 99) <= 30 ? "text-danger" : "text-muted"}>{left(report.expiresOn)}</span>
                  </Row>
                  <Row label="Name servers">{report.nsHosts.length ? report.nsHosts.join(", ") : "None"}</Row>
                  <Row label="DNS hosted by">{report.dnsProvider && report.dnsProvider !== "Other" ? report.dnsProvider : "—"}</Row>
                </Section>
                <Section title="Website">
                  <Row label="Answers">{report.httpStatus ? `${report.httpStatus} at ${report.finalUrl}` : "No answer"}</Row>
                  <Row label="Title">{report.siteTitle ?? "—"}</Row>
                  <Row label="Hosted on">{report.hostProvider ? `${report.hostProvider}${report.hostEvidence ? ` (${report.hostEvidence})` : ""}` : "—"}</Row>
                  <Row label="Built with">{report.platform ?? "—"}</Row>
                  <Row label="IP address">{report.aRecords.join(", ") || "—"}</Row>
                  <Row label="www">{report.www.cname ? `CNAME ${report.www.cname}` : report.www.addresses.join(", ") || "Doesn't resolve"}</Row>
                  <Row label="SSL">
                    {report.cert?.validTo ? (
                      <>
                        {report.cert.issuer ?? "Issuer unknown"}, to {day(report.cert.validTo)}
                        <span className={(daysLeft(report.cert.validTo) ?? 99) <= 14 ? "text-danger" : "text-muted"}>{left(report.cert.validTo)}</span>
                        {report.cert.error && <span className="block text-xs text-warning">{report.cert.error}</span>}
                      </>
                    ) : (
                      (report.cert?.error ?? "Not reachable")
                    )}
                  </Row>
                </Section>
              </div>

              <Section title="Mail">
                <Row label="Provider">{report.emailProvider ?? "—"}</Row>
                <Row label="Filtered by">{report.emailSecurityProvider ?? "—"}</Row>
                <Row label="MX">{report.mxRecords.length ? report.mxRecords.map((m) => `${m.priority}  ${m.exchange}`).join(" · ") : "None — mail can't be delivered"}</Row>
                <Row label="SPF">{report.spfRecord ? <code className="text-xs">{report.spfRecord}</code> : "None"}</Row>
                <Row label="DMARC">{report.dmarcRecord ? <code className="text-xs">{report.dmarcRecord}</code> : "None"}</Row>
                <Row label="DKIM">{report.dkimFound ? "Found" : "Not found under the usual selectors (google, selector1/2, zoho, default…)"}</Row>
              </Section>

              <Section title="DNS records">
                <table className="w-full text-xs">
                  <tbody>
                    {[
                      ...report.aRecords.map((v) => ["A", v]),
                      ...report.aaaa.map((v) => ["AAAA", v]),
                      ...report.cnames.map((v) => ["CNAME", v]),
                      ...report.mxRecords.map((m) => ["MX", `${m.priority} ${m.exchange}`]),
                      ...report.nsHosts.map((v) => ["NS", v]),
                      ...report.txtRecords.map((v) => ["TXT", v]),
                      ...report.caa.map((v) => ["CAA", v]),
                      ...(report.soa ? [["SOA", `${report.soa.primary} ${report.soa.admin} (serial ${report.soa.serial})`]] : []),
                    ].map(([type, value], i) => (
                      <tr key={`${type}-${i}`} className="border-b border-line align-top last:border-0">
                        <td className="w-16 py-1 pr-2 font-mono text-muted">{type}</td>
                        <td className="break-all py-1 font-mono text-text">{value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Section>
            </div>
          )}
        </div>
      </Dialog>
    </>
  );
}
