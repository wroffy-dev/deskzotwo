import Link from "next/link";
import { UserRoundCheck } from "lucide-react";
import { managerNoticeFor } from "@/actions/quick-messages";
import { QuickMessageButton } from "@/components/messages/quick-message";
import { DismissManagerNotice } from "@/components/messages/manager-notice-actions";

/**
 * On a customer whose account manager changed and who hasn't been told (owner, 11 Nov 2026 — src/lib/quick-messages):
 * a reminder with Email and WhatsApp, for whoever may message customers. Nothing is sent until somebody opens one and
 * presses Send; "No need" puts the reminder away. Shows nothing otherwise.
 */
export async function ManagerNoticeBanner({ companyId, companyName }: { companyId: string; companyName: string }) {
  const notice = await managerNoticeFor(companyId).catch(() => null);
  if (!notice) return null;
  const ask = { moment: "MANAGER_CHANGED", companyId };
  const intro = `From ${notice.toName}${notice.fromName ? `, with ${notice.fromName} copied on the email` : ""}. Nothing goes until you press Send.`;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-brand/30 bg-brand/5 px-4 py-3">
      <UserRoundCheck className="h-4 w-4 shrink-0 text-brand" aria-hidden />
      <div className="min-w-0 flex-1 text-sm text-text">
        <span className="font-medium">Not told about their new account manager.</span>{" "}
        <span className="text-muted">
          {notice.toName} took over{notice.fromName ? ` from ${notice.fromName}` : ""}. Introduce them when you&apos;re ready.{" "}
          <Link href="/companies/manager-changes" className="text-brand hover:underline">
            All waiting
          </Link>
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <QuickMessageButton ask={ask} title={`Introduce ${notice.toName} to ${companyName}`} label="Email" intro={intro} start="EMAIL" variant="primary" />
        <QuickMessageButton ask={ask} title={`Introduce ${notice.toName} to ${companyName}`} label="WhatsApp" intro={intro} start="WHATSAPP" />
        <DismissManagerNotice companyId={companyId} />
      </div>
    </div>
  );
}
