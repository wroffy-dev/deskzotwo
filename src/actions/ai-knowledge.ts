"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/actions/company";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/authz/resolve";
import { refuseWhileViewingAs, requireUser } from "@/lib/session";
import { AI_KNOWLEDGE_LIMITS, normaliseText } from "@/lib/ai-knowledge/chunk";
import { COPILOT_KNOWLEDGE_CHUNKS, copilotRender, fitKnowledge } from "@/lib/ai-knowledge/budget";
import { searchKnowledge, type KnowledgeHit } from "@/lib/ai-knowledge/search";
import { deleteKnowledgeFile, knowledgeFile, setKnowledgeForCustomers, updateKnowledgeFile, type KnowledgeFileDetail } from "@/lib/ai-knowledge/store";
import { knowledgeName } from "@/lib/ai-knowledge/upload";

/**
 * Settings › AI Knowledge (src/app/(dashboard)/settings/ai-knowledge): a file opened to edit, saved, deleted, and
 * "what would the AI find" for a question. Uploading is src/app/api/ai-knowledge/upload — files can be several
 * megabytes, past what an action takes. Only for whoever may change the workspace's settings (`settings.manage`),
 * never while viewing as somebody, and every change is in the audit trail.
 */

const NOT_ALLOWED = "Only somebody who can change the workspace's settings can manage AI Knowledge.";

async function admin(): Promise<{ id: string } | string> {
  const user = await requireUser();
  const refused = await refuseWhileViewingAs();
  if (refused) return refused;
  if (!(await can(user.id, "settings.manage"))) return NOT_ALLOWED;
  return user;
}

export async function getAiKnowledgeFile(id: string): Promise<ActionResult<KnowledgeFileDetail>> {
  const user = await admin();
  if (typeof user === "string") return { ok: false, error: user };
  const file = await knowledgeFile(String(id ?? ""));
  return file ? { ok: true, data: file } : { ok: false, error: "That file isn't there any more." };
}

/** A file's name and text, edited: saved, and cut into chunks again. */
export async function saveAiKnowledgeFile(input: { id: string; name: string; content: string }): Promise<ActionResult<{ id: string }>> {
  const user = await admin();
  if (typeof user === "string") return { ok: false, error: user };
  const id = String(input?.id ?? "");
  const raw = String(input?.name ?? "").trim();
  const name = knowledgeName(raw);
  if (!name) return { ok: false, error: `Give the file a name, in under ${AI_KNOWLEDGE_LIMITS.nameChars} characters.` };
  if (!/\.(md|markdown|txt)$/i.test(name)) return { ok: false, error: "Keep the name ending in .md or .txt — a .md file is read for its headings." };
  const content = normaliseText(String(input?.content ?? ""));
  if (!content) return { ok: false, error: "The file is empty. To remove it, delete it instead." };
  if (content.length > AI_KNOWLEDGE_LIMITS.fileChars) return { ok: false, error: `Keep a file under ${AI_KNOWLEDGE_LIMITS.fileChars.toLocaleString("en-IN")} characters — split it into two.` };
  const before = await knowledgeFile(id);
  if (!before) return { ok: false, error: "That file isn't there any more." };
  const refused = await updateKnowledgeFile(user.id, id, { name, content });
  if (refused) return { ok: false, error: refused };
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "AiKnowledgeFile",
    entityId: id,
    entityLabel: before.name === name ? `AI Knowledge: ${name} edited` : `AI Knowledge: ${before.name} renamed ${name}`,
  });
  revalidatePath("/settings/ai-knowledge");
  return { ok: true, data: { id } };
}

export async function deleteAiKnowledgeFile(id: string): Promise<ActionResult<null>> {
  const user = await admin();
  if (typeof user === "string") return { ok: false, error: user };
  const name = await deleteKnowledgeFile(String(id ?? ""));
  if (!name) return { ok: false, error: "That file isn't there any more." };
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "AiKnowledgeFile", entityId: String(id), entityLabel: `AI Knowledge: ${name}` });
  revalidatePath("/settings/ai-knowledge");
  return { ok: true, data: null };
}

/**
 * "Website chat may use this", ticked or cleared on one file (security audit, 11 Nov 2026 — SEC-46): the Customer
 * inbox's bot answers customers only from files with it on, so a file of internal notes is never read out to a
 * visitor. The same people as every other change here, and written in the audit trail either way.
 */
export async function setAiKnowledgeForCustomers(input: { id: string; on: boolean }): Promise<ActionResult<{ on: boolean }>> {
  const user = await admin();
  if (typeof user === "string") return { ok: false, error: user };
  const id = String(input?.id ?? "");
  const on = input?.on === true;
  const saved = await setKnowledgeForCustomers(id, on);
  if (!saved) return { ok: false, error: "That file isn't there any more." };
  if (saved === "not-ready") return { ok: false, error: "This workspace is being updated, so this can't be changed yet. Try again in a few minutes — until then the website chat uses none of these files." };
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "AiKnowledgeFile",
    entityId: id,
    entityLabel: on ? `AI Knowledge: ${saved.name} — the website chat may use it` : `AI Knowledge: ${saved.name} — the website chat may not use it any more`,
  });
  revalidatePath("/settings/ai-knowledge");
  return { ok: true, data: { on } };
}

/** What the copilot's search_knowledge would be given for a question — the same search, the same 4,000 characters. */
export async function tryAiKnowledgeSearch(question: string): Promise<ActionResult<KnowledgeHit[]>> {
  const user = await admin();
  if (typeof user === "string") return { ok: false, error: user };
  const q = String(question ?? "").trim().slice(0, 200);
  if (q.length < 2) return { ok: false, error: "Type a question, or a few words." };
  return { ok: true, data: fitKnowledge(await searchKnowledge(q, COPILOT_KNOWLEDGE_CHUNKS), copilotRender) };
}
