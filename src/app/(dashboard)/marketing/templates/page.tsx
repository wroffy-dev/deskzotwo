import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listTemplates } from "@/actions/marketing";
import { hasEffectivePermission } from "@/actions/permission";
import { currentUser } from "@/lib/session";
import { Badge, Card } from "@/components/ui/card";
import { TemplateEditor } from "@/components/marketing/template-editor";
import { TemplateRowActions } from "@/components/marketing/template-row-actions";
import { TemplateLibrary } from "@/components/marketing/template-library";
import { libraryBrand } from "@/lib/marketing/library-brand";
import { designedIds } from "@/lib/marketing/design-store";
import Link from "next/link";
import { LayoutDashboard, Sparkles } from "lucide-react";
import { TOPICS } from "@/lib/marketing/topics";
import { requiredFields } from "@/lib/marketing/merge";
import { workspaceClock } from "@/lib/time/workspace";

export default async function TemplatesPage() {
  const enabled = await isModuleEnabled("marketing");
  if (!enabled) return <ModuleDisabledNotice moduleKey="marketing" />;

  const user = await currentUser();
  const [templates, canManage, clock] = await Promise.all([
    listTemplates(),
    user ? hasEffectivePermission(user.id, "marketing.manage") : Promise.resolve(false),
    workspaceClock(),
  ]);
  // The ready-made templates are drawn in this workspace's look (src/lib/marketing/template-library.ts), and those
  // made in the email builder open there again rather than in the HTML editor.
  const [brand, designed] = canManage ? await Promise.all([libraryBrand(), designedIds(templates.map((t) => t.id))]) : [null, new Set<string>()];

  return (
    <div className="animate-fade-rise">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Templates</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            The wording. A template is frozen onto each message as it is queued, so editing one next month never
            rewrites what went out last month.
          </p>
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            {brand && <TemplateLibrary brand={brand} />}
            <TemplateEditor />
            <Link href="/marketing/templates/builder?ai=1" className="inline-flex h-9 items-center gap-1.5 rounded-base border border-line-strong bg-surface px-3.5 text-sm text-text shadow-sm hover:bg-surface-sunken">
              <Sparkles className="h-4 w-4 text-brand" aria-hidden /> Design with AI
            </Link>
            <Link href="/marketing/templates/builder" className="inline-flex h-9 items-center gap-1.5 rounded-base bg-brand px-3.5 text-sm font-medium text-brand-contrast shadow-sm hover:brightness-110">
              <LayoutDashboard className="h-4 w-4" aria-hidden /> Build an email
            </Link>
          </div>
        )}
      </div>

      <div className="mt-5 space-y-3">
        {templates.length === 0 ? (
          <Card className="px-4 py-12 text-center text-sm text-subtle">
            No templates yet. A campaign needs one — it is the thing that actually gets sent.
          </Card>
        ) : (
          templates.map((t) => {
            const required = requiredFields(`${t.subject ?? ""} ${t.body}`);
            return (
              <Card key={t.id} className="px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-text">{t.name}</span>
                      <Badge tone="blue">{t.channel === "WHATSAPP" ? "WhatsApp" : "Email"}</Badge>
                      <Badge tone="default">{TOPICS.find((x) => x.key === t.topic)?.label ?? t.topic}</Badge>
                      {designed.has(t.id) ? <Badge tone="brand">Email builder</Badge> : t.format === "HTML" && <Badge tone="brand">HTML{t.sourceFileName ? ` · ${t.sourceFileName}` : ""}</Badge>}
                      {!t.active && <Badge tone="amber">Retired</Badge>}
                    </div>
                    {t.subject && <p className="text-xs text-muted">{t.subject}</p>}
                    <p className="text-[11px] text-subtle">
                      {t.createdBy.name} · updated {clock.date(t.updatedAt)}
                      {required.length > 0 && (
                        <> · every recipient must have: {required.map((r) => `{{${r}}}`).join(", ")}</>
                      )}
                    </p>
                  </div>
                  {canManage && (
                    <div className="flex flex-wrap items-start gap-2">
                      <TemplateRowActions template={{ id: t.id, name: t.name, active: t.active }} />
                      {designed.has(t.id) ? (
                        <Link href={`/marketing/templates/builder?id=${t.id}`} className="inline-flex h-8 items-center gap-1.5 rounded-base border border-line-strong bg-surface px-3 text-[13px] text-text shadow-sm hover:bg-surface-sunken">
                          <LayoutDashboard className="h-3.5 w-3.5" aria-hidden /> Edit in builder
                        </Link>
                      ) : (
                        <TemplateEditor template={t} />
                      )}
                    </div>
                  )}
                </div>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
