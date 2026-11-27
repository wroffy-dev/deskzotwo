import Link from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { workbookFilterOptions } from "@/actions/workspace";
import { WorkbookEditor } from "@/components/workspace/workbook-editor";
import { NewListChooser } from "@/components/smart-lists/new-list-chooser";
import { INDUSTRY_TEMPLATES } from "@/lib/industry-templates/catalogue";
import { templatesFor } from "@/lib/smart-lists/templates";
import { ownRowsReady, workspaceIndustry } from "@/lib/smart-lists/own-rows";
import { companyTemplates } from "@/lib/smart-lists/company-templates";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";

/**
 * A new Smart List: companies narrowed by filters (?from=companies), or — since 20 Nov 2026 (owner: "add more smart list
 * templates use cases across industry usage as per the industry template admin choose") — a list with rows of its own,
 * blank or from a template, the workspace's own industry first (src/lib/smart-lists/own-rows.ts).
 */
export default async function NewWorkbookPage({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  const enabled = await isModuleEnabled("workspace");
  if (!enabled) return <ModuleDisabledNotice moduleKey="workspace" />;

  const { from } = await searchParams;
  if (from === "companies") {
    const options = await workbookFilterOptions();
    return (
      <div className="animate-fade-rise">
        <Link href="/smart-lists/new" className="text-sm text-muted hover:text-text">
          ← New list
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-text">A list of companies</h1>
        <p className="mt-1 mb-5 text-sm text-muted">
          Narrow the companies down, watch the count, then save it. Nothing is saved until you press Save.
        </p>

        <WorkbookEditor options={options} />
      </div>
    );
  }

  const [industry, ready, viewer] = await Promise.all([workspaceIndustry(), ownRowsReady(), requireUser()]);
  // The company's own templates, made from its lists (Smart Lists phase 3).
  const mine = await companyTemplates(viewer.id, await can(viewer.id, "workspace.manageAny"));
  const { suggested, groups } = templatesFor(industry?.key ?? null);

  return (
    <div className="animate-fade-rise">
      <Link href="/smart-lists" className="text-sm text-muted hover:text-text">
        ← Smart Lists
      </Link>
      <h1 className="mt-1 text-xl font-semibold text-text">New list</h1>
      <p className="mt-1 mb-5 text-sm text-muted">A list of your companies, or a list with rows of its own — blank, or from a template made for the work.</p>

      <NewListChooser
        industry={industry}
        suggested={suggested}
        groups={groups}
        industryNames={Object.fromEntries(INDUSTRY_TEMPLATES.map((t) => [t.key, t.name]))}
        ready={ready}
        mine={mine}
      />
    </div>
  );
}
