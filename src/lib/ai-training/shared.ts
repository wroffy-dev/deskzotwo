import type { AiFeature } from "@/lib/ai/catalogue";
import { TEAMMATE_KEYS, type TeammateKey } from "@/lib/ai/teammates";

/**
 * AI training from the console (owner, 20 Nov 2026 — "admin.deskzo.com can put the md files universally for all and
 * also specific for tenants; this option will not show to any workspace"). Deskzo's staff upload .md/.txt guides at
 * Settings › AI training; each file is for every teammate or chosen ones, and for every workspace or chosen ones. A
 * workspace never lists or opens them: its teammates are given a few of their chunks inside the prompt, and nothing else.
 *
 * Fast on a small local model (qwen2.5:7b on Ollama, 8k of context): a file is never pasted whole into a prompt. Each
 * answer is given only the chunks its question finds, for its own teammate, in a fixed budget — a short prompt is the
 * one thing that makes a 7B model answer sooner. Files ticked "Always" (short rules and tone) come first, within
 * their own smaller share of that budget.
 *
 * Pure and client-safe.
 */

/** The most training one prompt is given, in characters — on top of AI Knowledge's 4,000 (src/lib/ai-knowledge/budget.ts). */
export const TRAINING_PROMPT_CHARS = 2500;
/** Of that, the most the "Always" files take; the rest is for what the question finds. */
export const TRAINING_ALWAYS_CHARS = 1200;
/** Chunks a question is searched for — the budget cuts them down. */
export const TRAINING_SEARCH_CHUNKS = 4;

/** Which teammate each AI feature is (src/lib/ai/teammates.ts) — whose training its prompt is given. */
export const FEATURE_TEAMMATE: Record<AiFeature, TeammateKey> = {
  "copilot.chat": "deskzo",
  "copilot.escalate": "deskzo",
  "marketing.design": "deskzo",
  "automate.draft": "mira",
  "inbox.answer": "kabir",
  "research.brief": "ved",
  "research.plan": "ved",
  "nurture.email": "tara",
  "nurture.reply": "tara",
  "reengage.email": "tara",
  "collections.email": "arjun",
  "collections.reply": "arjun",
  "bills.read": "arjun",
  "receipts.read": "arjun",
  "bank.match": "arjun",
  "tickets.draft": "kabir",
  "hr.answer": "priya",
};

/** A model a teammate's work runs on now (./models.ts): whether only the chat's harder questions reach it. */
export type TeammateModel = { key: string; label: string; providerModel: string; harder: boolean };
export type TeammateModels = Partial<Record<TeammateKey, TeammateModel[]>>;

/** "Claude Haiku 5.5 (claude-haiku-5-5); harder questions: Claude Sonnet 5.5 (claude-sonnet-5-5)" — null when none. */
export function modelsText(models: TeammateModel[] | undefined): string | null {
  if (!models?.length) return null;
  const named = (m: TeammateModel) => (m.label === m.providerModel ? m.label : `${m.label} (${m.providerModel})`);
  const main = models.filter((m) => !m.harder).map(named);
  const harder = models.filter((m) => m.harder).map(named);
  return [main.join(", "), harder.length ? `harder questions: ${harder.join(", ")}` : ""].filter(Boolean).join("; ");
}

/** Teammate keys as kept on a file: known ones only, once each, in the catalogue's order. Empty: every teammate. */
export function cleanAgents(value: unknown): TeammateKey[] {
  const given = new Set(Array.isArray(value) ? value.map((v) => String(v)) : []);
  return TEAMMATE_KEYS.filter((k) => given.has(k));
}

/** A file as the console lists it. */
export type TrainingFileRow = {
  id: string;
  name: string;
  title: string;
  chars: number;
  chunks: number;
  /** Empty: every teammate. */
  agents: TeammateKey[];
  /** Empty: every workspace. */
  tenantIds: string[];
  always: boolean;
  active: boolean;
  updatedAt: string;
};

export type TrainingFileDetail = TrainingFileRow & { content: string };

/** What a bulk change sets on every file chosen; a field left out stays as each file has it. */
export type TrainingBulkChange = { agents?: TeammateKey[]; tenantIds?: string[]; always?: boolean; active?: boolean };

/** A workspace, as the console's picker offers it. */
export type TrainingWorkspace = { id: string; slug: string; name: string };

export type TrainingSaveReport = { added: string[]; replaced: string[]; skipped: { name: string; reason: string }[] };

/** What a teammate would be given for a question in a workspace — the console's "Try it". */
export type TrainingPreview = { always: { file: string; text: string }[]; found: { file: string; heading: string; text: string }[]; chars: number; ms: number };
