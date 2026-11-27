import { assertGrantWithinOwnAuthority } from "@/lib/authz/guards";
import { permissionsFor } from "@/lib/authz/resolve";
import { ACCESS_RECORDS, explainAccess } from "@/lib/authz/access";
import { within } from "@/lib/authz/level-order";
import { resolveStoredFieldPolicies } from "@/lib/authz/fields";
import { FIELD_ENTITIES, openPolicy, withinPolicy } from "@/lib/authz/field-policy";

/**
 * Whether somebody holds nothing `actor` couldn't give themselves — the rule for borrowing their account,
 * by viewing as them (holdsNothingBeyond, src/lib/impersonation.ts) or by being handed their setup link or
 * a temporary password (mayPassOnSetupLink, src/lib/account-setup.ts).
 *
 * Security audit, Nov 2026: both compared permission keys only. Authority has two more kinds, and a
 * borrowed session carries all of them, so an admin who reaches only their own leads, or sees lead
 * emails masked, could view as somebody who reaches all leads or sees them in the clear. Now all three
 * are held to the same tests the grant screens use:
 *
 *   1. every permission key the account holds is one the actor could grant (assertGrantWithinOwnAuthority);
 *   2. every record type and action: the account's level is within the actor's (`within`, with the actor's
 *      "as the account" read through their companies level, as setPersonAccessLevels does);
 *   3. every sensitive field of every record type: the account's stored policy is no more open than the
 *      actor's (`withinPolicy`, as setPersonFieldAccess does). Stored, not effective: with masking switched
 *      off everybody reads "in the clear", and the rule must outlast the switch going back on.
 *
 * A super admin holds everything, so passes.
 */
export async function targetWithinActorAuthority(actor: { id: string; isSuperAdmin: boolean }, targetId: string): Promise<boolean> {
  if (actor.isSuperAdmin) return true;

  for (const key of await permissionsFor(targetId)) {
    try {
      await assertGrantWithinOwnAuthority(actor, key);
    } catch {
      return false;
    }
  }

  for (const record of ACCESS_RECORDS) {
    for (const action of record.actions) {
      const theirs = (await explainAccess(targetId, record.key, action)).level;
      if (theirs === "NONE") continue;
      const own = (await explainAccess(actor.id, record.key, action)).level;
      const accounts = own === "FOLLOW" ? (await explainAccess(actor.id, "companies", action)).level : null;
      if (!within(theirs, accounts === "ALL" ? "ALL" : own)) return false;
    }
  }

  for (const entity of FIELD_ENTITIES) {
    const [theirs, mine] = await Promise.all([resolveStoredFieldPolicies(targetId, entity), resolveStoredFieldPolicies(actor.id, entity)]);
    for (const [key, field] of theirs.fields) {
      const own = mine.fields.get(key)?.policy ?? openPolicy(field.field.kind);
      if (!withinPolicy(field.policy, own)) return false;
    }
  }

  return true;
}
