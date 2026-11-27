"use server";

import { revalidatePath } from "next/cache";
import { can } from "@/lib/authz/resolve";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { OLD_PROPOSALS_LIMITS, OldProposalsRefused, previewOldProposals, type PreviewResult } from "@/lib/old-proposals/preview";
import { importPart, moveOldProposal, startOldProposals, undoPart, type Decision, type ImportView } from "@/lib/old-proposals/run";
import { requireUser } from "@/lib/session";
import type { ActionResult } from "@/actions/company";

/**
 * Settings › Old CRM migration › Old proposals (owner, 25 Nov 2026; src/lib/old-proposals): what bringing in the proposals
 * made in Excel before Zoho would do, bringing them in, and taking them back. The workspace's super admin's alone, acting
 * as themselves — checked on every call.
 */

async function run<T>(work: (userId: string) => Promise<T>): Promise<ActionResult<T>> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage")) || !(await actingAsSuperAdmin(user.id))) return { ok: false, error: "Only the workspace's super admin can bring in the old proposals." };
  try {
    return { ok: true, data: await work(user.id) };
  } catch (err) {
    if (err instanceof OldProposalsRefused) return { ok: false, error: err.message };
    throw err;
  }
}

function bytesFrom(base64: unknown): Buffer {
  if (typeof base64 !== "string" || !base64 || base64.length > Math.ceil(OLD_PROPOSALS_LIMITS.packed / 3) * 4 + 4) throw new OldProposalsRefused("That file is bigger than a prepared one can be.");
  return Buffer.from(base64, "base64");
}

/** Reads only: nothing is written, and the uploaded file isn't kept. */
export async function previewOldProposalsFile(base64: string): Promise<ActionResult<PreviewResult>> {
  return run(async () => previewOldProposals(bytesFrom(base64)));
}

const DECISIONS = new Set<string>(["SUGGESTED", "NEW", "LATER"]);

export async function startOldProposalsImport(base64: string, decisions: Record<string, Decision>, confirmed: boolean): Promise<ActionResult<{ id: string }>> {
  return run(async (userId) => {
    if (confirmed !== true) throw new OldProposalsRefused("Confirm the import after reading what it will do.");
    const given = decisions && typeof decisions === "object" ? Object.entries(decisions).slice(0, OLD_PROPOSALS_LIMITS.proposals) : [];
    const clean = Object.fromEntries(given.filter(([, v]) => DECISIONS.has(String(v)))) as Record<string, Decision>;
    const id = await startOldProposals(bytesFrom(base64), clean, userId);
    revalidatePath("/settings/data/old-proposals");
    return { id };
  });
}

export async function stepOldProposalsImport(importId: string): Promise<ActionResult<ImportView>> {
  return run((userId) => importPart(String(importId ?? ""), userId));
}

/** One proposal to another company; `to` null, to one of its own name. */
export async function moveOldProposalTo(proposalId: string, to: string | null): Promise<ActionResult<{ seq: number; name: string; contact: boolean }>> {
  return run(async (userId) => {
    const moved = await moveOldProposal(String(proposalId ?? ""), to === null ? null : String(to ?? ""), userId);
    revalidatePath("/companies/[id]", "page");
    return moved;
  });
}

export async function undoOldProposalsImport(importId: string, typed: string): Promise<ActionResult<{ done: boolean; left: number; kept: number }>> {
  return run(async (userId) => {
    if (typed !== "UNDO") throw new OldProposalsRefused("Type UNDO to take it back.");
    const r = await undoPart(String(importId ?? ""), userId);
    if (r.done) revalidatePath("/settings/data/old-proposals");
    return r;
  });
}
