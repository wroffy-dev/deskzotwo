import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getOrganisation } from "@/lib/organisation";
import { currentGuest } from "@/lib/connect/guest-auth";
import { guestShares } from "@/lib/connect/guest-lists";
import { Card } from "@/components/ui/card";
import { GuestSignIn } from "@/components/connect/guest-sign-in";
import { GuestHeader } from "@/components/connect/guest-header";

/**
 * Deskzo Connect's front door (owner, 20 Nov 2026 — src/lib/connect): signed out, the code sign-in; signed in, the lists
 * shared with this guest — straight into the one when there is only one. Nothing else of the workspace is reachable.
 */
export const metadata: Metadata = { title: "Deskzo Connect", robots: { index: false, follow: false }, referrer: "no-referrer" };
export const dynamic = "force-dynamic";

export default async function ConnectPage() {
  const org = await getOrganisation();
  const business = org.tradeName || org.legalName || "this business";
  const guest = await currentGuest();
  if (!guest) return <GuestSignIn business={business} />;

  const shares = await guestShares(guest.id);
  if (shares.length === 1) redirect(`/connect/${shares[0]!.id}`);

  return (
    <>
      <GuestHeader name={guest.name} connection={guest.connectionName} business={business} />
      <div className="mx-auto max-w-2xl space-y-3">
        <h1 className="text-xl font-semibold text-text">Shared with you</h1>
        {shares.length === 0 ? (
          <Card className="p-6 text-sm text-muted">Nothing is shared with you right now. {business} will email you when something is.</Card>
        ) : (
          shares.map((s) => (
            <Link key={s.id} href={`/connect/${s.id}`} className="block">
              <Card className="p-4 transition-colors hover:border-line-strong">
                <div className="font-medium text-text">{s.listName}</div>
                <div className="mt-0.5 text-xs text-muted">
                  {s.sharedBy ? `Shared by ${s.sharedBy}` : "Shared with you"}
                  {s.until ? ` · until ${new Date(s.until).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}` : ""}
                </div>
              </Card>
            </Link>
          ))
        )}
      </div>
    </>
  );
}
