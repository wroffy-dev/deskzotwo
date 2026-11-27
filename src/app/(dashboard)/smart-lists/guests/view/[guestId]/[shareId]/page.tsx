import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { previewGuest, previewGuestList } from "@/actions/connect";
import { getOrganisation } from "@/lib/organisation";
import { Card } from "@/components/ui/card";
import { GuestHeader } from "@/components/connect/guest-header";
import { GuestListTable } from "@/components/connect/guest-list-table";
import { GuestPreviewBanner } from "@/components/connect/guest-preview-banner";

/**
 * A shared list as this guest sees it (owner, 20 Nov 2026) — through the same function as theirs, so their ticked rows,
 * territory and columns are exactly what shows. View only.
 */
export default async function GuestListPreviewPage({ params, searchParams }: { params: Promise<{ guestId: string; shareId: string }>; searchParams: Promise<{ q?: string; page?: string }> }) {
  if (!(await isModuleEnabled("workspace"))) return <ModuleDisabledNotice moduleKey="workspace" />;
  const [{ guestId, shareId }, query] = await Promise.all([params, searchParams]);
  const guest = await previewGuest(guestId);
  if (!guest) notFound();
  const page = Number(query.page) || 1;
  const view = await previewGuestList(guest.id, shareId, { search: query.q, page });
  const org = await getOrganisation();
  const business = org.tradeName || org.legalName || "this business";

  return (
    <div className="animate-fade-rise">
      <GuestPreviewBanner guest={guest} />
      <GuestHeader name={guest.name} connection={guest.connection} business={business} preview />
      <div className="mx-auto max-w-6xl">
        {!view ? (
          <Card className="mx-auto max-w-lg p-6 text-center">
            <h1 className="text-lg font-semibold text-text">This list isn&apos;t shared with them</h1>
            <p className="mt-2 text-sm text-muted">It may have ended, or been taken back.</p>
          </Card>
        ) : (
          <GuestListTable view={view} search={query.q ?? ""} page={page} hasOthers={guest.shares.length > 1} preview={{ guestId: guest.id, base: `/smart-lists/guests/view/${guest.id}` }} />
        )}
      </div>
    </div>
  );
}
