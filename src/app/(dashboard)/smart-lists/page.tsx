import Link from "next/link";
import { Plus, Users } from "lucide-react";
import { isModuleEnabled } from "@/actions/module";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listWorkbooks } from "@/actions/workspace";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { workspaceClock } from "@/lib/time/workspace";
import { listExtras } from "@/lib/smart-lists/index-extras";
import { SmartListIndex, type IndexRow } from "@/components/smart-lists/smart-list-index";

/**
 * Saved lists. The ones most recently opened come first, because a worklist is something people come back to daily
 * rather than browse. Since 20 Nov 2026 (owner: "this screen also requires upgrade") in the look the lists themselves
 * have — search, tabs, cards or a table, and what each list holds at a glance (src/components/smart-lists/smart-list-index).
 */
export default async function WorkspacePage() {
  const enabled = await isModuleEnabled("workspace");
  if (!enabled) return <ModuleDisabledNotice moduleKey="workspace" />;

  const [all, clock, viewer] = await Promise.all([listWorkbooks(), workspaceClock(), requireUser()]);
  // Deskzo Connect's guests (owner, 20 Nov 2026): for whoever may manage every list — an existing permission.
  const manageGuests = await can(viewer.id, "workspace.manageAny");
  const extras = await listExtras(all.map((w) => w.id));
  const rows: IndexRow[] = all.map((w) => ({
    id: w.id,
    name: w.name,
    description: w.description,
    calling: w.mode === "COLD_CALLING",
    ownRows: w.mode === "ROWS",
    shared: w.shared,
    filterCount: w.filterCount,
    records: w._count.records,
    mine: w.mine,
    assignedToMe: w.assignedToMe,
    owner: w.owner.name,
    assignees: w.assignees.map((a) => a.user.name),
    opened: w.lastOpenedAt ? `opened ${clock.date(w.lastOpenedAt)}` : `saved ${clock.date(w.updatedAt)}`,
  }));

  return (
    <div className="animate-fade-rise space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-text">Smart Lists</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Lists of companies built from filters — a territory, a renewal window, every account nobody has called in 90
            days — that stay current as the data moves. Or lists with rows of their own, from a template or a spreadsheet:
            backlinks, units, candidates, tenders.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {manageGuests && (
            <Link href="/smart-lists/guests">
              <Button variant="secondary">
                <Users className="mr-1.5 h-3.5 w-3.5" />
                Guests
              </Button>
            </Link>
          )}
          <Link href="/smart-lists/new">
            <Button>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              New list
            </Button>
          </Link>
        </div>
      </div>

      {all.length === 0 ? (
        <Card className="px-4 py-12 text-center">
          <p className="text-sm text-muted">No lists yet.</p>
          <p className="mt-1 text-sm text-subtle">
            Build one from any combination of city, industry, order type, renewal window, pipeline state or what their
            domain says — then save it and work from it.
          </p>
          <Link href="/smart-lists/new" className="mt-4 inline-block">
            <Button>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Build a list
            </Button>
          </Link>
        </Card>
      ) : (
        <SmartListIndex rows={rows} extras={extras} />
      )}
    </div>
  );
}
