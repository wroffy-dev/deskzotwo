import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { formForFilling } from "@/actions/smart-list-team";
import { FormFiller } from "@/components/smart-lists/list-forms";

/**
 * A Smart List's form, to fill in (owner, 20 Nov 2026 — Smart Lists phase 3): for anybody signed in with Smart Lists
 * open to them. Only the form shows — never the list — and the answer becomes a row of it (src/lib/smart-lists/forms.ts).
 * A closed or deleted form answers as a page that isn't there.
 */
export default async function SmartListFormPage({ params }: { params: Promise<{ formId: string }> }) {
  if (!(await isModuleEnabled("workspace"))) return <ModuleDisabledNotice moduleKey="workspace" />;
  const { formId } = await params;
  const form = await formForFilling(formId);
  if (!form) notFound();
  return (
    <div className="mx-auto max-w-xl animate-fade-rise space-y-4">
      <div>
        <p className="text-xs text-subtle">A form for the Smart List &ldquo;{form.listName}&rdquo;</p>
        <h1 className="text-xl font-semibold text-text">{form.name}</h1>
        {form.intro && <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{form.intro}</p>}
      </div>
      <FormFiller form={form} />
    </div>
  );
}
