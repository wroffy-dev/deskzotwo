"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { isKeptInTally } from "@/lib/tally/kept";

/**
 * While Tally keeps the books (Settings › Tally — src/lib/tally), a ledger page says so instead of showing figures nobody
 * should trust: "Kept in Tally", with the way to the Tally page. Invoices, receipts and the rest of the accounting
 * module show as ever.
 */
export function KeptInTallyGate({ on, children }: { on: boolean; children: ReactNode }) {
  const path = usePathname();
  if (!on || !isKeptInTally(path)) return <>{children}</>;
  return (
    <div className="mx-auto mt-8 max-w-xl rounded-xl border border-line bg-surface p-6 text-sm">
      <h1 className="text-lg font-semibold text-text">Kept in Tally</h1>
      <p className="mt-2 text-muted">
        Your books are kept in Tally, so the ledger, the reports, vouchers, returns and closing are there — not here. Deskzo does the selling and billing, and
        sends each period&apos;s invoices, credit notes and receipts to Tally.
      </p>
      <p className="mt-3">
        <Link href="/settings/tally" className="font-medium text-brand hover:underline">
          Open the Tally page
        </Link>
      </p>
    </div>
  );
}
