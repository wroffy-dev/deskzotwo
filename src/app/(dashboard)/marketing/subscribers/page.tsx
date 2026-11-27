import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { viewerHas } from "@/actions/permission";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Badge, Card } from "@/components/ui/card";
import { ListHeader } from "@/components/ui/list-header";
import { ToolbarSearch } from "@/components/ui/filter-toolbar";
import { Pagination } from "@/components/ui/pagination";
import { UnsubscribeButton } from "@/components/marketing/unsubscribe-button";
import { SUBSCRIBER_PAGE, subscribersPage } from "@/lib/marketing/subscribers";
import { TOPICS } from "@/lib/marketing/topics";
import { resolvePage, totalPages } from "@/lib/pagination";
import { workspaceClock } from "@/lib/time/workspace";
import { requireUser } from "@/lib/session";

export const metadata = { title: "Subscribers" };

const STATUS: Record<string, { label: string; tone: "green" | "amber" | "red" | "default" }> = {
  VALID: { label: "Works", tone: "green" },
  RISKY: { label: "Works · shared or free-mail", tone: "green" },
  INVALID: { label: "Doesn't work", tone: "red" },
  UNKNOWN: { label: "Couldn't be checked", tone: "amber" },
  UNCHECKED: { label: "Not checked yet", tone: "default" },
};
const SUPPRESSED: Record<string, string> = { UNSUBSCRIBED: "Unsubscribed", HARD_BOUNCE: "Bounced", COMPLAINT: "Marked us as spam", MANUAL: "Suppressed by hand", INVALID: "Address doesn't work" };

/**
 * Marketing › Subscribers (owner, 1 Nov 2026 — src/lib/marketing/subscribers.ts): everybody on a mailing list or with an
 * email consent, with what they agreed to, the lists they came on, whether their address works, and whether they're
 * suppressed — and, for whoever runs marketing, an unsubscribe for somebody who asked. For a workspace on Deskzo
 * Campaigns alone, the one place its people show.
 */
export default async function SubscribersPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  if (!(await isModuleEnabled("marketing"))) return <ModuleDisabledNotice moduleKey="marketing" />;
  const [manage, viewAll] = await Promise.all([viewerHas("marketing.manage"), viewerHas("marketing.viewAll")]);
  if (!manage && !viewAll) notFound();
  const params = await searchParams;
  const page = resolvePage(params.page);
  // Each name and address as the viewer's contacts policy shows them (owner, 5 Nov 2026 — Phase 3 masking fixes).
  const viewer = await requireUser();
  const [{ rows, total }, clock] = await Promise.all([subscribersPage(params.q, page, viewer.id), workspaceClock()]);
  const topic = (t: string) => TOPICS.find((x) => x.key === t)?.label ?? t;

  return (
    <div className="space-y-4">
      <ListHeader title="Subscribers" subtitle={`${total.toLocaleString("en-IN")} ${total === 1 ? "person" : "people"}`} search={<ToolbarSearch paramName="q" placeholder="Search" label="Name, email or company" />} />
      <p className="max-w-3xl text-sm text-muted">Everybody on a mailing list or who has agreed to hear from you by email: what they agreed to, where they came from, and whether mail reaches them.</p>
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Person</th>
              <th className="px-4 py-2.5">Address</th>
              <th className="px-4 py-2.5">Agreed to</th>
              <th className="px-4 py-2.5">Lists</th>
              <th className="px-4 py-2.5">Added</th>
              {manage && <th className="px-4 py-2.5" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const status = STATUS[r.emailStatus] ?? STATUS.UNCHECKED!;
              return (
                <tr key={r.id} className="border-b border-line last:border-0 align-top">
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-text">{r.name}</div>
                    <div className="text-xs text-muted">{r.email}</div>
                    <div className="text-xs text-subtle">{r.company}</div>
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone={r.suppressed ? "red" : status.tone}>{r.suppressed ? (SUPPRESSED[r.suppressed] ?? "Suppressed") : status.label}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted">
                    {r.subscribed.length ? r.subscribed.map(topic).join(", ") : <span className="text-subtle">Nothing</span>}
                    {r.unsubscribed.length > 0 && <div className="text-subtle">Opted out of {r.unsubscribed.map(topic).join(", ")}</div>}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted">{r.lists.length ? r.lists.join(", ") : <span className="text-subtle">—</span>}</td>
                  <td className="px-4 py-2.5 text-xs text-muted">{clock.date(r.addedAt)}</td>
                  {manage && <td className="px-4 py-2.5 text-right">{r.suppressed !== "UNSUBSCRIBED" && r.subscribed.length > 0 && <UnsubscribeButton contactId={r.id} name={r.name} />}</td>}
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={manage ? 6 : 5} className="px-4 py-8 text-center text-subtle">
                  {params.q ? "Nobody matches." : "No subscribers yet — upload a mailing list, or add a sign-up form."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
      <Pagination page={page} pageSize={SUBSCRIBER_PAGE} total={total} totalPages={totalPages(total, SUBSCRIBER_PAGE)} pageSizes={[SUBSCRIBER_PAGE]} />
    </div>
  );
}
