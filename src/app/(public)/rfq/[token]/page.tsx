import type { Metadata } from "next";
import { getQuoteRequestPage } from "@/actions/quote-request-public";
import { Card } from "@/components/ui/card";
import { QuoteRequestForm } from "@/components/quote-requests/request-form";

/**
 * A reseller's own link to ask for a quotation (owner, 26 Nov 2026 — src/lib/quote-requests.ts). The token answers this
 * one reseller person, so the page is never indexed and never hands the address on in a Referer header.
 */
export const metadata: Metadata = {
  title: "Request a quotation",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function QuoteRequestLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const page = await getQuoteRequestPage(token);
  // One page for every way the link can be wrong — unknown, switched off, the person gone — so it says nothing about
  // which links exist.
  if (!page) {
    return (
      <Card className="mx-auto max-w-lg px-6 py-12 text-center">
        <h1 className="text-lg font-semibold text-text">This link isn&apos;t working</h1>
        <p className="mt-2 text-sm text-muted">It may have been switched off. Ask your account manager for a new one.</p>
      </Card>
    );
  }
  return <QuoteRequestForm token={token} page={page} />;
}
