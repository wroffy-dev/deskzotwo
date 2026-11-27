"use server";

import { revalidatePath } from "next/cache";
import { requireUser, refuseWhileViewingAs } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { toPlain } from "@/lib/serialize";
import type { ActionResult } from "@/actions/company";
import { RULE_ENTITIES, type FieldRule, type RuleEntity, type RuleField } from "@/lib/field-rules/catalogue";
import { deleteFieldRule, ruleFields, rulesFor, saveFieldRule, type FieldRuleInput } from "@/lib/field-rules/server";

/**
 * Settings › Field rules (owner, 12 Nov 2026 — src/lib/field-rules): the rules on companies, contacts and leads,
 * for whoever may change organisation settings. The rules themselves are checked on every save by a person.
 */

const NO_SETTINGS = "You can't change these settings.";

export type FieldRulesView = Record<RuleEntity, { fields: RuleField[]; rules: FieldRule[] }>;

export async function listFieldRules(): Promise<ActionResult<FieldRulesView>> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: NO_SETTINGS };
  const out = {} as FieldRulesView;
  for (const entity of RULE_ENTITIES) out[entity] = { fields: await ruleFields(entity), rules: await rulesFor(entity) };
  return { ok: true, data: toPlain(out) };
}

export async function saveFieldRuleAction(input: FieldRuleInput): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: NO_SETTINGS };
  const saved = await saveFieldRule(user.id, input);
  if (!saved.ok) return saved;
  revalidatePath("/settings/field-rules");
  return { ok: true, data: { id: saved.id } };
}

export async function deleteFieldRuleAction(id: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: NO_SETTINGS };
  await deleteFieldRule(user.id, String(id ?? ""));
  revalidatePath("/settings/field-rules");
  return { ok: true, data: null };
}
