import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getOrganisation } from "@/lib/organisation";
import { currentGuest } from "@/lib/connect/guest-auth";
import { guestListView, guestShares } from "@/lib/connect/guest-lists";
import { Card } from "@/components/ui/card";
import { GuestHeader } from "@/components/connect/guest-header";
import { GuestListTable } from "@/components/connect/guest-list-table";

/**
 * A Smart List as a guest sees it (owner, 20 Nov 2026 — src/lib/connect/guest-lists.ts): its companies, the columns
 * marked for guests, editable where marked. A share that isn't theirs, or has ended, shows nothing of the list.
 */
export const metadata: Metadata = { title: "Deskzo Connect", robots: { index: false, follow: false }, referrer: "no-referrer" };
export const dynamic = "force-dynamic";

export default async function GuestListPage({ params, searchParams }: { params: Promise<{ shareId: string }>; searchParams: Promise<{ q?: string; page?: string }> }) {
  const [{ shareId }, query] = await Promise.all([params, searchParams]);
  const guest = await currentGuest();
  if (!guest) redirect("/connect");
  const org = await getOrganisation();
  const business = org.tradeName || org.legalName || "this business";
  const view = await guestListView(guest.id, shareId, { search: query.q, page: Number(query.page) || 1 });
  const others = (await guestShares(guest.id)).length;

  return (
    <>
      <GuestHeader name={guest.name} connection={guest.connectionName} business={business} />
      <div className="mx-auto max-w-6xl">
        {!view ? (
          <Card className="mx-auto max-w-lg p-6 text-center">
            <h1 className="text-lg font-semibold text-text">This list isn&apos;t shared with you</h1>
            <p className="mt-2 text-sm text-muted">It may have ended, or been taken back. {others > 0 && <Link href="/connect" className="text-brand hover:underline">See what is shared with you</Link>}</p>
          </Card>
        ) : (
          <GuestListTable view={view} search={query.q ?? ""} page={Number(query.page) || 1} hasOthers={others > 1} />
        )}
      </div>
    </>
  );
}
