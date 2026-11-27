import Link from "next/link";
import { notFound } from "next/navigation";
import { Inbox } from "lucide-react";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { connectOverview } from "@/actions/connect";
import { getContactMode, pendingSuggestionCount } from "@/actions/connect-review";
import { connectLink } from "@/lib/connect/mail";
import { Button } from "@/components/ui/button";
import { GuestsManager } from "@/components/connect/guests-manager";
import { ContactModeSetting } from "@/components/connect/contact-mode-setting";
import { GuestAllowanceLine } from "@/components/connect/guest-allowance";
import { BarChart3 } from "lucide-react";

/**
 * Deskzo Connect's guests (owner, 20 Nov 2026 — src/lib/connect): the companies this workspace works alongside and
 * their people, the suggestions waiting, and how a row's account owner is shown to guests. For whoever may manage every
 * Smart List; anybody else gets "not found", as refused pages do.
 */
export default async function GuestsPage() {
  if (!(await isModuleEnabled("workspace"))) return <ModuleDisabledNotice moduleKey="workspace" />;
  const overview = await connectOverview();
  if (!overview.manager) notFound();
  const [waiting, mode] = overview.ready ? await Promise.all([pendingSuggestionCount(), getContactMode()]) : [0, "NAME_EMAIL"];

  return (
    <div className="animate-fade-rise space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/smart-lists" className="text-sm text-muted hover:text-text">
            ← Smart Lists
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-text">Guests</h1>
          <p className="mt-1 text-sm text-muted">
            People from other companies — a brand&apos;s reps, a subcontractor, an adviser — who see only the Smart Lists you share with them. They sign in at{" "}
            <span className="font-medium text-text">{await connectLink()}</span> with a code to their work email.
          </p>
        </div>
        {overview.ready && (
          <div className="flex flex-wrap gap-2">
            <Link href="/smart-lists/guests/activity">
              <Button variant="secondary">
                <BarChart3 className="mr-1.5 h-3.5 w-3.5" />
                Activity
              </Button>
            </Link>
            <Link href="/smart-lists/guests/suggestions">
              <Button variant={waiting ? "primary" : "secondary"}>
                <Inbox className="mr-1.5 h-3.5 w-3.5" />
                Suggestions{waiting ? ` · ${waiting}` : ""}
              </Button>
            </Link>
          </div>
        )}
      </div>
      {overview.ready ? (
        <>
          <GuestAllowanceLine allowance={overview.allowance} />
          <ContactModeSetting mode={mode} />
          <GuestsManager connections={overview.connections} states={overview.states} />
        </>
      ) : (
        <p className="text-sm text-muted">Deskzo Connect arrives with this workspace&apos;s next update.</p>
      )}
    </div>
  );
}
