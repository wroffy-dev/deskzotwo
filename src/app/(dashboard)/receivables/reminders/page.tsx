import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { isModuleEnabled } from "@/actions/module";
import { remindersToSend } from "@/actions/payment-reminders";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { RemindersQueue } from "@/components/collect/reminders-queue";
import { currentUser } from "@/lib/session";
import { mayLogFollowUps } from "@/lib/collections/load";

export const metadata = { title: "Reminders to send" };

/**
 * Receivables › Reminders to send (owner, 3 Nov 2026 — src/actions/payment-reminders.ts): payment reminders marked
 * "Review first" in Settings › Payment collection, waiting for somebody who follows up payments to send, edit, skip or
 * snooze them. Anybody else is told there's no such page.
 */
export default async function RemindersToSendPage() {
  if (!(await isModuleEnabled("receivables"))) return <ModuleDisabledNotice moduleKey="receivables" />;
  const user = await currentUser();
  if (!user || !(await mayLogFollowUps(user.id))) notFound();
  const { rows, snoozed, ready } = await remindersToSend();
  return (
    <div className="animate-fade-rise space-y-4">
      <Link href="/receivables" className="inline-flex items-center gap-1 text-sm text-muted hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden /> Receivables
      </Link>
      <div>
        <h1 className="text-xl font-semibold text-text">Reminders to send</h1>
        <p className="mt-1 text-sm text-muted">
          Steps marked &ldquo;Review first&rdquo; wait here rather than going by themselves. Send as it is, edit then send, snooze a week, or skip this step for
          that invoice — later steps still go.{snoozed ? ` ${snoozed} snoozed, shown faded.` : ""}
        </p>
      </div>
      {ready ? <RemindersQueue rows={rows} /> : <p className="text-sm text-muted">This workspace can review reminders after its next update.</p>}
    </div>
  );
}
