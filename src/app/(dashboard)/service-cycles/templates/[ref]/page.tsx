import Link from "next/link";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { getTemplate, listTemplates } from "@/actions/service-cycles";
import { TemplateForm } from "@/components/service-cycles/service-cycle-forms";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cadenceWords } from "@/lib/service-cycles/rules";

export const metadata = { title: "Service cycle plan" };

/** A plan (owner, 9 Nov 2026): made or changed by whoever runs cycles, read by whoever sees them. `new` for a new one. */
export default async function ServiceCyclePlanPage({ params }: { params: Promise<{ ref: string }> }) {
  if (!(await isModuleEnabled("tasks"))) return <ModuleDisabledNotice moduleKey="tasks" />;
  const ref = (await params).ref;
  const list = await listTemplates();
  if (!list) notFound();
  if (ref === "new" && !list.mayManage) notFound();
  const seq = Number(ref);
  const template = ref === "new" ? null : Number.isInteger(seq) && seq > 0 ? await getTemplate(seq) : null;
  if (ref !== "new" && !template) notFound();
  return (
    <div className="animate-fade-rise space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/service-cycles?tab=plans" className="text-xs text-brand hover:underline">Service cycles · Plans</Link>
          <h1 className="mt-1 text-xl font-semibold text-text">{template ? template.name : "New plan"}</h1>
        </div>
        {template && list.mayManage && template.active && (
          <Link href={`/service-cycles/new?plan=${template.id}`}>
            <Button size="sm">Start a cycle from it</Button>
          </Link>
        )}
      </div>
      {list.mayManage ? (
        <TemplateForm template={template} />
      ) : (
        template && (
          <Card className="space-y-2 p-4 text-sm">
            <p className="text-muted">
              {template.months} months{template.description ? ` · ${template.description}` : ""}
            </p>
            <ul className="space-y-1">
              {template.steps.map((s) => (
                <li key={s.id}>
                  <span className="font-medium text-text">{s.name}</span>{" "}
                  <span className="text-muted">
                    — {cadenceWords(s)}, a task {s.showDaysBefore} days ahead
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        )
      )}
    </div>
  );
}
