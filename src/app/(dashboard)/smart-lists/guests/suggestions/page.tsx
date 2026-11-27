import Link from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { reviewQueue } from "@/actions/connect-review";
import { ReviewQueue } from "@/components/connect/review-queue";

/**
 * Guests' suggestions to review (owner, 20 Nov 2026 — Deskzo Connect phase 3): on the lists this person may edit — every
 * list for whoever manages them all.
 */
export default async function SuggestionsPage() {
  if (!(await isModuleEnabled("workspace"))) return <ModuleDisabledNotice moduleKey="workspace" />;
  const items = await reviewQueue();
  return (
    <div className="animate-fade-rise space-y-5">
      <div>
        <Link href="/smart-lists/guests" className="text-sm text-muted hover:text-text">
          ← Guests
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-text">Suggestions from guests</h1>
        <p className="mt-1 text-sm text-muted">Companies and corrections guests proposed for your lists. Nothing goes into Companies until you decide here; the guest only ever hears &ldquo;added&rdquo; or &ldquo;not added&rdquo;.</p>
      </div>
      {items === null ? <p className="text-sm text-muted">This arrives with the workspace&apos;s next update.</p> : <ReviewQueue items={items} />}
    </div>
  );
}
