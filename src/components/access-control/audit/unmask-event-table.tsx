"use client";

import { useState } from "react";
import { CompanyLink } from "@/components/companies/company-link";
import { Eye } from "lucide-react";
import type { UnmaskLogRow } from "@/actions/unmask-log";
import { acPath } from "@/lib/access-control/nav";
import { SENSITIVE_FIELDS } from "@/lib/authz/field-policy";
import { companyPath, leadPath } from "@/lib/record-links";
import { useClock } from "@/components/time/clock-provider";
import { Ago } from "@/components/ui/ago";
import { SidePane } from "@/components/ui/side-pane";
import { InitialsAvatar, rowHoverClass, tdClass, thClass } from "@/components/access-control/ui";
import { cn } from "@/lib/utils";
import { DetailLink, DetailLinks, DetailList, DetailRow, rowOpenButtonClass, selectedRowClass } from "./detail";

/** The four ways an attempt ends, in the words the unmasking log has always used. */
const RESULT: Record<UnmaskLogRow["result"], { label: string; text: string; dot: string }> = {
  ALLOWED: { label: "Unmasked", text: "text-success", dot: "bg-success" },
  REPEAT: { label: "Opened again", text: "text-muted", dot: "bg-subtle" },
  QUOTA_EXHAUSTED: { label: "Limit reached", text: "text-warning", dot: "bg-warning" },
  DENIED: { label: "Refused", text: "text-danger", dot: "bg-danger" },
};

const MODULE: Record<string, string> = { leads: "Leads", contacts: "Contacts", companies: "Companies" };
const moduleLabel = (entity: string) => MODULE[entity] ?? entity;

const FIELD_LABELS = new Map(SENSITIVE_FIELDS.map((f) => [`${f.entity}:${f.key}`, f.label]));
const fieldLabel = (entity: string, key: string) => FIELD_LABELS.get(`${entity}:${key}`) ?? (key.startsWith("custom:") ? key.slice("custom:".length) : key);
const fieldsText = (r: UnmaskLogRow) => r.fields.map((f) => fieldLabel(r.entity, f)).join(", ");

/** Where the record lives now, if it still does: a lead's page, or a contact's company. */
function recordHref(r: UnmaskLogRow): string | null {
  if (r.entity === "leads" && r.lead) return leadPath(r.lead.leadSeq);
  if (r.entity === "contacts" && r.contact) return `${companyPath(r.contact.companySeq)}?tab=contacts`;
  return null;
}

/** The record by its name as it is now — looked up for the reader, never stored in the log. */
function recordName(r: UnmaskLogRow): { name: string; gone: boolean } {
  if (r.entity === "leads") return r.lead ? { name: r.lead.title, gone: false } : { name: "Lead removed", gone: true };
  if (r.entity === "contacts") return r.contact ? { name: r.contact.name, gone: false } : { name: "Contact removed", gone: true };
  return { name: r.leadRef ?? r.recordId, gone: false };
}

function RecordCell({ r }: { r: UnmaskLogRow }) {
  const href = recordHref(r);
  const { name, gone } = recordName(r);
  return (
    <>
      {href ? (
        <CompanyLink href={href} onClick={(e) => e.stopPropagation()} className="text-text hover:text-brand hover:underline">
          {name}
        </CompanyLink>
      ) : (
        <span className={gone ? "text-subtle" : "text-text"}>{name}</span>
      )}
      {r.entity !== "companies" && <span className="block font-mono text-[11px] text-subtle">{r.leadRef ?? "—"}</span>}
    </>
  );
}

function ResultTag({ result }: { result: UnmaskLogRow["result"] }) {
  const meta = RESULT[result];
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap text-xs font-semibold", meta.text)}>
      <span className={cn("h-[7px] w-[7px] rounded-full", meta.dot)} aria-hidden />
      {meta.label}
    </span>
  );
}

