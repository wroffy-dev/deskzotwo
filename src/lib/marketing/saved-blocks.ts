import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { sanitizeEmailHtml } from "@/lib/marketing/html";
import { blockSchema, type Block } from "@/lib/marketing/email-design";

/**
 * Saved blocks (owner, 1 Nov 2026: "saved blocks / brand kit") — a block or a run of blocks kept from the email builder
 * to drop into any email: the header with a partner's logo beside ours, the footer with social links and the sign-off.
 * The workspace's, shared by everybody who designs its emails. Text is cleaned as the email will be; a picture must be
 * hosted (the builder uploads every one), not carried in the block.
 */

export type SavedBlock = { id: string; name: string; blocks: Block[]; updatedAt: string };

export const SAVED_BLOCKS_MAX = 60;
const MAX_BYTES = 400_000;

const blocksSchema = z.array(blockSchema).min(1).max(20);

/** The workspace has no table yet (its migration hasn't reached it), or a running server's client predates it. */
function notKeptYet(err: unknown): boolean {
  return notMigratedYet(err) || err instanceof TypeError || (err instanceof Prisma.PrismaClientValidationError && /savedBlock/i.test(err.message));
}

const read = (value: unknown): Block[] | null => {
  const parsed = blocksSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** Every saved block, newest change first — any that no longer reads as blocks left out. */
export async function listSavedBlocks(): Promise<SavedBlock[]> {
  try {
    const rows = await db.marketingSavedBlock.findMany({ orderBy: { updatedAt: "desc" }, take: SAVED_BLOCKS_MAX, select: { id: true, name: true, blocks: true, updatedAt: true } });
    return rows.flatMap((r) => {
      const blocks = read(r.blocks);
      return blocks ? [{ id: r.id, name: r.name, blocks, updatedAt: r.updatedAt.toISOString() }] : [];
    });
  } catch (err) {
    if (notKeptYet(err)) return [];
    throw err;
  }
}

/** Checks and cleans what is to be saved: blocks the builder draws, their text cleaned, no picture carried inside. */
export function cleanSavedBlocks(value: unknown): { ok: true; blocks: Block[] } | { ok: false; error: string } {
  const parsed = blocksSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.code === "too_small") return { ok: false, error: "Tick a block to save." };
    if (issue?.code === "too_big") return { ok: false, error: "Save 20 blocks at most at a time." };
    return { ok: false, error: `That block couldn't be saved: ${(issue?.message ?? "it isn't right").replace(/\.$/, "")}.` };
  }
  const blocks = parsed.data.map((b) => (b.type === "text" || b.type === "html" ? { ...b, html: sanitizeEmailHtml(b.html) } : b));
  const json = JSON.stringify(blocks);
  if (/"data:image\//.test(json)) return { ok: false, error: "A picture in it isn't uploaded yet — upload it in the block's settings, then save." };
  if (json.length > MAX_BYTES) return { ok: false, error: "That's too much to save as one — save fewer blocks." };
  return { ok: true, blocks };
}

export type SaveResult = { ok: true; data: SavedBlock } | { ok: false; error: string };

/** Saves blocks under a name — replacing the saved ones of that name, so "Header" saved again is the new header. */
export async function storeSavedBlocks(input: { userId: string; name: string; blocks: Block[] }): Promise<SaveResult> {
  const name = input.name.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!name) return { ok: false, error: "Give it a name — Header, Footer, Microsoft offer…" };
  try {
    const same = await db.marketingSavedBlock.findFirst({ where: { name: { equals: name, mode: "insensitive" } }, select: { id: true } });
    if (!same && (await db.marketingSavedBlock.count()) >= SAVED_BLOCKS_MAX) return { ok: false, error: `There are ${SAVED_BLOCKS_MAX} saved already — delete one you don't use first.` };
    const data = { name, blocks: input.blocks as unknown as Prisma.InputJsonValue };
    const row = same
      ? await db.marketingSavedBlock.update({ where: { id: same.id }, data, select: { id: true, updatedAt: true } })
      : await db.marketingSavedBlock.create({ data: { ...data, createdById: input.userId }, select: { id: true, updatedAt: true } });
    return { ok: true, data: { id: row.id, name, blocks: input.blocks, updatedAt: row.updatedAt.toISOString() } };
  } catch (err) {
    if (notKeptYet(err)) return { ok: false, error: "This workspace can't keep saved blocks until its next update." };
    throw err;
  }
}
