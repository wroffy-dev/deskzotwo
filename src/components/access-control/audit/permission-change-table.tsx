"use client";

import { useState } from "react";
import type { PermissionChangeKind } from "@prisma/client";
import {
  ArrowRight,
  Building2,
  Crown,
  Eye,
  KeyRound,
  Layers,
  Network,
  PencilLine,
  Power,
  PowerOff,
  RotateCcw,
  ShieldCheck,
  ShieldPlus,
  ShieldX,
  Trash2,
  UserCheck,
  UserCog,
  UserPlus,
  UserX,
  type LucideIcon,
} from "lucide-react";
import type { PermissionChangeRow } from "@/actions/access-control-audit";
import { acPath } from "@/lib/access-control/nav";
import { useClock } from "@/components/time/clock-provider";
import { Ago } from "@/components/ui/ago";
import { SidePane } from "@/components/ui/side-pane";
import { InitialsAvatar, Pill, rowHoverClass, tdClass, thClass } from "@/components/access-control/ui";
import { cn } from "@/lib/utils";
import { answerWord, PERMISSION_CHANGE_KIND_LABEL, PERMISSION_CHANGE_KIND_TONE } from "./kinds";
import { DetailLink, DetailLinks, DetailList, DetailRow, rowOpenButtonClass, selectedRowClass } from "./detail";

const KIND_ICON: Record<PermissionChangeKind, LucideIcon> = {
  GRANT: ShieldCheck,
  REVOKE: ShieldX,
  RESET_TO_DEFAULT: RotateCcw,
  PRESET_APPLIED: Layers,
  ROLE_ASSIGNED: UserCog,
  MANAGER_CHANGED: Network,
  DEPARTMENT_CHANGED: Building2,
  USER_CREATED: UserPlus,
  USER_ACTIVATED: UserCheck,
  USER_DEACTIVATED: UserX,
  TWO_FACTOR_RESET: KeyRound,
  SUPER_ADMIN_GRANTED: Crown,
  SUPER_ADMIN_REVOKED: Crown,
  ROLE_CREATED: ShieldPlus,
  ROLE_RENAMED: PencilLine,
  ROLE_DELETED: Trash2,
  ROLE_DEACTIVATED: PowerOff,
  ROLE_ACTIVATED: Power,
};

/** Who or what the change was made on: a role by its name now (or the key the log kept), or a person. */
function subjectText(r: PermissionChangeRow): string {
  if (r.subjectType === "USER") return r.subjectUser?.name ?? "A removed account";
  if (!r.subjectRole) return "—";
  return `Role · ${r.subjectRoleName ?? `${r.subjectRole} (deleted)`}`;
}

/** Only a change to one key has a before and an after; a role assignment or a preset says its piece in the detail. */
const hasAnswer = (r: PermissionChangeRow) => !!r.permission || r.fromAllowed !== null || r.toAllowed !== null;

function Change({ r }: { r: PermissionChangeRow }) {
  if (!hasAnswer(r)) return <span className="text-subtle">—</span>;
  return (
    <span className="whitespace-nowrap">
      <span className="font-mono text-[11px] text-muted">{answerWord(r.fromAllowed)}</span>
      <ArrowRight className="mx-1 inline h-3.5 w-3.5 align-middle text-subtle" aria-hidden />
      <span className={cn("font-mono text-[11px] font-medium", r.toAllowed === true ? "text-success" : r.toAllowed === false ? "text-danger" : "text-text")}>{answerWord(r.toAllowed)}</span>
    </span>
  );
}

function KindPill({ kind }: { kind: PermissionChangeKind }) {
  const Icon = KIND_ICON[kind] ?? ShieldCheck;
  return (
    <Pill tone={PERMISSION_CHANGE_KIND_TONE[kind] ?? "neutral"} className="h-[22px] text-[11.5px]">
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {PERMISSION_CHANGE_KIND_LABEL[kind] ?? kind}
    </Pill>
  );
}

/**
 * The permission-change log's page of rows, and the entry a row opens.
 *
 * A row is a fact that was written when the change was made (src/lib/authz/audit.ts) — there is nothing to
 * edit and no "revert": undoing a change is made on the role or the person, where the rules about who may
 * are, and writes its own row here.
 */
