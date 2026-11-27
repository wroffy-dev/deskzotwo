import Link from "next/link";
import type { ReactNode } from "react";
import { BadgeCheck, CalendarDays, CheckSquare, ChevronRight, Flame, Mail, Plane, Plus, Wallet } from "lucide-react";
import type { todayFor } from "@/lib/app/daily";
import type { HotLead } from "@/lib/research/auto-plan";
import type { WaitingEmail } from "@/lib/nurture/server";
import { Card } from "@/components/ui/card";
import { TeamTodayCard, type TeamTodayData } from "@/components/ai/team-today";
import { WaitingForYouCard } from "@/components/ai/waiting-for-you";
import type { WaitingForYou } from "@/lib/ai/waiting";
import { CHASE_ACTION_LABELS, type ChaseAction } from "@/lib/collections/chase";
import { SupportTodayCard, type SupportRow } from "@/components/today/support-card";

/** Arjun's part of Today (src/lib/collections/chase-server.ts): who to chase, his drafts waiting, replies he read. */
export type TodayChases = { items: { id: string; companyName: string; action: ChaseAction; reasons: string }[]; drafts: number; replies: number };

export type TodayData = Awaited<ReturnType<typeof todayFor>>;

/** Each kind of approval, in words, and the page where it's decided (src/lib/app/daily.ts approvalsFor). */
const APPROVAL_WORDS: Record<string, { one: string; many: string; href: string }> = {
  leave: { one: "leave request", many: "leave requests", href: "/people/leave" },
  correction: { one: "attendance correction", many: "attendance corrections", href: "/people/me" },
  expense: { one: "expense claim", many: "expense claims", href: "/expenses?view=approve" },
  workflow: { one: "workflow step", many: "workflow steps", href: "/approvals" },
  order: { one: "order to approve", many: "orders to approve", href: "/orders?status=PENDING_APPROVAL" },
  device: { one: "new device", many: "new devices", href: "/settings/security/access?tab=devices" },
  "attendance-exception": { one: "attendance exception", many: "attendance exceptions", href: "/people/attendance/exceptions" },
};

/**
 * The Today screen's look (src/app/(dashboard)/today/page.tsx), on what the page read — apart from it so the check
 * suite can draw it on sample data (scripts/check-pwa.ts).
 */
