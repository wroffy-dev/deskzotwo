import { requireAccessViewer } from "@/lib/access-control/guard";
import { notFound } from "next/navigation";
import { Clock } from "lucide-react";
import { unmaskLimitsBoard } from "@/actions/access-control-sensitive";
import { unmaskDefaultLimitState } from "@/actions/unmask-log";
import { AcPage, HintNote, acButton } from "@/components/access-control/ui";
import { DefaultLimitButton } from "@/components/access-control/sensitive/default-limit";
import { LimitsBoard } from "@/components/access-control/sensitive/limits-board";
import { RoleLimitsPanel } from "@/components/access-control/sensitive/role-limits";

export const metadata = { title: "Unmasking Limits" };

/**
 * Settings › Access Control › Sensitive Data › Unmasking Limits: one daily limit per person for
 * unmasking leads, contacts and companies — who has which, where it comes from, and how much of it is
 * used today. A person's own limit and a role's are set here; the workspace default is the super
 * admin's. Each action checks again who is asking.
 */
export default async function UnmaskingLimitsPage({ searchParams }: { searchParams: Promise<{ status?: string | string[] }> }) {
  await requireAccessViewer();
  const sp = await searchParams;
  const status = Array.isArray(sp.status) ? sp.status[0] : sp.status;
  const [board, defaultLimit] = await Promise.all([unmaskLimitsBoard(), unmaskDefaultLimitState()]);
  if (!board) notFound();

  const chip = "flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-xs text-text/80";

  return (
    <AcPage
      crumb="Unmasking Limits"
      title="Unmasking Limits"
      description="One daily limit for unmasking leads, contacts and companies, per employee, across every screen and device. Each record unmasked uses one unit, once a day."
      actions={
        <>
          <div className={chip} title={board.nextResetText ? `Next: ${board.nextResetText}` : undefined}>
            <Clock className="h-4 w-4 text-muted" aria-hidden />
            Resets daily at <b className="font-bold">12:00 AM</b>
            <span className="text-subtle">· {board.zone}</span>
          </div>
          <div className={chip} title={defaultLimit.mayChange ? undefined : "Only the super admin can change it."}>
            Default limit
            <b className="font-bold text-text">{defaultLimit.dailyLimit === null ? "No limit" : defaultLimit.dailyLimit}</b>
            {defaultLimit.dailyLimit !== null && <span className="text-subtle">records / day</span>}
            <DefaultLimitButton state={defaultLimit} className="ml-1 font-semibold text-brand hover:underline">
              Change
            </DefaultLimitButton>
          </div>
          <a href="#role-limits" className={acButton.secondary}>
            Limits by role
          </a>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        {!board.maskingOn && (
          <HintNote>
            Field masking is switched off for the workspace: masked fields show in the clear and there is nothing to unmask, so nothing is counted. The limits below are kept and apply
            again when it is switched back on.
          </HintNote>
        )}
        <LimitsBoard key={status ?? "all"} data={board} initialStatus={status} />
        <RoleLimitsPanel roles={board.roles} workspaceDefault={defaultLimit.dailyLimit} />
      </div>
    </AcPage>
  );
}
