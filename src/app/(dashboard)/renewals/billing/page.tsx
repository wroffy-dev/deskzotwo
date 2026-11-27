import Link from "next/link";
import { CompanyLink } from "@/components/companies/company-link";
import type { ReactNode } from "react";
import { isModuleEnabled } from "@/actions/module";
import { billingCheck, type BillingCheck } from "@/actions/billing-check";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Card } from "@/components/ui/card";
import { formatCalendarDay } from "@/lib/time/zone";
import { formatOrderId } from "@/lib/order-id";
import { companyPath, orderPath } from "@/lib/record-links";
import { documentPath } from "@/lib/trade-documents";

export const metadata = { title: "Billing check" };

/**
 * Renewals › Billing check (owner, 30 Oct 2026): monthly orders, annual terms paid monthly, quarterly payments on a
 * yearly subscription — each bills itself only if its order says how (recurring billing), so this lists what could
 * slip: running subscriptions nothing bills, ones switched on with a gap the daily job can't pass, and drafts it
 * raised that nobody issued. Within the viewer's reach, as the renewals list is.
 */
export default async function BillingCheckPage() {
  if (!(await isModuleEnabled("renewals"))) return <ModuleDisabledNotice moduleKey="renewals" />;
  const check = await billingCheck();
  if (!check) return <ModuleDisabledNotice moduleKey="renewals" />;
  return <View check={check} />;
}

