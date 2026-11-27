import Link from "next/link";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { guestActivityReport } from "@/actions/connect";
import { Badge, Card } from "@/components/ui/card";
import { GuestAllowanceLine } from "@/components/connect/guest-allowance";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * What guests are doing (owner, 20 Nov 2026 — Deskzo Connect phase 4): over the last 7, 30 or 90 days, each guest's
 * sign-ins, the cells they changed, their comments and suggestions (and how many were added), and the same for each
 * shared list. For whoever manages guests.
 */
export default async function GuestActivityPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  if (!(await isModuleEnabled("workspace"))) return <ModuleDisabledNotice moduleKey="workspace" />;
  const { days } = await searchParams;
  const report = await guestActivityReport(Number(days) || 30);
  if (!report) notFound();
  const clock = await workspaceClock();
  const num = (n: number) => (n ? n.toLocaleString("en-IN") : <span className="text-subtle">—</span>);
  const th = "px-3 py-2 text-left text-xs font-medium text-muted";
  const td = "px-3 py-2 text-sm";

  return (
    <div className="animate-fade-rise space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/smart-lists/guests" className="text-sm text-muted hover:text-text">
            ← Guests
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-text">Guest activity</h1>
          <p className="mt-1 text-sm text-muted">What the people you share lists with have done — last {report.days} days.</p>
        </div>
        <nav aria-label="Period" className="flex gap-1">
          {[7, 30, 90].map((d) => (
            <Link
              key={d}
              href={`/smart-lists/guests/activity?days=${d}`}
              aria-current={report.days === d ? "page" : undefined}
              className={report.days === d ? "rounded-base bg-brand-subtle px-3 py-1.5 text-sm font-medium text-brand" : "rounded-base px-3 py-1.5 text-sm text-muted hover:bg-surface-sunken"}
            >
              {d} days
            </Link>
          ))}
        </nav>
      </div>

      <GuestAllowanceLine allowance={report.allowance} />

      <Card className="overflow-x-auto p-0">
        <h2 className="border-b border-line px-4 py-3 text-sm font-semibold text-text">By guest</h2>
        <table className="w-full min-w-[720px] border-collapse">
          <thead className="border-b border-line bg-surface-sunken">
            <tr>
              <th className={th}>Guest</th>
              <th className={th}>Last signed in</th>
              <th className={`${th} text-right`}>Sign-ins</th>
              <th className={`${th} text-right`}>Cells changed</th>
              <th className={`${th} text-right`}>Comments</th>
              <th className={`${th} text-right`}>Suggested</th>
              <th className={`${th} text-right`}>Added</th>
              <th className={th}>Lists</th>
            </tr>
          </thead>
          <tbody>
            {report.guests.map((g) => (
              <tr key={g.id} className="border-b border-line last:border-0">
                <td className={td}>
                  <div className="font-medium text-text">
                    {g.name} {g.status === "SUSPENDED" && <Badge tone="red">Stopped</Badge>}
                    {g.status === "INVITED" && <Badge tone="amber">Invited</Badge>}
                  </div>
                  <div className="text-xs text-muted">
                    {g.connection} · {g.email}
                  </div>
                </td>
                <td className={`${td} text-muted`}>{g.lastSignInAt ? clock.date(g.lastSignInAt) : "Never"}</td>
                <td className={`${td} text-right tabular-nums`}>{num(g.signIns)}</td>
                <td className={`${td} text-right tabular-nums`}>{num(g.edits)}</td>
                <td className={`${td} text-right tabular-nums`}>{num(g.comments)}</td>
                <td className={`${td} text-right tabular-nums`}>{num(g.suggested)}</td>
                <td className={`${td} text-right tabular-nums`}>{num(g.added)}</td>
                <td className={`${td} text-xs text-muted`}>{g.lists.join(", ") || "—"}</td>
              </tr>
            ))}
            {report.guests.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-sm text-subtle">
                  No guests yet. Share a Smart List to invite one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <Card className="overflow-x-auto p-0">
        <h2 className="border-b border-line px-4 py-3 text-sm font-semibold text-text">By list</h2>
        <table className="w-full min-w-[560px] border-collapse">
          <thead className="border-b border-line bg-surface-sunken">
            <tr>
              <th className={th}>List</th>
              <th className={`${th} text-right`}>Guests</th>
              <th className={`${th} text-right`}>Cells changed</th>
              <th className={`${th} text-right`}>Comments</th>
              <th className={`${th} text-right`}>Suggestions</th>
            </tr>
          </thead>
          <tbody>
            {report.lists.map((l) => (
              <tr key={l.id} className="border-b border-line last:border-0">
                <td className={td}>
                  <Link href={`/smart-lists/${l.id}`} className="font-medium text-text hover:underline">
                    {l.name}
                  </Link>
                </td>
                <td className={`${td} text-right tabular-nums`}>{num(l.guests)}</td>
                <td className={`${td} text-right tabular-nums`}>{num(l.edits)}</td>
                <td className={`${td} text-right tabular-nums`}>{num(l.comments)}</td>
                <td className={`${td} text-right tabular-nums`}>{num(l.suggested)}</td>
              </tr>
            ))}
            {report.lists.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-sm text-subtle">
                  No list is shared yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
