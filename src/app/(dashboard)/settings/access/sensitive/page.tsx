import { requireAccessViewer } from "@/lib/access-control/guard";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Clock, Globe } from "lucide-react";
import { sensitiveAccessBoard } from "@/actions/access-control-sensitive";
import { acPath } from "@/lib/access-control/nav";
import { AcPage, HintNote, Panel, acButton } from "@/components/access-control/ui";
import { KpiTile, MaskingStatePill, QuotaCards, limitText } from "@/components/access-control/sensitive/summary";
import { ExportHoldersPanel, FieldAccessPanel } from "@/components/access-control/sensitive/who-can-see";

export const metadata = { title: "Sensitive Data Access" };

/**
 * Settings › Access Control › Sensitive Data: the fields that matter most in one place — masking and
 * today's unmasking at the top, then, record type by record type, who sees each sensitive field in the
 * clear, masked or not at all, and who holds the rights that take data out in a file.
 *
 * It answers "who can see it"; it changes nothing. A field's rule is a role's or a person's, set in
 * Field Permissions, and every row links there.
 */
export default async function SensitiveDataPage() {
  await requireAccessViewer();
  const board = await sensitiveAccessBoard();
  if (!board) notFound();
  const { summary } = board;

  const fields = board.entities.flatMap((e) => e.fields);
  const maskedFields = fields.filter((f) => f.masked.length > 0).length;
  const restrictedFields = fields.filter((f) => f.restricted.length > 0).length;
  const unmaskable = fields.filter((f) => f.unmask.length > 0).length;
  const exporters = new Set(board.exports.flatMap((x) => x.holders.map((h) => h.person))).size;

  return (
    <AcPage
      crumb="Sensitive Data"
      title="Sensitive Data Access"
      description="The fields that matter most, in one place. Mask hides part of the value; Unmask is a separate, logged right."
      actions={
        <>
          <Link href={acPath.masking()} className={acButton.secondary}>
            Masking settings
          </Link>
          <Link href={acPath.fields()} className={acButton.primary}>
            Field Permissions
          </Link>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <Panel>
          <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-4 py-3">
            <Globe className="h-[18px] w-[18px] shrink-0 text-brand" aria-hidden />
            <div className="min-w-[200px] flex-1">
              <div className="font-bold text-text">Global PII Masking</div>
              <div className="text-xs text-muted">
                {board.maskingOn
                  ? "The masking rules apply: a masked value shows in part until it is unmasked, within each person's daily limit."
                  : "Switched off for the whole workspace: masked fields show in the clear and there is nothing to unmask. The rules are kept."}
              </div>
            </div>
            <MaskingStatePill on={board.maskingOn} recordTypes={board.entities.length} />
            <Link href={acPath.masking()} className="text-xs font-semibold text-brand hover:underline">
              Settings
            </Link>
          </div>
          <QuotaCards summary={summary} className="px-4 py-3" />
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pb-3 text-xs text-muted">
            <Clock className="h-4 w-4 shrink-0" aria-hidden />
            <span>
              One limit for leads, contacts and companies · default <b className="font-bold text-text">{limitText(summary.defaultLimit).toLowerCase()}</b> · resets 12:00 AM {board.zone}
            </span>
            <Link href={acPath.limits()} className="ml-auto font-semibold text-brand hover:underline">
              Manage limits per employee
            </Link>
          </div>
        </Panel>

        <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">
          <KpiTile label="Sensitive fields" value={fields.length} hint={`on ${board.entities.map((e) => e.title.toLowerCase()).join(", ")}`} />
          <KpiTile label="Masked for someone" value={maskedFields} hint="partial value shown" tone={maskedFields ? "warn" : undefined} />
          <KpiTile label="Can be unmasked" value={unmaskable} hint="logged on every reveal" tone={unmaskable ? "warn" : undefined} />
          <KpiTile label="Restricted for someone" value={restrictedFields} hint="not shown at all" />
          <KpiTile label="People who can export" value={exporters} hint={exporters ? "leaves the system in files" : "nothing leaves in files"} tone={exporters ? "danger" : "success"} />
        </div>

        {!board.maskingOn && (
          <HintNote>
            Field masking is switched off, so what is listed here is what people see right now: fields a rule masks show in the clear. Restricted fields stay hidden. The rules apply
            again when masking is switched back on.
          </HintNote>
        )}

        {board.entities.map((e) => (
          <FieldAccessPanel key={e.entity} entity={e.entity} title={e.title} fields={e.fields} people={board.people} />
        ))}
        <ExportHoldersPanel rows={board.exports} people={board.people} />
      </div>
    </AcPage>
  );
}
