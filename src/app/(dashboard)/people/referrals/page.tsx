import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { myReferrals } from "@/actions/referrals";
import { Badge, Card } from "@/components/ui/card";
import { ReferForm } from "@/components/hr/referrals";
import { REFERRAL_WORDS } from "@/lib/hr/referrals";
import { formatCalendarDay } from "@/lib/time/zone";

export const metadata = { title: "Referrals" };

/** People › Referrals (owner, 31 Oct 2026 — src/actions/referrals.ts): refer somebody, and follow the ones you have. */
export default async function ReferralsPage() {
  if (!(await isModuleEnabled("hr"))) return <ModuleDisabledNotice moduleKey="hr" />;
  const mine = await myReferrals();
  return (
    <div className="animate-fade-rise space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-text">Referrals</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">Know somebody good? Refer them — they go to HR&apos;s hiring with your name, and you&apos;re told as they move on.</p>
      </div>
      <ReferForm />
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-text">My referrals</h2>
        {mine.length === 0 ? (
          <Card className="p-4 text-sm text-muted">None yet.</Card>
        ) : (
          <Card className="p-0">
            <ul className="divide-y divide-line">
              {mine.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-text">{r.name}</p>
                    <p className="text-xs text-muted">
                      {r.designation ? `${r.designation} · ` : ""}referred {formatCalendarDay(new Date(r.referredOn))}
                    </p>
                  </div>
                  <Badge tone={r.status === "JOINED" ? "green" : r.status === "DECLINED" || r.status === "WITHDRAWN" ? "default" : "blue"}>{REFERRAL_WORDS[r.status]}</Badge>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
    </div>
  );
}