export function TodayView({
  today,
  greeting,
  zone,
  approvals,
  newLead,
  hotLeads = [],
  toCheck = [],
  teamDone = {},
  kabir = null,
  chases = null,
  waiting = null,
  support = null,
}: {
  today: TodayData;
  greeting: string;
  zone: string;
  approvals: boolean;
  newLead: boolean;
  /** Their own leads Deskzo AI read as hot or warm (src/lib/research/auto-plan.ts), hot first. */
  hotLeads?: HotLead[];
  /** Nurture emails Deskzo AI wrote, waiting for them to check and send (src/lib/nurture). */
  toCheck?: WaitingEmail[];
  /** Jobs each AI teammate finished for them today (src/lib/ai/teammate-work.ts). */
  teamDone?: TeamTodayData["done"];
  /** Kabir's day in the Customer inbox, where it is theirs to see (src/lib/ai/kabir-live.ts). */
  kabir?: TeamTodayData["kabir"];
  /** Payments to chase, for somebody who follows them up. */
  chases?: TodayChases | null;
  /** Everything the AI team left for them to decide, across teammates (src/lib/ai/waiting.ts) — it holds the emails to check too. */
  waiting?: WaitingForYou | null;
  /** Customers' tickets and colleagues' help desk requests with them (src/lib/desks/today.ts). */
  support?: { rows: SupportRow[]; more: number } | null;
}) {
  const longDay = new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${today.date}T00:00:00Z`));
  const time = (at: string | null) => (at ? new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: zone }).format(new Date(at)) : null);
  const dayWords = (key: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${key}T00:00:00Z`));
  const a = today.attendance;

  // One column on a phone; two from md, so a tablet's width holds the cards side by side rather than a strip down
  // the middle (owner, 31 Oct 2026).
  return (
    <div className="mx-auto grid max-w-xl items-start gap-4 md:max-w-4xl md:grid-cols-2">
      <div className="md:col-span-2">
        <h1 className="text-xl font-semibold text-text">{greeting}</h1>
        <p className="text-sm text-muted">{longDay}</p>
      </div>

      {a && (
        <Tile href="/people/attendance" icon={<CalendarDays className="h-5 w-5" />} title="Attendance">
          {a.check_in_at ? (
            <>
              In at {time(a.check_in_at)}
              {a.check_out_at ? ` · out at ${time(a.check_out_at)}` : " · still in"}
              {a.worked_minutes ? ` · ${Math.floor(a.worked_minutes / 60)} h ${a.worked_minutes % 60} min` : ""}
            </>
          ) : (
            <span className="text-warning">Not clocked in yet — tap to clock in</span>
          )}
        </Tile>
      )}

      {approvals &&
        (today.approvals_waiting === 0 ? (
          <Tile href="/approvals" icon={<BadgeCheck className="h-5 w-5" />} title="Approvals">
            Nothing waiting for you
          </Tile>
        ) : (
          // Each queue by name, to the page that decides it — the web's Approvals page holds only workflow steps.
          <Card className="p-4">
            <div className="flex items-center gap-3">
              <span className="text-muted">
                <BadgeCheck className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-text">Approvals</span>
                <span className="block text-xs text-muted">
                  {today.approvals_waiting}
                  {today.approvals_more ? "+" : ""} waiting for you
                </span>
              </span>
              <span className="rounded-full bg-danger px-2 py-0.5 text-xs font-semibold text-white">
                {today.approvals_waiting}
                {today.approvals_more ? "+" : ""}
              </span>
            </div>
            <ul className="mt-2 divide-y divide-line">
              {Object.entries(today.approvals_by_kind).map(([kind, n]) => {
                const w = APPROVAL_WORDS[kind];
                if (!w || !n) return null;
                return (
                  <li key={kind}>
                    <Link href={w.href} className="flex items-center justify-between gap-2 py-2 text-sm text-text">
                      <span>
                        {n}
                        {n >= 50 && (kind === "expense" || kind === "order" || kind === "device") ? "+" : ""} {n === 1 ? w.one : w.many}
                      </span>
                      <ChevronRight className="h-4 w-4 text-subtle" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Card>
        ))}

      {/* What the AI team left for them to decide, one list across teammates (owner, 20 Nov 2026). */}
      {waiting && <WaitingForYouCard waiting={waiting} className="md:col-span-2" />}

      {/* Their AI team today: who is waiting on them, and what each finished (owner, 19 Nov 2026). */}
      <TeamTodayCard
        team={{ done: teamDone, draftsWaiting: toCheck.length, leadsToWork: hotLeads.length, kabir, arjun: chases ? { toChase: chases.items.length, drafts: chases.drafts, replies: chases.replies } : null }}
      />

      {chases && chases.items.length + chases.drafts + chases.replies > 0 && (
        // Payments to chase (owner, 19 Nov 2026): Arjun's picks, ranked from the books, and what waits for them.
        <Card id="payments-to-chase" className="scroll-mt-20 p-4">
          <Link href="/collections" className="flex items-center gap-3">
            <span className="text-brand">
              <Wallet className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-text">Payments to chase</span>
              <span className="block text-xs text-muted">
                {[chases.replies > 0 ? `${chases.replies} ${chases.replies === 1 ? "reply" : "replies"} to act on` : null, chases.drafts > 0 ? `${chases.drafts} ${chases.drafts === 1 ? "draft" : "drafts"} to check` : null]
                  .filter(Boolean)
                  .join(" · ") || "Who to chase first, as Arjun ranks them"}
              </span>
            </span>
            <ChevronRight className="h-4 w-4 text-subtle" />
          </Link>
          {chases.items.length > 0 && (
            <ul className="mt-3 divide-y divide-line border-t border-line">
              {chases.items.map((c) => (
                <li key={c.id}>
                  <Link href="/collections" className="flex items-start gap-2 py-2.5">
                    <span
                      className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${c.action === "CALL" ? "bg-danger-bg text-danger" : c.action === "CHECK" ? "bg-warning-bg text-warning" : "bg-brand-subtle text-brand"}`}
                    >
                      {CHASE_ACTION_LABELS[c.action]}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-text">{c.companyName}</span>
                      <span className="block text-xs text-subtle">{c.reasons}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {!waiting && toCheck.length > 0 && (
        // Emails to check (owner, 18 Nov 2026 — phase 3): each goes from their mailbox only once they send it.
        <Card id="emails-to-check" className="scroll-mt-20 p-4">
          <div className="flex items-center gap-3">
            <span className="text-brand">
              <Mail className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-text">Emails to check</span>
              <span className="block text-xs text-muted">Deskzo AI&apos;s follow-ups, waiting for you to send</span>
            </span>
            <span className="rounded-full bg-brand px-2 py-0.5 text-xs font-semibold text-white">{toCheck.length}</span>
          </div>
          <ul className="mt-3 divide-y divide-line border-t border-line">
            {toCheck.map((m) => (
              <li key={m.touchId}>
                <Link href={m.href} className="block py-2.5">
                  <span className="block text-sm text-text">{m.subject}</span>
                  <span className="block text-xs text-subtle">
                    Email {m.step + 1} · {m.company} · {m.leadTitle}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {hotLeads.length > 0 && (
        // Leads to work first (owner, 18 Nov 2026): Deskzo AI's hot and warm reads of their own open leads.
        <Card id="leads-to-work" className="scroll-mt-20 p-4">
          <Link href="/leads" className="flex items-center gap-3">
            <span className="text-danger">
              <Flame className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-text">Leads to work first</span>
              <span className="block text-xs text-muted">Hot and warm, as Deskzo AI reads them</span>
            </span>
            <ChevronRight className="h-4 w-4 text-subtle" />
          </Link>
          <ul className="mt-3 divide-y divide-line border-t border-line">
            {hotLeads.map((l) => (
              <li key={l.id}>
                <Link href={l.href} className="flex items-start gap-2 py-2.5">
                  <span
                    className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${l.fit === "HOT" ? "bg-danger-bg text-danger" : "bg-warning-bg text-warning"}`}
                  >
                    {l.fit === "HOT" ? "Hot" : "Warm"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-text">{l.title}</span>
                    <span className="block text-xs text-subtle">
                      {l.company}
                      {l.nextStep ? ` · next: ${l.nextStep}` : ""}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {support && <SupportTodayCard rows={support.rows} more={support.more} />}

      {today.tasks && (
        <Card className="p-4">
          <Link href="/tasks" className="flex items-center gap-3">
            <span className="text-muted">
              <CheckSquare className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-text">My tasks</span>
              <span className="block text-xs text-muted">
                {today.tasks.open} open
                {today.tasks.overdue ? <span className="text-danger"> · {today.tasks.overdue} overdue</span> : null}
              </span>
            </span>
            <ChevronRight className="h-4 w-4 text-subtle" />
          </Link>
          {today.tasks.due_today.length > 0 ? (
            <ul className="mt-3 divide-y divide-line border-t border-line">
              {today.tasks.due_today.map((t) => (
                <li key={t.id}>
                  <Link href={`/tasks?task=${t.id}`} className="block py-2.5">
                    <span className="block text-sm text-text">{t.title}</span>
                    {t.company && <span className="block text-xs text-subtle">{t.company}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-subtle">Nothing due today.</p>
          )}
        </Card>
      )}

      {today.leave && (
        <Card className="p-4">
          <Link href="/people/leave" className="flex items-center gap-3">
            <span className="text-muted">
              <Plane className="h-5 w-5" />
            </span>
            <span className="flex-1 text-sm font-medium text-text">Leave</span>
            <span className="text-xs font-medium text-primary">Apply for leave</span>
          </Link>
          {today.leave.balances.length > 0 && (
            <div className="mt-3 grid grid-cols-3 gap-2 md:grid-cols-2 xl:grid-cols-3">
              {today.leave.balances.slice(0, 6).map((b) => (
                <div key={b.type_id} className="rounded-base bg-surface-sunken px-2 py-2 text-center">
                  <div className="text-base font-semibold tabular-nums text-text">{b.available}</div>
                  <div className="truncate text-xs text-muted">{b.name}</div>
                </div>
              ))}
            </div>
          )}
          {today.leave.upcoming.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-muted">
              {today.leave.upcoming.map((l) => (
                <li key={l.id}>
                  {l.type}: {dayWords(l.from)}
                  {l.to !== l.from ? ` – ${dayWords(l.to)}` : ""}
                  {l.status === "PENDING" ? " · waiting for approval" : ""}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {newLead && (
        <Link
          href="/leads/new"
          className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong bg-surface py-3 text-sm font-medium text-text hover:bg-surface-sunken md:col-span-2"
        >
          <Plus className="h-4 w-4" />
          New lead
        </Link>
      )}
    </div>
  );
}

function Tile({ href, icon, title, count, children }: { href: string; icon: ReactNode; title: string; count?: number; children: ReactNode }) {
  return (
    <Card className="p-4">
      <Link href={href} className="flex items-center gap-3">
        <span className="text-muted">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-text">{title}</span>
          <span className="block text-xs text-muted">{children}</span>
        </span>
        {count ? <span className="rounded-full bg-danger px-2 py-0.5 text-xs font-semibold text-white">{count}</span> : null}
        <ChevronRight className="h-4 w-4 text-subtle" />
      </Link>
    </Card>
  );
}
