import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/console/kit/page-header";
import { StatusPill } from "@/components/console/kit/status";
import { MailTemplatesEditor, type TemplateRow } from "@/components/console/settings/mail-templates";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { capsFor } from "@/lib/console-shared/roles";
import { MAIL_TEMPLATES } from "@/lib/console-shared/mail-templates";
import { consoleStaff } from "@/lib/platform/console-page";
import { staffNamesByIds } from "@/lib/platform/console-page-reads";
import { savedWordings, wordingOf } from "@/lib/platform/mail/templates";

export const metadata: Metadata = { title: "Mail templates" };

/**
 * Settings › Mail › Templates (owner, 1 Nov 2026): the wording of every email Deskzo itself sends — signing in,
 * workspaces, billing, staff and partners. Settings' own gate; only an owner changes anything
 * (src/actions/platform/console-mail.ts checks again).
 */
export default async function ConsoleMailTemplatesPage() {
  const staff = await consoleStaff(PAGE_ROLES.settings);
  const caps = capsFor(staff.role);
  const saved = await savedWordings();
  const by = [...new Set(Object.values(saved).map((w) => w?.updatedBy).filter((id): id is string => !!id))];
  const people = by.length ? await staffNamesByIds(by).catch(() => []) : [];
  const names = new Map(people.map((p) => [p.id, p.name]));
  const rows: TemplateRow[] = MAIL_TEMPLATES.map((def) => {
    const wording = wordingOf(def, saved);
    const own = wording.edited ? saved[def.key] : undefined;
    return { key: def.key, subject: wording.subject, text: wording.text, edited: wording.edited, updatedAt: own?.updatedAt ?? null, updatedByName: own ? (names.get(own.updatedBy) ?? null) : null };
  });

  return (
    <>
      <PageHeader
        title="Mail templates"
        chips={caps.owner ? undefined : <StatusPill tone="neutral">View only</StatusPill>}
        subtitle="The wording of every email Deskzo sends itself — account setup, password links, signup codes, billing, staff and partner invitations. Emails about a workspace go from “<Workspace> via Deskzo”."
        actions={
          <Link href="/settings/mail" className="inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:underline">
            Mail settings
          </Link>
        }
      />
      <MailTemplatesEditor defs={MAIL_TEMPLATES} rows={rows} canEdit={caps.owner} testTo={staff.email} />
    </>
  );
}
