"use server";

import { revalidatePath } from "next/cache";
import { refuseWhileViewingAs } from "@/lib/session";
import { requireModuleAccess } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { cleanTallyName } from "@/lib/tally/names";
import { TallyRefusal, markImported, previewExport, runExport, saveTallyConfig, saveTallyMasters, setTallyMapping, tallyConfig } from "@/lib/tally/server";
import type { ExportPlan } from "@/lib/tally/build";
import type { ActionResult } from "@/actions/company";

/**
 * Settings › Tally (owner, 25 Oct 2026 plan, decision 7; built 23 Nov 2026 — src/lib/tally). The switch, the Tally
 * company, the masters upload and the mapping take "Close the books"; making an export, checking one and marking it
 * imported take "Export finance data". No new permissions. Never while viewing as somebody.
 */

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

async function who(permission: "books.close" | "data.exportFinance"): Promise<{ id: string } | { error: string }> {
  const user = await requireModuleAccess("accounting");
  if (!(await can(user.id, permission))) return { error: permission === "books.close" ? "The Tally settings take the “Close the books” permission." : "Exporting to Tally takes the “Export finance data” permission." };
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { error: viewingAs };
  return user;
}

function refusal(err: unknown): { ok: false; error: string } {
  if (err instanceof TallyRefusal) return { ok: false, error: err.message };
  throw err;
}

export async function saveTallySettings(input: { booksIn: string; companyName: string; itemLines: boolean; startDate: string }): Promise<ActionResult<null>> {
  const user = await who("books.close");
  if ("error" in user) return { ok: false, error: user.error };
  const booksIn = input?.booksIn === "TALLY" ? "TALLY" : "DESKZO";
  const companyName = cleanTallyName(input?.companyName);
  const startDate = String(input?.startDate ?? "").trim();
  if (startDate && !DAY_KEY.test(startDate)) return { ok: false, error: "The start date isn't a date." };
  if (booksIn === "TALLY" && !companyName) return { ok: false, error: "Say which Tally company the files are for — its name exactly as Tally shows it." };
  const before = await tallyConfig();
  if (!before.migrated) return { ok: false, error: "This workspace is still being updated. Try again in a few minutes." };
  await saveTallyConfig({ booksIn, companyName: companyName || null, itemLines: input?.itemLines !== false, startDate: startDate || null }, user.id);
  if (before.booksIn !== booksIn) await recordAudit({ userId: user.id, action: "UPDATE", entityType: "TallySettings", entityId: "global", entityLabel: booksIn === "TALLY" ? "The books are kept in Tally — Deskzo's ledger pages switched off" : "The books are kept in Deskzo again" });
  if (before.companyName !== (companyName || null) || before.startDate !== (startDate || null) || before.itemLines !== (input?.itemLines !== false)) {
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "TallySettings", entityId: "global", entityLabel: `Tally export: company “${companyName || "—"}”, from ${startDate || "the beginning"}, ${input?.itemLines !== false ? "with item lines" : "amounts by ledger only"}` });
  }
  revalidatePath("/", "layout");
  return { ok: true, data: null };
}

/** The masters file the accountant exported from Tally (Display › List of Accounts › Export, XML). */
export async function uploadTallyMasters(form: FormData): Promise<ActionResult<{ ledgers: number; items: number }>> {
  const user = await who("books.close");
  if ("error" in user) return { ok: false, error: user.error };
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose the masters file Tally exported." };
  if (file.size > 20 * 1024 * 1024) return { ok: false, error: "That file is over 20 MB — export the masters only, not the vouchers." };
  const got = await saveTallyMasters(file.name, new Uint8Array(await file.arrayBuffer()), user.id);
  if (!got.ledgers && !got.items) return { ok: false, error: "No ledgers or stock items were found in it — export Tally's masters as XML (Display › List of Accounts › Export)." };
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "TallySettings", entityId: "global", entityLabel: `Tally's masters uploaded (${file.name}): ${got.ledgers} ledgers, ${got.items} stock items` });
  revalidatePath("/settings/tally");
  return { ok: true, data: got };
}

/** A Deskzo name's Tally name — empty takes the mapping away. */
export async function mapToTally(input: { key: string; tallyName: string }): Promise<ActionResult<null>> {
  const user = await who("books.close");
  if ("error" in user) return { ok: false, error: user.error };
  const key = String(input?.key ?? "");
  if (!/^(ACCOUNT:[A-Za-z0-9_-]{1,64}(@\d{1,2}(\.\d{1,2})?)?|PARTY:[A-Za-z0-9_-]{1,64}|ITEM:[\s\S]{1,300})$/.test(key)) return { ok: false, error: "That isn't something that's matched to Tally." };
  const raw = String(input?.tallyName ?? "");
  const name = cleanTallyName(raw);
  if (raw.trim() && !name) return { ok: false, error: "That isn't a Tally name." };
  await setTallyMapping(key, name || null, user.id);
  revalidatePath("/settings/tally");
  return { ok: true, data: null };
}

export async function checkTallyExport(input: { from: string; to: string }): Promise<ActionResult<Pick<ExportPlan, "unmatched" | "skipped" | "summary"> & { vouchers: number }>> {
  const user = await who("data.exportFinance");
  if ("error" in user) return { ok: false, error: user.error };
  if (!DAY_KEY.test(input?.from ?? "") || !DAY_KEY.test(input?.to ?? "") || input.from > input.to) return { ok: false, error: "Choose the period: from a day to a day." };
  const plan = await previewExport(input.from, input.to);
  return { ok: true, data: { unmatched: plan.unmatched, skipped: plan.skipped, summary: plan.summary, vouchers: plan.vouchers.length } };
}

export async function makeTallyExport(input: { from: string; to: string }): Promise<ActionResult<{ id: string; exportSeq: number; vouchers: number }>> {
  const user = await who("data.exportFinance");
  if ("error" in user) return { ok: false, error: user.error };
  if (!DAY_KEY.test(input?.from ?? "") || !DAY_KEY.test(input?.to ?? "") || input.from > input.to) return { ok: false, error: "Choose the period: from a day to a day." };
  try {
    const made = await runExport(input.from, input.to, user.id);
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "TallyExport", entityId: made.id, entityLabel: `Tally export ${made.exportSeq}: ${input.from} to ${input.to}, ${made.vouchers} vouchers` });
    revalidatePath("/settings/tally");
    return { ok: true, data: made };
  } catch (err) {
    return refusal(err);
  }
}

export async function markTallyImported(id: string): Promise<ActionResult<null>> {
  const user = await who("data.exportFinance");
  if ("error" in user) return { ok: false, error: user.error };
  try {
    await markImported(String(id ?? ""), user.id);
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "TallyExport", entityId: String(id), entityLabel: "Tally export marked imported — its totals tie in Tally" });
    revalidatePath("/settings/tally");
    return { ok: true, data: null };
  } catch (err) {
    return refusal(err);
  }
}
