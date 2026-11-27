import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { listManagerNotices } from "@/actions/quick-messages";
import { listQuickTemplates } from "@/lib/quick-messages/server";
import { Card } from "@/components/ui/card";
import { ManagerNoticesTable } from "@/components/messages/manager-notice-actions";
import { workspaceClock } from "@/lib/time/workspace";

export const metadata = { title: "New account managers to introduce" };

/**
 * Customers › New account managers to introduce (owner, 11 Nov 2026 — src/lib/quick-messages): the customers whose
 * account manager changed and who haven't been told. Each is told by hand — one at a time, or several by email. For
 * whoever may message customers from templates; the customers listed are the ones they can open.
 */
export default async function ManagerChangesPage() {
  const waiting = await listManagerNotices();
  if (!waiting.ok) notFound();
  const [clock, templates] = await Promise.all([workspaceClock(), listQuickTemplates({ moment: "MANAGER_CHANGED", activeOnly: true })]);
  const rows = waiting.data.map((r) => ({ ...r, changed: clock.date(new Date(r.changedAt)) }));
  return (
    <div className="space-y-5">
      <div>
        <Link href="/companies" className="inline-flex items-center gap-1 text-xs text-muted hover:text-text">
          <ArrowLeft className="h-3.5 w-3.5" /> Customers
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-text">New account managers to introduce</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Customers whose account manager changed and who haven&apos;t been told. The email goes from the new account manager, with the previous one
          copied; WhatsApp goes from the company&apos;s number. Nothing is sent on its own — open one, read it, and press Send, or tick several and
          email them the template as it stands.
        </p>
      </div>
      <Card className="overflow-hidden">
        <ManagerNoticesTable rows={rows} templates={templates.filter((t) => t.emailSubject && t.emailBody).map((t) => ({ id: t.id, name: t.name }))} />
      </Card>
    </div>
  );
}