function View({ check }: { check: BillingCheck }) {
  const waiting = check.waiting;
  const stale = waiting?.filter((d) => d.days >= check.waitingDays).length ?? 0;
  return (
    <div className="animate-fade-rise space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-text">Billing check</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          A subscription bills itself when its order has a billing plan: <strong className="font-medium text-text">the whole term, when it renews</strong> — month to month,
          or a monthly order billed a quarter at a time — or <strong className="font-medium text-text">the term in parts</strong>, monthly, quarterly or half-yearly, for a
          yearly commitment paid as it goes; and, ticked, it <strong className="font-medium text-text">keeps renewing on that plan</strong>. These are the ones that could be
          missed.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Link href="/renewals" className="rounded-full border border-line-strong bg-surface px-3 py-1 text-sm text-muted transition-colors hover:text-text">
          Renewals
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Nothing set to bill" value={check.notSetTotal} note="running, and not billed by itself" />
        <Stat label="Held up" value={check.heldUp.length} note="switched on, but it can't bill" />
        <Stat label="Missed parts" value={check.missed.length} note="a part's day gone by, nothing raised" />
        <Stat label="Drafts waiting" value={waiting ? waiting.length : null} note={waiting ? `${stale} for ${check.waitingDays} days or more` : "needs sight of documents"} />
      </div>

      <Section
        title="Nothing set to bill"
        note="Running subscriptions with recurring billing off: not invoiced in full yet, or a month's term ending soon that is renewed — and billed — by hand each time. Open the order and switch it on, or invoice it."
        empty="Every running subscription is invoiced in full or bills itself."
        rows={check.notSet.map((o) => ({
          key: o.id,
          order: <OrderLink seq={o.orderSeq} />,
          company: <NamedCompany company={o.company} />,
          what: o.item.name,
          term: <Term start={o.startDate} end={o.endDate} />,
          why: o.why === "not-invoiced" ? "Not invoiced in full" : "Month's term — renews by hand",
        }))}
        more={check.notSetTotal > check.notSet.length ? check.notSetTotal - check.notSet.length : 0}
      />

      <Section
        title="Held up"
        note="Switched on, but the daily job will pass these over when they fall due until the gap is filled."
        empty="Nothing switched on is held up."
        rows={check.heldUp.map((o) => ({
          key: o.id,
          order: <OrderLink seq={o.orderSeq} />,
          company: <NamedCompany company={o.company} />,
          what: `${o.item.name} · ${o.mode === "INSTALMENTS" ? "in parts" : "renews itself"}`,
          term: <Term start={o.startDate} end={o.endDate} />,
          why: o.why.charAt(0).toUpperCase() + o.why.slice(1),
        }))}
      />

      <Section
        title="Missed parts"
        note="Billed in parts, with a part whose day has gone by and nothing raised — not even a draft somebody deleted to skip it. The daily job raises what is due each morning, so this is one it couldn't: open the order, and invoice that part by hand or put right what stopped it."
        empty="No part has been missed."
        rows={check.missed.map((o) => ({
          key: o.id,
          order: <OrderLink seq={o.orderSeq} />,
          company: <NamedCompany company={o.company} />,
          what: o.item.name,
          term: <Term start={o.startDate} end={o.endDate} />,
          why: o.parts.map((p) => `Part ${p.index + 1} of ${p.count} (${formatCalendarDay(p.start)})`).join(", "),
        }))}
      />

      {waiting && (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <caption className="px-4 pt-3 text-left">
              <span className="text-xs uppercase tracking-wide text-subtle">Drafts waiting to be issued</span>
              <span className="mt-1 block text-xs text-muted">
                Raised by recurring billing, oldest first. Issue each one, or delete it to skip that period. Whoever issues documents is reminded on Mondays of any waiting{" "}
                {check.waitingDays} days or more.{" "}
                <Link href="/sales/invoices?status=DRAFT&origin=RECURRING_BILLING" className="text-primary hover:underline">
                  Issue them from the invoice list
                </Link>
              </span>
            </caption>
            <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2">Draft</th>
                <th className="px-4 py-2">Order</th>
                <th className="px-4 py-2">Company</th>
                <th className="px-4 py-2">Raised</th>
              </tr>
            </thead>
            <tbody>
              {waiting.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-subtle">
                    No drafts waiting.
                  </td>
                </tr>
              ) : (
                waiting.map((d) => (
                  <tr key={d.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-2">
                      <Link href={documentPath(d.id)} className="text-primary hover:underline">
                        Open draft
                      </Link>
                    </td>
                    <td className="px-4 py-2">{d.orderSeq ? <OrderLink seq={d.orderSeq} /> : "—"}</td>
                    <td className="px-4 py-2 text-text">{d.company}</td>
                    <td className={`whitespace-nowrap px-4 py-2 ${d.days >= check.waitingDays ? "text-warning" : "text-muted"}`}>
                      {d.days === 0 ? "today" : `${d.days} day${d.days === 1 ? "" : "s"} ago`}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

type Row = { key: string; order: ReactNode; company: ReactNode; what: string; term: ReactNode; why: string };

function Section({ title, note, empty, rows, more = 0 }: { title: string; note: string; empty: string; rows: Row[]; more?: number }) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[44rem] text-sm">
        <caption className="px-4 pt-3 text-left">
          <span className="text-xs uppercase tracking-wide text-subtle">{title}</span>
          <span className="mt-1 block text-xs text-muted">{note}</span>
        </caption>
        <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="px-4 py-2">Order</th>
            <th className="px-4 py-2">Company</th>
            <th className="px-4 py-2">Subscription</th>
            <th className="px-4 py-2">Term</th>
            <th className="px-4 py-2">Why</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-4 py-6 text-center text-subtle">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.key} className="border-b border-line last:border-0">
                <td className="whitespace-nowrap px-4 py-2">{r.order}</td>
                <td className="px-4 py-2">{r.company}</td>
                <td className="px-4 py-2 text-muted">{r.what}</td>
                <td className="whitespace-nowrap px-4 py-2 text-muted">{r.term}</td>
                <td className="px-4 py-2 text-warning">{r.why}</td>
              </tr>
            ))
          )}
          {more > 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-2 text-xs text-subtle">
                …and {more} more, soonest-ending shown first.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Card>
  );
}

function Stat({ label, value, note }: { label: string; value: number | null; note: string }) {
  const warn = !!value;
  return (
    <Card className={`px-4 py-3 ${warn ? "border-warning/40" : ""}`}>
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${warn ? "text-warning" : "text-text"}`}>{value ?? "—"}</div>
      <div className="mt-0.5 text-xs text-muted">{note}</div>
    </Card>
  );
}

const OrderLink = ({ seq }: { seq: number }) => (
  <Link href={orderPath(seq)} className="text-primary hover:underline">
    {formatOrderId(seq)}
  </Link>
);

const NamedCompany = ({ company }: { company: { companySeq: number; name: string } }) => (
  <CompanyLink href={companyPath(company.companySeq)} className="text-text hover:underline">
    {company.name}
  </CompanyLink>
);

const Term = ({ start, end }: { start: Date | string | null; end: Date | string | null }) => (
  <>
    {formatCalendarDay(start)} – {formatCalendarDay(end)}
  </>
);
