import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { hasEffectivePermission } from "@/actions/permission";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { EmailBuilder } from "@/components/marketing/builder/email-builder";
import { currentUser } from "@/lib/session";
import { db } from "@/lib/db";
import { blankDesign } from "@/lib/marketing/email-design";
import { designOf } from "@/lib/marketing/design-store";
import { libraryBrand } from "@/lib/marketing/library-brand";
import { libraryTemplate } from "@/lib/marketing/template-library";
import { listSavedBlocks } from "@/lib/marketing/saved-blocks";

export const metadata = { title: "Email builder" };

/**
 * Marketing › Templates › Email builder (owner, 1 Nov 2026): `?id=` a template made here, to change it; `?start=` a
 * template library's key, to begin from it; neither, to begin from a blank email — or, with `?ai=1`, from nothing, with
 * "Design with AI" open. For whoever may manage marketing — anybody else is told there's no such page ("refused pages
 * are 404").
 */
export default async function EmailBuilderPage({ searchParams }: { searchParams: Promise<{ id?: string; start?: string; ai?: string }> }) {
  if (!(await isModuleEnabled("marketing"))) return <ModuleDisabledNotice moduleKey="marketing" />;
  const user = await currentUser();
  if (!user || !(await hasEffectivePermission(user.id, "marketing.manage"))) notFound();
  const { id, start, ai } = await searchParams;
  const [brand, saved] = await Promise.all([libraryBrand(), listSavedBlocks()]);

  if (id) {
    const template = await db.marketingTemplate.findUnique({ where: { id }, select: { id: true, name: true, topic: true, subject: true, preheader: true, channel: true } });
    if (!template || template.channel !== "EMAIL") notFound();
    const design = await designOf(template.id);
    // Written or uploaded as HTML: there's no design to open — it's edited where it was made.
    if (!design) notFound();
    return <EmailBuilder brand={brand} saved={saved} initial={{ id: template.id, name: template.name, topic: template.topic, subject: template.subject ?? "", preheader: template.preheader ?? "", design }} />;
  }

  const from = start ? libraryTemplate(start) : null;
  return (
    <EmailBuilder
      brand={brand}
      saved={saved}
      // Templates › Design with AI: a blank email, the AI dialog open on it.
      openAi={ai === "1"}
      initial={
        from
          ? { id: null, name: from.name, topic: from.topic, subject: from.subject, preheader: from.preheader, design: from.design(brand) }
          : { id: null, name: "New email", topic: "NEWSLETTER", subject: "", preheader: "", design: ai === "1" ? { ...blankDesign(), blocks: [] } : blankDesign() }
      }
    />
  );
}
