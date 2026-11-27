import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { COPILOT_KNOWLEDGE_CHUNKS } from "@/lib/ai-knowledge/budget";

/**
 * Finding the chunks of AI Knowledge that answer a question (owner, 3 Nov 2026): Postgres full-text search over each
 * chunk's `search` — its headings weighted above its text, English stemming, a GIN index (migration
 * 20261203110000_ai_knowledge). The copilot's search_knowledge asks for the best five; the inbox's bot for three.
 *
 * A question is asked in everyday words — "how do I add a lead in deskzo?" — so a chunk need not hold every one of
 * them: any of its words will do, the common ones ("how", "do", "in") left out by the stemmer. Chunks holding all of
 * the question's words come first; then the rest, by cover density (ts_rank_cd, so a chunk where they come close
 * together beats one where they're scattered), a long chunk not favoured merely for being long.
 */

export type KnowledgeHit = { file: string; heading: string; text: string };

/**
 * The words a question is searched on — letters and digits in any script, with their marks (Hindi's matras: "लीड" is
 * one word, not two) — or none when it has none. Nothing else reaches the query.
 */
export function searchableText(question: string): string {
  return (question.match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).join(" ").slice(0, 500);
}

type Row = { file: string; heading: string; text: string };

/**
 * The `limit` chunks that best answer a question, best first. None when nothing matches, or before the migration.
 *
 * `forCustomers` (security audit, 11 Nov 2026 — SEC-46): only the files ticked "Website chat may use this" are
 * searched — what the Customer inbox's bot asks for, since its answer goes to somebody outside the company. Everybody
 * inside (the copilot, the AI Knowledge screen's own search) leaves it out and searches every file. A workspace whose
 * database hasn't the column yet has no file a customer may be answered from: nothing is found.
 */
export async function searchKnowledge(question: string, limit: number = COPILOT_KNOWLEDGE_CHUNKS, opts: { forCustomers?: boolean; forHrDesk?: boolean } = {}): Promise<KnowledgeHit[]> {
  const words = searchableText(question);
  if (!words) return [];
  const take = Math.max(1, Math.min(20, Math.floor(limit)));
  const onlyForCustomers = opts.forCustomers === true ? Prisma.sql`AND f."forCustomers" = true` : Prisma.empty;
  // `forHrDesk` (owner, 20 Nov 2026 — src/lib/hr-desk): only the files chosen for Priya, whose answers go to any employee.
  const onlyForHrDesk = opts.forHrDesk === true ? Prisma.sql`AND EXISTS (SELECT 1 FROM hr_desk_files h WHERE h."fileId" = f.id)` : Prisma.empty;
  try {
    const rows = await db.$queryRaw<Row[]>`
      WITH q AS (
        SELECT plainto_tsquery('english', ${words}) AS every_word,
               NULLIF(replace(plainto_tsquery('english', ${words})::text, ' & ', ' | '), '')::tsquery AS any_word
      )
      SELECT f.name AS file, c.heading, c.text
      FROM q, ai_knowledge_chunks c
      JOIN ai_knowledge_files f ON f.id = c."fileId"
      WHERE q.any_word IS NOT NULL AND c.search @@ q.any_word ${onlyForCustomers} ${onlyForHrDesk}
      ORDER BY (c.search @@ q.every_word) DESC, ts_rank_cd(c.search, q.any_word, 1) DESC, f.name ASC, c.position ASC
      LIMIT ${take}`;
    return rows.map((r) => ({ file: r.file, heading: r.heading, text: r.text }));
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}
