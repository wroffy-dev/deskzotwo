"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { companyMasker } from "@/lib/companies/masking";
import { recordAudit } from "@/lib/audit";
import { AiRefusal } from "@/lib/ai/gateway";
import { copilotConfig } from "@/lib/copilot/settings";
import { refreshResearch, researchOf } from "@/lib/research/gather";
import { briefHasFacts, writeBrief } from "@/lib/research/brief";
import { briefInputFor } from "@/lib/research/view";
import { refreshDomainProfile } from "@/actions/domain";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import type { ActionResult } from "@/actions/company";
import { teammateWork } from "@/lib/ai/teammate-work";
import { BRIEF_STEPS } from "@/lib/ai/teammate-steps";

/**
 * A company's research (owner, 18 Nov 2026 — src/lib/research): Refresh gathers what free public sources say, and
 * "Write a brief" has Deskzo AI write it up. Anybody who sees the company may refresh it; writing a brief takes
 * "Use Deskzo AI" and spends the workspace's credits. Somebody the company's website is masked from gets neither — the
 * research is the website's, as Domain Intel is (src/lib/domain-intel/masking.ts).
 */

const GONE = "Company not found.";
const MASKED = "This company's website is hidden from you, so its research is too.";
/** Pressed again within this, Refresh keeps what it has rather than fetch the same pages twice. */
const AGAIN_AFTER_MS = 60_000;
/** Domain Intel's own lookup is run with it when its findings are older than this, or missing. */
const DOMAIN_STALE_MS = 30 * 86_400_000;

async function reachable(userId: string, companyId: unknown) {
  const company = await db.company.findUnique({
    where: { id: String(companyId ?? "") },
    select: { id: true, name: true, website: true, ownerUserId: true, relationshipType: true, companySeq: true },
  });
  if (!company || !(await canSeeCompany(userId, company))) return { refused: GONE, company: null };
  if ((await companyMasker(userId, "detail")).visibility("website") !== "clear") return { refused: MASKED, company: null };
  return { refused: null, company };
}

export async function refreshCompanyResearch(companyId: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  const found = await reachable(user.id, companyId);
  if (!found.company) return { ok: false, error: found.refused ?? GONE };
  const { company } = found;
  const before = await researchOf(company.id);
  if (before?.refreshedAt && Date.now() - before.refreshedAt.getTime() < AGAIN_AFTER_MS) return { ok: true, data: null };

  await refreshResearch(company, user.id);
  // Domain Intel beside it, where the workspace has it and its findings are old or missing — its own action, its own rules.
  if (company.website && (await moduleAvailableForTenant("domains").catch(() => false))) {
    const profile = await db.domainProfile.findUnique({ where: { companyId: company.id }, select: { fetchedAt: true } }).catch(() => null);
    if (!profile?.fetchedAt || Date.now() - profile.fetchedAt.getTime() > DOMAIN_STALE_MS) await refreshDomainProfile(company.id).catch(() => null);
  }
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Company", entityId: company.id, entityLabel: `${company.name}: research refreshed from public sources` });
  revalidatePath(`/companies/${company.id}`);
  return { ok: true, data: null };
}

export async function writeCompanyBrief(companyId: string): Promise<ActionResult<{ brief: string; at: string }>> {
  const user = await requireUser();
  if (!(await can(user.id, "copilot.use"))) return { ok: false, error: "Writing a brief takes the “Use Deskzo AI” permission." };
  if (!(await copilotConfig()).enabled) return { ok: false, error: "Deskzo AI is switched off. An admin can switch it on in Settings → Deskzo AI." };
  const found = await reachable(user.id, companyId);
  if (!found.company) return { ok: false, error: found.refused ?? GONE };
  const { company } = found;
  // Nothing gathered yet: gather first, so the brief is written from something.
  if (!(await researchOf(company.id))?.refreshedAt) await refreshResearch(company, user.id);
  const input = await briefInputFor(company.id, user.id);
  if (!input || !briefHasFacts(input)) return { ok: false, error: "Nothing was found to write from yet. Add the company's website or GSTIN, then press Refresh." };
  try {
    // Ved's work, shown as it happens (src/lib/ai/teammate-work.ts). What was found is read above; this is the writing.
    const { brief, at } = await teammateWork(
      { teammate: "ved", userId: user.id, kind: "research.brief", subject: `company:${company.id}`, label: company.name, steps: BRIEF_STEPS },
      async (work) => {
        await work.step(1);
        return writeBrief(company.id, user.id, input);
      },
      () => "A research brief, on its company page",
    );
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Company", entityId: company.id, entityLabel: `${company.name}: research brief written by Deskzo AI` });
    revalidatePath(`/companies/${company.id}`);
    return { ok: true, data: { brief, at: at.toISOString() } };
  } catch (err) {
    if (err instanceof AiRefusal) return { ok: false, error: err.message };
    throw err;
  }
}