export function PermissionChangeTable({ rows }: { rows: PermissionChangeRow[] }) {
  const clock = useClock();
  const [openId, setOpenId] = useState<string | null>(null);
  const open = rows.find((r) => r.id === openId) ?? null;

  return (
    <>
      <div className="relative overflow-auto">
        <table className="w-full min-w-[900px] border-collapse">
          <thead>
            <tr>
              {["When", "Who", "Action", "Resource", "Permission", "Change"].map((h) => (
                <th key={h} className={thClass}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} onClick={() => setOpenId(r.id)} className={cn("cursor-pointer", rowHoverClass, openId === r.id && selectedRowClass)}>
                <td className={cn(tdClass, "whitespace-nowrap")}>
                  <button
                    type="button"
                    className={rowOpenButtonClass}
                    aria-label={`Entry details: ${PERMISSION_CHANGE_KIND_LABEL[r.changeKind] ?? r.changeKind}, ${subjectText(r)}, ${clock.dateTimeShort(r.createdAt)}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenId(r.id);
                    }}
                  >
                    <Ago at={r.createdAt} />
                  </button>
                  <div className="text-[11px] text-subtle">{clock.dateTimeShort(r.createdAt)}</div>
                </td>
                <td className={cn(tdClass, "whitespace-nowrap")}>
                  <span className="inline-flex items-center gap-1.5">
                    <InitialsAvatar name={r.actor.name} seed={r.actor.id} size={22} />
                    <span className="font-medium">{r.actor.name}</span>
                    {r.impersonatedByUserId && (
                      <span title={`Made by ${r.impersonatedByName ?? "an admin"} while viewing as ${r.actor.name}`} className="inline-flex text-warning">
                        <Eye className="h-3.5 w-3.5" aria-hidden />
                        <span className="sr-only">while viewing as</span>
                      </span>
                    )}
                  </span>
                </td>
                <td className={cn(tdClass, "whitespace-nowrap")}>
                  <KindPill kind={r.changeKind} />
                </td>
                <td className={cn(tdClass, "max-w-[220px] truncate text-text/80")}>{subjectText(r)}</td>
                <td className={cn(tdClass, "max-w-[320px] text-xs text-text/80")}>
                  {r.permission ? (
                    <>
                      <div className="truncate">{r.permissionLabel ?? r.permission}</div>
                      <div className="truncate font-mono text-[11px] text-subtle">{r.permission}</div>
                    </>
                  ) : (
                    <div className="line-clamp-2">{r.detail ?? <span className="text-subtle">—</span>}</div>
                  )}
                </td>
                <td className={tdClass}>
                  <Change r={r} />
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-8 py-8 text-center text-subtle">
                  No entries match these filters
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <SidePane open={!!open} onClose={() => setOpenId(null)} title="Entry details">
        {open && (
          <>
            <DetailList>
              <DetailRow label="Timestamp">{clock.dateTime(open.createdAt)}</DetailRow>
              <DetailRow label="Changed by">{open.actor.name}</DetailRow>
              {open.impersonatedByUserId && (
                /* Attributed to the real person, not the borrowed account — the reason the column exists. */
                <DetailRow label="While viewing as">
                  <span className="inline-flex items-start gap-1.5 text-warning">
                    <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span>
                      Made by {open.impersonatedByName ?? "an admin"} while viewing as {open.actor.name}.
                    </span>
                  </span>
                </DetailRow>
              )}
              <DetailRow label="Action">
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <KindPill kind={open.changeKind} />
                  <span className="font-mono text-[11px] text-subtle">{open.changeKind}</span>
                </span>
              </DetailRow>
              <DetailRow label="Changed on">{subjectText(open)}</DetailRow>
              <DetailRow label="Permission">{open.permission ? (open.permissionLabel ?? "A permission since retired") : null}</DetailRow>
              <DetailRow label="Key" mono>
                {open.permission}
              </DetailRow>
              <DetailRow label="Previous" mono>
                {hasAnswer(open) ? answerWord(open.fromAllowed) : null}
              </DetailRow>
              <DetailRow label="New" mono>
                {hasAnswer(open) ? <span className={open.toAllowed === true ? "text-success" : open.toAllowed === false ? "text-danger" : undefined}>{answerWord(open.toAllowed)}</span> : null}
              </DetailRow>
              <DetailRow label="Detail">{open.detail}</DetailRow>
              <DetailRow label="Entry ID" mono>
                {open.id}
              </DetailRow>
            </DetailList>
            <DetailLinks>
              {open.subjectType === "USER" && open.subjectUser && (
                <>
                  <DetailLink href={acPath.employee(open.subjectUser.id)}>Open employee</DetailLink>
                  <DetailLink href={acPath.audit({ user: open.subjectUser.id })} onClick={() => setOpenId(null)}>All changes for {open.subjectUser.name}</DetailLink>
                </>
              )}
              {open.subjectType === "ROLE" && open.subjectRole && (
                <>
                  {open.subjectRoleName && <DetailLink href={acPath.modules({ role: open.subjectRole })}>Open role</DetailLink>}
                  <DetailLink href={acPath.audit({ role: open.subjectRole })} onClick={() => setOpenId(null)}>All changes to this role</DetailLink>
                </>
              )}
            </DetailLinks>
          </>
        )}
      </SidePane>
    </>
  );
}
