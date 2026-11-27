import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { VerifyFrame, VerifySearchForm } from "@/components/verifiable/verify-page";
import { clientIpFrom } from "@/lib/client-ip";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { HOUR_MS, siteAllowance } from "@/lib/platform/find-workspaces";
import { currentTenant } from "@/lib/tenancy/resolve";
import { workspaceClock } from "@/lib/time/workspace";
import { formatCalendarDay } from "@/lib/time/zone";
import { STANDING_WORDS, type VerifiableStanding } from "@/lib/verifiable/rules";
import { NUMBER_SEARCH_LIMITS, publicDesign, searchVerifiable, usesNameSearch, verifiableSearchSettings, type VerifiableHit } from "@/lib/verifiable/search";

export const metadata: Metadata = { title: "Check a document", robots: { index: false, follow: false } };

const TEN_MINUTES = 10 * 60_000;
const TONE: Record<VerifiableStanding, string> = { VALID: "bg-success", EXPIRED: "bg-warning", WITHDRAWN: "bg-danger" };

function Result({ hit }: { hit: VerifiableHit }) {
  const inner = (
    <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
      <span className="min-w-0">
        {/* Security audit, 11 Nov 2026 (SEC-33): a person's name only through the certificate's own QR code. */}
        <span className="block font-semibold text-text">{hit.holderName ?? "Issued to a person — scan the certificate's QR code to see whose"}</span>
        <span className="block text-sm text-muted">
          {hit.title} · <span className="font-mono text-xs">{hit.number}</span>
        </span>
        {hit.expiresOn && <span className="block text-xs text-subtle">{hit.standing === "EXPIRED" ? "Expired on" : "Valid until"} {formatCalendarDay(hit.expiresOn)}</span>}
      </span>
      <span className={`${TONE[hit.standing]} rounded-full px-3 py-1 text-sm font-medium text-white`}>{STANDING_WORDS[hit.standing]}</span>
    </div>
  );
  if (!hit.token) return <div className="block overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">{inner}</div>;
  return (
    <Link href={`/v/${hit.token}`} className="block overflow-hidden rounded-2xl border border-line bg-surface shadow-sm transition-colors hover:border-brand">
      {inner}
    </Link>
  );
}

/**
 * A workspace's public document search (owner, 7 Nov 2026 — src/lib/verifiable/search.ts): off until it's switched on under
 * Certificates › Public pages, and a 404 till then. Works without JavaScript, because it's a plain form. Limited by address, name
 * searches more tightly: searching isn't a way to read out the client list.
 */
export default async function VerifySearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  if (!(await moduleAvailableForTenant("companies"))) notFound();
  const settings = await verifiableSearchSettings();
  if (!settings.searchOn) notFound();
  const q = String((await searchParams).q ?? "").trim().slice(0, 120);
  const [design, clock, tenant] = await Promise.all([publicDesign(), workspaceClock(), currentTenant()]);
  let limited = false;
  let hits: VerifiableHit[] = [];
  if (q) {
    const ip = clientIpFrom(await headers()) ?? "unknown";
    // Security audit, 11 Nov 2026: number lookups held tightly by address, over ten minutes and a day (SEC-33), and
    // no workspace-wide cap any more — one outsider could use it up and switch the page off for everybody (SEC-48).
    const max = usesNameSearch(q, settings) ? 10 : NUMBER_SEARCH_LIMITS.perTenMinutes;
    limited =
      !siteAllowance([{ key: `verify:${tenant.id}:${ip}`, max }], TEN_MINUTES) ||
      !siteAllowance([{ key: `verify-day:${tenant.id}:${ip}`, max: NUMBER_SEARCH_LIMITS.perDay }], 24 * HOUR_MS);
    if (!limited) hits = await searchVerifiable(q, settings, clock.calendarDate(new Date()));
  }
  return (
    <VerifyFrame design={design}>
      <VerifySearchForm design={design} query={q} placeholder={settings.nameSearch ? "Certificate number or company name" : "Certificate number"} />
      {limited && <p className="rounded-2xl border border-warning/40 bg-warning-bg px-5 py-4 text-sm text-warning">Too many searches just now. Please wait a few minutes.</p>}
      {q && !limited && hits.length === 0 && (
        <p className="rounded-2xl border border-line bg-surface px-5 py-4 text-sm text-muted">
          No record found for &ldquo;{q}&rdquo;. Check the number as printed. This doesn&apos;t prove a document is fake, so please ask {design.issuer} directly if you&apos;re unsure.
        </p>
      )}
      {hits.map((hit) => (
        <Result key={hit.token} hit={hit} />
      ))}
    </VerifyFrame>
  );
}
