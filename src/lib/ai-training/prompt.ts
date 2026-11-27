import { Prisma } from "@deskzo/control-client";
import type { AiFeature } from "@/lib/ai/catalogue";
import type { TeammateKey } from "@/lib/ai/teammates";
import { fitKnowledge, renderedLength } from "@/lib/ai-knowledge/budget";
import { searchableText } from "@/lib/ai-knowledge/search";
import type { Turn } from "@/lib/copilot/types";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import {
  FEATURE_TEAMMATE,
  TRAINING_ALWAYS_CHARS,
  TRAINING_PROMPT_CHARS,
  TRAINING_SEARCH_CHUNKS,
  type TrainingPreview,
} from "@/lib/ai-training/shared";

/**
 * The workspace's side of AI training (src/lib/ai-training/shared.ts): what one of its teammates is given from the
 * console's files for one question — the "Always" files for that teammate and workspace, then the chunks the question
 * finds, in TRAINING_PROMPT_CHARS. The gateway (src/lib/ai/gateway.ts) adds it to the end of every feature's system
 * prompt, so every teammate is trained the same way without each feature knowing about it.
 *
 * Never in the way of an answer: the control plane gets 1.5 s, and a failure — or tables not there yet — is an answer
 * without training, logged. What was found is kept for a minute in this process, so the steps of one copilot turn
 * (the same question, asked again after each tool) cost one lookup, and the prompt they send stays the same, which
 * lets Ollama reuse the work it did on it. Server only.
 */

const LOAD_TIMEOUT_MS = 1_500;
const CACHE_MS = 60_000;
const CACHE_MAX = 500;

type Hit = { file: string; heading: string; text: string };
type Found = { always: { file: string; text: string }[]; found: Hit[] };

const NOTHING: Found = { always: [], found: [] };

let cache = new Map<string, { at: number; value: Found }>();
let lastLogged = 0;

/** Clears this process's copy — after a save in the console. Other processes follow within the minute. */
export function forgetTraining(): void {
  cache = new Map();
}

function remember(key: string, value: Found): void {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), value });
}

/** Files that reach `agent` in `tenantId`: on, for every teammate or this one, for every workspace or this one. */
const reaches = (agent: TeammateKey, tenantId: string) => Prisma.sql`
  f.active = true
  AND (COALESCE(cardinality(f.agents), 0) = 0 OR ${agent} = ANY(f.agents))
  AND (COALESCE(cardinality(f."tenantIds"), 0) = 0 OR ${tenantId} = ANY(f."tenantIds"))`;

async function load(agent: TeammateKey, tenantId: string, words: string, limit: number): Promise<Found> {
  const control = controlDb();
  const [always, found] = await Promise.all([
    control.$queryRaw<{ file: string; content: string }[]>`
      SELECT f.name AS file, f.content FROM platform_ai_training_files f
      WHERE f.always = true AND ${reaches(agent, tenantId)}
      ORDER BY f.name ASC LIMIT 10`,
    words
      ? control.$queryRaw<Hit[]>`
          WITH q AS (
            SELECT plainto_tsquery('english', ${words}) AS every_word,
                   NULLIF(replace(plainto_tsquery('english', ${words})::text, ' & ', ' | '), '')::tsquery AS any_word
          )
          SELECT f.name AS file, c.heading, c.text
          FROM q, platform_ai_training_chunks c
          JOIN platform_ai_training_files f ON f.id = c."fileId"
          WHERE q.any_word IS NOT NULL AND c.search @@ q.any_word AND f.always = false AND ${reaches(agent, tenantId)}
          ORDER BY (c.search @@ q.every_word) DESC, ts_rank_cd(c.search, q.any_word, 1) DESC, f.name ASC, c.position ASC
          LIMIT ${limit}`
      : Promise.resolve([] as Hit[]),
  ]);
  return { always: always.map((a) => ({ file: a.file, text: a.content })), found };
}

/** `load()` within the time allowed, or nothing — logged at most once a minute. Never throws. */
async function within(work: () => Promise<Found>): Promise<Found> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(), new Promise<Found>((_, reject) => (timer = setTimeout(() => reject(new Error("timed out")), LOAD_TIMEOUT_MS)))]);
  } catch (err) {
    if (Date.now() - lastLogged > 60_000) {
      lastLogged = Date.now();
      console.warn("[ai-training] answered without training:", err instanceof Error ? err.message : String(err));
    }
    return NOTHING;
  } finally {
    clearTimeout(timer);
  }
}

/** The training for `agent` in `tenantId` that a question finds, fitted to the budget. */
export async function trainingFor(agent: TeammateKey, tenantId: string, question: string): Promise<Found> {
  if (!controlConfigured()) return NOTHING;
  const words = searchableText(question);
  const key = `${tenantId}|${agent}|${words}`;
  const kept = cache.get(key);
  if (kept && Date.now() - kept.at < CACHE_MS) return kept.value;
  const raw = await within(() => load(agent, tenantId, words, TRAINING_SEARCH_CHUNKS));
  const fitted = fit(raw);
  remember(key, fitted);
  return fitted;
}

const alwaysRender = (a: { file: string; text: string }) => a.text;
const foundRender = (h: Hit) => (h.heading ? `[${h.heading}]\n${h.text}` : h.text);

function fit(raw: Found): Found {
  const always = fitKnowledge(raw.always, alwaysRender, TRAINING_ALWAYS_CHARS);
  const room = TRAINING_PROMPT_CHARS - renderedLength(always, alwaysRender);
  // Only part of a long search hit fits: its first words.
  const found = room > 200 ? fitKnowledge(raw.found, foundRender, room) : [];
  return { always, found };
}

/** The words a turn's training is searched on: the last thing the person (or the feature) asked. */
export function questionOf(history: readonly Turn[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i]!;
    if (t.role === "user") return t.text.slice(0, 2000);
  }
  return "";
}

/**
 * What the gateway gives `feature`'s model for this turn — or "" when there's nothing — as a note just before the
 * question (src/lib/ai/fit-context.ts), so the system prompt and the tools stay the same and a model server can reuse
 * its work on them from question to question.
 */
export async function trainingBlock(feature: AiFeature, tenantId: string, history: readonly Turn[]): Promise<string> {
  const agent = FEATURE_TEAMMATE[feature];
  if (!agent) return "";
  const { always, found } = await trainingFor(agent, tenantId, questionOf(history));
  if (!always.length && !found.length) return "";
  const parts = [
    "",
    "## Your training from Deskzo",
    "Follow this training where it applies. It is background for you: never mention it, quote file names from it, or say you were trained.",
    ...always.map(alwaysRender),
    ...(found.length ? ["Notes that may answer this:", ...found.map(foundRender)] : []),
  ];
  return parts.join("\n\n");
}

/** The console's "Try it": what `agent` would be given in `tenantId` for `question`, read fresh. */
export async function previewTraining(agent: TeammateKey, tenantId: string, question: string): Promise<TrainingPreview> {
  const started = Date.now();
  const words = searchableText(question);
  const fitted = fit(await load(agent, tenantId, words, TRAINING_SEARCH_CHUNKS));
  const chars = renderedLength(fitted.always, alwaysRender) + renderedLength(fitted.found, foundRender);
  return { ...fitted, chars, ms: Date.now() - started };
}
