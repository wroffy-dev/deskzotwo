import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { previewGuest } from "@/actions/connect";
import { getOrganisation } from "@/lib/organisation";
import { Card } from "@/components/ui/card";
import { GuestHeader } from "@/components/connect/guest-header";
import { GuestPreviewBanner } from "@/components/connect/guest-preview-banner";

/**
 * What a guest sees on signing in (owner, 20 Nov 2026: "let admin see the view of each guest just like admin can see the
 * other users") — for whoever manages guests; anybody else gets "not found", as refused pages do. The lists shared with
 * them, straight into the one when there is only one, as theirs does.
 */
export default async function GuestPreviewPage({ params }: { params: Promise<{ guestId: string }> }) {
  if (!(await isModuleEnabled("workspace"))) return <ModuleDisabledNotice moduleKey="workspace" />;
  const { guestId } = await params;
  const guest = await previewGuest(guestId);
  if (!guest) notFound();
  if (guest.shares.length === 1) redirect(`/smart-lists/guests/view/${guest.id}/${guest.shares[0]!.id}`);
  const org = await getOrganisation();
  const business = org.tradeName || org.legalName || "this business";

  return (
    <div className="animate-fade-rise">
      <GuestPreviewBanner guest={guest} />
      <GuestHeader name={guest.name} connection={guest.connection} business={business} preview />
      <div className="mx-auto max-w-2xl space-y-3">
        <h1 className="text-xl font-semibold text-text">Shared with you</h1>
        {guest.shares.length === 0 ? (
          <Card className="p-6 text-sm text-muted">Nothing is shared with you right now. {business} will email you when something is.</Card>
        ) : (
          guest.shares.map((s) => (
            <Link key={s.id} href={`/smart-lists/guests/view/${guest.id}/${s.id}`} className="block">
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
    </div>
  );
}
