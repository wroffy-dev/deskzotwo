import { assignmentScores, listAssignmentRules } from "@/actions/lead-assignment";
import { leadLimitTriggerState, roleLeadLimit } from "@/actions/lead-limits";
import { listRoles } from "@/lib/authz/role-registry";
import { RoleLeadLimit } from "@/components/settings/access/lead-limit-editor";
import { planGate } from "@/components/settings/module-disabled-notice";
import { SettingsPage } from "@/components/settings/settings-page";
import { LeadAssignmentManager } from "@/components/settings/lead-assignment-manager";
import { LeadLimitTrigger } from "@/components/settings/lead-limit-trigger";

/** The rules that choose a salesperson for a lead nobody assigned — see src/lib/leads/assign.ts. */
export default async function Page() {
  // Configures leads rather than showing them, so the plan decides — not the viewer's leads.view.
  const gate = await planGate("leads", "Lead assignment");
  if (gate) return gate;
  // The lead limits' backstop switch and its warnings (owner, 12 Nov 2026 — Phase 4 lead limits, audit H.6.4): null for anybody but the super admin.
  const [data, scores, trigger, roles] = await Promise.all([listAssignmentRules(), assignmentScores(), leadLimitTriggerState(), listRoles()]);
  // Each role's lead limits (Phase 4, audit H.6.5) — here since Access Control replaced the roles' Business Rules tab.
  // roleLeadLimit answers null for anybody who may not review permissions, so they see none of it.
  const roleLimits = (await Promise.all(roles.map(async (r) => ({ role: r, limit: await roleLeadLimit(r.key) })))).filter((r) => r.limit !== null);

  return (
    <SettingsPage
      title="Lead assignment"
      description="Who a new lead goes to when nobody chooses — website leads, and leads created with the salesperson left empty. Rules are tried in order; the first that fits decides."
      settingsKey="lead-assignment"
    >
      {data ? (
        <LeadAssignmentManager rules={data.rules} brands={data.brands} people={data.people} categories={data.categories} items={data.items} scores={scores ?? []} />
      ) : (
        <p className="text-sm text-danger">You can&apos;t manage lead assignment.</p>
      )}
      {roleLimits.length > 0 && (
        <section className="mt-6 space-y-3" aria-labelledby="role-lead-limits">
          <h2 id="role-lead-limits" className="text-sm font-semibold text-text">
            Lead limits by role
          </h2>
          {roleLimits.map(({ role, limit }) => (
            <RoleLeadLimit key={`${role.key}:${JSON.stringify(limit!.stored)}`} role={role.key} data={limit!} title={role.name} />
          ))}
        </section>
      )}
      {trigger && (
        <div className="mt-6">
          <LeadLimitTrigger state={trigger} />
        </div>
      )}
    </SettingsPage>
  );
}
