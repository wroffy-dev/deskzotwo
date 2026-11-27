import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { VerifyFrame, VerifyResult } from "@/components/verifiable/verify-page";
import { db } from "@/lib/db";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { workspaceClock } from "@/lib/time/workspace";
import { publicFacts } from "@/lib/verifiable/rules";
import { publicDesign, publicExtraFields, verifiableSearchSettings } from "@/lib/verifiable/search";

export const metadata: Metadata = { title: "Document check", robots: { index: false, follow: false } };

/**
 * What a verifiable document's QR code opens (owner, 7 Nov 2026 — src/actions/verifiable.ts), for anybody: an employer, a tender
 * team, a customer. Who issued it, what it is, and whether it still stands, in the workspace's own design. An address that isn't a
 * document is a 404. A workspace that no longer has the feature can't say a document is good, so it says so rather than "Valid".
 */
export default async function VerifiableCheckPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) notFound();
  const doc = await db.verifiableDocument.findUnique({
    where: { token },
    select: { docType: true, number: true, title: true, holderName: true, scope: true, issuedOn: true, expiresOn: true, withdrawnAt: true, customFields: true },
  });
  if (!doc) notFound();
  const [design, clock, open, search] = await Promise.all([publicDesign(), workspaceClock(), moduleAvailableForTenant("companies"), verifiableSearchSettings()]);
  if (!open) {
    return (
      <div className="mx-auto w-full max-w-md rounded-2xl border border-line bg-surface px-5 py-5 text-sm text-muted shadow-sm">
        This document couldn&apos;t be confirmed here. Please ask {design.issuer} directly.
      </div>
    );
  }
  const facts = publicFacts(doc, clock.calendarDate(new Date()));
  return (
    <VerifyFrame design={design}>
      <VerifyResult
        issuer={design.issuer}
        checkedAt={clock.dateTime(new Date())}
        facts={{ ...facts, withdrawnOn: facts.withdrawnOn ? clock.date(facts.withdrawnOn) : null, extra: await publicExtraFields(doc.customFields) }}
      />
      {search.searchOn && (
        <Link href="/verify" className="block text-center text-sm text-muted hover:underline">
          Check another document
        </Link>
      )}
    </VerifyFrame>
  );
}
