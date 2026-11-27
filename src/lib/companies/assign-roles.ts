/**
 * The ways a person is given a company — its caller, account manager, renewal manager — or a lead, as its owner (owner,
 * 20 Nov 2026), and the department tick for each (Settings › Departments). Plain data, for the settings page as much as the server: the rule itself is in
 * src/lib/companies/assign-teams.ts.
 */

export type AssignRole = "leadOwner" | "caller" | "accountManager" | "renewalManager";

export const ASSIGN_ROLES: Record<AssignRole, { flag: "leadOwnerTeam" | "callerTeam" | "accountManagerTeam" | "renewalManagerTeam"; label: string }> = {
  leadOwner: { flag: "leadOwnerTeam", label: "Lead owner" },
  caller: { flag: "callerTeam", label: "Caller" },
  accountManager: { flag: "accountManagerTeam", label: "Account manager" },
  renewalManager: { flag: "renewalManagerTeam", label: "Renewal manager" },
};
