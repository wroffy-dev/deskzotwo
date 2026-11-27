import { requireAccessViewer } from "@/lib/access-control/guard";
import { can } from "@/lib/authz/resolve";
import { getSecurityPolicyForAdmin } from "@/actions/security-policy";
import { getSecuritySettings } from "@/actions/security";
import { getWorkplaceSettings } from "@/actions/workplace";
import { getSupportAccess } from "@/actions/support-access";
import { getLinkedSignInAdmin } from "@/actions/linked-sign-in-admin";
import { getRoleSignInRules } from "@/actions/sign-in-rules";
import { listRolesForScreen } from "@/actions/role";
import { fieldMaskingState } from "@/actions/field-access";
import { unmaskDefaultLimitState } from "@/actions/unmask-log";
import { DEFAULT_SECURITY_POLICY, type SecurityPolicyShape } from "@/lib/security/policy";
import { protocolFor } from "@/lib/tenancy/host";
import { currentTenant } from "@/lib/tenancy/resolve";
import { signInProviders } from "@/lib/workplace/settings";
import { SIGN_IN_NAMES } from "@/lib/workplace/providers";
import { LinkedSignInCard } from "@/components/settings/linked-sign-in-card";
import { WorkplaceProviderPicker } from "@/components/settings/workplace-provider-picker";
import { SupportAccessCard } from "@/components/settings/support-access-card";
import { RoleSignInRules } from "@/components/settings/role-sign-in-rules";
import { Panel, PanelHeader } from "@/components/access-control/ui";
import { SecuritySettingsScreen } from "@/components/access-control/policy/security-settings-screen";

export const metadata = { title: "Security Settings" };

/**
 * The roles the browser deterrents can be lifted for — the built-in ones the policy accepts
 * (src/lib/validation/security-policy.ts). Admin is exempt in code and is never listed.
 */
const EXEMPTABLE_ROLES = ["MANAGEMENT", "SALES", "SUPPORT", "ACCOUNTS", "PURCHASE", "CALLING", "PROFILE"] as const;

/** The policy's own settings and nothing else of its row, so the draft compares like with like. */
function policyOnly(row: SecurityPolicyShape): SecurityPolicyShape {
  const keys = Object.keys(DEFAULT_SECURITY_POLICY) as (keyof SecurityPolicyShape)[];
  return Object.fromEntries(keys.map((k) => [k, row[k]])) as SecurityPolicyShape;
}

/**
 * Every address the workspace answers at — its own subdomain, then each live custom address — as
 * origins: Microsoft, Google and Zoho need a redirect address for each one people sign in at.
 */
async function workspaceOrigins(): Promise<string[]> {
  const tenant = await currentTenant();
  return [...new Set(tenant.hosts)].map((host) => `${protocolFor(host)}://${host}`);
}

/**
 * Settings › Access Control › Security Settings: the sign-in policy and the data-loss-prevention
 * policy as one drafted page, a summary of how sensitive data is protected, and the door to Devices,
 * networks & sign-ins.
 *
 * `permissions.view` opens the area (the layout), but the two policies are read and changed with
 * "Change the security and DLP policy" — each read below answers null without it, and the screen then
 * draws only what the person may see. The sign-in providers, the rules by role, linked sign-in and
 * platform support access keep their own forms, which save as they always did.
 */
export default async function SecuritySettingsPage() {
  const viewer = await requireAccessViewer();

  const [maySecurity, mayApproveDevices, mayViewSignIns, policy, loginSettings, workplace, signIn, roleRules, support, linked, roleRows, masking, unmaskDefault] = await Promise.all([
    can(viewer.id, "security.manage"),
    can(viewer.id, "access.approveDevices"),
    can(viewer.id, "access.viewSignIns"),
    getSecurityPolicyForAdmin(),
    getSecuritySettings(),
    // Null in a workspace still waiting for its migration: no Google or Zoho cards until it has the table.
    getWorkplaceSettings(),
    signInProviders(),
    // Null in a workspace still waiting for its migration: no rules by role until it has the table.
    getRoleSignInRules(),
    // The super admin's alone — null for everybody else, who never sees the card.
    getSupportAccess(),
    // One card, never a reason for the page to fail: a control plane out of reach just hides it.
    getLinkedSignInAdmin().catch(() => null),
    listRolesForScreen(),
    fieldMaskingState(),
    unmaskDefaultLimitState(),
  ]);
  const origins = loginSettings ? await workspaceOrigins() : [];

  const roleName = new Map((roleRows.ok ? roleRows.data : []).map((r) => [r.key, r.name]));
  const exemptChoices = EXEMPTABLE_ROLES.map((key) => ({ key, name: roleName.get(key) ?? key.charAt(0) + key.slice(1).toLowerCase() }));
  const ownForms = maySecurity && (roleRules || loginSettings || linked || support);

  return (
    <SecuritySettingsScreen
      policy={policy ? policyOnly(policy) : null}
      signIn={loginSettings ? { enforceTwoFactor: loginSettings.enforceTwoFactor, enforceSso: loginSettings.enforceSso } : null}
      signInWith={signIn.map((p) => SIGN_IN_NAMES[p])}
      exemptChoices={exemptChoices}
      masking={{ enabled: masking.enabled, changedAtText: masking.changedAtText, changedBy: masking.changedBy }}
      unmaskDefault={{ dailyLimit: unmaskDefault.dailyLimit, changedAtText: unmaskDefault.changedAtText, changedBy: unmaskDefault.changedBy }}
      devicesLink={maySecurity || mayApproveDevices || mayViewSignIns}
    >
      {ownForms && (
        <section className="mt-2 flex flex-col gap-4">
          <div>
            <h2 className="text-[15px] font-bold tracking-[-0.01em] text-text">Sign-in providers &amp; support access</h2>
            <p className="mt-0.5 text-xs text-muted">Each of these saves on its own, not with Save settings above.</p>
          </div>
          {roleRules && (
            <Panel>
              <PanelHeader title="Sign-in by role" />
              <div className="p-4">
                <RoleSignInRules roles={roleRules.roles} choices={roleRules.choices} />
              </div>
            </Panel>
          )}
          {/* The suite the company uses — for signing in, and for people's own mailboxes. */}
          {loginSettings && (
            <Panel>
              <PanelHeader title="Email & sign-in: Microsoft 365, Google Workspace or Zoho" />
              <div className="p-4">
                <WorkplaceProviderPicker microsoft={loginSettings.microsoft} google={workplace?.google ?? null} zoho={workplace?.zoho ?? null} origins={origins} />
              </div>
            </Panel>
          )}
          {/* Null while viewing as somebody and in a workspace outside the control plane. */}
          {linked && (
            <Panel>
              <PanelHeader title="Linked sign-in" />
              <div className="p-4">
                <LinkedSignInCard state={linked} />
              </div>
            </Panel>
          )}
          {support && (
            <Panel>
              <PanelHeader title="Platform support access" />
              <div className="p-4">
                <SupportAccessCard state={support} />
              </div>
            </Panel>
          )}
        </section>
      )}
    </SecuritySettingsScreen>
  );
}
