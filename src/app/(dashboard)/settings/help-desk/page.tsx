import { db } from "@/lib/db";
import { isModuleEnabled } from "@/actions/module";
import { DeskSettings } from "@/components/desks/desk-settings";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { SettingsPage } from "@/components/settings/settings-page";
import { notMigratedYet } from "@/lib/not-migrated";
import { deskSettings, type DeskSetting } from "@/lib/desks/server";

/** Settings → Help desk (owner, 25 Nov 2026 — src/lib/desks): the desks, their people, types and times. No request is shown. */
export default async function Page() {
  if (!(await isModuleEnabled("desks"))) return <ModuleDisabledNotice moduleKey="desks" />;
  const [desks, departments] = await Promise.all([
    deskSettings().catch((err): DeskSetting[] | null => {
      if (notMigratedYet(err)) return null;
      throw err;
    }),
    db.department.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, members: { where: { active: true, kind: "MEMBER" }, orderBy: { name: "asc" }, select: { id: true, name: true } } } }),
  ]);
  return (
    <SettingsPage settingsKey="help-desk" description="Desks employees ask inside the company: IT, admin, accounts. Each desk is one of your departments. Its people see its requests, and nobody else's. The super admin sees every desk.">
      {desks ? <DeskSettings desks={desks} departments={departments} /> : <p className="text-sm text-muted">This workspace is being updated — come back in a few minutes.</p>}
    </SettingsPage>
  );
}
