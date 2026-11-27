import { requireAccessViewer } from "@/lib/access-control/guard";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Building2, Clock, Contact, Globe, Target } from "lucide-react";
import { sensitiveAccessBoard } from "@/actions/access-control-sensitive";
import { fieldMaskingState } from "@/actions/field-access";
import { unmaskDefaultLimitState } from "@/actions/unmask-log";
import { acPath } from "@/lib/access-control/nav";
import { AcPage, HintNote, Panel, Pill, acButton } from "@/components/access-control/ui";
import { DefaultLimitButton } from "@/components/access-control/sensitive/default-limit";
import { MaskingSwitchRow } from "@/components/access-control/sensitive/masking-switch";
import { MaskingStatePill, QuotaCards, limitText } from "@/components/access-control/sensitive/summary";
import { cn } from "@/lib/utils";

export const metadata = { title: "Global PII Masking" };

const ENTITY_ICON = { leads: Target, contacts: Contact, companies: Building2 } as const;

/** A workspace-wide rule the app keeps but has no switch for: said in words, with a pill for its answer. */
function FixedRow({ label, value, children, last }: { label: string; value: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className={cn("flex items-center gap-3.5 px-4 py-2.5", !last && "border-b border-line/70")}>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-text">{label}</div>
        <div className="text-xs leading-[1.45] text-muted">{children}</div>
      </div>
      <Pill className="shrink-0">{value}</Pill>
    </div>
  );
}

const inlineLink = "font-semibold text-brand hover:underline";

/**
 * Settings › Access Control › Sensitive Data › Global PII Masking: the one workspace-wide switch —
 * whether the masking rules apply at all — with what it covers and the rules around it that are fixed.
 *
 * The design's per-module coverage, "strict" default and "require reason" switches are not here: Deskzo
 * masks the sensitive fields of leads, contacts and companies by each role's and person's field rules,
 * and has no setting for the rest. They are stated, not drawn as switches that would do nothing.
 */
export default async function GlobalMaskingPage() {
  await requireAccessViewer();
  const [board, masking, defaultLimit] = await Promise.all([sensitiveAccessBoard(), fieldMaskingState(), unmaskDefaultLimitState()]);
  if (!board) notFound();
  const fieldCount = board.entities.reduce((n, e) => n + e.fields.length, 0);
  const { summary } = board;

  return (
    <AcPage
      crumb="Global PII Masking"
      title="Global PII Masking"
      description="Whether the masking rules apply at all, across the workspace. Which fields are masked, for whom, and who may unmask them is set per role and per person."
      actions={
        <>
          <Link href={acPath.sensitive()} className={acButton.secondary}>
            Who can see what
          </Link>
          <Link href={acPath.fields()} className={acButton.secondary}>
            Field Permissions
          </Link>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        <Panel id="pii-global">
          <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-4 py-3">
            <Globe className="h-[18px] w-[18px] shrink-0 text-brand" aria-hidden />
            <div className="min-w-[200px] flex-1">
              <div className="font-bold text-text">Global PII Masking Settings</div>
              <div className="text-xs text-muted">
                Workspace-wide policy for every masked field. Field-level View, Mask, Unmask and Export still decide per role and per person in{" "}
                <Link href={acPath.fields()} className={inlineLink}>
                  Field Permissions
                </Link>
                .
              </div>
            </div>
            <MaskingStatePill on={masking.enabled} recordTypes={board.entities.length} />
          </div>

          <div className="grid grid-cols-1 min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <div className="flex flex-col border-line/70 min-[1100px]:border-r">
              <MaskingSwitchRow state={masking} />
              <FixedRow label="Default masking behaviour" value="Visible unless a rule masks it">
                A field with no rule for a role or a person is visible and unmasked, as before field access. Masking starts where a rule is set, and a person&apos;s own rule comes
                before their role&apos;s.
              </FixedRow>
              <FixedRow label="Authorised unmasking" value={`${summary.canUnmask} ${summary.canUnmask === 1 ? "person" : "people"}`}>
                A masked value is revealed only by somebody whose rule for that field allows Unmask, on a record they can open, and within their daily limit. Nobody unmasks while
                viewing as somebody else.
              </FixedRow>
              <FixedRow label="Reason before reveal" value="Optional" last>
                Whoever presses Show may say why; what they type is kept with the log row. Every attempt — unmasked, shown again, stopped by the limit or refused — is logged either way, in{" "}
                <Link href={acPath.audit({ category: "pii" })} className={inlineLink}>
                  Unmasking Activity
                </Link>
                .
              </FixedRow>
            </div>

            <div className="flex flex-col border-t border-line/70 min-[1100px]:border-t-0">
              <div className="flex flex-wrap items-center gap-2 border-b border-line/70 px-4 py-2.5">
                <span className="flex-1 font-medium text-text">Record coverage</span>
                <span className="text-xs text-subtle">
                  {fieldCount} sensitive fields on {board.entities.length} record types
                </span>
              </div>
              <div className="flex flex-col gap-2.5 border-b border-line/70 px-4 py-3">
                {board.entities.map((e) => {
                  const Icon = ENTITY_ICON[e.entity];
                  return (
                    <div key={e.entity} className="flex flex-wrap items-center gap-1.5">
                      <Link
                        href={acPath.fields({ entity: e.entity })}
                        title={`${e.fields.length} sensitive fields — open in Field Permissions`}
                        className={cn(
                          "inline-flex h-[26px] items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold transition-colors",
                          masking.enabled ? "border-brand bg-brand-subtle text-brand" : "border-line-strong bg-surface text-subtle",
                        )}
                      >
                        <Icon className="h-3.5 w-3.5" aria-hidden />
                        {e.title}
                        <span className="font-medium opacity-70">{e.fields.length}</span>
                      </Link>
                      {e.fields.map((f) => (
                        <span key={f.key} title={f.description} className="inline-flex h-[22px] items-center rounded-full bg-surface-sunken px-2 text-[11px] font-medium text-muted">
                          {f.label}
                          {f.custom && <span className="ml-1 text-subtle">· custom</span>}
                        </span>
                      ))}
                    </div>
                  );
                })}
                <p className="text-[11.5px] leading-[1.45] text-subtle">
                  Masking covers these fields wherever the record is listed, opened, searched, exported or read through the API. A company&apos;s name is never masked: it is the
                  record&apos;s identity on every order, ticket and invoice. Custom fields are added here as they are created.
                </p>
              </div>
              <QuotaCards summary={summary} className="px-4 py-3" />
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pb-3 text-xs text-muted">
                <Clock className="h-4 w-4 shrink-0" aria-hidden />
                <span>
                  One limit for leads, contacts and companies · default <b className="font-bold text-text">{limitText(defaultLimit.dailyLimit).toLowerCase()}</b> · resets 12:00 AM{" "}
                  {board.zone}
                </span>
                <DefaultLimitButton state={defaultLimit} className={inlineLink}>
                  Change default
                </DefaultLimitButton>
                <Link href={acPath.limits()} className={cn(inlineLink, "ml-auto")}>
                  Manage limits per employee
                </Link>
              </div>
            </div>
          </div>
        </Panel>

        {!masking.enabled && (
          <HintNote>
            Masking is switched off: every masked field shows in the clear to everybody who can open the record, and there is nothing to unmask. Fields somebody may not see at all stay
            hidden. The rules are kept and apply again when it is switched back on.
          </HintNote>
        )}
        {!defaultLimit.mayChange && <p className="text-xs text-subtle">The master switch and the default daily limit are the super admin&apos;s to change.</p>}
      </div>
    </AcPage>
  );
}
