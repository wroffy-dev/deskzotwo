import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * The workspace's house style for everything its AI teammates write (owner, 20 Nov 2026 — step 2): the tone, the
 * sign-off, what to always mention and what never to say, in the workspace's own words. Added to each writing
 * teammate's instructions — Tara's emails and answers, Arjun's chase emails, Kabir's chat answers, Priya's HR answers —
 * as a block after their own, so a teammate's rules (no prices, no promises) still come first.
 */

export type HouseStyle = { tone: string; signOff: string; alwaysMention: string; neverSay: string; notes: string };
export const EMPTY_STYLE: HouseStyle = { tone: "", signOff: "", alwaysMention: "", neverSay: "", notes: "" };
export const STYLE_LIMIT = 400;

export async function houseStyle(): Promise<HouseStyle> {
  try {
    const row = await db.aiHouseStyle.findUnique({ where: { id: "global" } });
    if (!row) return EMPTY_STYLE;
    return { tone: row.tone ?? "", signOff: row.signOff ?? "", alwaysMention: row.alwaysMention ?? "", neverSay: row.neverSay ?? "", notes: row.notes ?? "" };
  } catch (err) {
    if (notMigratedYet(err)) return EMPTY_STYLE;
    throw err;
  }
}

export async function saveHouseStyle(style: HouseStyle, userId: string): Promise<void> {
  const clean = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, STYLE_LIMIT) || null;
  const data = { tone: clean(style.tone), signOff: clean(style.signOff), alwaysMention: clean(style.alwaysMention), neverSay: clean(style.neverSay), notes: clean(style.notes), updatedById: userId };
  await db.aiHouseStyle.upsert({ where: { id: "global" }, create: { id: "global", ...data }, update: data, select: { id: true } });
}

/** The style as a block of instructions — empty when nothing is set. */
export function styleBlock(style: HouseStyle, opts: { signOff?: boolean } = {}): string {
  const lines = [
    style.tone && `Tone: ${style.tone}`,
    opts.signOff !== false && style.signOff && `Sign off as: ${style.signOff}`,
    style.alwaysMention && `Where it fits naturally, mention: ${style.alwaysMention}`,
    style.neverSay && `Never say or promise: ${style.neverSay}`,
    style.notes && `Also: ${style.notes}`,
  ].filter(Boolean);
  if (!lines.length) return "";
  return `\n\nThis company's house style — follow it within the rules above (they win where the two differ):\n${lines.map((l) => `- ${l}`).join("\n")}`;
}

/** A teammate's instructions with the workspace's house style after them — without the sign-off for a chat or HR answer. */
export async function styled(system: string, opts: { signOff?: boolean } = {}): Promise<string> {
  return system + styleBlock(await houseStyle(), opts);
}