/** What is left of the day's limit after this attempt; null when the row carries no count (a refusal) or there is no limit. */
function remainingOf(r: UnmaskLogRow): number | null {
  return r.usedToday === null || r.dailyLimit === null ? null : Math.max(0, r.dailyLimit - r.usedToday);
}

/**
 * The unmasking log's page of rows — every press of Show on a masked lead, contact or company — and the
 * entry a row opens.
 *
 * The log holds which fields, never what they held, so nothing here can show a value. A "unit" is one
 * record against the person's daily limit: the first unmask of a record in a day uses one, opening it again
 * that day does not, and a refusal uses none.
 */
export function UnmaskEventTable({ rows }: { rows: UnmaskLogRow[] }) {
  const clock = useClock();
  const [openId, setOpenId] = useState<string | null>(null);
  const open = rows.find((r) => r.id === openId) ?? null;
  const openHref = open ? recordHref(open) : null;
  const openRemaining = open ? remainingOf(open) : null;

  return (
    <>
      <div className="relative overflow-auto">
        <table className="w-full min-w-[1180px] border-collapse">
          <thead>
            <tr>
              {["Timestamp", "Employee", "Module", "Record", "Field(s)", "Result", "Units used", "Remaining", "Reason", "IP address"].map((h) => (
                <th key={h} className={thClass}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const remaining = remainingOf(r);
              return (
                <tr key={r.id} onClick={() => setOpenId(r.id)} className={cn("cursor-pointer", rowHoverClass, openId === r.id && selectedRowClass)}>
                  <td className={cn(tdClass, "whitespace-nowrap")}>
                    <button
                      type="button"
                      className={rowOpenButtonClass}
                      aria-label={`Entry details: ${r.userName}, ${RESULT[r.result].label}, ${clock.dateTimeShort(r.at)}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenId(r.id);
                      }}
                    >
                      <Ago at={r.at} />
                    </button>
                    <div className="text-[11px] text-subtle">{clock.dateTimeShort(r.at)}</div>
                  </td>
                  <td className={cn(tdClass, "whitespace-nowrap")}>
                    <span className="inline-flex items-center gap-1.5">
                      <InitialsAvatar name={r.userName} seed={r.userId} size={22} />
                      <span className="font-medium">{r.userName}</span>
                      {r.impersonatedBy && (
                        <span title={`Viewed as by ${r.impersonatedBy}`} className="inline-flex text-warning">
                          <Eye className="h-3.5 w-3.5" aria-hidden />
                          <span className="sr-only">viewed as by {r.impersonatedBy}</span>
                        </span>
                      )}
                    </span>
                  </td>
                  <td className={cn(tdClass, "whitespace-nowrap text-text/80")}>{moduleLabel(r.entity)}</td>
                  <td className={cn(tdClass, "max-w-[220px]")}>
                    <RecordCell r={r} />
                  </td>
                  <td className={cn(tdClass, "max-w-[220px] text-xs text-text/80")}>{fieldsText(r) || <span className="text-subtle">—</span>}</td>
                  <td className={tdClass}>
                    <ResultTag result={r.result} />
                  </td>
                  <td className={cn(tdClass, "whitespace-nowrap text-xs font-bold", r.consumed ? "text-warning" : "text-subtle")}>{r.consumed ? "1" : "0"}</td>
                  <td className={cn(tdClass, "whitespace-nowrap text-xs")}>
                    {r.usedToday === null ? (
                      <span className="text-subtle">—</span>
                    ) : remaining === null ? (
                      <>
                        <span className="text-text/80">No limit</span>
                        <span className="block font-mono text-[11px] text-muted">{r.usedToday} today</span>
                      </>
                    ) : (
                      <>
                        <span className={cn("font-semibold", remaining === 0 ? "text-danger" : "text-text/80")}>{remaining} left</span>
                        <span className="block font-mono text-[11px] text-muted">
                          {r.usedToday} / {r.dailyLimit} used
                        </span>
                      </>
                    )}
                  </td>
                  <td className={cn(tdClass, "max-w-[240px] text-xs")}>
                    {r.statedReason && <div className="line-clamp-2 text-text/80">{r.statedReason}</div>}
                    {r.reason && <div className="line-clamp-2 text-[11px] text-subtle">{r.reason}</div>}
                    {!r.statedReason && !r.reason && <span className="text-subtle">—</span>}
                  </td>
                  <td className={cn(tdClass, "whitespace-nowrap font-mono text-[11px] text-muted")}>{r.ip ?? "—"}</td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={10} className="px-8 py-8 text-center text-subtle">
                  No unmasking attempts match these filters
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
              <DetailRow label="Timestamp">{clock.dateTime(open.at)}</DetailRow>
              <DetailRow label="Business day" mono>
                {open.businessDate}
              </DetailRow>
              <DetailRow label="Employee">{open.userName}</DetailRow>
              {open.impersonatedBy && (
                <DetailRow label="While viewing as">
                  <span className="inline-flex items-start gap-1.5 text-warning">
                    <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span>
                      {open.impersonatedBy} was viewing as {open.userName}.
                    </span>
                  </span>
                </DetailRow>
              )}
              <DetailRow label="Module">{moduleLabel(open.entity)}</DetailRow>
              <DetailRow label="Record">
                <span className={recordName(open).gone ? "text-subtle" : undefined}>{recordName(open).name}</span>
              </DetailRow>
              <DetailRow label="Record ref" mono>
                {open.leadRef}
              </DetailRow>
              <DetailRow label="Record ID" mono>
                {open.recordId}
              </DetailRow>
              <DetailRow label="Field(s)">{fieldsText(open)}</DetailRow>
              <DetailRow label="Revealed value">
                <span className="text-muted">Never stored — the log keeps which fields, not what they held.</span>
              </DetailRow>
              <DetailRow label="Result">
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <ResultTag result={open.result} />
                  <span className="font-mono text-[11px] text-subtle">{open.result}</span>
                </span>
              </DetailRow>
              <DetailRow label="Unit used">{open.consumed ? "Yes — 1 of the day's limit" : "No"}</DetailRow>
              <DetailRow label="Used today" mono>
                {open.usedToday === null ? null : open.dailyLimit === null ? `${open.usedToday} · no daily limit` : `${open.usedToday} / ${open.dailyLimit}`}
              </DetailRow>
              <DetailRow label="Remaining" mono>
                {openRemaining === null ? null : String(openRemaining)}
              </DetailRow>
              <DetailRow label="Reason given">{open.statedReason}</DetailRow>
              <DetailRow label="System note">{open.reason}</DetailRow>
              <DetailRow label="IP address" mono>
                {open.ip}
              </DetailRow>
              <DetailRow label="Device">{open.userAgent}</DetailRow>
              <DetailRow label="Request ID" mono>
                {open.requestId}
              </DetailRow>
              <DetailRow label="Workspace" mono>
                {open.tenantId}
              </DetailRow>
              <DetailRow label="Chain position" mono>
                {`#${open.seq}`}
              </DetailRow>
              <DetailRow label="Entry ID" mono>
                {open.id}
              </DetailRow>
            </DetailList>
            <p className="mt-3 text-[11.5px] leading-[1.5] text-subtle">Each row is chained to the one before it. The row&apos;s hash and the previous row&apos;s are in the CSV export, so the file can be checked against itself.</p>
            <DetailLinks>
              <DetailLink href={acPath.employee(open.userId)}>Open employee</DetailLink>
              {openHref && <DetailLink href={openHref}>Open record</DetailLink>}
              <DetailLink href={acPath.audit({ category: "pii", user: open.userId })} onClick={() => setOpenId(null)}>
                All unmasking by {open.userName}
              </DetailLink>
            </DetailLinks>
          </>
        )}
      </SidePane>
    </>
  );
}
