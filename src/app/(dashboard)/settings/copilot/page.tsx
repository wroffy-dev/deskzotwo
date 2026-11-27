import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { getCopilotSettings } from "@/actions/copilot";
import { CopilotSettingsForm } from "@/components/settings/copilot-settings-form";
import { getAutoPlanSettings } from "@/actions/research-plan";
import { AutoPlanSettings } from "@/components/settings/auto-plan-settings";
import { getNurtureSettings } from "@/actions/nurture";
import { NurtureSettings } from "@/components/settings/nurture-settings";
import { getArjunSettings } from "@/actions/arjun-settings";
import { ArjunSettings } from "@/components/settings/arjun-settings";
import { getHrDeskSettings } from "@/actions/hr-desk";
import { HrDeskSettings } from "@/components/settings/hr-desk-settings";
import { getHouseStyle } from "@/actions/ai-quality";
import { getReengageSettings } from "@/actions/reengage";
import { ReengageSettings } from "@/components/settings/reengage-settings";
import { HouseStyleSettings } from "@/components/settings/house-style-settings";
import { getMailReading } from "@/actions/mail-reading";
import { MailReadingSettings } from "@/components/settings/mail-reading-settings";

export const metadata = { title: "Deskzo AI" };
export const dynamic = "force-dynamic";

/**
 * Deskzo AI in this workspace: the copilot's and drafting's switches, a daily cap for each person, where
 * each feature's requests go, this month's credits and who used them. The models and their rates are
 * Deskzo's (console › Settings › AI); a workspace brings no key since 17 Oct 2026. See src/lib/ai.
 */
export default async function CopilotSettingsPage() {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) notFound();
  const [settings, autoPlan, nurture, arjun, hrDesk] = await Promise.all([getCopilotSettings(), getAutoPlanSettings(), getNurtureSettings(), getArjunSettings(), getHrDeskSettings()]);
  const style = await getHouseStyle();
  const reengage = await getReengageSettings();
  const mailReading = await getMailReading();
  if (!settings) notFound();
  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Deskzo AI</h1>
        <p className="mt-1 text-sm text-muted">
          Deskzo AI, in the header, answers questions about your data, draws reports, and drafts tasks, notes, new leads and a change to one lead; Automate drafts workflows from a description. Both
          run on Deskzo&apos;s own AI and are paid for in credits — your plan includes some each month, and packs add more. Deskzo AI sees and does only what the
          person using it already can.
        </p>
      </div>
      <CopilotSettingsForm settings={settings} />
      {/* How every AI teammate writes (owner, 20 Nov 2026 — src/lib/ai/house-style.ts). */}
      {style && <HouseStyleSettings style={style} />}
      {/* New leads researched and planned by themselves (owner, 18 Nov 2026 — src/lib/research/auto-plan.ts). */}
      {autoPlan && autoPlan.migrated && <AutoPlanSettings settings={autoPlan} />}
      {/* Leads nurtured by Deskzo AI, every email approved first (owner, 18 Nov 2026 — src/lib/nurture). */}
      {nurture && nurture.migrated && <NurtureSettings settings={nurture} />}
      {/* Tara checking in with quiet customers, every email approved by the account manager (owner, 20 Nov 2026 — src/lib/reengage). */}
      {reengage && reengage.migrated && <ReengageSettings settings={reengage} />}
      {/* Arjun drafting chase emails each morning, and his Monday note (owner, 19 Nov 2026 — src/lib/collections/arjun-auto.ts). */}
      {arjun && arjun.migrated && <ArjunSettings settings={arjun} />}
      {/* Priya, the HR desk, for everybody with My HR (owner, 20 Nov 2026 — src/lib/hr-desk). */}
      {hrDesk && hrDesk.migrated && <HrDeskSettings settings={hrDesk} />}
      {/* The AI teammates reading connected mailboxes, mailbox by mailbox (owner, 23 Nov 2026 — src/lib/mail-reading). */}
      {mailReading && mailReading.ready && <MailReadingSettings view={mailReading} />}
    </div>
  );
}
