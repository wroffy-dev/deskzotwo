import type { Metadata } from "next";
import Link from "next/link";
import { Banner } from "@/components/console/kit/banner";
import { PageHeader } from "@/components/console/kit/page-header";
import { StatusPill } from "@/components/console/kit/status";
import { AiTraining } from "@/components/console/settings/ai-training";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { capsFor } from "@/lib/console-shared/roles";
import { teammateModels } from "@/lib/ai-training/models";
import { listTrainingFiles, trainingWorkspaces } from "@/lib/ai-training/store";
import { notMigratedYet } from "@/lib/not-migrated";
import { consoleStaff } from "@/lib/platform/console-page";

export const metadata: Metadata = { title: "AI training" };

/**
 * Settings › AI training (owner, 20 Nov 2026 — src/lib/ai-training): the .md/.txt files Deskzo AI's teammates are
 * trained on, for every workspace or chosen ones. Settings' own gate to read; owners and admins change them (the
 * actions check again). No workspace sees this page or these files.
 */
export default async function ConsoleAiTrainingPage() {
  const staff = await consoleStaff(PAGE_ROLES.settings);
  const caps = capsFor(staff.role);
  const canEdit = caps.manage;
  const loaded = await Promise.all([listTrainingFiles(), trainingWorkspaces()]).catch((err) => {
    // The control plane's migration hasn't run yet.
    if (notMigratedYet(err) || (err instanceof Error && /platform_ai_training/.test(err.message))) return null;
    throw err;
  });
  // Which model each teammate runs on now — shown beside its name, so it's plain where its training goes.
  const models = await teammateModels().catch(() => ({}));

  return (
    <>
      <PageHeader
        title="AI training"
        chips={canEdit ? undefined : <StatusPill tone="neutral">View only</StatusPill>}
        subtitle="Guides each AI teammate is trained on — for every workspace, or only the ones you choose. Workspaces never see these files."
        actions={
          <Link href="/settings/ai" className="inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:underline">
            Deskzo AI settings
          </Link>
        }
      />
      {loaded ? (
        <AiTraining files={loaded[0]} workspaces={loaded[1]} models={models} canEdit={canEdit} />
      ) : (
        <Banner tone="warning" title="Not ready yet">
          {"This release's control-plane migration hasn't run here. Run npm run control:migrate, then reload."}
        </Banner>
      )}
    </>
  );
}
